-- Speaker diarization by real name: the recorder bot captures the meeting
-- roster and a who-spoke-when timeline (timestamps relative to recording
-- start) and uploads them alongside the audio. The notetaker aligns each
-- transcriber speaker index to a real name by maximal temporal overlap.
ALTER TABLE notetaker_jobs ADD COLUMN participants_json TEXT;        -- JSON: string[] of names
ALTER TABLE notetaker_jobs ADD COLUMN speaker_timeline_json TEXT;    -- JSON: [{startMs,endMs,name}]
