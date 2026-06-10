import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/store';

describe('SessionStore', () => {
  it('upserts and reads back a session', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ id: 'a', meetingUrl: 'u', title: null, status: 'recording', reason: null, createdAt: 1, updatedAt: 1 });
    expect(store.get('a')!.status).toBe('recording');
    store.upsert({ id: 'a', meetingUrl: 'u', title: null, status: 'done', reason: null, createdAt: 1, updatedAt: 2 });
    expect(store.get('a')!.status).toBe('done');
  });

  it('marks interrupted any non-terminal rows (restart recovery)', () => {
    const store = new SessionStore(':memory:');
    store.upsert({ id: 'a', meetingUrl: 'u', title: null, status: 'recording', reason: null, createdAt: 1, updatedAt: 1 });
    store.upsert({ id: 'b', meetingUrl: 'u', title: null, status: 'done', reason: null, createdAt: 1, updatedAt: 1 });
    store.markInterrupted(99);
    expect(store.get('a')!.status).toBe('failed');
    expect(store.get('a')!.reason).toBe('interrupted');
    expect(store.get('b')!.status).toBe('done');
  });
});

describe('api key handling', () => {
  it('persists a session carrying an apiKey without storing the key', () => {
    const store = new SessionStore(':memory:');
    store.upsert({
      id: 'k1', meetingUrl: 'https://m/a', title: null, status: 'queued',
      reason: null, createdAt: 1, updatedAt: 1, apiKey: 'cai_secret',
    });
    const back = store.get('k1');
    expect(back).toBeDefined();
    expect(JSON.stringify(back)).not.toContain('cai_secret');
  });
});
