# CRM compatibility and completeness audit

RedBlack Core keeps PostgreSQL as the system of record. The prior Apps Script CRM remains a behavioral reference; Google Sheets/Apps Script are not runtime dependencies.

## Implemented on PR #28

- lead create, detail, edit, search/filter, pagination, duplicate detection, soft-delete Trash, restore, owner/admin permanent delete, bulk trash/status/owner/stage/tag operations
- agent-scoped active leads, Trash, bulk mutations, tasks and meetings; workspace RBAC remains enforced server-side
- configurable lead custom fields with field types, required state and layout metadata; values persist per lead
- workspace tags, lead sources, task types, saved lead views and active lead-list layouts
- configurable pipelines/stages plus persisted stage history and drag/drop lead movement
- complete practical task workflow: create, edit, complete, cancel and reopen
- Today sales desk
- native meeting create/edit and completed/missed/cancelled outcomes
- CSV import/export with duplicate skipping and agent-scoped export
- assignment rules (fixed owner, round robin, unassigned) and deterministic scoring rules using nested conditions, including custom-field paths
- visual automation action editor with drag/reorder, broad trigger/action vocabulary, nested ALL/ANY trigger conditions, waits, versioned definitions and run-history visibility
- automation wait/resume progression fixed so resumed runs continue after a completed wait step
- Communication, Voice, AI Gateway, Usage/Billing and Control Center boundaries preserved
- OpenAPI expanded for new CRM surfaces
- migration 0010 adds CRM assignment/scoring rules, saved views, layouts and task types

## Apps Script behavior preserved or translated

- statuses and status-driven workflows
- next follow-up / next action
- Touch/follow-up task concepts
- DND/consent boundaries
- owner, budget, score and temperature
- one idempotent intended automation follow-up task
- pipeline/stage history
- calendar/meeting identifiers and hooks
- WhatsApp/email/call records through provider-neutral gateways

## Intentional changes

- PostgreSQL is authoritative; Sheets/Apps Script are migration/reference inputs only.
- outbound communication requires configured adapters and consent/DNC checks.
- destructive lead deletion is soft-delete first; permanent deletion is explicit and owner/admin controlled.
- automation definitions are versioned and execution is idempotent.

## Remaining work before declaring the requested world-class CRM complete

- full graph-style automation branching/connection canvas (current visual builder is ordered action cards with nested trigger conditions and waits)
- richer per-step visual condition/branch editing rather than JSON for advanced conditions
- workflow clone/edit/publish/test controls and step-level run inspection in the UI
- richer custom-field editor for changing existing field label/options/visibility/order/read-only settings (backend PATCH exists)
- pipeline/stage edit/reorder/archive UI beyond create + drag/drop lead movement
- deeper behavioral PostgreSQL E2E tests for the newly added CRM builder/rule/import/layout flows
- final local browser acceptance across owner/admin/manager/agent/reporting/service roles
