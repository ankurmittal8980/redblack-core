import { createHash, randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { hasPermission } from './rbac.js';
import { recordUsage } from './usage-engine.js';
import { ModelRegistry, ModelRouter, RouterError, normalizeUsage } from './model-router.js';
import { createProviderAdapters } from './provider-adapters.js';
import { CapabilityLayer } from './ai-capabilities.js';

const PROVIDERS = new Set(['openai', 'gemini', 'anthropic']);
const PROCESSING = new Set(['standard', 'flex', 'batch']);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export { normalizeUsage };
export function missingCredential(provider) { return fail('AI_PROVIDER_UNAVAILABLE', `AI provider ${provider} is not configured.`, 503); }

// Compatibility shim; canonical provider HTTP ownership is provider-adapters.js.
export function providerAdapter(provider, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!PROVIDERS.has(provider)) throw fail('AI_PROVIDER_UNSUPPORTED', `Unsupported AI provider: ${provider}`);
  const adapter = createProviderAdapters({ env, fetchImpl })[provider];
  return { provider, async complete(request) {
    if (request.processing === 'batch' || (request.processing === 'flex' && provider !== 'openai')) throw fail('AI_PROCESSING_UNSUPPORTED', `${request.processing} is not supported by ${provider}.`);
    const result = await adapter.execute(request);
    return { provider, model: request.model, text: result.output, finishReason: result.finishReason, requestId: result.requestId, usage: normalizeUsage(result.usage) };
  } };
}

function validateRequest(input) {
  if (!input?.workspaceId || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 100) throw fail('AI_REQUEST_INVALID', 'workspaceId and 1-100 messages are required.');
  if (input.messages.some(item => !item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string')) throw fail('AI_REQUEST_INVALID', 'Messages must contain supported roles and text.');
  if (input.messages.reduce((sum, item) => sum + item.content.length, 0) > 120000) throw fail('AI_INPUT_TOO_LARGE', 'AI input exceeds the configured size limit.', 413);
  if (!PROCESSING.has(input.processing ?? 'standard')) throw fail('AI_PROCESSING_UNSUPPORTED', 'Unsupported processing strategy.');
}

export class AIGateway {
  constructor({ db = null, env = process.env, adapters = {}, routes = {}, timeoutMs = Number(env.AI_REQUEST_TIMEOUT_MS ?? 30000), router = null } = {}) {
    this.db = db; this.env = env; this.routes = routes; this.timeoutMs = timeoutMs;
    this.adapters = Object.fromEntries([...PROVIDERS].map(provider => [provider, adapters[provider] ?? providerAdapter(provider, { env })]));
    this.router = router ?? new ModelRouter({ registry: new ModelRegistry(), adapters: {}, maxAttempts: 3 });
    this.capabilities = new CapabilityLayer({ executor: request => this.complete(request) });
    for (const value of Object.values(routes)) for (const route of (value?.standard ?? value?.models ?? value ?? [])) this.#register(route);
    if (!Object.keys(routes).length) this.#register(env.AI_DEFAULT_MODEL ?? 'openai:gpt-4o-mini');
  }
  #register(route) {
    const [provider, model] = String(route).split(':');
    if (!PROVIDERS.has(provider) || !model) return;
    const id = `${provider}:${model}`;
    if (!this.router.registry.get(id)) this.router.registry.register({ id, provider, model, enabled: true, priority: 1 });
    if (!this.router.adapters[provider]) {
      const adapter = this.adapters[provider];
      this.router.adapters[provider] = { execute: async request => { try { const result = await adapter.complete(request); return { output: result.text ?? result.output ?? '', usage: result.usage, finishReason: result.finishReason, requestId: result.requestId }; } catch (error) { if (error.status == null) error.status = 503; throw error; } } };
    }
  }
  async route({ workspaceId, model, processing = 'standard' }) {
    if (!PROCESSING.has(processing)) throw fail('AI_PROCESSING_UNSUPPORTED', `Unsupported processing strategy: ${processing}.`);
    let configured = this.routes[workspaceId] ?? this.routes.default;
    if (!configured && this.db) configured = (await this.db.query('SELECT model_routes FROM workspace_control_settings WHERE workspace_id=$1', [workspaceId])).rows[0]?.model_routes;
    configured ??= {};
    const candidates = configured[processing] ?? configured.models ?? this.env.AI_DEFAULT_MODEL ?? 'openai:gpt-4o-mini';
    return (Array.isArray(candidates) ? candidates : [candidates]).map(item => { const [provider, selectedModel] = String(item).split(':'); if (!PROVIDERS.has(provider) || !selectedModel) throw fail('AI_ROUTE_INVALID', 'AI model route is invalid.'); return { provider, model: model ?? selectedModel }; });
  }
  async complete(input) {
    validateRequest(input);
    const processing = input.processing ?? 'standard';
    const idempotencyKey = String(input.idempotencyKey ?? randomUUID()).slice(0, 200);
    if (this.db && input.actor) {
      const member = await this.db.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active=true', [input.workspaceId, input.actor.userId]);
      if (!member.rows[0] || member.rows[0].role !== input.actor.role || !hasPermission(input.actor.role, 'crm:read')) throw fail('AI_FORBIDDEN', 'Active workspace membership is required.', 403);
    }
    const requestHash = createHash('sha256').update(JSON.stringify({ capability: input.capability ?? null, messages: input.messages, model: input.model ?? null, processing })).digest('hex');
    if (this.db) {
      const prior = await this.db.query('SELECT * FROM ai_requests WHERE workspace_id=$1 AND idempotency_key=$2', [input.workspaceId, idempotencyKey]);
      if (prior.rows[0]) { if (prior.rows[0].request_hash !== requestHash) throw fail('AI_IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with different input.', 409); if (prior.rows[0].status === 'completed') return prior.rows[0].response; }
      await this.db.query(`INSERT INTO ai_requests(workspace_id,actor_user_id,capability,status,idempotency_key,correlation_id,request_hash) VALUES($1,$2,$3,'running',$4,$5,$6) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`, [input.workspaceId, input.actor?.userId ?? null, input.capability ?? 'unspecified', idempotencyKey, randomUUID(), requestHash]);
    }
    try {
      const candidates = await this.route({ workspaceId: input.workspaceId, model: input.model, processing });
      for (const candidate of candidates) this.#register(`${candidate.provider}:${candidate.model}`);
      const result = await this.router.execute({ workspaceId: input.workspaceId, provider: input.provider, model: input.model, messages: input.messages, capability: input.capability, structuredOutput: input.responseFormat === 'structured', processing, timeout: this.timeoutMs, allowFallback: input.toolCalls !== true });
      const response = { provider: result.provider, model: result.model, text: result.output, finishReason: result.finishReason, usage: normalizeUsage(result.usage), requestId: result.requestId };
      if (this.db) {
        await recordUsage(this.db, { workspaceId: input.workspaceId, provider: response.provider, service: 'ai_gateway', usageType: 'tokens', quantity: String(response.usage.totalTokens || response.usage.inputTokens + response.usage.outputTokens), unit: 'token', idempotencyKey, metadata: { model: response.model, processing, capability: input.capability ?? null } });
        await this.db.query('UPDATE ai_requests SET status=\'completed\',provider=$3,model=$4,response=$5::jsonb,usage=$6::jsonb,completed_at=now() WHERE workspace_id=$1 AND idempotency_key=$2', [input.workspaceId, idempotencyKey, response.provider, response.model, JSON.stringify(response), JSON.stringify(response.usage)]);
        await audit(this.db, { workspaceId: input.workspaceId, actorUserId: input.actor?.userId ?? null, action: 'ai.request_completed', entityType: 'ai_request', request: input.request, metadata: { capability: input.capability ?? null } });
      }
      return response;
    } catch (error) {
      if (this.db) await this.db.query('UPDATE ai_requests SET status=\'failed\',error_code=$3,error_message=$4,completed_at=now() WHERE workspace_id=$1 AND idempotency_key=$2', [input.workspaceId, idempotencyKey, error.code ?? 'AI_FAILED', String(error.message).slice(0, 500)]).catch(() => {});
      if (error instanceof RouterError) throw Object.assign(error, { status: error.status ?? 502 });
      throw error;
    }
  }

  async executeCapability(args) {
    return this.capabilities.executeCapability(args);
  }
}
