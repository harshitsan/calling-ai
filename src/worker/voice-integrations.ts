// Voice integrations — isolated per-tenant config for PSTN/VoIP, Voice
// Streaming, and SIP Trunking. Disable: flip VOICE_INTEGRATIONS_ENABLED here
// AND in web/src/lib/features.ts.
//
// Three modalities, three states of wiring:
//   - Voice Streaming: real, working. Tenants get a usable API key that
//     authenticates their PBX/contact-center against the streaming endpoint.
//   - PSTN / VoIP: credentials persist. Carrier-webhook → CallSession wiring
//     is deployment-pending and tracked separately.
//   - SIP Trunking: config persists. Needs an out-of-Worker SIP gateway
//     component (FreeSWITCH/JamBonz) to be live.

import { hashApiKey } from './auth';
import { err, json, now, uuid } from './util';

export const VOICE_INTEGRATIONS_ENABLED = true;

interface RowAll {
  tenant_id: string;
  stream_enabled: number;
  stream_api_key_hash: string | null;
  stream_api_key_prefix: string | null;
  stream_key_created_at: number | null;
  pstn_enabled: number;
  pstn_provider: string | null;
  pstn_account_id: string | null;
  pstn_auth_token: string | null;
  pstn_phone_numbers: string;
  sip_enabled: number;
  sip_uri: string | null;
  sip_auth_method: string | null;
  sip_allowed_ips: string;
  sip_digest_user: string | null;
  sip_digest_pass: string | null;
  updated_at: number;
}

function redactTail(s: string | null): string | null {
  if (!s) return null;
  if (s.length <= 4) return '••••';
  return `••••${s.slice(-4)}`;
}

function rowToJson(r: RowAll): Record<string, unknown> {
  return {
    streaming: {
      enabled: !!r.stream_enabled,
      apiKeyPrefix: r.stream_api_key_prefix,
      apiKeyCreatedAt: r.stream_key_created_at,
      // Plaintext key is NEVER returned via GET — only the prefix for display.
      // The full key is shown once at /rotate time.
    },
    pstn: {
      enabled: !!r.pstn_enabled,
      provider: r.pstn_provider,
      accountId: r.pstn_account_id,
      authToken: redactTail(r.pstn_auth_token),
      phoneNumbers: safeParseJsonArray(r.pstn_phone_numbers),
    },
    sip: {
      enabled: !!r.sip_enabled,
      uri: r.sip_uri,
      authMethod: r.sip_auth_method,
      allowedIps: safeParseJsonArray(r.sip_allowed_ips),
      digestUser: r.sip_digest_user,
      digestPass: redactTail(r.sip_digest_pass),
    },
    updatedAt: r.updated_at,
  };
}

function safeParseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

async function ensureRow(env: Env, tenantId: string): Promise<RowAll> {
  const existing = await env.DB.prepare('SELECT * FROM voice_integrations WHERE tenant_id = ?')
    .bind(tenantId)
    .first<RowAll>();
  if (existing) return existing;
  await env.DB.prepare(
    `INSERT INTO voice_integrations (tenant_id, updated_at) VALUES (?, ?)`,
  ).bind(tenantId, now()).run();
  return (await env.DB.prepare('SELECT * FROM voice_integrations WHERE tenant_id = ?')
    .bind(tenantId)
    .first<RowAll>())!;
}

interface UpdateStreaming { enabled?: unknown }
interface UpdatePstn {
  enabled?: unknown;
  provider?: unknown;
  accountId?: unknown;
  authToken?: unknown;
  phoneNumbers?: unknown;
}
interface UpdateSip {
  enabled?: unknown;
  uri?: unknown;
  authMethod?: unknown;
  allowedIps?: unknown;
  digestUser?: unknown;
  digestPass?: unknown;
}

const PSTN_PROVIDERS = new Set(['twilio', 'vonage', 'plivo', 'telnyx', 'acefone', 'other']);
const SIP_AUTH_METHODS = new Set(['ip_allowlist', 'digest']);

export async function handleVoiceIntegrationsApi(
  request: Request,
  env: Env,
  authResult: { tenantId: string; userId?: string } | null,
): Promise<Response | null> {
  if (!VOICE_INTEGRATIONS_ENABLED) return null;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (!path.startsWith('/api/voice-integrations')) return null;
  if (!authResult) return err(401, 'unauthorized');
  const tenantId = authResult.tenantId;

  // GET /api/voice-integrations — full config (secrets redacted)
  if (path === '/api/voice-integrations' && method === 'GET') {
    const row = await ensureRow(env, tenantId);
    return json({ integrations: rowToJson(row) });
  }

  // PUT /api/voice-integrations/streaming — toggle on/off
  if (path === '/api/voice-integrations/streaming' && method === 'PUT') {
    const body = (await request.json().catch(() => ({}))) as UpdateStreaming;
    await ensureRow(env, tenantId);
    const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : null;
    if (enabled === null) return err(400, 'enabled (boolean) required');
    await env.DB.prepare(
      'UPDATE voice_integrations SET stream_enabled = ?, updated_at = ? WHERE tenant_id = ?',
    ).bind(enabled, now(), tenantId).run();
    const row = (await env.DB.prepare('SELECT * FROM voice_integrations WHERE tenant_id = ?')
      .bind(tenantId).first<RowAll>())!;
    return json({ integrations: rowToJson(row) });
  }

  // POST /api/voice-integrations/streaming/rotate — generate a new key,
  // return it once in plaintext. Hash is stored; prefix is kept for display.
  if (path === '/api/voice-integrations/streaming/rotate' && method === 'POST') {
    await ensureRow(env, tenantId);
    const rawKey = `cai_live_${uuid().replace(/-/g, '')}${uuid().replace(/-/g, '').slice(0, 16)}`;
    const hash = await hashApiKey(rawKey);
    const prefix = rawKey.slice(0, 16);
    const ts = now();
    await env.DB.prepare(
      `UPDATE voice_integrations
       SET stream_api_key_hash = ?, stream_api_key_prefix = ?, stream_key_created_at = ?,
           stream_enabled = 1, updated_at = ?
       WHERE tenant_id = ?`,
    ).bind(hash, prefix, ts, ts, tenantId).run();
    return json({ apiKey: rawKey, prefix, createdAt: ts });
  }

  // PUT /api/voice-integrations/pstn — update PSTN config
  if (path === '/api/voice-integrations/pstn' && method === 'PUT') {
    const body = (await request.json().catch(() => ({}))) as UpdatePstn;
    const cur = await ensureRow(env, tenantId);
    const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : cur.pstn_enabled;
    const provider = typeof body.provider === 'string' && PSTN_PROVIDERS.has(body.provider)
      ? body.provider : cur.pstn_provider;
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() || null : cur.pstn_account_id;
    // Empty string means "keep existing" so we don't accidentally wipe secrets
    // when the UI submits a form without the user re-typing the token.
    const authToken =
      typeof body.authToken === 'string' && body.authToken.length > 0
        ? body.authToken
        : cur.pstn_auth_token;
    const numbers = Array.isArray(body.phoneNumbers)
      ? body.phoneNumbers.filter((n): n is string => typeof n === 'string' && /^\+\d{6,15}$/.test(n.trim())).map((n) => n.trim())
      : safeParseJsonArray(cur.pstn_phone_numbers);
    await env.DB.prepare(
      `UPDATE voice_integrations
       SET pstn_enabled = ?, pstn_provider = ?, pstn_account_id = ?, pstn_auth_token = ?,
           pstn_phone_numbers = ?, updated_at = ?
       WHERE tenant_id = ?`,
    ).bind(enabled, provider, accountId, authToken, JSON.stringify(numbers), now(), tenantId).run();
    const row = (await env.DB.prepare('SELECT * FROM voice_integrations WHERE tenant_id = ?')
      .bind(tenantId).first<RowAll>())!;
    return json({ integrations: rowToJson(row) });
  }

  // PUT /api/voice-integrations/sip — update SIP config
  if (path === '/api/voice-integrations/sip' && method === 'PUT') {
    const body = (await request.json().catch(() => ({}))) as UpdateSip;
    const cur = await ensureRow(env, tenantId);
    const enabled = typeof body.enabled === 'boolean' ? (body.enabled ? 1 : 0) : cur.sip_enabled;
    const uri = typeof body.uri === 'string' ? body.uri.trim() || null : cur.sip_uri;
    const authMethod = typeof body.authMethod === 'string' && SIP_AUTH_METHODS.has(body.authMethod)
      ? body.authMethod : cur.sip_auth_method;
    const ips = Array.isArray(body.allowedIps)
      ? body.allowedIps.filter((n): n is string => typeof n === 'string' && n.trim().length > 0).map((n) => n.trim())
      : safeParseJsonArray(cur.sip_allowed_ips);
    const digestUser = typeof body.digestUser === 'string' ? body.digestUser.trim() || null : cur.sip_digest_user;
    const digestPass =
      typeof body.digestPass === 'string' && body.digestPass.length > 0
        ? body.digestPass
        : cur.sip_digest_pass;
    await env.DB.prepare(
      `UPDATE voice_integrations
       SET sip_enabled = ?, sip_uri = ?, sip_auth_method = ?, sip_allowed_ips = ?,
           sip_digest_user = ?, sip_digest_pass = ?, updated_at = ?
       WHERE tenant_id = ?`,
    ).bind(enabled, uri, authMethod, JSON.stringify(ips), digestUser, digestPass, now(), tenantId).run();
    const row = (await env.DB.prepare('SELECT * FROM voice_integrations WHERE tenant_id = ?')
      .bind(tenantId).first<RowAll>())!;
    return json({ integrations: rowToJson(row) });
  }

  return err(404, 'not found');
}
