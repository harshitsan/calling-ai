-- Per-tenant voice integration config. One row per tenant. Created on first
-- read if missing (server-side upsert), so tenants don't need an explicit
-- enablement step. Secrets stored plaintext for now (tenant-scoped, never
-- returned over the API in raw form — they're redacted to last-4 on read).

CREATE TABLE voice_integrations (
  tenant_id              TEXT PRIMARY KEY REFERENCES tenants(id),

  -- Voice Streaming (BYOC) — wired end-to-end. Real, usable API key for
  -- customers to authenticate their PBX/contact-center WebSocket.
  stream_enabled         INTEGER NOT NULL DEFAULT 1,
  stream_api_key_hash    TEXT,
  stream_api_key_prefix  TEXT,                  -- first 12 chars for display
  stream_key_created_at  INTEGER,

  -- PSTN / VoIP — credentials stored, wiring (carrier webhooks → CallSession)
  -- is deployment-pending. UI labels this clearly.
  pstn_enabled           INTEGER NOT NULL DEFAULT 0,
  pstn_provider          TEXT,                  -- 'twilio'|'vonage'|'plivo'|'telnyx'|'acefone'|'other'
  pstn_account_id        TEXT,
  pstn_auth_token        TEXT,                  -- plaintext, redacted on read
  pstn_phone_numbers     TEXT NOT NULL DEFAULT '[]',  -- JSON array of E.164

  -- SIP Trunking — config stored, gateway component (FreeSWITCH/JamBonz) pending.
  sip_enabled            INTEGER NOT NULL DEFAULT 0,
  sip_uri                TEXT,
  sip_auth_method        TEXT,                  -- 'ip_allowlist'|'digest'
  sip_allowed_ips        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  sip_digest_user        TEXT,
  sip_digest_pass        TEXT,                  -- plaintext, redacted on read

  updated_at             INTEGER NOT NULL
);
