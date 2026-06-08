import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { joinMeeting, isInCall, readParticipantCount, isRemoved } from '../src/bot-driver';
import { FIXTURE_SELECTORS } from '../src/meet-selectors';

// ESM-safe fixture path (no __dirname): resolve relative to this module.
const fixtureUrl = new URL('./fixtures/fake-meet.html', import.meta.url).href;

describe('bot driver (fixture)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('joins, lands in-call, reads count, and detects removal', async () => {
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    await joinMeeting(page, FIXTURE_SELECTORS, 'Notetaker Bot', 5000);
    expect(await isInCall(page, FIXTURE_SELECTORS)).toBe(true);
    expect(await readParticipantCount(page, FIXTURE_SELECTORS)).toBe(2);
    await page.evaluate(() => (window as any).__setCount(1));
    expect(await readParticipantCount(page, FIXTURE_SELECTORS)).toBe(1);
    expect(await isRemoved(page, FIXTURE_SELECTORS)).toBe(false);
    await page.evaluate(() => (window as any).__remove());
    expect(await isRemoved(page, FIXTURE_SELECTORS)).toBe(true);
    await page.close();
  });
});
