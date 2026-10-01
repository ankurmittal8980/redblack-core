# Deployment environments

RedBlack Core keeps the public site, CRM UI, and API on one domain:

| Path | Destination |
| --- | --- |
| `/` | Existing public RedBlack site |
| `/app/` | RedBlack Core UI |
| `/api/v1/` | RedBlack Core API |
| `/health/` | Core health endpoints |

`deploy/nginx.conf.template` provides this routing. Set `PUBLIC_SITE_UPSTREAM` to the existing site service; it does not move or replace the main site.

## Environments

Use separate database instances and separate secrets for development, staging, and production. Start from `.env.example`, `deploy/staging.env.example`, and `deploy/production.env.example`; replace every placeholder through the deployment platform's secret manager.

For a local stack:

```text
docker compose --profile tools run --rm migrate
docker compose up --build
```

For staging and production, run the database migration as a one-off release step before starting the web and worker processes. Confirm `/health/ready`, then open `/app/` through the intended TLS domain. Production requires an HTTPS `APP_BASE_URL` and a PostgreSQL URL.

## Release and rollback

1. Build the commit selected by the protected-branch PR review.
2. Run CI, including PostgreSQL migration checks and security dependency audit.
3. Back up the target database and record the restore point.
4. Deploy the migration, web process, worker process, and edge route.
5. Verify health, owner sign-in, workspace isolation, and a dry-run sheet import in staging.
6. If application deployment fails, restore the previous web and worker images. Database migrations are forward-only; use a tested compensating migration or the recorded restore point for database rollback.

No live deployment was performed by this change because production domain, infrastructure, and secret-manager access are not present in the connected repository.


