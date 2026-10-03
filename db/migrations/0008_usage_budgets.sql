CREATE TABLE IF NOT EXISTS usage_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  period_limit numeric(20,8) NOT NULL CHECK (period_limit >= 0),
  currency char(3) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);
CREATE TABLE IF NOT EXISTS usage_budget_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES usage_budgets(id) ON DELETE CASCADE,
  threshold numeric(8,4) NOT NULL CHECK (threshold > 0 AND threshold <= 1),
  triggered_at timestamptz,
  UNIQUE(budget_id, threshold)
);
CREATE INDEX IF NOT EXISTS usage_events_workspace_time_idx ON usage_events(workspace_id, occurred_at);
