// DID → tenant/agent routing. Inbound calls arrive knowing only the dialed
// number (To); we must find which tenant owns it (and optionally which agent)
// before we have any auth context. The did_routes table is a denormalized index
// of the per-agent `inbound_dids` and per-tenant `pstn_phone_numbers` arrays,
// kept in sync on write, so inbound resolution is a single indexed lookup.

const normalize = (d: string): string => d.replace(/\D/g, '');

export interface DidRoute {
  tenantId: string;
  agentId: string | null;
}

export async function resolveDidRoute(env: Env, did: string): Promise<DidRoute | null> {
  const norm = normalize(did);
  if (!norm) return null;
  const row = await env.DB.prepare('SELECT tenant_id, agent_id FROM did_routes WHERE did_norm = ?')
    .bind(norm)
    .first<{ tenant_id: string; agent_id: string | null }>();
  return row ? { tenantId: row.tenant_id, agentId: row.agent_id } : null;
}

/**
 * Rebuild a tenant's did_routes from its current agents + PSTN config. Called
 * after any change to PSTN phone numbers or an agent's inbound DIDs. Agent-level
 * DIDs take precedence over tenant-level PSTN numbers for the same number.
 */
export async function syncTenantDidRoutes(env: Env, tenantId: string): Promise<void> {
  const ts = Date.now();
  const map = new Map<string, { did: string; agentId: string | null }>();

  const vi = await env.DB.prepare('SELECT pstn_phone_numbers FROM voice_integrations WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ pstn_phone_numbers: string | null }>();
  if (vi?.pstn_phone_numbers) {
    try {
      for (const d of JSON.parse(vi.pstn_phone_numbers) as string[]) {
        const n = normalize(d);
        if (n) map.set(n, { did: d, agentId: null });
      }
    } catch { /* ignore malformed */ }
  }

  const agents = await env.DB.prepare('SELECT id, inbound_dids FROM agents WHERE tenant_id = ?')
    .bind(tenantId)
    .all<{ id: string; inbound_dids: string }>();
  for (const a of agents.results) {
    try {
      for (const d of JSON.parse(a.inbound_dids) as string[]) {
        const n = normalize(d);
        if (n) map.set(n, { did: d, agentId: a.id });
      }
    } catch { /* ignore malformed */ }
  }

  const stmts = [env.DB.prepare('DELETE FROM did_routes WHERE tenant_id = ?').bind(tenantId)];
  for (const [norm, v] of map) {
    stmts.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO did_routes (did_norm, did, tenant_id, agent_id, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).bind(norm, v.did, tenantId, v.agentId, ts),
    );
  }
  await env.DB.batch(stmts);
}
