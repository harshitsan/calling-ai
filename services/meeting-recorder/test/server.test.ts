import { describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/server';
import { SessionManager } from '../src/session-manager';

function setup() {
  const manager = new SessionManager({
    maxConcurrent: 2,
    runner: vi.fn(async () => {}),
    idFactory: () => 'sid',
    now: () => 1000,
  });
  const app = buildServer({ manager, controlSecret: 'sek' });
  return { app, manager };
}

describe('control API', () => {
  it('rejects requests without the bearer secret', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/recordings', payload: { meetingUrl: 'https://m/a' } });
    expect(res.statusCode).toBe(401);
  });

  it('starts a recording and returns the session id', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/recordings',
      headers: { authorization: 'Bearer sek' },
      payload: { meetingUrl: 'https://m/a', title: 'T' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: 'sid' });
  });

  it('returns 400 when meetingUrl is missing', async () => {
    const { app } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/recordings',
      headers: { authorization: 'Bearer sek' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 429 at capacity', async () => {
    const manager = new SessionManager({
      maxConcurrent: 1,
      runner: () => new Promise<void>(() => {}),
      idFactory: () => 'sid',
      now: () => 1000,
    });
    const app = buildServer({ manager, controlSecret: 'sek' });
    await app.inject({ method: 'POST', url: '/recordings', headers: { authorization: 'Bearer sek' }, payload: { meetingUrl: 'https://m/a' } });
    const res = await app.inject({ method: 'POST', url: '/recordings', headers: { authorization: 'Bearer sek' }, payload: { meetingUrl: 'https://m/b' } });
    expect(res.statusCode).toBe(429);
  });

  it('GET /recordings/:id returns the session or 404', async () => {
    const { app } = setup();
    await app.inject({ method: 'POST', url: '/recordings', headers: { authorization: 'Bearer sek' }, payload: { meetingUrl: 'https://m/a' } });
    const ok = await app.inject({ method: 'GET', url: '/recordings/sid', headers: { authorization: 'Bearer sek' } });
    expect(ok.statusCode).toBe(200);
    const missing = await app.inject({ method: 'GET', url: '/recordings/nope', headers: { authorization: 'Bearer sek' } });
    expect(missing.statusCode).toBe(404);
  });

  it('healthz is open and returns ok', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
