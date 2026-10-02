# RedBlack Core — Production Database Layer Proposal v1

## Decision
Use PostgreSQL as the production database and the system of record for RedBlack CRM. Google Sheets remains migration-only.

## Deployment
Run PostgreSQL in the RedBlack production environment rather than adopting a CRM SaaS or managed CRM database. Keep database access private; the application API is the normal application-facing entry point.

Development and staging use isolated PostgreSQL databases. Production data is never used directly by development.

## Application data layer
Use Git-tracked migrations and a typed ORM/query layer. Database access is isolated behind repository/service modules rather than scattered through API handlers.

Required behavior:
- transactions for multi-record business operations;
- foreign keys and database constraints;
- workspace-scoped unique indexes where needed;
- soft deletion where records must remain auditable;
- immutable event/usage records;
- UTC timestamps;
- cursor pagination for large lists;
- explicit indexes for common CRM filters.

## Logical modules
- identity/workspaces
- CRM/leads/pipelines
- tasks/activities/meetings
- communications/calls
- automation
- usage/billing
- reporting
- audit

These are application modules, not separate databases.

## Initial indexes
- leads(workspace_id, normalized_phone)
- leads(workspace_id, normalized_email)
- leads(workspace_id, owner_user_id)
- leads(workspace_id, status)
- leads(workspace_id, created_at)
- lead_pipeline_entries(workspace_id, pipeline_id, stage_id)
- tasks(workspace_id, assigned_user_id, status, due_at)
- activities(workspace_id, lead_id, occurred_at)
- calls(workspace_id, lead_id, started_at)
- messages(workspace_id, lead_id, created_at)
- usage_events(workspace_id, occurred_at)
- unique idempotency keys for provider/webhook/usage events as appropriate.

## Security
- Database private to the application network.
- Least-privilege runtime credentials.
- Separate migration/admin credentials where practical.
- Secrets supplied through environment/secret management and never committed to Git.
- Encrypted production backups.
- Audit security-sensitive changes.

## Backup/recovery
Automated production backups and a documented restore procedure are required before launch. Restore testing is part of pre-launch QA.

## Migration
The approved CRM migration map is the source specification. A dedicated migration script will validate rows, normalize phone/email, map pipeline/status values, preserve source IDs, detect duplicates without silent deletion, import supported leads/tasks/activities, produce import and rejected-row reports, and be safely re-runnable using deterministic migration keys.

## PAYG
Provider usage is recorded in PostgreSQL while external communication providers remain adapters. Each provider call/message/AI usage event records quantity and provider cost when available so RedBlack can calculate internal cost and customer charge before execution or quoting.

## One-domain deployment
The public website remains on the existing RedBlack Tech domain. The CRM application is planned under `/app` and API routes under `/api/v1`, subject to final reverse-proxy configuration.

## Environments
- development: local Docker PostgreSQL + local API/web app
- staging: isolated server/database for release and migration testing
- production: isolated server/database with backups and monitoring

## Not decided by this proposal
- specific VPS/cloud vendor;
- final frontend framework;
- final ORM package;
- communication providers;
- AI model provider;
- Convo360 integration.

These remain implementation decisions and must not change the approved core data model.