import { describe, expect, it } from 'vitest';
import { handleMeetingDispatchApi } from './meeting-dispatch';
import { hashApiKey } from './auth';

interface Stmt { sql: string; binds: unknown[] }

function fakeEnv(extra: Record<string, string> = {}) {
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
    RECORDER_URL: 'https://recorder.example',
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

function recorderOk(captured: { url?: string; init?: RequestInit }) {
  return (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(JSON.stringify({ sessionId: 'sess-1', status: 'queued' }), { status: 201 });
  }) as unknown as typeof fetch;
}

describe('POST /api/notetaker/meetings', () => {
  it('mints a tenant key, dispatches to the recorder, returns 202', async () => {
    const { env, stmts } = fakeEnv();
    const captured: { url?: string; init?: RequestInit } = {};
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij', title: 'standup' }),
      env, AUTH, recorderOk(captured),
    );
    expect(res?.status).toBe(202);
    expect((await res!.json()) as object).toEqual({ meeting: { sessionId: 'sess-1', status: 'queued' } });

    expect(captured.url).toBe('https://recorder.example/recordings');
    const headers = captured.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ctl-secret');
    const sent = JSON.parse(captured.init!.body as string) as { meetingUrl: string; apiKey: string; title: string };
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
      post({ meetingUrl: 'https://zoom.us/j/123' }), env, AUTH, recorderOk({}),
    );
    expect(res?.status).toBe(400);
  });

  it('503s with a setup hint when recorder secrets are missing', async () => {
    const { env } = fakeEnv({ RECORDER_URL: '', RECORDER_CONTROL_SECRET: '' });
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, AUTH, recorderOk({}),
    );
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as { error: string }).error).toMatch(/RECORDER_URL/);
  });

  it('passes through recorder capacity as 429', async () => {
    const { env } = fakeEnv();
    const fetchImpl = (async () => new Response('{"error":"at capacity"}', { status: 429 })) as unknown as typeof fetch;
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, AUTH, fetchImpl,
    );
    expect(res?.status).toBe(429);
  });

  it('502s when the recorder is unreachable', async () => {
    const { env } = fakeEnv();
    const fetchImpl = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, AUTH, fetchImpl,
    );
    expect(res?.status).toBe(502);
  });

  it('requires auth', async () => {
    const { env } = fakeEnv();
    const res = await handleMeetingDispatchApi(
      post({ meetingUrl: 'https://meet.google.com/abc-defg-hij' }), env, null, recorderOk({}),
    );
    expect(res?.status).toBe(401);
  });
});

describe('GET /api/notetaker/meetings/:id', () => {
  it('proxies the recorder status', async () => {
    const { env } = fakeEnv();
    const fetchImpl = (async (url: string) => {
      expect(url).toBe('https://recorder.example/recordings/sess-1');
      return new Response(JSON.stringify({ id: 'sess-1', status: 'recording' }), { status: 200 });
    }) as unknown as typeof fetch;
    const req = new Request('https://x/api/notetaker/meetings/sess-1');
    const res = await handleMeetingDispatchApi(req, env, AUTH, fetchImpl);
    expect(res?.status).toBe(200);
    expect((await res!.json()) as object).toEqual({ meeting: { id: 'sess-1', status: 'recording' } });
  });

  it('404s when the recorder does not know the session', async () => {
    const { env } = fakeEnv();
    const fetchImpl = (async () => new Response('{"error":"not found"}', { status: 404 })) as unknown as typeof fetch;
    const req = new Request('https://x/api/notetaker/meetings/nope');
    const res = await handleMeetingDispatchApi(req, env, AUTH, fetchImpl);
    expect(res?.status).toBe(404);
  });
});

describe('routing', () => {
  it('ignores non-meeting paths', async () => {
    const { env } = fakeEnv();
    const req = new Request('https://x/api/notetaker/abc123');
    expect(await handleMeetingDispatchApi(req, env, AUTH, recorderOk({}))).toBeNull();
  });
});
