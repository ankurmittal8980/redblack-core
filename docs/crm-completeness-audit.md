# CRM compatibility and completeness audit

RedBlack Core keeps PostgreSQL as the system of record. The prior Apps Script CRM behavior was reviewed as a behavioral reference.

Preserved behavior:
- lead statuses including New Lead, Contact Attempted, Connected, Qualified, Meeting / Presentation, Proposal, Negotiation, Won and Lost
- follow-up date and next-action fields
- owner assignment, score, temperature, budget, requirement, consent and DND fields
- one idempotent first follow-up task from lead creation
- duplicate lead detection by normalized email or phone
- pipeline stage history and stage-change automation
- task completion and activity/timeline history
- calendar/meeting identifiers and native appointment hooks
- WhatsApp/email/call records through provider-neutral gateways

Intentionally changed:
- Google Sheets and Apps Script are import/reference behavior only; PostgreSQL is authoritative.
- outbound communication requires a configured provider and consent/DNC checks.
- destructive lead deletion is soft deletion by default; permanent deletion remains restricted to an explicit administrative policy.
- automation execution is versioned and idempotent, so retries cannot create duplicate follow-up tasks.

Current CRM configuration surfaces include workspace-scoped pipelines/stages, automation definitions, workspace settings, custom field tables, tags, reports, and RBAC-protected APIs. The lead Trash view and restore flow are available from the CRM navigation.
