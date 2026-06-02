-- PSTN providers vary in their click-to-call REST URL; let tenants point us
-- at the right one (e.g. Tata's https://api.tatateleservices.com/v1/c2c).
-- pstn_extra is a free-form JSON blob for provider-specific fields we don't
-- want to bake into the schema (Tata's "async" flag, etc.).

ALTER TABLE voice_integrations ADD COLUMN pstn_endpoint_url TEXT;
ALTER TABLE voice_integrations ADD COLUMN pstn_extra TEXT NOT NULL DEFAULT '{}';
