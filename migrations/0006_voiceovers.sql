-- Voiceover jobs: async-style TTS render-and-store, tenant-scoped.
-- Each row owns one R2 audio object at `voiceovers/<tenant_id>/<id>.<ext>`.

CREATE TABLE voiceover_jobs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  title           TEXT,
  script_text     TEXT NOT NULL,
  voice_id        TEXT NOT NULL,
  model           TEXT NOT NULL,
  language        TEXT NOT NULL,
  format          TEXT NOT NULL CHECK (format IN ('mp3', 'wav')),
  chars           INTEGER NOT NULL,
  duration_ms     INTEGER,
  cost_usd_micro  INTEGER,
  r2_key          TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('rendering', 'ready', 'failed')),
  error           TEXT,
  created_at      INTEGER NOT NULL,
  rendered_at     INTEGER
);

CREATE INDEX idx_vo_tenant_created ON voiceover_jobs (tenant_id, created_at DESC);
