import { createToolEngine } from '../tool-engine.js';

// Canonical bridge from AgentRunner's provider-neutral tool contract to the
// fixed, server-owned Tool Engine registry. The model never supplies context.
export function createAgentToolExecutor({ db, executors = {}, verifyApproval = null, timeoutMs } = {}) {
  const engine = createToolEngine({ db, executors, verifyApproval, timeoutMs });
  return Object.freeze({
    listTools: () => engine.listTools(),
    async execute({ request, actor, authorization }) {
      const context = {
        workspaceId: actor?.workspaceId,
        actorUserId: actor?.userId,
        role: actor?.role,
        correlationId: actor?.correlationId,
        runId: actor?.runId,
        idempotencyKey: request?.idempotencyKey ?? actor?.idempotencyKey,
        approvalContext: authorization?.approvalContext ?? actor?.approvalContext ?? null
      };
      const result = await engine.execute({ toolName: request?.tool, input: request?.input, context });
      return result.ok
        ? { ok: true, output: result.data, metadata: { toolName: result.toolName } }
        : { ok: false, error: result.error?.code ?? 'TOOL_FAILED', metadata: result };
    }
  });
}

