-- calling-ai core schema (Phase 2 foundation)

CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free',
  concurrency_cap INTEGER NOT NULL DEFAULT 100,
  created_at      INTEGER NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE api_keys (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  prefix     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);

CREATE TABLE agents (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL REFERENCES tenants(id),
  name                   TEXT NOT NULL,
  avatar                 TEXT,
  voice                  TEXT NOT NULL DEFAULT 'asteria',
  role                   TEXT,
  system_prompt_template TEXT NOT NULL DEFAULT '',
  variables_schema       TEXT NOT NULL DEFAULT '[]',
  tools                  TEXT NOT NULL DEFAULT '[]',
  llm_tier_policy        TEXT NOT NULL DEFAULT '{}',
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_agents_tenant ON agents(tenant_id);

CREATE TABLE calls (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  agent_id    TEXT REFERENCES agents(id),
  caller_ref  TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  duration_s  INTEGER,
  status      TEXT NOT NULL DEFAULT 'active',
  end_reason  TEXT,
  cost_usd    REAL,
  summary     TEXT,
  tool_calls  TEXT NOT NULL DEFAULT '[]',
  latency_p50_ms INTEGER,
  latency_p95_ms INTEGER
);
CREATE INDEX idx_calls_tenant ON calls(tenant_id, started_at);
CREATE INDEX idx_calls_agent ON calls(agent_id);

CREATE TABLE transcripts (
  call_id   TEXT PRIMARY KEY REFERENCES calls(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  turns     TEXT NOT NULL DEFAULT '[]'
);
