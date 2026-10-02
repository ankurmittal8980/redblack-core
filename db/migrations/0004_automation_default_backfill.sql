-- Default automation names are workspace-scoped so startup backfill is race-safe.
CREATE UNIQUE INDEX automations_workspace_name_key ON automations(workspace_id, name);

