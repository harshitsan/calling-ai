import type { AudioChunk, Clock, ClientEvent, LlmDelta, Message, SttEvent } from '../types';
import type { ClientPort, LlmPort, SttPort, TtsPort } from '../ports';

export class ManualClock implements Clock {
  constructor(private t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

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
    return this.events
      .filter((e) => e.type === 'state')
      .map((e) => (e as { state: string }).state);
  }
  audioText(): string[] {
    return this.events
      .filter((e) => e.type === 'audio')
      .map((e) => new TextDecoder().decode((e as { chunk: AudioChunk }).chunk.data));
  }
}
