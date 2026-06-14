import { describe, it, expect } from 'vitest';
import type { Ai } from '@cloudflare/workers-types';
import { FluxStt } from './adapters';
import type { SttEvent } from '../engine/types';

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
