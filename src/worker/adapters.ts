import type { LlmPort, SttPort, TtsPort } from '../engine/ports';
import type { AudioChunk, LlmDelta, Message, SttEvent } from '../engine/types';

/** Reports a failure/warning out of an adapter so it can be logged. */
export type ErrorReporter = (msg: string, data?: Record<string, unknown>, level?: 'warn' | 'error') => void;

/**
 * Resolve a voice id to {model, speaker}. IDs prefixed with the model
 * (e.g. "aura2en:luna", "aura2es:carina") map to those models; bare ids
 * (e.g. "asteria") stay on Aura-1 for backwards compatibility.
 */
export function resolveVoice(voiceId: string): { model: string; speaker: string } {
  const idx = voiceId.indexOf(':');
  if (idx > 0) {
    const prefix = voiceId.slice(0, idx);
    const speaker = voiceId.slice(idx + 1);
    if (prefix === 'aura2en') return { model: '@cf/deepgram/aura-2-en', speaker };
    if (prefix === 'aura2es') return { model: '@cf/deepgram/aura-2-es', speaker };
    if (prefix === 'gemini') return { model: 'google/gemini-3.1-flash-tts', speaker };
  }
  return { model: '@cf/deepgram/aura-1', speaker: voiceId };
}

/** Build the model-specific params object for env.AI.run. */
export function ttsParams(model: string, text: string, speaker: string): Record<string, unknown> {
  if (model.startsWith('google/')) return { text, voice: speaker };
  return { text, speaker, encoding: 'mp3' };
}

// ---- Google Gemini TTS (direct, BYOK) ----
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wrapPcmAsWav(pcm: Uint8Array, sampleRate: number, channels = 1, bps = 16): Uint8Array {
  const headerSize = 44;
  const byteRate = (sampleRate * channels * bps) / 8;
  const blockAlign = (channels * bps) / 8;
  const wav = new Uint8Array(headerSize + pcm.length);
  const dv = new DataView(wav.buffer);
  wav[0] = 0x52; wav[1] = 0x49; wav[2] = 0x46; wav[3] = 0x46; // RIFF
  dv.setUint32(4, 36 + pcm.length, true);
  wav[8] = 0x57; wav[9] = 0x41; wav[10] = 0x56; wav[11] = 0x45; // WAVE
  wav[12] = 0x66; wav[13] = 0x6d; wav[14] = 0x74; wav[15] = 0x20; // fmt
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bps, true);
  wav[36] = 0x64; wav[37] = 0x61; wav[38] = 0x74; wav[39] = 0x61; // data
  dv.setUint32(40, pcm.length, true);
  wav.set(pcm, headerSize);
  return wav;
}

const GEMINI_MODEL_CANDIDATES = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'];

async function callGeminiTts(
  apiKey: string,
  text: string,
  voiceName: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    },
  };
  let lastErr = '';
  for (const m of GEMINI_MODEL_CANDIDATES) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 404) {
      lastErr = `404 model ${m}`;
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
    };
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
    if (!part?.data) throw new Error('Gemini returned no audio');
    const mime = part.mimeType ?? 'audio/L16;codec=pcm;rate=24000';
    const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000);
    const pcm = base64ToBytes(part.data);
    return { bytes: wrapPcmAsWav(pcm, rate), contentType: 'audio/wav' };
  }
  throw new Error(`Gemini: ${lastErr || 'no model accepted'}`);
}

/** Unified TTS entrypoint — handles Aura via env.AI and Gemini via direct fetch. */
export async function synthesizeTts(args: {
  ai: Ai;
  googleApiKey?: string;
  voiceId: string;
  text: string;
}): Promise<{ bytes: Uint8Array; contentType: string }> {
  const { model, speaker } = resolveVoice(args.voiceId);
  if (model.startsWith('google/')) {
    if (!args.googleApiKey) throw new Error('GOOGLE_AI_API_KEY not configured');
    return callGeminiTts(args.googleApiKey, args.text, speaker);
  }
  const res = await args.ai.run(model as never, ttsParams(model, args.text, speaker) as never);
  const bytes = await toBytes(res);
  return { bytes, contentType: 'audio/mpeg' };
}

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

  constructor(
    ai: Ai,
    sampleRate = '16000',
    private onError?: ErrorReporter,
  ) {
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
      if (!ws) {
        this.onError?.('Flux STT did not return a WebSocket');
        return;
      }
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
    } catch (e) {
      this.onError?.('Flux STT connection failed', { error: String(e) });
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
  private onError?: ErrorReporter;
  constructor(
    private ai: Ai,
    opts: { model?: string; gatewayId?: string; onError?: ErrorReporter } = {},
  ) {
    this.model = opts.model ?? '@cf/meta/llama-3.1-8b-instruct';
    this.gatewayId = opts.gatewayId;
    this.onError = opts.onError;
  }

  async *generate(messages: Message[], opts?: { signal?: AbortSignal }): AsyncIterable<LlmDelta> {
    const aiMessages = messages.map((m) => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: m.content,
    }));
    const runOpts = this.gatewayId ? { gateway: { id: this.gatewayId } } : undefined;
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = (await this.ai.run(
        this.model as never,
        { messages: aiMessages, stream: true, max_tokens: 512 } as never,
        runOpts as never,
      )) as unknown as ReadableStream<Uint8Array>;
    } catch (e) {
      this.onError?.('Workers AI LLM call failed', { model: this.model, error: String(e) });
      yield { type: 'done' };
      return;
    }
    if (!stream) {
      this.onError?.('Workers AI LLM returned no stream', { model: this.model });
      yield { type: 'done' };
      return;
    }

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

export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

interface OpenAiDelta {
  content?: string;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

/** Streaming LLM over the OpenAI Chat Completions API, with function calling. */
export class OpenAiLlm implements LlmPort {
  private tools?: OpenAiTool[];
  private onError?: ErrorReporter;
  constructor(
    private apiKey: string,
    private model = 'gpt-4o-mini',
    opts: { tools?: OpenAiTool[]; baseUrl?: string; onError?: ErrorReporter } = {},
    private baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1',
  ) {
    this.tools = opts.tools && opts.tools.length ? opts.tools : undefined;
    this.onError = opts.onError;
  }

  async *generate(messages: Message[], opts?: { signal?: AbortSignal }): AsyncIterable<LlmDelta> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: messages.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content })),
          stream: true,
          max_tokens: 300,
          temperature: 0.6,
          ...(this.tools ? { tools: this.tools, tool_choice: 'auto' } : {}),
        }),
        signal: opts?.signal,
      });
    } catch (e) {
      if (!opts?.signal?.aborted) this.onError?.('OpenAI request threw', { model: this.model, error: String(e) });
      yield { type: 'done' };
      return;
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      this.onError?.('OpenAI request failed', { status: res.status, body: body.slice(0, 300) });
      yield { type: 'done' };
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let produced = false;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const flushTools = (): LlmDelta[] => {
      const out: LlmDelta[] = [];
      for (const [, t] of toolAcc) {
        if (!t.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = t.args ? JSON.parse(t.args) : {};
        } catch {
          args = {};
        }
        out.push({ type: 'toolCall', id: t.id || t.name, name: t.name, arguments: args });
      }
      return out;
    };

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
            const tools = flushTools();
            for (const d of tools) yield d;
            if (!produced && tools.length === 0) {
              this.onError?.('OpenAI returned an empty response', { model: this.model }, 'warn');
            }
            yield { type: 'done' };
            return;
          }
          try {
            const j = JSON.parse(data) as { choices?: { delta?: OpenAiDelta }[] };
            const delta = j.choices?.[0]?.delta;
            if (delta?.content) {
              produced = true;
              yield { type: 'text', text: delta.content };
            }
            if (delta?.tool_calls) {
              produced = true;
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                toolAcc.set(idx, cur);
              }
            }
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
    const tools = flushTools();
    for (const d of tools) yield d;
    if (!produced && tools.length === 0 && !opts?.signal?.aborted) {
      this.onError?.('OpenAI stream ended with no output', { model: this.model }, 'warn');
    }
    yield { type: 'done' };
  }
}

/** TTS over Workers AI Deepgram Aura. Buffers the full clip per sentence for simple playback. */
export class AuraTts implements TtsPort {
  constructor(
    private ai: Ai,
    private voiceId = 'angus',
    private onError?: ErrorReporter,
    private googleApiKey?: string,
  ) {}

  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    if (opts?.signal?.aborted) return;
    try {
      const { bytes } = await synthesizeTts({
        ai: this.ai,
        googleApiKey: this.googleApiKey,
        voiceId: this.voiceId,
        text,
      });
      if (opts?.signal?.aborted) return;
      if (bytes.length > 0) yield { data: bytes };
      else this.onError?.('TTS returned no audio', { voiceId: this.voiceId, chars: text.length }, 'warn');
    } catch (e) {
      this.onError?.('TTS call failed', { voiceId: this.voiceId, error: String(e) });
    }
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
