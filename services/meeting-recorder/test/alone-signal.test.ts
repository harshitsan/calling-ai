import { describe, expect, it } from 'vitest';
import { shouldRunVision, resolveLeaveOthers, VISION_MIN_INTERVAL_MS } from '../src/alone-signal';

describe('shouldRunVision', () => {
  const base = { visionConfigured: true, domTotal: 1, unreadStreak: 0, msSinceLastVision: VISION_MIN_INTERVAL_MS };

  it('never runs when vision is not configured', () => {
    expect(shouldRunVision({ ...base, visionConfigured: false })).toBe(false);
  });

  it('runs when only the bot tile is visible and the interval has elapsed', () => {
    expect(shouldRunVision({ ...base, domTotal: 1 })).toBe(true);
  });

  it('does not run when the room is clearly populated', () => {
    expect(shouldRunVision({ ...base, domTotal: 3 })).toBe(false);
  });

  it('does not run again before the minimum interval has elapsed', () => {
    expect(shouldRunVision({ ...base, domTotal: 1, msSinceLastVision: 5_000 })).toBe(false);
  });

  it('runs after the DOM has been unreadable for several polls', () => {
    expect(shouldRunVision({ ...base, domTotal: null, unreadStreak: 3 })).toBe(true);
  });

  it('does not run on a single unreadable poll', () => {
    expect(shouldRunVision({ ...base, domTotal: null, unreadStreak: 1 })).toBe(false);
  });
});

describe('resolveLeaveOthers', () => {
  it('uses the vision result when vision ran', () => {
    expect(resolveLeaveOthers({ visionConfigured: true, ranVision: true, visionOthers: 0, domTotal: 1 })).toBe(0);
    expect(resolveLeaveOthers({ visionConfigured: true, ranVision: true, visionOthers: 2, domTotal: 1 })).toBe(2);
    expect(resolveLeaveOthers({ visionConfigured: true, ranVision: true, visionOthers: null, domTotal: 1 })).toBeNull();
  });

  it('falls back to a name-independent DOM count when vision is not configured', () => {
    // tiles incl. bot → subtract the bot's own tile, never name-based filtering.
    expect(resolveLeaveOthers({ visionConfigured: false, ranVision: false, visionOthers: null, domTotal: 1 })).toBe(0);
    expect(resolveLeaveOthers({ visionConfigured: false, ranVision: false, visionOthers: null, domTotal: 3 })).toBe(2);
    expect(resolveLeaveOthers({ visionConfigured: false, ranVision: false, visionOthers: null, domTotal: null })).toBeNull();
  });

  it('reports populated rooms from DOM without a vision call', () => {
    expect(resolveLeaveOthers({ visionConfigured: true, ranVision: false, visionOthers: null, domTotal: 4 })).toBe(3);
  });

  it('reports unknown while maybe-alone between vision calls', () => {
    expect(resolveLeaveOthers({ visionConfigured: true, ranVision: false, visionOthers: null, domTotal: 1 })).toBeNull();
    expect(resolveLeaveOthers({ visionConfigured: true, ranVision: false, visionOthers: null, domTotal: null })).toBeNull();
  });
});
