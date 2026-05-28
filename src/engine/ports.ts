import type { AudioChunk, ClientEvent, LlmDelta, Message, SttEvent } from './types';

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
