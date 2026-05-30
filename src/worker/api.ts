import { hashApiKey, hashPassword, signJwt, verifyJwt, verifyPassword } from './auth';
import { AgentSchema, LoginSchema, RegisterSchema } from './schemas';
import { err, json, now, uuid } from './util';

const JWT_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function getSecret(env: Env): string {
  return (env as unknown as { JWT_SECRET?: string }).JWT_SECRET ?? 'dev-insecure-secret-change-me';
}

interface Auth {
  tenantId: string;
  userId?: string;
}

async function authenticate(request: Request, env: Env): Promise<Auth | null> {
  const authz = request.headers.get('authorization');
  if (authz?.startsWith('Bearer ')) {
    const claims = await verifyJwt(authz.slice(7), getSecret(env));
    if (claims) return { tenantId: claims.tid, userId: claims.sub };
  }
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    const hash = await hashApiKey(apiKey);
    const row = await env.DB.prepare('SELECT tenant_id FROM api_keys WHERE key_hash = ?')
      .bind(hash)
      .first<{ tenant_id: string }>();
    if (row) return { tenantId: row.tenant_id };
  }
  return null;
}

interface AgentRow {
  id: string;
  tenant_id: string;
  name: string;
  avatar: string | null;
  voice: string;
  role: string | null;
  system_prompt_template: string;
  variables_schema: string;
  tools: string;
  llm_tier_policy: string;
  endpointing_ms: number;
  inbound_lookup: string | null;
  end_webhook: string | null;
  created_at: number;
  updated_at: number;
}

function agentToJson(r: AgentRow) {
  return {
    id: r.id,
    name: r.name,
    avatar: r.avatar ?? undefined,
    voice: r.voice,
    role: r.role ?? undefined,
    systemPromptTemplate: r.system_prompt_template,
    variables: JSON.parse(r.variables_schema),
    tools: JSON.parse(r.tools),
    llmTierPolicy: JSON.parse(r.llm_tier_policy),
    endpointingMs: r.endpointing_ms,
    inboundLookup: r.inbound_lookup ? JSON.parse(r.inbound_lookup) : undefined,
    endWebhook: r.end_webhook ? JSON.parse(r.end_webhook) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ---- auth: register ----
  if (path === '/api/auth/register' && method === 'POST') {
    const parsed = RegisterSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return err(400, parsed.error.issues[0]?.message ?? 'invalid body');
    const { email, password, tenantName } = parsed.data;

    const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) return err(409, 'email already registered');

    const tenantId = uuid();
    const userId = uuid();
    const ts = now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tenants (id, name, plan, concurrency_cap, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(tenantId, tenantName, 'free', 100, ts),
      env.DB.prepare('INSERT INTO users (id, tenant_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(userId, tenantId, email, await hashPassword(password), 'owner', ts),
    ]);

    const token = await signJwt(
      { sub: userId, tid: tenantId, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
      getSecret(env),
    );
    return json({ token, tenant: { id: tenantId, name: tenantName }, user: { id: userId, email } });
  }

  // ---- auth: login ----
  if (path === '/api/auth/login' && method === 'POST') {
    const parsed = LoginSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return err(400, 'invalid body');
    const { email, password } = parsed.data;
    const user = await env.DB.prepare(
      'SELECT id, tenant_id, password_hash FROM users WHERE email = ?',
    )
      .bind(email)
      .first<{ id: string; tenant_id: string; password_hash: string }>();
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return err(401, 'invalid credentials');
    }
    const token = await signJwt(
      { sub: user.id, tid: user.tenant_id, exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS },
      getSecret(env),
    );
    return json({ token });
  }

  // ---- everything below requires auth ----
  const auth = await authenticate(request, env);
  if (!auth) return err(401, 'unauthorized');

  if (path === '/api/me' && method === 'GET') {
    const tenant = await env.DB.prepare('SELECT id, name, plan FROM tenants WHERE id = ?')
      .bind(auth.tenantId)
      .first();
    return json({ tenant, userId: auth.userId });
  }

  // ---- agents ----
  if (path === '/api/agents' && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM agents WHERE tenant_id = ? ORDER BY updated_at DESC',
    )
      .bind(auth.tenantId)
      .all<AgentRow>();
    return json({ agents: results.map(agentToJson) });
  }

  if (path === '/api/agents' && method === 'POST') {
    const parsed = AgentSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return err(400, parsed.error.issues[0]?.message ?? 'invalid agent');
    const a = parsed.data;
    const id = uuid();
    const ts = now();
    await env.DB.prepare(
      `INSERT INTO agents (id, tenant_id, name, avatar, voice, role, system_prompt_template, variables_schema, tools, llm_tier_policy, endpointing_ms, inbound_lookup, end_webhook, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id, auth.tenantId, a.name, a.avatar ?? null, a.voice, a.role ?? null,
        a.systemPromptTemplate, JSON.stringify(a.variables), JSON.stringify(a.tools),
        JSON.stringify(a.llmTierPolicy), a.endpointingMs,
        a.inboundLookup ? JSON.stringify(a.inboundLookup) : null,
        a.endWebhook ? JSON.stringify(a.endWebhook) : null,
        ts, ts,
      )
      .run();
    const row = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first<AgentRow>();
    return json({ agent: agentToJson(row!) }, { status: 201 });
  }

  const agentMatch = path.match(/^\/api\/agents\/([a-f0-9-]+)$/);
  if (agentMatch) {
    const agentId = agentMatch[1]!;
    const row = await env.DB.prepare('SELECT * FROM agents WHERE id = ? AND tenant_id = ?')
      .bind(agentId, auth.tenantId)
      .first<AgentRow>();
    if (!row) return err(404, 'agent not found');

    if (method === 'GET') return json({ agent: agentToJson(row) });

    if (method === 'PUT') {
      const parsed = AgentSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return err(400, parsed.error.issues[0]?.message ?? 'invalid agent');
      const a = parsed.data;
      await env.DB.prepare(
        `UPDATE agents SET name=?, avatar=?, voice=?, role=?, system_prompt_template=?, variables_schema=?, tools=?, llm_tier_policy=?, endpointing_ms=?, inbound_lookup=?, end_webhook=?, updated_at=?
         WHERE id=? AND tenant_id=?`,
      )
        .bind(
          a.name, a.avatar ?? null, a.voice, a.role ?? null, a.systemPromptTemplate,
          JSON.stringify(a.variables), JSON.stringify(a.tools), JSON.stringify(a.llmTierPolicy),
          a.endpointingMs,
          a.inboundLookup ? JSON.stringify(a.inboundLookup) : null,
          a.endWebhook ? JSON.stringify(a.endWebhook) : null,
          now(), agentId, auth.tenantId,
        )
        .run();
      const updated = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(agentId).first<AgentRow>();
      return json({ agent: agentToJson(updated!) });
    }

    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM agents WHERE id = ? AND tenant_id = ?')
        .bind(agentId, auth.tenantId)
        .run();
      return json({ ok: true });
    }
  }

  // ---- usage / cost metering ----
  if (path === '/api/usage' && method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost_usd,
              COALESCE(SUM(duration_s), 0) AS duration_s,
              COALESCE(AVG(latency_p50_ms), 0) AS avg_latency_ms
       FROM calls WHERE tenant_id = ? AND status = 'ended'`,
    )
      .bind(auth.tenantId)
      .first();
    return json({ usage: row });
  }

  // ---- call logs ----
  if (path === '/api/calls' && method === 'GET') {
    const q = url.searchParams.get('q')?.trim() ?? '';
    const filterAgentId = url.searchParams.get('agentId') ?? '';
    const status = url.searchParams.get('status') ?? 'all';
    const endReason = url.searchParams.get('endReason') ?? 'all';
    const since = Number(url.searchParams.get('since') ?? '0');

    const where: string[] = ['tenant_id = ?'];
    const args: (string | number)[] = [auth.tenantId];
    if (q) {
      where.push('(caller_ref LIKE ? OR summary LIKE ?)');
      const like = `%${q}%`;
      args.push(like, like);
    }
    if (filterAgentId) {
      where.push('agent_id = ?');
      args.push(filterAgentId);
    }
    if (status === 'ended' || status === 'active') {
      where.push('status = ?');
      args.push(status);
    }
    if (endReason === 'manual') where.push("end_reason = 'client_hangup'");
    else if (endReason === 'tool') where.push("end_reason LIKE 'tool:%'");
    else if (endReason === 'disconnected') where.push("end_reason = 'socket_closed'");
    if (since > 0) {
      where.push('started_at >= ?');
      args.push(since);
    }

    const sql = `SELECT id, agent_id, caller_ref, started_at, ended_at, duration_s, status, end_reason, cost_usd, summary, latency_p50_ms
                 FROM calls WHERE ${where.join(' AND ')}
                 ORDER BY started_at DESC LIMIT 200`;
    const { results } = await env.DB.prepare(sql).bind(...args).all();
    return json({ calls: results });
  }

  const recMatch = path.match(/^\/api\/calls\/([a-zA-Z0-9-]+)\/recording$/);
  if (recMatch) {
    const callId = recMatch[1]!;
    const call = await env.DB.prepare(
      'SELECT recording_key FROM calls WHERE id = ? AND tenant_id = ?',
    )
      .bind(callId, auth.tenantId)
      .first<{ recording_key: string | null }>();
    if (!call) return err(404, 'call not found');

    if (method === 'POST' || method === 'PUT') {
      if (!request.body) return err(400, 'empty body');
      const key = `t/${auth.tenantId}/${callId}.webm`;
      const ct = request.headers.get('content-type') ?? 'audio/webm';
      await env.RECORDINGS.put(key, request.body, { httpMetadata: { contentType: ct } });
      await env.DB.prepare('UPDATE calls SET recording_key = ? WHERE id = ? AND tenant_id = ?')
        .bind(key, callId, auth.tenantId)
        .run();
      return json({ ok: true, key });
    }

    if (method === 'GET') {
      if (!call.recording_key) return err(404, 'no recording');
      const obj = await env.RECORDINGS.get(call.recording_key);
      if (!obj) return err(404, 'recording missing');
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType ?? 'audio/webm',
          'cache-control': 'private, max-age=3600',
        },
      });
    }
  }

  const callMatch = path.match(/^\/api\/calls\/([a-zA-Z0-9-]+)$/);
  if (callMatch && method === 'GET') {
    const callId = callMatch[1]!;
    const call = await env.DB.prepare('SELECT * FROM calls WHERE id = ? AND tenant_id = ?')
      .bind(callId, auth.tenantId)
      .first();
    if (!call) return err(404, 'call not found');
    const transcript = await env.DB.prepare('SELECT turns FROM transcripts WHERE call_id = ? AND tenant_id = ?')
      .bind(callId, auth.tenantId)
      .first<{ turns: string }>();
    return json({ call, turns: transcript ? JSON.parse(transcript.turns) : [] });
  }

  return err(404, 'not found');
}

export { authenticate };
