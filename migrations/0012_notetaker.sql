-- Notetaker jobs — async transcription + structured-notes extraction from
-- uploaded audio files. Each job: audio in R2, transcript + notes in D1.

CREATE TABLE notetaker_jobs (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  user_id             TEXT NOT NULL REFERENCES users(id),
  title               TEXT,
  audio_r2_key        TEXT NOT NULL,
  audio_size_bytes    INTEGER NOT NULL,
  audio_duration_sec  INTEGER,
  mime_type           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','transcribing','summarizing','ready','failed')),
  error               TEXT,
  transcript_text     TEXT,
  transcript_words    TEXT,                    -- JSON array of {word,start,end}
  notes_json          TEXT,                    -- JSON: {summary, actionItems, keyTopics, sentiment, decisions, speakers}
  chars               INTEGER,
  cost_usd_micro      INTEGER,
  created_at          INTEGER NOT NULL,
  transcribed_at      INTEGER,
  completed_at        INTEGER
);

CREATE INDEX idx_notetaker_tenant_created ON notetaker_jobs (tenant_id, created_at DESC);
