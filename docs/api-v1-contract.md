# RedBlack Core API v1 — Initial Contract

Base path: `/api/v1`

## Authentication
All authenticated endpoints require a valid session/access token. Authorization is evaluated against the active workspace membership.

## Workspace
- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/{workspaceId}`
- `PATCH /workspaces/{workspaceId}`
- `GET /workspaces/{workspaceId}/members`
- `POST /workspaces/{workspaceId}/members`

## Leads
- `GET /workspaces/{workspaceId}/leads`
- `POST /workspaces/{workspaceId}/leads`
- `GET /workspaces/{workspaceId}/leads/{leadId}`
- `PATCH /workspaces/{workspaceId}/leads/{leadId}`
- `DELETE /workspaces/{workspaceId}/leads/{leadId}` — soft delete
- `POST /workspaces/{workspaceId}/leads/{leadId}/assign`
- `GET /workspaces/{workspaceId}/leads/{leadId}/timeline`

Lead create/update accepts normalized contact fields, source, project/opportunity data, budget/location/requirement, score/temperature, tags and custom fields. Duplicate checks use normalized email/phone before creation.

## Pipelines
- `GET /workspaces/{workspaceId}/pipelines`
- `POST /workspaces/{workspaceId}/pipelines`
- `GET /workspaces/{workspaceId}/pipelines/{pipelineId}`
- `PATCH /workspaces/{workspaceId}/pipelines/{pipelineId}`
- `POST /workspaces/{workspaceId}/pipelines/{pipelineId}/stages`
- `PATCH /workspaces/{workspaceId}/pipelines/{pipelineId}/stages/{stageId}`
- `POST /workspaces/{workspaceId}/leads/{leadId}/pipeline-entry`
- `POST /workspaces/{workspaceId}/leads/{leadId}/stage`

Stage changes must write both current state and immutable stage history.

## Tasks and activities
- `GET /workspaces/{workspaceId}/tasks`
- `POST /workspaces/{workspaceId}/tasks`
- `PATCH /workspaces/{workspaceId}/tasks/{taskId}`
- `GET /workspaces/{workspaceId}/activities`
- `POST /workspaces/{workspaceId}/activities`

## Calls and meetings
- `GET /workspaces/{workspaceId}/calls`
- `POST /workspaces/{workspaceId}/calls`
- `POST /workspaces/{workspaceId}/calls/{callId}/notes`
- `GET /workspaces/{workspaceId}/meetings`
- `POST /workspaces/{workspaceId}/meetings`
- `PATCH /workspaces/{workspaceId}/meetings/{meetingId}`

Provider webhooks use dedicated `/api/v1/webhooks/{provider}/{event}` adapter routes and translate external payloads into normalized call/message/usage events.

## Communications
- `GET /workspaces/{workspaceId}/messages`
- `POST /workspaces/{workspaceId}/messages`
- `POST /workspaces/{workspaceId}/messages/send`

The API accepts channel + provider adapter selection but does not expose provider-specific business objects to CRM consumers.

## Automation
- `GET /workspaces/{workspaceId}/automations`
- `POST /workspaces/{workspaceId}/automations`
- `PATCH /workspaces/{workspaceId}/automations/{automationId}`
- `POST /workspaces/{workspaceId}/automations/{automationId}/test`
- `GET /workspaces/{workspaceId}/automations/{automationId}/runs`

Automation execution is asynchronous and idempotent.

## Usage and reporting
- `GET /workspaces/{workspaceId}/usage`
- `GET /workspaces/{workspaceId}/usage/estimate`
- `GET /workspaces/{workspaceId}/reports/sales`
- `GET /workspaces/{workspaceId}/reports/agents`
- `GET /workspaces/{workspaceId}/reports/sources`

Usage estimates are informational until provider cost data is confirmed. Customer charges are derived from immutable usage events and pricing rules, not from hard-coded provider assumptions.

## API rules
- All workspace IDs are authorization-scoped; never trust a client-supplied workspace ID without membership validation.
- Mutating endpoints accept an idempotency key where an operation can create external side effects.
- Pagination is cursor-based for high-volume lists.
- Timestamps are ISO-8601 UTC.
- Errors use a stable machine-readable code plus human-readable message.
- Secrets are never accepted as ordinary CRM fields or returned in responses.
