ALTER TYPE communication_channel ADD VALUE IF NOT EXISTS 'sms';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS messages_workspace_idempotency_key
  ON messages(workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_workspace_provider_message
  ON messages(workspace_id, provider_message_id) WHERE provider_message_id IS NOT NULL;