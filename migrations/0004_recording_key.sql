-- R2 object key for the call recording (mixed mic + agent audio, webm/opus).
ALTER TABLE calls ADD COLUMN recording_key TEXT;
