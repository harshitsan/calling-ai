import { describe, expect, it } from 'vitest';
import { handleApiKeysApi } from './api-keys';
import { hashApiKey } from './auth';

interface Stmt { sql: string; binds: unknown[] }

/** Minimal fake D1: route by SQL substring, record every bound statement. */
function fakeDb(handlers: Array<{ match: RegExp; first?: unknown; all?: unknown[]; changes?: number }>) {
  const stmts: Stmt[] = [];
  const db = {
    prepare(sql: string) {
      const exec = (binds: unknown[]) => {
        stmts.push({ sql, binds });
        const h = handlers.find((h) => h.match.test(sql));
        return {
          first: async () => h?.first ?? null,
          all: async () => ({ results: h?.all ?? [] }),
          run: async () => ({ meta: { changes: h?.changes ?? 1 } }),
        };
      };
      return { bind: (...binds: unknown[]) => exec(binds) };
    },
  };
  return { db, stmts };
}

function envWith(db: unknown): Env {
  return { DB: db } as unknown as Env;
}

const AUTH = { tenantId: 't1', userId: 'u1' };

function post(body: unknown): Request {
  return new Request('https://x/api/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/api-keys', () => {
  it('creates a key, returns it once, and stores only its hash', async () => {
    const { db, stmts } = fakeDb([
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: 'whsec_existing' } },
    ]);
    const res = await handleApiKeysApi(post({ name: 'prod ingest' }), envWith(db), AUTH);
    expect(res?.status).toBe(201);
    const body = (await res!.json()) as { apiKey: { id: string; name: string; key: string; prefix: string } };
    const { key, prefix, name } = body.apiKey;
    expect(name).toBe('prod ingest');
    expect(key).toMatch(/^cai_[0-9a-f]{32}$/);
    expect(key.startsWith(prefix)).toBe(true);

    const insert = stmts.find((s) => /INSERT INTO api_keys/.test(s.sql))!;
    expect(insert).toBeDefined();
    // the full key is never stored — only its SHA-256 hash
    expect(insert.binds).not.toContain(key);
    expect(insert.binds).toContain(await hashApiKey(key));
    // the creating user's id rides along for bot-upload user context
    expect(insert.binds).toContain('u1');
  });

  it('generates the tenant webhook secret on first key creation', async () => {
    const { db, stmts } = fakeDb([
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: null } },
    ]);
    const res = await handleApiKeysApi(post({ name: 'k' }), envWith(db), AUTH);
    const body = (await res!.json()) as { webhookSecret: string };
    expect(body.webhookSecret).toMatch(/^whsec_[0-9a-f]{32}$/);
    const upd = stmts.find((s) => /UPDATE tenants SET webhook_secret/.test(s.sql))!;
    expect(upd.binds).toContain(body.webhookSecret);
  });

  it('returns the existing webhook secret without regenerating it', async () => {
    const { db, stmts } = fakeDb([
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: 'whsec_existing' } },
    ]);
    const res = await handleApiKeysApi(post({ name: 'k' }), envWith(db), AUTH);
    const body = (await res!.json()) as { webhookSecret: string };
    expect(body.webhookSecret).toBe('whsec_existing');
    expect(stmts.some((s) => /UPDATE tenants SET webhook_secret/.test(s.sql))).toBe(false);
  });

  it('rejects a missing or empty name', async () => {
    const { db } = fakeDb([]);
    const res = await handleApiKeysApi(post({}), envWith(db), AUTH);
    expect(res?.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const { db } = fakeDb([]);
    const res = await handleApiKeysApi(post({ name: 'k' }), envWith(db), null);
    expect(res?.status).toBe(401);
  });
});

describe('GET /api/api-keys', () => {
  it('lists keys (prefix only, never hashes) plus the webhook secret', async () => {
    const { db } = fakeDb([
      {
        match: /SELECT .* FROM api_keys/,
        all: [{ id: 'k1', name: 'prod', prefix: 'cai_abcd1234', created_at: 5 }],
      },
      { match: /SELECT webhook_secret FROM tenants/, first: { webhook_secret: 'whsec_s' } },
    ]);
    const req = new Request('https://x/api/api-keys');
    const res = await handleApiKeysApi(req, envWith(db), AUTH);
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { apiKeys: unknown[]; webhookSecret: string };
    expect(body.apiKeys).toEqual([{ id: 'k1', name: 'prod', prefix: 'cai_abcd1234', createdAt: 5 }]);
    expect(body.webhookSecret).toBe('whsec_s');
  });
});

describe('DELETE /api/api-keys/:id', () => {
  it('revokes a key scoped to the tenant', async () => {
    const { db, stmts } = fakeDb([{ match: /DELETE FROM api_keys/, changes: 1 }]);
    const req = new Request('https://x/api/api-keys/k1', { method: 'DELETE' });
    const res = await handleApiKeysApi(req, envWith(db), AUTH);
    expect(res?.status).toBe(200);
    const del = stmts.find((s) => /DELETE FROM api_keys/.test(s.sql))!;
    expect(del.binds).toEqual(['k1', 't1']);
  });

  it('404s when the key does not exist in this tenant', async () => {
    const { db } = fakeDb([{ match: /DELETE FROM api_keys/, changes: 0 }]);
    const req = new Request('https://x/api/api-keys/nope', { method: 'DELETE' });
    const res = await handleApiKeysApi(req, envWith(db), AUTH);
    expect(res?.status).toBe(404);
  });
});

describe('routing', () => {
  it('returns null for non-api-keys paths', async () => {
    const { db } = fakeDb([]);
    const req = new Request('https://x/api/other');
    expect(await handleApiKeysApi(req, envWith(db), AUTH)).toBeNull();
  });
});
