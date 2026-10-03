import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  assert.match(app, /Trigger \/ condition JSON/);
  assert.match(app, /automationSteps/);
  assert.match(app, /data-automation-step/);
  assert.match(app, /dragstart/);
  assert.match(app, /automation-runs/);
  assert.match(server, /operation\s*===\s*'status'/);
  assert.match(server, /operation\s*===\s*'owner'/);
});


test('CRM builder exposes custom fields, tags, meetings and import/export', () => {
  assert.match(server, /lead_custom_fields/);
  assert.match(server, /lead_tags/);
  assert.match(server, /leads\/import/);
  assert.match(server, /leads\/export/);
  assert.match(app, /customFieldForm/);
  assert.match(app, /tagForm/);
  assert.match(app, /async function renderMeetings/);
  assert.match(app, /csvImportForm/);
  assert.equal(app.includes("const exportHref = `${apiRoot}${workspacePath('leads/export')}${"), true);
  assert.equal(app.includes("exportParams.set('q', appState.leadSearch)"), true);
  assert.equal(app.includes("leads/import/preview"), true);
  assert.equal(app.includes("download-import-errors"), true);
});

test('pipeline board uses persisted stage state and drag drop movement', () => {
  assert.match(server, /current_stage_id/);
  assert.match(app, /data-drag-lead/);
  assert.match(app, /data-drop-stage/);
  assert.match(app, /bindPipelineDnD/);
});

test('automation conditions support nested all-any comparisons', () => {
  assert.match(server, /function automationCondition/);
  assert.match(server, /Array\.isArray\(node\.all\)/);
  assert.match(server, /Array\.isArray\(node\.any\)/);
  assert.match(server, /operator === '>='/);
});


test('configurable CRM rules and safe destructive controls are wired', () => {
  assert.match(server, /crm_assignment_rules/);
  assert.match(server, /crm_scoring_rules/);
  assert.match(server, /applyLeadRules/);
  assert.match(server, /lead\.permanently_deleted/);
  assert.match(app, /assignmentRuleForm/);
  assert.match(app, /scoringRuleForm/);
  assert.match(app, /purge-lead/);
});

test('bulk CRM actions cover owner stage and tags', () => {
  assert.match(server, /'stage','tags'/);
  assert.match(app, /bulkStage/);
  assert.match(app, /bulkTag/);
  assert.match(app, /bulkOwner/);
});


test('CRM navigation respects role-gated views', () => {
  assert.match(app, /const VIEW_ROLES/);
  assert.match(app, /automations: \['owner','admin','manager'\]/);
  assert.match(app, /workspace: \['owner','admin'\]/);
  assert.match(app, /!viewAllowed\(button\.dataset\.view, appState\.role\)/);
  assert.match(app, /if \(!viewAllowed\(view, appState\.role\)\) view = 'dashboard'/);
});
