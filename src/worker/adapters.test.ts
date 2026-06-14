import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Ai } from '@cloudflare/workers-types';
import { FluxStt, OpenAiLlm } from './adapters';
import type { Message, SttEvent } from '../engine/types';

// Minimal stand-in for the Workers AI Flux WebSocket.
function fakeWs() {
  const listeners: Record<string, ((ev: unknown) => void)[]> = {};
  return {
    accept() {},
    send(_data: unknown) {},
    close() {},
    addEventListener(type: string, cb: (ev: unknown) => void) {
      (listeners[type] ||= []).push(cb);
    },
    emit(type: string, ev: unknown) {
      (listeners[type] || []).forEach((cb) => cb(ev));
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('FluxStt', () => {
  it('sends only Workers-AI-supported params to ai.run (no eot_* — they break the handshake)', async () => {
    let captured: Record<string, unknown> | undefined;
    const ws = fakeWs();
    const ai = {
      run: async (_model: string, input: Record<string, unknown>) => {
        captured = input;
        return { webSocket: ws };
      },
    } as unknown as Ai;

    new FluxStt(ai, '16000');
    await tick();

    expect(captured).toMatchObject({ encoding: 'linear16', sample_rate: '16000' });
    // Regression guard: these params make @cf/deepgram/flux return {} instead of
    // a WebSocket, silently killing STT (see git history — broke all calls).
    expect(captured).not.toHaveProperty('eot_threshold');
    expect(captured).not.toHaveProperty('eot_timeout_ms');
  });

  it('emits endOfTurn from a Flux TurnInfo/EndOfTurn message', async () => {
    const ws = fakeWs();
    const ai = { run: async () => ({ webSocket: ws }) } as unknown as Ai;
    const events: SttEvent[] = [];
    const stt = new FluxStt(ai, '16000');
    stt.onEvent((e) => events.push(e));
    await tick();

    ws.emit('message', { data: JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'Hello. Can you hear me?' }) });
    expect(events).toContainEqual({ type: 'endOfTurn', text: 'Hello. Can you hear me?' });
  });

  it('emits partial from a Flux Update message', async () => {
    const ws = fakeWs();
    const ai = { run: async () => ({ webSocket: ws }) } as unknown as Ai;
    const events: SttEvent[] = [];
    const stt = new FluxStt(ai, '16000');
    stt.onEvent((e) => events.push(e));
    await tick();

    ws.emit('message', { data: JSON.stringify({ type: 'TurnInfo', event: 'Update', transcript: 'Hello' }) });
    expect(events).toContainEqual({ type: 'partial', text: 'Hello' });
  });
});

describe('OpenAiLlm (Responses API thread continuity)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // SSE body for one Responses turn — sets the response id and emits some text.
  function sse(id: string) {
    const events = [
      `data: ${JSON.stringify({ type: 'response.created', response: { id } })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { id } })}\n\n`,
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) c.enqueue(enc.encode(e));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  async function drain(it: AsyncIterable<unknown>) {
    for await (const _ of it) { /* consume */ }
  }

  it('sends the system prompt as instructions on EVERY turn (persona must survive past turn 1)', async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return sse(`resp-${++n}`);
    });

    const llm = new OpenAiLlm('key', 'gpt-4o-mini');
    const sys: Message = { role: 'system', content: 'You are Zorp.' };
    await drain(llm.generate([sys, { role: 'user', content: 'hi' }]));
    await drain(llm.generate([sys, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'again' }]));

    expect(bodies).toHaveLength(2);
    // Turn 2 must continue the thread AND re-send the persona.
    expect(bodies[1].previous_response_id).toBe('resp-1');
    expect(bodies[1].instructions).toBe('You are Zorp.');
  });
});
