# RedBlack CRM v1 — Schema Design

## Purpose
Production CRM schema derived from the approved Google Sheet + Apps Script migration mapping. Google Sheets remains a migration/reference source only.

## Tenancy
- Workspace is the tenant boundary.
- Every CRM-owned record carries `workspace_id` directly or through its parent.
- Users may belong to multiple workspaces.
- Production data must never rely on Google Sheets IDs as primary keys.

## Core entities
1. `workspaces` — client/company account and billing boundary.
2. `users` — authenticated people operating the workspace.
3. `workspace_members` — user membership, role and status.
4. `roles` — owner/admin/manager/agent/reporting/service roles.
5. `leads` — canonical prospect/customer record.
6. `lead_sources` — website, referral, campaign, import, API, etc.
7. `lead_tags` / `tags` — flexible classification.
8. `lead_custom_fields` / `custom_field_definitions` — workspace-configurable fields.
9. `pipelines` — independent sales processes; initial pipelines: Franchise, Realty, Tech.
10. `pipeline_stages` — ordered stages within each pipeline.
11. `lead_pipeline_entries` — a lead's current/previous pipeline state and stage history.
12. `lead_assignments` — agent ownership/distribution history.
13. `tasks` — follow-ups and operational work.
14. `activities` — unified timeline events.
15. `calls` — telephony/AI call records and outcomes.
16. `call_participants` — lead/agent/provider-side participants.
17. `call_notes` — structured/unstructured notes linked to calls.
18. `meetings` — appointments linked to leads and users.
19. `proposals` — sales proposal records.
20. `opportunities` — commercial opportunity/value state where separate from lead identity.
21. `automations` — workspace automation definitions.
22. `automation_runs` — execution history, status, errors and provider usage.
23. `automation_actions` — ordered actions within an automation.
24. `messages` — normalized outbound/inbound communication record.
25. `communication_providers` — provider configuration metadata; secrets remain in secret storage.
26. `usage_events` — immutable PAYG consumption ledger.
27. `provider_costs` — provider-reported/request-level cost metadata.
28. `billing_accounts` — customer billing configuration.
29. `invoices` / `invoice_items` — customer-facing usage/service billing.
30. `audit_logs` — security and operational audit trail.

## Lead model
Canonical lead fields preserve the existing CRM concepts: name, phone, email, source, brand/project, opportunity type, budget, location, requirement, stage/status, score/temperature, owner, next action, next action date, meeting details, follow-up metadata, notes and timestamps.

Use normalized fields for searchable/queryable values and JSON/custom-field storage only for workspace-specific extensions.

### Duplicate detection
Primary duplicate candidates: normalized phone, normalized email. Secondary matching: name + company/context. Deduplication must be reversible and audited; never silently delete a lead.

## Pipelines
Initial seed pipelines:
- Franchise: New Lead → Contact Attempted → Connected → Qualified → Meeting/Presentation → Proposal → Negotiation → Won/Lost
- Realty: same canonical stages, configurable per workspace
- Tech: same canonical stages, configurable per workspace

Stage changes create immutable activity/history records.

## Agent/user model
Users authenticate once and may belong to many workspaces. `workspace_members` controls role and active status. Lead assignment is separate from membership so ownership history is retained.

## Calling model
`calls` stores provider-independent call metadata: direction, provider, external ID, status, started/ended time, duration, recording reference, AI/human flag, disposition and cost. Provider-specific payloads remain in adapter/event storage rather than contaminating the core CRM model.

## Communication model
Email, WhatsApp, RCS and voice are provider adapters behind a common communication interface. `messages` stores normalized business events and provider IDs. Raw provider payloads are retained separately where needed for debugging/audit.

## Automation model
Automation = trigger + ordered actions + conditions. Execution is asynchronous and idempotent. Every run records status, timestamps, retries, failure reason and usage events. Automations must be workspace-scoped.

## Usage/PAYG model
`usage_events` is append-only. Examples: email_sent, whatsapp_message, rcs_message, voice_seconds, ai_input_tokens, ai_output_tokens, storage_bytes. Each event records workspace, provider, product/service, quantity, unit, provider cost, internal charge, currency and idempotency key. This enables cost-before-quote calculators and customer billing without requiring subscriptions for external communication providers.

## Security
- Tenant isolation enforced at service/data-access layer.
- Passwords handled only by a proven auth provider/library; never stored directly.
- Provider/API secrets stored in secret management, never database plaintext or Git.
- Audit sensitive actions.
- Encrypt data in transit and at rest.
- Signed webhooks with replay protection.
- Role-based authorization on every workspace-scoped operation.

## API architecture
Versioned REST API initially: `/api/v1/...`. Domain modules: auth, workspaces, users, leads, pipelines, tasks, activities, calls, meetings, automations, communications, usage, billing and reports. Webhooks are inbound adapter endpoints and must not expose provider-specific models to the core domain.

## One-domain architecture
Public website and CRM share the RedBlack Tech domain. The application is planned under `/app` (for example `redblacktech.com/app`) while preserving existing public routes. Internal APIs may be routed behind the same domain/API gateway.

## Migration principle
Import existing sheet data into normalized CRM entities with deterministic mapping and migration IDs. Preserve original values where mapping is ambiguous. Do not make Google Sheets a runtime dependency.

## Deferred implementation
No Convo360 integration. No provider subscription dependency. External communication/AI services are consumed through provider adapters and PAYG usage accounting. Detailed SQL/ORM syntax and infrastructure choices are implemented only after schema review.
