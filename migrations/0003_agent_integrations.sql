-- Per-agent integrations: inbound lookup (call start) and outbound webhook (call end).
ALTER TABLE agents ADD COLUMN inbound_lookup TEXT;
ALTER TABLE agents ADD COLUMN end_webhook TEXT;
