# RedBlack Core — Implementation Status

## Current state
- Website remains the public RedBlack Tech surface.
- RedBlack Core is the production application/backend foundation.
- Google Sheet + Apps Script are migration/reference sources only.
- Convo360 is intentionally not integrated.
- External communication and AI providers remain provider-neutral and PAYG-oriented.
- CRM is planned under the same public domain using the `/app` application path.

## Implemented in this phase
- PostgreSQL-oriented production schema covering workspaces, users/memberships, leads, pipelines/stages/history, assignments, tasks, activities, calls, meetings, opportunities, proposals, automations/runs/actions, normalized communications, usage, billing and audit records.
- Indexing and tenant-scoping requirements are defined in the migration.

## Required next implementation order
1. Database environment/configuration and migration runner.
2. Authentication + workspace membership/RBAC.
3. Leads API + duplicate detection + assignments.
4. Pipeline/stage API + stage history.
5. Tasks/activities/meetings API.
6. Communication adapter interfaces (Email/WhatsApp/RCS/Voice) without provider lock-in.
7. Calling adapter interface and call-event ingestion.
8. Automation engine primitives and idempotent execution.
9. Usage metering and cost calculator.
10. Reporting API.
11. CRM web application under `/app`.
12. Google Sheet migration importer and reconciliation.
13. End-to-end tests, security review and deployment environments.

## Review gates
Only stop for user review when an architecture/security decision materially changes the approved design or when a PR is ready to merge into `main`.
