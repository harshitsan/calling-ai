import { describe, expect, it } from 'vitest';
import { handleNotetakerApi } from './notetaker';

interface Stmt { sql: string; binds: unknown[] }

function fakeDb(handlers: Array<{ match: RegExp; first?: unknown; all?: unknown[] }>) {
  const stmts: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      const exec = (binds: unknown[]) => {
        stmts.push({ sql, binds });
        const h = handlers.find((h) => h.match.test(sql));
        return {
          first: async () => h?.first ?? null,
          all: async () => ({ results: h?.all ?? [] }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      };
      return { bind: (...binds: unknown[]) => exec(binds) };
    },
  };
  return { db, stmts };
}

function fakeEnv(handlers: Array<{ match: RegExp; first?: unknown; all?: unknown[] }> = []) {
  const { db, stmts } = fakeDb(handlers);
  const r2Puts: { key: string }[] = [];
  const queued: unknown[] = [];
  const env = {
    DB: db,
    RECORDINGS: {
      put: async (key: string) => { r2Puts.push({ key }); },
    },
    NOTETAKER_QUEUE: {
      send: async (msg: unknown) => { queued.push(msg); },
    },
  } as unknown as Env;
  return { env, stmts, r2Puts, queued };
}

const CTX = { waitUntil: () => {} };
const AUTH = { tenantId: 't1', userId: 'u1' };

function uploadReq(fields: { webhookUrl?: string } = {}): Request {
  const form = new FormData();
  form.append('audio', new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' }));
  form.append('title', 'standup');
  if (fields.webhookUrl) form.append('webhookUrl', fields.webhookUrl);
  return new Request('https://x/api/notetaker', { method: 'POST', body: form });
}

describe('POST /api/notetaker (async ingestion)', () => {
  it('returns 202 with a queued job and enqueues a process message', async () => {
    const { env, stmts, r2Puts, queued } = fakeEnv();
    const res = await handleNotetakerApi(uploadReq(), env, CTX, AUTH);
    expect(res?.status).toBe(202);
    const body = (await res!.json()) as { notetaker: { id: string; status: string } };
    expect(body.notetaker.status).toBe('queued');
    expect(r2Puts.length).toBe(1);
    expect(stmts.some((s) => /INSERT INTO notetaker_jobs/.test(s.sql))).toBe(true);
    expect(queued).toEqual([{ kind: 'process', jobId: body.notetaker.id, tenantId: 't1' }]);
  });

  it('stores the webhook url on the job row', async () => {
    const { env, stmts } = fakeEnv();
    const res = await handleNotetakerApi(uploadReq({ webhookUrl: 'https://org.example/hook' }), env, CTX, AUTH);
    expect(res?.status).toBe(202);
    const insert = stmts.find((s) => /INSERT INTO notetaker_jobs/.test(s.sql))!;
    expect(insert.binds).toContain('https://org.example/hook');
  });

  it('rejects non-https webhook urls and stores nothing', async () => {
    const { env, stmts, queued } = fakeEnv();
    const res = await handleNotetakerApi(uploadReq({ webhookUrl: 'http://org.example/hook' }), env, CTX, AUTH);
    expect(res?.status).toBe(400);
    expect(stmts.some((s) => /INSERT INTO notetaker_jobs/.test(s.sql))).toBe(false);
    expect(queued.length).toBe(0);
  });
});

describe('/api/v1/notetaker alias', () => {
  it('serves the v1 path with the same handler', async () => {
    const jobRow = {
      id: 'a1b2', tenant_id: 't1', user_id: 'u1', title: null, audio_r2_key: 'k',
      audio_size_bytes: 3, audio_duration_sec: null, mime_type: 'audio/mpeg',
      status: 'ready', error: null, transcript_text: 'hi', transcript_words: '[]',
      notes_json: null, chars: 2, cost_usd_micro: null, created_at: 1,
      transcribed_at: 2, completed_at: 3,
    };
    const { env } = fakeEnv([{ match: /SELECT \* FROM notetaker_jobs WHERE id=/, first: jobRow }]);
    const req = new Request('https://x/api/v1/notetaker/a1b2');
    const res = await handleNotetakerApi(req, env, CTX, AUTH);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { notetaker: { id: string } };
    expect(body.notetaker.id).toBe('a1b2');
  });
});
