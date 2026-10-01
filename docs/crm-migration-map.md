# RedBlack CRM — Migration Mapping Baseline

**Status:** Review required — no production CRM code changed  
**Source:** `MASTER CRM – MASTER_FINAL.xlsx` + supplied Google Apps Script (`FRANCHISE CRM V4.0 — CLEAN STABLE BUILD`)  
**Branch:** `feat/crm-migration-mapping`

## 1. Purpose

This document maps the existing Google Sheets CRM into the first-party RedBlack Core CRM. The spreadsheet and Apps Script remain migration/reference material; they are not the production source of truth.

The migration must preserve the existing business logic where it is still required, while removing spreadsheet-specific constraints such as row-based state, sheet tabs, cell-column coupling, and manual script triggers.

## 2. Source workbook inventory

The supplied workbook contains these sheets:

- `LEADS`
- `TASKS`
- `TODAY`
- `CALENDAR`
- `DASHBOARD`
- `CONTROL ROOM`
- `SETTINGS`
- `WHATSAPP SCRIPTS`
- `Manual`

Observed workbook dimensions/content:

- `LEADS`: 10,005 non-empty rows; 32 columns.
- `TASKS`: 32,790 non-empty rows; 9 columns.
- `TODAY`: 1,223 non-empty rows; 12 columns.
- `CALENDAR`: 2 non-empty rows; 6 columns.
- `DASHBOARD`: 14 non-empty rows; 2 columns.
- `CONTROL ROOM`: 11 non-empty rows; 3 columns.
- `SETTINGS`: 8 non-empty rows with content; 2 columns.
- `WHATSAPP SCRIPTS`: 13 non-empty rows; 4 columns.
- `Manual`: 358 non-empty rows; 2 columns.

The supplied Apps Script declares a 30-column A:AD `LEADS` layout, while the supplied workbook currently has 32 columns. The workbook's additional columns are `Brand / Project Name` and `Opportunity Type`. This discrepancy must be preserved and explicitly resolved during migration rather than silently dropping either field.

## 3. Current LEADS → RedBlack CRM

| Existing field | RedBlack entity/field | Migration treatment |
|---|---|---|
| Lead ID | `leads.external_source_id` + generated RedBlack `id` | Preserve source ID; generate internal ID |
| Date Added | `leads.created_at` | Direct mapping |
| Name | Contact name | Split into contact identity only if reliable; otherwise preserve display name |
| Phone | Contact phone | Normalize and retain original value |
| Investor Email | Contact email | Normalize and retain original value |
| Lead Source | Lead source | Preserve source value |
| Budget | Lead qualification / opportunity budget | Preserve raw value plus normalized numeric value later |
| Timeline | Lead qualification | Preserve enum/value |
| Decision Maker | Lead qualification | Preserve enum/value |
| Intent | Lead qualification | Preserve enum/value |
| Fit | Lead qualification | Preserve enum/value |
| Score | Lead score | Preserve current score as imported snapshot; RedBlack scoring becomes recalculable |
| Temperature | Lead temperature | Preserve imported value; derive from score in RedBlack |
| Status | Lead lifecycle stage/status | Map to configurable pipeline stage/status |
| Nurture Type | Automation/nurture state | Preserve current value; later move to workflow state |
| Last Contacted | Activity/contact metadata | Preserve timestamp; future value derived from activities |
| Next Follow-up | Task/next action | Convert to task due date where applicable |
| Next Action | Task/next action | Convert to task type/action |
| Meeting Date | Meeting/activity | Convert to meeting record |
| Meeting Status | Meeting | Convert to meeting status |
| Last Outcome | Activity outcome/disposition | Convert to activity/call outcome |
| Notes | Notes/activity notes | Preserve as CRM note/history where possible |
| WhatsApp Status | Communication contact/channel state | Preserve as channel status |
| Send WhatsApp | Communication action flag | Migration only; production uses explicit communication jobs/actions |
| DND | Consent/suppression | Preserve as contact/lead communication suppression |
| Touch # | Journey/sequence position | Preserve as migration state; automation owns future sequence state |
| Last Message Sent | Communication activity | Preserve timestamp; future value derived from messages |
| Owner | User/assignment | Resolve to RedBlack user/agent |
| Budget Score | Qualification score component | Preserve imported value; recalculate from normalized budget |
| Calendar Event ID | External meeting reference | Preserve provider event ID as adapter metadata |
| Brand / Project Name | Opportunity/project context | Preserve as structured field; do not drop |
| Opportunity Type | Opportunity/business context | Preserve as structured field |

## 4. CRM entities required by the migration

### Tenant / workspace

- `tenants`
- `workspaces`
- `users`
- `memberships`
- `roles` / permission model

### CRM

- `organizations`
- `contacts`
- `leads`
- `opportunities`
- `pipelines`
- `pipeline_stages`
- `lead_tags`
- `custom_fields`
- `custom_field_values`
- `activities`
- `notes`
- `tasks`
- `meetings`
- `lead_assignments`
- `lead_sources`
- `import_batches`
- `external_id_mappings`

### Communication

- `communication_threads`
- `messages`
- `message_events`
- `channel_accounts`
- `provider_references`
- `consents` / suppression records

### Automation

- `workflows`
- `workflow_versions`
- `workflow_runs`
- `workflow_steps`
- `workflow_step_runs`
- `automation_events`

### Usage / billing

- `usage_events`
- `usage_aggregates`
- `billing_accounts`
- `billing_plans`
- `invoices`
- `invoice_lines`
- `billing_adjustments`

## 5. Existing pipeline/status logic

The current CRM has statuses including:

`NEW`, `CONTACTED`, `HOT`, `WARM`, `NO RESPONSE`, `NO BUDGET`, `PLAN DROPPED`, `INVESTED ELSEWHERE`, `CALL LATER`, `FUTURE EVENT`, `MEETING`, `POST-MEETING`, `COLD`, `NOT INTERESTED`, `WON`, `LOST`, `DND`.

The Apps Script treats `NOT INTERESTED`, `DND`, `WON`, and `LOST` as terminal statuses. It also has explicit meeting/post-meeting behavior and a cold-lead reactivation path. These behaviors must become configurable workflow/stage rules rather than hard-coded sheet-row behavior.

RedBlack Core will initially support three business pipelines:

### Franchise

`New Lead → Contact Attempted → Connected → Qualified → Meeting / Presentation → Proposal → Negotiation → Won / Lost`

### Realty

`New Lead → Contact Attempted → Connected → Qualified → Meeting / Presentation → Proposal → Negotiation → Won / Lost`

### RedBlack Tech

`New Lead → Contact Attempted → Connected → Qualified → Meeting / Presentation → Proposal → Negotiation → Won / Lost`

The imported legacy status must remain available during migration so no source state is lost. A mapping table will translate legacy status to the selected RedBlack pipeline/stage.

## 6. Existing scoring logic

The current script calculates lead score from:

- Intent
- Timeline
- Budget
- Decision-maker status
- Fit

Budget scoring currently uses:

- below ₹25L = 0
- ₹25L–₹49.99L = 1
- ₹50L+ = 2

Intent, timeline, decision-maker and fit each contribute bounded score components. Temperature is derived from total score.

RedBlack Core should preserve this as **Scoring Model v1 — Legacy CRM**, implemented as configuration/rules rather than embedded spreadsheet code. This allows future client-specific scoring without rewriting the CRM.

## 7. Existing task/follow-up engine

The current Apps Script uses a `TASKS` table with:

- Task ID
- Lead ID
- Due Date
- Task Type
- Touch #
- Status
- Completed At
- Notes
- Priority

Task types include `CALL`, `WHATSAPP`, `MEETING`, `EMAIL`, and `OTHER`.

The current engine intentionally prevents more than one pending task per lead. Status changes cancel the old pending journey and create the next task. Manual changes to next follow-up/action can override the automated next task. Task completion updates lead contact/message timestamps and advances the journey.

RedBlack Core should preserve the **one active next-action principle as the default legacy workflow behavior**, but the automation engine must support configurable multi-step workflows later.

## 8. Existing WhatsApp logic

The supplied script contains 12 WhatsApp message codes covering new lead, no response, warm lead, no budget, plan dropped, invested elsewhere, meeting confirmation/reminder, post-meeting, and reactivation.

Important source constraint: the current Apps Script explicitly states that WhatsApp is **manual** and the CRM does not auto-send messages. RedBlack Core must preserve this behavior during migration unless a later approved automation workflow explicitly enables outbound sending through the communication adapter with appropriate consent and audit controls.

## 9. Existing meeting/calendar logic

The CRM uses Google Calendar for actual appointments. A booked meeting can create a calendar event, while meeting completion moves the lead into post-meeting handling and creates a follow-up journey.

RedBlack Core should model meetings internally and store external calendar/provider IDs as adapter metadata. Calendar synchronization belongs to an integration adapter, not to the CRM database itself.

## 10. Existing dashboard/reporting logic

The current dashboard includes:

- Total Leads
- HOT
- WARM
- COLD
- NO RESPONSE
- NO BUDGET
- MEETING
- POST-MEETING
- WON
- LOST
- DND
- Today Pending Tasks
- Win Rate

RedBlack Core reporting must expand this into the planned reporting model:

- Calls
- Connected calls
- Talk time
- Follow-ups
- Meetings
- Presentations
- Proposals
- Closures
- Conversion %
- Revenue
- Agent performance
- Source performance

Legacy dashboard metrics should remain available as the first reporting view.

## 11. Agent/user expansion

The current workbook has an `Owner` field but does not represent a complete multi-user agent system. RedBlack Core must therefore introduce:

- User accounts
- Tenant/workspace memberships
- Roles
- Lead ownership
- Assignment history
- Distribution rules
- Agent performance metrics

No assumption is made that current Owner values are complete user identities; migration must resolve them against an explicit RedBlack user mapping.

## 12. Calling expansion

The current CRM models call work primarily through task type and last outcome. It does not provide the full calling system required for RedBlack Core.

Add first-class models for:

- Business number / channel account
- Call session
- Direction
- Started/answered/ended timestamps
- Duration
- Answered/missed/busy/failed status
- Recording reference
- Call notes
- Disposition
- Agent
- Lead/contact
- Follow-up created from call
- Provider call ID
- PAYG usage event

The actual telephony provider remains an adapter decision and is not part of this migration mapping.

## 13. Duplicate detection

The current source does not establish a dedicated duplicate-resolution entity. RedBlack Core must add a deterministic duplicate detection layer using normalized contact identifiers and tenant scope, with a review/merge process rather than destructive automatic deletion.

## 14. Migration strategy

1. Freeze the source workbook as a read-only migration snapshot.
2. Capture source columns, validation lists, status values, WhatsApp scripts, scoring rules, and representative workflows.
3. Import source records with an `import_batch_id`.
4. Preserve every original source ID in `external_id_mappings`.
5. Normalize contacts and organizations without destroying raw source values.
6. Map Owner values to RedBlack users where possible.
7. Map legacy statuses into the appropriate Franchise/Realty/Tech pipeline.
8. Convert pending tasks into RedBlack tasks.
9. Convert meeting/calendar references into RedBlack meeting records plus provider metadata.
10. Preserve historical message/task/outcome timestamps as activity history.
11. Recalculate scores using the legacy scoring model and compare against imported snapshots.
12. Reconcile record counts, task counts, pipeline distributions, and representative lead journeys.
13. Run migration in staging first.
14. Only after reconciliation, perform production cutover.

## 15. Explicit gaps to address in RedBlack Core

The source CRM does **not** by itself provide all requested RedBlack Core capabilities. These must be newly implemented:

- Multi-tenant architecture
- Workspaces
- User authentication and roles
- Configurable pipelines
- Agent distribution
- Full call logging/telephony integration
- Call recordings
- Call duration and provider outcomes
- Communication provider adapters
- RCS and email provider adapters
- AI gateway
- Workflow engine
- Usage/PAYG metering
- Cost calculator
- Client billing
- Revenue attribution
- Source/agent reporting
- Audit/event history
- API/webhooks
- Security/tenant isolation

## 16. Current architectural rule

**Do not build a Google Sheets replacement that merely looks like the current workbook.**

Build RedBlack Core as a proper multi-tenant application and use the workbook as a validated migration/reference dataset.

The existing business rules are valuable; the spreadsheet implementation is not the target architecture.

## 17. Approval gate

This mapping is the implementation baseline for the next CRM build step. Before database migrations or CRM feature code are merged into `main`, review:

- entity model
- legacy status-to-pipeline mapping
- scoring model
- one-next-task legacy behavior
- owner-to-user mapping strategy
- migration handling for the workbook's 32-column `LEADS` structure
- calling model
- communication adapters
- usage/billing model

No production data should be imported until these items are approved.