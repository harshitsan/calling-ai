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
