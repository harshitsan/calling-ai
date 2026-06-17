import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { computeTwilioSignature, validateTwilioSignature, buildConnectStreamTwiml, buildTwilioCallRequest } from './twilio';

// Independent reference: Twilio signs the URL with each POST param appended as
// key+value in key-sorted order, HMAC-SHA1, base64. Computed here with Node's
// crypto (a different implementation from the Web Crypto our code uses) so this
// cross-checks both the concatenation order and the HMAC wiring.
function reference(url: string, params: Record<string, string>, token: string): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac('sha1', token).update(data).digest('base64');
}

describe('computeTwilioSignature', () => {
  it('matches an independent HMAC-SHA1 reference over the documented concatenation', async () => {
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675309',
      Digits: '1234',
      From: '+14158675309',
      To: '+18005551212',
    };
    const sig = await computeTwilioSignature(url, params, '12345');
    expect(sig).toBe(reference(url, params, '12345'));
  });

  it('validates a freshly computed signature and rejects a bad one', async () => {
    const url = 'https://x/twilio/voice';
    const params = { To: '+1999', From: '+1888', CallSid: 'CA1' };
    const sig = await computeTwilioSignature(url, params, 'tok');
    expect(await validateTwilioSignature(url, params, 'tok', sig)).toBe(true);
    expect(await validateTwilioSignature(url, params, 'tok', 'nope')).toBe(false);
    expect(await validateTwilioSignature(url, params, 'tok', null)).toBe(false);
    // tampering with a param invalidates it
    expect(await validateTwilioSignature(url, { ...params, To: '+1000' }, 'tok', sig)).toBe(false);
  });
});

describe('buildTwilioCallRequest', () => {
  it('builds a form-encoded Calls.json POST with Basic auth and a status callback', () => {
    const { url, init } = buildTwilioCallRequest({
      accountSid: 'AC123',
      authToken: 'tok',
      to: '+14155551212',
      from: '+14158675309',
      twiml: '<Response/>',
      statusCallback: 'https://h/twilio/status',
    });
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa('AC123:tok')}`);
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('To')).toBe('+14155551212');
    expect(form.get('From')).toBe('+14158675309');
    expect(form.get('Twiml')).toBe('<Response/>');
    expect(form.get('StatusCallback')).toBe('https://h/twilio/status');
    expect(form.get('StatusCallbackMethod')).toBe('POST');
  });

  it('omits status-callback fields when no callback url is given', () => {
    const { init } = buildTwilioCallRequest({
      accountSid: 'AC1', authToken: 't', to: '+1', from: '+2', twiml: '<x/>',
    });
    const form = new URLSearchParams(init.body as string);
    expect(form.get('StatusCallback')).toBeNull();
  });
});

describe('buildConnectStreamTwiml', () => {
  it('emits Connect/Stream with XML-escaped url and parameters', () => {
    const twiml = buildConnectStreamTwiml('wss://h/voice/stream?token=a&b=c', { from: '+1<2>', to: '+3' });
    expect(twiml).toContain('<Connect><Stream url="wss://h/voice/stream?token=a&amp;b=c">');
    expect(twiml).toContain('<Parameter name="from" value="+1&lt;2&gt;"/>');
    expect(twiml).toContain('<Parameter name="to" value="+3"/>');
    expect(twiml).toMatch(/^<\?xml/);
  });
});
