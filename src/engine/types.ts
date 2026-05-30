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
  /** Codec of the bytes — 'mp3' (default, full clip), 'wav' (full clip), or 'pcm' (raw L16 streamed chunk). */
  codec?: 'mp3' | 'wav' | 'pcm';
  /** Required when codec === 'pcm'. */
  sampleRate?: number;
  /** Required when codec === 'pcm'; defaults to 1. */
  channels?: number;
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
