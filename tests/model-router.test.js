import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeProviderAdapter, ModelRegistry, ModelRouter, RouterError } from '../backend/src/model-router.js';

const entry = (id, provider, extra = {}) => ({ id, provider, model: id, enabled: true, capabilities: ['classification', 'structured'], structuredOutput: true, priority: 1, ...extra });

test('router selects eligible model and normalizes usage', async () => {
  const fake = new FakeProviderAdapter({ responses: [{ output: '{"ok":true}', usage: { inputTokens: 2, outputTokens: 3 } }] });
  const recorded = []; const router = new ModelRouter({ registry: new ModelRegistry([entry('fake-1', 'fake')]), adapters: { fake }, usageRecorder: event => recorded.push(event) });
  const result = await router.execute({ workspaceId: 'w1', capability: 'classification', structuredOutput: true, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(result.output, '{"ok":true}'); assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  assert.deepEqual(result.structuredOutput, { ok: true }); assert.equal(recorded[0].provider, 'fake');
});

test('disabled and policy-disallowed models are never selected', async () => {
  const fake = new FakeProviderAdapter(); const registry = new ModelRegistry([entry('disabled', 'fake', { enabled: false }), entry('allowed', 'fake')]);
  const router = new ModelRouter({ registry, adapters: { fake }, policies: { w1: { allowedModels: ['allowed'] } } });
  await router.execute({ workspaceId: 'w1', messages: [{ role: 'user', content: 'x' }] }); assert.equal(fake.calls[0].model, 'allowed');
});

test('capability mismatch and invalid explicit model are rejected', async () => {
  const router = new ModelRouter({ registry: new ModelRegistry([entry('basic', 'fake', { capabilities: [] })]), adapters: { fake: new FakeProviderAdapter() } });
  await assert.rejects(() => router.execute({ workspaceId: 'w1', capability: 'tool-use', messages: [] }), error => error.code === 'unsupported_capability');
  await assert.rejects(() => router.execute({ workspaceId: 'w1', model: 'missing', messages: [] }), error => error.code === 'unsupported_model');
});

test('retryable primary failure falls back once; non-retryable failure does not', async () => {
  const primary = new FakeProviderAdapter({ error: new RouterError('rate_limited', 'busy', { retryable: true }) }); const backup = new FakeProviderAdapter();
  const router = new ModelRouter({ registry: new ModelRegistry([entry('a', 'a', { priority: 1 }), entry('b', 'b', { priority: 2 })]), adapters: { a: primary, b: backup } });
  const result = await router.execute({ workspaceId: 'w1', messages: [] }); assert.equal(result.provider, 'b'); assert.equal(backup.calls.length, 1);
  const bad = new ModelRouter({ registry: new ModelRegistry([entry('a', 'a'), entry('b', 'b')]), adapters: { a: new FakeProviderAdapter({ error: new RouterError('invalid_provider_response', 'bad') }), b: backup } });
  await assert.rejects(() => bad.execute({ workspaceId: 'w1', messages: [] }), error => error.code === 'invalid_provider_response'); assert.equal(backup.calls.length, 1);
});

test('structured output and timeout failures are normalized without secrets', async () => {
  const router = new ModelRouter({ registry: new ModelRegistry([entry('bad', 'fake')]), adapters: { fake: new FakeProviderAdapter({ responses: [{ output: 'not-json' }] }) } });
  await assert.rejects(() => router.execute({ workspaceId: 'w1', structuredOutput: true, messages: [] }), error => error.code === 'invalid_provider_response');
  const timeout = new ModelRouter({ registry: new ModelRegistry([entry('slow', 'slow')]), adapters: { slow: { execute: async () => { throw Object.assign(new Error('secret-key-value'), { name: 'AbortError' }); } } } });
  await assert.rejects(() => timeout.execute({ workspaceId: 'w1', messages: [] }), error => error.code === 'timeout' && !error.message.includes('secret'));
});
