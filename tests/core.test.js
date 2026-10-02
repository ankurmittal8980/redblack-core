import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../backend/src/csv.js';
import { mapLegacyLead, normalizeLegacyStatus, parseLegacyBudget, parseLegacyDate } from '../backend/src/legacy-map.js';
import { calculateEstimate } from '../backend/src/pricing.js';
import { hasPermission, visibleLeadPredicate } from '../backend/src/rbac.js';
import { hashPassword, verifyPassword, hashToken, safeEqual } from '../backend/src/password.js';
import { decimalProduct, decimalToUnits, unitsToDecimal, uuid } from '../backend/src/validation.js';
import { SlidingWindowLimiter } from '../backend/src/auth.js';
import { OPENAPI_SPEC } from '../backend/src/openapi.js';
import { normalizeAutomation } from '../backend/src/server.js';

test('CSV reader handles BOM, escaped quotes, commas and multiline cells', () => {
  const parsed = parseCsv('\uFEFFLead ID,Name,Notes\r\n42,"Mira, K.","called ""twice""\nand emailed"\r\n');
  assert.deepEqual(parsed.headers, ['Lead ID', 'Name', 'Notes']);
  assert.equal(parsed.records[0].values.Name, 'Mira, K.');
  assert.equal(parsed.records[0].values.Notes, 'called "twice"\nand emailed');
  assert.throws(() => parseCsv('a,a\n1,2'), /unique/);
  assert.throws(() => parseCsv('a\n"not closed'), /unterminated/);
});

test('legacy conversion preserves source values while making explicit status and date choices', () => {
  const headers = ['Lead ID', 'Name', 'Phone', 'Investor Email', 'Status', 'Budget', 'DND'];
  const lead = mapLegacyLead(['L-9', 'Mira Kapoor', '9876543210', 'MIRA@example.com', 'CALL LATER', '1.25 Cr', 'yes'], headers);
  assert.equal(lead.stageSlug, 'contact-attempted');
  assert.equal(lead.phoneNormalized, '+919876543210');
  assert.equal(lead.emailNormalized, 'mira@example.com');
  assert.equal(lead.budget, '12500000');
  assert.equal(lead.doNotContact, true);
  assert.equal(lead.migrationPayload.Status, 'CALL LATER');
  assert.equal(normalizeLegacyStatus('unknown').stageSlug, 'new-lead');
  assert.equal(parseLegacyDate('31/12/2025'), '2025-12-31T00:00:00.000Z');
  assert.equal(parseLegacyDate('31/02/2025'), null);
  assert.equal(parseLegacyBudget('no budget'), null);
});

test('decimal helpers use fixed-point arithmetic without floating point drift', () => {
  assert.equal(decimalProduct('0.1', '0.2'), '0.02');
  assert.equal(unitsToDecimal(decimalToUnits('123.4500')), '123.45');
  assert.deepEqual(calculateEstimate({ quantity: '60', providerCostPerUnit: '0.018', customerChargePerUnit: '0.035' }), {
    quantity: '60', providerCost: '1.08', customerCharge: '2.1'
  });
  assert.throws(() => decimalToUnits('1e4'));
});

test('workspace permissions default to deny and agent lead queries stay scoped', () => {
  assert.equal(hasPermission('owner', 'members:manage'), true);
  assert.equal(hasPermission('agent', 'billing:manage'), false);
  assert.equal(hasPermission('made-up', 'crm:read'), false);
  assert.deepEqual(visibleLeadPredicate({ role: 'manager' }), { sql: '', values: [] });
  const predicate = visibleLeadPredicate({ role: 'agent', workspaceId: 'workspace', userId: 'user' }, 'lead');
  assert.match(predicate.sql, /workspace_id = \$1/);
  assert.match(predicate.sql, /user_id = \$2/);
  assert.deepEqual(predicate.values, ['workspace', 'user']);
});

test('password hashes verify only their matching password and tokens compare safely', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong password', encoded), false);
  assert.notEqual(encoded, 'correct horse battery staple');
  assert.equal(safeEqual(hashToken('session-token'), hashToken('session-token')), true);
  assert.equal(safeEqual(hashToken('session-token'), hashToken('other-token')), false);
});

test('rate limiter enforces a fixed window and resets after expiry', () => {
  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.take('client', 100).allowed, true);
  assert.equal(limiter.take('client', 200).allowed, true);
  assert.equal(limiter.take('client', 300).allowed, false);
  assert.equal(limiter.take('client', 1200).allowed, true);
});

test('input validation rejects malformed identifiers and OpenAPI covers runtime routes', () => {
  assert.equal(uuid('7527e319-7089-4dae-b869-fdd7635895ee'), '7527e319-7089-4dae-b869-fdd7635895ee');
  assert.throws(() => uuid('1; DROP TABLE leads'));
  assert.equal(OPENAPI_SPEC.openapi, '3.1.0');
  assert.ok(OPENAPI_SPEC.paths['/api/v1/workspaces/{workspaceId}/reports/dashboard']);
  assert.ok(OPENAPI_SPEC.paths['/api/v1/webhooks/{provider}/calls']);
  assert.ok(OPENAPI_SPEC.paths['/api/v1/workspaces/{workspaceId}/automations/install-defaults']);
});

test('automation definitions support default follow-up ownership and delay actions', () => {
  const definition = normalizeAutomation({
    name: 'New lead follow-up', triggerType: 'lead.created', triggerConfig: {},
    actions: [{ type: 'create_task', config: { title: 'Call lead', dueInMinutes: 60, assignTo: 'owner' } }]
  });
  assert.equal(definition.actions[0].config.assignTo, 'owner');
  assert.equal(definition.actions[0].config.dueInMinutes, 60);
  const delayed = normalizeAutomation({ name: 'Delayed', triggerType: 'lead.created', actions: [{ type: 'wait', config: { minutes: 10 } }] });
  assert.equal(delayed.actions[0].config.minutes, 10);
});

