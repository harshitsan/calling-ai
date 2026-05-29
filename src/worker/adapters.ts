import type { LlmPort, SttPort, TtsPort } from '../engine/ports';
import type { AudioChunk, LlmDelta, Message, SttEvent } from '../engine/types';

/**
 * Server-side Deepgram Flux STT over Workers AI WebSocket.
 * Client streams raw linear16 16kHz PCM frames; Flux emits Update/EndOfTurn events.
 * EXPERIMENTAL: protocol per docs; needs live-audio verification.
 */
export class FluxStt implements SttPort {
  private handler: ((e: SttEvent) => void) | null = null;
  private flux: WebSocket | null = null;
  private queue: Uint8Array[] = [];
  private ready: Promise<void>;

  constructor(ai: Ai, sampleRate = '16000') {
    this.ready = this.connect(ai, sampleRate);
  }

  private async connect(ai: Ai, sampleRate: string): Promise<void> {
    try {
      const resp = (await ai.run(
        '@cf/deepgram/flux' as never,
        { encoding: 'linear16', sample_rate: sampleRate } as never,
        { websocket: true } as never,
      )) as unknown as { webSocket?: WebSocket };
      const ws = resp.webSocket;
      if (!ws) return;
      ws.accept();
      ws.addEventListener('message', (e: MessageEvent) => {
        if (typeof e.data !== 'string') return;
        let msg: { event?: string; transcript?: string };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        const text = msg.transcript ?? '';
        if (msg.event === 'EndOfTurn') this.handler?.({ type: 'endOfTurn', text });
        else if (msg.event === 'Update' && text) this.handler?.({ type: 'partial', text });
      });
      this.flux = ws;
      for (const f of this.queue) ws.send(f);
      this.queue = [];
    } catch {
      // leave flux null; audio frames will be dropped
    }
  }

  sendAudio(frame: Uint8Array): void {
    if (this.flux) this.flux.send(frame);
    else this.queue.push(frame);
  }
  onEvent(handler: (e: SttEvent) => void): void {
    this.handler = handler;
  }
  close(): void {
    try {
      this.flux?.close();
    } catch {
      // ignore
    }
  }
}

/** STT fed by client-recognized text (browser SpeechRecognition stand-in). */
export class ClientFedStt implements SttPort {
  private handler: ((e: SttEvent) => void) | null = null;
  sendAudio(_frame: Uint8Array): void {}
  onEvent(handler: (e: SttEvent) => void): void {
    this.handler = handler;
  }
  close(): void {}
  feedPartial(text: string): void {
    this.handler?.({ type: 'partial', text });
  }
  feedEndOfTurn(text: string): void {
    this.handler?.({ type: 'endOfTurn', text });
  }
}

/** Streaming LLM over Workers AI (open Llama model — low TTFT default). */
export class WorkersAiLlm implements LlmPort {
  private model: string;
  private gatewayId?: string;
  constructor(
    private ai: Ai,
    opts: { model?: string; gatewayId?: string } = {},
  ) {
    this.model = opts.model ?? '@cf/meta/llama-3.1-8b-instruct';
    this.gatewayId = opts.gatewayId;
  }

  async *generate(messages: Message[], opts?: { signal?: AbortSignal }): AsyncIterable<LlmDelta> {
    const aiMessages = messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.content,
    }));
    const runOpts = this.gatewayId ? { gateway: { id: this.gatewayId } } : undefined;
    const stream = (await this.ai.run(
      this.model as never,
      { messages: aiMessages, stream: true, max_tokens: 512 } as never,
      runOpts as never,
    )) as unknown as ReadableStream<Uint8Array>;

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        if (opts?.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }
          try {
            const json = JSON.parse(data) as { response?: string };
            if (json.response) yield { type: 'text', text: json.response };
          } catch {
            // partial JSON line; ignore
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
    yield { type: 'done' };
  }
}

/** Streaming LLM over the OpenAI Chat Completions API (better quality than Llama). */
export class OpenAiLlm implements LlmPort {
  constructor(
    private apiKey: string,
    private model = 'gpt-4o-mini',
    private baseUrl = 'https://api.openai.com/v1',
  ) {}

  async *generate(messages: Message[], opts?: { signal?: AbortSignal }): AsyncIterable<LlmDelta> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content })),
        stream: true,
        max_tokens: 300,
        temperature: 0.6,
      }),
      signal: opts?.signal,
    });
    if (!res.ok || !res.body) {
      yield { type: 'done' };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        if (opts?.signal?.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }
          try {
            const j = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
            const tok = j.choices?.[0]?.delta?.content;
            if (tok) yield { type: 'text', text: tok };
          } catch {
            // partial SSE line; ignore
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
    yield { type: 'done' };
  }
}

/** TTS over Workers AI Deepgram Aura. Buffers the full clip per sentence for simple playback. */
export class AuraTts implements TtsPort {
  constructor(
    private ai: Ai,
    private speaker = 'angus',
  ) {}

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    if (opts?.signal?.aborted) return;
    const res = (await this.ai.run('@cf/deepgram/aura-1' as never, {
      text,
      speaker: this.speaker,
      encoding: 'mp3',
    } as never)) as unknown;

    const bytes = await toBytes(res);
    if (opts?.signal?.aborted) return;
    if (bytes.length > 0) yield { data: bytes };
  }
}

async function toBytes(res: unknown): Promise<Uint8Array> {
  if (res instanceof Uint8Array) return res;
  if (res instanceof ArrayBuffer) return new Uint8Array(res);
  if (res instanceof ReadableStream) {
    const reader = (res as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.length;
      }
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
  if (res && typeof (res as Response).arrayBuffer === 'function') {
    return new Uint8Array(await (res as Response).arrayBuffer());
  }
  return new Uint8Array(0);
}
