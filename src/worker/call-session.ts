import { ConversationEngine } from '../engine/conversation-engine';
import type { ClientPort } from '../engine/ports';
import { dispatchTool, type ToolCall, type ToolResult } from '../engine/tools';
import type { ClientEvent } from '../engine/types';
import { AuraTts, ClientFedStt, WorkersAiLlm } from './adapters';
import { verifyJwt } from './auth';

const DEFAULT_SYSTEM_PROMPT =
  'You are a friendly, concise voice agent on a phone call. Keep replies short and natural, one or two sentences. Do not use markdown or emoji.';

interface AgentConfig {
  id: string;
  name: string;
  voice: string;
  systemPromptTemplate: string;
  variables: { name: string; source: string; default?: string }[];
  tools: { name: string; webhookUrl?: string }[];
}

class WsClientPort implements ClientPort {
  constructor(private ws: WebSocket) {}
  emit(event: ClientEvent): void {
    if (event.type === 'audio') {
      this.ws.send(event.chunk.data);
      return;
    }
    this.ws.send(JSON.stringify(event));
  }
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => vars[name] ?? '');
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

    const url = new URL(request.url);
    const params = url.searchParams;
    const agentId = params.get('agentId');
    const token = params.get('token');

    let systemPrompt = params.get('prompt') ?? DEFAULT_SYSTEM_PROMPT;
    let voice = params.get('voice') ?? 'asteria';
    let toolMap = new Map<string, string | undefined>();

    if (agentId && token) {
      const agent = await this.loadAgent(agentId, token);
      if (agent) {
        const vars: Record<string, string> = { agent_name: agent.name };
        for (const v of agent.variables) {
          if (v.source === 'call_init') vars[v.name] = params.get(v.name) ?? v.default ?? '';
          else if (v.source === 'static') vars[v.name] = v.default ?? '';
        }
        if (agent.systemPromptTemplate.trim()) {
          systemPrompt = renderTemplate(agent.systemPromptTemplate, vars);
        }
        voice = params.get('voice') ?? agent.voice;
        toolMap = new Map(agent.tools.map((t) => [t.name, t.webhookUrl]));
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const stt = new ClientFedStt();
    const engine = new ConversationEngine({
      stt,
      llm: new WorkersAiLlm(this.env.AI),
      tts: new AuraTts(this.env.AI, voice),
      client: new WsClientPort(server),
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

  private async loadAgent(agentId: string, token: string): Promise<AgentConfig | null> {
    const secret = (this.env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
    const claims = await verifyJwt(token, secret);
    if (!claims) return null;
    const row = await this.env.DB.prepare(
      'SELECT id, name, voice, system_prompt_template, variables_schema, tools FROM agents WHERE id = ? AND tenant_id = ?',
    )
      .bind(agentId, claims.tid)
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

  private async executeTool(call: ToolCall, toolMap: Map<string, string | undefined>): Promise<ToolResult> {
    if (call.name === 'end_call') return dispatchTool(call);
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
          const text = await r.text();
          return { type: 'continue', content: text.slice(0, 2000) };
        } catch {
          return { type: 'continue', content: `Error calling tool "${call.name}".` };
        }
      }
    }
    return dispatchTool(call);
  }
}
