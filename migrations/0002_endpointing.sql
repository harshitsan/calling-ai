-- Per-agent end-of-turn silence threshold (ms) before the agent responds.
ALTER TABLE agents ADD COLUMN endpointing_ms INTEGER NOT NULL DEFAULT 900;
