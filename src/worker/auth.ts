import { b64urlDecode, b64urlEncode } from './util';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const salt = b64urlDecode(parts[2]!);
  const bits = await deriveBits(password, salt, Number(parts[1]));
  return timingSafeEqual(b64urlEncode(bits), parts[3]!);
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export interface JwtClaims {
  sub: string; // user id
  tid: string; // tenant id
  exp: number; // unix seconds
}

export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const data = `${header}.${payload}`;
  return `${data}.${await hmac(data, secret)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  if (!timingSafeEqual(await hmac(data, secret), parts[2]!)) return null;
  try {
    const claims = JSON.parse(dec.decode(b64urlDecode(parts[1]!))) as JwtClaims;
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

async function hmac(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return b64urlEncode(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function hashApiKey(key: string): Promise<string> {
  return b64urlEncode(await crypto.subtle.digest('SHA-256', enc.encode(key)));
}
