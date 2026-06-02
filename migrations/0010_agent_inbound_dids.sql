-- Per-agent inbound DID assignment. When a carrier (Tata, Twilio, …) opens a
-- stream, we match start.to against agents.inbound_dids and route the call
-- to that agent. Defaults to '[]' so existing agents keep working with the
-- "most-recently-updated agent for tenant" fallback.

ALTER TABLE agents ADD COLUMN inbound_dids TEXT NOT NULL DEFAULT '[]';
