-- Per-agent BCP-47 language code (used when the chosen voice is multilingual).
ALTER TABLE agents ADD COLUMN language TEXT NOT NULL DEFAULT 'en-US';
