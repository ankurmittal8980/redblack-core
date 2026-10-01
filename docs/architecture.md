# RedBlack Core — Master Architecture

**Status:** Frozen logical baseline (v1)  
**Owner:** Red Black Tech

This document fixes the platform's top-level boundaries, data ownership, and integration patterns. It deliberately leaves implementation frameworks, hosting vendors, and concrete communication, AI, and billing providers open.

## 1. System Architecture

Red Black Tech is the organization. RedBlack Core is its shared platform for CRM, automation, AI, communications, client/workspace management, and billing.

    RED BLACK TECH
           |
           v
      RED BLACK CORE
       /     |     \
      v      v      v
     CRM  AUTOMATION  AI
       \     |     /
           v
     COMMUNICATION
      /    |    |    \
    Email WhatsApp RCS Voice
           |
           v
         CLIENT
           |
           v
         BILLING

CRM, Automation, and AI use the common communication boundary. The four channel adapters address a client and report normalized outcomes. The client account owns workspaces, data, and usage. Billing consumes that account's metered usage and entitlements.

These are logical domains and stable contracts, not a requirement to deploy every box as a separate service. Implementation may begin as a modular application with background workers while preserving the boundaries described here.

**Baseline decisions**

- RedBlack Core is the platform boundary; CRM, Automation, AI, Communication, Usage, and Billing are domain boundaries.
- RedBlack Database is the source of truth for platform and CRM records.
- A client account is the tenant boundary; workspaces organize that tenant's users and work.
- Communication and AI integrations go through RedBlack-owned adapters.
- Metered events flow into Billing; domain modules do not calculate final invoices independently.

## 2. Multi-tenant Client/Workspace Model

In this architecture, **Client** means a RedBlack customer account (tenant). A CRM contact or organization is a record managed by that tenant; it is not a tenant. Keeping those meanings separate avoids ambiguity in code and data models.

- A tenant owns its workspaces, users/memberships, CRM records, communication history, automations, AI activity, usage, and billing records.
- A tenant may have one or more workspaces. Workspace membership and role can scope access further than tenant membership.
- A user may belong to multiple tenants, with a separate membership and role in each.
- Every tenant-owned row carries a tenant identifier. Workspace-scoped rows also carry a workspace identifier.
- Tenant context is resolved from the authenticated membership and checked by the backend on every request. A caller-supplied tenant ID is never sufficient authorization.
- Database relationships and uniqueness rules include tenant scope where needed, preventing cross-tenant references as well as cross-tenant reads.
- Platform operations use a separate, explicitly authorized control-plane boundary and are audited.

Tenant isolation is mandatory in queries, background jobs, cache keys, search indexes, file references, webhooks, and exports.

## 3. Database Architecture

RedBlack Database is the canonical, transactional system of record. The logical model is relational and should use foreign keys, scoped uniqueness constraints, and versioned migrations. The specific database engine remains an implementation choice to record when the application stack is selected.

- Store canonical tenant, workspace, user-membership, CRM, communication, automation, usage, and billing data here.
- Use stable opaque identifiers and explicit created/updated timestamps. Record important state transitions in an audit/event history.
- Keep schema migrations versioned, reviewed, and repeatable. Application code must not silently mutate production schema.
- Store files and large payloads through a storage boundary; keep tenant-scoped metadata and references in the database.
- Keep provider credentials and application secrets outside the database schema and source repository.
- Design imports to be repeatable: preserve source identifiers, record an import batch, and make replays idempotent.

**Google Sheets migration boundary**

    Existing Google Sheet + Apps Script
                    |
                    v
           Migration / Import
                    |
                    v
             RedBlack Database
                    |
                    v
               RedBlack CRM

Google Sheets is **not** the CRM and is not the production source of truth. Preserve the existing Sheet and Apps Script as migration references so their data and established logic can be accounted for.

Before migration, capture the sheet structure, values, formulas, validations, lookup lists, Apps Script source, triggers, and relevant execution behavior. Map source columns and identifiers to the RedBlack model. Import through a repeatable migration process, then reconcile record counts, relationships, and representative business rules with the reference. Reimplement required business logic in RedBlack CRM or Automation and validate it before cutover. Keep the original materials available as read-only references after migration; do not discard or overwrite them as part of import.

## 4. CRM Architecture

CRM is a first-party RedBlack domain backed by RedBlack Database. It owns tenant-managed business records and the lifecycle rules for those records.

The initial logical entities are:

- Organizations and contacts
- Leads and opportunities
- Activities and communication interactions
- Tasks, notes, and tags
- Import batches and source-to-RedBlack identifier mappings

Every entity is tenant-scoped and optionally workspace-scoped. CRM operations use domain APIs and publish events for Automation and Usage. Communication history links to CRM records through internal identifiers; provider-specific identifiers remain adapter metadata.

Google Sheets and Apps Script are migration references only. New CRM reads and writes use RedBlack Core.

## 5. Authentication & Roles

Authentication establishes the user identity. Tenant membership and role-based authorization determine what that identity can do. The identity vendor is intentionally not selected here.

Initial role vocabulary:

- **Owner:** tenant-wide administration, membership, workspace, and billing authority.
- **Admin:** tenant configuration and membership administration, excluding ownership transfer.
- **Manager:** manage assigned workspaces and their CRM and automation operations.
- **Member:** use the CRM and communication capabilities granted in assigned workspaces.
- **Viewer:** read-only access to explicitly assigned workspaces and records.

Permissions are enforced on the server at tenant and workspace scope. UI visibility is not an authorization control. Privileged support access, if introduced, uses time-limited, reason-recorded, auditable elevation.

## 6. API Architecture

The backend exposes a versioned, documented API for the frontend, integrations, and internal domain modules.

- Use a versioned HTTP/JSON interface, initially under **/api/v1**, with an OpenAPI contract.
- Authenticate every protected request and resolve tenant/workspace scope before domain access.
- Use consistent validation, pagination, filtering, and error response shapes.
- Require idempotency for retryable operations that create external effects, including message sends, imports, and billing actions.
- Accept external callbacks through dedicated webhook endpoints. Verify signatures, timestamps, and replay protection in the relevant adapter before processing.
- Use asynchronous jobs for long-running automation, imports, provider callbacks, and metering aggregation. Return an operation or event identifier when work continues in the background.
- Publish domain events through an internal event boundary so producers do not depend on consumer implementation details.

The API contract is the boundary; modules should not bypass authorization by directly reaching into another domain's storage.

## 7. Communication Provider Adapters

RedBlack Core defines and owns these provider-neutral channel adapters:

- **RedBlack Email Adapter**
- **RedBlack WhatsApp Adapter**
- **RedBlack RCS Adapter**
- **RedBlack Voice Adapter**

Each adapter translates the internal communication envelope to and from whichever provider is selected later. No concrete provider is selected in this baseline.

The shared internal envelope includes tenant and workspace scope, destination, content or media reference, correlation and idempotency identifiers, requested channel, and delivery status. Adapters normalize provider callbacks into common accepted, queued, sent, delivered, failed, and inbound-message events where the channel supports them.

Adapters own provider-specific payloads, authentication, rate limits, callback verification, and error mapping. CRM, Automation, and AI call the RedBlack communication boundary and do not call a provider SDK directly. Provider selection, channel capability differences, consent rules, and regional restrictions are resolved in later implementation decisions.

## 8. Automation Engine

Automation evaluates tenant-owned, versioned workflows using domain events, schedules, or explicitly requested actions.

A workflow consists of a trigger, optional conditions, and ordered actions. Actions call authorized RedBlack domain APIs and adapters. The engine records the workflow version, tenant/workspace, execution status, timestamps, and per-step outcomes.

Executions are asynchronous and tenant-scoped. They use idempotency keys, bounded retries with backoff, failure/dead-letter handling, and an audit trail. Workflow edits are drafted and validated before publication. High-impact actions can require a human approval step. The engine cannot bypass the same tenant permissions or consent requirements enforced by direct API operations.

## 9. AI Gateway

The **RedBlack AI Adapter** is the single policy and accounting boundary for AI operations. No model vendor or AI provider is selected here.

The gateway accepts approved internal operations, applies tenant policy and data minimization, and returns normalized results. It centralizes capability checks, redaction, timeouts, error handling, optional fallback policy, and usage reporting. Domain modules do not embed provider SDK calls or credentials.

Requests carry tenant/workspace and correlation identifiers. Logs avoid unnecessary prompts and personal data; retention and redaction follow configured policy. Outputs used for consequential CRM changes or external communication can require human review. Model/provider choice, retention guarantees, and deployment mode remain explicit follow-up decisions.

## 10. Usage Metering

Usage is recorded as an append-oriented ledger of normalized events. Candidate billable dimensions include Email, WhatsApp, RCS, Voice, AI, automation executions, storage, and API usage; enabling any dimension for billing is a later commercial decision.

Each event records a stable event ID, tenant, optional workspace, event type, quantity and unit, occurrence time, source/correlation ID, and deduplication key. Provider details may be retained as metadata but are not the billing contract.

Metering consumers deduplicate retries and reconcile asynchronous provider outcomes. Aggregates are derived from ledger events and can be recalculated. Billing adjustments are explicit records; historical usage events are not silently rewritten.

## 11. Billing

Billing is tenant-account scoped and consumes metered usage together with plan entitlements and explicit adjustments. It owns subscription state, plan assignment, invoice lifecycle, and billing history. CRM and communication modules emit usage; they do not issue invoices.

Pricing, currencies, taxes, payment collection, and a concrete payment provider remain undecided. When selected, external billing or payment systems connect through an adapter boundary. Billing operations use idempotency and retain an auditable link from invoice lines to the usage or adjustment records that produced them.

## 12. Security

- Enforce tenant isolation at the API, domain, database query, job, cache, search, and storage-reference layers.
- Use encrypted transport and platform-supported encryption at rest. Keep secrets in environment-specific secret storage, never in Git.
- Apply least privilege to users, service credentials, jobs, and provider adapters.
- Validate and normalize external input. Verify webhook authenticity and prevent replay.
- Audit privileged actions, membership/role changes, imports, exports, billing changes, and sensitive communication actions.
- Define data classification, retention, deletion, and export rules for personal and communication data.
- Keep real tenant data out of development and staging unless an approved, minimized, protected workflow explicitly requires it.
- Review dependency, access, backup, and incident-response practices as part of deployment readiness.

## 13. Deployment

The architecture is deployment-vendor neutral. A production installation needs the RedBlack Core application/API, asynchronous workers, a transactional database, and a storage/queue boundary for files and jobs. These may begin as co-located modules and managed services; concrete products are selected separately.

Each environment has separate configuration, credentials, data, and operational access. Deployments provide structured logs, metrics, trace/correlation IDs, health checks, encrypted backups, and a tested restore procedure. Provider callbacks and scheduled jobs must be safe to retry.

## 14. Development → Staging → Production

- **Development:** local iteration with synthetic or sanitized data, example configuration, and fast feedback.
- **Staging:** production-like configuration shape, isolated credentials and data, migration rehearsals, integration checks, and release verification.
- **Production:** approved releases, tenant data, restricted access, monitoring, backup, and incident procedures.

Promote a reviewed build through the environments rather than rebuilding different artifacts. Apply backward-compatible database changes before code that depends on them. Verify migrations and rollback/forward-fix plans in staging. Use gradual rollout where practical, monitor health and tenant-visible outcomes, and keep application rollback independent from safe, forward-compatible schema evolution.
