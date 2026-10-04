import { randomUUID } from 'node:crypto';

export const ROUTING_POLICIES = Object.freeze(['AUTO', 'QUALITY', 'BALANCED', 'FAST', 'LOW_COST']);

export class RouterError extends Error {
  constructor(code, message, { retryable = false, status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RouterError'; this.code = code; this.retryable = retryable; this.status = status;
  }
}

export function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? 0);
  return { inputTokens, outputTokens, totalTokens: Number(usage.totalTokens ?? usage.total_token_count ?? inputTokens + outputTokens) };
}

export function normalizeProviderError(error) {
  if (error instanceof RouterError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ETIMEDOUT') return new RouterError('timeout', 'The AI provider timed out.', { retryable: true, status: 504, cause: error });
  const status = Number(error?.status ?? error?.statusCode ?? 0);
  if (status === 401 || status === 403) return new RouterError('authentication_configuration_error', 'The AI provider is not configured for this service.', { status: 503, cause: error });
  if (status === 429) return new RouterError('rate_limited', 'The AI provider rate limit was reached.', { retryable: true, status: 429, cause: error });
  if (status >= 500) return new RouterError('provider_unavailable', 'The AI provider is temporarily unavailable.', { retryable: true, status: 502, cause: error });
  return new RouterError('internal_error', 'The AI provider request failed.', { status: 502, cause: error });
}

function compatible(entry, request) {
  return entry.enabled !== false && (!request.capability || entry.capabilities?.includes(request.capability)) &&
    (!request.structuredOutput || entry.structuredOutput === true) && (!request.toolUse || entry.toolUse === true);
}

export class ModelRegistry {
  constructor(entries = []) { this.entries = new Map(entries.map(entry => [entry.id, Object.freeze({ ...entry, capabilities: [...(entry.capabilities ?? [])] })])); }
  register(entry) {
    if (!entry?.id || !entry.provider || !entry.model) throw new TypeError('A model entry requires id, provider, and model.');
    this.entries.set(entry.id, Object.freeze({ ...entry, enabled: entry.enabled !== false, capabilities: [...(entry.capabilities ?? [])] }));
    return this.entries.get(entry.id);
  }
  get(id) { return this.entries.get(id) ?? null; }
  list() { return [...this.entries.values()]; }
}

export function createWorkspacePolicyLoader(db) {
  if (!db?.query) throw new TypeError('A database client is required.');
  return async workspaceId => {
    const result = await db.query('SELECT model_routes FROM workspace_control_settings WHERE workspace_id=$1', [workspaceId]);
    return result.rows[0]?.model_routes ?? {};
  };
}

export class ModelRouter {
  constructor({ registry, adapters = {}, policies = {}, policyLoader = null, usageRecorder = null, health = null, now = () => Date.now(), maxAttempts = 3, logger = null } = {}) {
    this.registry = registry ?? new ModelRegistry(); this.adapters = adapters; this.policies = policies; this.policyLoader = policyLoader;
    this.usageRecorder = usageRecorder; this.health = health ?? new Map(); this.now = now; this.maxAttempts = Math.max(1, Math.min(5, Number(maxAttempts) || 3)); this.logger = logger;
  }
  async policyFor(workspaceId) { return (this.policyLoader ? await this.policyLoader(workspaceId) : this.policies[workspaceId] ?? this.policies.default ?? {}); }
  async candidates(request) {
    const policy = await this.policyFor(request.workspaceId); const requestedProvider = request.provider ?? policy.defaultProvider;
    const requestedModel = request.model ?? policy.defaultModel; const allowedProviders = policy.allowedProviders ?? null; const allowedModels = policy.allowedModels ?? null;
    const entries = this.registry.list().filter(entry => compatible(entry, request) && (!allowedProviders || allowedProviders.includes(entry.provider)) && (!allowedModels || allowedModels.includes(entry.id) || allowedModels.includes(entry.model)) && (!requestedProvider || entry.provider === requestedProvider) && (!requestedModel || entry.id === requestedModel || entry.model === requestedModel));
    if (requestedProvider && !entries.some(entry => entry.provider === requestedProvider)) throw new RouterError('unsupported_model', 'The requested provider is not permitted or available.');
    if (requestedModel && !entries.length) throw new RouterError('unsupported_model', 'The requested model is not permitted or available.');
    if (!entries.length) throw new RouterError(request.capability ? 'unsupported_capability' : 'unsupported_model', 'No enabled model satisfies this request.');
    const policyName = request.policy ?? policy.strategy ?? 'AUTO'; if (!ROUTING_POLICIES.includes(policyName)) throw new RouterError('internal_error', 'Unknown routing policy.');
    const sorted = [...entries].sort((a, b) => policyName === 'FAST' ? (a.latencyRank ?? 99) - (b.latencyRank ?? 99) : policyName === 'LOW_COST' ? (a.costRank ?? 99) - (b.costRank ?? 99) : policyName === 'QUALITY' ? (b.qualityRank ?? 0) - (a.qualityRank ?? 0) : (a.priority ?? 99) - (b.priority ?? 99));
    return sorted.filter(entry => !this.isOpen(entry.id)).slice(0, this.maxAttempts);
  }
  isOpen(id) { const state = this.health.get(id); return state?.openUntil > this.now(); }
  markFailure(id, error) { if (!error.retryable) return; const prior = this.health.get(id) ?? { failures: 0 }; const failures = prior.failures + 1; this.health.set(id, { failures, openUntil: failures >= 2 ? this.now() + 30_000 : 0 }); }
  markSuccess(id) { this.health.delete(id); }
  async execute(request) {
    if (!request?.workspaceId || !Array.isArray(request.messages ?? request.input)) throw new RouterError('internal_error', 'workspaceId and input are required.');
    const candidates = await this.candidates(request); let lastError = null; const attempts = [];
    for (const entry of candidates) {
      const adapter = this.adapters[entry.provider]; if (!adapter?.execute) { lastError = new RouterError('provider_unavailable', `No adapter is configured for ${entry.provider}.`, { retryable: true, status: 503 }); this.markFailure(entry.id, lastError); continue; }
      const started = this.now();
      try {
        const result = await adapter.execute({ ...request, messages: request.messages ?? request.input, provider: entry.provider, model: entry.model, timeout: Math.min(Math.max(Number(request.timeout ?? 30_000), 1), 120_000) });
        if (!result || typeof result.output !== 'string') throw new RouterError('invalid_provider_response', 'The AI provider returned an invalid response.');
        let structuredOutput = result.structuredOutput;
        if (request.structuredOutput && structuredOutput === undefined) {
          try { structuredOutput = JSON.parse(result.output); } catch (error) { throw new RouterError('invalid_provider_response', 'The provider returned invalid structured output.', { cause: error }); }
        }
        const normalized = { provider: entry.provider, model: entry.model, output: result.output, structuredOutput, usage: normalizeUsage(result.usage), finishReason: result.finishReason ?? null, latency: this.now() - started, warnings: result.warnings ?? [], attempts: attempts.length + 1, requestId: result.requestId ?? randomUUID() };
        if (this.usageRecorder) await this.usageRecorder({ workspaceId: request.workspaceId, provider: normalized.provider, model: normalized.model, usage: normalized.usage, latency: normalized.latency, metadata: request.metadata ?? {} });
        this.markSuccess(entry.id); this.logger?.({ event: 'ai.route.success', workspaceId: request.workspaceId, provider: entry.provider, model: entry.model, attempts: normalized.attempts, latency: normalized.latency }); return normalized;
      } catch (error) {
        lastError = normalizeProviderError(error); attempts.push({ provider: entry.provider, model: entry.model, code: lastError.code }); this.markFailure(entry.id, lastError);
        this.logger?.({ event: 'ai.route.failure', workspaceId: request.workspaceId, provider: entry.provider, model: entry.model, code: lastError.code, attempts: attempts.length });
        if (!lastError.retryable || request.allowFallback === false) throw lastError;
      }
    }
    throw lastError ?? new RouterError('provider_unavailable', 'No provider is available.', { retryable: true, status: 503 });
  }
}

export class FakeProviderAdapter {
  constructor({ provider = 'fake', responses = [], error = null, delayMs = 0 } = {}) { this.provider = provider; this.responses = [...responses]; this.error = error; this.delayMs = delayMs; this.calls = []; }
  async execute(request) { this.calls.push(request); if (this.delayMs) await new Promise(resolve => setTimeout(resolve, this.delayMs)); if (this.error) throw this.error; return this.responses.shift() ?? { output: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }; }
}
