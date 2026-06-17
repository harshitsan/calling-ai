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
import { syncTenantDidRoutes } from './did-routes';
import { mintStreamToken } from './stream-token';
import { buildConnectStreamTwiml, buildTwilioCallRequest } from './twilio';

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

/** POST to a carrier URL, wrap whatever they return into our standard envelope. */
async function fetchAndRespond(
  url: string,
  init: RequestInit,
  carrier: string | null,
): Promise<Response> {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* leave as text */ }
    return json({
      ok: res.ok,
      status: res.status,
      carrier,
      response: parsed,
    }, { status: res.ok ? 200 : 502 });
  } catch (e) {
    return err(502, `carrier request failed: ${(e as Error).message.slice(0, 200)}`);
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
  agentId?: unknown;
  callTimeoutSeconds?: unknown;
  carrierAgentId?: unknown;
}

/**
 * Resolve which agent + DID drives this outbound call.
 *
 * Inputs (precedence top → bottom):
 *   1. explicit callerId   — caller knows exactly which DID to dial from
 *   2. agentId             — look up that agent's first inbound_did
 *   3. fallback            — the tenant's first configured PSTN DID
 *
 * Returns agent + did separately so the customParameters can carry the
 * resolved agentId back to the streaming endpoint for routing-on-receive.
 */
async function resolveOutboundRoute(
  env: Env,
  tenantId: string,
  body: ClickToCallBody,
  configDids: string[],
): Promise<
  | { ok: true; did: string; agentId: string | null; carrierAgentId: string | null }
  | { ok: false; error: string }
> {
  const explicitCallerId = typeof body.callerId === 'string' ? body.callerId.trim() : '';
  const explicitAgentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const explicitCarrierAgent =
    typeof body.carrierAgentId === 'string' ? body.carrierAgentId.trim() : '';

  // Look up the agent (validates it belongs to this tenant + has DIDs).
  let agentId: string | null = null;
  let agentDid: string | null = null;
  let agentCarrierId: string | null = null;
  if (explicitAgentId) {
    const row = await env.DB.prepare(
      'SELECT id, inbound_dids, carrier_agent_id FROM agents WHERE id = ? AND tenant_id = ?',
    )
      .bind(explicitAgentId, tenantId)
      .first<{ id: string; inbound_dids: string; carrier_agent_id: string | null }>();
    if (!row) return { ok: false, error: `agent ${explicitAgentId} not found for tenant` };
    agentId = row.id;
    agentCarrierId = row.carrier_agent_id;
    try {
      const dids = JSON.parse(row.inbound_dids ?? '[]') as string[];
      if (Array.isArray(dids) && dids[0]) agentDid = dids[0]!.trim();
    } catch { /* keep null */ }
  }

  // Pick the DID we'll dial from. Explicit > agent's first DID > tenant fallback.
  const did = explicitCallerId || agentDid || configDids[0] || '';
  if (!did) {
    return {
      ok: false,
      error: 'no caller_id available — pass callerId, or set an agent with inbound_dids, or add a phone number to PSTN config',
    };
  }

  // Carrier agent ID — explicit > agent's stored value > null (proxy will then
  // surface a useful error to the caller).
  const carrierAgentId = explicitCarrierAgent || agentCarrierId || null;
  return { ok: true, did, agentId, carrierAgentId };
}
interface UpdateSip {
  enabled?: unknown;
  uri?: unknown;
  authMethod?: unknown;
  allowedIps?: unknown;
  digestUser?: unknown;
  digestPass?: unknown;
}

const PSTN_PROVIDERS = new Set(['tata', 'twilio', 'vonage', 'plivo', 'telnyx', 'acefone', 'other']);
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
    // Keep the inbound DID→tenant routing index in sync with the new numbers.
    await syncTenantDidRoutes(env, tenantId).catch((e) =>
      console.warn('[voice-integrations] did route sync failed', (e as Error).message));
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
    const async = body.async === 1 || body.async === true ? 1 : 0;
    const callTimeout =
      typeof body.callTimeoutSeconds === 'number' && body.callTimeoutSeconds > 0
        ? Math.min(7200, Math.floor(body.callTimeoutSeconds))
        : 0;
    if (!customerNumber) return err(400, 'customerNumber is required');

    const cfg = await ensureRow(env, tenantId);
    // Twilio's endpoint URL is derived from the Account SID, so it's the one
    // provider that doesn't need pstn_endpoint_url configured.
    const isTwilio =
      cfg.pstn_provider === 'twilio' || /api\.twilio\.com/i.test(cfg.pstn_endpoint_url ?? '');
    if (!cfg.pstn_enabled) return err(409, 'PSTN integration is not enabled for this tenant');
    if (!isTwilio && !cfg.pstn_endpoint_url) return err(409, 'carrier endpoint URL is not configured');
    if (!cfg.pstn_auth_token) return err(409, 'carrier API key is not configured');

    const route = await resolveOutboundRoute(
      env,
      tenantId,
      body,
      safeParseJsonArray(cfg.pstn_phone_numbers),
    );
    if (!route.ok) return err(400, route.error);
    const callerId = route.did;

    // Twilio uses its REST Calls API (Basic auth, form-encoded, E.164 numbers)
    // and connects the answered call to our media bridge via inline TwiML with a
    // per-call stream token — NOT the generic JSON proxy below.
    if (isTwilio) {
      const sid = cfg.pstn_account_id?.trim();
      if (!sid) return err(409, 'Twilio Account SID (accountId) is not configured');
      const secret = (env as unknown as { STREAM_TOKEN_SECRET?: string }).STREAM_TOKEN_SECRET;
      if (!secret) return err(503, 'STREAM_TOKEN_SECRET not configured');
      const streamToken = await mintStreamToken(
        { tenantId, agentId: route.agentId, callSid: null, direction: 'outbound' },
        secret,
      );
      const host = new URL(request.url).host;
      const wssUrl = `wss://${host}/voice/stream?token=${encodeURIComponent(streamToken)}`;
      const twiml = buildConnectStreamTwiml(wssUrl, { from: callerId, to: customerNumber });
      const { url, init } = buildTwilioCallRequest({
        accountSid: sid,
        authToken: cfg.pstn_auth_token!,
        to: customerNumber,
        from: callerId,
        twiml,
        statusCallback: `https://${host}/twilio/status`,
      });
      return fetchAndRespond(url, init, cfg.pstn_provider);
    }

    // Bare digits — Tata rejects E.164 + prefix in the call form.
    const destinationNumber = customerNumber.replace(/^\+/, '');
    const agentNumber = callerId.replace(/^\+/, '');

    // Treat any tatateleservices.com endpoint as Tata even if provider
    // dropdown wasn't explicitly saved — the URL is unambiguous.
    const isTata =
      cfg.pstn_provider === 'tata' ||
      /tatateleservices\.com|smartflo/i.test(cfg.pstn_endpoint_url);

    let fetchInit: RequestInit;
    if (isTata) {
      // Tata Smartflo has TWO click-to-call flows, distinguished by token shape:
      //
      //  (a) JWT flow — token is `eyJ…`. Routes to a Smartflo AGENT (which
      //      must forward to a phone). Useful for human agents.
      //      POST /v1/click_to_call
      //      Authorization: Bearer <jwt>
      //      Body: { agent_number, destination_number, caller_id, async }
      //
      //  (b) API-key flow — token is a UUID like `022f24e8-…`. The api_key
      //      was created in Tata's portal with a *bound destination*, so the
      //      call routes to that destination (incl. Voice Streaming →
      //      magentic-calling for AI bots) WITHOUT going through an agent.
      //      POST /v1/click_to_call_support
      //      No Authorization header.
      //      Body: { api_key, customer_number, caller_id, async }
      //
      // We auto-detect by token shape.
      const token = cfg.pstn_auth_token!;
      const looksLikeJwt = /^eyJ[a-zA-Z0-9_-]+\./.test(token);
      const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(token);

      if (!agentNumber) {
        return err(400, 'callerId (DID) is required for Tata click-to-call — pass it explicitly or set a default DID under PSTN config');
      }

      // custom_identifier flows back to us in Tata's webhook + (per docs)
      // can also reach the streaming endpoint as a customParameter. We use
      // it to carry the resolved agentId so the inbound media stream routes
      // back to the same agent that initiated the outbound call.
      const customIdentifier = route.agentId
        ? JSON.stringify({ agentId: route.agentId })
        : '';

      if (looksLikeUuid && !looksLikeJwt) {
        // API-key flow — destination is pre-bound on the api_key.
        const body: Record<string, unknown> = {
          api_key: token,
          customer_number: destinationNumber,
          caller_id: agentNumber,
          async: async ? 1 : 0,
          ...(callTimeout > 0 ? { call_timeout: callTimeout } : {}),
          ...(customIdentifier ? { custom_identifier: customIdentifier } : {}),
        };
        // Default URL is /v1/click_to_call_support — but honor whatever the
        // tenant configured (some accounts have a different base URL).
        let url = cfg.pstn_endpoint_url!;
        if (!/click_to_call_support|c2c/i.test(url)) {
          url = url.replace(/\/v1\/click_to_call\/?$/, '/v1/click_to_call_support');
        }
        fetchInit = {
          method: 'POST',
          headers: { 'accept': 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
        // Swap to support URL when needed (since cfg.pstn_endpoint_url is also
        // used for the JWT flow). Tracked separately so we don't mutate cfg.
        return fetchAndRespond(url, fetchInit, cfg.pstn_provider);
      }

      // JWT flow — needs the Smartflo agent id (carrier_agent_id).
      const carrierAgent = route.carrierAgentId;
      if (!carrierAgent) {
        return err(400,
          'Tata JWT-flow requires a Smartflo agent ID (carrierAgentId). ' +
          'Either set it on the agent under /agents → Integrations → "Carrier agent ID", ' +
          'or switch to the Click-to-Call Support API token flow ' +
          '(generate a UUID-style api_key in Tata\'s portal that\'s bound to your Voice Streaming destination — no agent middleman needed).',
        );
      }
      const body: Record<string, unknown> = {
        agent_number: carrierAgent,
        destination_number: destinationNumber,
        caller_id: agentNumber,
        async: async ? 1 : 0,
        ...(callTimeout > 0 ? { call_timeout: callTimeout } : {}),
        ...(customIdentifier ? { custom_identifier: customIdentifier } : {}),
      };
      fetchInit = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'accept': 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      };
    } else {
      // Generic providers — JSON body with api_key + Bearer header.
      const useBearerAuth =
        cfg.pstn_provider === 'telnyx' ||
        cfg.pstn_provider === 'other' ||
        !cfg.pstn_provider;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (useBearerAuth) headers['Authorization'] = `Bearer ${cfg.pstn_auth_token}`;
      const payload: Record<string, unknown> = {
        ...(useBearerAuth ? {} : { api_key: cfg.pstn_auth_token }),
        customer_number: destinationNumber,
        ...(agentNumber ? { caller_id: agentNumber } : {}),
        ...(async ? { async: 1 } : {}),
      };
      fetchInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      };
    }

    return fetchAndRespond(cfg.pstn_endpoint_url!, fetchInit, cfg.pstn_provider);
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
