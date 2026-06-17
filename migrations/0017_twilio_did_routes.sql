-- Inbound DID routing index + carrier call correlation, for the Twilio
-- integration (and any carrier whose inbound webhook knows only the dialed
-- number). did_routes is a denormalized index of per-agent inbound_dids and
-- per-tenant pstn_phone_numbers, kept in sync on write (see did-routes.ts).
CREATE TABLE did_routes (
  did_norm   TEXT PRIMARY KEY,                       -- digits-only normalized DID
  did        TEXT NOT NULL,                          -- original E.164 as configured
  tenant_id  TEXT NOT NULL REFERENCES tenants(id),
  agent_id   TEXT REFERENCES agents(id),             -- null => tenant-level (no specific agent)
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_did_routes_tenant ON did_routes (tenant_id);

-- Backfill from existing config. Normalization here strips the common E.164
-- separators (+, -, space, parens) to match did-routes.ts's \D removal.
-- Agent-level rows are inserted first and win over tenant-level on conflict.
INSERT OR IGNORE INTO did_routes (did_norm, did, tenant_id, agent_id, updated_at)
SELECT replace(replace(replace(replace(replace(je.value, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''),
       je.value, a.tenant_id, a.id, 0
FROM agents a, json_each(a.inbound_dids) je
WHERE je.value IS NOT NULL AND je.value != '';

INSERT OR IGNORE INTO did_routes (did_norm, did, tenant_id, agent_id, updated_at)
SELECT replace(replace(replace(replace(replace(je.value, '+', ''), '-', ''), ' ', ''), '(', ''), ')', ''),
       je.value, vi.tenant_id, NULL, 0
FROM voice_integrations vi, json_each(vi.pstn_phone_numbers) je
WHERE je.value IS NOT NULL AND je.value != '';

-- Correlate our call row with the carrier's call id (Twilio CallSid, etc.).
ALTER TABLE calls ADD COLUMN carrier_call_id TEXT;
