// Per-tenant realtime log fan-out. Keeps a small ring buffer and broadcasts
// every published event to all connected dashboard subscribers over WebSocket.

export interface LogEvent {
  ts?: number;
  service: string; // 'call' | 'stt' | 'llm' | 'tts' | 'memory' | 'tool' | 'auth' | 'system'
  level?: 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
  callId?: string;
}

const BUFFER_MAX = 200;

export class LogHub {
  private subscribers = new Set<WebSocket>();
  private buffer: LogEvent[] = [];

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/publish' && request.method === 'POST') {
      const ev = (await request.json().catch(() => null)) as LogEvent | null;
      if (!ev) return new Response('bad', { status: 400 });
      ev.ts = ev.ts ?? Date.now();
      ev.level = ev.level ?? 'info';
      this.buffer.push(ev);
      if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
      const msg = JSON.stringify({ type: 'log', event: ev });
      for (const ws of this.subscribers) {
        try {
          ws.send(msg);
        } catch {
          this.subscribers.delete(ws);
        }
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      this.subscribers.add(server);
      server.send(JSON.stringify({ type: 'history', events: this.buffer }));
      server.addEventListener('close', () => this.subscribers.delete(server));
      server.addEventListener('error', () => this.subscribers.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }
}

export function publishLog(env: Env, tenantId: string | null, ev: LogEvent): Promise<unknown> {
  if (!tenantId) return Promise.resolve();
  try {
    const stub = env.LOGS.get(env.LOGS.idFromName(tenantId));
    return stub.fetch('https://logs/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ev),
    });
  } catch {
    return Promise.resolve();
  }
}
