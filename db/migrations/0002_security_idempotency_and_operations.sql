-- Production hardening and application foundation for RedBlack Core.
-- This migration preserves the approved CRM entities and adds constraints
-- required for tenant isolation, repeatable imports, and auditable PAYG.

ALTER TABLE users ADD COLUMN password_hash text;
ALTER TABLE leads ADD COLUMN do_not_contact boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN migration_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE leads ADD COLUMN owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE calls ADD COLUMN answered_at timestamptz;
ALTER TABLE calls ADD COLUMN idempotency_key text;
ALTER TABLE calls ADD COLUMN provider_event_at timestamptz;
ALTER TABLE messages ADD COLUMN provider_event_at timestamptz;
ALTER TABLE calls ADD CONSTRAINT calls_duration_nonnegative CHECK (duration_seconds >= 0);
CREATE UNIQUE INDEX calls_workspace_idempotency_key ON calls(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE tasks ADD COLUMN task_type text;
ALTER TABLE tasks ADD COLUMN touch_number integer CHECK (touch_number IS NULL OR touch_number >= 0);
ALTER TABLE tasks ADD COLUMN migration_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE activities ADD COLUMN migration_source text;
ALTER TABLE activities ADD COLUMN migration_source_id text;
ALTER TABLE activities ADD CONSTRAINT activities_migration_source_key
  UNIQUE (workspace_id, migration_source, migration_source_id);
ALTER TABLE meetings ADD COLUMN migration_source text;
ALTER TABLE meetings ADD COLUMN migration_source_id text;
ALTER TABLE meetings ADD COLUMN migration_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meetings ADD CONSTRAINT meetings_migration_source_key
  UNIQUE (workspace_id, migration_source, migration_source_id);
ALTER TABLE meetings ADD CONSTRAINT meetings_end_after_start CHECK (ends_at IS NULL OR ends_at >= starts_at);

ALTER TABLE leads ADD CONSTRAINT leads_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE lead_sources ADD CONSTRAINT lead_sources_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE tags ADD CONSTRAINT tags_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE pipelines ADD CONSTRAINT pipelines_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_pipeline_id_id_key UNIQUE (pipeline_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE activities ADD CONSTRAINT activities_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE calls ADD CONSTRAINT calls_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE meetings ADD CONSTRAINT meetings_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE proposals ADD CONSTRAINT proposals_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE automations ADD CONSTRAINT automations_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE communication_providers ADD CONSTRAINT communication_providers_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE usage_events ADD CONSTRAINT usage_events_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE invoices ADD CONSTRAINT invoices_workspace_id_id_key UNIQUE (workspace_id, id);

-- Derive workspace ownership from the already-linked parent before enforcing it.
ALTER TABLE lead_pipeline_entries ADD COLUMN workspace_id uuid;
UPDATE lead_pipeline_entries e SET workspace_id = l.workspace_id FROM leads l WHERE l.id = e.lead_id;
ALTER TABLE lead_pipeline_entries ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE lead_stage_history ADD COLUMN workspace_id uuid;
UPDATE lead_stage_history h SET workspace_id = l.workspace_id FROM leads l WHERE l.id = h.lead_id;
ALTER TABLE lead_stage_history ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE lead_assignments ADD COLUMN workspace_id uuid;
UPDATE lead_assignments a SET workspace_id = l.workspace_id FROM leads l WHERE l.id = a.lead_id;
ALTER TABLE lead_assignments ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE lead_tags ADD COLUMN workspace_id uuid;
UPDATE lead_tags lt SET workspace_id = l.workspace_id FROM leads l WHERE l.id = lt.lead_id;
ALTER TABLE lead_tags ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE lead_custom_fields ADD COLUMN workspace_id uuid;
UPDATE lead_custom_fields lcf SET workspace_id = l.workspace_id FROM leads l WHERE l.id = lcf.lead_id;
ALTER TABLE lead_custom_fields ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE call_notes ADD COLUMN workspace_id uuid;
UPDATE call_notes n SET workspace_id = c.workspace_id FROM calls c WHERE c.id = n.call_id;
ALTER TABLE call_notes ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE automation_runs ADD COLUMN workspace_id uuid;
UPDATE automation_runs r SET workspace_id = a.workspace_id FROM automations a WHERE a.id = r.automation_id;
ALTER TABLE automation_runs ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE invoice_items ADD COLUMN workspace_id uuid;
UPDATE invoice_items ii SET workspace_id = i.workspace_id FROM invoices i WHERE i.id = ii.invoice_id;
ALTER TABLE invoice_items ALTER COLUMN workspace_id SET NOT NULL;

-- Make scoped relationships impossible to forge across workspaces.
ALTER TABLE leads ADD CONSTRAINT leads_source_same_workspace_fk
  FOREIGN KEY (workspace_id, source_id) REFERENCES lead_sources(workspace_id, id) ON DELETE SET NULL (source_id);
ALTER TABLE leads ADD CONSTRAINT leads_owner_same_workspace_fk
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (owner_user_id);
ALTER TABLE lead_tags ADD CONSTRAINT lead_tags_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_tags ADD CONSTRAINT lead_tags_tag_same_workspace_fk
  FOREIGN KEY (workspace_id, tag_id) REFERENCES tags(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_custom_fields ADD CONSTRAINT lead_custom_fields_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE custom_field_definitions ADD CONSTRAINT custom_fields_workspace_id_id_key UNIQUE (workspace_id, id);
ALTER TABLE lead_custom_fields ADD CONSTRAINT lead_custom_fields_definition_same_workspace_fk
  FOREIGN KEY (workspace_id, field_definition_id) REFERENCES custom_field_definitions(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_pipeline_entries ADD CONSTRAINT lead_pipeline_entries_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_pipeline_entries ADD CONSTRAINT lead_pipeline_entries_pipeline_same_workspace_fk
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_pipeline_entries ADD CONSTRAINT lead_pipeline_entries_stage_in_pipeline_fk
  FOREIGN KEY (pipeline_id, current_stage_id) REFERENCES pipeline_stages(pipeline_id, id);
ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_pipeline_same_workspace_fk
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_from_stage_in_pipeline_fk
  FOREIGN KEY (pipeline_id, from_stage_id) REFERENCES pipeline_stages(pipeline_id, id);
ALTER TABLE lead_stage_history ADD CONSTRAINT lead_stage_history_to_stage_in_pipeline_fk
  FOREIGN KEY (pipeline_id, to_stage_id) REFERENCES pipeline_stages(pipeline_id, id);
ALTER TABLE lead_assignments ADD CONSTRAINT lead_assignments_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE lead_assignments ADD CONSTRAINT lead_assignments_user_same_workspace_fk
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (user_id);
ALTER TABLE tasks ADD CONSTRAINT tasks_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE tasks ADD CONSTRAINT tasks_assignee_same_workspace_fk
  FOREIGN KEY (workspace_id, assigned_to) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (assigned_to);
ALTER TABLE activities ADD CONSTRAINT activities_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE calls ADD CONSTRAINT calls_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE meetings ADD CONSTRAINT meetings_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE meetings ADD CONSTRAINT meetings_owner_same_workspace_fk
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (owner_user_id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE opportunities ADD CONSTRAINT opportunities_pipeline_same_workspace_fk
  FOREIGN KEY (workspace_id, pipeline_id) REFERENCES pipelines(workspace_id, id) ON DELETE SET NULL (pipeline_id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_owner_same_workspace_fk
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (owner_user_id);
ALTER TABLE proposals ADD CONSTRAINT proposals_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE opportunities ADD CONSTRAINT opportunities_workspace_id_pair_key UNIQUE (workspace_id, id);
ALTER TABLE proposals ADD CONSTRAINT proposals_opportunity_same_workspace_fk
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES opportunities(workspace_id, id) ON DELETE SET NULL (opportunity_id);
ALTER TABLE messages ADD CONSTRAINT messages_lead_same_workspace_fk
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE SET NULL (lead_id);
ALTER TABLE messages ADD CONSTRAINT messages_provider_same_workspace_fk
  FOREIGN KEY (workspace_id, provider_id) REFERENCES communication_providers(workspace_id, id) ON DELETE SET NULL (provider_id);
ALTER TABLE calls ADD CONSTRAINT calls_time_order CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at);
ALTER TABLE calls ADD CONSTRAINT calls_answer_after_start CHECK (answered_at IS NULL OR started_at IS NULL OR answered_at >= started_at);
ALTER TABLE call_notes ADD CONSTRAINT call_notes_call_same_workspace_fk
  FOREIGN KEY (workspace_id, call_id) REFERENCES calls(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_automation_same_workspace_fk
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_invoice_same_workspace_fk
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_usage_same_workspace_fk
  FOREIGN KEY (workspace_id, usage_event_id) REFERENCES usage_events(workspace_id, id) ON DELETE SET NULL (usage_event_id);

CREATE UNIQUE INDEX tasks_legacy_one_open_next_action_key ON tasks(workspace_id, lead_id)
  WHERE lead_id IS NOT NULL AND source = 'legacy' AND status IN ('pending', 'in_progress');
ALTER TABLE tasks ADD COLUMN migration_source text;
ALTER TABLE tasks ADD COLUMN migration_source_id text;
CREATE UNIQUE INDEX tasks_import_source_id_key ON tasks(workspace_id, migration_source, migration_source_id)
  WHERE migration_source IS NOT NULL AND migration_source_id IS NOT NULL;
ALTER TABLE messages ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX messages_workspace_idempotency_key ON messages(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
UPDATE automation_runs SET idempotency_key = 'legacy:' || id::text WHERE idempotency_key IS NULL;
ALTER TABLE automation_runs ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE automation_runs ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE automation_runs ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE automation_runs ADD COLUMN retry_after timestamptz;

-- Reusable auth sessions store only a hash of the browser's opaque random token.
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_sessions_workspace_membership_fk
    FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

-- Consent and provider event receipts are scoped and replay-safe.
CREATE TABLE communication_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL,
  channel communication_channel NOT NULL,
  opted_in boolean NOT NULL DEFAULT false,
  source text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, lead_id, channel),
  FOREIGN KEY (workspace_id, lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE
);
CREATE TABLE webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);

-- Automation runs point to an immutable workflow definition snapshot.
CREATE TABLE automation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  automation_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  definition jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(automation_id, version_number),
  UNIQUE(workspace_id, id),
  UNIQUE(workspace_id, automation_id, id),
  FOREIGN KEY (workspace_id, automation_id) REFERENCES automations(workspace_id, id) ON DELETE CASCADE
);
INSERT INTO automation_versions(workspace_id, automation_id, version_number, definition, created_by)
SELECT a.workspace_id, a.id, 1,
       jsonb_build_object(
         'triggerType', a.trigger_type,
         'triggerConfig', a.trigger_config,
         'actions', COALESCE(
           jsonb_agg(jsonb_build_object('position', aa.position, 'actionType', aa.action_type, 'config', aa.action_config)
                     ORDER BY aa.position) FILTER (WHERE aa.id IS NOT NULL),
           '[]'::jsonb
         )
       ),
       a.created_by
FROM automations a
LEFT JOIN automation_actions aa ON aa.automation_id = a.id
GROUP BY a.workspace_id, a.id, a.trigger_type, a.trigger_config, a.created_by;
ALTER TABLE automations ADD COLUMN current_version_id uuid;
UPDATE automations a SET current_version_id = v.id
FROM automation_versions v WHERE v.automation_id = a.id AND v.version_number = 1;
ALTER TABLE automations ADD CONSTRAINT automations_current_version_fk
  FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES automation_versions(workspace_id, automation_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE automations ADD CONSTRAINT automations_active_requires_version
  CHECK (NOT active OR current_version_id IS NOT NULL);
ALTER TABLE automation_runs ADD COLUMN version_id uuid;
UPDATE automation_runs r SET version_id = v.id
FROM automation_versions v WHERE v.automation_id = r.automation_id AND v.version_number = 1;
ALTER TABLE automation_runs ALTER COLUMN version_id SET NOT NULL;
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_version_fk
  FOREIGN KEY (workspace_id, automation_id, version_id)
  REFERENCES automation_versions(workspace_id, automation_id, id);
ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_workspace_id_id_key UNIQUE (workspace_id, id);
CREATE TABLE automation_action_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_run_id uuid NOT NULL,
  version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'skipped')),
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  UNIQUE(automation_run_id, position),
  FOREIGN KEY (workspace_id, automation_run_id) REFERENCES automation_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, version_id) REFERENCES automation_versions(workspace_id, id)
);

-- Versioned, pre-execution cost rates are owned by RedBlack Core, not by a provider subscription.
CREATE TABLE provider_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text,
  service text NOT NULL,
  usage_type text NOT NULL,
  unit text NOT NULL,
  provider_cost_per_unit numeric(20,8) NOT NULL CHECK (provider_cost_per_unit >= 0),
  customer_charge_per_unit numeric(20,8) NOT NULL CHECK (customer_charge_per_unit >= 0),
  currency char(3) NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX provider_rates_lookup_idx ON provider_rates(workspace_id, service, usage_type, unit, valid_from DESC);
CREATE UNIQUE INDEX provider_rates_version_key ON provider_rates
  (COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(provider, ''), service, usage_type, unit, currency, valid_from);
CREATE TABLE usage_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_event_id uuid NOT NULL,
  amount numeric(20,8) NOT NULL,
  currency char(3) NOT NULL,
  reason text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, usage_event_id) REFERENCES usage_events(workspace_id, id)
);

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_system text NOT NULL,
  status text NOT NULL CHECK (status IN ('preview', 'running', 'completed', 'completed_with_errors', 'failed')),
  source_fingerprint char(64),
  source_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejected_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, source_system, source_fingerprint)
);
CREATE TABLE external_id_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  import_batch_id uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  source_system text NOT NULL,
  entity_type text NOT NULL,
  source_id text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, source_system, entity_type, source_id)
);
CREATE TABLE import_row_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_sheet text NOT NULL,
  source_row integer NOT NULL CHECK (source_row > 0),
  source_id text,
  error_code text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(import_batch_id, source_sheet, source_row)
);
ALTER TABLE import_batches ADD CONSTRAINT import_batches_workspace_id_id_key UNIQUE(workspace_id, id);
ALTER TABLE external_id_mappings ADD CONSTRAINT external_id_mappings_batch_same_workspace_fk
  FOREIGN KEY(workspace_id, import_batch_id) REFERENCES import_batches(workspace_id, id) ON DELETE SET NULL (import_batch_id);

-- Make ledgers and version snapshots append-only; corrections are compensating rows.
CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a compensating record instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER usage_events_append_only BEFORE UPDATE OR DELETE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER usage_adjustments_append_only BEFORE UPDATE OR DELETE ON usage_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER provider_rates_append_only BEFORE UPDATE OR DELETE ON provider_rates
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER automation_versions_append_only BEFORE UPDATE OR DELETE ON automation_versions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();

CREATE INDEX leads_workspace_created_idx ON leads(workspace_id, created_at DESC, id);
CREATE INDEX leads_workspace_owner_idx ON leads(workspace_id, owner_user_id, created_at DESC);
CREATE INDEX tasks_workspace_assignee_status_due_idx ON tasks(workspace_id, assigned_to, status, due_at);
CREATE INDEX messages_workspace_lead_time_idx ON messages(workspace_id, lead_id, created_at DESC);
CREATE INDEX messages_workspace_time_idx ON messages(workspace_id, created_at DESC);
CREATE INDEX messages_workspace_provider_event_idx ON messages(workspace_id, provider_event_at DESC);
CREATE INDEX activities_workspace_time_idx ON activities(workspace_id, occurred_at DESC);
CREATE INDEX calls_workspace_time_idx_v2 ON calls(workspace_id, started_at DESC);
CREATE INDEX automation_runs_queue_idx ON automation_runs(status, retry_after, started_at, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX meetings_workspace_start_idx ON meetings(workspace_id, starts_at);
CREATE INDEX opportunities_workspace_status_idx ON opportunities(workspace_id, status, expected_close_date);

