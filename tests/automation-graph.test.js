import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutomationCondition, normalizeAutomationGraph } from '../backend/src/automation-graph.js';

const graph = {
  version: 1, startNodeId: 'gate',
  nodes: [
    { id: 'gate', type: 'condition', condition: { all: [{ field: 'lead.score', operator: '>=', value: 70 }, { any: [{ field: 'lead.status', operator: '=', value: 'Qualified' }, { field: 'lead.status', operator: '=', value: 'Connected' }] }] } },
    { id: 'yes', type: 'action', action: { type: 'create_note', config: { title: 'yes' } } },
    { id: 'no', type: 'action', action: { type: 'create_note', config: { title: 'no' } } },
    { id: 'end', type: 'end' }
  ],
  edges: [{ from: 'gate', to: 'yes', label: 'yes' }, { from: 'gate', to: 'no', label: 'no' }, { from: 'yes', to: 'end' }, { from: 'no', to: 'end' }]
};

test('automation graph validates branching, joins and nested AND/OR comparisons', () => {
  const normalized = normalizeAutomationGraph(graph, action => action);
  assert.equal(normalized.edges.length, 4);
  assert.equal(evaluateAutomationCondition(normalized.nodes[0].condition, { lead: { score: 75, status: 'Qualified' } }), true);
  assert.equal(evaluateAutomationCondition(normalized.nodes[0].condition, { lead: { score: 35, status: 'Qualified' } }), false);
});

test('automation graph rejects incomplete branches and cycles', () => {
  assert.throws(() => normalizeAutomationGraph({ ...graph, edges: graph.edges.filter(edge => edge.label !== 'no') }, action => action), /YES and NO/);
  const cyclic = { version: 1, startNodeId: 'a', nodes: [{ id: 'a', type: 'action', action: {} }, { id: 'b', type: 'end' }], edges: [{ from: 'a', to: 'a', label: 'next' }] };
  assert.throws(() => normalizeAutomationGraph(cyclic, action => action), /invalid node|loops/);
});
