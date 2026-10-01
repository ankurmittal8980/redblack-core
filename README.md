# RedBlack Core

RedBlack Core is the central platform for Red Black Tech's CRM, automation, AI, communications, and billing capabilities.

## Architecture

The platform's system boundaries and initial decisions are documented in [docs/architecture.md](docs/architecture.md).

The RedBlack Database is the source of truth. Google Sheets and Apps Script remain migration references for importing existing data and preserving established logic; they are not the CRM.

## Repository layout

- `docs/` — architecture and product/engineering documentation
- `backend/` — API and application services
- `frontend/` — user-facing applications
- `database/` — schema, migrations, and seed data
- `integrations/` — external system connectors and provider adapters
- `automation/` — workflow definitions and execution engine
- `ai/` — AI gateway and policy boundary
- `billing/` — usage, plans, invoices, and billing logic
- `tests/` — automated test suites

Empty directories use `.gitkeep` files until implementation files are added.

## Provider strategy

The first architecture defines RedBlack adapters for Email, WhatsApp, RCS, Voice, and AI. Concrete providers are intentionally left open.

## Configuration

Copy `.env.example` to a local environment file and fill in values for the selected development setup. Never commit secrets.

## Status

Architecture baseline only. Implementation frameworks, hosting platforms, and external providers remain to be selected in later tasks.
