import { AgentRunner } from './runner.js';
import { InMemoryAgentRunStore } from './store.js';
import { createAgentToolExecutor } from './tool-engine-adapter.js';
import { createMemoryService, PostgresMemoryStore } from '../ai-memory.js';

const actorFromDb = async (db, workspaceId, actor) => {
  const result = await db.query('SELECT wm.user_id, wm.role, wm.workspace_id FROM workspace_members wm WHERE wm.workspace_id=$1 AND wm.user_id=$2 AND wm.active=true', [workspaceId, actor?.userId]);
  const row = result.rows[0];
  if (!row) { const e = new Error('Active workspace membership required.'); e.code = 'AGENT_UNAUTHORIZED'; e.status = 403; throw e; }
  return { userId: row.user_id, role: row.role, workspaceId: row.workspace_id };
};

const query = async (db, sql, values) => (await db.query(sql, values)).rows;

export function createProductionAgentRuntime({ db, knowledgeService = null, planner = null } = {}) {
  if (!db?.query) throw new Error('Database is required for agent runtime.');
  const executors = {
    searchLeads: ({ db: cx, context, input }) => query(cx, 'SELECT id,name,email,phone,status,temperature,score FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL AND (name ILIKE $2 OR email ILIKE $2) ORDER BY updated_at DESC LIMIT $3', [context.workspaceId, `%${input.query}%`, input.limit ?? 20]),
    getLead: async ({ db: cx, context, input }) => (await query(cx, 'SELECT id,name,email,phone,status,temperature,score,budget,location,requirement,next_action,next_action_at FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL LIMIT 1', [context.workspaceId, input.leadId]))[0] ?? null,
    listTasks: ({ db: cx, context, input }) => query(cx, 'SELECT id,lead_id,title,description,status,due_at,priority,assigned_to FROM tasks WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR due_at<$3) ORDER BY due_at NULLS LAST, id LIMIT $4', [context.workspaceId, input.status ?? null, input.dueBefore ?? null, input.limit ?? 50]),
    listPipelines: ({ db: cx, context }) => query(cx, 'SELECT p.id,p.name,s.id AS stage_id,s.name AS stage_name,s.position FROM pipelines p LEFT JOIN pipeline_stages s ON s.workspace_id=p.workspace_id AND s.pipeline_id=p.id WHERE p.workspace_id=$1 ORDER BY p.name,s.position', [context.workspaceId]),
    getLeadTimeline: ({ db: cx, context, input }) => query(cx, 'SELECT id,lead_id,activity_type,title,body,created_at FROM activities WHERE workspace_id=$1 AND lead_id=$2 ORDER BY created_at DESC LIMIT $3', [context.workspaceId, input.leadId, input.limit ?? 50]),
    getMessageHistory: ({ db: cx, context, input }) => query(cx, 'SELECT id,lead_id,channel,direction,status,subject,body,created_at FROM messages WHERE workspace_id=$1 AND lead_id=$2 ORDER BY created_at DESC LIMIT $3', [context.workspaceId, input.leadId, input.limit ?? 50]),
    retrieveKnowledge: async ({ context, input }) => knowledgeService ? knowledgeService.retrieve({ workspaceId: context.workspaceId, userId: context.actorUserId, role: context.role }, { query: input.query, topK: input.limit ?? 10 }) : [],
    createTask: async ({ db: cx, context, input }) => (await cx.query('INSERT INTO tasks(workspace_id,lead_id,title,description,due_at,priority,assigned_to,status) VALUES($1,$2,$3,$4,$5,$6,$7,\'pending\') RETURNING id,lead_id,title,description,due_at,priority,assigned_to,status', [context.workspaceId, input.leadId ?? null, input.title, input.description ?? null, input.dueAt ?? null, input.priority ?? 0, context.actorUserId])).rows[0],
    updateTask: async ({ db: cx, context, input }) => (await cx.query('UPDATE tasks SET title=COALESCE($3,title),description=COALESCE($4,description),due_at=COALESCE($5,due_at),status=COALESCE($6,status),priority=COALESCE($7,priority),updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,lead_id,title,description,due_at,priority,assigned_to,status', [context.workspaceId, input.taskId, input.title ?? null, input.description ?? null, input.dueAt ?? null, input.status ?? null, input.priority ?? null])).rows[0],
    createNote: async ({ db: cx, context, input }) => (await cx.query('INSERT INTO activities(workspace_id,lead_id,activity_type,title,body,created_by) VALUES($1,$2,\'note\',$3,$4,$5) RETURNING id,lead_id,activity_type,title,body,created_at', [context.workspaceId, input.leadId ?? null, input.title, input.body ?? null, context.actorUserId])).rows[0],
    updateLead: async ({ db: cx, context, input }) => (await cx.query('UPDATE leads SET status=COALESCE($3,status),temperature=COALESCE($4,temperature),score=COALESCE($5,score),budget=COALESCE($6,budget),location=COALESCE($7,location),requirement=COALESCE($8,requirement),next_action=COALESCE($9,next_action),next_action_at=COALESCE($10,next_action_at),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id,status,temperature,score,budget,location,requirement,next_action,next_action_at', [context.workspaceId, input.leadId, input.status ?? null, input.temperature ?? null, input.score ?? null, input.budget ?? null, input.location ?? null, input.requirement ?? null, input.nextAction ?? null, input.nextActionAt ?? null])).rows[0],
    changeLeadStage: async ({ db: cx, context, input }) => (await cx.query('UPDATE lead_pipeline_entries SET pipeline_id=$3,stage_id=$4,updated_at=now() WHERE workspace_id=$1 AND lead_id=$2 RETURNING lead_id,pipeline_id,stage_id', [context.workspaceId, input.leadId, input.pipelineId, input.stageId])).rows[0],
    assignLead: async ({ db: cx, context, input }) => (await cx.query('UPDATE lead_assignments SET unassigned_at=now() WHERE workspace_id=$1 AND lead_id=$2 AND unassigned_at IS NULL; INSERT INTO lead_assignments(workspace_id,lead_id,user_id) VALUES($1,$2,$3) RETURNING lead_id,user_id', [context.workspaceId, input.leadId, input.assigneeId])).rows.at(-1),
    createMessageDraft: async ({ db: cx, context, input }) => (await cx.query('INSERT INTO messages(workspace_id,lead_id,channel,direction,status,subject,body,created_by) VALUES($1,$2,$3,\'outbound\',\'draft\',$4,$5,$6,$7) RETURNING id,lead_id,channel,status,subject,body,created_at', [context.workspaceId, input.leadId, input.channel, input.subject ?? null, input.body, context.actorUserId])).rows[0]
  };
  const toolExecutor = createAgentToolExecutor({ db, executors, verifyApproval: async ({ approvalContext, context }) => {
    if (!approvalContext?.approvalId || approvalContext.workspaceId !== context.workspaceId) return false;
    const approved = await db.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active=true AND role IN (\'owner\',\'admin\',\'manager\')', [context.workspaceId, approvalContext.approverId]);
    return approved.rowCount > 0;
  } });
  const memoryStore = new PostgresMemoryStore(db);
  const memory = createMemoryService({ store: memoryStore, authorizeEntity: async () => true });
  const agent = new AgentRunner({ store: new InMemoryAgentRunStore(), planner: planner ?? { next: async view => { if (view.stepCount === 0) { try { return { type: 'tool', request: JSON.parse(view.goal) }; } catch { return { type: 'finish', result: null }; } } return { type: 'finish', result: view.observations.at(-1)?.observation ?? null }; } }, toolExecutor, authorizeTool: async ({ request, actor, approval }) => ({ allowed: Boolean(actor?.userId && actor?.workspaceId && request?.tool), approvalContext: approval ? { approvalId: `${approval.actor?.userId ?? ''}:${approval.decidedAt ?? ''}`, approverId: approval.actor?.userId, workspaceId: actor.workspaceId } : null }), memoryStore: { getContext: args => memory.buildMemoryContext({ ...args, actor: args.actor, maxChars: 12000 }) }, knowledgeRetriever: knowledgeService ? { retrieve: args => knowledgeService.retrieve(args.actor, { query: args.goal, topK: 10 }) } : null });
  return Object.freeze({ agent, toolExecutor, resolveActor: (workspaceId, actor) => actorFromDb(db, workspaceId, actor) });
}

