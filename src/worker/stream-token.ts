// Per-call signed token for the media WebSocket (/voice/stream).
//
// The Twilio inbound webhook can't set WS headers, so it embeds one of these in
// the wss URL it returns in TwiML. The WS handler verifies it instead of the
// long-lived streaming API key — which we only store hashed, and which is
// weaker than a per-call, short-lived, signed credential anyway. Claims carry
// the routing decision (tenant + agent) so it can't be tampered with in transit.
import { b64urlDecode, b64urlEncode } from './util';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface StreamTokenClaims {
  tenantId: string;
  agentId: string | null;
  callSid: string | null;
  direction: 'inbound' | 'outbound';
  exp: number; // unix seconds
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function mintStreamToken(
  claims: Omit<StreamTokenClaims, 'exp'>,
  secret: string,
  opts: { nowMs?: number; ttlMs?: number } = {},
): Promise<string> {
  const nowMs = opts.nowMs ?? Date.now();
  const ttlMs = opts.ttlMs ?? 60_000; // 60s to connect the media stream
  const full: StreamTokenClaims = { ...claims, exp: Math.floor((nowMs + ttlMs) / 1000) };
  const payload = b64urlEncode(enc.encode(JSON.stringify(full)));
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyStreamToken(
  token: string,
  secret: string,
  opts: { nowMs?: number } = {},
): Promise<StreamTokenClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  if (!timingSafeEqual(await hmac(parts[0]!, secret), parts[1]!)) return null;
  try {
    const claims = JSON.parse(dec.decode(b64urlDecode(parts[0]!))) as StreamTokenClaims;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}
