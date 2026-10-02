# Google Sheet migration

RedBlack Core is the production system of record. The legacy workbook is imported once and remains a read-only reference after reconciliation.

## Source files

Export the tabs as UTF-8 CSV files in one folder:

- `LEADS.csv` — required
- `TASKS.csv` — required
- `CALENDAR.csv` — optional

The importer requires the legacy `LEADS` headers `Lead ID`, `Name`, `Phone`, `Investor Email`, `Lead Source`, and `Status`; all known workbook columns are retained in `leads.migration_payload`. Missing optional values remain null rather than being invented.

## Deterministic status mapping

| Legacy status | Core stage |
| --- | --- |
| New / New Lead | New Lead |
| Contacted / No Response / Call Later | Contact Attempted |
| Hot / Warm / Cold / Future Event | Qualified |
| Meeting | Meeting / Presentation |
| Post-Meeting | Proposal |
| Won | Won |
| No Budget / Plan Dropped / Invested Elsewhere / Not Interested / DND / Lost | Lost |
| Unknown value | New Lead, with original status preserved |

Pipeline selection is deterministic: property-related data goes to Realty; digital, website, marketing, automation, and RedBlack Tech data goes to RedBlack Tech; all other rows go to Franchise. The source project, opportunity type, original status, DND flag, source IDs, calendar ID, notes, and scoring columns stay in the imported record.

## Safe import sequence

1. Provision an empty staging database and run `pnpm migrate`.
2. Create the target workspace once, sign in, and record its UUID as `REDBLACK_WORKSPACE_ID`.
3. Run a preview first: `pnpm import:sheet -- <csv-folder>`.
4. Reconcile source counts, rejected rows, duplicate warnings, status counts, meetings, and tasks against the export.
5. Apply the identical files to staging: `pnpm import:sheet -- <csv-folder> --apply`.
6. Replay the same command to confirm idempotency, then reconcile again.
7. Take a production backup, enable the short cutover window, and run `pnpm import:sheet -- <csv-folder> --apply --confirm-production-cutover` with `APP_ENV=production`.
8. Keep the workbook read-only after cutover. Use `import_batches`, `import_row_errors`, and `external_id_mappings` for audit and retry investigation.

The importer records each source fingerprint and stable source ID. A replay updates the same lead, task, meeting, activity, and external-ID mapping instead of creating duplicates. A source row with a malformed email or phone is retained with its raw value and a normalization warning; it is not silently discarded.


