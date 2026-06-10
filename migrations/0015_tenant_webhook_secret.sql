-- Per-tenant HMAC secret for signing notetaker webhook payloads.
-- Generated lazily on first API key creation; shown on the API Keys page.
ALTER TABLE tenants ADD COLUMN webhook_secret TEXT;
