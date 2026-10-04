CREATE TABLE ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_user_id uuid,
  capability text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  correlation_id uuid NOT NULL,
  request_hash char(64) NOT NULL,
  provider text,
  model text,
  response jsonb,
  usage jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, correlation_id),
  FOREIGN KEY (workspace_id, actor_user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (actor_user_id)
);
CREATE INDEX ai_requests_workspace_created_idx ON ai_requests(workspace_id, created_at DESC);
CREATE INDEX ai_requests_workspace_status_idx ON ai_requests(workspace_id, status);
