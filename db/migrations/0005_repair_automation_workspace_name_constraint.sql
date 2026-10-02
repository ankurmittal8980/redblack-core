-- Repair databases that may have recorded the restored 0004 migration before its
-- workspace/name uniqueness index was present. This migration is intentionally
-- idempotent and gives the startup default-automation upsert its required arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS automations_workspace_name_key
  ON automations(workspace_id, name);
