# CRM compatibility and completeness audit

RedBlack Core keeps PostgreSQL as the system of record. The prior Apps Script CRM remains a behavioral reference; Google Sheets/Apps Script are not runtime dependencies.

## Implemented on PR #28

- lead create, detail, edit, search/filter, pagination, duplicate detection, soft-delete Trash, restore, owner/admin permanent delete, bulk trash/status/owner/stage/tag operations
- lead create now persists required custom fields and tags atomically; lead edit is transactional across standard fields, custom fields, tags, audit, scoring and automation enqueue
- agent-scoped active leads, Trash, bulk mutations, tasks and meetings; workspace RBAC remains enforced server-side
- bulk mutations validate every lead against the active workspace before changing assignments, tags or stages
- configurable lead custom fields with field types, required state, section/order/options/visibility/read-only metadata and an editor for existing fields
- workspace tags, lead sources, task types, saved lead views and active lead-list layouts
- configurable pipelines/stages with pipeline settings, stage editing, transactional occupied-position swaps, persisted stage history and drag/drop lead movement
- complete practical task workflow: create, edit, complete, cancel and reopen
- Today sales desk
- native meeting create/edit and completed/missed/cancelled outcomes, with PostgreSQL API coverage for list and lead-filtered queries
- CSV import with column mapping, a sample preview, required custom fields, duplicate skipping and downloadable row errors; export includes custom fields, honors current search/status filters and stays agent-scoped
- assignment rules (fixed owner, round robin, unassigned) and deterministic scoring rules using nested conditions, including custom-field paths; rules can be enabled/disabled and updated
- visual automation action editor with drag/reorder, broad trigger vocabulary, nested ALL/ANY trigger conditions, waits, versioned definitions, clone/edit/test/manual-run controls and run-history visibility
- step-level automation run inspection backed by automation_action_runs
- executable CRM automation actions include create task/activity/note, schedule follow-up, update lead, assign owner, change stage, create message draft, waits, AI, provider communication and provider calls; unsupported actions are not advertised
- automation wait/resume progression fixed so resumed runs continue after a completed wait step
- database-enforced one-open-automation-follow-up invariant for the same workspace/lead/title, with conflict-safe worker inserts
- Communication, Voice, AI Gateway, Usage/Billing and Control Center boundaries preserved
- OpenAPI expanded for CRM Builder, rule lifecycle and automation runtime inspection surfaces
- migration 0010 adds CRM assignment/scoring rules, saved views, layouts and task types
- migration 0011 repairs historical duplicate open automation follow-ups and installs the partial unique index that prevents recurrence
- PostgreSQL behavioral coverage now exercises tenant-safe bulk operations, required custom fields/tags, CSV mapping/import/export and role-scoped export, stage movement/reordering, meeting queries, CRM rule updates, automation worker CRM actions and atomic rollback of invalid lead edits

## Apps Script behavior preserved or translated

- statuses and status-driven workflows
- next follow-up / next action
- Touch/follow-up task concepts
- DND/consent boundaries
- owner, budget, score and temperature
- duplicate-safe intended automation follow-up tasks
- pipeline/stage history
- calendar/meeting identifiers and hooks
- WhatsApp/email/call records through provider-neutral gateways

## Intentional changes

- PostgreSQL is authoritative; Sheets/Apps Script are migration/reference inputs only.
- outbound communication requires configured adapters and consent/DNC checks.
- destructive lead deletion is soft-delete first; permanent deletion is explicit and owner/admin controlled.
- automation definitions are versioned and execution is idempotent.
- the Automation Builder only advertises actions that the worker can actually execute safely.

## Remaining work before declaring the requested world-class CRM complete

- full graph-style automation branching/connection canvas; the current builder is an ordered draggable action flow rather than a node-edge graph
- richer per-step visual configuration and branch/condition editing instead of JSON for advanced automation configuration
- clearer draft-versus-publish/version lifecycle and operator retry controls for failed automation runs
- stage archive/delete lifecycle and richer pipeline administration beyond edit/reorder/active pipeline controls
- edit/deactivate lifecycle UI for lead sources, task types and tags, plus richer saved-view management (more filters, sort/columns and delete/rename)
- chunked and resumable imports for files larger than the current 5,000-row limit
- further concurrency hardening around active lead email/phone identity beyond application-level duplicate checks
- deeper behavioral E2E coverage for layouts/saved views and advanced automation branches
- final local Docker/browser acceptance across owner/admin/manager/agent/reporting/service roles before merge
