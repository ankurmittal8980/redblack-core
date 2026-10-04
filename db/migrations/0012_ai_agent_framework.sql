CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  initiating_actor jsonb NOT NULL,
  agent_definition_id text NOT NULL,
  goal text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','running','paused','approval_required','escalated','completed','failed','cancelled','max_steps','timed_out')),
  step_count integer NOT NULL DEFAULT 0 CHECK (step_count >= 0),
  correlation_id text NOT NULL,
  idempotency_key text NOT NULL,
  deadline_at timestamptz NOT NULL,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ai_agent_runs_workspace_status_idx ON ai_agent_runs(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_runs_correlation_idx ON ai_agent_runs(workspace_id, correlation_id);
