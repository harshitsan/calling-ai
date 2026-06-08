import { describe, expect, it } from 'vitest';
import { decideEnd } from '../src/end-detector';

const base = {
  removed: false,
  stopRequested: false,
  otherParticipants: 1,
  aloneSinceMs: null as number | null,
  startedAtMs: 1000,
  nowMs: 1000,
  aloneGraceMs: 120_000,
  maxDurationMs: 7_200_000,
};

describe('decideEnd', () => {
  it('keeps recording when others are present and within limits', () => {
    expect(decideEnd(base)).toEqual({ end: false, reason: null });
  });

  it('ends when the bot was removed', () => {
    expect(decideEnd({ ...base, removed: true })).toEqual({ end: true, reason: 'removed' });
  });

  it('ends on explicit stop request', () => {
    expect(decideEnd({ ...base, stopRequested: true })).toEqual({ end: true, reason: 'stopped' });
  });

  it('ends when alone past the grace window', () => {
    const r = decideEnd({ ...base, otherParticipants: 0, aloneSinceMs: 1000, nowMs: 1000 + 120_001 });
    expect(r).toEqual({ end: true, reason: 'alone' });
  });

  it('keeps recording when alone but still within grace', () => {
    const r = decideEnd({ ...base, otherParticipants: 0, aloneSinceMs: 1000, nowMs: 1000 + 60_000 });
    expect(r.end).toBe(false);
  });

  it('ends when max duration is exceeded', () => {
    const r = decideEnd({ ...base, nowMs: 1000 + 7_200_001 });
    expect(r).toEqual({ end: true, reason: 'max_duration' });
  });
});
