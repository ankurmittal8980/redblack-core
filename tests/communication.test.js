import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationGateway } from '../backend/src/communication-gateway.js';
import { CommunicationRegistry } from '../backend/src/providers.js';

function dbFor(lead = { do_not_contact: false, consent: true }) {
  const rows = [];
  return { rows, async query(sql, values) {
    if (sql.startsWith('SELECT do_not_contact')) return { rows: lead ? [lead] : [] };
    if (sql.startsWith('SELECT * FROM messages')) return { rows: rows.filter(item => item.workspace_id === values[0] && item.idempotency_key === values[1]) };
    if (sql.startsWith('INSERT INTO messages')) { const message = { id: `m-${rows.length + 1}`, workspace_id: values[0], provider_message_id: values[3], status: 'sent', idempotency_key: values[6] }; rows.push(message); return { rows: [message] }; }
    if (sql.startsWith('INSERT INTO usage_events')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
}

test('communication gateway enforces workspace consent and idempotency', async () => {
  const db = dbFor(); const registry = new CommunicationRegistry({ test: { send: async () => ({ providerMessageId: 'p-1' }) } });
  const gateway = new CommunicationGateway({ db, registry });
  const first = await gateway.send({ workspaceId: 'w1', leadId: 'l1', channel: 'email', provider: 'test', to: 'a@example.com', body: 'Hi', idempotencyKey: 'same-key' });
  const second = await gateway.send({ workspaceId: 'w1', leadId: 'l1', channel: 'email', provider: 'test', to: 'a@example.com', body: 'Hi', idempotencyKey: 'same-key' });
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  await assert.rejects(() => new CommunicationGateway({ db: dbFor({ do_not_contact: true, consent: true }), registry }).send({ workspaceId: 'w1', leadId: 'l1', channel: 'sms', provider: 'test', body: 'Hi' }), /opted out/);
  await assert.rejects(() => gateway.send({ workspaceId: 'w1', leadId: 'l1', channel: 'whatsapp', provider: 'missing', body: 'Hi' }), /provider adapter/);
});