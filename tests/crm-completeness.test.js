import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const server = fs.readFileSync(path.join(root, 'backend/src/server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'frontend/public/app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');

test('CRM lead lifecycle exposes isolated trash, bulk actions and restore', () => {
  assert.match(server, /suffix === 'leads\/trash'/);
  assert.match(server, /suffix === 'leads\/bulk'/);
  assert.match(server, /LEAD_NOT_IN_TRASH/);
  assert.match(server, /lead\.restored/);
  assert.match(server, /requirePermission\(context, 'crm:write'\)/);
});

test('CRM UI exposes trash restore and visible task completion', () => {
  assert.match(index, /data-view="trash"/);
  assert.match(app, /async function renderTrash/);
  assert.match(app, /data-action="restore-lead"/);
  assert.match(app, /data-action="complete-task"/);
  assert.match(app, /const checkbox = event\.target\.matches/);
});

test('existing configurable CRM surfaces remain wired', () => {
  assert.match(app, /async function renderPipelines/);
  assert.match(app, /async function renderAutomations/);
  assert.match(app, /workspacePath\('automations'\)/);
  assert.match(app, /workspacePath\('pipelines'\)/);
});

test('CRM daily workspace and builder contracts are present', () => {
  assert.match(app, /async function renderToday/);
  assert.match(app, /leadEditForm/);
  assert.match(app, /select-all-leads/);
  assert.match(app, /Conditions JSON/);
  assert.match(app, /waitMinutes/);
  assert.match(server, /operation === 'status'/);
  assert.match(server, /operation === 'owner'/);
});
