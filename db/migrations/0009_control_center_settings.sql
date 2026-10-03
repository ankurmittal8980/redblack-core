CREATE TABLE IF NOT EXISTS workspace_control_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  model_routes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  communication_defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
