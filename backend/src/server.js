import http from 'node:http';
import { handleCrmPlatform } from './crm-platform.js';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { pool, transaction, closeDatabase } from './db.js';
import { config } from './config.js';
import { audit } from './audit.js';
import { createSession, setSessionCookies, clearSessionCookies, readSession, requireCsrf, assertSameOrigin } from './auth.js';
import { hashPassword, verifyPassword, hashToken, safeEqual } from './password.js';
import { requirePermission } from './rbac.js';
import { loginByIp, loginByEmail, bootstrapByIp } from './rate-limit.js';
import { quoteUsage } from './pricing.js';
import { ValidationError, decimal, objectBody, requiredString, optionalString, uuid, enumValue, finiteNumber, isoDate, slug, normalizeEmail, normalizePhone, parseCursor, makeCursor } from './validation.js';
import { communications, calling } from './providers.js';
import { AIGateway } from './ai-gateway.js';
import { OPENAPI_SPEC } from './openapi.js';
import { normalizeAutomationGraph } from './automation-graph.js';
import { parseCsv, serializeCsv } from './csv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, '../../frontend/public');
const MEMBER_ROLES = ['owner', 'admin', 'manager', 'agent', 'reporting', 'service'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const CHANNELS = ['email', 'sms', 'whatsapp', 'rcs', 'voice'];
const CALL_DIRECTIONS = ['inbound', 'outbound'];
const CALL_STATUSES = ['queued', 'ringing', 'answered', 'missed', 'busy', 'failed', 'cancelled'];
const ACTIVITY_TYPES = ['call', 'email', 'whatsapp', 'rcs', 'meeting', 'note', 'status_change', 'system'];
const AUTOMATION_ACTIONS = ['create_task', 'create_activity', 'change_stage', 'create_message_draft', 'wait', 'update_lead', 'assign_owner', 'create_note', 'invoke_ai', 'schedule_follow_up', 'send_communication', 'start_call'];
const LEAD_CSV_FIELDS = [
  { key: 'firstName', label: 'First Name', aliases: ['first', 'firstname', 'given name'] },
  { key: 'lastName', label: 'Last Name', aliases: ['last', 'lastname', 'surname', 'family name'] },
  { key: 'email', label: 'Email', aliases: ['email address'] },
  { key: 'phone', label: 'Phone', aliases: ['phone number', 'mobile', 'mobile number'] },
  { key: 'companyName', label: 'Company', aliases: ['company name', 'organization', 'organisation'] },
  { key: 'brandProject', label: 'Project', aliases: ['brand project', 'project name'] },
  { key: 'opportunityType', label: 'Opportunity Type', aliases: ['opportunity', 'deal type'] },
  { key: 'budget', label: 'Budget', aliases: ['deal size', 'amount'] },
  { key: 'location', label: 'Location', aliases: ['city', 'region'] },
  { key: 'status', label: 'Status', aliases: ['lead status'] },
  { key: 'temperature', label: 'Temperature', aliases: ['lead temperature'] },
  { key: 'score', label: 'Score', aliases: ['lead score'] },
  { key: 'nextAction', label: 'Next Action', aliases: ['next step'] },
  { key: 'nextActionAt', label: 'Next Follow-up', aliases: ['next follow up', 'follow-up date', 'follow up date'] },
  { key: 'requirement', label: 'Requirement', aliases: ['requirements'] },
  { key: 'notes', label: 'Notes', aliases: ['note'] },
  { key: 'doNotContact', label: 'Do Not Contact', aliases: ['do not call', 'dnc'] }
];
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon']
]);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers });
  response.end(body);
}

function sendCsv(response, filename, headers, rows) {
  const body = serializeCsv(headers, rows);
  response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function csvHeaderKey(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function leadCsvPlan(headers, customFields = []) {
  const headerByKey = new Map(headers.map(header => [csvHeaderKey(header), header]));
  const fields = [
    ...LEAD_CSV_FIELDS.map(field => ({ key: field.key, label: field.label, required: false })),
    ...customFields.map(field => ({ key: `custom:${field.id}`, label: `Custom: ${field.label}`, required: field.required }))
  ];
  const suggestedMapping = {};
  for (const field of LEAD_CSV_FIELDS) {
    const match = [field.label, ...field.aliases].map(csvHeaderKey).find(key => headerByKey.has(key));
    if (match) suggestedMapping[field.key] = headerByKey.get(match);
  }
  for (const field of customFields) {
    const match = [field.label, field.field_key, `Custom: ${field.label}`].map(csvHeaderKey).find(key => headerByKey.has(key));
    if (match) suggestedMapping[`custom:${field.id}`] = headerByKey.get(match);
  }
  return { fields, suggestedMapping };
}

function secureHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  if (config.isProduction) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function readRawBody(request, maxBytes = config.bodyLimitBytes) {
  if (request.rawBodyPromise) return request.rawBodyPromise;
  request.rawBodyPromise = new Promise((resolve, reject) => {
    const parts = [];
    let bytes = 0;
    let tooLarge = false;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) tooLarge = true;
      else parts.push(chunk);
    });
    request.on('end', () => tooLarge ? reject(new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds the 1 MB limit.')) : resolve(Buffer.concat(parts)));
    request.on('error', reject);
  });
  return request.rawBodyPromise;
}

async function jsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
  const bytes = await readRawBody(request);
  if (!bytes.length) return {};
  try { return objectBody(JSON.parse(bytes.toString('utf8'))); }
  catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
}

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name ?? user.displayName, role: user.role ?? null };
}

function userSafeError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof ValidationError) return new HttpError(400, 'VALIDATION_ERROR', error.message);
  if (error?.status && error?.code) return error;
  if (error?.code === '23505') return new HttpError(409, 'ALREADY_EXISTS', 'A record with these details already exists.');
  if (error?.code === '23503' || error?.code === '23514' || error?.code === '22P02') return new HttpError(400, 'INVALID_REFERENCE', 'One or more referenced values are invalid for this workspace.');
  return new HttpError(500, 'INTERNAL_ERROR', 'The request could not be completed.');
}

async function workspaceSeeds(db, workspaceId) {
  const pipelineDefs = [
    ['Franchise', 'franchise'], ['Realty', 'realty'], ['RedBlack Tech', 'redblack-tech']
  ];
  const stages = [
    ['New Lead', 'new-lead', false, false], ['Contact Attempted', 'contact-attempted', false, false],
    ['Connected', 'connected', false, false], ['Qualified', 'qualified', false, false],
    ['Meeting / Presentation', 'meeting-presentation', false, false], ['Proposal', 'proposal', false, false],
    ['Negotiation', 'negotiation', false, false], ['Won', 'won', true, false], ['Lost', 'lost', false, true]
  ];
  for (const [name, pipelineSlug] of pipelineDefs) {
    const pipeline = await db.query(
      'INSERT INTO pipelines(workspace_id, name, slug) VALUES($1, $2, $3) ON CONFLICT(workspace_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [workspaceId, name, pipelineSlug]
    );
    for (const [stageName, stageSlug, won, lost] of stages) {
      await db.query(
        `INSERT INTO pipeline_stages(pipeline_id, name, slug, position, is_won, is_lost)
         VALUES($1, $2, $3, $4, $5, $6) ON CONFLICT(pipeline_id, slug) DO NOTHING`,
        [pipeline.rows[0].id, stageName, stageSlug, stages.findIndex(item => item[1] === stageSlug), won, lost]
      );
    }
  }
  await installDefaultAutomations(db, workspaceId, null);
}

async function installDefaultAutomations(db, workspaceId, createdBy) {
  const defaults = [
    { name: 'New lead first follow-up', triggerType: 'lead.created', triggerConfig: {}, actions: [{ type: 'create_task', config: { title: 'First follow-up call', description: 'Call the new lead and record the outcome.', dueInMinutes: 60, assignTo: 'owner' } }] },
    { name: 'Stage change follow-up', triggerType: 'lead.stage_changed', triggerConfig: {}, actions: [{ type: 'create_task', config: { title: 'Follow up after stage change', dueInMinutes: 1440, assignTo: 'owner' } }] },
    { name: 'Completed task next action', triggerType: 'task.completed', triggerConfig: {}, actions: [{ type: 'create_task', config: { title: 'Plan the next follow-up', dueInMinutes: 1440, assignTo: 'owner' } }] },
    { name: 'Meeting created follow-up', triggerType: 'meeting.created', triggerConfig: {}, actions: [{ type: 'create_task', config: { title: 'Prepare meeting follow-up', dueInMinutes: 1440, assignTo: 'owner' } }] },
    { name: 'No response follow-up', triggerType: 'lead.no_response', triggerConfig: { afterMinutes: 1440 }, actions: [{ type: 'create_task', config: { title: 'Try the lead again after no response', dueInMinutes: 0, assignTo: 'owner' } }] }
  ];
  for (const definition of defaults) {
    const existing = await db.query('SELECT id FROM automations WHERE workspace_id=$1 AND name=$2 LIMIT 1', [workspaceId, definition.name]);
    if (existing.rows[0]) continue;
    const automation = await db.query('INSERT INTO automations(workspace_id,name,description,active,trigger_type,trigger_config,created_by) VALUES($1,$2,$3,false,$4,$5::jsonb,$6) ON CONFLICT (workspace_id,name) DO NOTHING RETURNING id', [workspaceId, definition.name, 'RedBlack Core default CRM behavior.', definition.triggerType, JSON.stringify(definition.triggerConfig), createdBy]);
    if (!automation.rows[0]) continue;
    const version = await db.query('INSERT INTO automation_versions(workspace_id,automation_id,version_number,definition,created_by) VALUES($1,$2,1,$3::jsonb,$4) RETURNING id', [workspaceId, automation.rows[0].id, JSON.stringify(definition), createdBy]);
    await db.query('UPDATE automations SET current_version_id=$3, active=true WHERE workspace_id=$1 AND id=$2', [workspaceId, automation.rows[0].id, version.rows[0].id]);
  }
}

export async function ensureDefaultAutomations(db = pool) {
  const uniquenessIndex = await db.query(`
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'automations_workspace_name_key'
  `);
  if (!uniquenessIndex.rows[0]) {
    throw new Error('Required automation uniqueness index is missing. Run database migrations before starting Core.');
  }
  const workspaces = await db.query("SELECT id FROM workspaces WHERE status='active'");
  for (const workspace of workspaces.rows) await installDefaultAutomations(db, workspace.id, null);
}

function ipOf(request) {
  // The container is private behind the managed edge. Only enable this when that edge replaces X-Real-IP.
  if (config.trustProxy) {
    const forwarded = String(request.headers['x-real-ip'] ?? '').trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(forwarded) || /^[0-9a-f:]+$/i.test(forwarded)) return forwarded;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function setRateLimit(response, result) {
  if (!result.allowed) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
  }
}

function workspaceContext(session, workspaceId) {
  if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  uuid(workspaceId, 'workspaceId');
  if (!session.workspaceId || session.workspaceId !== workspaceId || !session.role) {
    throw new HttpError(403, 'WORKSPACE_CONTEXT_REQUIRED', 'Select an active workspace with an authorized membership.');
  }
  return session;
}

async function leadVisible(db, context, leadId) {
  const result = await db.query(
    `SELECT l.id FROM leads l
      WHERE l.workspace_id = $1 AND l.id = $2 AND l.deleted_at IS NULL
        AND ($3 <> 'agent' OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.workspace_id = l.workspace_id AND a.lead_id = l.id AND a.user_id = $4 AND a.unassigned_at IS NULL))`,
    [context.workspaceId, leadId, context.role, context.userId]
  );
  if (!result.rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND', 'Lead was not found in this workspace.');
}

async function trashedLeadVisible(db, context, leadId) {
  const result = await db.query(
    `SELECT l.id FROM leads l
      WHERE l.workspace_id = $1 AND l.id = $2 AND l.deleted_at IS NOT NULL
        AND ($3 <> 'agent' OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.workspace_id = l.workspace_id AND a.lead_id = l.id AND a.user_id = $4 AND a.unassigned_at IS NULL))`,
    [context.workspaceId, leadId, context.role, context.userId]
  );
  if (!result.rows[0]) throw new HttpError(404, 'LEAD_NOT_IN_TRASH', 'The lead is not available in this workspace trash.');
}

function cursorFor(requestUrl) {
  if (!requestUrl.searchParams.has('cursor')) return null;
  const cursor = parseCursor(requestUrl.searchParams.get('cursor'));
  if (!cursor) throw new HttpError(400, 'INVALID_CURSOR', 'Pagination cursor is invalid.');
  return cursor;
}

function pageSize(requestUrl) {
  const raw = requestUrl.searchParams.get('limit');
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new HttpError(400, 'INVALID_LIMIT', 'limit must be between 1 and 100.');
  return value;
}

function booleanInput(value, field, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean.`, field);
  return value;
}

function parseIdempotency(request) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply an Idempotency-Key header containing 8–200 characters.');
  }
  return key;
}

async function serveStatic(request, response, pathname) {
  if (pathname === '/app') {
    response.writeHead(308, { Location: '/app/' });
    response.end();
    return true;
  }
  if (pathname !== '/app/' && !pathname.startsWith('/app/')) return false;
  const relative = pathname === '/app/' ? 'index.html' : decodeURIComponent(pathname.slice('/app/'.length));
  if (relative.includes('..') || relative.includes('\0')) throw new HttpError(400, 'INVALID_PATH', 'Invalid path.');
  const file = path.resolve(staticRoot, relative);
  if (!file.startsWith(`${staticRoot}${path.sep}`)) throw new HttpError(400, 'INVALID_PATH', 'Invalid path.');
  try {
    await access(file);
    const info = await stat(file);
    if (!info.isFile()) return false;
    secureHeaders(response);
    response.writeHead(200, { 'Content-Type': MIME.get(path.extname(file)) ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
    createReadStream(file).pipe(response);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

function buildLeadCursor(row) { return makeCursor(row.created_at, row.id); }

export function createRedBlackServer({ db = pool, communicationAdapters = communications, callingAdapters = calling } = {}) {
  const server = http.createServer(async (request, response) => {
    secureHeaders(response);
    const requestId = randomBytes(12).toString('hex');
    response.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(request.url, config.appBaseUrl);
      const pathname = url.pathname === '/app/' ? '/app/' : (url.pathname.replace(/\/+$/, '') || '/');
      if (request.method === 'OPTIONS') { response.writeHead(204, { Allow: 'GET,POST,PATCH,DELETE,OPTIONS' }); response.end(); return; }
      if (request.method === 'GET' && pathname === '/health/live') { sendJson(response, 200, { status: 'ok' }); return; }
      if (request.method === 'GET' && pathname === '/health/ready') {
        await db.query('SELECT 1'); sendJson(response, 200, { status: 'ready' }); return;
      }
      if (request.method === 'GET' && pathname === '/api/v1/openapi.json') {
        sendJson(response, 200, OPENAPI_SPEC, { 'Cache-Control': 'public, max-age=300' }); return;
      }
      if (await serveStatic(request, response, pathname)) return;
      if (!pathname.startsWith('/api/v1/')) throw new HttpError(404, 'NOT_FOUND', 'Route was not found.');

      if (!pathname.startsWith('/api/v1/webhooks/')) assertSameOrigin(request);
      let sessionPromise;
      const session = async () => sessionPromise ??= readSession(db, request);
      const identity = async () => {
        const current = await session();
        if (!current) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
        return current;
      };
      const protectMutation = async current => {
        if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) return;
        const currentSession = current ?? await identity();
        requireCsrf(currentSession, request);
      };
      const body = async () => jsonBody(request);

      if (request.method === 'POST' && pathname === '/api/v1/auth/bootstrap') {
        setRateLimit(response, bootstrapByIp.take(ipOf(request)));
        const input = await body();
        if (!config.bootstrapToken || !safeEqual(String(request.headers['x-bootstrap-token'] ?? ''), config.bootstrapToken)) {
          throw new HttpError(404, 'BOOTSTRAP_UNAVAILABLE', 'Initial workspace setup is not available.');
        }
        const email = normalizeEmail(requiredString(input.email, 'email', { max: 320 }));
        const displayName = requiredString(input.displayName, 'displayName', { max: 120 });
        const passwordHash = await hashPassword(requiredString(input.password, 'password', { min: 12, max: 1024 }));
        const workspaceName = requiredString(input.workspaceName, 'workspaceName', { max: 120 });
        const workspaceSlug = slug(input.workspaceSlug);
        const result = await transaction(db, async client => {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['redblack-core-first-owner']);
          const owner = await client.query("SELECT 1 FROM workspace_members WHERE role = 'owner' LIMIT 1");
          if (owner.rows.length) throw new HttpError(409, 'ALREADY_INITIALIZED', 'An owner account already exists.');
          const user = await client.query(
            `INSERT INTO users(email, display_name, password_hash) VALUES($1, $2, $3) RETURNING id, email, display_name`,
            [email, displayName, passwordHash]
          );
          const workspace = await client.query(
            `INSERT INTO workspaces(name, slug) VALUES($1, $2) RETURNING id, name, slug`, [workspaceName, workspaceSlug]
          );
          await client.query("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1, $2, 'owner')", [workspace.rows[0].id, user.rows[0].id]);
          await workspaceSeeds(client, workspace.rows[0].id);
          await audit(client, { workspaceId: workspace.rows[0].id, actorUserId: user.rows[0].id, action: 'auth.bootstrap', entityType: 'workspace', entityId: workspace.rows[0].id, request });
          return { user: user.rows[0], workspace: workspace.rows[0] };
        });
        const created = await createSession(db, { userId: result.user.id, workspaceId: result.workspace.id });
        setSessionCookies(response, created.token, created.csrf, created.expiresAt);
        sendJson(response, 201, { user: publicUser(result.user), workspace: result.workspace }); return;
      }

      if (request.method === 'POST' && pathname === '/api/v1/auth/login') {
        setRateLimit(response, loginByIp.take(ipOf(request)));
        const input = await body();
        const email = normalizeEmail(requiredString(inpu…51071 tokens truncated…way.complete({ workspaceId: 'w1', messages: [], toolCalls: true }), error => error.code === 'AI_REQUEST_INVALID');
  await assert.rejects(() => providerAdapter('gemini', { env: { GEMINI_API_KEY: 'x' } }).complete({ model: 'm', messages: [], processing: 'flex' }), /not supported/);
});
