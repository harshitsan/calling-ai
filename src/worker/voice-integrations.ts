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
  pstn_endpoint_url: string | null;
  pstn_extra: string;
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
      endpointUrl: r.pstn_endpoint_url,
      extra: safeParseJson(r.pstn_extra),
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

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
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
  endpointUrl?: unknown;
  extra?: unknown;
}

interface ClickToCallBody {
  customerNumber?: unknown;
  callerId?: unknown;
  async?: unknown;
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
      ? body.phoneNumbers.filter((n): n is string => typeof n === 'string' && /^\+?\d{6,15}$/.test(n.trim())).map((n) => n.trim())
      : safeParseJsonArray(cur.pstn_phone_numbers);
    const endpointUrl =
      typeof body.endpointUrl === 'string'
        ? (body.endpointUrl.trim() || null)
        : cur.pstn_endpoint_url;
    const extra =
      body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra)
        ? JSON.stringify(body.extra)
        : cur.pstn_extra;
    await env.DB.prepare(
      `UPDATE voice_integrations
       SET pstn_enabled = ?, pstn_provider = ?, pstn_account_id = ?, pstn_auth_token = ?,
           pstn_phone_numbers = ?, pstn_endpoint_url = ?, pstn_extra = ?, updated_at = ?
       WHERE tenant_id = ?`,
    ).bind(enabled, provider, accountId, authToken, JSON.stringify(numbers), endpointUrl, extra, now(), tenantId).run();
    const row = (await env.DB.prepare('SELECT * FROM voice_integrations WHERE tenant_id = ?')
      .bind(tenantId).first<RowAll>())!;
    return json({ integrations: rowToJson(row) });
  }

  // POST /api/voice-integrations/pstn/call — proxy a click-to-call request to
  // the tenant's configured carrier endpoint.
  //
  // Body shape mirrors Tata's spec:
  //   { customerNumber, callerId?, async? }
  // We attach api_key from the stored credentials. Provider-specific request
  // shape (Tata uses snake_case JSON body) is normalized below.
  if (path === '/api/voice-integrations/pstn/call' && method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as ClickToCallBody;
    const customerNumber = typeof body.customerNumber === 'string' ? body.customerNumber.trim() : '';
    const callerId = typeof body.callerId === 'string' ? body.callerId.trim() : '';
    const async = body.async === 1 || body.async === true ? 1 : 0;
    if (!customerNumber) return err(400, 'customerNumber is required');

    const cfg = await ensureRow(env, tenantId);
    if (!cfg.pstn_enabled) return err(409, 'PSTN integration is not enabled for this tenant');
    if (!cfg.pstn_endpoint_url) return err(409, 'carrier endpoint URL is not configured');
    if (!cfg.pstn_auth_token) return err(409, 'carrier API key is not configured');

    // Body — same shape across carriers we proxy. api_key is kept in the
    // body too so older Tata Click-to-Call API versions (which want it in the
    // body) keep working alongside the modern Authorization-header version.
    const payload: Record<string, unknown> = {
      api_key: cfg.pstn_auth_token,
      customer_number: customerNumber,
      ...(callerId ? { caller_id: callerId } : {}),
      ...(async ? { async: 1 } : {}),
    };

    // Headers — Tata's newer click-to-call API requires Authorization: Bearer.
    // Telnyx and most modern carriers use the same convention; Twilio uses
    // HTTP Basic which carrier-specific config can override later.
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (
      cfg.pstn_provider === 'tata' ||
      cfg.pstn_provider === 'telnyx' ||
      cfg.pstn_provider === 'other' ||
      !cfg.pstn_provider
    ) {
      headers['Authorization'] = `Bearer ${cfg.pstn_auth_token}`;
    }

    try {
      const res = await fetch(cfg.pstn_endpoint_url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* leave as text */ }
      return json({
        ok: res.ok,
        status: res.status,
        carrier: cfg.pstn_provider,
        response: parsed,
      }, { status: res.ok ? 200 : 502 });
    } catch (e) {
      return err(502, `carrier request failed: ${(e as Error).message.slice(0, 200)}`);
    }
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
