# RedBlack Core

RedBlack Core is the workspace-scoped CRM and operations platform for Red Black Tech. It serves the CRM UI at `/app/` and the versioned API at `/api/v1/` under the same domain as the public site.

## Included capabilities

- Secure first-owner setup, password login, workspace membership, RBAC, CSRF protection, and audit records.
- Leads, pipelines, stage history, assignments, tasks, activities, meetings, calls, and workspace reports.
- Provider-neutral email, WhatsApp, RCS, and voice boundaries. No provider account, subscription, or Convo360 integration is included.
- Immutable automation versions with replay-safe runs and a separate worker.
- Versioned PAYG rate cards, fixed-point estimates, and append-only usage records.
- Preview-first Google Sheet CSV migration that preserves the approved source mapping and supports idempotent replay.

## Local setup

Copy `.env.example` to a local environment file. Then run the migration and stack:

```text
docker compose --profile tools run --rm migrate
docker compose up --build
```

Open `http://localhost:8080/app/`. The first owner setup requires the local `BOOTSTRAP_TOKEN`. Rotate it after setup.

For a non-container workflow, use `pnpm install`, `pnpm migrate`, `pnpm start`, and `pnpm worker` with PostgreSQL 17 available through `DATABASE_URL`.

## Validation

```text
pnpm run check
```

The test suite covers application helpers locally and applies both migrations against PostgreSQL 17 in CI. The runtime OpenAPI document is available at `/api/v1/openapi.json`.

## Documentation

- [Architecture](docs/architecture.md)
- [API contract](docs/api-v1-contract.md)
- [Sheet migration](docs/google-sheet-migration.md)
- [Security model](docs/security.md)
- [Deployment environments](docs/deployment.md)
- [Implementation status](docs/implementation-status.md)


