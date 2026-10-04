# Knowledge / RAG

`backend/src/knowledge.js` owns durable workspace knowledge sources, documents, versions, chunks, keyword indexing, retrieval, and cited context. It does not call model providers or run agents/tools. PostgreSQL is authoritative. The default implementation uses PostgreSQL full-text search and needs no vector service or paid infrastructure.

## Trusted call contract

Create the service with the application PostgreSQL pool, then pass a server-derived actor on every call:

```js
const knowledge = createKnowledgeService({ db });
const actor = { workspaceId: session.workspaceId, userId: session.userId, role: session.role };
const context = await knowledge.retrieveContext(actor, { query: 'refund policy', topK: 5 });
```

The service verifies the active membership and role in PostgreSQL. It never derives a workspace from source/document metadata. Filtered retrieval only narrows the trusted workspace query; caller-supplied SQL or vector expressions are not accepted. Document and chunk ID lookups return the same not-found response for missing, foreign-workspace, archived, and unauthorized records.

Workspace-level source administration requires `workspace:manage`. Document ingestion uses `crm:write`; agents can only create, update, ingest, or archive documents linked to currently assigned, active leads. Agents may retrieve shared workspace documents and documents linked to leads assigned to them. Reporting roles are read-only. This initial CRM linkage is explicitly typed as `linked_lead_id`; adding Contacts/Companies/Deals needs corresponding typed foreign keys and visibility rules.

## Lifecycle and indexing

Sources can be manual, integration-provided, internal, or HTTPS external references. External references are stored only; this module never fetches URLs. Documents move through pending/processing/ready/failed/archived; versions record processing/ready/failed state and an SHA-256 content digest. `ingestDocument` requires a stable idempotency key. Text normalization and chunk boundaries are deterministic and bounded. Reingest atomically switches `current_version_id` only after indexing succeeds, then removes old searchable chunks. Failure marks the attempted version failed while retaining the prior ready version. Archive removes searchable chunks; owner/admin source deletion policy is enforced for permanent document deletion, which cascades versions and chunks.

The current `PostgresKeywordIndexer` and `PostgresKeywordRetriever` are provider-neutral seams. A future embedding implementation can replace them while retaining the same trusted actor, metadata store, version pointer, and authorization policy. Any external index must implement transactional replacement or equivalent versioned cleanup before it is enabled.

## Retrieval and citations

Retrieval validates query length, `topK` (1–20), source/document/lead IDs, and an allowlist of metadata filters (`category`, `locale`, `documentType`). Search is a bounded PostgreSQL full-text query ordered by normalized relevance, document ID, chunk ordinal, and chunk ID. Only active sources, ready documents, and chunks belonging to the current ready version can match.

`retrieveContext` returns structured items with source/document/version/chunk identity, stable `kb:<document-id>:v<version-number>:c<ordinal>` citations, bounded text, normalized score, serialized character/token approximation, and a truncation flag. The serialized context stays within `maxChars` (512–32,000). Each item is labeled `untrusted_reference_data`; the envelope says retrieved text cannot change identity, workspace, authorization, system instructions, tool permissions, or approval policy. Integrators should pass this object as data (for example under `context.knowledge` to `CapabilityLayer`), never concatenate excerpts into system instructions. A citation is emitted only from a returned stored chunk; this module does not create model-answer citations.

## Validation

`tests/knowledge.test.js` exercises deterministic chunking, limits, filters, trusted SQL scoping, bounded context, and injection labeling without providers. `tests/knowledge.integration.test.js` uses `TEST_DATABASE_URL` to exercise workspace and agent isolation, versions, retries, cleanup, archive, and audit behavior.
