import { RouterError, normalizeUsage } from './model-router.js';

async function requestJson({ fetchImpl, url, headers, body, timeout }) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try { const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal }); if (!response.ok) throw Object.assign(new Error('provider request failed'), { status: response.status }); return await response.json(); }
  finally { clearTimeout(timer); }
}

export function createProviderAdapters({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const key = (name) => env[name];
  const make = (provider, execute) => ({ provider, async execute(request) { if (!key({ openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[provider])) throw new RouterError('authentication_configuration_error', `AI provider ${provider} is not configured.`, { status: 503 }); return execute(request); } });
  return {
    openai: make('openai', async ({ model, messages, timeout }) => { const payload = await requestJson({ fetchImpl, timeout, url: `${env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1/chat/completions'}`, headers: { 'content-type': 'application/json', authorization: `Bearer ${key('OPENAI_API_KEY')}` }, body: { model, messages } }); return { output: payload.choices?.[0]?.message?.content ?? '', usage: normalizeUsage(payload.usage), finishReason: payload.choices?.[0]?.finish_reason }; }),
    gemini: make('gemini', async ({ model, messages, timeout }) => { const payload = await requestJson({ fetchImpl, timeout, url: `${env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent`, headers: { 'content-type': 'application/json', 'x-goog-api-key': key('GEMINI_API_KEY') }, body: { contents: [{ role: 'user', parts: [{ text: messages.map(message => message.content).join('\n') }] }] } }); return { output: payload.candidates?.[0]?.content?.parts?.map(part => part.text).join('') ?? '', usage: normalizeUsage(payload.usageMetadata), finishReason: payload.candidates?.[0]?.finishReason }; }),
    anthropic: make('anthropic', async ({ model, messages, timeout, systemInstructions }) => { const payload = await requestJson({ fetchImpl, timeout, url: `${env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1/messages'}`, headers: { 'content-type': 'application/json', 'x-api-key': key('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' }, body: { model, max_tokens: 4096, ...(systemInstructions ? { system: systemInstructions } : {}), messages } }); return { output: payload.content?.map(part => part.text).join('') ?? '', usage: normalizeUsage(payload.usage), finishReason: payload.stop_reason }; })
  };
}
