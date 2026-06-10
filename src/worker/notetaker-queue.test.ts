import { describe, expect, it } from 'vitest';
import { handleNotetakerQueue, deliverWebhook, processJob } from './notetaker';

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

const READY_ROW = {
  id: 'a1b2', tenant_id: 't1', user_id: 'u1', title: 'standup', audio_r2_key: 'k',
  audio_size_bytes: 3, audio_duration_sec: 60, mime_type: 'audio/mpeg',
  status: 'ready', error: null, transcript_text: 'hi', transcript_words: '[]',
  notes_json: '{"summary":"s"}', chars: 2, cost_usd_micro: null, created_at: 1,
  transcribed_at: 2, completed_at: 3,
  webhook_url: 'https://org.example/hook', webhook_status: null, webhook_attempts: 0,
};

function fakeEnv(handlers: Array<{ match: RegExp; first?: unknown; all?: unknown[] }>) {
  const { db, stmts } = fakeDb(handlers);
  const queued: unknown[] = [];
  const env = {
    DB: db,
    NOTETAKER_QUEUE: { send: async (m: unknown) => { queued.push(m); } },
  } as unknown as Env;
  return { env, stmts, queued };
}

function msg(body: unknown, attempts = 1) {
  const state = { retried: false, acked: false };
  return {
    body, attempts,
    retry: () => { state.retried = true; },
    ack: () => { state.acked = true; },
    state,
  };
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('processJob idempotency', () => {
  it('does nothing when the job is already ready (queue redelivery)', async () => {
    const { env, stmts } = fakeEnv([
      { match: /SELECT \* FROM notetaker_jobs/, first: READY_ROW },
    ]);
    await processJob(env, 'a1b2', 't1');
    expect(stmts.some((s) => /UPDATE notetaker_jobs/.test(s.sql))).toBe(false);
  });
});

describe('deliverWebhook', () => {
  it('POSTs a signed payload and marks the webhook delivered', async () => {
    const { env, stmts } = fakeEnv([
      { match: /SELECT \* FROM notetaker_jobs/, first: READY_ROW },
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: 'whsec_s' } },
    ]);
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    await deliverWebhook(env, 'a1b2', 't1', fetchImpl);

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://org.example/hook');
    const rawBody = calls[0]!.init.body as string;
    const payload = JSON.parse(rawBody) as { event: string; notetaker: { id: string } };
    expect(payload.event).toBe('notetaker.ready');
    expect(payload.notetaker.id).toBe('a1b2');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Notetaker-Signature']).toBe(`sha256=${await hmacHex('whsec_s', rawBody)}`);
    expect(headers['X-Notetaker-Delivery']).toMatch(/[0-9a-f-]{36}/);
    expect(stmts.some((s) => /UPDATE notetaker_jobs SET webhook_status='delivered'/.test(s.sql))).toBe(true);
  });

  it('sends notetaker.failed for failed jobs', async () => {
    const { env } = fakeEnv([
      { match: /SELECT \* FROM notetaker_jobs/, first: { ...READY_ROW, status: 'failed', error: 'boom' } },
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: 'whsec_s' } },
    ]);
    let event = '';
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      event = (JSON.parse(init.body as string) as { event: string }).event;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    await deliverWebhook(env, 'a1b2', 't1', fetchImpl);
    expect(event).toBe('notetaker.failed');
  });

  it('throws on a non-2xx response so the queue retries', async () => {
    const { env, stmts } = fakeEnv([
      { match: /SELECT \* FROM notetaker_jobs/, first: READY_ROW },
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: 'whsec_s' } },
    ]);
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    await expect(deliverWebhook(env, 'a1b2', 't1', fetchImpl)).rejects.toThrow(/500/);
    expect(stmts.some((s) => /webhook_attempts = webhook_attempts \+ 1/.test(s.sql))).toBe(true);
  });
});

describe('handleNotetakerQueue', () => {
  it('process message: runs the job then enqueues a webhook message when webhook_url is set', async () => {
    const { env, queued } = fakeEnv([
      { match: /SELECT webhook_url FROM notetaker_jobs/, first: { webhook_url: 'https://org.example/hook' } },
    ]);
    const ran: string[] = [];
    const m = msg({ kind: 'process', jobId: 'a1b2', tenantId: 't1' });
    await handleNotetakerQueue(
      { messages: [m] } as never, env,
      { processJobImpl: async (_e, id) => { ran.push(id); }, deliverWebhookImpl: async () => {} },
    );
    expect(ran).toEqual(['a1b2']);
    expect(queued).toEqual([{ kind: 'webhook', jobId: 'a1b2', tenantId: 't1' }]);
    expect(m.state.retried).toBe(false);
  });

  it('process message: no webhook message when the job has no webhook_url', async () => {
    const { env, queued } = fakeEnv([
      { match: /SELECT webhook_url FROM notetaker_jobs/, first: { webhook_url: null } },
    ]);
    await handleNotetakerQueue(
      { messages: [msg({ kind: 'process', jobId: 'a1b2', tenantId: 't1' })] } as never, env,
      { processJobImpl: async () => {}, deliverWebhookImpl: async () => {} },
    );
    expect(queued).toEqual([]);
  });

  it('webhook message: retries on delivery failure below the attempt cap', async () => {
    const { env, stmts } = fakeEnv([]);
    const m = msg({ kind: 'webhook', jobId: 'a1b2', tenantId: 't1' }, 2);
    await handleNotetakerQueue(
      { messages: [m] } as never, env,
      { processJobImpl: async () => {}, deliverWebhookImpl: async () => { throw new Error('down'); } },
    );
    expect(m.state.retried).toBe(true);
    expect(stmts.some((s) => /webhook_status='failed'/.test(s.sql))).toBe(false);
  });

  it('webhook message: marks webhook_status failed at the attempt cap and stops retrying', async () => {
    const { env, stmts } = fakeEnv([]);
    const m = msg({ kind: 'webhook', jobId: 'a1b2', tenantId: 't1' }, 5);
    await handleNotetakerQueue(
      { messages: [m] } as never, env,
      { processJobImpl: async () => {}, deliverWebhookImpl: async () => { throw new Error('down'); } },
    );
    expect(m.state.retried).toBe(false);
    expect(stmts.some((s) => /webhook_status='failed'/.test(s.sql))).toBe(true);
  });
});
