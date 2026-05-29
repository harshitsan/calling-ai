# Phase 1 — Conversation Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the transport-agnostic conversational voice-agent engine — the STT→LLM→TTS turn loop with eager TTS chunking, barge-in, the `end_call` tool, and per-stage latency instrumentation — as pure TypeScript with injected ports, fully unit-tested without a live Cloudflare account.

**Architecture:** Hexagonal (ports & adapters). The `ConversationEngine` state machine depends only on four interfaces — `SttPort`, `LlmPort`, `TtsPort`, `ClientPort` — plus an injectable `Clock`. Real Cloudflare adapters (Deepgram Flux/Aura over WebSocket, Workers AI LLM) and the Durable Object + client SDK wiring are **separate follow-on plans** (they need a CF account to integration-test). This plan delivers the latency-critical core (`plan.md` §4, §9) and its tests (`plan.md` §18).

**Tech Stack:** TypeScript (ESM, strict), Vitest. No runtime dependencies.

**Decomposition of `plan.md` (this plan = #1):**
1. **Conversation engine core** ← this plan
2. Cloudflare adapters (Flux STT, Aura TTS, Workers AI LLM) + Durable Object + WS signaling Worker + wrangler config
3. Browser client SDK (AudioWorklet capture, VAD, Opus, playback, barge-in)
4. Multi-tenancy + agent builder + dashboard (`plan.md` §6, §7, §12)
5. Vectorless KG memory (`plan.md` §10)
6. Scale hardening / WebRTC / PSTN (`plan.md` §15, §5)

**MVP assumptions (defaults; open questions in `plan.md` §21 deferred to later phases):** single-tenant, fast Workers AI model only (no escalation), recording off, memory deferred, latency SLO p50 ≤700ms / p95 ≤1.2s. Only built-in tool wired is `end_call`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | TS + Vitest scaffold |
| `src/engine/types.ts` | Domain types: `Message`, `EngineState`, `SttEvent`, `LlmDelta`, `ClientEvent`, `Clock`, `AudioChunk` |
| `src/engine/ports.ts` | Port interfaces: `SttPort`, `LlmPort`, `TtsPort`, `ClientPort` |
| `src/engine/chunking.ts` | `TextChunker` — eager token→speakable-chunk splitter |
| `src/engine/tools.ts` | Tool registry, `END_CALL_TOOL`, `dispatchTool` |
| `src/engine/latency.ts` | `TurnLatency` — per-stage timing with injected clock |
| `src/engine/conversation-engine.ts` | `ConversationEngine` — the turn-loop state machine |
| `src/engine/testing/fakes.ts` | Fake ports + `ManualClock` for tests |
| `src/engine/index.ts` | Barrel export |

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Test: `src/engine/smoke.test.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "calling-ai-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "WebWorker"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
```

- [ ] **Step 4: Write smoke test `src/engine/smoke.test.ts`**

```ts
import { expect, test } from 'vitest';

test('vitest harness runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Install and run**

Run: `npm install && npm test`
Expected: 1 passing test.

- [ ] **Step 6: Commit**

```bash
printf 'node_modules\ndist\n.wrangler\n' > .gitignore
git add package.json tsconfig.json vitest.config.ts src/engine/smoke.test.ts .gitignore package-lock.json
git commit -m "chore: scaffold TS + Vitest for conversation engine"
```

---

## Task 1: Domain types and ports

**Files:**
- Create: `src/engine/types.ts`, `src/engine/ports.ts`

- [ ] **Step 1: Write `src/engine/types.ts`**

```ts
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export type EngineState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'ended';

export interface AudioChunk {
  data: Uint8Array;
}

export type SttEvent =
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'endOfTurn'; text: string };

export type LlmDelta =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'done' };

export type LatencyMark = 'endOfTurn' | 'llmFirstToken' | 'ttsFirstAudio';

export interface TurnLatencySummary {
  endpointToFirstToken?: number;
  firstTokenToFirstAudio?: number;
  endpointToFirstAudio?: number;
  marks: Partial<Record<LatencyMark, number>>;
}

export type ClientEvent =
  | { type: 'state'; state: EngineState }
  | { type: 'transcript'; role: Role; text: string }
  | { type: 'audio'; chunk: AudioChunk }
  | { type: 'flush' }
  | { type: 'ended'; reason: string }
  | { type: 'latency'; turn: TurnLatencySummary };

export interface Clock {
  now(): number;
}
```

- [ ] **Step 2: Write `src/engine/ports.ts`**

```ts
import type { AudioChunk, LlmDelta, Message, SttEvent, ClientEvent } from './types';

export interface SttPort {
  sendAudio(frame: Uint8Array): void;
  onEvent(handler: (event: SttEvent) => void): void;
  close(): void;
}

export interface LlmPort {
  generate(messages: Message[], opts?: { signal?: AbortSignal }): AsyncIterable<LlmDelta>;
}

export interface TtsPort {
  synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk>;
}

export interface ClientPort {
  emit(event: ClientEvent): void;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/engine/types.ts src/engine/ports.ts
git commit -m "feat: define engine domain types and ports"
```

---

## Task 2: TextChunker (eager TTS chunking)

**Files:**
- Create: `src/engine/chunking.ts`
- Test: `src/engine/chunking.test.ts`

Eager chunking emits speakable text as early as possible so TTS starts before the LLM finishes (`plan.md` §4.3). Rules: emit on sentence-ender (`.!?`) + whitespace; emit on clause-ender (`,;:`) + whitespace once `minWords` reached; force-emit at `maxWords`; `flush()` returns the remainder.

- [ ] **Step 1: Write failing test `src/engine/chunking.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import { TextChunker } from './chunking';

describe('TextChunker', () => {
  test('emits a sentence when a terminator is followed by space', () => {
    const c = new TextChunker();
    expect(c.push('Hello there. ')).toEqual(['Hello there.']);
  });

  test('buffers an incomplete sentence until flushed', () => {
    const c = new TextChunker();
    expect(c.push('Hello there')).toEqual([]);
    expect(c.flush()).toBe('Hello there');
  });

  test('emits on a clause boundary only after minWords', () => {
    const c = new TextChunker({ minWords: 3 });
    expect(c.push('one, ')).toEqual([]); // only 1 word before comma
    expect(c.push('two three four, ')).toEqual(['one, two three four,']);
  });

  test('force-emits at maxWords without punctuation', () => {
    const c = new TextChunker({ maxWords: 4 });
    expect(c.push('alpha beta gamma delta epsilon ')).toEqual(['alpha beta gamma delta']);
  });

  test('handles deltas split mid-token across pushes', () => {
    const c = new TextChunker();
    expect(c.push('Hel')).toEqual([]);
    expect(c.push('lo. ')).toEqual(['Hello.']);
  });

  test('flush returns null when buffer empty', () => {
    const c = new TextChunker();
    c.push('Done. ');
    expect(c.flush()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/chunking.test.ts`
Expected: FAIL — cannot find module `./chunking`.

- [ ] **Step 3: Write `src/engine/chunking.ts`**

```ts
export interface ChunkerOptions {
  minWords?: number;
  maxWords?: number;
}

export class TextChunker {
  private buffer = '';
  private readonly minWords: number;
  private readonly maxWords: number;

  constructor(opts: ChunkerOptions = {}) {
    this.minWords = opts.minWords ?? 3;
    this.maxWords = opts.maxWords ?? 20;
  }

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    let chunk: string | null;
    while ((chunk = this.extract()) !== null) out.push(chunk);
    return out;
  }

  flush(): string | null {
    const text = this.buffer.trim();
    this.buffer = '';
    return text.length > 0 ? text : null;
  }

  private wordCount(s: string): number {
    const t = s.trim();
    return t.length === 0 ? 0 : t.split(/\s+/).length;
  }

  private extract(): string | null {
    const buf = this.buffer;
    // Earliest boundary that is valid to emit: sentence-ender always,
    // clause-ender only once minWords is reached. Punctuation must be
    // followed by whitespace (avoids splitting "3.14" or mid-stream tokens).
    const re = /[.!?,;:](?=\s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(buf)) !== null) {
      const idx = m.index;
      const piece = buf.slice(0, idx + 1);
      const isSentence = buf[idx] === '.' || buf[idx] === '!' || buf[idx] === '?';
      if (isSentence || this.wordCount(piece) >= this.minWords) {
        this.buffer = buf.slice(idx + 1).replace(/^\s+/, '');
        return piece.trim();
      }
    }
    if (this.wordCount(buf) >= this.maxWords) {
      const words = buf.trim().split(/\s+/);
      const take = words.slice(0, this.maxWords).join(' ');
      this.buffer = words.slice(this.maxWords).join(' ');
      return take.trim();
    }
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/chunking.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/chunking.ts src/engine/chunking.test.ts
git commit -m "feat: eager TextChunker for low-latency TTS"
```

---

## Task 3: Tools and end_call

**Files:**
- Create: `src/engine/tools.ts`
- Test: `src/engine/tools.test.ts`

- [ ] **Step 1: Write failing test `src/engine/tools.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import { END_CALL_TOOL, dispatchTool } from './tools';

describe('tools', () => {
  test('end_call tool definition is exposed', () => {
    expect(END_CALL_TOOL.name).toBe('end_call');
    expect(END_CALL_TOOL.parameters.required).toContain('reason');
  });

  test('dispatch end_call returns endCall result with reason + farewell', () => {
    const r = dispatchTool({ id: '1', name: 'end_call', arguments: { reason: 'done', farewell: 'Bye!' } });
    expect(r).toEqual({ type: 'endCall', reason: 'done', farewell: 'Bye!' });
  });

  test('dispatch end_call defaults reason when missing', () => {
    const r = dispatchTool({ id: '1', name: 'end_call', arguments: {} });
    expect(r).toEqual({ type: 'endCall', reason: 'completed', farewell: undefined });
  });

  test('unknown tool returns a continue error', () => {
    const r = dispatchTool({ id: '2', name: 'mystery', arguments: {} });
    expect(r).toEqual({ type: 'continue', content: 'Error: unknown tool "mystery".' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/tools.test.ts`
Expected: FAIL — cannot find module `./tools`.

- [ ] **Step 3: Write `src/engine/tools.ts`**

```ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ToolResult =
  | { type: 'continue'; content: string }
  | { type: 'endCall'; reason: string; farewell?: string };

export const END_CALL_TOOL: ToolDefinition = {
  name: 'end_call',
  description: 'End the call when the conversation is complete or the caller asks to hang up.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why the call is ending.' },
      farewell: { type: 'string', description: 'Optional closing line to speak before hanging up.' },
    },
    required: ['reason'],
  },
};

export function dispatchTool(call: ToolCall): ToolResult {
  switch (call.name) {
    case 'end_call':
      return {
        type: 'endCall',
        reason: typeof call.arguments.reason === 'string' ? call.arguments.reason : 'completed',
        farewell: typeof call.arguments.farewell === 'string' ? call.arguments.farewell : undefined,
      };
    default:
      return { type: 'continue', content: `Error: unknown tool "${call.name}".` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/engine/tools.ts src/engine/tools.test.ts
git commit -m "feat: tool registry with built-in end_call"
```

---

## Task 4: TurnLatency

**Files:**
- Create: `src/engine/latency.ts`
- Test: `src/engine/latency.test.ts`

- [ ] **Step 1: Write failing test `src/engine/latency.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import { TurnLatency } from './latency';
import { ManualClock } from './testing/fakes';

describe('TurnLatency', () => {
  test('computes per-stage deltas from marks', () => {
    const clock = new ManualClock(1000);
    const lat = new TurnLatency(clock);
    lat.mark('endOfTurn');
    clock.advance(200);
    lat.mark('llmFirstToken');
    clock.advance(150);
    lat.mark('ttsFirstAudio');

    const s = lat.summary();
    expect(s.endpointToFirstToken).toBe(200);
    expect(s.firstTokenToFirstAudio).toBe(150);
    expect(s.endpointToFirstAudio).toBe(350);
  });

  test('first mark wins (idempotent per stage)', () => {
    const clock = new ManualClock(0);
    const lat = new TurnLatency(clock);
    lat.mark('endOfTurn');
    clock.advance(50);
    lat.mark('endOfTurn');
    expect(lat.summary().marks.endOfTurn).toBe(0);
  });

  test('missing marks yield undefined deltas', () => {
    const lat = new TurnLatency(new ManualClock(0));
    lat.mark('endOfTurn');
    expect(lat.summary().endpointToFirstAudio).toBeUndefined();
  });
});
```

- [ ] **Step 2: Write `src/engine/testing/fakes.ts` (ManualClock portion)**

> Note: this file is extended in Task 5 with fake ports. Create it now with `ManualClock`.

```ts
import type { Clock } from '../types';

export class ManualClock implements Clock {
  constructor(private t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/engine/latency.test.ts`
Expected: FAIL — cannot find module `./latency`.

- [ ] **Step 4: Write `src/engine/latency.ts`**

```ts
import type { Clock, LatencyMark, TurnLatencySummary } from './types';

export class TurnLatency {
  private marks: Partial<Record<LatencyMark, number>> = {};

  constructor(private clock: Clock) {}

  mark(m: LatencyMark): void {
    if (this.marks[m] === undefined) this.marks[m] = this.clock.now();
  }

  summary(): TurnLatencySummary {
    const m = this.marks;
    const diff = (a?: number, b?: number) =>
      a !== undefined && b !== undefined ? b - a : undefined;
    return {
      endpointToFirstToken: diff(m.endOfTurn, m.llmFirstToken),
      firstTokenToFirstAudio: diff(m.llmFirstToken, m.ttsFirstAudio),
      endpointToFirstAudio: diff(m.endOfTurn, m.ttsFirstAudio),
      marks: { ...m },
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/engine/latency.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/engine/latency.ts src/engine/latency.test.ts src/engine/testing/fakes.ts
git commit -m "feat: per-turn latency instrumentation"
```

---

## Task 5: ConversationEngine state machine

**Files:**
- Create: `src/engine/conversation-engine.ts`
- Modify: `src/engine/testing/fakes.ts` (add fake ports)
- Test: `src/engine/conversation-engine.test.ts`

- [ ] **Step 1: Extend `src/engine/testing/fakes.ts` with fake ports**

Append below `ManualClock`:

```ts
import type { AudioChunk, ClientEvent, LlmDelta, Message, SttEvent } from '../types';
import type { ClientPort, LlmPort, SttPort, TtsPort } from '../ports';

export class FakeStt implements SttPort {
  sent: Uint8Array[] = [];
  private handler: ((e: SttEvent) => void) | null = null;
  closed = false;
  sendAudio(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  onEvent(handler: (e: SttEvent) => void): void {
    this.handler = handler;
  }
  close(): void {
    this.closed = true;
  }
  emit(e: SttEvent): void {
    this.handler?.(e);
  }
}

export class FakeLlm implements LlmPort {
  constructor(private script: LlmDelta[]) {}
  lastMessages: Message[] = [];
  async *generate(messages: Message[], opts?: { signal?: AbortSignal }): AsyncIterable<LlmDelta> {
    this.lastMessages = messages;
    for (const delta of this.script) {
      if (opts?.signal?.aborted) return;
      yield delta;
      await Promise.resolve();
    }
  }
}

export class FakeTts implements TtsPort {
  calls: string[] = [];
  async *synthesize(text: string, opts?: { signal?: AbortSignal }): AsyncIterable<AudioChunk> {
    this.calls.push(text);
    if (opts?.signal?.aborted) return;
    yield { data: new TextEncoder().encode(text) };
    await Promise.resolve();
  }
}

export class FakeClient implements ClientPort {
  events: ClientEvent[] = [];
  emit(event: ClientEvent): void {
    this.events.push(event);
  }
  states(): string[] {
    return this.events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
  }
  audioText(): string[] {
    return this.events
      .filter((e) => e.type === 'audio')
      .map((e) => new TextDecoder().decode((e as { chunk: AudioChunk }).chunk.data));
  }
}
```

- [ ] **Step 2: Write failing test `src/engine/conversation-engine.test.ts`**

```ts
import { describe, expect, test } from 'vitest';
import { ConversationEngine } from './conversation-engine';
import { FakeClient, FakeLlm, FakeStt, FakeTts, ManualClock } from './testing/fakes';

function makeEngine(llm: FakeLlm) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const client = new FakeClient();
  const engine = new ConversationEngine({
    stt, llm, tts, client, clock: new ManualClock(0),
    systemPrompt: 'You are a helpful agent.',
  });
  engine.start();
  return { engine, stt, tts, client };
}

describe('ConversationEngine', () => {
  test('runs a turn: STT end-of-turn -> LLM -> chunked TTS -> audio to client', async () => {
    const llm = new FakeLlm([
      { type: 'text', text: 'Hi there. ' },
      { type: 'text', text: 'How can I help?' },
      { type: 'done' },
    ]);
    const { engine, stt, tts, client } = makeEngine(llm);

    stt.emit({ type: 'endOfTurn', text: 'hello' });
    await new Promise((r) => setTimeout(r, 0));

    expect(tts.calls).toEqual(['Hi there.', 'How can I help?']);
    expect(client.audioText()).toEqual(['Hi there.', 'How can I help?']);
    expect(engine.getState()).toBe('listening');
    const history = engine.getHistory();
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'Hi there. How can I help?' });
  });

  test('emits a latency summary on first audio', async () => {
    const llm = new FakeLlm([{ type: 'text', text: 'Ok. ' }, { type: 'done' }]);
    const { stt, client } = makeEngine(llm);
    stt.emit({ type: 'endOfTurn', text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));
    expect(client.events.some((e) => e.type === 'latency')).toBe(true);
  });

  test('end_call tool ends the call and speaks the farewell', async () => {
    const llm = new FakeLlm([
      { type: 'toolCall', id: 't1', name: 'end_call', arguments: { reason: 'done', farewell: 'Goodbye!' } },
    ]);
    const { engine, stt, tts, client } = makeEngine(llm);
    stt.emit({ type: 'endOfTurn', text: 'bye' });
    await new Promise((r) => setTimeout(r, 0));

    expect(tts.calls).toEqual(['Goodbye!']);
    expect(engine.getState()).toBe('ended');
    expect(stt.closed).toBe(true);
    expect(client.events.some((e) => e.type === 'ended' && e.reason === 'done')).toBe(true);
  });

  test('barge-in cancels the turn, flushes, and returns to listening', async () => {
    // long script so we can interrupt mid-generation
    const llm = new FakeLlm([
      { type: 'text', text: 'One. ' },
      { type: 'text', text: 'Two. ' },
      { type: 'text', text: 'Three. ' },
      { type: 'done' },
    ]);
    const { engine, stt, client } = makeEngine(llm);
    const turn = (async () => { stt.emit({ type: 'endOfTurn', text: 'go' }); })();
    engine.interrupt(); // interrupt immediately
    await turn;
    await new Promise((r) => setTimeout(r, 0));

    expect(client.events.some((e) => e.type === 'flush')).toBe(true);
    expect(engine.getState()).toBe('listening');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/engine/conversation-engine.test.ts`
Expected: FAIL — cannot find module `./conversation-engine`.

- [ ] **Step 4: Write `src/engine/conversation-engine.ts`**

```ts
import { TextChunker, type ChunkerOptions } from './chunking';
import { TurnLatency } from './latency';
import { dispatchTool } from './tools';
import type { ClientPort, LlmPort, SttPort, TtsPort } from './ports';
import type { Clock, EngineState, Message, SttEvent } from './types';

export interface EngineDeps {
  stt: SttPort;
  llm: LlmPort;
  tts: TtsPort;
  client: ClientPort;
  clock: Clock;
  systemPrompt: string;
  chunkerOptions?: ChunkerOptions;
}

export class ConversationEngine {
  private state: EngineState = 'idle';
  private history: Message[] = [];
  private turnId = 0;
  private abort: AbortController | null = null;

  constructor(private deps: EngineDeps) {
    this.history.push({ role: 'system', content: deps.systemPrompt });
    deps.stt.onEvent((e) => this.onStt(e));
  }

  start(): void {
    this.setState('listening');
  }

  pushAudio(frame: Uint8Array): void {
    this.deps.stt.sendAudio(frame);
  }

  interrupt(): void {
    if (this.state === 'speaking' || this.state === 'thinking') {
      this.cancelCurrentTurn();
      this.deps.client.emit({ type: 'flush' });
      this.setState('listening');
    }
  }

  end(reason: string): void {
    if (this.state === 'ended') return;
    this.cancelCurrentTurn();
    this.deps.stt.close();
    this.setState('ended');
    this.deps.client.emit({ type: 'ended', reason });
  }

  getState(): EngineState {
    return this.state;
  }

  getHistory(): Message[] {
    return [...this.history];
  }

  private cancelCurrentTurn(): void {
    this.turnId++;
    this.abort?.abort();
    this.abort = null;
  }

  private onStt(e: SttEvent): void {
    if (e.type === 'partial') {
      this.deps.client.emit({ type: 'transcript', role: 'user', text: e.text });
      return;
    }
    if (e.type === 'endOfTurn') {
      void this.handleTurn(e.text);
    }
  }

  private async handleTurn(userText: string): Promise<void> {
    if (this.state === 'ended') return;
    const myTurn = ++this.turnId;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const latency = new TurnLatency(this.deps.clock);
    latency.mark('endOfTurn');

    this.history.push({ role: 'user', content: userText });
    this.deps.client.emit({ type: 'transcript', role: 'user', text: userText });
    this.setState('thinking');

    const chunker = new TextChunker(this.deps.chunkerOptions);
    let assistantText = '';
    let firstToken = false;
    let firstAudio = false;

    const speak = async (text: string): Promise<void> => {
      if (text.trim().length === 0) return;
      for await (const audio of this.deps.tts.synthesize(text, { signal })) {
        if (myTurn !== this.turnId) return;
        if (!firstAudio) {
          firstAudio = true;
          latency.mark('ttsFirstAudio');
          this.deps.client.emit({ type: 'latency', turn: latency.summary() });
        }
        this.deps.client.emit({ type: 'audio', chunk: audio });
      }
    };

    try {
      for await (const delta of this.deps.llm.generate(this.history, { signal })) {
        if (myTurn !== this.turnId) return;
        if (delta.type === 'text') {
          if (!firstToken) {
            firstToken = true;
            latency.mark('llmFirstToken');
          }
          assistantText += delta.text;
          if (this.state !== 'speaking') this.setState('speaking');
          for (const chunk of chunker.push(delta.text)) await speak(chunk);
        } else if (delta.type === 'toolCall') {
          const result = dispatchTool({ id: delta.id, name: delta.name, arguments: delta.arguments });
          if (result.type === 'endCall') {
            if (result.farewell) {
              this.setState('speaking');
              await speak(result.farewell);
            }
            this.finishAssistantTurn(assistantText);
            this.end(result.reason);
            return;
          }
          this.deps.client.emit({ type: 'transcript', role: 'tool', text: result.content });
        } else if (delta.type === 'done') {
          break;
        }
      }
      if (myTurn !== this.turnId) return;
      const tail = chunker.flush();
      if (tail) await speak(tail);
      if (myTurn !== this.turnId) return;
      this.finishAssistantTurn(assistantText);
      this.setState('listening');
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
  }

  private finishAssistantTurn(text: string): void {
    if (text.trim().length > 0) {
      this.history.push({ role: 'assistant', content: text });
      this.deps.client.emit({ type: 'transcript', role: 'assistant', text });
    }
  }

  private setState(s: EngineState): void {
    if (this.state === s) return;
    this.state = s;
    this.deps.client.emit({ type: 'state', state: s });
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/engine/conversation-engine.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/engine/conversation-engine.ts src/engine/conversation-engine.test.ts src/engine/testing/fakes.ts
git commit -m "feat: ConversationEngine turn-loop state machine with barge-in"
```

---

## Task 6: Barrel export and full suite

**Files:**
- Create: `src/engine/index.ts`

- [ ] **Step 1: Write `src/engine/index.ts`**

```ts
export * from './types';
export * from './ports';
export { TextChunker, type ChunkerOptions } from './chunking';
export { END_CALL_TOOL, dispatchTool, type ToolCall, type ToolDefinition, type ToolResult } from './tools';
export { TurnLatency } from './latency';
export { ConversationEngine, type EngineDeps } from './conversation-engine';
```

- [ ] **Step 2: Run full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all tests pass (smoke + chunking 6 + tools 4 + latency 3 + engine 4 = 18), no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/engine/index.ts
git commit -m "feat: barrel export for engine package"
```

---

## Self-Review

**Spec coverage (`plan.md`):**
- §4 latency instrumentation → Task 4 + engine latency marks (Task 5). ✓
- §4.3 eager chunking → Task 2. ✓
- §4.10 barge-in → Task 5 `interrupt()`. ✓
- §8 `end_call` tool → Task 3 + Task 5 tool handling. ✓
- §9 turn loop (STT→LLM→TTS, history) → Task 5. ✓
- §18 unit tests with mocked STT/TTS/LLM → fakes + all tests. ✓
- Deferred (separate plans): real adapters, DO/WS, client SDK, multi-tenancy, memory, dashboard. Documented in decomposition. ✓

**Placeholders:** none — every step has runnable code/commands.

**Type consistency:** `Message`, `EngineState`, `SttEvent`, `LlmDelta`, `ClientEvent`, `Clock` defined in Task 1 and used consistently in Tasks 4–6. Ports defined in Task 1 implemented by fakes in Task 5. `dispatchTool`/`ToolResult` signature from Task 3 matches usage in Task 5.

**Known MVP simplifications (intentional, YAGNI):** only `end_call` wired; non-`end_call` tools emit a transcript note and do not re-invoke the LLM (multi-tool re-generation is a later phase). Speculative generation (§4.2) deferred to Phase 2 per `plan.md` §20.
