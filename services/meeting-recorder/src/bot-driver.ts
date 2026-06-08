import type { Page } from 'playwright';
import type { Selectors } from './meet-selectors';

export async function joinMeeting(page: Page, sel: Selectors, displayName: string, lobbyTimeoutMs: number): Promise<void> {
  const nameInput = page.locator(sel.nameInput);
  if (await nameInput.count()) {
    await nameInput.first().fill(displayName).catch(() => {});
  }
  await page.locator(sel.joinButton).first().click();
  await page.waitForSelector(sel.inCallMarker, { timeout: lobbyTimeoutMs });
}

export async function isInCall(page: Page, sel: Selectors): Promise<boolean> {
  return (await page.locator(sel.inCallMarker).count()) > 0
    && await page.locator(sel.inCallMarker).first().isVisible().catch(() => false);
}

export async function readParticipantCount(page: Page, sel: Selectors): Promise<number> {
  const el = page.locator(sel.participantCount).first();
  if (!(await el.count())) return 0;
  const raw = (await el.getAttribute(sel.participantCountAttr)) ?? '';
  const m = raw.match(/\d+/);
  return m ? Number(m[0]) : 0;
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
