// In-page auto-discovery agent for the meeting participants panel.
//
// Injected into the live meeting page as a RAW STRING (not compiled by
// tsx/esbuild, which would inject a `__name` helper that doesn't exist in the
// page context). It defines `window.__ntProbe` with heuristics that find the
// roster and who's speaking WITHOUT any hand-confirmed CSS selectors, so the
// bot self-adapts when Meet's obfuscated DOM drifts.
//
// Discovery strategy:
//   roster   — every [data-participant-id] (Meet's panel + tiles carry it),
//              de-duped by id; falls back to role=listitem under a people
//              container. Name comes from aria-label / name sub-node / text.
//   speaking — explicit markers first (aria-label / class containing
//              "speaking"/"talking", or data-is-speaking), else a
//              MutationObserver that attributes DOM churn to the speaking row
//              (animated audio bars mutate continuously; idle rows don't).

export interface ProbeSample {
  ok: boolean;
  strategy: string;
  participants: string[];
  speaking: string[];
}

export const PROBE_SOURCE = String.raw`
(function () {
  if (window.__ntProbe) return;

  function stripStatus(s) {
    return (s || '')
      .split('\n')[0]
      .replace(/\s*\((you|host|meeting host)\)\s*/gi, ' ')
      .replace(/,.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Per-participant control buttons embed the clean display name in their
  // aria-label. This is FAR more reliable than the tile's textContent, which
  // concatenates Material-icon ligatures (keep_outline, mic_none, more_vert,
  // devices) and action phrases into a blob.
  var NAME_FROM_CONTROL = [
    /^More options for (.+)$/i,
    /^Pin (.+?) to your main screen$/i,
    /^Unpin (.+?) from your main screen$/i,
    /^Mute (.+)$/i,
    /^Unmute (.+)$/i,
    /^Remove (.+?) from the (?:call|meeting)$/i,
  ];

  // Material Symbols render their icon name as text: one lowercase token, no
  // spaces (e.g. "keep_outline", "mic_none", "more_vert", "devices").
  function isIconLigature(s) {
    return /^[a-z][a-z0-9_]*$/.test(s);
  }

  function nameFromControls(el) {
    var labelled = el.querySelectorAll('[aria-label]');
    for (var i = 0; i < labelled.length; i++) {
      var lab = (labelled[i].getAttribute('aria-label') || '').trim();
      for (var p = 0; p < NAME_FROM_CONTROL.length; p++) {
        var m = lab.match(NAME_FROM_CONTROL[p]);
        if (m && m[1]) return stripStatus(m[1]);
      }
    }
    return '';
  }

  // Last resort: pick the most frequent text node that isn't inside a button and
  // isn't an icon ligature. The name is rendered repeatedly; controls are not.
  // Locale-independent (no action-phrase matching). Ties break toward the
  // shorter string (the bare name beats an embedded phrase).
  function nameFromText(el) {
    var counts = {};
    var order = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var p = node.parentElement;
      if (p && p.closest && p.closest('button,[role="button"]')) continue;
      var t = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!t || isIconLigature(t)) continue;
      if (!(t in counts)) { counts[t] = 0; order.push(t); }
      counts[t]++;
    }
    var best = '', bestC = 0;
    for (var i = 0; i < order.length; i++) {
      var t2 = order[i];
      if (counts[t2] > bestC || (counts[t2] === bestC && best && t2.length < best.length)) {
        best = t2; bestC = counts[t2];
      }
    }
    return stripStatus(best);
  }

  function nameOf(el) {
    // 1) The element's own aria-label, when it's a clean name (People-panel rows
    //    expose the bare name this way). Reject noisy blobs (icon ligatures leave
    //    an underscore behind).
    var aria = (el.getAttribute('aria-label') || '').trim();
    if (aria && aria.indexOf('_') === -1 && aria.length <= 80) return stripStatus(aria);
    // 2) Pull the name out of a per-participant control button's aria-label.
    var fromCtrl = nameFromControls(el);
    if (fromCtrl) return fromCtrl;
    // 3) Structural text fallback.
    return nameFromText(el);
  }

  function findRows() {
    var byId = Array.prototype.slice.call(document.querySelectorAll('[data-participant-id]'));
    var map = {};
    for (var i = 0; i < byId.length; i++) {
      var el = byId[i];
      var id = el.getAttribute('data-participant-id');
      if (!map[id] || nameOf(el).length > nameOf(map[id]).length) map[id] = el;
    }
    var rows = Object.keys(map).map(function (k) { return map[k]; });
    if (rows.length > 0) return { rows: rows, strategy: 'data-participant-id' };

    var items = Array.prototype.slice.call(
      document.querySelectorAll('[role="list"] [role="listitem"], [aria-label*="participant" i] [role="listitem"]')
    ).filter(function (el) { return nameOf(el).length > 0; });
    return { rows: items, strategy: items.length ? 'role-listitem' : 'none' };
  }

  function container() {
    var f = findRows();
    if (!f.rows.length) return null;
    var node = f.rows[0];
    var hops = 0;
    while (node && node.parentElement && hops < 6) {
      node = node.parentElement; hops++;
      var role = node.getAttribute ? node.getAttribute('role') : null;
      var aria = node.getAttribute ? (node.getAttribute('aria-label') || '') : '';
      if (role === 'list' || /participant|people/i.test(aria)) return node;
    }
    return f.rows[0].parentElement || document.body;
  }

  var churn = {};
  function pidOf(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('data-participant-id')) return node.getAttribute('data-participant-id');
      node = node.parentElement;
    }
    return null;
  }
  var observer = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var pid = pidOf(muts[i].target);
      if (pid) churn[pid] = (churn[pid] || 0) + 1;
    }
  });
  var observing = false;
  function ensureObserver() {
    if (observing) return;
    var c = container();
    if (!c) return;
    observer.observe(c, { subtree: true, attributes: true, childList: true, characterData: true });
    observing = true;
  }

  function explicitSpeaking(el) {
    if (el.querySelector('[aria-label*="speaking" i],[aria-label*="is talking" i],[class*="speaking" i],[data-is-speaking="true"]')) return true;
    return /speaking|is talking/i.test(el.getAttribute('aria-label') || '');
  }

  window.__ntProbe = {
    markPeopleButton: function () {
      var btns = Array.prototype.slice.call(document.querySelectorAll('button,[role="button"]'));
      for (var i = 0; i < btns.length; i++) {
        var label = (btns[i].getAttribute('aria-label') || '') + ' ' + (btns[i].textContent || '');
        if (/\bpeople\b|participant|show everyone/i.test(label)) {
          btns[i].setAttribute('data-nt-people', '1');
          return true;
        }
      }
      return false;
    },
    discover: function () {
      ensureObserver();
      var f = findRows();
      return { strategy: f.strategy, count: f.rows.length };
    },
    sample: function () {
      ensureObserver();
      var f = findRows();
      var rows = f.rows;
      var participants = [];
      var seen = {};
      for (var i = 0; i < rows.length; i++) {
        var n = nameOf(rows[i]);
        if (n && !seen[n]) { seen[n] = 1; participants.push(n); }
      }
      var speaking = rows.filter(explicitSpeaking).map(nameOf).filter(Boolean);
      if (!speaking.length) {
        var maxC = 0, ids = Object.keys(churn), j;
        for (j = 0; j < ids.length; j++) if (churn[ids[j]] > maxC) maxC = churn[ids[j]];
        if (maxC >= 2) {
          for (var k = 0; k < rows.length; k++) {
            var pid = rows[k].getAttribute && rows[k].getAttribute('data-participant-id');
            if (pid && churn[pid] >= Math.max(2, maxC * 0.5)) {
              var nm = nameOf(rows[k]);
              if (nm) speaking.push(nm);
            }
          }
        }
      }
      churn = {};
      return { ok: rows.length > 0, strategy: f.strategy, participants: participants, speaking: speaking };
    }
  };
})();
`;
