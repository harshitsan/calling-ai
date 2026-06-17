import { describe, expect, it } from 'vitest';
import { handleTwilioVoice, computeTwilioSignature } from './twilio';

interface Handler { match: RegExp; first?: unknown }
function fakeEnv(handlers: Handler[]): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind: (..._binds: unknown[]) => ({
          first: async () => handlers.find((h) => h.match.test(sql))?.first ?? null,
        }),
      };
    },
  };
  return { DB: db, STREAM_TOKEN_SECRET: 'stream-secret' } as unknown as Env;
}

const URL_ = 'https://x/twilio/voice';
const PARAMS = { To: '+14155551212', From: '+14158675309', CallSid: 'CA1' };

async function req(authToken: string, opts: { sign?: boolean } = {}): Promise<Request> {
  const sig = await computeTwilioSignature(URL_, PARAMS, authToken);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.sign !== false) headers['x-twilio-signature'] = sig;
  return new Request(URL_, { method: 'POST', headers, body: new URLSearchParams(PARAMS).toString() });
}

const ROUTE = { match: /FROM did_routes/, first: { tenant_id: 't1', agent_id: 'a1' } };
const CFG = { match: /pstn_auth_token/, first: { pstn_auth_token: 'tok' } };

describe('POST /twilio/voice', () => {
  it('returns TwiML streaming to /voice/stream with a token on a valid signed request', async () => {
    const res = await handleTwilioVoice(await req('tok'), fakeEnv([ROUTE, CFG]));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const body = await res.text();
    expect(body).toContain('<Connect><Stream url="wss://x/voice/stream?token=');
    expect(body).toContain('<Parameter name="from" value="+14158675309"/>');
    expect(body).toContain('<Parameter name="to" value="+14155551212"/>');
  });

  it('404s when no tenant owns the dialed number', async () => {
    const res = await handleTwilioVoice(await req('tok'), fakeEnv([{ match: /FROM did_routes/, first: null }]));
    expect(res.status).toBe(404);
  });

  it('403s when Twilio is not configured for the tenant', async () => {
    const res = await handleTwilioVoice(await req('tok'), fakeEnv([ROUTE, { match: /pstn_auth_token/, first: null }]));
    expect(res.status).toBe(403);
  });

  it('403s on a missing or invalid signature', async () => {
    expect((await handleTwilioVoice(await req('tok', { sign: false }), fakeEnv([ROUTE, CFG]))).status).toBe(403);
    // signature computed with the wrong token
    expect((await handleTwilioVoice(await req('WRONG'), fakeEnv([ROUTE, CFG]))).status).toBe(403);
  });
});
