# Security model

## Access and tenancy

Browser sessions use random opaque tokens. Only SHA-256 token hashes are stored. Session cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production; mutating requests also require the matching CSRF value and same-origin check.

Each request carries one active workspace. API queries scope records by workspace, and the database adds composite foreign keys so a lead, stage, task, message, call, automation run, invoice item, or provider record cannot be connected to another workspace. Agent access is further limited to active lead assignments.

Roles are owner, admin, manager, agent, reporting, and service. Permissions are deny-by-default and checked at the API boundary.

## Data integrity and operations

- Passwords use scrypt with a random salt and timing-safe verification.
- Login and first-owner setup have per-IP and per-email rate limits.
- Webhooks require a timestamped HMAC signature, tolerate a five-minute clock window, and store replay receipts.
- Provider sends, call starts, and automation runs use idempotency keys.
- Usage events, usage adjustments, rate versions, automation versions, and audit logs are append-only. Corrections require compensating rows.
- A rate version must exist before a provider-backed message or call can be initiated.
- Message sends require recorded channel consent and honor a lead's do-not-contact flag.
- The server sets CSP, frame, MIME-sniffing, referrer, and permissions-policy headers, plus HSTS in production.

## Secrets and backups

Keep `DATABASE_URL`, `BOOTSTRAP_TOKEN`, provider credentials, and webhook secrets only in the environment manager. Do not add them to a repository, CSV export, audit entry, or provider configuration reference. Rotate the one-time bootstrap token after first owner setup.

Use encrypted daily PostgreSQL backups, retain a verified restore point before every production migration or sheet cutover, and rehearse restore into an isolated staging database. The deployment checklist requires `GET /health/ready`, migration success, and an authenticated `/app/` smoke test before traffic is switched.


