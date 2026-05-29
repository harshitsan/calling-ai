// Per-tenant realtime log fan-out + durable storage. Events are persisted to the
// DO's SQLite store (survive eviction/refresh) and broadcast to live subscribers.

export interface LogEvent {
  ts?: number;
  service: string; // 'call' | 'stt' | 'llm' | 'tts' | 'memory' | 'tool' | 'auth' | 'system'
  level?: 'info' | 'warn' | 'error';
  msg: string;
  data?: Record<string, unknown>;
  callId?: string;
}

const KEEP_ROWS = 5000;
const HISTORY_LIMIT = 400;

interface Row {
  ts: number;
  service: string;
  level: string;
  msg: string;
  data: string;
  call_id: string | null;
}

export class LogHub {
  private subscribers = new Set<WebSocket>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          service TEXT NOT NULL,
          level TEXT NOT NULL,
          msg TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          call_id TEXT
        )`,
      );
    });
  }

  private history(): LogEvent[] {
    const rows = this.state.storage.sql
      .exec<Row>('SELECT ts, service, level, msg, data, call_id FROM logs ORDER BY id DESC LIMIT ?', HISTORY_LIMIT)
      .toArray()
      .reverse();
    return rows.map((r) => ({
      ts: r.ts,
      service: r.service,
      level: r.level as LogEvent['level'],
      msg: r.msg,
      data: JSON.parse(r.data || '{}'),
      callId: r.call_id ?? undefined,
    }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/publish' && request.method === 'POST') {
      const ev = (await request.json().catch(() => null)) as LogEvent | null;
      if (!ev) return new Response('bad', { status: 400 });
      ev.ts = ev.ts ?? Date.now();
      ev.level = ev.level ?? 'info';
      this.state.storage.sql.exec(
        'INSERT INTO logs (ts, service, level, msg, data, call_id) VALUES (?, ?, ?, ?, ?, ?)',
        ev.ts,
        ev.service,
        ev.level,
        ev.msg,
        JSON.stringify(ev.data ?? {}),
        ev.callId ?? null,
      );
      // cheap cap: trim rows older than the most recent KEEP_ROWS
      this.state.storage.sql.exec(
        'DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - ?',
        KEEP_ROWS,
      );
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

    if (url.pathname === '/history') {
      return Response.json({ events: this.history() });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      this.subscribers.add(server);
      server.send(JSON.stringify({ type: 'history', events: this.history() }));
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
