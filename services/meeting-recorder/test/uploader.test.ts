import { describe, expect, it, vi } from 'vitest';
import { uploadRecording } from '../src/uploader';

const opts = {
  notetakerUrl: 'https://app.example.com',
  apiKey: 'secret-key',
  title: 'Standup',
  fileName: 'rec.mp3',
  bytes: new Uint8Array([1, 2, 3]),
  sleep: async () => {},
};

describe('uploadRecording', () => {
  it('POSTs multipart to the notetaker with the api key and title', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ notetaker: { id: 'job1' } }), { status: 201 }));
    const res = await uploadRecording({ ...opts, fetchImpl });
    expect(res.jobId).toBe('job1');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://app.example.com/api/notetaker');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'secret-key' });
    const body = (init as RequestInit).body as FormData;
    expect(body.get('title')).toBe('Standup');
    expect(body.get('audio')).toBeInstanceOf(File);
  });

  it('retries on a 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ notetaker: { id: 'job2' } }), { status: 201 }));
    const res = await uploadRecording({ ...opts, fetchImpl, maxRetries: 3 });
    expect(res.jobId).toBe('job2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(uploadRecording({ ...opts, fetchImpl, maxRetries: 2 })).rejects.toThrow(/upload failed/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
