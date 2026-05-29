// Per-tenant vectorless knowledge graph (one DO per tenant, sharded by caller).
// Retrieval is by entity (caller) + keyword LIKE — no embeddings, no vector index.

interface FactRow {
  subject: string;
  predicate: string;
  object: string;
}

export class MemoryStore {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.state.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS facts (
          id TEXT PRIMARY KEY,
          caller TEXT,
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object TEXT NOT NULL,
          ts INTEGER NOT NULL
        )`,
      );
      this.state.storage.sql.exec('CREATE INDEX IF NOT EXISTS idx_facts_caller ON facts(caller, ts)');
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/upsert' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as {
        caller?: string;
        facts?: { subject?: string; predicate?: string; object?: string }[];
      };
      let n = 0;
      for (const f of body.facts ?? []) {
        if (!f.object && !f.subject) continue;
        this.state.storage.sql.exec(
          'INSERT INTO facts (id, caller, subject, predicate, object, ts) VALUES (?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(),
          body.caller ?? null,
          f.subject ?? '',
          f.predicate ?? 'is',
          f.object ?? '',
          Date.now(),
        );
        n++;
      }
      return Response.json({ ok: true, inserted: n });
    }

    if (url.pathname === '/recall') {
      const caller = url.searchParams.get('caller');
      const q = url.searchParams.get('q');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '8'), 25);
      let rows: FactRow[];
      if (q) {
        const like = `%${q}%`;
        rows = this.state.storage.sql
          .exec<FactRow>(
            'SELECT subject, predicate, object FROM facts WHERE object LIKE ? OR subject LIKE ? ORDER BY ts DESC LIMIT ?',
            like,
            like,
            limit,
          )
          .toArray();
      } else if (caller) {
        rows = this.state.storage.sql
          .exec<FactRow>(
            'SELECT subject, predicate, object FROM facts WHERE caller = ? ORDER BY ts DESC LIMIT ?',
            caller,
            limit,
          )
          .toArray();
      } else {
        rows = this.state.storage.sql
          .exec<FactRow>('SELECT subject, predicate, object FROM facts ORDER BY ts DESC LIMIT ?', limit)
          .toArray();
      }
      const facts = rows.map((r) => `${r.subject} ${r.predicate} ${r.object}`.trim());
      return Response.json({ facts });
    }

    return new Response('not found', { status: 404 });
  }
}
