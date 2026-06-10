// API key self-service — lets an organization mint and revoke keys for the
// public notetaker API from the web app. Session (JWT) auth only: index.ts
// must never route x-api-key-authenticated requests here, so a leaked key
// cannot mint more keys.
//
// The full key is returned exactly once at creation; only its SHA-256 hash
// (the lookup column authenticate() uses) and a display prefix are stored.

import { hashApiKey } from './auth';
import { err, json, now, uuid } from './util';

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Tenant webhook signing secret, generated lazily on first key creation. */
async function ensureWebhookSecret(env: Env, tenantId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT webhook_secret FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<{ webhook_secret: string | null }>();
  if (row?.webhook_secret) return row.webhook_secret;
  const secret = `whsec_${randomHex(16)}`;
  await env.DB.prepare('UPDATE tenants SET webhook_secret = ? WHERE id = ?')
    .bind(secret, tenantId)
    .run();
  return secret;
}

export async function handleApiKeysApi(
  request: Request,
  env: Env,
  auth: { tenantId: string; userId?: string } | null,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith('/api/api-keys')) return null;
  if (!auth) return err(401, 'unauthorized');

  // POST /api/api-keys — mint a key; the full key appears only in this response.
  if (path === '/api/api-keys' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { name?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return err(400, 'name is required');
    if (name.length > 100) return err(400, 'name too long (max 100 chars)');

    const key = `cai_${randomHex(16)}`;
    const prefix = key.slice(0, 12);
    const id = uuid();
    const createdAt = now();
    await env.DB.prepare(
      `INSERT INTO api_keys (id, tenant_id, name, key_hash, prefix, created_at, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, auth.tenantId, name, await hashApiKey(key), prefix, createdAt, auth.userId ?? null).run();

    const webhookSecret = await ensureWebhookSecret(env, auth.tenantId);
    return json({ apiKey: { id, name, key, prefix, createdAt }, webhookSecret }, { status: 201 });
  }

  // GET /api/api-keys — list (prefixes only, never hashes or full keys).
  if (path === '/api/api-keys' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, name, prefix, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC',
    ).bind(auth.tenantId).all<{ id: string; name: string; prefix: string; created_at: number }>();
    const row = await env.DB.prepare('SELECT webhook_secret FROM tenants WHERE id = ?')
      .bind(auth.tenantId)
      .first<{ webhook_secret: string | null }>();
    return json({
      apiKeys: results.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at })),
      webhookSecret: row?.webhook_secret ?? null,
    });
  }

  // DELETE /api/api-keys/:id — revoke.
  const delMatch = path.match(/^\/api\/api-keys\/([A-Za-z0-9-]+)$/);
  if (delMatch && method === 'DELETE') {
    const { meta } = await env.DB.prepare('DELETE FROM api_keys WHERE id = ? AND tenant_id = ?')
      .bind(delMatch[1]!, auth.tenantId)
      .run();
    if (!meta.changes) return err(404, 'api key not found');
    return json({ ok: true });
  }

  return err(404, 'not found');
}
