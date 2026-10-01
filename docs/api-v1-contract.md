# RedBlack Core API v1

Base path: `/api/v1`. The executable OpenAPI 3.1 document is served at `/api/v1/openapi.json` and is the current endpoint contract.

## Authentication and workspace selection

- `POST /auth/bootstrap` creates the first owner and workspace. It needs the one-time `X-Bootstrap-Token`.
- `POST /auth/login`, `POST /auth/select-workspace`, `POST /auth/logout`, and `GET /auth/me` manage the browser session.
- Authenticated write routes require the session cookie and matching `X-CSRF-Token` header.

All workspace routes start with `/workspaces/{workspaceId}`. The active membership must match the path workspace. Roles are checked per route and agent queries are limited to actively assigned leads.

## Resources

| Area | Main routes |
| --- | --- |
| CRM | `leads`, `leads/{leadId}/timeline`, `leads/{leadId}/stage`, `pipelines`, `tasks`, `activities`, `meetings` |
| Communications | `communications/providers`, `messages`, `messages/send`, `communications/consent`, `calls`, `calls/start` |
| Automation | `automations`, `automations/{automationId}`, `automations/{automationId}/runs` |
| PAYG and reporting | `usage`, `usage/estimate`, `usage/rates`, `billing/invoices`, `reports/dashboard`, `reports/sales`, `reports/agents`, `reports/sources`, `audit` |

Provider webhooks are `POST /webhooks/{provider}/calls` and `POST /webhooks/{provider}/messages`. They require a timestamped HMAC signature and are replay-safe.

Provider-backed sends and calls need a configured adapter, recorded consent, an idempotency key, and a published Core rate. Message drafts and manual call logs do not require a provider adapter.


