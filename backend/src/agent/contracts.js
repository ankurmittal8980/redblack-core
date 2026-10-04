import { createHash, randomUUID } from 'node:crypto';

export const AGENT_RUN_STATUS = Object.freeze({
  PENDING: 'pending', RUNNING: 'running', PAUSED: 'paused', APPROVAL_REQUIRED: 'approval_required',
  ESCALATED: 'escalated', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
  MAX_STEPS: 'max_steps', TIMED_OUT: 'timed_out'
});

export const TERMINAL_AGENT_STATUSES = new Set([
  AGENT_RUN_STATUS.COMPLETED, AGENT_RUN_STATUS.FAILED, AGENT_RUN_STATUS.CANCELLED,
  AGENT_RUN_STATUS.MAX_STEPS, AGENT_RUN_STATUS.TIMED_OUT
]);

export class AgentFrameworkError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message); this.name = 'AgentFrameworkError'; this.code = code; this.status = status; this.details = details;
  }
}

export const fail = (code, message, status = 400, details) => { throw new AgentFrameworkError(code, message, status, details); };

const nonEmpty = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim()) fail('AGENT_INPUT_INVALID', `${name} must be a non-empty string.`);
  if (value.length > max) fail('AGENT_INPUT_INVALID', `${name} exceeds ${max} characters.`);
  return value.trim();
};

export function normalizeAgentDefinition(definition = {}) {
  const allowedTools = Array.isArray(definition.allowedTools) ? [...new Set(definition.allowedTools)] : [];
  if (allowedTools.some(tool => typeof tool !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(tool))) fail('AGENT_DEFINITION_INVALID', 'allowedTools contains an invalid tool name.');
  const maxSteps = Number(definition.maxSteps ?? 12);
  const deadlineMs = Number(definition.deadlineMs ?? 60_000);
  const maxRetries = Number(definition.maxRetries ?? 1);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) fail('AGENT_DEFINITION_INVALID', 'maxSteps must be between 1 and 100.');
  if (!Number.isInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 3_600_000) fail('AGENT_DEFINITION_INVALID', 'deadlineMs must be between 100 and 3600000.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) fail('AGENT_DEFINITION_INVALID', 'maxRetries must be between 0 and 5.');
  return Object.freeze({
    id: nonEmpty(definition.id ?? 'default', 'definition.id', 120),
    name: nonEmpty(definition.name ?? definition.id ?? 'RedBlack Agent', 'definition.name', 200),
    allowedTools, maxSteps, deadlineMs, maxRetries,
    requireApprovalFor: [...new Set(definition.requireApprovalFor ?? [])],
    metadata: definition.metadata && typeof definition.metadata === 'object' ? structuredClone(definition.metadata) : {}
  });
}

export function normalizeToolRequest(request, run) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('TOOL_REQUEST_INVALID', 'Planner tool request must be an object.');
  const tool = nonEmpty(request.tool, 'tool', 128);
  const input = request.input == null ? {} : request.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('TOOL_REQUEST_INVALID', 'Tool input must be an object.');
  const rationale = typeof request.rationale === 'string' ? request.rationale.slice(0, 1000) : '';
  const impact = ['read','write','external','destructive','administrative'].includes(request.impact) ? request.impact : 'read';
  const canonical = JSON.stringify({ tool, input });
  const fingerprint = createHash('sha256').update(canonical).digest('hex');
  return {
    id: request.id && typeof request.id === 'string' ? request.id : randomUUID(),
    runId: run.id, workspaceId: run.workspaceId, tool, input: structuredClone(input), rationale, impact,
    requestedAt: new Date().toISOString(), fingerprint,
    idempotencyKey: `${run.id}:${fingerprint}`
  };
}

export function normalizeToolResult(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('TOOL_RESULT_INVALID', 'Tool executor returned an invalid result.', 502);
  if (result.workspaceId && result.workspaceId !== request.workspaceId) fail('TOOL_RESULT_WORKSPACE_MISMATCH', 'Tool result belongs to another workspace.', 502);
  if (result.tool && result.tool !== request.tool) fail('TOOL_RESULT_UNAUTHORIZED', 'Tool result does not match the authorized tool.', 502);
  return {
    requestId: request.id, tool: request.tool, workspaceId: request.workspaceId,
    ok: result.ok !== false, output: result.output ?? null,
    error: result.error ? String(result.error).slice(0, 2000) : null,
    completedAt: new Date().toISOString(), metadata: result.metadata && typeof result.metadata === 'object' ? structuredClone(result.metadata) : {}
  };
}

export function normalizePlannerDecision(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) fail('PLANNER_OUTPUT_INVALID', 'Planner returned no valid decision.', 502);
  const type = decision.type;
  if (!['tool','finish','pause','escalate'].includes(type)) fail('PLANNER_OUTPUT_INVALID', 'Planner decision type is unsupported.', 502);
  const base = { type, rationale: typeof decision.rationale === 'string' ? decision.rationale.slice(0, 1000) : '' };
  if (type === 'tool') return { ...base, request: decision.request };
  if (type === 'finish') return { ...base, result: decision.result ?? null };
  return { ...base, reason: typeof decision.reason === 'string' ? decision.reason.slice(0, 1000) : '' };
}

export function assertRunScope(run, { workspaceId, actor } = {}) {
  if (workspaceId && workspaceId !== run.workspaceId) fail('AGENT_WORKSPACE_MISMATCH', 'Agent run belongs to another workspace.', 403);
  if (actor?.workspaceId && actor.workspaceId !== run.workspaceId) fail('AGENT_WORKSPACE_MISMATCH', 'Actor is outside the agent workspace.', 403);
}
