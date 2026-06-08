-- Allow an API key to carry a service user identity, so machine clients
-- (e.g. the meeting-recorder bot) can upload to endpoints that require a
-- userId. Existing keys keep user_id NULL and behave exactly as before.
ALTER TABLE api_keys ADD COLUMN user_id TEXT;
