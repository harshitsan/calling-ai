import { describe, expect, it } from 'vitest';
import { handleMeetingDispatchApi } from './meeting-dispatch';
import { hashApiKey } from './auth';

interface Stmt { sql: string; binds: unknown[] }

// Minimal stand-in for the RecorderContainer Durable Object namespace: the
// dispatch module only uses idFromName().get().fetch().
function fakeRecorder(handler: (req: Request) => Promise<Response> | Response) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)),
    }),
  };
}

function fakeEnv(extra: Record<string, unknown> = {}) {
  const stmts: Stmt[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (...binds: unknown[]) => {
            stmts.push({ sql, binds });
            return {
              first: async () => null,
              all: async () => ({ results: [] }),
              run: async () => ({ meta: { changes: 1 } }),
            };
          },
        };
      },
    },
    RECORDER: fakeRecorder(async () =>
      new Response(JSON.stringify({ sessionId: 'sess-1', status: 'queued' }), { status: 201 })),
    RECORDER_CONTROL_SECRET: 'ctl-secret',
    ...extra,
  } as unknown as Env;
  return { env, stmts };
}

const AUTH = { tenantId: 't1', userId: 'u1' };

function post(body: unknown): Request {
  return new Request('https://x/api/notetaker/meetings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/notetaker/meetings', () => {
  it('mints a tenant key, dispatches to the recorder container, returns 202', async () => {
    const captured: { req?: Request; body?: string } = {};
    const { env, stmts } = fakeEnv({
      RECORDER: fakeRecorder(async (req) => {
        captured.req = req;
        captured.body = await req.text();
        return new Response(JSON.stringify({ sessionId: 'sess-1', status: 'queued' }), { status: 201 });
      }),
    });
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij', title: 'standup' }),
      env, AUTH,
    );
    expect(res?.status).toBe(202);
    expect((await res!.json()) as object).toEqual({ meeting: { sessionId: 'sess-1', status: 'queued' } });

    expect(new URL(captured.req!.url).pathname).toBe('/recordings');
    expect(captured.req!.headers.get('authorization')).toBe('Bearer ctl-secret');
    const sent = JSON.parse(captured.body!) as { meetingUrl: string; apiKey: string; title: string };
    expect(sent.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(sent.title).toBe('standup');
    expect(sent.apiKey).toMatch(/^cai_[0-9a-f]{32}$/);
    // the key handed to the recorder was minted into this tenant
    const insert = stmts.find((s) => /INSERT INTO api_keys/.test(s.sql))!;
    expect(insert.binds).toContain('t1');
    expect(insert.binds).toContain(await hashApiKey(sent.apiKey));
  });

  it('rejects non-Meet urls', async () => {
    const { env } = fakeEnv();
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://zoom.us/j/123' }), env, AUTH,
    );
    expect(res?.status).toBe(400);
  });

  it('503s with a setup hint when the recorder is not configured', async () => {
    const { env } = fakeEnv({ RECORDER: undefined, RECORDER_CONTROL_SECRET: '' });
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, AUTH,
    );
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as { error: string }).error).toMatch(/recorder not configured/);
  });

  it('passes through recorder capacity as 429', async () => {
    const { env } = fakeEnv({
      RECORDER: fakeRecorder(() => new Response('{"error":"at capacity"}', { status: 429 })),
    });
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, AUTH,
    );
    expect(res?.status).toBe(429);
  });

  it('502s when the recorder container is unreachable', async () => {
    const { env } = fakeEnv({
      RECORDER: fakeRecorder(() => { throw new Error('container failed to start'); }),
    });
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, AUTH,
    );
    expect(res?.status).toBe(502);
  });

  it('requires auth', async () => {
    const { env } = fakeEnv();
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, null,
    );
    expect(res?.status).toBe(401);
  });
});

describe('GET /api/notetaker/meetings/:id', () => {
  it('proxies the recorder status', async () => {
    const { env } = fakeEnv({
      RECORDER: fakeRecorder((req) => {
        expect(new URL(req.url).pathname).toBe('/recordings/sess-1');
        return new Response(JSON.stringify({ id: 'sess-1', status: 'recording' }), { status: 200 });
      }),
    });
    const req = new Request('https://x/api/notetaker/meetings/sess-1');
    const res = await handleMeetingDispatchApi(req, env, AUTH);
    expect(res?.status).toBe(200);
    expect((await res!.json()) as object).toEqual({ meeting: { id: 'sess-1', status: 'recording' } });
  });

  it('404s when the recorder does not know the session', async () => {
    const { env } = fakeEnv({
      RECORDER: fakeRecorder(() => new Response('{"error":"not found"}', { status: 404 })),
    });
    const req = new Request('https://x/api/notetaker/meetings/nope');
    const res = await handleMeetingDispatchApi(req, env, AUTH);
    expect(res?.status).toBe(404);
  });
});

describe('routing', () => {
  it('ignores non-meeting paths', async () => {
    const { env } = fakeEnv();
    const req = new Request('https://x/api/notetaker/abc123');
    expect(await handleMeetingDispatchApi(req, env, AUTH)).toBeNull();
  });
});
