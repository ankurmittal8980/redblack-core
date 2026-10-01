# Website calculator and webinar integration boundary

## Current website behavior

frontend/wordpress/redblack-public-tools/ is a WordPress plugin for the existing RedBlack Tech block-theme site. It adds two shortcode-rendered components without changing the theme or its shared design tokens:

- rbt_payg_calculator estimates a monthly client price from configured usage and rates.
- rbt_webinar_booking collects and validates a registration for a session generated from the configurable weekly schedule.

The public calculator contains no provider price table. Rates are configured by a site administrator. Public visitors receive only the estimated client price. Provider cost, RedBlack actual cost, markup and estimated margin are visible only to authenticated site administrators.

## Usage and billing boundary

Calculator input is an estimate, not a billable event. The website does not send estimates to Core and must never write them into usage_events.

When communications and AI features are implemented, their server-side adapters should emit actual normalized usage events after a metered operation. The existing Core schema defines the ledger as append-oriented and tenant-scoped. A future event can map the calculator's stable category keys as follows:

| Website estimate category | Suggested Core event type | Notes |
| --- | --- | --- |
| email | email.sent | Record actual accepted/sent units according to the chosen adapter contract. |
| whatsapp | whatsapp.message | Provider-specific payload stays adapter metadata. |
| rcs | rcs.message | Use the normalized unit/capability selected by the adapter. |
| voice | voice.duration | Include actual duration and the billing unit. |
| ai_model | ai.model_usage | Record actual input/output usage dimensions if the selected model exposes them. |
| sms | sms.message | Keep destination and provider details behind the adapter boundary. |
| storage | storage.usage | Aggregate actual storage over a documented interval. |

Each actual event must follow the Core contract for event ID, tenant/workspace, quantity/unit, occurrence time, source/correlation ID and deduplication key. Provider-reported cost belongs in provider-cost metadata; provider-specific rate tables do not belong in the calculator's core formula.

## Webinar registration boundary

The WordPress form validates and captures a selected session plus name, email, phone, company, optional website, optional challenge and recorded consent. Before an API is configured, entries are private WordPress records restricted to site administrators. No automatic reminder, attendance tracking or CRM synchronization is claimed by the current website implementation.

The plugin includes an optional server-to-server adapter for the proposed POST /api/v1/webinar-registrations contract. Both REDBLACK_CORE_API_URL and REDBLACK_CORE_API_TOKEN must be supplied by the deployment environment; credentials never enter browser code. A configured Core failure returns an error to the registrant rather than silently storing the entry somewhere else.

Proposed CRM mapping for a future Core implementation:

- Match or create a workspace-scoped contact using normalized email and phone.
- Link or create the related organization from the company and website fields.
- Record the selected session as a webinar registration/activity with the consent timestamp and website source.
- Apply tenant authorization and idempotency on the server. The public website never submits a tenant ID or chooses CRM ownership.
- Emit a domain event for the reminder workflow only after the registration is accepted.
- Record attendance and follow-up as separate lifecycle events; do not infer attendance from registration.

The public website does not connect to Convo360 and requires no subscription-based webinar or CRM service. Core CRM, reminder automation, attendance and follow-up remain future Core work because this repository currently contains architecture and schema documentation, not a running API implementation.

