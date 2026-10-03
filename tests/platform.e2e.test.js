import test from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway } from '../backend/src/ai-gateway.js';
import { CommunicationGateway } from '../backend/src/communication-gateway.js';
import { CommunicationRegistry, CallingRegistry } from '../backend/src/providers.js';

test('end-to-end neutral workflow: AI decision -> communication -> voice', async () => {
  const messages = []; const calls = [];
  const db = { async query(sql, values) {
    if (sql.startsWith('SELECT do_not_contact')) return { rows: [{ do_not_contact: false, consent: true }] };
    if (sql.startsWith('SELECT * FROM messages')) return { rows: messages.filter(row => row.workspace_id === values[0] && row.idempotency_key === values[1]) };
    if (sql.startsWith('INSERT INTO messages')) { const row = { id: 'message-1', workspace_id: values[0], idempotency_key: values[6], status: 'sent' }; messages.push(row); return { rows: [row] }; }
    if (sql.startsWith('INSERT INTO calls')) { const row = { id: 'call-1', workspace_id: values[0], idempotency_key: values[7], status: 'queued' }; calls.push(row); return { rows: [row] }; }
    if (sql.startsWith('INSERT INTO usage_events')) return { rows: [] };
    if (sql.includes('FROM calls')) return { rows: calls.filter(row => row.idempotency_key === values[1]) };
    throw new Error(sql);
  } };
  const ai = new AIGateway({ routes: { w1: { standard: ['openai:test'] } }, adapters: { openai: { complete: async () => ({ provider: 'openai', model: 'test', text: 'approved', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) } } });
  const decision = await ai.complete({ workspaceId: 'w1', messages: [{ role: 'user', content: 'qualify lead' }], toolCalls: false });
  assert.equal(decision.text, 'approved');
  const communications = new CommunicationRegistry({ mock: { send: async () => ({ providerMessageId: 'msg-1' }) } });
  const calling = new CallingRegistry({ mock: { startCall: async () => ({ providerCallId: 'call-1' }) } });
  const gateway = new CommunicationGateway({ db, registry: communications, callingRegistry: calling });
  const sent = await gateway.send({ workspaceId: 'w1', leadId: 'lead-1', channel: 'email', provider: 'mock', body: decision.text, idempotencyKey: 'workflow-message-1' });
  const call = await gateway.startCall({ workspaceId: 'w1', leadId: 'lead-1', provider: 'mock', direction: 'outbound', to: '+1000', idempotencyKey: 'workflow-call-1' });
  assert.equal(sent.message.status, 'sent'); assert.equal(call.call.status, 'queued');
});
