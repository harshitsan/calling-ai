import { describe, expect, it, vi } from 'vitest';
import { countOthersInScreenshot, type VisionConfig } from '../src/liveness-vision';

const cfg: VisionConfig = {
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  botDisplayName: 'dev gomagentic',
};

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "\x89PNG"

function okResponse(answer: object): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('countOthersInScreenshot', () => {
  it('returns the other-participant count from a well-formed answer', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ others: 2, botVisible: true, note: 'two people' }));
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBe(2);
  });

  it('reports 0 when only the bot is present (bot visible)', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ others: 0, botVisible: true, note: 'just the bot' }));
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBe(0);
  });

  it('returns null (unknown) when others=0 but the bot is not even visible', async () => {
    // Probably a loading/transition screen — must not be treated as "alone".
    const fetchImpl = vi.fn(async () => okResponse({ others: 0, botVisible: false, note: 'blank' }));
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBeNull();
  });

  it('returns null on a non-OK HTTP status', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBeNull();
  });

  it('returns null when the request throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBeNull();
  });

  it('returns null on an unparseable answer body', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }),
    );
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBeNull();
  });

  it('returns null on a model refusal', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { refusal: 'no', content: null } }] }), { status: 200 }),
    );
    expect(await countOthersInScreenshot(png, cfg, fetchImpl)).toBeNull();
  });

  it('sends a vision request with the image and auth header', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ others: 1, botVisible: true, note: 'ok' }));
    await countOthersInScreenshot(png, cfg, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.model).toBe('gpt-4o-mini');
    const imageBlock = sent.messages[1].content.find((c: { type: string }) => c.type === 'image_url');
    expect(imageBlock.image_url.url).toMatch(/^data:image\/png;base64,/);
  });
});
