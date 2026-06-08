import { describe, expect, it } from 'vitest';
import { canTransition, assertTransition } from '../src/state-machine';

describe('state machine', () => {
  it('allows the happy path', () => {
    expect(canTransition('queued', 'joining')).toBe(true);
    expect(canTransition('joining', 'waiting_admit')).toBe(true);
    expect(canTransition('waiting_admit', 'recording')).toBe(true);
    expect(canTransition('recording', 'uploading')).toBe(true);
    expect(canTransition('uploading', 'done')).toBe(true);
  });

  it('allows failing from any non-terminal state', () => {
    expect(canTransition('joining', 'failed')).toBe(true);
    expect(canTransition('recording', 'failed')).toBe(true);
  });

  it('rejects skipping states', () => {
    expect(canTransition('queued', 'recording')).toBe(false);
    expect(canTransition('done', 'recording')).toBe(false);
  });

  it('assertTransition throws on an illegal move', () => {
    expect(() => assertTransition('done', 'recording')).toThrow(/illegal/i);
  });
});
