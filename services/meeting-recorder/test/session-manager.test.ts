import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../src/session-manager';

function makeManager(maxConcurrent: number, runner: any) {
  let seq = 0;
  return new SessionManager({
    maxConcurrent,
    runner,
    idFactory: () => `s${++seq}`,
    now: () => 1000,
  });
}

describe('SessionManager', () => {
  it('starts a session and exposes it via get', async () => {
    const runner = vi.fn(async () => {});
    const m = makeManager(2, runner);
    const s = m.start('https://meet.example/abc', 'Title');
    expect(s.id).toBe('s1');
    expect(m.get('s1')!.meetingUrl).toBe('https://meet.example/abc');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('rejects when at capacity', async () => {
    // runner that never resolves keeps the slot occupied
    const runner = vi.fn(() => new Promise<void>(() => {}));
    const m = makeManager(1, runner);
    m.start('https://meet.example/a', null);
    expect(() => m.start('https://meet.example/b', null)).toThrow(/at capacity/i);
  });

  it('frees the slot after the runner finishes', async () => {
    let resolve!: () => void;
    const runner = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const m = makeManager(1, runner);
    m.start('https://meet.example/a', null);
    expect(m.activeCount()).toBe(1);
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.activeCount()).toBe(0);
  });

  it('marks a session failed if the runner throws', async () => {
    const runner = vi.fn(async () => { throw new Error('boom'); });
    const m = makeManager(1, runner);
    const s = m.start('https://meet.example/a', null);
    await new Promise((r) => setTimeout(r, 0));
    expect(m.get(s.id)!.status).toBe('failed');
    expect(m.get(s.id)!.reason).toContain('boom');
  });
});

describe('graceful shutdown (SIGTERM drain)', () => {
  it('requestStopAll flags every active session and drain resolves once they finish', async () => {
    const m = makeManager(2, async (_s: unknown, ctx: { isStopRequested: () => boolean }) => {
      while (!ctx.isStopRequested()) await new Promise((r) => setTimeout(r, 10));
    });
    m.start('https://meet.example/a', null);
    m.start('https://meet.example/b', null);
    expect(m.activeCount()).toBe(2);
    m.requestStopAll();
    expect(await m.drain(2000)).toBe(true);
    expect(m.activeCount()).toBe(0);
  });

  it('drain gives up after the timeout when a session never ends', async () => {
    const m = makeManager(1, () => new Promise<void>(() => {}));
    m.start('https://meet.example/a', null);
    expect(await m.drain(150)).toBe(false);
    expect(m.activeCount()).toBe(1);
  });

  it('drain resolves immediately when nothing is active', async () => {
    const m = makeManager(1, async () => {});
    expect(await m.drain(1000)).toBe(true);
  });
});

describe('per-session api keys (multi-tenant)', () => {
  it('stores the tenant api key on the session', () => {
    const m = makeManager(2, async () => {});
    const s = m.start('https://meet.example/abc', 'T', 'cai_tenant1');
    expect(s.apiKey).toBe('cai_tenant1');
  });

  it('defaults apiKey to null when not provided', () => {
    const m = makeManager(2, async () => {});
    const s = m.start('https://meet.example/abc', 'T');
    expect(s.apiKey).toBeNull();
  });
});
