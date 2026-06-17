import { describe, expect, it } from 'vitest';
import { mintStreamToken, verifyStreamToken } from './stream-token';

const SECRET = 'test-stream-secret';

describe('stream tokens', () => {
  it('round-trips claims', async () => {
    const t = await mintStreamToken(
      { tenantId: 't1', agentId: 'a1', callSid: 'CA123', direction: 'inbound' },
      SECRET,
      { nowMs: 1_000_000 },
    );
    const claims = await verifyStreamToken(t, SECRET, { nowMs: 1_000_000 });
    expect(claims).toMatchObject({ tenantId: 't1', agentId: 'a1', callSid: 'CA123', direction: 'inbound' });
  });

  it('rejects an expired token', async () => {
    const t = await mintStreamToken(
      { tenantId: 't1', agentId: null, callSid: null, direction: 'outbound' },
      SECRET,
      { nowMs: 1_000_000, ttlMs: 60_000 },
    );
    // 61s later
    expect(await verifyStreamToken(t, SECRET, { nowMs: 1_061_000 })).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const t = await mintStreamToken(
      { tenantId: 't1', agentId: null, callSid: null, direction: 'inbound' },
      SECRET,
      { nowMs: 1_000_000 },
    );
    expect(await verifyStreamToken(t, 'wrong-secret', { nowMs: 1_000_000 })).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const t = await mintStreamToken(
      { tenantId: 't1', agentId: null, callSid: null, direction: 'inbound' },
      SECRET,
      { nowMs: 1_000_000 },
    );
    const [payload, sig] = t.split('.');
    // flip the payload, keep the old signature
    const forged = `${payload}x.${sig}`;
    expect(await verifyStreamToken(forged, SECRET, { nowMs: 1_000_000 })).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyStreamToken('garbage', SECRET)).toBeNull();
    expect(await verifyStreamToken('a.b.c', SECRET)).toBeNull();
  });
});
