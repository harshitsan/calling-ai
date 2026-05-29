import { ConversationEngine } from '../engine/conversation-engine';
import type { ClientPort } from '../engine/ports';
import { dispatchTool, type ToolCall, type ToolResult } from '../engine/tools';
import type { ClientEvent } from '../engine/types';
import { AuraTts, ClientFedStt, WorkersAiLlm } from './adapters';
import { verifyJwt } from './auth';
import { estimateCallCost } from './cost';
import { uuid } from './util';

const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly, concise voice agent on a phone call. Keep replies short and natural, one or two sentences. Do not use markdown or emoji.';
const SUMMARY_MODEL = '@cf/meta/llama-3.1-8b-instruct';

interface AgentConfig {
  id: string;
  name: string;
  voice: string;
  systemPromptTemplate: string;
  variables: { name: string; source: string; default?: string }[];
  tools: { name: string; webhookUrl?: string }[];
}

interface Turn {
  role: string;
  text: string;
  ts: number;
}

class RecordingClientPort implements ClientPort {
  constructor(
    private ws: WebSocket,
    private hooks: {
      onTurn: (t: Turn) => void;
      onLatency: (ms: number) => void;
      onEnded: (reason: string) => void;
    },
  ) {}
  emit(event: ClientEvent): void {
    if (event.type === 'audio') {
      this.ws.send(event.chunk.data);
      return;
    }
    if (event.type === 'transcript') {
      this.hooks.onTurn({ role: event.role, text: event.text, ts: Date.now() });
    } else if (event.type === 'latency' && event.turn.endpointToFirstAudio != null) {
      this.hooks.onLatency(event.turn.endpointToFirstAudio);
    } else if (event.type === 'ended') {
      this.hooks.onEnded(event.reason);
    }
    this.ws.send(JSON.stringify(event));
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => vars[name] ?? '');
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export class CallSession {
  private callId = uuid();
  private tenantId: string | null = null;
  private agentId: string | null = null;
  private callerRef: string | null = null;
  private startedAt = Date.now();
  private turns: Turn[] = [];
  private latencies: number[] = [];
  private speakingChars = 0;
  private finalized = false;

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const url = new URL(request.url);
    const params = url.searchParams;
    const agentId = params.get('agentId');
    const token = params.get('token');
    this.callerRef = params.get('customer_name') ?? params.get('caller') ?? null;

    let systemPrompt = params.get('prompt') ?? DEFAULT_SYSTEM_PROMPT;
    let voice = params.get('voice') ?? 'asteria';
    let toolMap = new Map<string, string | undefined>();

    if (token) {
      const claims = await verifyJwt(token, this.secret());
      if (claims) this.tenantId = claims.tid;
    }

    if (agentId && this.tenantId) {
      const agent = await this.loadAgent(agentId);
      if (agent) {
        this.agentId = agent.id;
        const vars: Record<string, string> = { agent_name: agent.name };
        for (const v of agent.variables) {
          if (v.source === 'call_init') vars[v.name] = params.get(v.name) ?? v.default ?? '';
          else if (v.source === 'static') vars[v.name] = v.default ?? '';
        }
        if (agent.systemPromptTemplate.trim()) systemPrompt = renderTemplate(agent.systemPromptTemplate, vars);
        voice = params.get('voice') ?? agent.voice;
        toolMap = new Map(agent.tools.map((t) => [t.name, t.webhookUrl]));
      }
    }

    // vectorless KG recall at call start (top-K facts about this caller)
    if (this.tenantId && this.callerRef) {
      const facts = await this.recallMemory({ caller: this.callerRef });
      if (facts.length) {
        systemPrompt += `\n\nKnown facts about the caller:\n${facts.map((f) => `- ${f}`).join('\n')}`;
      }
    }

    if (this.tenantId) await this.createCallRecord();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const stt = new ClientFedStt();
    const port = new RecordingClientPort(server, {
      onTurn: (t) => {
        this.turns.push(t);
        if (t.role === 'assistant') this.speakingChars += t.text.length;
      },
      onLatency: (ms) => this.latencies.push(ms),
      onEnded: (reason) => this.state.waitUntil(this.finalize(reason)),
    });

    const engine = new ConversationEngine({
      stt,
      llm: new WorkersAiLlm(this.env.AI),
      tts: new AuraTts(this.env.AI, voice),
      client: port,
      clock: { now: () => Date.now() },
      systemPrompt,
      chunkerOptions: { minWords: 6, maxWords: 30 },
      onToolCall: (call) => this.executeTool(call, toolMap),
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
      if (msg.type === 'userText' && typeof msg.text === 'string') stt.feedEndOfTurn(msg.text);
      else if (msg.type === 'partial' && typeof msg.text === 'string') stt.feedPartial(msg.text);
      else if (msg.type === 'interrupt') engine.interrupt();
      else if (msg.type === 'hangup') engine.end('client_hangup');
    });

    server.addEventListener('close', () => engine.end('socket_closed'));

    return new Response(null, { status: 101, webSocket: client });
  }

  private secret(): string {
    return (this.env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
  }

  private async createCallRecord(): Promise<void> {
    try {
      await this.env.DB.prepare(
        'INSERT INTO calls (id, tenant_id, agent_id, caller_ref, started_at, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
        .bind(this.callId, this.tenantId, this.agentId, this.callerRef, this.startedAt, 'active')
        .run();
    } catch {
      // best-effort; logging must never break a call
    }
  }

  private async finalize(reason: string): Promise<void> {
    if (this.finalized || !this.tenantId) return;
    this.finalized = true;
    const endedAt = Date.now();
    const durationS = Math.round((endedAt - this.startedAt) / 1000);
    const summary = await this.summarize();
    const cost = estimateCallCost({ durationS, ttsChars: this.speakingChars });
    await this.extractMemory();

    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          'UPDATE calls SET ended_at=?, duration_s=?, status=?, end_reason=?, cost_usd=?, summary=?, latency_p50_ms=? WHERE id=?',
        ).bind(endedAt, durationS, 'ended', reason, cost, summary, median(this.latencies), this.callId),
        this.env.DB.prepare(
          'INSERT OR REPLACE INTO transcripts (call_id, tenant_id, turns) VALUES (?, ?, ?)',
        ).bind(this.callId, this.tenantId, JSON.stringify(this.turns)),
      ]);
    } catch {
      // best-effort
    }
  }

  private async summarize(): Promise<string> {
    const convo = this.turns.map((t) => `${t.role}: ${t.text}`).join('\n');
    if (!convo.trim()) return '';
    try {
      const r = (await this.env.AI.run(SUMMARY_MODEL as never, {
        messages: [
          { role: 'system', content: 'Summarize this phone call transcript in 1-2 sentences. Be factual.' },
          { role: 'user', content: convo.slice(0, 6000) },
        ],
        max_tokens: 120,
      } as never)) as { response?: string };
      return (r.response ?? '').trim();
    } catch {
      return '';
    }
  }

  private async loadAgent(agentId: string): Promise<AgentConfig | null> {
    const row = await this.env.DB.prepare(
      'SELECT id, name, voice, system_prompt_template, variables_schema, tools FROM agents WHERE id = ? AND tenant_id = ?',
    )
      .bind(agentId, this.tenantId)
      .first<{
        id: string;
        name: string;
        voice: string;
        system_prompt_template: string;
        variables_schema: string;
        tools: string;
      }>();
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      voice: row.voice,
      systemPromptTemplate: row.system_prompt_template,
      variables: JSON.parse(row.variables_schema),
      tools: JSON.parse(row.tools),
    };
  }

  private memoryStub() {
    return this.env.MEMORY.get(this.env.MEMORY.idFromName(this.tenantId!));
  }

  private async recallMemory(opts: { caller?: string; q?: string }): Promise<string[]> {
    if (!this.tenantId) return [];
    try {
      const qs = opts.q
        ? `q=${encodeURIComponent(opts.q)}`
        : `caller=${encodeURIComponent(opts.caller ?? '')}`;
      const r = await this.memoryStub().fetch(`https://memory/recall?${qs}`);
      const j = (await r.json()) as { facts?: string[] };
      return j.facts ?? [];
    } catch {
      return [];
    }
  }

  private async extractMemory(): Promise<void> {
    if (!this.tenantId) return;
    const convo = this.turns.map((t) => `${t.role}: ${t.text}`).join('\n');
    if (!convo.trim()) return;
    try {
      const r = (await this.env.AI.run(SUMMARY_MODEL as never, {
        messages: [
          {
            role: 'system',
            content:
              'Extract durable facts about the caller from this transcript as a JSON array of objects {"subject","predicate","object"}. Only stable facts (identity, preferences, commitments). Respond with ONLY the JSON array, or [] if none.',
          },
          { role: 'user', content: convo.slice(0, 6000) },
        ],
        max_tokens: 300,
      } as never)) as { response?: string };
      const match = (r.response ?? '').match(/\[[\s\S]*\]/);
      if (!match) return;
      const facts = JSON.parse(match[0]) as { subject?: string; predicate?: string; object?: string }[];
      if (!Array.isArray(facts) || facts.length === 0) return;
      await this.memoryStub().fetch('https://memory/upsert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caller: this.callerRef, facts }),
      });
    } catch {
      // best-effort
    }
  }

  private async executeTool(call: ToolCall, toolMap: Map<string, string | undefined>): Promise<ToolResult> {
    if (call.name === 'end_call') return dispatchTool(call);
    if (call.name === 'recall_memory') {
      const q = typeof call.arguments.query === 'string' ? call.arguments.query : '';
      const facts = await this.recallMemory({ q });
      return { type: 'continue', content: facts.length ? facts.join('; ') : 'no relevant memory found' };
    }
    if (toolMap.has(call.name)) {
      const webhookUrl = toolMap.get(call.name);
      if (webhookUrl) {
        try {
          const r = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(call.arguments),
            signal: AbortSignal.timeout(8000),
          });
          return { type: 'continue', content: (await r.text()).slice(0, 2000) };
        } catch {
          return { type: 'continue', content: `Error calling tool "${call.name}".` };
        }
      }
    }
    return dispatchTool(call);
  }
}
