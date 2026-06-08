import { describe, expect, it } from 'vitest';
import { authenticate } from './api';

function envWith(row: { tenant_id: string; user_id: string | null } | null) {
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
    JWT_SECRET: 'unused-here',
  } as unknown as Env;
}

describe('authenticate via x-api-key', () => {
  it('returns the service userId when the api key row has one', async () => {
    const req = new Request('https://x/', { headers: { 'x-api-key': 'k' } });
    const auth = await authenticate(req, envWith({ tenant_id: 't1', user_id: 'meeting-bot' }));
    expect(auth).toEqual({ tenantId: 't1', userId: 'meeting-bot' });
  });

  it('returns tenant with undefined userId when user_id is null (back-compat)', async () => {
    const req = new Request('https://x/', { headers: { 'x-api-key': 'k' } });
    const auth = await authenticate(req, envWith({ tenant_id: 't1', user_id: null }));
    expect(auth).toEqual({ tenantId: 't1', userId: undefined });
  });

  it('returns null when no key matches', async () => {
    const req = new Request('https://x/', { headers: { 'x-api-key': 'k' } });
    const auth = await authenticate(req, envWith(null));
    expect(auth).toBeNull();
  });
});
