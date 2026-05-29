import { describe, expect, test } from 'vitest';
import { TurnLatency } from './latency';
import { ManualClock } from './testing/fakes';

describe('TurnLatency', () => {
  test('computes per-stage deltas from marks', () => {
    const clock = new ManualClock(1000);
    const lat = new TurnLatency(clock);
    lat.mark('endOfTurn');
    clock.advance(200);
    lat.mark('llmFirstToken');
    clock.advance(150);
    lat.mark('ttsFirstAudio');

    const s = lat.summary();
    expect(s.endpointToFirstToken).toBe(200);
    expect(s.firstTokenToFirstAudio).toBe(150);
    expect(s.endpointToFirstAudio).toBe(350);
  });

  test('first mark wins (idempotent per stage)', () => {
    const clock = new ManualClock(0);
    const lat = new TurnLatency(clock);
    lat.mark('endOfTurn');
    clock.advance(50);
    lat.mark('endOfTurn');
    expect(lat.summary().marks.endOfTurn).toBe(0);
  });

  test('missing marks yield undefined deltas', () => {
    const lat = new TurnLatency(new ManualClock(0));
    lat.mark('endOfTurn');
    expect(lat.summary().endpointToFirstAudio).toBeUndefined();
  });
});
