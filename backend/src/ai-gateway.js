import { randomUUID } from 'node:crypto';
import { recordUsage } from './usage-engine.js';

const PROVIDERS = new Set(['openai', 'gemini', 'anthropic']);
const PROCESSING = new Set(['standard', 'flex', 'batch']);
const keys = { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

function error(code, message, status) { return Object.assign(new Error(message), { code, status }); }
export function missingCredential(provider) { return error('AI_PROVIDER_UNAVAILABLE', `AI provider ${provider} is not configured.`, 503); }
export function normalizeUsage(u = {}) { return { inputTokens: Number(u.inputTokens ?? u.prompt_tokens ?? u.promptTokenCount ?? 0), outputTokens: Number(u.outputTokens ?? u.completion_tokens ?? u.candidatesTokenCount ?? 0), totalTokens: Number(u.totalTokens ?? u.total_token_count ?? 0) }; }

export function providerAdapter(provider, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  if (!PROVIDERS.has(provider)) throw error('AI_PROVIDER_UNSUPPORTED', `Unsupported AI provider: ${provider}`, 400);
  const key = env[keys[provider]];
  return { provider, async complete({ model, messages, processing = 'standard', signal, timeoutMs = 30000 }) {
    if (!key) throw missingCredential(provider);
    if (processing === 'batch' || (processing === 'flex' && provider !== 'openai')) throw error('AI_PROCESSING_UNSUPPORTED', `${processing} is not supported by ${provider}.`, 400);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    let url; const headers = { 'content-type': 'application/json' }; let body;
    if (provider === 'openai') { url = env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/chat/completions'; headers.authorization = `Bearer ${key}`; body = { model, messages, ...(processing === 'flex' ? { service_tier: 'flex' } : {}) }; }
    if (provider === 'gemini') { url = `${env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent`; headers['x-goog-api-key'] = key; body = { contents: [{ role: 'user', parts: [{ text: messages.map(message => message.content).join('\n') }] }] }; }
    if (provider === 'anthropic') { url = env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1/messages'; headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; body = { model, max_tokens: 4096, messages }; }
    try {
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) throw error('AI_PROVIDER_ERROR', `AI provider ${provider} request failed (${response.status}).`, response.status >= 500 ? 502 : 400);
      const payload = await response.json();
      const text = provider === 'openai' ? payload.choices?.[0]?.message?.content : provider === 'gemini' ? payload.candidates?.[0]?.content?.parts?.map(part => part.text).join('') : payload.content?.map(part => part.text).join('');
      const usage = normalizeUsage(provider === 'openai' ? payload.usage : provider === 'gemini' ? payload.usageMetadata : payload.usage);
      return { provider, model, requestId: response.headers.get('x-request-id'), text: text ?? '', finishReason: payload.choices?.[0]?.finish_reason ?? payload.candidates?.[0]?.finishReason ?? null, usage };
    } catch (e) { if (e.name === 'AbortError') throw error('AI_PROVIDER_TIMEOUT', 'AI provider request timed out.', 504); throw e; } finally { clearTimeout(timer); }
  } };
}

export class AIGateway {
  constructor({ db = null, env = process.env, adapters = {}, routes = {}, timeoutMs = Number(env.AI_REQUEST_TIMEOUT_MS ?? 30000) } = {}) {
    this.db = db; this.env = env; this.routes = routes; this.timeoutMs = timeoutMs;
    this.adapters = Object.fromEntries([...PROVIDERS].map(provider => [provider, adapters[provider] ?? providerAdapter(provider, { env })]));
  }
  async route({ workspaceId, model, processing = 'standard' }) {
    if (!PROCESSING.has(processing)) throw error('AI_PROCESSING_UNSUPPORTED', `Unsupported processing strategy: ${processing}`, 400);
    let configured = this.routes[workspaceId] ?? this.routes.default;
    if (!configured && this.db) configured = (await this.db.query('SELECT model_routes FROM workspace_control_settings WHERE workspace_id=$1', [workspaceId])).rows[0]?.model_routes;
    configured ??= {};
    const candidates = configured[processing] ?? configured.models ?? this.env.AI_DEFAULT_MODEL ?? 'openai:gpt-4o-mini';
    return (Array.isArray(candidates) ? candidates : [candidates]).map(item => { const [provider, selectedModel] = String(item).split(':'); if (!PROVIDERS.has(provider) || !selectedModel) throw error('AI_ROUTE_INVALID', 'AI model route is invalid.', 400); return { provider, model: model ?? selectedModel }; });
  }
  async complete({ workspaceId, userId = null, messages, model = null, processing = 'standard', idempotencyKey = randomUUID(), allowFallback = true, toolCalls = false, signal }) {
    if (!workspaceId || !Array.isArray(messages)) throw error('AI_REQUEST_INVALID', 'workspaceId and messages are required.', 400);
    const candidates = await this.route({ workspaceId, model, processing }); let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const response = await this.adapters[candidates[index].provider].complete({ model: candidates[index].model, messages, processing, signal, timeoutMs: this.timeoutMs });
        if (this.db) await recordUsage(this.db, { workspaceId, provider: response.provider, service: 'ai_gateway', usageType: 'tokens', quantity: String(response.usage.totalTokens || response.usage.inputTokens + response.usage.outputTokens), unit: 'token', idempotencyKey, metadata: { model: response.model, processing, userId } });
        return response;
      } catch (e) { lastError = e; if (!allowFallback || toolCalls || index === candidates.length - 1) throw e; }
    }
    throw lastError;
  }
}
