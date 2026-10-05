import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionAgentRuntime } from '../backend/src/agent/runtime.js';

test('production agent runtime resolves authoritative membership role and exposes real tools', async () => {
  const db = { query: async (sql) => sql.includes('workspace_members') ? { rows: [{ user_id: '11111111-1111-4111-8111-111111111111', workspace_id: '22222222-2222-4222-8222-222222222222', role: 'manager' }] } : { rows: [] } };
  const runtime = createProductionAgentRuntime({ db });
  const actor = await runtime.resolveActor('22222222-2222-4222-8222-222222222222', { userId: '11111111-1111-4111-8111-111111111111', role: 'owner' });
  assert.equal(actor.role, 'manager');
  const names = runtime.toolExecutor.listTools().map(tool => tool.name);
  assert.ok(names.includes('crm.leads.search'));
  assert.ok(names.includes('crm.tasks.create'));
  assert.ok(names.includes('knowledge.retrieve'));
});

test('inactive or non-member actors are rejected before agent execution', async () => {
  const runtime = createProductionAgentRuntime({ db: { query: async () => ({ rows: [] }) } });
  await assert.rejects(() => runtime.resolveActor('22222222-2222-4222-8222-222222222222', { userId: '11111111-1111-4111-8111-111111111111' }), error => error.code === 'AGENT_UNAUTHORIZED');
});

