-- Carrier-side agent identifier per agent. For Tata Smartflo this is what
-- their /v1/click_to_call API expects as `agent_number` — a Smartflo agent ID,
-- NOT a phone number. The DID we already store separately as caller_id.

ALTER TABLE agents ADD COLUMN carrier_agent_id TEXT;
