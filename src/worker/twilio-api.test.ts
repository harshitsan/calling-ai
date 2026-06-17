import { describe, expect, it } from 'vitest';
import { handleTwilioVoice, handleTwilioStatus, computeTwilioSignature } from './twilio';

interface Handler { match: RegExp; first?: unknown }
function fakeEnv(handlers: Handler[]): { env: Env; runs: { sql: string; binds: unknown[] }[] } {
  const runs: { sql: string; binds: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind: (...binds: unknown[]) => ({
          first: async () => handlers.find((h) => h.match.test(sql))?.first ?? null,
          run: async () => { runs.push({ sql, binds }); return { meta: { changes: 1 } }; },
        }),
      };
    },
  };
  return { env: { DB: db, STREAM_TOKEN_SECRET: 'stream-secret' } as unknown as Env, runs };
}

async function signedForm(
  url: string,
  params: Record<string, string>,
  authToken: string,
  opts: { sign?: boolean } = {},
): Promise<Request> {
  const sig = await computeTwilioSignature(url, params, authToken);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.sign !== false) headers['x-twilio-signature'] = sig;
  return new Request(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
}

const ROUTE = { match: /FROM did_routes/, first: { tenant_id: 't1', agent_id: 'a1' } };
const CFG = { match: /pstn_auth_token/, first: { pstn_auth_token: 'tok' } };

describe('POST /twilio/voice', () => {
  const URL_ = 'https://x/twilio/voice';
  const PARAMS = { To: '+14155551212', From: '+14158675309', CallSid: 'CA1' };

  it('returns TwiML streaming to /voice/stream with a token on a valid signed request', async () => {
    const res = await handleTwilioVoice(await signedForm(URL_, PARAMS, 'tok'), fakeEnv([ROUTE, CFG]).env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/xml');
    const body = await res.text();
    expect(body).toContain('<Connect><Stream url="wss://x/voice/stream?token=');
    expect(body).toContain('<Parameter name="from" value="+14158675309"/>');
    expect(body).toContain('<Parameter name="to" value="+14155551212"/>');
  });

  it('404s when no tenant owns the dialed number', async () => {
    const res = await handleTwilioVoice(await signedForm(URL_, PARAMS, 'tok'), fakeEnv([{ match: /FROM did_routes/, first: null }]).env);
    expect(res.status).toBe(404);
  });

  it('403s when Twilio is not configured for the tenant', async () => {
    const res = await handleTwilioVoice(await signedForm(URL_, PARAMS, 'tok'), fakeEnv([ROUTE, { match: /pstn_auth_token/, first: null }]).env);
    expect(res.status).toBe(403);
  });

  it('403s on a missing or invalid signature', async () => {
    expect((await handleTwilioVoice(await signedForm(URL_, PARAMS, 'tok', { sign: false }), fakeEnv([ROUTE, CFG]).env)).status).toBe(403);
    expect((await handleTwilioVoice(await signedForm(URL_, PARAMS, 'WRONG'), fakeEnv([ROUTE, CFG]).env)).status).toBe(403);
  });
});

describe('POST /twilio/status', () => {
  const URL_ = 'https://x/twilio/status';
  const DONE = { CallSid: 'CA9', CallStatus: 'completed', From: '+14158675309', To: '+14155551212', CallDuration: '42' };

  it('closes the matching call row on a terminal status', async () => {
    const { env, runs } = fakeEnv([ROUTE, CFG]);
    const res = await handleTwilioStatus(await signedForm(URL_, DONE, 'tok'), env);
    expect(res.status).toBe(204);
    const update = runs.find((r) => /UPDATE calls/.test(r.sql));
    expect(update).toBeTruthy();
    expect(update!.binds).toContain('CA9');
    expect(update!.binds).toContain('twilio:completed');
  });

  it('does not write for a non-terminal status', async () => {
    const { env, runs } = fakeEnv([ROUTE, CFG]);
    const ringing = { ...DONE, CallStatus: 'ringing' };
    const res = await handleTwilioStatus(await signedForm(URL_, ringing, 'tok'), env);
    expect(res.status).toBe(204);
    expect(runs.find((r) => /UPDATE calls/.test(r.sql))).toBeUndefined();
  });

  it('403s on an invalid signature', async () => {
    const { env } = fakeEnv([ROUTE, CFG]);
    expect((await handleTwilioStatus(await signedForm(URL_, DONE, 'WRONG'), env)).status).toBe(403);
  });

  it('acks (204) and ignores an unknown call', async () => {
    const { env, runs } = fakeEnv([{ match: /FROM did_routes/, first: null }]);
    const res = await handleTwilioStatus(await signedForm(URL_, DONE, 'tok'), env);
    expect(res.status).toBe(204);
    expect(runs.length).toBe(0);
  });
});
