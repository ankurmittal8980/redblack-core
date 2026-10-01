# RedBlack Core Architecture

RedBlack Core is the internal operating platform behind RedBlack Tech.

```text
RedBlack Tech website
        |
        v
   RedBlack Core
   /     |      \
 CRM  Automation  AI
  |       |       |
  +-------+-------+
          |
   Communication
 Email / WhatsApp / RCS / Voice
          |
        Client
          |
       Billing
```

## Domain boundary
The public website and authenticated CRM application share one domain. Public pages remain unchanged; the application is served under `/app` and API routes under `/api/v1`.

## Core principles
- Multi-tenant by workspace.
- Provider-neutral communication and AI adapters.
- PAYG usage is measured as immutable events.
- Google Sheets is migration input, never runtime storage.
- Automations are asynchronous and idempotent.
- All tenant-scoped access is authorization-checked.
- Secrets never live in Git or ordinary application tables.
