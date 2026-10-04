# Operational CRM completion

The vanilla SPA exposes Contacts, Companies, Deals, Tickets, Global Search and Notifications. Lists include search, paging and archive filters; records have create/edit/detail/history/note/archive/restore flows. Deals retain the `opportunities` table and proposal foreign keys. The deal board offers stage movement without requiring drag gestures on mobile. Pipeline/stage choices are validated together; Won/Lost stages set deal status.

## Upgrade

Run the normal `pnpm migrate` before starting the new server. Forward migration `0013_crm_operational_completion.sql` follows unchanged `0012`. It adds composite tenant relationship constraints, opportunity stage, conversion registry, immutable record history, internal per-user message read state, and notification hooks. It does not reset data. Existing invalid cross-workspace relationships cause a constraint failure and must be investigated rather than silently rewriting customer data.

## Conversion

`POST /api/v1/workspaces/:workspaceId/leads/:leadId/convert` accepts deal `title`, `value`, `pipelineId`, `stageId`, `expectedCloseDate`, optional `companyId`/`companyName` and optional `contactId`. Locks the lead, creates or reuses visible records, stores the unique conversion, appends lead activity and audit in one transaction. Concurrent/repeated requests return the same relationship IDs; subsequent retry payloads do not edit converted records. Original lead, tasks and timeline remain intact. Rollback leaves no partial records, notifications or audit entries. Edit converted records using their own APIs.

## Permissions

Owner/Admin/Manager manage all workspace records. Agents manage only records they own (tickets: assigned to them); conversion and inbox require a current active lead assignment. Related record pickers include only permitted records. Relationship writes require active workspace member owners and same-workspace visible records. Agents cannot assign other users or relinquish ownership. Reporting can read CRM and reports; Service can read these new CRM modules but cannot mutate them. Existing service automation/provider permissions remain intact.

## Notifications, reports and inbox

Database hooks create internal notifications transactionally on lead assignment, task creation/assignment/status/due changes, and deal/ticket assignment/status/stage changes. Recipients must be active workspace members. Notification reads and read mutations require the current recipient. No external delivery is implied.

`GET reports/crm?from=ISO&to=ISO` returns deal funnel totals separated by currency, conversions occurring in the period, leads created in the period, task/activity and ticket metrics. Conversion counts are period counts, not a cohort conversion percentage. SQL identifiers and groupings are fixed server-side; reports permission is mandatory.

Inbox threads group by workspace/lead/channel, retain provider status, expose lead context and per-user internal unread state. Internal read state never claims provider delivery/read acknowledgement. Drafts do not send. External sending still requires supported configured adapters, channel consent and DNC checks through the existing communication API. No provider integration is invented.

List/picker pages use at most 100 records; next-page controls are available in module lists. Existing record detail displays stored relationship IDs as well as history; picker choices are permission scoped.
