import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationGateway } from '../backend/src/communication-gateway.js';
import { CallingRegistry } from '../backend/src/providers.js';

test('voice gateway enforces DNC, idempotency and replaceable call adapter', async () => {
  const calls = []; const db = { async query(sql, values) {
    if (sql.startsWith('SELECT do_not_contact')) return { rows: [{ do_not_contact: false, consent: true }] };
    if (sql.startsWith('SELECT * FROM calls')) return { rows: calls.filter(c => c.idempotency_key === values[1]) };
    if (sql.startsWith('INSERT INTO calls')) { const row = { id: 'call-1', workspace_id: values[0], idempotency_key: values[7], status: 'queued' }; calls.push(row); return { rows: [row] }; }
    if (sql.startsWith('INSERT INTO usage_events')) return { rows: [] };
    throw new Error(sql);
  } };
  const registry = new CallingRegistry({ test: { startCall: async () => ({ providerCallId: 'provider-call-1' }) } });
  const gateway = new CommunicationGateway({ db, callingRegistry: registry });
  const first = await gateway.startCall({ workspaceId: 'w1', leadId: 'l1', provider: 'test', direction: 'outbound', to: '+1000', idempotencyKey: 'call-key' });
  const second = await gateway.startCall({ workspaceId: 'w1', leadId: 'l1', provider: 'test', direction: 'outbound', to: '+1000', idempotencyKey: 'call-key' });
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  await assert.rejects(() => gateway.startCall({ workspaceId: 'w1', leadId: 'l1', provider: 'missing', direction: 'outbound', to: '+1000' }), /provider adapter/);
});