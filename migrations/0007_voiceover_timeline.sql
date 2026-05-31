-- Timeline model for voiceovers: each job is now a project with one or more
-- snippets placed at offsets along a total timeline. Legacy single-script jobs
-- (rows pre-dating this migration) keep working — they simply have no snippet
-- rows and total_duration_ms left NULL.

ALTER TABLE voiceover_jobs ADD COLUMN total_duration_ms INTEGER;

CREATE TABLE voiceover_snippets (
  id              TEXT PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES voiceover_jobs(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  start_ms        INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  script_text     TEXT NOT NULL,
  voice_id        TEXT NOT NULL,
  model           TEXT NOT NULL,
  language        TEXT NOT NULL,
  speed           TEXT NOT NULL DEFAULT 'normal',
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_snippets_job ON voiceover_snippets (job_id, start_ms);
