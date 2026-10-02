# Implementation status

This change completes the RedBlack Core application foundation after the CRM schema migration.

- Backend/API: native Node HTTP service with `/api/v1`, a served `/app/`, `/health`, and an OpenAPI document at `/api/v1/openapi.json`.
- Identity: password login, first-owner bootstrap, secure sessions, active workspace selection, CSRF, rate limits, RBAC, and tenant-scoped records.
- CRM: leads, stages, pipelines, assignments, tasks, activities, meetings, calls, and reports.
- Communications: provider-neutral registries for email, WhatsApp, RCS, and calling. Core has no configured provider and contains no Convo360 integration.
- Automation: immutable workflow versions, idempotent queued runs, replay-safe action records, and a worker with retry handling.
- PAYG: versioned Core-managed rates, fixed-point quote calculation, append-only usage ledger, and usage adjustments.
- Migration: preview-first, idempotent `LEADS`/`TASKS`/`CALENDAR` CSV importer using the approved legacy mapping.
- Operations: containers, one-domain edge routing, environment templates, CI, migration verification, dependency audit, and deployment runbook.

The remaining release gates are PR review/merge, a staging rehearsal using the real sheet export, and production infrastructure configuration.


