/** Provider neutral AI gateway. Network access and credentials stay at this boundary. */
import { randomUUID } from 'node:crypto';
const PROVIDERS = new Set(['openai', 'gemini', 'anthropic']);
const PROCESSING = new Set(['standard', 'flex', 'batch']);

const envKey = provider => ({ openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[provider]);

function missingCredential(provider) {
  const error = new Error(`AI provider ${provider} is not configured.`);
  error.code = 'AI_PROVIDER_UNAVAILABLE';
  error.status = 503;
  return error;
}

function normalizeUsage(usage = {}) {
  return { inputTokens: Number(usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokenCount ?? 0), outputTokens: Number(usage.outputTokens ?? usage.completion_tokens ?? usage.candidatesTokenCount ?? 0), totalTokens: Number(usage.totalTokens ?? usage.total_token_count ?? 0) };
}

function normalizeResponse(provider, model, response, usage, requestId = null) {
  return { provider, model, requestId, text: response.text ?? '', finishReason: response.finishReason ?? null, usage: normalizeUsage(usage) };
}

export function providerAdapter(provider, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported AI provider: ${provider}`);
  const key = env[envKey(provider)];
  return {
    provider,
    async complete({ model, messages, processing = 'standard', signal }) {
      if (!key) throw missingCredential(provider);
      if (typeof fetchImpl !== 'function') throw new Error('AI fetch implementation is unavailable.');
      let url; let headers = { 'content-type': 'application/json' }; let body;
      if (provider === 'openai') { url = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/chat/completions'; headers.authorization = `Bearer ${key}`; body = { model, messages, ...(processing === 'batch' ? { endpoint: '/v1/chat/completions' } : {}) }; }
      if (provider === 'gemini') { url = `${env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`; body = { contents: [{ role: 'user', parts: [{ text: messages.map(m => m.content).join('\n') }] }] }; }
      if (provider === 'anthropic') { url = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; body = { model, max_tokens: 4096, messages }; }
      const result = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!result.ok) { const error = new Error(`AI provider ${provider} request failed (${result.status}).`); error.code = 'AI_PROVIDER_ERROR'; error.status = result.status >= 500 ? 502 : 400; throw error; }
      const payload = await result.json();
      const text = provider === 'openai' ? payload.choices?.[0]?.message?.content : provider === 'gemini' ? payload.candidates?.[0]?.content?.parts?.map(p => p.text).join('') : payload.content?.map(p => p.text).join('');
      const usage = provider === 'openai' ? payload.usage : provider === 'gemini' ? payload.usageMetadata : payload.usage;
      return normalizeResponse(provider, model, { text, finishReason: payload.choices?.[0]?.finish_reason ?? payload.candidates?.[0]?.finishReason }, usage, result.headers.get('x-request-id'));
    }
  };
}

function routesFromEnv(env) {
  try { return JSON.parse(env.AI_MODEL_ROUTES ?? '{}'); } catch { return {}; }
}

export class AIGateway {
  constructor({ db = null, env = process.env, adapters = {}, routes = routesFromEnv(env), rates = {} } = {}) { this.db = db; this.env = env; this.routes = routes; this.rates = rates; this.adapters = Object.fromEntries([...PROVIDERS].map(p => [p, adapters[p] ?? providerAdapter(p, { env })])); }
  route({ workspaceId, model, processing = 'standard' }) {
    if (!PROCESSING.has(processing)) throw new Error(`Unsupported processing strategy: ${processing}`);
    const configured = this.routes[workspaceId] ?? this.routes.default ?? {};
    const candidates = configured[processing] ?? configured.models ?? this.env.AI_DEFAULT_MODEL ?? 'openai:gpt-4o-mini';
    const list = Array.isArray(candidates) ? candidates : [candidates];
    return list.map(item => { const [provider, selectedModel] = String(item).split(':'); return { provider, model: model ?? selectedModel }; });
  }
  async complete({ workspaceId, userId = null, messages, model = null, processing = 'standard', idempotencyKey = randomUUID(), allowFallback = true, toolCalls = false, signal }) {
    if (!workspaceId) throw new Error('workspaceId is required.');
    const candidates = this.route({ workspaceId, model, processing });
    let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      try {
        const response = await this.adapters[candidate.provider].complete({ model: candidate.model, messages, processing, signal });
        await this.recordUsage({ workspaceId, userId, idempotencyKey, response, processing });
        return response;
      } catch (error) { lastError = error; if (!allowFallback || toolCalls || index === candidates.length - 1) throw error; }
    }
    throw lastError;
  }
  async recordUsage({ workspaceId, userId, idempotencyKey, response, processing }) {
    if (!this.db) return;
    const total = response.usage.totalTokens || response.usage.inputTokens + response.usage.outputTokens;
    const rate = this.rates[`${response.provider}:${response.model}`] ?? {};
    await this.db.query(`INSERT INTO usage_events(workspace_id, provider, service, usage_type, quantity, unit, provider_cost, idempotency_key, metadata) VALUES($1,$2,'ai_gateway','tokens',$3,'token',$4,$5,$6) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING`, [workspaceId, response.provider, total, (response.usage.inputTokens * Number(rate.input ?? 0)) + (response.usage.outputTokens * Number(rate.output ?? 0)), idempotencyKey, JSON.stringify({ model: response.model, processing, userId })]);
  }
}

export { missingCredential, normalizeUsage };
