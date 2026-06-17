import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { ParticipantTracker, coalesceTimeline } from '../src/participant-tracker';
import { joinMeeting } from '../src/bot-driver';
import { FIXTURE_SELECTORS } from '../src/meet-selectors';
import type { Platform } from '../src/platform';

const fixtureUrl = new URL('./fixtures/fake-meet.html', import.meta.url).href;
const FIXTURE_PLATFORM: Platform = { id: 'google-meet', selectors: FIXTURE_SELECTORS };

describe('ParticipantTracker (fixture)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it('reads the roster (others = roster - bot) and records who is speaking', async () => {
    let clock = 1000;
    const now = () => clock;
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    await joinMeeting(page, FIXTURE_SELECTORS, 'Notetaker Bot', 5000);

    const tracker = new ParticipantTracker(page, FIXTURE_PLATFORM, 'Notetaker Bot', /*startedAtMs*/ 1000, now);
    await tracker.openPanel();
    await page.evaluate(() => (window as any).__setRoster(['Notetaker Bot', 'Alex', 'Mira']));

    // t=0ms: Alex speaking.
    clock = 1000;
    await page.evaluate(() => (window as any).__setSpeaking(['Alex']));
    expect(await tracker.poll()).toBe(2); // Alex + Mira

    // t=1000ms: still Alex.
    clock = 2000;
    await tracker.poll();

    // t=2000ms: Mira takes over.
    clock = 3000;
    await page.evaluate(() => (window as any).__setSpeaking(['Mira']));
    await tracker.poll();

    expect(tracker.participants().sort()).toEqual(['Alex', 'Mira']); // bot excluded
    const timeline = tracker.timeline();
    expect(timeline).toContainEqual({ startMs: 0, endMs: 2000, name: 'Alex' });
    expect(timeline.some((s) => s.name === 'Mira' && s.startMs === 2000)).toBe(true);
    await page.close();
  });

  it('returns null (unknown, never "alone") when the panel cannot be read', async () => {
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    await joinMeeting(page, FIXTURE_SELECTORS, 'Notetaker Bot', 5000);
    // Panel never opened / roster never set => zero rows => unavailable.
    const tracker = new ParticipantTracker(page, FIXTURE_PLATFORM, 'Notetaker Bot', 0);
    expect(await tracker.poll()).toBeNull();
    await page.close();
  });

  it('reports others=0 only on a confident empty room (just the bot)', async () => {
    const page = await browser.newPage();
    await page.goto(fixtureUrl);
    await joinMeeting(page, FIXTURE_SELECTORS, 'Notetaker Bot', 5000);
    const tracker = new ParticipantTracker(page, FIXTURE_PLATFORM, 'Notetaker Bot', 0);
    await tracker.openPanel();
    await page.evaluate(() => (window as any).__setRoster(['Notetaker Bot']));
    expect(await tracker.poll()).toBe(0); // bot alone, but a CONFIDENT reading
    await page.close();
  });
});

describe('coalesceTimeline', () => {
  it('merges consecutive samples for the same speaker into one segment', () => {
    const segs = coalesceTimeline([
      { tMs: 0, speaking: ['Alex'] },
      { tMs: 1000, speaking: ['Alex'] },
      { tMs: 2000, speaking: ['Mira'] },
      { tMs: 3000, speaking: ['Mira'] },
    ]);
    expect(segs).toContainEqual({ startMs: 0, endMs: 2000, name: 'Alex' });
    expect(segs).toContainEqual({ startMs: 2000, endMs: 3000, name: 'Mira' });
  });

  it('handles overlapping (simultaneous) speakers as separate segments', () => {
    const segs = coalesceTimeline([
      { tMs: 0, speaking: ['Alex', 'Mira'] },
      { tMs: 1000, speaking: ['Alex'] },
    ]);
    expect(segs).toContainEqual({ startMs: 0, endMs: 1000, name: 'Mira' });
    expect(segs.find((s) => s.name === 'Alex')!.startMs).toBe(0);
  });

  it('returns [] for no samples', () => {
    expect(coalesceTimeline([])).toEqual([]);
  });
});
