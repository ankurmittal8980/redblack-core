import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolEngine } from '../backend/src/tool-engine.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const otherActorId = '00000000-0000-4000-8000-000000000003';
const leadId = '00000000-0000-4000-8000-000000000004';
const taskId = '00000000-0000-4000-8000-000000000005';
const pipelineId = '00000000-0000-4000-8000-000000000006';
const stageId = '00000000-0000-4000-8000-000000000007';

function context(overrides = {}) {
  return {
    workspaceId, actorUserId: actorId, role: 'manager',
    correlationId: 'corr-1', runId: 'run-1', idempotencyKey: 'idem-key-0001',
    ...overrides
  };
}

class MemoryPg {
  constructor({ visibleLeads = [], visibleTasks = [], visiblePipelines = [], consents = {} } = {}) {
    this.idempotency = new Map();
    this.auditRows = [];
    this.visibleLeads = new Set(visibleLeads);
    this.visibleTasks = new Set(visibleTasks);
    this.visiblePipelines = new Set(visiblePipelines);
    this.consents = consents;
  }

  async query(text, values = []) {
    return this.runQuery(text, values, null);
  }

  async connect() {
    const transaction = { idempotency: new Map(this.idempotency), auditRows: [] };
    return {
      query: async (text, values = []) => this.runQuery(text, values, transaction),
      release() {}
    };
  }

  async runQuery(text, values, transaction) {
    if (text === 'BEGIN' || text.startsWith("SELECT set_config('statement_timeout'")) return { rows: [] };
    if (text === 'COMMIT') {
      if (transaction) {
        this.idempotency = transaction.idempotency;
        this.auditRows.push(...transaction.auditRows);
      }
      return { rows: [] };
    }
    if (text === 'ROLLBACK') return { rows: [] };
    const idempotency = transaction?.idempotency ?? this.idempotency;
    if (text.includes('INSERT INTO agent_tool_idempotency')) {
      const [key, ws, actor, role, tool, hash] = values;
      if (idempotency.has(key)) return { rows: [] };
      idempotency.set(key, { workspace_id: ws, actor_user_id: actor, actor_role: role, tool_name: tool, input_hash: hash, status: 'in_progress', result: null });
      return { rows: [{ idempotency_key: key }] };
    }
    if (text.includes('SELECT workspace_id,actor_user_id,actor_role,tool_name,input_hash,status,result FROM agent_tool_idempotency')) {
      return { rows: idempotency.has(values[0]) ? [idempotency.get(values[0])] : [] };
    }
    if (text.startsWith('UPDATE agent_tool_idempotency')) {
      const previous = idempotency.get(values[0]);
      if (previous) idempotency.set(values[0], { ...previous, status: 'completed', result: JSON.parse(values[1]) });
      return { rows: [] };
    }
    if (text.includes('INSERT INTO audit_logs')) {
      const row = { values };
      if (transaction) transaction.auditRows.push(row);
      else this.auditRows.push(row);
      return { rows: [] };
    }
    if (text.startsWith('SELECT l.do_not_contact, c.opted_in FROM leads l')) {
      const consent = this.consents[`${values[1]}:${values[2]}`];
      return { rows: this.visibleLeads.has(values[1]) ? [consent ?? { do_not_contact: false, opted_in: null }] : [] };
    }
    if (text.includes('SELECT l.id FROM leads l WHERE l.workspace_id=$1 AND l.id=ANY')) {
      return { rows: values[0] === workspaceId ? values[1].filter(id => this.visibleLeads.has(id)).map(id => ({ id })) : [] };
    }
    if (text.includes('SELECT id FROM tasks WHERE workspace_id=$1 AND id=ANY')) {
      return { rows: values[0] === workspaceId ? values[1].filter(id => this.visibleTasks.has(id)).map(id => ({ id })) : [] };
    }
    if (text.includes('SELECT id FROM pipelines WHERE workspace_id=$1 AND id=ANY')) {
      return { rows: values[0] === workspaceId ? values[1].filter(id => this.visiblePipelines.has(id)).map(id => ({ id })) : [] };
    }
    if (text.includes('SELECT l.id FROM leads l')) {
      const id = values[1];
      return { rows: values[0] === workspaceId && this.visibleLeads.has(id) ? [{ id }] : [] };
    }
    if (text.includes('SELECT t.id FROM tasks t')) {
      const id = values[1];
      return { rows: this.visibleTasks.has(id) ? [{ id }] : [] };
    }
    throw new Error(`Unexpected fake database query: ${text}`);
  }
}

test('registry is fixed, descriptive, and contains only explicit domain tools', () => {
  const engine = createToolEngine();
  const tools = engine.listTools();
  assert.ok(tools.some(tool => tool.name === 'crm.leads.search' && tool.classification === 'read'));
  assert.ok(tools.some(tool => tool.name === 'crm.tasks.create' && tool.classification === 'write' && tool.idempotencyRequired));
  assert.ok(tools.some(tool => tool.name === 'knowledge.retrieve'));
  assert.equal(tools.find(tool => tool.name === 'crm.leads.assign').approvalRequired, true);
  const leadSearch = tools.find(tool => tool.name === 'crm.leads.search');
  assert.equal(leadSearch.inputSchema.additionalProperties, false);
  assert.equal(leadSearch.inputSchema.properties.query.maxLength, 120);
  assert.equal(leadSearch.inputSchema.properties.query.minLength, 1);
  assert.equal(leadSearch.inputSchema.properties.query.max, undefined);
  assert.equal(tools.find(tool => tool.name === 'crm.leads.get').inputSchema.properties.leadId.format, 'uuid');
  assert.equal(tools[0].resultSchema.properties.ok.type, 'boolean');
  assert.deepEqual(tools[0].resultSchema.required, ['ok', 'status', 'toolName', 'data', 'error', 'retryable']);
  assert.deepEqual(tools.find(tool => tool.name === 'crm.tasks.list').inputSchema.properties.dueBefore.type, ['string', 'null']);
  assert.deepEqual(tools.find(tool => tool.name === 'crm.leads.assign').authorizationPolicy.allowedRoles, ['owner', 'admin', 'manager']);
  assert.equal(tools.some(tool => /^(shell\.exec|sql\.query|http\.request|eval|filesystem\.read)$/.test(tool.name)), false);
  assert.equal(engine.register, undefined);
  assert.equal(Object.isFrozen(tools[0]), true);
});

test('known read tool executes with normalized envelope and redacts sensitive fields', async () => {
  const db = new MemoryPg({ visiblePipelines: [pipelineId] });
  const engine = createToolEngine({ db, executors: { listPipelines: async () => ({ data: [{ id: pipelineId, name: 'Sales', provider_token: 'secret' }] }) } });
  const result = await engine.execute({ toolName: 'crm.pipelines.list', input: {}, context: context({ idempotencyKey: undefined }) });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.equal(result.data.data[0].name, 'Sales');
  assert.equal('provider_token' in result.data.data[0], false);
  assert.equal(result.retryable, false);
});

test('unknown tools, dangerous extra fields, invalid IDs, and context spoofing fail closed', async () => {
  let calls = 0;
  const engine = createToolEngine({ executors: { searchLeads: async () => { calls += 1; return { data: [] }; } } });
  const validContext = context({ idempotencyKey: undefined });
  assert.equal((await engine.execute({ toolName: 'sql.query', input: { sql: 'select 1' }, context: validContext })).status, 'validation_failure');
  assert.equal((await engine.execute({ toolName: 'crm.leads.search', input: { query: 'x', workspaceId }, context: validContext })).status, 'validation_failure');
  for (const toolName of ['shell.exec', 'sql.query', 'http.request', 'eval', 'filesystem.read']) {
    assert.equal((await engine.execute({ toolName, input: { command: 'id', sql: 'select 1', url: 'https://example.invalid', code: '1+1', path: 'C:/secret' }, context: validContext })).status, 'validation_failure');
  }
  assert.equal((await engine.execute({ toolName: 'crm.leads.search', input: { query: 'x', actorUserId: otherActorId }, context: validContext })).status, 'validation_failure');
  assert.equal((await engine.execute({ toolName: 'crm.leads.get', input: { leadId: '1 OR 1=1' }, context: validContext })).status, 'validation_failure');
  assert.equal((await engine.execute({ toolName: 'crm.leads.search', input: { query: 'x' }, context: { ...validContext, role: 'root' } })).status, 'authorization_denied');
  assert.equal((await engine.execute(null)).status, 'validation_failure');
  assert.equal(calls, 0);
});

test('agent lead IDs are checked against workspace assignment visibility before execution', async () => {
  const db = new MemoryPg({ visibleLeads: [leadId] });
  let calls = 0;
  const engine = createToolEngine({ db, executors: { getLead: async ({ input, context: trusted }) => { calls += 1; assert.equal(trusted.workspaceId, workspaceId); return { id: input.leadId, first_name: 'Allowed' }; } } });
  const allowed = await engine.execute({ toolName: 'crm.leads.get', input: { leadId }, context: context({ role: 'agent', idempotencyKey: undefined }) });
  const denied = await engine.execute({ toolName: 'crm.leads.get', input: { leadId: taskId }, context: context({ role: 'agent', idempotencyKey: undefined }) });
  assert.equal(allowed.ok, true);
  assert.equal(denied.status, 'not_found');
  assert.equal(calls, 1);
  const crossWorkspace = await engine.execute({ toolName: 'crm.leads.get', input: { leadId }, context: context({ workspaceId: '00000000-0000-4000-8000-000000000099', role: 'agent', idempotencyKey: undefined }) });
  assert.equal(crossWorkspace.status, 'not_found');
});

test('list results are workspace-scoped and agent rows are post-filtered by assignment', async () => {
  const db = new MemoryPg({ visibleLeads: [leadId] });
  const engine = createToolEngine({ db, executors: { searchLeads: async () => ({ data: [{ id: leadId }, { id: taskId }], total: 2 }) } });
  const result = await engine.execute({ toolName: 'crm.leads.search', input: { query: 'lead' }, context: context({ role: 'agent', idempotencyKey: undefined }) });
  assert.deepEqual(result.data.data.map(row => row.id), [leadId]);
  assert.equal('total' in result.data, false);
  const manager = await engine.execute({ toolName: 'crm.leads.search', input: { query: 'lead' }, context: context({ idempotencyKey: undefined }) });
  assert.deepEqual(manager.data.data.map(row => row.id), [leadId]);
});

test('database availability and domain conflicts normalize to stable retry-aware error codes', async () => {
  const databaseUnavailable = createToolEngine({ executors: {
    listPipelines: async () => { throw Object.assign(new Error('private DSN'), { code: '08006' }); }
  } });
  const conflict = createToolEngine({ executors: {
    listPipelines: async () => { throw Object.assign(new Error('private constraint'), { code: '23505' }); }
  } });
  const transient = await databaseUnavailable.execute({ toolName: 'crm.pipelines.list', context: context({ idempotencyKey: undefined }) });
  const permanentConflict = await conflict.execute({ toolName: 'crm.pipelines.list', context: context({ idempotencyKey: undefined }) });
  assert.deepEqual([transient.status, transient.retryable, transient.error.code], ['transient_failure', true, 'DATABASE_UNAVAILABLE']);
  assert.deepEqual([permanentConflict.status, permanentConflict.retryable, permanentConflict.error.code], ['conflict', false, 'DOMAIN_CONFLICT']);
  assert.equal(JSON.stringify(transient).includes('private'), false);
});

test('every Core role can read within its role policy and communication drafts enforce consent', async () => {
  const db = new MemoryPg({ visibleLeads: [leadId], consents: {
    [`${leadId}:email`]: { do_not_contact: false, opted_in: true },
    [`${leadId}:whatsapp`]: { do_not_contact: true, opted_in: true }
  } });
  let draftCalls = 0;
  const engine = createToolEngine({ db, executors: {
    listPipelines: async () => ({ data: [] }),
    createMessageDraft: async ({ input }) => { draftCalls += 1; return { id: taskId, channel: input.channel, status: 'draft' }; }
  } });
  for (const role of ['owner', 'admin', 'manager', 'agent', 'reporting', 'service']) {
    assert.equal((await engine.execute({ toolName: 'crm.pipelines.list', input: {}, context: context({ role, idempotencyKey: undefined }) })).ok, true, role);
  }
  const noConsent = await engine.execute({ toolName: 'crm.messages.draft.create', input: { leadId, channel: 'rcs', body: 'Hello' }, context: context({ idempotencyKey: 'idem-no-consent' }) });
  const suppressed = await engine.execute({ toolName: 'crm.messages.draft.create', input: { leadId, channel: 'whatsapp', body: 'Hello' }, context: context({ idempotencyKey: 'idem-suppressed' }) });
  const allowed = await engine.execute({ toolName: 'crm.messages.draft.create', input: { leadId, channel: 'email', body: 'Hello' }, context: context({ idempotencyKey: 'idem-consented' }) });
  assert.equal(noConsent.error.code, 'CONSENT_REQUIRED');
  assert.equal(suppressed.error.code, 'DO_NOT_CONTACT');
  assert.equal(allowed.ok, true);
  assert.equal(draftCalls, 1);
  assert.equal(engine.listTools().some(tool => /\.send$/.test(tool.name)), false);
  assert.equal(engine.listTools().find(tool => tool.name === 'crm.messages.draft.create').consentRequired, true);
});

test('reporting cannot use write tools; service remains non-administrative', async () => {
  let calls = 0;
  const engine = createToolEngine({ executors: { createTask: async () => { calls += 1; return { id: taskId }; }, assignLead: async () => { calls += 1; return { id: leadId }; } } });
  const reporting = await engine.execute({ toolName: 'crm.tasks.create', input: { title: 'Call back' }, context: context({ role: 'reporting' }) });
  const serviceAssign = await engine.execute({ toolName: 'crm.leads.assign', input: { leadId, assigneeId: otherActorId }, context: context({ role: 'service', idempotencyKey: 'idem-service-1', approvalContext: { approvalId: 'approval-1' } }) });
  assert.equal(reporting.status, 'authorization_denied');
  assert.equal(serviceAssign.status, 'authorization_denied');
  assert.equal(calls, 0);
});

test('high-impact assignment requires matching trusted approval; model approval input is rejected', async () => {
  const db = new MemoryPg({ visibleLeads: [leadId] });
  let calls = 0;
  let verified;
  const engine = createToolEngine({
    db,
    verifyApproval: async request => { verified = request; return request.approvalContext.approvalId === 'trusted-approval'; },
    executors: { assignLead: async () => { calls += 1; return { id: leadId, owner_user_id: otherActorId }; } }
  });
  const argsFakeApproval = await engine.execute({ toolName: 'crm.leads.assign', input: { leadId, assigneeId: otherActorId, approved: true }, context: context({ idempotencyKey: 'idem-approval-1' }) });
  const noApproval = await engine.execute({ toolName: 'crm.leads.assign', input: { leadId, assigneeId: otherActorId }, context: context({ idempotencyKey: 'idem-approval-2' }) });
  const approved = await engine.execute({ toolName: 'crm.leads.assign', input: { leadId, assigneeId: otherActorId }, context: context({ idempotencyKey: 'idem-approval-3', approvalContext: { approvalId: 'trusted-approval' } }) });
  assert.equal(argsFakeApproval.status, 'validation_failure');
  assert.equal(noApproval.status, 'approval_required');
  assert.equal(approved.ok, true);
  assert.equal(calls, 1);
  assert.equal(verified.toolName, 'crm.leads.assign');
  assert.equal(verified.context.workspaceId, workspaceId);
});

test('write retry returns the prior result; mismatched actor, workspace, tool, or payload conflicts', async () => {
  const db = new MemoryPg();
  let writes = 0;
  const engine = createToolEngine({ db, executors: { createTask: async ({ input }) => { writes += 1; return { id: taskId, title: input.title }; }, createNote: async () => ({ id: taskId }) } });
  const request = { toolName: 'crm.tasks.create', input: { title: 'Follow up' }, context: context() };
  const first = await engine.execute(request);
  assert.equal(db.idempotency.size, 1, JSON.stringify(first));
  const retry = await engine.execute(request);
  assert.deepEqual(retry, first);
  assert.equal(writes, 1, JSON.stringify({ first, retry }));
  assert.equal(writes, 1);
  for (const changed of [
    { ...request, context: context({ actorUserId: otherActorId }) },
    { ...request, context: context({ workspaceId: '00000000-0000-4000-8000-000000000099' }) },
    { ...request, toolName: 'crm.activities.note.create', input: { title: 'Follow up' } },
    { ...request, input: { title: 'Different action' } }
  ]) {
    const conflict = await engine.execute(changed);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(writes, 1, JSON.stringify({ toolName: changed.toolName, context: changed.context, input: changed.input, conflict }));
  }
  const successAudits = db.auditRows.filter(row => row.values[2] === 'agent_tool.executed');
  assert.equal(successAudits.length, 1);
  const audit = JSON.parse(successAudits[0].values[5]);
  assert.equal(audit.toolName, 'crm.tasks.create');
  assert.equal(audit.correlationId, 'corr-1');
  assert.equal(audit.idempotencyRef.length, 64);
  const failureAudit = db.auditRows.find(row => row.values[2] === 'agent_tool.denied_or_failed');
  assert.ok(failureAudit);
  assert.equal(failureAudit.values[0], workspaceId);
  assert.equal(failureAudit.values[1], otherActorId);
  assert.equal(JSON.parse(failureAudit.values[4]).errorCode, 'IDEMPOTENCY_CONFLICT');
});

test('task mutations are record-scoped and executor errors never leak internals', async () => {
  const db = new MemoryPg({ visibleTasks: [taskId] });
  let calls = 0;
  const engine = createToolEngine({ db, executors: {
    updateTask: async ({ input }) => { calls += 1; return { id: input.taskId, status: 'completed' }; },
    listPipelines: async () => { throw new Error('secret=abc stack at /private/path'); }
  } });
  const allowed = await engine.execute({ toolName: 'crm.tasks.update', input: { taskId, status: 'completed' }, context: context({ role: 'agent', idempotencyKey: 'idem-task-1' }) });
  const denied = await engine.execute({ toolName: 'crm.tasks.update', input: { taskId: leadId, status: 'completed' }, context: context({ role: 'agent', idempotencyKey: 'idem-task-2' }) });
  const failed = await engine.execute({ toolName: 'crm.pipelines.list', input: {}, context: context({ idempotencyKey: undefined }) });
  assert.equal(allowed.ok, true);
  assert.equal(denied.status, 'not_found');
  assert.equal(calls, 1);
  assert.equal(failed.status, 'permanent_failure');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal(JSON.stringify(failed).includes('/private/path'), false);
});

test('stalled read executors are aborted at the registered timeout', async () => {
  const engine = createToolEngine({ timeoutMs: 100, executors: {
    listPipelines: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
    })
  } });
  const result = await engine.execute({ toolName: 'crm.pipelines.list', input: {}, context: context({ idempotencyKey: undefined }) });
  assert.equal(result.status, 'timeout');
  assert.equal(result.retryable, true);
});

test('stalled writes return a timeout and roll back their idempotency claim', async () => {
  const db = new MemoryPg();
  const engine = createToolEngine({ db, timeoutMs: 100, executors: {
    createTask: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
    })
  } });
  const result = await engine.execute({ toolName: 'crm.tasks.create', input: { title: 'Never commits' }, context: context({ idempotencyKey: 'idem-timeout-1' }) });
  assert.equal(result.status, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(db.idempotency.size, 0);
});
