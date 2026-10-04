const OPERATORS = new Set(['=', '!=', '>', '>=', '<', '<=', 'contains', 'does not contain', 'is empty', 'is not empty', 'in', 'not in']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

function validateCondition(condition, depth = 0, count = { value: 0 }) {
  if (depth > 8 || !condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('Automation condition must be an object with at most 8 levels.');
  count.value += 1;
  if (count.value > 100) throw new Error('Automation condition contains too many rules.');
  const keys = Object.keys(condition);
  if (keys.length === 1 && (Array.isArray(condition.all) || Array.isArray(condition.any))) {
    const key = keys[0];
    if (!condition[key].length || condition[key].length > 50) throw new Error('Condition groups must contain 1 to 50 rules.');
    return { [key]: condition[key].map(item => validateCondition(item, depth + 1, count)) };
  }
  if (!condition.field || typeof condition.field !== 'string' || condition.field.length > 160 || !OPERATORS.has(String(condition.operator ?? '').toLowerCase())) {
    throw new Error('Condition rules require a field and a supported operator.');
  }
  if (condition.operator !== 'is empty' && condition.operator !== 'is not empty' && !Object.hasOwn(condition, 'value')) throw new Error('Condition rules require a comparison value.');
  return { field: condition.field, operator: String(condition.operator).toLowerCase(), ...(Object.hasOwn(condition, 'value') ? { value: condition.value } : {}) };
}

export function normalizeAutomationGraph(graph, normalizeAction) {
  if (graph === undefined || graph === null) return null;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('graph must be an object.');
  const { startNodeId, nodes, edges } = graph;
  if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 50) throw new Error('Graph must contain 2 to 50 nodes.');
  if (!Array.isArray(edges) || edges.length > 100) throw new Error('Graph must contain no more than 100 connections.');
  if (typeof startNodeId !== 'string' || !ID_PATTERN.test(startNodeId)) throw new Error('Graph startNodeId is invalid.');
  const ids = new Set();
  const normalizedNodes = nodes.map(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.id !== 'string' || !ID_PATTERN.test(node.id) || ids.has(node.id)) throw new Error('Graph node IDs must be unique valid identifiers.');
    ids.add(node.id);
    if (node.type === 'condition') return { id: node.id, label: typeof node.label === 'string' ? node.label.slice(0,80) : node.id, type: 'condition', condition: validateCondition(node.condition) };
    if (node.type === 'action') {
      if (!node.action || typeof node.action !== 'object') throw new Error(`Action node ${node.id} is missing its action.`);
      return { id: node.id, label: typeof node.label === 'string' ? node.label.slice(0,80) : node.id, type: 'action', action: normalizeAction(node.action) };
    }
    if (node.type === 'wait') {
      const minutes = Number(node.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error(`Wait node ${node.id} requires minutes from 1 to 525600.`);
      return { id: node.id, label: typeof node.label === 'string' ? node.label.slice(0,80) : node.id, type: 'wait', minutes };
    }
    if (node.type === 'end') return { id: node.id, label: typeof node.label === 'string' ? node.label.slice(0,80) : node.id, type: 'end' };
    throw new Error(`Unsupported graph node type: ${String(node.type)}.`);
  });
  if (!ids.has(startNodeId)) throw new Error('Graph startNodeId must refer to a node.');
  const byId = new Map(normalizedNodes.map(node => [node.id, node]));
  const outgoing = new Map(normalizedNodes.map(node => [node.id, []]));
  const incoming = new Map(normalizedNodes.map(node => [node.id, 0]));
  const edgeKeys = new Set();
  const normalizedEdges = edges.map(edge => {
    if (!edge || typeof edge !== 'object' || !byId.has(edge.from) || !byId.has(edge.to) || edge.from === edge.to) throw new Error('Graph connection references an invalid node.');
    const from = byId.get(edge.from); const label = edge.label ?? 'next';
    const allowed = from.type === 'condition' ? ['yes', 'no'] : ['next'];
    if (!allowed.includes(label)) throw new Error(`Invalid connection label for node ${edge.from}.`);
    const key = `${edge.from}:${label}`;
    if (edgeKeys.has(key)) throw new Error(`Node ${edge.from} has duplicate ${label} connections.`);
    edgeKeys.add(key); outgoing.get(edge.from).push({ to: edge.to, label }); incoming.set(edge.to, incoming.get(edge.to) + 1);
    return { from: edge.from, to: edge.to, label };
  });
  for (const node of normalizedNodes) {
    const links = outgoing.get(node.id);
    if (node.type === 'condition' && (!edgeKeys.has(`${node.id}:yes`) || !edgeKeys.has(`${node.id}:no`))) throw new Error(`Condition node ${node.id} needs YES and NO connections.`);
    if ((node.type === 'action' || node.type === 'wait') && links.length !== 1) throw new Error(`Node ${node.id} needs exactly one next connection.`);
    if (node.type === 'end' && links.length) throw new Error(`End node ${node.id} cannot have outgoing connections.`);
  }
  if (incoming.get(startNodeId) !== 0 || normalizedNodes.some(node => node.id !== startNodeId && incoming.get(node.id) === 0)) throw new Error('Graph must have one start node and every other node must be connected.');
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new Error('Automation graphs cannot contain loops.');
    if (visited.has(id)) return;
    visiting.add(id); for (const edge of outgoing.get(id)) visit(edge.to); visiting.delete(id); visited.add(id);
  };
  visit(startNodeId);
  if (visited.size !== normalizedNodes.length) throw new Error('Every graph node must be reachable from the start.');
  return { version: 1, startNodeId, nodes: normalizedNodes, edges: normalizedEdges };
}

export function evaluateAutomationCondition(condition, context) {
  if (Array.isArray(condition?.all)) return condition.all.every(item => evaluateAutomationCondition(item, context));
  if (Array.isArray(condition?.any)) return condition.any.some(item => evaluateAutomationCondition(item, context));
  const actual = String(condition?.field ?? '').split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], context);
  const expected = condition?.value; const operator = String(condition?.operator ?? '').toLowerCase();
  if (operator === 'is empty') return actual === undefined || actual === null || actual === '';
  if (operator === 'is not empty') return actual !== undefined && actual !== null && actual !== '';
  if (operator === 'contains') return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'does not contain') return Array.isArray(actual) ? !actual.includes(expected) : !String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'in') return Array.isArray(expected) && expected.includes(actual);
  if (operator === 'not in') return Array.isArray(expected) && !expected.includes(actual);
  if (operator === '=') return actual === expected || String(actual ?? '') === String(expected ?? '');
  if (operator === '!=') return !(actual === expected || String(actual ?? '') === String(expected ?? ''));
  const left = Number(actual); const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === '>') return left > right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  if (operator === '<=') return left <= right;
  return false;
}
