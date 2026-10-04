import test from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway, providerAdapter } from '../backend/src/ai-gateway.js';

test('AI Gateway routes per workspace, rejects unsupported modes, and blocks tool fallback', async () => {
  const calls = [];
  const gateway = new AIGateway({ routes: { w1: { standard: ['openai:primary', 'anthropic:backup'] } }, adapters: {
    openai: { complete: async () => { calls.push('openai'); throw new Error('failed'); } },
    anthropic: { complete: async () => { calls.push('anthropic'); return { provider: 'anthropic', model: 'backup', text: 'ok', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }; } },
    gemini: { complete: async () => ({}) }
  }});
  const response = await gateway.complete({ workspaceId: 'w1', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(response.provider, 'anthropic'); assert.deepEqual(calls, ['openai', 'anthropic']);
  await assert.rejects(() => gateway.complete({ workspaceId: 'w1', messages: [], toolCalls: true }), error => error.code === 'AI_REQUEST_INVALID');
  await assert.rejects(() => providerAdapter('gemini', { env: { GEMINI_API_KEY: 'x' } }).complete({ model: 'm', messages: [], processing: 'flex' }), /not supported/);
});
