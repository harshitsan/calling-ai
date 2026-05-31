import { TextChunker, type ChunkerOptions } from './chunking';
import { TurnLatency } from './latency';
import { dispatchTool, type ToolCall, type ToolResult } from './tools';
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
  /** Custom tool executor (e.g. tenant webhooks). Defaults to built-in dispatch. */
  onToolCall?: (call: ToolCall) => ToolResult | Promise<ToolResult>;
}

export class ConversationEngine {
  private state: EngineState = 'idle';
  private history: Message[] = [];
  private turnId = 0;
  private abort: AbortController | null = null;
  /** In-flight assistant text for the current turn, exposed so interrupt() can
   *  commit it to history before cancelling — keeps context intact across
   *  barge-ins so the next LLM call has the full conversation. */
  private inflightAssist = '';

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
      // Commit whatever the agent had generated so far BEFORE we cancel,
      // so the next turn's LLM call still has full conversation context.
      if (this.inflightAssist.trim().length > 0) {
        this.finishAssistantTurn(this.inflightAssist);
        this.inflightAssist = '';
      }
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
    this.inflightAssist = '';

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
          this.inflightAssist = assistantText;
          if (this.state !== 'speaking') this.setState('speaking');
          for (const chunk of chunker.push(delta.text)) await speak(chunk);
        } else if (delta.type === 'toolCall') {
          const exec = this.deps.onToolCall ?? dispatchTool;
          const result = await exec({ id: delta.id, name: delta.name, arguments: delta.arguments });
          if (myTurn !== this.turnId) return;
          if (result.type === 'endCall') {
            if (result.farewell) {
              this.setState('speaking');
              await speak(result.farewell);
            }
            this.finishAssistantTurn(assistantText);
            this.end(`tool:${result.reason || 'completed'}`);
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
      this.inflightAssist = '';
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
