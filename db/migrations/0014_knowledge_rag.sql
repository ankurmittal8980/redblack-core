-- Durable, workspace-scoped knowledge metadata and PostgreSQL full-text index.
-- The database remains authoritative; provider-specific embeddings can be added
-- behind the application indexer seam without changing document ownership.

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  source_type text NOT NULL CHECK (source_type IN ('manual', 'integration', 'internal', 'external_reference')),
  source_uri text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CHECK (source_type <> 'external_reference' OR source_uri IS NOT NULL),
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE UNIQUE INDEX knowledge_sources_workspace_name_idx
  ON knowledge_sources(workspace_id, lower(name)) WHERE status <> 'archived';

CREATE TABLE knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  linked_lead_id uuid,
  external_key text,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'archived')),
  current_version_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES knowledge_sources(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, linked_lead_id) REFERENCES leads(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (created_by)
);
CREATE UNIQUE INDEX knowledge_documents_external_key_idx
  ON knowledge_documents(workspace_id, source_id, external_key) WHERE external_key IS NOT NULL AND status <> 'archived';

CREATE TABLE knowledge_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
  normalized_text text NOT NULL,
  content_sha256 char(64) NOT NULL,
  idempotency_key text NOT NULL,
  error_summary text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, document_id, version_number),
  UNIQUE (workspace_id, document_id, id),
  UNIQUE (workspace_id, document_id, idempotency_key),
  CHECK (length(normalized_text) <= 1000000),
  CHECK (length(idempotency_key) BETWEEN 8 AND 120),
  FOREIGN KEY (workspace_id, document_id) REFERENCES knowledge_documents(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, created_by) REFERENCES workspace_members(workspace_id, user_id) ON DELETE SET NULL (created_by)
);
ALTER TABLE knowledge_documents ADD CONSTRAINT knowledge_documents_current_version_fk
  FOREIGN KEY (workspace_id, id, current_version_id)
  REFERENCES knowledge_document_versions(workspace_id, document_id, id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  char_start integer NOT NULL CHECK (char_start >= 0),
  char_end integer NOT NULL CHECK (char_end >= char_start),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  search_vector tsvector NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, version_id, ordinal),
  FOREIGN KEY (workspace_id, document_id, version_id)
    REFERENCES knowledge_document_versions(workspace_id, document_id, id) ON DELETE CASCADE
);

CREATE INDEX knowledge_sources_workspace_status_idx ON knowledge_sources(workspace_id, status);
CREATE INDEX knowledge_documents_workspace_status_idx ON knowledge_documents(workspace_id, status, updated_at DESC);
CREATE INDEX knowledge_documents_workspace_lead_idx ON knowledge_documents(workspace_id, linked_lead_id) WHERE linked_lead_id IS NOT NULL;
CREATE INDEX knowledge_versions_workspace_document_idx ON knowledge_document_versions(workspace_id, document_id, version_number DESC);
CREATE INDEX knowledge_chunks_workspace_document_idx ON knowledge_chunks(workspace_id, document_id, version_id, ordinal);
CREATE INDEX knowledge_chunks_search_idx ON knowledge_chunks USING gin(search_vector);
