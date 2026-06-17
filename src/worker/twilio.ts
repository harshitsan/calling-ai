// Twilio integration — signaling/control plane.
//
// The media plane (μ-law 8k over WebSocket) is already Twilio-native in
// voice-stream-tata.ts. What Twilio needs that didn't exist:
//   - an inbound Voice webhook that returns TwiML telling Twilio to open a
//     Media Stream back to /voice/stream (Twilio never opens a WS unprompted);
//   - X-Twilio-Signature validation on that webhook;
//   - a way to auth the resulting WS without headers — a per-call stream token
//     embedded in the wss URL (see stream-token.ts).
import { err } from './util';
import { mintStreamToken } from './stream-token';
import { resolveDidRoute } from './did-routes';

const enc = new TextEncoder();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Twilio's request signature: base64( HMAC-SHA1( authToken,
 *   fullUrl + each POST param as `key+value`, concatenated in key-sorted order
 * ) ). See https://www.twilio.com/docs/usage/security#validating-requests.
 */
export async function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): Promise<string> {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin); // standard base64, matching Twilio's header
}

export async function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;
  return timingSafeEqual(await computeTwilioSignature(url, params, authToken), signature);
}

const escXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** TwiML that connects the call's media to our WebSocket bridge. */
export function buildConnectStreamTwiml(wssUrl: string, params: Record<string, string> = {}): string {
  const ps = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${escXml(k)}" value="${escXml(v)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escXml(wssUrl)}">${ps}</Stream></Connect></Response>`;
}

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/xml; charset=utf-8' } });
}

/**
 * POST /twilio/voice — Twilio's inbound Voice webhook (also the entry point for
 * SIP calls arriving via a Twilio Elastic SIP Trunk). Resolves the tenant/agent
 * from the dialed number, validates the signature with that tenant's Auth Token,
 * and returns TwiML that streams the call to /voice/stream with a per-call token.
 */
export async function handleTwilioVoice(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return err(405, 'POST required');
  let form: FormData;
  try { form = await request.formData(); } catch { return err(400, 'expected form-encoded body'); }
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === 'string') params[k] = v;

  const to = params.To ?? '';
  const from = params.From ?? '';
  const callSid = params.CallSid ?? '';
  if (!to) return err(400, 'missing To');

  const route = await resolveDidRoute(env, to);
  if (!route) return err(404, 'no tenant configured for this number');

  const cfg = await env.DB.prepare(
    `SELECT pstn_auth_token FROM voice_integrations WHERE tenant_id = ? AND pstn_provider = 'twilio'`,
  ).bind(route.tenantId).first<{ pstn_auth_token: string | null }>();
  const authToken = cfg?.pstn_auth_token ?? null;
  if (!authToken) return err(403, 'twilio not configured for tenant');

  const signature = request.headers.get('x-twilio-signature');
  if (!(await validateTwilioSignature(request.url, params, authToken, signature))) {
    return err(403, 'invalid twilio signature');
  }

  const secret = (env as unknown as { STREAM_TOKEN_SECRET?: string }).STREAM_TOKEN_SECRET;
  if (!secret) return err(503, 'STREAM_TOKEN_SECRET not configured');
  const token = await mintStreamToken(
    { tenantId: route.tenantId, agentId: route.agentId, callSid: callSid || null, direction: 'inbound' },
    secret,
  );
  const host = new URL(request.url).host;
  const wssUrl = `wss://${host}/voice/stream?token=${encodeURIComponent(token)}`;
  return xml(buildConnectStreamTwiml(wssUrl, { from, to, callSid }));
}
