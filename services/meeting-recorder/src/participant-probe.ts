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

  function nameOf(el) {
    var aria = el.getAttribute('aria-label');
    if (!aria) {
      var sub = el.querySelector('[data-self-name],[data-participant-name]');
      if (sub) aria = sub.textContent;
    }
    return stripStatus(aria || el.textContent);
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
