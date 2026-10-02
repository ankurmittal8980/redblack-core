-- RedBlack Core CRM v1
-- PostgreSQL migration 0001
-- Google Sheets is migration-only; this schema is the production system of record.

create extension if not exists pgcrypto;

create type member_role as enum ('owner','admin','manager','agent','reporting','service');
create type record_status as enum ('active','inactive','archived');
create type lead_temperature as enum ('hot','warm','cold');
create type task_status as enum ('pending','in_progress','completed','cancelled');
create type call_direction as enum ('inbound','outbound');
create type call_status as enum ('queued','ringing','answered','missed','busy','failed','cancelled');
create type automation_run_status as enum ('queued','running','completed','failed','cancelled');
create type communication_channel as enum ('email','whatsapp','rcs','voice');

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status record_status not null default 'active',
  timezone text not null default 'Asia/Kolkata',
  currency char(3) not null default 'INR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  phone text,
  status record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role member_role not null default 'agent',
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table lead_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique(workspace_id, name)
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  unique(workspace_id, name)
);

create table leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  migration_source text,
  migration_source_id text,
  first_name text,
  last_name text,
  company_name text,
  email text,
  email_normalized text,
  phone text,
  phone_normalized text,
  source_id uuid references lead_sources(id) on delete set null,
  brand_project text,
  opportunity_type text,
  budget numeric(18,2),
  location text,
  requirement text,
  status text not null default 'New Lead',
  temperature lead_temperature,
  score integer not null default 0 check (score >= 0),
  notes text,
  next_action text,
  next_action_at timestamptz,
  last_contacted_at timestamptz,
  last_followup_at timestamptz,
  meeting_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique(workspace_id, migration_source, migration_source_id)
);

create index leads_workspace_phone_idx on leads(workspace_id, phone_normalized) where deleted_at is null;
create index leads_workspace_email_idx on leads(workspace_id, email_normalized) where deleted_at is null;
create index leads_workspace_status_idx on leads(workspace_id, status) where deleted_at is null;

create table lead_tags (
  lead_id uuid not null references leads(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  primary key (lead_id, tag_id)
);

create table custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  entity_type text not null default 'lead',
  field_key text not null,
  label text not null,
  field_type text not null,
  required boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(workspace_id, entity_type, field_key)
);

create table lead_custom_fields (
  lead_id uuid not null references leads(id) on delete cascade,
  field_definition_id uuid not null references custom_field_definitions(id) on delete cascade,
  value jsonb,
  primary key (lead_id, field_definition_id)
);

create table pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  slug text not null,
  active boolean not null default true,
  unique(workspace_id, slug)
);

create table pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name text not null,
  slug text not null,
  position integer not null,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  unique(pipeline_id, slug),
  unique(pipeline_id, position)
);

create table lead_pipeline_entries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  current_stage_id uuid not null references pipeline_stages(id),
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  is_current boolean not null default true
);
create unique index lead_one_current_pipeline on lead_pipeline_entries(lead_id, pipeline_id) where is_current;

create table lead_stage_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  from_stage_id uuid references pipeline_stages(id),
  to_stage_id uuid not null references pipeline_stages(id),
  changed_by uuid references users(id) on delete set null,
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table lead_assignments (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  assigned_by uuid references users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  reason text
);
create unique index lead_one_active_assignment on lead_assignments(lead_id) where unassigned_at is null;

create table tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  assigned_to uuid references users(id) on delete set null,
  created_by uuid references users(id) on delete set null,
  title text not null,
  description text,
  due_at timestamptz,
  status task_status not null default 'pending',
  completed_at timestamptz,
  priority integer not null default 0,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table activities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  type text not null,
  title text not null,
  body text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  provider text,
  provider_call_id text,
  direction call_direction not null,
  status call_status not null,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer not null default 0,
  recording_ref text,
  is_ai boolean not null default false,
  disposition text,
  cost_amount numeric(18,6),
  cost_currency char(3),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider, provider_call_id)
);

create table call_notes (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  author_user_id uuid references users(id) on delete set null,
  note text not null,
  created_at timestamptz not null default now()
);

create table meetings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  owner_user_id uuid references users(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status text not null default 'scheduled',
  meeting_type text,
  external_provider text,
  external_event_id text,
  notes text,
  created_at timestamptz not null default now()
);

create table opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  pipeline_id uuid references pipelines(id) on delete set null,
  owner_user_id uuid references users(id) on delete set null,
  value numeric(18,2),
  currency char(3),
  status text not null default 'open',
  expected_close_date date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  opportunity_id uuid references opportunities(id) on delete set null,
  status text not null default 'draft',
  amount numeric(18,2),
  currency char(3),
  issued_at timestamptz,
  accepted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create table automations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text,
  active boolean not null default false,
  trigger_type text not null,
  trigger_config jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table automation_actions (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  position integer not null,
  action_type text not null,
  action_config jsonb not null default '{}'::jsonb,
  unique(automation_id, position)
);

create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references automations(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  status automation_run_status not null default 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  unique(automation_id, idempotency_key)
);

create table communication_providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  channel communication_channel not null,
  provider_name text not null,
  active boolean not null default true,
  config_ref text,
  created_at timestamptz not null default now()
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  provider_id uuid references communication_providers(id) on delete set null,
  channel communication_channel not null,
  direction text not null,
  provider_message_id text,
  status text,
  subject text,
  body text,
  sent_at timestamptz,
  delivered_at timestamptz,
  cost_amount numeric(18,6),
  cost_currency char(3),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(provider_id, provider_message_id)
);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider text,
  service text not null,
  usage_type text not null,
  quantity numeric(20,8) not null,
  unit text not null,
  provider_cost numeric(20,8),
  internal_charge numeric(20,8),
  currency char(3) not null default 'INR',
  external_reference text,
  idempotency_key text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(workspace_id, idempotency_key)
);

create table billing_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references workspaces(id) on delete cascade,
  billing_email text,
  tax_id text,
  payment_terms_days integer not null default 0,
  created_at timestamptz not null default now()
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  invoice_number text not null,
  status text not null default 'draft',
  currency char(3) not null default 'INR',
  subtotal numeric(18,2) not null default 0,
  tax numeric(18,2) not null default 0,
  total numeric(18,2) not null default 0,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  unique(workspace_id, invoice_number)
);

create table invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  usage_event_id uuid references usage_events(id) on delete set null,
  description text not null,
  quantity numeric(20,8) not null default 1,
  unit_price numeric(18,6) not null default 0,
  amount numeric(18,2) not null default 0,
  metadata jsonb not null default '{}'::jsonb
);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  actor_user_id uuid references users(id) on delete set null,
  action text not null,
  entity_type text,
  entity_id uuid,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index activities_lead_time_idx on activities(lead_id, occurred_at desc);
create index tasks_workspace_due_idx on tasks(workspace_id, status, due_at);
create index calls_workspace_time_idx on calls(workspace_id, started_at desc);
create index messages_lead_time_idx on messages(lead_id, created_at desc);
create index usage_workspace_time_idx on usage_events(workspace_id, occurred_at desc);
create index audit_workspace_time_idx on audit_logs(workspace_id, created_at desc);

-- Initial pipeline seed is intentionally performed by application/bootstrap code,
-- because each workspace may customize stage names/order.
