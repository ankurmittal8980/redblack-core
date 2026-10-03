import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAutomation } from '../backend/src/server.js';

test('automation contract accepts production triggers and actions', () => {
  const definition = normalizeAutomation({
    name: 'Qualified lead workflow',
    triggerType: 'lead.score_changed',
    triggerConfig: { all: [
      { field: 'lead.score', operator: '>=', value: 70 },
      { field: 'lead.status', operator: '=', value: 'connected' },
      { field: 'lead.consent', operator: '=', value: true }
    ] },
    actions: [
      { type: 'update_lead', config: { status: 'qualified' } },
      { type: 'assign_owner', config: {} },
      { type: 'create_note', config: { title: 'Qualified', body: 'Automation completed.' } },
      { type: 'schedule_follow_up', config: { title: 'Call qualified lead', dueInMinutes: 60 } }
    ]
  });
  assert.equal(definition.triggerType, 'lead.score_changed');
  assert.equal(definition.actions.length, 4);
});
