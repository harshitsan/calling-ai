import { ConversationEngine } from '../engine/conversation-engine';
import type { ClientPort } from '../engine/ports';
import type { ClientEvent } from '../engine/types';
import { AuraTts, ClientFedStt, WorkersAiLlm } from './adapters';

const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly, concise voice agent on a phone call. Keep replies short and natural, one or two sentences. Do not use markdown or emoji.';

class WsClientPort implements ClientPort {
  constructor(private ws: WebSocket) {}
  emit(event: ClientEvent): void {
    if (event.type === 'audio') {
      // binary frame = one playable audio clip
      this.ws.send(event.chunk.data);
      return;
    }
    this.ws.send(JSON.stringify(event));
  }
}

export class CallSession {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const url = new URL(request.url);
    const speaker = url.searchParams.get('voice') ?? 'angus';
    const systemPrompt = url.searchParams.get('prompt') ?? DEFAULT_SYSTEM_PROMPT;

    const stt = new ClientFedStt();
    const engine = new ConversationEngine({
      stt,
      llm: new WorkersAiLlm(this.env.AI),
      tts: new AuraTts(this.env.AI, speaker),
      client: new WsClientPort(server),
      clock: { now: () => Date.now() },
      systemPrompt,
    });
    engine.start();

    server.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      let msg: { type?: string; text?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'userText' && typeof msg.text === 'string') {
        stt.feedEndOfTurn(msg.text);
      } else if (msg.type === 'partial' && typeof msg.text === 'string') {
        stt.feedPartial(msg.text);
      } else if (msg.type === 'interrupt') {
        engine.interrupt();
      } else if (msg.type === 'hangup') {
        engine.end('client_hangup');
      }
    });

    server.addEventListener('close', () => engine.end('socket_closed'));

    return new Response(null, { status: 101, webSocket: client });
  }
}
