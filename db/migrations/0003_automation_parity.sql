ALTER TABLE automation_runs ADD COLUMN resume_at timestamptz;
CREATE INDEX automation_runs_resume_idx ON automation_runs(status, resume_at) WHERE status = 'queued' AND resume_at IS NOT NULL;

