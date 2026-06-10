-- Async ingestion: jobs can carry a webhook to call when notes are ready
-- (or the job fails). Delivery state is tracked for observability and to
-- stop retrying after the attempt cap.
ALTER TABLE notetaker_jobs ADD COLUMN webhook_url TEXT;
ALTER TABLE notetaker_jobs ADD COLUMN webhook_status TEXT;
ALTER TABLE notetaker_jobs ADD COLUMN webhook_attempts INTEGER NOT NULL DEFAULT 0;
