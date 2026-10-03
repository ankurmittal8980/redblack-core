import test from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, usageSummary } from '../backend/src/usage-engine.js';

test('usage engine applies configured rate and idempotency', async () => {
  const events = [];
  const db = { async query(sql, values) {
    if (sql.includes('FROM provider_rates')) return { rows: [{ id: 'rate-1', provider: 'test', currency: 'INR', provider_cost_per_unit: '2', customer_charge_per_unit: '3' }] };
    if (sql.startsWith('INSERT INTO usage_events')) { if (events.length) return { rows: [] }; const row = { id: 'u1', workspace_id: values[0], provider_cost: '2', internal_charge: '3', idempotency_key: values[10] }; events.push(row); return { rows: [row] }; }
    if (sql.startsWith('SELECT * FROM usage_events')) return { rows: events };
    throw new Error(sql);
  } };
  const first = await recordUsage(db, { workspaceId: 'w1', provider: 'test', service: 'voice', usageType: 'call', quantity: '1', unit: 'call', idempotencyKey: 'usage-1' });
  const second = await recordUsage(db, { workspaceId: 'w1', provider: 'test', service: 'voice', usageType: 'call', quantity: '1', unit: 'call', idempotencyKey: 'usage-1' });
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true); assert.equal(first.quote.customerCharge, '3');
});
