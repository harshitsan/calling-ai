import type { Page } from 'playwright';
import type { Selectors } from './meet-selectors';

export async function joinMeeting(page: Page, sel: Selectors, displayName: string, lobbyTimeoutMs: number): Promise<void> {
  // Meet's pre-join UI can render slowly on cold loads; lobbyTimeoutMs governs
  // the whole join, not Playwright's 30s default click timeout.
  const joinButton = page.locator(sel.joinButton).first();
  const alreadyInCall = page.locator(sel.alreadyInCallButton).first();
  const appeared = await Promise.race([
    joinButton.waitFor({ state: 'visible', timeout: lobbyTimeoutMs }).then(() => 'join' as const).catch(() => null),
    alreadyInCall.waitFor({ state: 'visible', timeout: lobbyTimeoutMs }).then(() => 'switch' as const).catch(() => null),
  ]);
  if (appeared === null) {
    throw new Error(`timeout ${lobbyTimeoutMs}ms waiting for join button: ${sel.joinButton}`);
  }
  if (appeared === 'switch') {
    // Clicking "Switch here" would steal the call from the account's other
    // session, so refuse instead.
    throw new Error('bot account is already in this meeting from another session — use a dedicated bot Google account');
  }
  const nameInput = page.locator(sel.nameInput);
  if (await nameInput.count()) {
    await nameInput.first().fill(displayName).catch(() => {});
  }
  await joinButton.click({ timeout: lobbyTimeoutMs });
  await page.waitForSelector(sel.inCallMarker, { timeout: lobbyTimeoutMs });
}

export async function isInCall(page: Page, sel: Selectors): Promise<boolean> {
  return (await page.locator(sel.inCallMarker).count()) > 0
    && await page.locator(sel.inCallMarker).first().isVisible().catch(() => false);
}

// Counts participant tiles (one per attendee, including the bot's own). Meet's
// "People N" toolbar label collapses into an overflow at some window sizes, so
// tile-counting is the reliable signal — see scripts/probe-participants.ts.
export async function readParticipantCount(page: Page, sel: Selectors): Promise<number> {
  return page.locator(sel.participantTile).count();
}

// Diagnostic helper used by scripts/probe-participants.ts to inspect real Meet
// DOM. Dumps every element whose aria-label/text mentions people/participants.
export async function dumpParticipantCandidates(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rx = /people|participant|everyone|attendee/i;
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const aria = el.getAttribute('aria-label') ?? '';
      const text = (el.textContent ?? '').trim().slice(0, 60);
      if (rx.test(aria) || rx.test(text)) {
        out.push(
          `<${el.tagName.toLowerCase()} aria-label=${JSON.stringify(aria)} ` +
            `text=${JSON.stringify(text)} class=${JSON.stringify((el.getAttribute('class') ?? '').slice(0, 80))}>`,
        );
      }
    }
    return out.slice(0, 40).join('\n') || '(no people/participant elements found)';
  }).catch((e) => `(dump failed: ${(e as Error).message})`);
}

export async function isRemoved(page: Page, sel: Selectors): Promise<boolean> {
  const el = page.locator(sel.removedBanner).first();
  if (!(await el.count())) return false;
  return el.isVisible().catch(() => false);
}

export async function leaveMeeting(page: Page, sel: Selectors): Promise<void> {
  const btn = page.locator(sel.leaveButton).first();
  if (await btn.count()) await btn.click().catch(() => {});
}
