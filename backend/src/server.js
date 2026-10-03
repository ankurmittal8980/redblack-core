import http from 'node:http';
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
import { parseCsv } from './csv.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, '../../frontend/public');
const MEMBER_ROLES = ['owner', 'admin', 'manager', 'agent', 'reporting', 'service'];
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const CHANNELS = ['email', 'whatsapp', 'rcs', 'voice'];
const CALL_DIRECTIONS = ['inbound', 'outbound'];
const CALL_STATUSES = ['queued', 'ringing', 'answered', 'missed', 'busy', 'failed', 'cancelled'];
const ACTIVITY_TYPES = ['call', 'email', 'whatsapp', 'rcs', 'meeting', 'note', 'status_change', 'system'];
const AUTOMATION_ACTIONS = ['create_task', 'create_activity', 'change_stage', 'create_message_draft', 'wait', 'update_lead', 'assign_owner', 'create_note', 'invoke_ai', 'schedule_follow_up', 'send_communication', 'start_call'];
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

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sendCsv(response, filename, headers, rows) {
  const body = [headers.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n') + '\r\n';
  response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
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
        const email = normalizeEmail(requiredString(input.email, 'email', { max: 320 }));
        setRateLimit(response, loginByEmail.take(email));
        const userResult = await db.query(
          `SELECT id, email, display_name, password_hash FROM users WHERE email = $1 AND status = 'active'`, [email]
        );
        const user = userResult.rows[0];
        if (!user || !user.password_hash || !(await verifyPassword(String(input.password ?? ''), user.password_hash))) {
          throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
        }
        const memberships = await db.query(
          `SELECT w.id, w.name, w.slug, wm.role FROM workspace_members wm
           JOIN workspaces w ON w.id = wm.workspace_id AND w.status = 'active'
           WHERE wm.user_id = $1 AND wm.active = true ORDER BY w.name`, [user.id]
        );
        if (!memberships.rows.length) throw new HttpError(403, 'NO_WORKSPACE', 'This account has no active workspace.');
        let selected = null;
        if (input.workspaceId) selected = memberships.rows.find(item => item.id === uuid(input.workspaceId, 'workspaceId')) ?? null;
        else if (memberships.rows.length === 1) selected = memberships.rows[0];
        if (input.workspaceId && !selected) throw new HttpError(403, 'WORKSPACE_FORBIDDEN', 'This account cannot access that workspace.');
        const created = await createSession(db, { userId: user.id, workspaceId: selected?.id ?? null });
        setSessionCookies(response, created.token, created.csrf, created.expiresAt);
        sendJson(response, selected ? 200 : 409, {
          user: publicUser(user), role: selected?.role ?? null, workspace: selected,
          workspaces: selected ? undefined : memberships.rows,
          code: selected ? undefined : 'WORKSPACE_SELECTION_REQUIRED'
        }); return;
      }

      if (request.method === 'POST' && pathname === '/api/v1/auth/select-workspace') {
        const current = await identity(); await protectMutation(current);
        const input = await body(); const workspaceId = uuid(input.workspaceId, 'workspaceId');
        const membership = await db.query(
          `SELECT wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
           WHERE wm.workspace_id = $1 AND wm.user_id = $2 AND wm.active = true AND w.status = 'active'`, [workspaceId, current.userId]
        );
        if (!membership.rows[0]) throw new HttpError(403, 'WORKSPACE_FORBIDDEN', 'This account cannot access that workspace.');
        await db.query('UPDATE auth_sessions SET workspace_id = $1 WHERE id = $2', [workspaceId, current.sessionId]);
        sendJson(response, 200, { workspaceId, role: membership.rows[0].role }); return;
      }

      if (request.method === 'POST' && pathname === '/api/v1/auth/logout') {
        const current = await identity(); await protectMutation(current);
        await db.query('DELETE FROM auth_sessions WHERE id = $1', [current.sessionId]);
        clearSessionCookies(response); sendJson(response, 200, { ok: true }); return;
      }

      if (request.method === 'GET' && pathname === '/api/v1/auth/me') {
        const current = await identity();
        let workspace = null;
        if (current.workspaceId) {
          const result = await db.query('SELECT id, name, slug FROM workspaces WHERE id = $1', [current.workspaceId]);
          workspace = result.rows[0] ?? null;
        }
        sendJson(response, 200, { user: { id: current.userId, email: current.email, displayName: current.displayName }, workspace, role: current.role, expiresAt: current.expiresAt }); return;
      }

      const workspaceMatch = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)(?:\/(.*))?$/);
      if (request.method === 'GET' && pathname === '/api/v1/workspaces') {
        const current = await identity();
        const result = await db.query(
          `SELECT w.id, w.name, w.slug, w.timezone, w.currency, wm.role
             FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
            WHERE wm.user_id = $1 AND wm.active = true AND w.status = 'active' ORDER BY w.name`, [current.userId]
        );
        sendJson(response, 200, { data: result.rows }); return;
      }

      if (request.method === 'POST' && pathname === '/api/v1/workspaces') {
        const current = await identity(); await protectMutation(current);
        if (!['owner', 'admin'].includes(current.role)) throw new HttpError(403, 'FORBIDDEN', 'Only an owner or admin may create a workspace.');
        const input = await body();
        const name = requiredString(input.name, 'name', { max: 120 }); const workspaceSlug = slug(input.slug);
        const result = await transaction(db, async client => {
          const workspace = await client.query('INSERT INTO workspaces(name, slug) VALUES($1, $2) RETURNING id, name, slug', [name, workspaceSlug]);
          await client.query("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1, $2, 'owner')", [workspace.rows[0].id, current.userId]);
          await workspaceSeeds(client, workspace.rows[0].id);
          await client.query('UPDATE auth_sessions SET workspace_id = $1 WHERE id = $2', [workspace.rows[0].id, current.sessionId]);
          await audit(client, { workspaceId: workspace.rows[0].id, actorUserId: current.userId, action: 'workspace.created', entityType: 'workspace', entityId: workspace.rows[0].id, request });
          return workspace.rows[0];
        });
        sendJson(response, 201, result); return;
      }

      if (workspaceMatch) {
        const workspaceId = uuid(workspaceMatch[1], 'workspaceId');
        const suffix = workspaceMatch[2] ?? '';
        const current = await identity();
        const context = workspaceContext(current, workspaceId);
        if (['POST', 'PATCH', 'DELETE'].includes(request.method)) await protectMutation(current);

        if (!suffix && request.method === 'GET') {
          const result = await db.query('SELECT id, name, slug, status, timezone, currency, created_at FROM workspaces WHERE id = $1', [workspaceId]);
          if (!result.rows[0]) throw new HttpError(404, 'WORKSPACE_NOT_FOUND', 'Workspace was not found.');
          sendJson(response, 200, result.rows[0]); return;
        }
        if (!suffix && request.method === 'PATCH') {
          requirePermission(context, 'workspace:manage');
          const input = await body(); const sets = []; const values = [workspaceId];
          for (const [key, column] of [['name', 'name'], ['timezone', 'timezone'], ['currency', 'currency']]) {
            if (input[key] !== undefined) { values.push(requiredString(input[key], key, { max: key === 'name' ? 120 : 80 })); sets.push(`${column} = $${values.length}`); }
          }
          if (!sets.length) throw new HttpError(400, 'NO_FIELDS', 'Provide at least one supported field.');
          const result = await db.query(`UPDATE workspaces SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING id, name, slug, timezone, currency`, values);
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'workspace.updated', entityType: 'workspace', entityId: workspaceId, request, metadata: { fields: sets.map(item => item.split(' ')[0]) } });
          sendJson(response, 200, result.rows[0]); return;
        }

        if (suffix === 'members' && request.method === 'GET') {
          requirePermission(context, 'members:manage');
          const result = await db.query(
            `SELECT u.id, u.email, u.display_name, u.status, wm.role, wm.active, wm.joined_at
               FROM workspace_members wm JOIN users u ON u.id = wm.user_id
              WHERE wm.workspace_id = $1 ORDER BY u.display_name`, [workspaceId]
          );
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'members' && request.method === 'POST') {
          requirePermission(context, 'members:manage');
          const input = await body(); const email = normalizeEmail(requiredString(input.email, 'email', { max: 320 }));
          const displayName = requiredString(input.displayName, 'displayName', { max: 120 });
          const passwordHash = await hashPassword(requiredString(input.initialPassword, 'initialPassword', { min: 12, max: 1024 }));
          const role = enumValue(input.role ?? 'agent', 'role', MEMBER_ROLES.filter(value => value !== 'owner'));
          const result = await transaction(db, async client => {
            const inserted = await client.query(
              `INSERT INTO users(email, display_name, password_hash) VALUES($1, $2, $3) RETURNING id, email, display_name`, [email, displayName, passwordHash]
            );
            await client.query('INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1, $2, $3)', [workspaceId, inserted.rows[0].id, role]);
            await audit(client, { workspaceId, actorUserId: current.userId, action: 'workspace.member_created', entityType: 'user', entityId: inserted.rows[0].id, request, metadata: { role } });
            return { ...inserted.rows[0], role };
          });
          sendJson(response, 201, publicUser(result)); return;
        }
        const memberMatch = suffix.match(/^members\/([^/]+)$/);
        if (memberMatch && request.method === 'PATCH') {
          requirePermission(context, 'members:manage');
          const memberId = uuid(memberMatch[1], 'userId'); const input = await body();
          if (memberId === current.userId && input.active === false) throw new HttpError(400, 'SELF_DEACTIVATION', 'You cannot deactivate your own active workspace membership.');
          const fields = []; const values = [workspaceId, memberId];
          if (input.role !== undefined) { values.push(enumValue(input.role, 'role', MEMBER_ROLES.filter(value => value !== 'owner'))); fields.push(`role = $${values.length}`); }
          if (input.active !== undefined) { if (typeof input.active !== 'boolean') throw new ValidationError('active must be a boolean.'); values.push(input.active); fields.push(`active = $${values.length}`); }
          if (!fields.length) throw new HttpError(400, 'NO_FIELDS', 'Provide role or active.');
          const result = await db.query(`UPDATE workspace_members SET ${fields.join(', ')} WHERE workspace_id = $1 AND user_id = $2 RETURNING workspace_id, user_id, role, active`, values);
          if (!result.rows[0]) throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Member was not found.');
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'workspace.member_updated', entityType: 'user', entityId: memberId, request, metadata: { fields: fields.map(item => item.split(' ')[0]) } });
          sendJson(response, 200, result.rows[0]); return;
        }

        if (suffix === 'leads/trash' && request.method === 'GET') {
          requirePermission(context, 'crm:read');
          const cursor = cursorFor(url); const limit = pageSize(url);
          const values = [workspaceId, current.role, current.userId];
          let cursorFilter = '';
          if (cursor) { values.push(cursor[0], cursor[1]); cursorFilter = ` AND (l.deleted_at, l.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`; }
          values.push(limit + 1);
          const result = await db.query(
            `SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone, l.status, l.deleted_at, l.updated_at
               FROM leads l
              WHERE l.workspace_id=$1 AND l.deleted_at IS NOT NULL
                AND ($2 <> 'agent' OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.workspace_id=l.workspace_id AND a.lead_id=l.id AND a.user_id=$3 AND a.unassigned_at IS NULL))
                ${cursorFilter}
              ORDER BY l.deleted_at DESC, l.id DESC LIMIT $${values.length}`, values);
          const hasMore = result.rows.length > limit; const data = result.rows.slice(0, limit);
          sendJson(response, 200, { data, nextCursor: hasMore && data.length ? makeCursor(data.at(-1).deleted_at, data.at(-1).id) : null }); return;
        }

        if (suffix === 'leads/bulk' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body();
          if (!Array.isArray(input.leadIds) || input.leadIds.length < 1 || input.leadIds.length > 100) throw new ValidationError('leadIds must contain 1 to 100 leads.');
          const ids = [...new Set(input.leadIds.map(value => uuid(value, 'leadId')))];
          const operation = enumValue(input.operation, 'operation', ['trash','restore','status','owner','stage','tags']);
          const expectsTrash = operation === 'restore';
          const scoped = await db.query(
            `SELECT id FROM leads WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND ${expectsTrash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'}`,
            [workspaceId, ids]
          );
          if (scoped.rows.length !== ids.length) {
            throw new HttpError(404, expectsTrash ? 'LEAD_NOT_IN_TRASH' : 'LEAD_NOT_FOUND', expectsTrash ? 'One or more leads are not available in this workspace trash.' : 'One or more leads were not found in this workspace.');
          }
          if (context.role === 'agent') {
            const visible = await db.query('SELECT COUNT(*)::int AS count FROM leads l WHERE l.workspace_id=$1 AND l.id=ANY($2::uuid[]) AND EXISTS (SELECT 1 FROM lead_assignments a WHERE a.workspace_id=l.workspace_id AND a.lead_id=l.id AND a.user_id=$3 AND a.unassigned_at IS NULL)', [workspaceId, ids, current.userId]);
            if (visible.rows[0].count !== ids.length) throw new HttpError(403, 'LEAD_SCOPE_FORBIDDEN', 'One or more leads are outside your assignment scope.');
          }
          if (operation === 'owner' && !['owner','admin','manager'].includes(context.role)) throw new HttpError(403, 'OWNER_ASSIGNMENT_FORBIDDEN', 'Your role cannot reassign lead ownership.');
          if (operation === 'restore') {
            const conflicts = await db.query('SELECT l.id FROM leads l JOIN leads active ON active.workspace_id=l.workspace_id AND active.deleted_at IS NULL AND active.id<>l.id AND ((l.email_normalized IS NOT NULL AND active.email_normalized=l.email_normalized) OR (l.phone_normalized IS NOT NULL AND active.phone_normalized=l.phone_normalized)) WHERE l.workspace_id=$1 AND l.id=ANY($2::uuid[]) AND l.deleted_at IS NOT NULL LIMIT 1', [workspaceId, ids]);
            if (conflicts.rows[0]) throw new HttpError(409, 'DUPLICATE_LEAD', 'One or more leads conflict with an active email or phone.');
          }
          let updated = [];
          if (operation === 'stage') {
            const pipelineId=uuid(input.pipelineId,'pipelineId'); const stageId=uuid(input.stageId,'stageId');
            const stage=await db.query('SELECT s.id FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.workspace_id=$1 AND p.id=$2 AND s.id=$3',[workspaceId,pipelineId,stageId]);
            if(!stage.rows[0]) throw new HttpError(400,'INVALID_STAGE','Stage does not belong to this workspace pipeline.');
            await transaction(db, async client => {
              for(const leadId of ids) {
                const prior=await client.query('SELECT current_stage_id FROM lead_pipeline_entries WHERE workspace_id=$1 AND lead_id=$2 AND pipeline_id=$3 AND is_current=true',[workspaceId,leadId,pipelineId]);
                await client.query('UPDATE lead_pipeline_entries SET is_current=false,exited_at=now() WHERE workspace_id=$1 AND lead_id=$2 AND pipeline_id=$3 AND is_current=true',[workspaceId,leadId,pipelineId]);
                await client.query('INSERT INTO lead_pipeline_entries(workspace_id,lead_id,pipeline_id,current_stage_id,is_current) VALUES($1,$2,$3,$4,true)',[workspaceId,leadId,pipelineId,stageId]);
                await client.query('INSERT INTO lead_stage_history(workspace_id,lead_id,pipeline_id,from_stage_id,to_stage_id,changed_by) VALUES($1,$2,$3,$4,$5,$6)',[workspaceId,leadId,pipelineId,prior.rows[0]?.current_stage_id??null,stageId,current.userId]);
                await dispatchAutomationEvent(client,{workspaceId,eventType:'lead.stage_changed',leadId,eventId:`bulk-stage:${leadId}:${stageId}`,actorUserId:current.userId,eventData:{pipelineId,fromStageId:prior.rows[0]?.current_stage_id??null,stageId}});
                updated.push(leadId);
              }
            });
          } else if (operation === 'tags') {
            const tagIds=[...new Set((input.tagIds??[]).map(value=>uuid(value,'tagId')))];
            if(tagIds.length){const valid=await db.query('SELECT id FROM tags WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspaceId,tagIds]);if(valid.rows.length!==tagIds.length)throw new HttpError(400,'INVALID_TAG','One or more tags are invalid.');}
            await transaction(db,async client=>{for(const leadId of ids){await client.query('DELETE FROM lead_tags WHERE workspace_id=$1 AND lead_id=$2',[workspaceId,leadId]);for(const tagId of tagIds)await client.query('INSERT INTO lead_tags(workspace_id,lead_id,tag_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[workspaceId,leadId,tagId]);updated.push(leadId);}});
          } else if (operation === 'owner') {
            const ownerId=uuid(input.ownerId,'ownerId'); const member=await db.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active=true',[workspaceId,ownerId]); if(!member.rows[0])throw new HttpError(400,'ASSIGNEE_NOT_IN_WORKSPACE','Owner must be an active workspace member.');
            await transaction(db,async client=>{for(const leadId of ids){await client.query('UPDATE lead_assignments SET unassigned_at=now() WHERE workspace_id=$1 AND lead_id=$2 AND unassigned_at IS NULL',[workspaceId,leadId]);await client.query('INSERT INTO lead_assignments(workspace_id,lead_id,user_id,assigned_by,reason) VALUES($1,$2,$3,$4,$5)',[workspaceId,leadId,ownerId,current.userId,'Bulk assignment']);await client.query('UPDATE leads SET owner_user_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',[workspaceId,leadId,ownerId]);updated.push(leadId);}});
          } else {
            const status=input.status?requiredString(input.status,'status',{max:80}):null; if(operation==='status'&&!status)throw new ValidationError('status is required.');
            const result=await db.query(operation==='trash'?'UPDATE leads SET deleted_at=COALESCE(deleted_at,now()),updated_at=now() WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL RETURNING id':operation==='restore'?'UPDATE leads SET deleted_at=NULL,updated_at=now() WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NOT NULL RETURNING id':'UPDATE leads SET status=$3,updated_at=now() WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL RETURNING id',operation==='status'?[workspaceId,ids,status]:[workspaceId,ids]);
            updated=result.rows.map(row=>row.id);
          }
          await audit(db,{workspaceId,actorUserId:current.userId,action:`leads.bulk_${operation}`,entityType:'lead',entityId:null,request,metadata:{count:updated.length}});
          sendJson(response,200,{updated,operation}); return;
        }
        if (suffix === 'leads/export' && request.method === 'GET') {
          requirePermission(context, 'crm:read');
          const values = [workspaceId]; let scope = 'l.workspace_id=$1 AND l.deleted_at IS NULL';
          if (context.role === 'agent') { values.push(current.userId); scope += ` AND EXISTS (SELECT 1 FROM lead_assignments a WHERE a.workspace_id=l.workspace_id AND a.lead_id=l.id AND a.user_id=$2 AND a.unassigned_at IS NULL)`; }
          const result = await db.query(`SELECT l.first_name,l.last_name,l.email,l.phone,l.company_name,l.brand_project,l.opportunity_type,l.budget,l.location,l.status,l.temperature,l.score,l.next_action,l.next_action_at,l.created_at FROM leads l WHERE ${scope} ORDER BY l.created_at DESC LIMIT 10000`, values);
          sendCsv(response, 'redblack-leads.csv', ['First Name','Last Name','Email','Phone','Company','Project','Opportunity Type','Budget','Location','Status','Temperature','Score','Next Action','Next Follow-up','Created'], result.rows.map(row => [row.first_name,row.last_name,row.email,row.phone,row.company_name,row.brand_project,row.opportunity_type,row.budget,row.location,row.status,row.temperature,row.score,row.next_action,row.next_action_at,row.created_at])); return;
        }

        if (suffix === 'leads/import' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body();
          const parsed = parseCsv(requiredString(input.csv, 'csv', { max: 900000 }));
          if (parsed.records.length > 5000) throw new ValidationError('A single import is limited to 5,000 rows.');
          const key = name => parsed.headers.find(header => header.trim().toLowerCase() === name.toLowerCase());
          const keys = { first:key('First Name'), last:key('Last Name'), email:key('Email'), phone:key('Phone'), company:key('Company'), project:key('Project'), opportunity:key('Opportunity Type'), budget:key('Budget'), location:key('Location'), status:key('Status') };
          if (!keys.first && !keys.email && !keys.phone) throw new ValidationError('CSV must contain First Name, Email or Phone columns.');
          const summary = { created: 0, skipped: 0, errors: [] };
          for (let index=0; index<parsed.records.length; index += 1) {
            const row = parsed.records[index].values; const email = normalizeEmail(keys.email ? row[keys.email] : null); const phone = normalizePhone(keys.phone ? row[keys.phone] : null);
            try {
              if (email || phone) {
                const duplicate = await db.query('SELECT id FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL AND (($2::text IS NOT NULL AND email_normalized=$2) OR ($3::text IS NOT NULL AND phone_normalized=$3)) LIMIT 1', [workspaceId,email,phone]);
                if (duplicate.rows[0]) { summary.skipped += 1; continue; }
              }
              const budgetRaw = keys.budget ? row[keys.budget] : null; const budget = budgetRaw ? finiteNumber(Number(String(budgetRaw).replaceAll(',','')), 'budget', { min: 0 }) : null;
              const inserted = await db.query(`INSERT INTO leads(workspace_id,first_name,last_name,email,email_normalized,phone,phone_normalized,company_name,brand_project,opportunity_type,budget,location,status)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [workspaceId, keys.first ? optionalString(row[keys.first], 'firstName',120) : null, keys.last ? optionalString(row[keys.last], 'lastName',120) : null, keys.email ? optionalString(row[keys.email], 'email',320) : null, email, keys.phone ? optionalString(row[keys.phone], 'phone',80) : null, phone, keys.company ? optionalString(row[keys.company], 'company',240) : null, keys.project ? optionalString(row[keys.project], 'project',240) : null, keys.opportunity ? optionalString(row[keys.opportunity], 'opportunityType',160) : null, budget, keys.location ? optionalString(row[keys.location], 'location',240) : null, keys.status ? optionalString(row[keys.status], 'status',80) || 'New Lead' : 'New Lead']);
              await dispatchAutomationEvent(db, { workspaceId, eventType:'lead.created', leadId:inserted.rows[0].id, eventId:`csv-import:${inserted.rows[0].id}`, actorUserId:current.userId });
              summary.created += 1;
            } catch (error) { summary.errors.push({ row: index + 2, message: error.message }); if (summary.errors.length >= 100) break; }
          }
          await audit(db, { workspaceId, actorUserId: current.userId, action:'leads.imported', entityType:'lead', entityId:null, request, metadata:summary });
          sendJson(response, 200, summary); return;
        }

        if (suffix === 'leads' && request.method === 'GET') {
          requirePermission(context, 'crm:read');
          const cursor = cursorFor(url); const limit = pageSize(url); const values = [workspaceId]; const filters = ['l.workspace_id = $1', 'l.deleted_at IS NULL'];
          if (url.searchParams.get('status')) { values.push(requiredString(url.searchParams.get('status'), 'status', { max: 80 })); filters.push(`l.status = $${values.length}`); }
          if (url.searchParams.get('pipelineId')) { values.push(uuid(url.searchParams.get('pipelineId'), 'pipelineId')); filters.push(`EXISTS (SELECT 1 FROM lead_pipeline_entries e WHERE e.workspace_id = l.workspace_id AND e.lead_id = l.id AND e.pipeline_id = $${values.length} AND e.is_current)`); }
          if (url.searchParams.get('q')) { values.push(`%${requiredString(url.searchParams.get('q'), 'q', { max: 120 }).replace(/[\\%_]/g, '\\$&')}%`); filters.push(`(l.first_name ILIKE $${values.length} ESCAPE '\\' OR l.last_name ILIKE $${values.length} ESCAPE '\\' OR l.email ILIKE $${values.length} ESCAPE '\\' OR l.phone ILIKE $${values.length} ESCAPE '\\' OR l.company_name ILIKE $${values.length} ESCAPE '\\')`); }
          if (context.role === 'agent') { values.push(current.userId); filters.push(`EXISTS(SELECT 1 FROM lead_assignments a WHERE a.workspace_id=l.workspace_id AND a.lead_id=l.id AND a.user_id=$${values.length} AND a.unassigned_at IS NULL)`); }
          if (cursor) { values.push(cursor[0], cursor[1]); filters.push(`(l.created_at, l.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`); }
          values.push(limit + 1);
          const result = await db.query(
            `SELECT l.id, l.first_name, l.last_name, l.company_name, l.email, l.phone, l.source_id,
                    l.brand_project, l.opportunity_type, l.budget, l.location, l.requirement, l.status,
                    l.temperature, l.score, l.next_action, l.next_action_at, l.owner_user_id, l.created_at, l.updated_at,
                    (SELECT e.current_stage_id FROM lead_pipeline_entries e WHERE e.workspace_id=l.workspace_id AND e.lead_id=l.id AND e.is_current ORDER BY e.entered_at DESC LIMIT 1) AS current_stage_id,
                    (SELECT e.pipeline_id FROM lead_pipeline_entries e WHERE e.workspace_id=l.workspace_id AND e.lead_id=l.id AND e.is_current ORDER BY e.entered_at DESC LIMIT 1) AS current_pipeline_id
               FROM leads l WHERE ${filters.join(' AND ')} ORDER BY l.created_at DESC, l.id DESC LIMIT $${values.length}`,
            values
          );
          const hasMore = result.rows.length > limit; const data = result.rows.slice(0, limit);
          sendJson(response, 200, { data, nextCursor: hasMore ? buildLeadCursor(data.at(-1)) : null }); return;
        }

        if (suffix === 'leads' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body();
          const email = normalizeEmail(input.email); const phone = normalizePhone(input.phone);
          const firstName = optionalString(input.firstName, 'firstName', 120); const lastName = optionalString(input.lastName, 'lastName', 120);
          const sourceId = input.sourceId ? uuid(input.sourceId, 'sourceId') : null;
          const score = input.score === undefined ? 0 : Math.trunc(finiteNumber(input.score, 'score', { min: 0, max: 10000 }));
          const temperature = input.temperature ? enumValue(input.temperature, 'temperature', ['hot', 'warm', 'cold']) : null;
          const duplicates = await db.query(
            `SELECT id, first_name, last_name, email, phone FROM leads WHERE workspace_id = $1 AND deleted_at IS NULL
             AND (($2::text IS NOT NULL AND email_normalized = $2) OR ($3::text IS NOT NULL AND phone_normalized = $3)) LIMIT 5`,
            [workspaceId, email, phone]
          );
          if (duplicates.rows.length) throw new HttpError(409, 'DUPLICATE_LEAD', 'A matching email or phone already exists. Review the matches before creating another lead.');
          const result = await transaction(db, async client => {
            const inserted = await client.query(
              `INSERT INTO leads(workspace_id, first_name, last_name, company_name, email, email_normalized, phone, phone_normalized,
                source_id, brand_project, opportunity_type, budget, location, requirement, status, temperature, score, notes, next_action,
                next_action_at, do_not_contact, migration_payload)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'{}'::jsonb)
               RETURNING *`,
              [workspaceId, firstName, lastName, optionalString(input.companyName, 'companyName', 240), input.email ?? null, email,
                input.phone ?? null, phone, sourceId, optionalString(input.brandProject, 'brandProject', 240), optionalString(input.opportunityType, 'opportunityType', 160),
                input.budget === undefined || input.budget === null ? null : finiteNumber(input.budget, 'budget', { min: 0 }),
                optionalString(input.location, 'location', 240), optionalString(input.requirement, 'requirement', 5000),
                requiredString(input.status ?? 'New Lead', 'status', { max: 80 }), temperature, score,
                optionalString(input.notes, 'notes', 10000), optionalString(input.nextAction, 'nextAction', 500),
                input.nextActionAt ? isoDate(input.nextActionAt, 'nextActionAt') : null, booleanInput(input.doNotContact, 'doNotContact')]
            );
            const lead = inserted.rows[0];
            const customFields = input.customFields && typeof input.customFields === 'object' && !Array.isArray(input.customFields) ? input.customFields : {};
            const definitions = await client.query("SELECT id,label,required FROM custom_field_definitions WHERE workspace_id=$1 AND entity_type='lead'", [workspaceId]);
            const definitionsById = new Map(definitions.rows.map(item => [item.id, item]));
            for (const [rawFieldId, value] of Object.entries(customFields)) {
              const fieldId = uuid(rawFieldId, 'customFieldId'); const definition = definitionsById.get(fieldId);
              if (!definition) throw new HttpError(400, 'INVALID_CUSTOM_FIELD', 'A custom field does not belong to this workspace.');
              if (definition.required && (value === null || value === '' || (Array.isArray(value) && value.length === 0))) throw new ValidationError(`${definition.label} is required.`);
            }
            for (const definition of definitions.rows.filter(item => item.required)) {
              const value = customFields[definition.id];
              if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) throw new ValidationError(`${definition.label} is required.`);
            }
            for (const [rawFieldId, value] of Object.entries(customFields)) {
              const fieldId = uuid(rawFieldId, 'customFieldId');
              await client.query('INSERT INTO lead_custom_fields(workspace_id,lead_id,field_definition_id,value) VALUES($1,$2,$3,$4::jsonb)', [workspaceId, lead.id, fieldId, JSON.stringify(value)]);
            }
            const tagIds = Array.isArray(input.tagIds) ? [...new Set(input.tagIds.map(value => uuid(value, 'tagId')))] : [];
            if (tagIds.length) {
              const validTags = await client.query('SELECT id FROM tags WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspaceId, tagIds]);
              if (validTags.rows.length !== tagIds.length) throw new HttpError(400, 'INVALID_TAG', 'One or more tags do not belong to this workspace.');
              for (const tagId of tagIds) await client.query('INSERT INTO lead_tags(workspace_id,lead_id,tag_id) VALUES($1,$2,$3)', [workspaceId, lead.id, tagId]);
            }
            if (input.pipelineId || input.stageId) {
              const pipelineId = uuid(input.pipelineId, 'pipelineId'); const stageId = uuid(input.stageId, 'stageId');
              await client.query(`INSERT INTO lead_pipeline_entries(workspace_id, lead_id, pipeline_id, current_stage_id) VALUES($1,$2,$3,$4)`, [workspaceId, lead.id, pipelineId, stageId]);
              await client.query(`INSERT INTO lead_stage_history(workspace_id, lead_id, pipeline_id, to_stage_id, changed_by) VALUES($1,$2,$3,$4,$5)`, [workspaceId, lead.id, pipelineId, stageId, current.userId]);
            }
            await client.query(`INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body) VALUES($1,$2,$3,'system','Lead created','Lead created from CRM.')`, [workspaceId, lead.id, current.userId]);
            await audit(client, { workspaceId, actorUserId: current.userId, action: 'lead.created', entityType: 'lead', entityId: lead.id, request });
            const ruleResult = await applyLeadRules(client, { workspaceId, leadId: lead.id, actorUserId: current.userId });
            if (ruleResult.scoreChanged) await dispatchAutomationEvent(client, { workspaceId, eventType: 'lead.score_changed', leadId: lead.id, eventId: `lead-score:${lead.id}:${Date.now()}`, actorUserId: current.userId });
            await dispatchAutomationEvent(client, { workspaceId, eventType: 'lead.created', leadId: lead.id, eventId: `lead-created:${lead.id}`, actorUserId: current.userId });
            return lead;
          });
          sendJson(response, 201, result); return;
        }

        const leadRoute = suffix.match(/^leads\/([^/]+)(?:\/(.*))?$/);
        if (leadRoute) {
          const leadId = uuid(leadRoute[1], 'leadId'); const action = leadRoute[2] ?? '';
          if (action === 'restore' || action === 'permanent') await trashedLeadVisible(db, context, leadId);
          else await leadVisible(db, context, leadId);
          if (request.method === 'GET' && !action) {
            requirePermission(context, 'crm:read');
            const result = await db.query('SELECT * FROM leads WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL', [workspaceId, leadId]);
            const custom = await db.query(`SELECT d.id, d.field_key, d.label, d.field_type, d.required, d.config, v.value
              FROM custom_field_definitions d LEFT JOIN lead_custom_fields v ON v.field_definition_id=d.id AND v.lead_id=$2
              WHERE d.workspace_id=$1 AND d.entity_type='lead' ORDER BY d.created_at`, [workspaceId, leadId]);
            const tags = await db.query(`SELECT t.id,t.name FROM tags t JOIN lead_tags lt ON lt.tag_id=t.id WHERE t.workspace_id=$1 AND lt.lead_id=$2 ORDER BY t.name`, [workspaceId, leadId]);
            sendJson(response, 200, { ...result.rows[0], customFields: custom.rows, tags: tags.rows }); return;
          }
          if (request.method === 'GET' && action === 'timeline') {
            requirePermission(context, 'crm:read');
            const result = await db.query(
              `SELECT * FROM (
                 SELECT id, 'activity' AS item_type, type AS kind, title, body, occurred_at AS happened_at, metadata FROM activities WHERE workspace_id = $1 AND lead_id = $2
                 UNION ALL
                 SELECT id, 'task' AS item_type, status::text AS kind, title, description AS body, COALESCE(completed_at, due_at, created_at) AS happened_at, jsonb_build_object('dueAt', due_at, 'priority', priority) AS metadata FROM tasks WHERE workspace_id = $1 AND lead_id = $2
                 UNION ALL
                 SELECT id, 'message' AS item_type, channel::text AS kind, COALESCE(subject, 'Message') AS title, body, COALESCE(sent_at, created_at) AS happened_at, jsonb_build_object('status', status, 'direction', direction) AS metadata FROM messages WHERE workspace_id = $1 AND lead_id = $2
               ) timeline ORDER BY happened_at DESC LIMIT 200`, [workspaceId, leadId]
            );
            sendJson(response, 200, { data: result.rows }); return;
          }
          if (request.method === 'PATCH' && !action) {
            requirePermission(context, 'crm:write'); const input = await body();
            const updates = new Map();
            const simple = [['firstName','first_name',120],['lastName','last_name',120],['companyName','company_name',240],['brandProject','brand_project',240],['opportunityType','opportunity_type',160],['location','location',240],['requirement','requirement',5000],['notes','notes',10000],['nextAction','next_action',500],['status','status',80]];
            for (const [key, column, max] of simple) if (input[key] !== undefined) updates.set(column, optionalString(input[key], key, max));
            if (input.email !== undefined) { updates.set('email', input.email || null); updates.set('email_normalized', normalizeEmail(input.email)); }
            if (input.phone !== undefined) { updates.set('phone', input.phone || null); updates.set('phone_normalized', normalizePhone(input.phone)); }
            if (input.sourceId !== undefined) updates.set('source_id', input.sourceId ? uuid(input.sourceId, 'sourceId') : null);
            if (input.budget !== undefined) updates.set('budget', input.budget === null ? null : finiteNumber(input.budget, 'budget', { min: 0 }));
            if (input.score !== undefined) updates.set('score', Math.trunc(finiteNumber(input.score, 'score', { min: 0, max: 10000 })));
            if (input.temperature !== undefined) updates.set('temperature', input.temperature === null ? null : enumValue(input.temperature, 'temperature', ['hot','warm','cold']));
            if (input.nextActionAt !== undefined) updates.set('next_action_at', input.nextActionAt ? isoDate(input.nextActionAt, 'nextActionAt') : null);
            if (input.doNotContact !== undefined) { if (typeof input.doNotContact !== 'boolean') throw new ValidationError('doNotContact must be a boolean.'); updates.set('do_not_contact', input.doNotContact); }
            const hasCustomFields = input.customFields && typeof input.customFields === 'object' && !Array.isArray(input.customFields); const hasTags = Array.isArray(input.tagIds);
            if (!updates.size && !hasCustomFields && !hasTags) throw new HttpError(400, 'NO_FIELDS', 'No supported lead fields were provided.');
            if (updates.has('email_normalized') || updates.has('phone_normalized')) {
              const candidate = await db.query(
                `SELECT id FROM leads WHERE workspace_id = $1 AND id <> $2 AND deleted_at IS NULL
                 AND (($3::text IS NOT NULL AND email_normalized = $3) OR ($4::text IS NOT NULL AND phone_normalized = $4)) LIMIT 1`,
                [workspaceId, leadId, updates.get('email_normalized') ?? null, updates.get('phone_normalized') ?? null]
              );
              if (candidate.rows[0]) throw new HttpError(409, 'DUPLICATE_LEAD', 'A matching email or phone already exists.');
            }
            const values = [workspaceId, leadId]; const assignments = [];
            for (const [column, value] of updates) { values.push(value); assignments.push(`${column} = $${values.length}`); }
            let result;
            if (assignments.length) result = await db.query(`UPDATE leads SET ${assignments.join(', ')}, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *`, values);
            else result = await db.query('SELECT * FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceId, leadId]);
            if (hasCustomFields) {
              const entries = Object.entries(input.customFields);
              for (const [fieldId, value] of entries) {
                const definitionId = uuid(fieldId, 'customFieldId');
                const definition = await db.query("SELECT id,required FROM custom_field_definitions WHERE workspace_id=$1 AND id=$2 AND entity_type='lead'", [workspaceId, definitionId]);
                if (!definition.rows[0]) throw new HttpError(400, 'INVALID_CUSTOM_FIELD', 'A custom field does not belong to this workspace.');
                if (definition.rows[0].required && (value === null || value === '' || (Array.isArray(value) && value.length === 0))) throw new ValidationError('Required custom fields cannot be empty.');
                await db.query(`INSERT INTO lead_custom_fields(workspace_id,lead_id,field_definition_id,value) VALUES($1,$2,$3,$4::jsonb)
                  ON CONFLICT(lead_id,field_definition_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,value=EXCLUDED.value`, [workspaceId, leadId, definitionId, JSON.stringify(value)]);
              }
            }
            if (hasTags) {
              const tagIds = [...new Set(input.tagIds.map(value => uuid(value, 'tagId')))];
              if (tagIds.length) {
                const valid = await db.query('SELECT id FROM tags WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [workspaceId, tagIds]);
                if (valid.rows.length !== tagIds.length) throw new HttpError(400, 'INVALID_TAG', 'One or more tags do not belong to this workspace.');
              }
              await db.query('DELETE FROM lead_tags WHERE workspace_id=$1 AND lead_id=$2', [workspaceId, leadId]);
              for (const tagId of tagIds) await db.query('INSERT INTO lead_tags(workspace_id,lead_id,tag_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [workspaceId, leadId, tagId]);
            }
            await audit(db, { workspaceId, actorUserId: current.userId, action: 'lead.updated', entityType: 'lead', entityId: leadId, request, metadata: { fields: [...updates.keys()], customFields: hasCustomFields, tags: hasTags } });
            const ruleResult = await applyLeadRules(db, { workspaceId, leadId, actorUserId: current.userId });
            await dispatchAutomationEvent(db, { workspaceId, eventType: 'lead.updated', leadId, eventId: `lead-updated:${leadId}:${Date.now()}`, actorUserId: current.userId, eventData: { fields: [...updates.keys()] } });
            if (ruleResult.scoreChanged) await dispatchAutomationEvent(db, { workspaceId, eventType: 'lead.score_changed', leadId, eventId: `lead-score:${leadId}:${Date.now()}`, actorUserId: current.userId });
            sendJson(response, 200, result.rows[0]); return;
          }
          if (request.method === 'DELETE' && !action) {
            requirePermission(context, 'crm:write');
            const result = await db.query('UPDATE leads SET deleted_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id', [workspaceId, leadId]);
            await audit(db, { workspaceId, actorUserId: current.userId, action: 'lead.archived', entityType: 'lead', entityId: leadId, request });
            sendJson(response, 200, { id: result.rows[0]?.id, archived: true }); return;
          }
          if (request.method === 'DELETE' && action === 'permanent') {
            requirePermission(context, 'workspace:manage');
            const deleted = await transaction(db, async client => {
              const result = await client.query('DELETE FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NOT NULL RETURNING id', [workspaceId, leadId]);
              if (!result.rows[0]) throw new HttpError(404, 'LEAD_NOT_IN_TRASH', 'The lead is not in trash.');
              await audit(client, { workspaceId, actorUserId: current.userId, action: 'lead.permanently_deleted', entityType: 'lead', entityId: leadId, request });
              return result.rows[0];
            });
            sendJson(response, 200, { id: deleted.id, deleted: true }); return;
          }
          if (request.method === 'POST' && action === 'restore') {
            requirePermission(context, 'crm:write');
            const identity = await db.query('SELECT email_normalized, phone_normalized FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NOT NULL', [workspaceId, leadId]);
            if (!identity.rows[0]) throw new HttpError(404, 'LEAD_NOT_IN_TRASH', 'The lead is not in trash.');
            const collision = await db.query('SELECT id FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL AND id<>$2 AND (($3::text IS NOT NULL AND email_normalized=$3) OR ($4::text IS NOT NULL AND phone_normalized=$4)) LIMIT 1', [workspaceId, leadId, identity.rows[0].email_normalized, identity.rows[0].phone_normalized]);
            if (collision.rows[0]) throw new HttpError(409, 'DUPLICATE_LEAD', 'An active lead already uses this email or phone.');
            const result = await db.query('UPDATE leads SET deleted_at = NULL, updated_at = now() WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NOT NULL RETURNING id', [workspaceId, leadId]);
            if (!result.rows[0]) throw new HttpError(404, 'LEAD_NOT_IN_TRASH', 'The lead is not in trash.');
            await audit(db, { workspaceId, actorUserId: current.userId, action: 'lead.restored', entityType: 'lead', entityId: leadId, request });
            sendJson(response, 200, { id: result.rows[0].id, restored: true }); return;
          }
          if (request.method === 'POST' && action === 'assign') {
            requirePermission(context, 'crm:write'); const input = await body(); const userId = uuid(input.userId, 'userId');
            const assignment = await transaction(db, async client => {
              const member = await client.query('SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND active = true', [workspaceId, userId]);
              if (!member.rows[0]) throw new HttpError(400, 'ASSIGNEE_NOT_IN_WORKSPACE', 'The assignee must be an active workspace member.');
              await client.query('UPDATE lead_assignments SET unassigned_at = now() WHERE workspace_id = $1 AND lead_id = $2 AND unassigned_at IS NULL', [workspaceId, leadId]);
              const inserted = await client.query(
                'INSERT INTO lead_assignments(workspace_id, lead_id, user_id, assigned_by, reason) VALUES($1,$2,$3,$4,$5) RETURNING *',
                [workspaceId, leadId, userId, current.userId, optionalString(input.reason, 'reason', 500)]
              );
              await client.query('UPDATE leads SET owner_user_id = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, leadId, userId]);
              await client.query(`INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body) VALUES($1,$2,$3,'system','Lead assigned',$4)`, [workspaceId, leadId, current.userId, `Assigned to ${userId}.`]);
              await audit(client, { workspaceId, actorUserId: current.userId, action: 'lead.assigned', entityType: 'lead', entityId: leadId, request, metadata: { assignedTo: userId } });
              return inserted.rows[0];
            });
            sendJson(response, 201, assignment); return;
          }
          if (request.method === 'POST' && action === 'consent') {
            requirePermission(context, 'crm:write'); const input = await body();
            const channel = enumValue(input.channel, 'channel', CHANNELS);
            if (typeof input.optedIn !== 'boolean') throw new ValidationError('optedIn must be a boolean.');
            const result = await db.query(
              `INSERT INTO communication_consents(workspace_id, lead_id, channel, opted_in, source)
               VALUES($1,$2,$3,$4,$5)
               ON CONFLICT(workspace_id, lead_id, channel) DO UPDATE SET opted_in=EXCLUDED.opted_in, source=EXCLUDED.source, changed_at=now()
               RETURNING id, lead_id, channel, opted_in, source, changed_at`,
              [workspaceId, leadId, channel, input.optedIn, requiredString(input.source ?? 'manual', 'source', { max: 80 })]
            );
            await audit(db, { workspaceId, actorUserId: current.userId, action: 'lead.consent_updated', entityType: 'lead', entityId: leadId, request, metadata: { channel, optedIn: input.optedIn } });
            sendJson(response, 200, result.rows[0]); return;
          }
          if (request.method === 'POST' && action === 'stage') {
            requirePermission(context, 'crm:write'); const input = await body();
            const pipelineId = uuid(input.pipelineId, 'pipelineId'); const stageId = uuid(input.stageId, 'stageId');
            const changed = await transaction(db, async client => {
              const stage = await client.query(
                `SELECT s.id, s.name FROM pipeline_stages s JOIN pipelines p ON p.id = s.pipeline_id
                 WHERE p.workspace_id = $1 AND p.id = $2 AND s.id = $3 AND p.active = true`, [workspaceId, pipelineId, stageId]
              );
              if (!stage.rows[0]) throw new HttpError(400, 'INVALID_STAGE', 'Stage does not belong to this workspace pipeline.');
              const prior = await client.query('SELECT current_stage_id FROM lead_pipeline_entries WHERE workspace_id = $1 AND lead_id = $2 AND pipeline_id = $3 AND is_current = true FOR UPDATE', [workspaceId, leadId, pipelineId]);
              if (prior.rows[0]?.current_stage_id === stageId) return { id: leadId, stageId, unchanged: true };
              await client.query('UPDATE lead_pipeline_entries SET is_current = false, exited_at = now() WHERE workspace_id = $1 AND lead_id = $2 AND pipeline_id = $3 AND is_current = true', [workspaceId, leadId, pipelineId]);
              await client.query('INSERT INTO lead_pipeline_entries(workspace_id, lead_id, pipeline_id, current_stage_id) VALUES($1,$2,$3,$4)', [workspaceId, leadId, pipelineId, stageId]);
              const history = await client.query('INSERT INTO lead_stage_history(workspace_id, lead_id, pipeline_id, from_stage_id, to_stage_id, changed_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [workspaceId, leadId, pipelineId, prior.rows[0]?.current_stage_id ?? null, stageId, current.userId]);
              await client.query('UPDATE leads SET status = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, leadId, stage.rows[0].name]);
              await audit(client, { workspaceId, actorUserId: current.userId, action: 'lead.stage_changed', entityType: 'lead', entityId: leadId, request, metadata: { pipelineId, stageId } });
              await dispatchAutomationEvent(client, { workspaceId, eventType: 'lead.stage_changed', leadId, eventId: `lead-stage:${history.rows[0].id}`, actorUserId: current.userId, eventData: { pipelineId, fromStageId: prior.rows[0]?.current_stage_id ?? null, stageId } });
              return { id: leadId, stageId, stageName: stage.rows[0].name };
            });
            sendJson(response, 200, changed); return;
          }
        }

        if (suffix === 'pipelines' && request.method === 'GET') {
          requirePermission(context, 'crm:read');
          const result = await db.query(
            `SELECT p.id, p.name, p.slug, p.active,
              COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug, 'position', s.position, 'isWon', s.is_won, 'isLost', s.is_lost) ORDER BY s.position) FILTER (WHERE s.id IS NOT NULL), '[]'::jsonb) AS stages
             FROM pipelines p LEFT JOIN pipeline_stages s ON s.pipeline_id = p.id
             WHERE p.workspace_id = $1 GROUP BY p.id ORDER BY p.name`, [workspaceId]
          );
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'pipelines' && request.method === 'POST') {
          requirePermission(context, 'workspace:manage'); const input = await body();
          const name = requiredString(input.name, 'name', { max: 120 }); const pipelineSlug = slug(input.slug);
          const result = await db.query('INSERT INTO pipelines(workspace_id, name, slug) VALUES($1,$2,$3) RETURNING id, name, slug, active', [workspaceId, name, pipelineSlug]);
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'pipeline.created', entityType: 'pipeline', entityId: result.rows[0].id, request });
          sendJson(response, 201, result.rows[0]); return;
        }
        const pipelineMatch = suffix.match(/^pipelines\/([^/]+)(?:\/(.*))?$/);
        if (pipelineMatch && request.method === 'PATCH' && !pipelineMatch[2]) {
          requirePermission(context, 'workspace:manage'); const pipelineId = uuid(pipelineMatch[1], 'pipelineId'); const input = await body();
          const fields = []; const values = [workspaceId, pipelineId];
          if (input.name !== undefined) { values.push(requiredString(input.name, 'name', { max: 120 })); fields.push(`name=$${values.length}`); }
          if (input.slug !== undefined) { values.push(slug(input.slug)); fields.push(`slug=$${values.length}`); }
          if (input.active !== undefined) { if (typeof input.active !== 'boolean') throw new ValidationError('active must be a boolean.'); values.push(input.active); fields.push(`active=$${values.length}`); }
          if (!fields.length) throw new HttpError(400, 'NO_FIELDS', 'Provide name, slug or active.');
          const result = await db.query(`UPDATE pipelines SET ${fields.join(', ')} WHERE workspace_id=$1 AND id=$2 RETURNING id,name,slug,active`, values);
          if (!result.rows[0]) throw new HttpError(404, 'PIPELINE_NOT_FOUND', 'Pipeline was not found.');
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'pipeline.updated', entityType: 'pipeline', entityId: pipelineId, request }); sendJson(response, 200, result.rows[0]); return;
        }
        if (pipelineMatch && request.method === 'POST' && pipelineMatch[2] === 'stages') {
          requirePermission(context, 'workspace:manage'); const pipelineId = uuid(pipelineMatch[1], 'pipelineId'); const input = await body();
          const name = requiredString(input.name, 'name', { max: 120 }); const stageSlug = slug(input.slug);
          const position = Math.trunc(finiteNumber(input.position, 'position', { min: 0, max: 10000 }));
          const result = await db.query(
            `INSERT INTO pipeline_stages(pipeline_id, name, slug, position, is_won, is_lost)
             SELECT id, $3, $4, $5, $6, $7 FROM pipelines WHERE workspace_id = $1 AND id = $2
             RETURNING id, name, slug, position, is_won, is_lost`,
            [workspaceId, pipelineId, name, stageSlug, position, booleanInput(input.isWon, 'isWon'), booleanInput(input.isLost, 'isLost')]
          );
          if (!result.rows[0]) throw new HttpError(404, 'PIPELINE_NOT_FOUND', 'Pipeline was not found.');
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'pipeline.stage_created', entityType: 'pipeline_stage', entityId: result.rows[0].id, request, metadata: { pipelineId } });
          sendJson(response, 201, result.rows[0]); return;
        }
        if (pipelineMatch && request.method === 'PATCH' && /^stages\//.test(pipelineMatch[2] ?? '')) {
          requirePermission(context, 'workspace:manage'); const pipelineId = uuid(pipelineMatch[1], 'pipelineId'); const stageId = uuid(pipelineMatch[2].slice('stages/'.length), 'stageId'); const input = await body();
          const fields = []; const values = [pipelineId, stageId, workspaceId];
          let requestedPosition = null;
          if (input.name !== undefined) { values.push(requiredString(input.name, 'name', { max: 120 })); fields.push(`name=$${values.length}`); }
          if (input.slug !== undefined) { values.push(slug(input.slug)); fields.push(`slug=$${values.length}`); }
          if (input.position !== undefined) { requestedPosition = Math.trunc(finiteNumber(input.position, 'position', { min: 0, max: 10000 })); values.push(requestedPosition); fields.push(`position=$${values.length}`); }
          if (input.isWon !== undefined) { if (typeof input.isWon !== 'boolean') throw new ValidationError('isWon must be a boolean.'); values.push(input.isWon); fields.push(`is_won=$${values.length}`); }
          if (input.isLost !== undefined) { if (typeof input.isLost !== 'boolean') throw new ValidationError('isLost must be a boolean.'); values.push(input.isLost); fields.push(`is_lost=$${values.length}`); }
          if (!fields.length) throw new HttpError(400, 'NO_FIELDS', 'Provide stage fields.');
          const updateStage = async client => {
            if (requestedPosition !== null) {
              const currentStage = await client.query('SELECT s.position FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE p.workspace_id=$1 AND p.id=$2 AND s.id=$3 FOR UPDATE', [workspaceId, pipelineId, stageId]);
              if (!currentStage.rows[0]) throw new HttpError(404, 'STAGE_NOT_FOUND', 'Stage was not found.');
              const priorPosition = Number(currentStage.rows[0].position);
              if (priorPosition !== requestedPosition) {
                const temporary = await client.query('SELECT COALESCE(MIN(position),0)-1 AS position FROM pipeline_stages WHERE pipeline_id=$1', [pipelineId]);
                const temporaryPosition = Number(temporary.rows[0].position);
                await client.query('UPDATE pipeline_stages SET position=$3 WHERE pipeline_id=$1 AND id=$2', [pipelineId, stageId, temporaryPosition]);
                await client.query('UPDATE pipeline_stages SET position=$3 WHERE pipeline_id=$1 AND position=$2 AND id<>$4', [pipelineId, requestedPosition, priorPosition, stageId]);
              }
            }
            const result = await client.query(`UPDATE pipeline_stages s SET ${fields.join(', ')} FROM pipelines p WHERE s.pipeline_id=$1 AND s.id=$2 AND p.workspace_id=$3 AND p.id=s.pipeline_id RETURNING s.id,s.name,s.slug,s.position,s.is_won,s.is_lost`, values);
            if (!result.rows[0]) throw new HttpError(404, 'STAGE_NOT_FOUND', 'Stage was not found.');
            await audit(client, { workspaceId, actorUserId: current.userId, action: 'pipeline.stage_updated', entityType: 'pipeline_stage', entityId: stageId, request, metadata: { pipelineId, fields: fields.map(item => item.split('=')[0]) } });
            return result.rows[0];
          };
          const updated = requestedPosition === null ? await updateStage(db) : await transaction(db, updateStage);
          sendJson(response, 200, updated); return;
        }
        if (suffix === 'custom-fields' && request.method === 'GET') {
          requirePermission(context, 'crm:read'); const result = await db.query('SELECT id, entity_type, field_key, label, field_type, required, config, created_at FROM custom_field_definitions WHERE workspace_id=$1 AND entity_type=$2 ORDER BY created_at', [workspaceId, url.searchParams.get('entityType') ?? 'lead']); sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'custom-fields' && request.method === 'POST') {
          requirePermission(context, 'workspace:manage'); const input = await body(); const result = await db.query('INSERT INTO custom_field_definitions(workspace_id, entity_type, field_key, label, field_type, required, config) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *', [workspaceId, enumValue(input.entityType ?? 'lead', 'entityType', ['lead']), requiredString(input.fieldKey, 'fieldKey', { max: 80 }).toLowerCase(), requiredString(input.label, 'label', { max: 160 }), enumValue(input.fieldType ?? 'text', 'fieldType', ['text','textarea','number','currency','date','datetime','boolean','select','multiselect','email','phone','url']), booleanInput(input.required, 'required'), JSON.stringify(input.config ?? {})]); sendJson(response, 201, result.rows[0]); return;
        }
        const fieldMatch = suffix.match(/^custom-fields\/([^/]+)$/);
        if (fieldMatch && request.method === 'PATCH') {
          requirePermission(context, 'workspace:manage'); const input = await body(); const fieldId = uuid(fieldMatch[1], 'fieldId'); const fields = []; const values = [workspaceId, fieldId];
          if (input.label !== undefined) { values.push(requiredString(input.label, 'label', { max: 160 })); fields.push(`label=$${values.length}`); } if (input.required !== undefined) { if (typeof input.required !== 'boolean') throw new ValidationError('required must be a boolean.'); values.push(input.required); fields.push(`required=$${values.length}`); } if (input.config !== undefined) { values.push(JSON.stringify(input.config)); fields.push(`config=$${values.length}::jsonb`); }
          if (!fields.length) throw new HttpError(400, 'NO_FIELDS', 'Provide field settings.'); const result = await db.query(`UPDATE custom_field_definitions SET ${fields.join(', ')} WHERE workspace_id=$1 AND id=$2 RETURNING *`, values); if (!result.rows[0]) throw new HttpError(404, 'FIELD_NOT_FOUND', 'Custom field was not found.'); sendJson(response, 200, result.rows[0]); return;
        }
        if (suffix === 'tags' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result = await db.query('SELECT id,name FROM tags WHERE workspace_id=$1 ORDER BY name', [workspaceId]); sendJson(response, 200, { data: result.rows }); return; }
        if (suffix === 'tags' && request.method === 'POST') { requirePermission(context, 'workspace:manage'); const input = await body(); const result = await db.query('INSERT INTO tags(workspace_id,name) VALUES($1,$2) RETURNING id,name', [workspaceId, requiredString(input.name, 'name', { max: 80 })]); sendJson(response, 201, result.rows[0]); return; }
        const tagMatch = suffix.match(/^tags\/([^/]+)$/);
        if (tagMatch && request.method === 'PATCH') { requirePermission(context, 'workspace:manage'); const input = await body(); const result = await db.query('UPDATE tags SET name=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id,name', [workspaceId, uuid(tagMatch[1], 'tagId'), requiredString(input.name, 'name', { max: 80 })]); if (!result.rows[0]) throw new HttpError(404, 'TAG_NOT_FOUND', 'Tag was not found.'); sendJson(response, 200, result.rows[0]); return; }

        if (suffix === 'lead-sources' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result=await db.query('SELECT id,name FROM lead_sources WHERE workspace_id=$1 ORDER BY name',[workspaceId]); sendJson(response,200,{data:result.rows}); return; }
        if (suffix === 'lead-sources' && request.method === 'POST') { requirePermission(context, 'workspace:manage'); const input=await body(); const result=await db.query('INSERT INTO lead_sources(workspace_id,name) VALUES($1,$2) RETURNING id,name',[workspaceId,requiredString(input.name,'name',{max:120})]); sendJson(response,201,result.rows[0]); return; }
        if (suffix === 'task-types' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result=await db.query('SELECT id,name,active FROM crm_task_types WHERE workspace_id=$1 ORDER BY name',[workspaceId]); sendJson(response,200,{data:result.rows}); return; }
        if (suffix === 'task-types' && request.method === 'POST') { requirePermission(context, 'workspace:manage'); const input=await body(); const result=await db.query('INSERT INTO crm_task_types(workspace_id,name) VALUES($1,$2) RETURNING *',[workspaceId,requiredString(input.name,'name',{max:120})]); sendJson(response,201,result.rows[0]); return; }
        if (suffix === 'assignment-rules' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result=await db.query('SELECT * FROM crm_assignment_rules WHERE workspace_id=$1 ORDER BY priority,id',[workspaceId]); sendJson(response,200,{data:result.rows}); return; }
        if (suffix === 'assignment-rules' && request.method === 'POST') { requirePermission(context, 'workspace:manage'); const input=await body(); const result=await db.query('INSERT INTO crm_assignment_rules(workspace_id,name,priority,conditions,strategy,config,active) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7) RETURNING *',[workspaceId,requiredString(input.name,'name',{max:160}),Math.trunc(finiteNumber(input.priority??100,'priority',{min:0,max:10000})),JSON.stringify(objectBody(input.conditions??{})),enumValue(input.strategy,'strategy',['fixed_owner','round_robin','unassigned']),JSON.stringify(objectBody(input.config??{})),booleanInput(input.active,'active',true)]); sendJson(response,201,result.rows[0]); return; }
        if (suffix === 'scoring-rules' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result=await db.query('SELECT * FROM crm_scoring_rules WHERE workspace_id=$1 ORDER BY priority,id',[workspaceId]); sendJson(response,200,{data:result.rows}); return; }
        if (suffix === 'scoring-rules' && request.method === 'POST') { requirePermission(context, 'workspace:manage'); const input=await body(); const result=await db.query('INSERT INTO crm_scoring_rules(workspace_id,name,priority,conditions,score_delta,active) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING *',[workspaceId,requiredString(input.name,'name',{max:160}),Math.trunc(finiteNumber(input.priority??100,'priority',{min:0,max:10000})),JSON.stringify(objectBody(input.conditions??{})),Math.trunc(finiteNumber(input.scoreDelta,'scoreDelta',{min:-10000,max:10000})),booleanInput(input.active,'active',true)]); sendJson(response,201,result.rows[0]); return; }
        if (suffix === 'saved-views' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result=await db.query('SELECT * FROM crm_saved_views WHERE workspace_id=$1 AND entity_type=$2 AND (user_id IS NULL OR user_id=$3) ORDER BY name',[workspaceId,url.searchParams.get('entityType')??'lead',current.userId]); sendJson(response,200,{data:result.rows}); return; }
        if (suffix === 'saved-views' && request.method === 'POST') { requirePermission(context, 'crm:read'); const input=await body(); const result=await db.query('INSERT INTO crm_saved_views(workspace_id,user_id,entity_type,name,config) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *',[workspaceId,current.userId,enumValue(input.entityType??'lead','entityType',['lead']),requiredString(input.name,'name',{max:160}),JSON.stringify(objectBody(input.config??{}))]); sendJson(response,201,result.rows[0]); return; }
        if (suffix === 'layouts' && request.method === 'GET') { requirePermission(context, 'crm:read'); const result=await db.query('SELECT * FROM crm_layouts WHERE workspace_id=$1 AND entity_type=$2 ORDER BY name',[workspaceId,url.searchParams.get('entityType')??'lead']); sendJson(response,200,{data:result.rows}); return; }
        if (suffix === 'layouts' && request.method === 'POST') { requirePermission(context, 'workspace:manage'); const input=await body(); const entityType=enumValue(input.entityType??'lead','entityType',['lead']); const active=booleanInput(input.active,'active',true); const result=await transaction(db,async client=>{if(active)await client.query('UPDATE crm_layouts SET active=false,updated_at=now() WHERE workspace_id=$1 AND entity_type=$2',[workspaceId,entityType]);return client.query('INSERT INTO crm_layouts(workspace_id,entity_type,name,config,active) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *',[workspaceId,entityType,requiredString(input.name,'name',{max:160}),JSON.stringify(objectBody(input.config??{})),active]);}); sendJson(response,201,result.rows[0]); return; }

        if (suffix === 'tasks' && request.method === 'GET') {
          requirePermission(context, 'crm:read');
          const values = [workspaceId]; const filters = ['workspace_id = $1'];
          if (context.role === 'agent') { values.push(current.userId); filters.push(`assigned_to = $${values.length}`); }
          if (url.searchParams.get('status')) { values.push(enumValue(url.searchParams.get('status'), 'status', TASK_STATUSES)); filters.push(`status = $${values.length}`); }
          if (url.searchParams.get('dueBefore')) { values.push(isoDate(url.searchParams.get('dueBefore'), 'dueBefore')); filters.push(`due_at <= $${values.length}`); }
          values.push(pageSize(url));
          const result = await db.query(`SELECT * FROM tasks WHERE ${filters.join(' AND ')} ORDER BY due_at NULLS LAST, id LIMIT $${values.length}`, values);
          sendJson(response, 200, { data: result.rows }); return;
        }

        if (suffix === 'tasks' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body();
          const leadId = input.leadId ? uuid(input.leadId, 'leadId') : null;
          if (leadId) await leadVisible(db, context, leadId);
          const assignedTo = input.assignedTo ? uuid(input.assignedTo, 'assignedTo') : current.userId;
          const result = await db.query(
            `INSERT INTO tasks(workspace_id, lead_id, assigned_to, created_by, title, description, due_at, status, priority, source, task_type, touch_number)
             VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11) RETURNING *`,
            [workspaceId, leadId, assignedTo, current.userId, requiredString(input.title, 'title', { max: 240 }), optionalString(input.description, 'description', 5000),
              input.dueAt ? isoDate(input.dueAt, 'dueAt') : null, input.priority === undefined ? 0 : Math.trunc(finiteNumber(input.priority, 'priority', { min: 0, max: 10 })),
              input.source === 'legacy' ? 'legacy' : 'manual', optionalString(input.taskType, 'taskType', 80),
              input.touchNumber === undefined ? null : Math.trunc(finiteNumber(input.touchNumber, 'touchNumber', { min: 0, max: 10000 }))]
          );
          if (leadId) await db.query(`INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body, metadata) VALUES($1,$2,$3,'system','Task created',$4,$5::jsonb)`, [workspaceId, leadId, current.userId, result.rows[0].title, JSON.stringify({ taskId: result.rows[0].id })]);
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'task.created', entityType: 'task', entityId: result.rows[0].id, request });
          sendJson(response, 201, result.rows[0]); return;
        }
        const taskMatch = suffix.match(/^tasks\/([^/]+)$/);
        if (taskMatch && request.method === 'PATCH') {
          requirePermission(context, 'crm:write'); const taskId = uuid(taskMatch[1], 'taskId'); const input = await body();
          const values = [workspaceId, taskId]; const sets = [];
          if (input.title !== undefined) { values.push(requiredString(input.title, 'title', { max: 240 })); sets.push(`title = $${values.length}`); }
          if (input.description !== undefined) { values.push(optionalString(input.description, 'description', 5000)); sets.push(`description = $${values.length}`); }
          if (input.dueAt !== undefined) { values.push(input.dueAt ? isoDate(input.dueAt, 'dueAt') : null); sets.push(`due_at = $${values.length}`); }
          if (input.status !== undefined) { values.push(enumValue(input.status, 'status', TASK_STATUSES)); sets.push(`status = $${values.length}`); sets.push(input.status === 'completed' ? 'completed_at = now()' : 'completed_at = NULL'); }
          if (input.priority !== undefined) { values.push(Math.trunc(finiteNumber(input.priority, 'priority', { min: 0, max: 10 }))); sets.push(`priority = $${values.length}`); }
          if (!sets.length) throw new HttpError(400, 'NO_FIELDS', 'No supported task fields were provided.');
          const result = await transaction(db, async client => {
            const agentScope = context.role === 'agent' ? ` AND assigned_to = $${values.length + 1}` : '';
            if (context.role === 'agent') values.push(current.userId);
            const updated = await client.query(`UPDATE tasks SET ${sets.join(', ')}, updated_at = now() WHERE workspace_id = $1 AND id = $2${agentScope} RETURNING *`, values);
            if (updated.rows[0]?.status === 'completed' && updated.rows[0].lead_id) {
              await client.query('UPDATE leads SET last_contacted_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2', [workspaceId, updated.rows[0].lead_id]);
              await dispatchAutomationEvent(client, { workspaceId, eventType: 'task.completed', leadId: updated.rows[0].lead_id, eventId: `task-completed:${taskId}`, actorUserId: current.userId });
            }
            return updated;
          });
          if (!result.rows[0]) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task was not found.');
          if (result.rows[0].lead_id) await db.query(`INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body, metadata) VALUES($1,$2,$3,'system','Task updated',$4,$5::jsonb)`, [workspaceId, result.rows[0].lead_id, current.userId, result.rows[0].title, JSON.stringify({ taskId, status: result.rows[0].status })]);
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'task.updated', entityType: 'task', entityId: taskId, request });
          sendJson(response, 200, result.rows[0]); return;
        }

        if (suffix === 'activities' && request.method === 'GET') {
          requirePermission(context, 'crm:read'); const values = [workspaceId]; const filters = ['workspace_id = $1'];
          if (url.searchParams.get('leadId')) { const leadId = uuid(url.searchParams.get('leadId'), 'leadId'); await leadVisible(db, context, leadId); values.push(leadId); filters.push(`lead_id = $${values.length}`); }
          values.push(pageSize(url)); const result = await db.query(`SELECT * FROM activities WHERE ${filters.join(' AND ')} ORDER BY occurred_at DESC, id LIMIT $${values.length}`, values);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'activities' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body(); const leadId = input.leadId ? uuid(input.leadId, 'leadId') : null;
          if (leadId) await leadVisible(db, context, leadId);
          const result = await db.query(
            `INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body, occurred_at, metadata)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`,
            [workspaceId, leadId, current.userId, enumValue(input.type ?? 'note', 'type', ACTIVITY_TYPES), requiredString(input.title, 'title', { max: 240 }), optionalString(input.body, 'body', 10000), input.occurredAt ? isoDate(input.occurredAt, 'occurredAt') : new Date(), JSON.stringify(input.metadata ?? {})]
          );
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'activity.created', entityType: 'activity', entityId: result.rows[0].id, request });
          sendJson(response, 201, result.rows[0]); return;
        }

        if (suffix === 'meetings' && request.method === 'GET') {
          requirePermission(context, 'crm:read'); const values = [workspaceId]; let filter = 'workspace_id = $1';
          if (context.role === 'agent') { values.push(current.userId); filter += ` AND owner_user_id = ${values.length}`; }
          if (url.searchParams.get('leadId')) { const leadId = uuid(url.searchParams.get('leadId'), 'leadId'); await leadVisible(db, context, leadId); values.push(leadId); filter += ` AND lead_id = ${values.length}`; }
          values.push(pageSize(url)); const result = await db.query(`SELECT * FROM meetings WHERE ${filter} ORDER BY starts_at DESC LIMIT ${values.length}`, values);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'meetings' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body(); const leadId = input.leadId ? uuid(input.leadId, 'leadId') : null;
          if (leadId) await leadVisible(db, context, leadId);
          const startsAt = isoDate(input.startsAt, 'startsAt'); const endsAt = input.endsAt ? isoDate(input.endsAt, 'endsAt') : null;
          if (endsAt && Date.parse(endsAt) < Date.parse(startsAt)) throw new ValidationError('endsAt must be after startsAt.', 'endsAt');
          const result = await db.query(
            `INSERT INTO meetings(workspace_id, lead_id, owner_user_id, starts_at, ends_at, status, meeting_type, external_provider, external_event_id, notes)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [workspaceId, leadId, current.userId, startsAt, endsAt,
              requiredString(input.status ?? 'scheduled', 'status', { max: 60 }), optionalString(input.meetingType, 'meetingType', 120),
              optionalString(input.externalProvider, 'externalProvider', 80), optionalString(input.externalEventId, 'externalEventId', 240), optionalString(input.notes, 'notes', 5000)]
          );
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'meeting.created', entityType: 'meeting', entityId: result.rows[0].id, request });
          if (leadId) await dispatchAutomationEvent(db, { workspaceId, eventType: 'meeting.created', leadId, eventId: `meeting-created:${result.rows[0].id}`, actorUserId: current.userId });
          sendJson(response, 201, result.rows[0]); return;
        }
        const meetingMatch = suffix.match(/^meetings\/([^/]+)$/);
        if (meetingMatch && request.method === 'PATCH') {
          requirePermission(context, 'crm:write'); const meetingId = uuid(meetingMatch[1], 'meetingId'); const input = await body();
          const existing = await db.query(`SELECT starts_at, ends_at FROM meetings WHERE workspace_id=$1 AND id=$2 AND ($3 <> 'agent' OR owner_user_id=$4)`, [workspaceId, meetingId, context.role, current.userId]);
          if (!existing.rows[0]) throw new HttpError(404, 'MEETING_NOT_FOUND', 'Meeting was not found.');
          const candidateStart = input.startsAt !== undefined ? isoDate(input.startsAt, 'startsAt') : existing.rows[0].starts_at;
          const candidateEnd = input.endsAt !== undefined ? (input.endsAt ? isoDate(input.endsAt, 'endsAt') : null) : existing.rows[0].ends_at;
          if (candidateEnd && Date.parse(candidateEnd) < Date.parse(candidateStart)) throw new ValidationError('endsAt must be after startsAt.', 'endsAt');
          const values = [workspaceId, meetingId]; const sets = [];
          for (const [key, column, max] of [['status','status',60],['meetingType','meeting_type',120],['notes','notes',5000]]) if (input[key] !== undefined) { values.push(optionalString(input[key], key, max)); sets.push(`${column} = $${values.length}`); }
          if (input.startsAt !== undefined) { values.push(candidateStart); sets.push(`starts_at = $${values.length}`); }
          if (input.endsAt !== undefined) { values.push(candidateEnd); sets.push(`ends_at = $${values.length}`); }
          if (!sets.length) throw new HttpError(400, 'NO_FIELDS', 'No supported meeting fields were provided.');
          const result = await db.query(`UPDATE meetings SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2 RETURNING *`, values);
          if (!result.rows[0]) throw new HttpError(404, 'MEETING_NOT_FOUND', 'Meeting was not found.');
          if (result.rows[0].status === 'missed' && result.rows[0].lead_id) await dispatchAutomationEvent(db, { workspaceId, eventType: 'meeting.missed', leadId: result.rows[0].lead_id, eventId: `meeting-missed:${meetingId}`, actorUserId: current.userId, eventData: { status: 'missed' } });
          sendJson(response, 200, result.rows[0]); return;
        }

        if (suffix === 'calls' && request.method === 'GET') {
          requirePermission(context, 'crm:read'); const values = [workspaceId]; let filter = 'workspace_id = $1';
          if (url.searchParams.get('leadId')) { const leadId = uuid(url.searchParams.get('leadId'), 'leadId'); await leadVisible(db, context, leadId); values.push(leadId); filter += ` AND lead_id = $${values.length}`; }
          values.push(pageSize(url)); const result = await db.query(`SELECT * FROM calls WHERE ${filter} ORDER BY started_at DESC NULLS LAST, id LIMIT $${values.length}`, values);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'calls' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body(); const leadId = input.leadId ? uuid(input.leadId, 'leadId') : null;
          if (leadId) await leadVisible(db, context, leadId);
          const duration = Math.trunc(finiteNumber(input.durationSeconds ?? 0, 'durationSeconds', { min: 0, max: 48 * 60 * 60 }));
          const result = await db.query(
            `INSERT INTO calls(workspace_id, lead_id, user_id, direction, status, started_at, answered_at, ended_at, duration_seconds, recording_ref, disposition, metadata)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
            [workspaceId, leadId, current.userId, enumValue(input.direction, 'direction', CALL_DIRECTIONS), enumValue(input.status, 'status', CALL_STATUSES),
              input.startedAt ? isoDate(input.startedAt, 'startedAt') : null, input.answeredAt ? isoDate(input.answeredAt, 'answeredAt') : null,
              input.endedAt ? isoDate(input.endedAt, 'endedAt') : null, duration, optionalString(input.recordingRef, 'recordingRef', 1000),
              optionalString(input.disposition, 'disposition', 160), JSON.stringify(input.metadata ?? {})]
          );
          if (leadId) await db.query(`INSERT INTO activities(workspace_id, lead_id, user_id, type, title, body, metadata) VALUES($1,$2,$3,'call','Call logged',$4,$5::jsonb)`, [workspaceId, leadId, current.userId, result.rows[0].disposition, JSON.stringify({ callId: result.rows[0].id, status: result.rows[0].status, durationSeconds: duration })]);
          if (duration > 0) await db.query(
            `INSERT INTO usage_events(workspace_id, provider, service, usage_type, quantity, unit, external_reference, idempotency_key, metadata)
             VALUES($1, NULL, 'voice', 'call_duration', $2, 'second', $3, $4, $5::jsonb) ON CONFLICT(workspace_id, idempotency_key) DO NOTHING`,
            [workspaceId, duration, result.rows[0].id, `call:${result.rows[0].id}:duration`, JSON.stringify({ callId: result.rows[0].id })]
          );
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'call.logged', entityType: 'call', entityId: result.rows[0].id, request });
          sendJson(response, 201, result.rows[0]); return;
        }
        const callNoteMatch = suffix.match(/^calls\/([^/]+)\/notes$/);
        if (callNoteMatch && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const callId = uuid(callNoteMatch[1], 'callId'); const input = await body();
          const result = await db.query(
            `INSERT INTO call_notes(workspace_id, call_id, author_user_id, note)
             SELECT $1, id, $3, $4 FROM calls WHERE workspace_id = $1 AND id = $2 RETURNING *`,
            [workspaceId, callId, current.userId, requiredString(input.note, 'note', { max: 5000 })]
          );
          if (!result.rows[0]) throw new HttpError(404, 'CALL_NOT_FOUND', 'Call was not found.');
          sendJson(response, 201, result.rows[0]); return;
        }

        if (suffix === 'communications/providers' && request.method === 'GET') {
          requirePermission(context, 'crm:read'); const result = await db.query('SELECT id, channel, provider_name, active, config_ref FROM communication_providers WHERE workspace_id = $1 ORDER BY channel, provider_name', [workspaceId]);
          sendJson(response, 200, { data: result.rows, configuredAdapters: [...communicationAdapters.adapters.keys()] }); return;
        }
        if (suffix === 'messages' && request.method === 'GET') {
          requirePermission(context, 'crm:read'); const values = [workspaceId]; let filter = 'workspace_id = $1';
          if (url.searchParams.get('leadId')) { const leadId = uuid(url.searchParams.get('leadId'), 'leadId'); await leadVisible(db, context, leadId); values.push(leadId); filter += ` AND lead_id = $${values.length}`; }
          else if (context.role === 'agent') { values.push(current.userId); filter += ` AND EXISTS (SELECT 1 FROM lead_assignments a WHERE a.workspace_id=messages.workspace_id AND a.lead_id=messages.lead_id AND a.user_id=$${values.length} AND a.unassigned_at IS NULL)`; }
          values.push(pageSize(url)); const result = await db.query(`SELECT * FROM messages WHERE ${filter} ORDER BY created_at DESC LIMIT $${values.length}`, values);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'messages' && request.method === 'POST') {
          requirePermission(context, 'crm:write'); const input = await body(); const leadId = input.leadId ? uuid(input.leadId, 'leadId') : null;
          if (leadId) await leadVisible(db, context, leadId);
          const channel = enumValue(input.channel, 'channel', CHANNELS);
          const result = await db.query(
            `INSERT INTO messages(workspace_id, lead_id, channel, direction, status, subject, body, idempotency_key, metadata)
             VALUES($1,$2,$3,'outbound','draft',$4,$5,$6,$7::jsonb) RETURNING *`,
            [workspaceId, leadId, channel, optionalString(input.subject, 'subject', 500), requiredString(input.body, 'body', { max: 10000 }),
              input.idempotencyKey ? requiredString(input.idempotencyKey, 'idempotencyKey', { max: 200 }) : `draft:${randomBytes(20).toString('hex')}`, JSON.stringify({ requestedProvider: input.provider ?? null })]
          );
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'message.draft_created', entityType: 'message', entityId: result.rows[0].id, request, metadata: { channel } });
          sendJson(response, 201, result.rows[0]); return;
        }
        if (suffix === 'messages/send' && request.method === 'POST') {
          requirePermission(context, 'communications:send'); const input = await body(); const key = parseIdempotency(request);
          const leadId = uuid(input.leadId, 'leadId'); await leadVisible(db, context, leadId);
          const lead = await db.query('SELECT do_not_contact FROM leads WHERE workspace_id=$1 AND id=$2', [workspaceId, leadId]);
          if (lead.rows[0]?.do_not_contact) throw new HttpError(403, 'DO_NOT_CONTACT', 'This lead is suppressed from communications.');
          const channel = enumValue(input.channel, 'channel', CHANNELS);
          const consent = await db.query('SELECT do_not_contact FROM leads WHERE workspace_id = $1 AND id = $2', [workspaceId, leadId]);
          if (consent.rows[0]?.do_not_contact) throw new HttpError(403, 'DO_NOT_CONTACT', 'This lead is suppressed from communications.');
          const consentResult = await db.query('SELECT opted_in FROM communication_consents WHERE workspace_id = $1 AND lead_id = $2 AND channel = $3', [workspaceId, leadId, channel]);
          if (!consentResult.rows[0]?.opted_in) throw new HttpError(403, 'CONSENT_REQUIRED', 'Record channel consent before sending.');
          const providerName = requiredString(input.provider, 'provider', { max: 120 });
          const providerResult = await db.query('SELECT id FROM communication_providers WHERE workspace_id = $1 AND provider_name = $2 AND channel = $3 AND active = true', [workspaceId, providerName, channel]);
          const provider = providerResult.rows[0]; const adapter = communicationAdapters.get(providerName);
          if (!provider || !adapter) throw new HttpError(503, 'PROVIDER_NOT_CONFIGURED', 'No configured adapter is available for this channel.');
          const estimate = await quoteUsage(db, { workspaceId, provider: providerName, service: channel, usageType: 'message', quantity: '1', unit: 'message' });
          const bodyText = requiredString(input.body, 'body', { max: 10000 });
          const existing = await db.query('SELECT * FROM messages WHERE workspace_id = $1 AND idempotency_key = $2', [workspaceId, key]);
          if (existing.rows[0]) { sendJson(response, 200, existing.rows[0]); return; }
          const inserted = await db.query(
            `INSERT INTO messages(workspace_id, lead_id, provider_id, channel, direction, status, subject, body, idempotency_key, metadata)
             VALUES($1,$2,$3,$4,'outbound','queued',$5,$6,$7,$8::jsonb) RETURNING *`,
            [workspaceId, leadId, provider.id, channel, optionalString(input.subject, 'subject', 500), bodyText, key, JSON.stringify({ estimate })]
          );
          try {
            const sent = await adapter.send({ workspaceId, leadId, channel, to: requiredString(input.to, 'to', { max: 320 }), subject: input.subject ?? null, body: bodyText, idempotencyKey: key });
            const updated = await db.query('UPDATE messages SET provider_message_id = $3, status = $4, sent_at = now(), cost_amount = $5, cost_currency = $6 WHERE workspace_id = $1 AND id = $2 RETURNING *', [workspaceId, inserted.rows[0].id, optionalString(sent.providerMessageId, 'providerMessageId', 240), sent.status ?? 'sent', sent.providerCost ?? null, sent.currency ?? estimate.currency]);
            await db.query(
              `INSERT INTO usage_events(workspace_id, provider, service, usage_type, quantity, unit, provider_cost, internal_charge, currency, external_reference, idempotency_key, metadata)
               VALUES($1,$2,$3,'message',1,'message',$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
              [workspaceId, providerName, channel, sent.providerCost ?? estimate.providerCost, estimate.customerCharge, estimate.currency, sent.providerMessageId ?? null, `message:${inserted.rows[0].id}`, JSON.stringify({ rateId: estimate.rateId })]
            );
            await audit(db, { workspaceId, actorUserId: current.userId, action: 'message.sent', entityType: 'message', entityId: inserted.rows[0].id, request, metadata: { channel, provider: providerName } });
            sendJson(response, 202, updated.rows[0]); return;
          } catch (error) {
            await db.query("UPDATE messages SET status = 'failed', metadata = metadata || $3::jsonb WHERE workspace_id = $1 AND id = $2", [workspaceId, inserted.rows[0].id, JSON.stringify({ failure: error.code ?? 'PROVIDER_ERROR' })]);
            throw error;
          }
        }

        if (suffix === 'calls/start' && request.method === 'POST') {
          requirePermission(context, 'communications:send'); const input = await body();
          const providerName = requiredString(input.provider, 'provider', { max: 120 }); const adapter = callingAdapters.get(providerName);
          if (!adapter) throw new HttpError(503, 'PROVIDER_NOT_CONFIGURED', 'No calling adapter is configured. Calls can still be logged manually.');
          const leadId = uuid(input.leadId, 'leadId'); await leadVisible(db, context, leadId);
          const key = parseIdempotency(request);
          const estimate = await quoteUsage(db, { workspaceId, provider: providerName, service: 'voice', usageType: 'outbound_call', quantity: '1', unit: 'call' });
          const prior = await db.query('SELECT * FROM calls WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, key]);
          if (prior.rows[0]) { sendJson(response, 202, prior.rows[0]); return; }
          const queued = await db.query(
            `INSERT INTO calls(workspace_id, lead_id, user_id, provider, idempotency_key, direction, status, started_at, metadata)
             VALUES($1,$2,$3,$4,$5,'outbound','queued',now(),$6::jsonb) RETURNING *`,
            [workspaceId, leadId, current.userId, providerName, key, JSON.stringify({ estimate })]
          );
          try {
            const initiated = await adapter.startCall({ workspaceId, leadId, userId: current.userId, to: requiredString(input.to, 'to', { max: 80 }), idempotencyKey: key });
            const updated = await db.query(
              `UPDATE calls SET provider_call_id=$3, status=$4, metadata=metadata || $5::jsonb WHERE workspace_id=$1 AND id=$2 RETURNING *`,
              [workspaceId, queued.rows[0].id, requiredString(initiated.providerCallId, 'providerCallId', { max: 240 }),
                enumValue(initiated.status ?? 'queued', 'status', CALL_STATUSES), JSON.stringify({ estimatedCost: estimate })]
            );
            await db.query(
              `INSERT INTO usage_events(workspace_id, provider, service, usage_type, quantity, unit, provider_cost, internal_charge, currency, external_reference, idempotency_key, metadata)
               VALUES($1,$2,'voice','outbound_call',1,'call',$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
              [workspaceId, providerName, initiated.providerCost ?? estimate.providerCost, estimate.customerCharge, initiated.currency ?? estimate.currency, updated.rows[0].provider_call_id, `call:${updated.rows[0].id}:initiation`, JSON.stringify({ rateId: estimate.rateId })]
            );
            await audit(db, { workspaceId, actorUserId: current.userId, action: 'call.started', entityType: 'call', entityId: updated.rows[0].id, request, metadata: { provider: providerName } });
            sendJson(response, 202, updated.rows[0]); return;
          } catch (error) {
            await db.query("UPDATE calls SET status='failed', ended_at=now(), metadata=metadata || $3::jsonb WHERE workspace_id=$1 AND id=$2", [workspaceId, queued.rows[0].id, JSON.stringify({ failure: error.code ?? 'PROVIDER_ERROR' })]);
            throw error;
          }
        }

        if (suffix === 'control-center' && request.method === 'GET') {
          requirePermission(context, 'crm:read');
          const [usage, providers, automations, calls, settings] = await Promise.all([
            db.query("SELECT service, provider, SUM(quantity) quantity, SUM(provider_cost) provider_cost, SUM(internal_charge) client_charge, currency FROM usage_events WHERE workspace_id=$1 GROUP BY service, provider, currency ORDER BY service, provider", [workspaceId]),
            db.query("SELECT id, channel, provider_name, active, config_ref, created_at FROM communication_providers WHERE workspace_id=$1 ORDER BY channel, provider_name", [workspaceId]),
            db.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE active)::int AS active FROM automations WHERE workspace_id=$1", [workspaceId]),
            db.query("SELECT status, COUNT(*)::int AS count FROM calls WHERE workspace_id=$1 GROUP BY status", [workspaceId]),
            db.query("SELECT model_routes, ai_defaults, communication_defaults FROM workspace_control_settings WHERE workspace_id=$1", [workspaceId])
          ]);
          sendJson(response, 200, { role: current.role, usage: usage.rows, providers: providers.rows, automations: automations.rows[0], calls: calls.rows, settings: settings.rows[0] ?? { model_routes: {}, ai_defaults: {}, communication_defaults: {} } }); return;
        }
        if (suffix === 'control-center/settings' && request.method === 'PATCH') {
          requirePermission(context, 'workspace:manage'); const input = await body();
          const settings = { modelRoutes: objectBody(input.modelRoutes ?? {}), aiDefaults: objectBody(input.aiDefaults ?? {}), communicationDefaults: objectBody(input.communicationDefaults ?? {}) };
          const updated = await db.query(`INSERT INTO workspace_control_settings(workspace_id,model_routes,ai_defaults,communication_defaults,updated_by)
            VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5)
            ON CONFLICT(workspace_id) DO UPDATE SET model_routes=EXCLUDED.model_routes, ai_defaults=EXCLUDED.ai_defaults, communication_defaults=EXCLUDED.communication_defaults, updated_by=EXCLUDED.updated_by, updated_at=now()
            RETURNING model_routes, ai_defaults, communication_defaults, updated_at`, [workspaceId, JSON.stringify(settings.modelRoutes), JSON.stringify(settings.aiDefaults), JSON.stringify(settings.communicationDefaults), current.userId]);
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'control_center.settings_updated', entityType: 'workspace_control_settings', entityId: workspaceId, request });
          sendJson(response, 200, updated.rows[0]); return;
        }
        if (suffix === 'ai/complete' && request.method === 'POST') {
          requirePermission(context, 'crm:read'); const input = await body();
          const gateway = new AIGateway({ db });
          const result = await gateway.complete({ workspaceId, userId: current.userId, messages: input.messages, model: input.model ?? null, processing: input.processing ?? 'standard', idempotencyKey: request.headers['idempotency-key'] ?? undefined, allowFallback: input.allowFallback !== false, toolCalls: Boolean(input.toolCalls) });
          sendJson(response, 200, result); return;
        }
        if (suffix === 'automations/install-defaults' && request.method === 'POST') {
          requirePermission(context, 'automation:manage');
          await installDefaultAutomations(db, workspaceId, current.userId);
          sendJson(response, 200, { installed: true }); return;
        }
        if (suffix === 'automations' && request.method === 'GET') {
          requirePermission(context, 'automation:manage'); const result = await db.query('SELECT id, name, description, active, trigger_type, trigger_config, current_version_id, created_at, updated_at FROM automations WHERE workspace_id = $1 ORDER BY created_at DESC', [workspaceId]);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'automations' && request.method === 'POST') {
          requirePermission(context, 'automation:manage'); const input = await body(); const definition = normalizeAutomation(input);
          const created = await transaction(db, async client => {
            const automation = await client.query(
              `INSERT INTO automations(workspace_id, name, description, active, trigger_type, trigger_config, created_by)
               VALUES($1,$2,$3,false,$4,$5::jsonb,$6) RETURNING id`,
              [workspaceId, definition.name, definition.description, definition.triggerType, JSON.stringify(definition.triggerConfig), current.userId]
            );
            const version = await client.query(
              `INSERT INTO automation_versions(workspace_id, automation_id, version_number, definition, created_by)
               VALUES($1,$2,1,$3::jsonb,$4) RETURNING id`,
              [workspaceId, automation.rows[0].id, JSON.stringify(definition), current.userId]
            );
            const updated = await client.query('UPDATE automations SET current_version_id = $3, active = $4 WHERE workspace_id = $1 AND id = $2 RETURNING *', [workspaceId, automation.rows[0].id, version.rows[0].id, booleanInput(input.active, 'active')]);
            await audit(client, { workspaceId, actorUserId: current.userId, action: 'automation.created', entityType: 'automation', entityId: updated.rows[0].id, request, metadata: { version: 1 } });
            return updated.rows[0];
          });
          sendJson(response, 201, created); return;
        }
        const automationMatch = suffix.match(/^automations\/([^/]+)(?:\/(.*))?$/);
        if (automationMatch) {
          requirePermission(context, 'automation:manage'); const automationId = uuid(automationMatch[1], 'automationId'); const action = automationMatch[2] ?? '';
          if (request.method === 'GET' && !action) {
            const result = await db.query(`SELECT a.*,v.version_number,v.definition FROM automations a LEFT JOIN automation_versions v ON v.id=a.current_version_id AND v.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.id=$2`,[workspaceId,automationId]);
            if(!result.rows[0])throw new HttpError(404,'AUTOMATION_NOT_FOUND','Automation was not found.');
            sendJson(response,200,result.rows[0]);return;
          }
          if (request.method === 'PATCH' && !action) {
            const input = await body(); const definition = normalizeAutomation(input);
            const updated = await transaction(db, async client => {
              const locked = await client.query('SELECT id FROM automations WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, automationId]);
              if (!locked.rows[0]) throw new HttpError(404, 'AUTOMATION_NOT_FOUND', 'Automation was not found.');
              const prior = await client.query('SELECT COALESCE(MAX(version_number),0) AS version FROM automation_versions WHERE workspace_id=$1 AND automation_id=$2', [workspaceId, automationId]);
              const versionNo = Number(prior.rows[0].version) + 1;
              const version = await client.query('INSERT INTO automation_versions(workspace_id, automation_id, version_number, definition, created_by) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id', [workspaceId, automationId, versionNo, JSON.stringify(definition), current.userId]);
              const result = await client.query('UPDATE automations SET name=$3, description=$4, trigger_type=$5, trigger_config=$6::jsonb, current_version_id=$7, active=$8, updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *', [workspaceId, automationId, definition.name, definition.description, definition.triggerType, JSON.stringify(definition.triggerConfig), version.rows[0].id, booleanInput(input.active, 'active')]);
              await audit(client, { workspaceId, actorUserId: current.userId, action: 'automation.version_published', entityType: 'automation', entityId: automationId, request, metadata: { version: versionNo } });
              return result.rows[0];
            });
            sendJson(response, 200, updated); return;
          }
          if (request.method === 'POST' && action === 'test') {
            const input = await body(); const key = parseIdempotency(request);
            const result = await queueAutomationRun(db, { workspaceId, automationId, leadId: input.leadId ? uuid(input.leadId, 'leadId') : null, idempotencyKey: `test:${key}`, actorUserId: current.userId, test: true });
            sendJson(response, 202, result); return;
          }
          const runDetailMatch = action.match(/^runs\/([^/]+)$/);
          if (request.method === 'GET' && runDetailMatch) {
            const runId = uuid(runDetailMatch[1], 'runId');
            const run = await db.query(
              `SELECT r.id,r.lead_id,r.version_id,r.status,r.started_at,r.completed_at,r.error_message,r.attempt_count,r.created_at,
                      v.version_number,v.definition
                 FROM automation_runs r
                 JOIN automation_versions v ON v.workspace_id=r.workspace_id AND v.id=r.version_id
                WHERE r.workspace_id=$1 AND r.automation_id=$2 AND r.id=$3`,
              [workspaceId, automationId, runId]
            );
            if (!run.rows[0]) throw new HttpError(404, 'AUTOMATION_RUN_NOT_FOUND', 'Automation run was not found.');
            const steps = await db.query(
              'SELECT id,position,status,result,completed_at FROM automation_action_runs WHERE workspace_id=$1 AND automation_run_id=$2 ORDER BY position',
              [workspaceId, runId]
            );
            sendJson(response, 200, { run: run.rows[0], steps: steps.rows }); return;
          }
          if (request.method === 'GET' && action === 'runs') {
            const result = await db.query('SELECT id, lead_id, version_id, status, started_at, completed_at, error_message, attempt_count, created_at FROM automation_runs WHERE workspace_id=$1 AND automation_id=$2 ORDER BY created_at DESC LIMIT $3', [workspaceId, automationId, pageSize(url)]);
            sendJson(response, 200, { data: result.rows }); return;
          }
          if (request.method === 'POST' && !action) {
            const input = await body(); const key = parseIdempotency(request);
            const leadId = uuid(input.leadId, 'leadId'); await leadVisible(db, context, leadId);
            const result = await queueAutomationRun(db, { workspaceId, automationId, leadId, idempotencyKey: key, actorUserId: current.userId, test: false });
            sendJson(response, 202, result); return;
          }
        }

        if (suffix === 'usage/estimate' && request.method === 'POST') {
          requirePermission(context, 'usage:read'); const input = await body();
          const estimate = await quoteUsage(db, { workspaceId, provider: input.provider ?? null, service: requiredString(input.service, 'service', { max: 80 }), usageType: requiredString(input.usageType, 'usageType', { max: 80 }), quantity: decimal(input.quantity, 'quantity', { min: '0' }), unit: requiredString(input.unit, 'unit', { max: 60 }), currency: requiredString(input.currency ?? 'INR', 'currency', { max: 3 }).toUpperCase() });
          sendJson(response, 200, estimate); return;
        }
        if (suffix === 'usage' && request.method === 'GET') {
          requirePermission(context, 'usage:read'); const values = [workspaceId]; let filter = 'workspace_id = $1';
          if (url.searchParams.get('from')) { values.push(isoDate(url.searchParams.get('from'), 'from')); filter += ` AND occurred_at >= $${values.length}`; }
          if (url.searchParams.get('to')) { values.push(isoDate(url.searchParams.get('to'), 'to')); filter += ` AND occurred_at < $${values.length}`; }
          values.push(pageSize(url)); const result = await db.query(`SELECT id, provider, service, usage_type, quantity, unit, provider_cost, internal_charge, currency, external_reference, occurred_at FROM usage_events WHERE ${filter} ORDER BY occurred_at DESC LIMIT $${values.length}`, values);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'usage/rates' && request.method === 'GET') {
          requirePermission(context, 'usage:read'); const result = await db.query('SELECT id, provider, service, usage_type, unit, provider_cost_per_unit, customer_charge_per_unit, currency, valid_from, valid_until FROM provider_rates WHERE workspace_id = $1 OR workspace_id IS NULL ORDER BY service, usage_type, valid_from DESC', [workspaceId]);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'usage/rates' && request.method === 'POST') {
          requirePermission(context, 'usage:manage'); const input = await body();
          const result = await db.query(
            `INSERT INTO provider_rates(workspace_id, provider, service, usage_type, unit, provider_cost_per_unit, customer_charge_per_unit, currency, valid_from, valid_until)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, provider, service, usage_type, unit, provider_cost_per_unit, customer_charge_per_unit, currency, valid_from, valid_until`,
            [workspaceId, optionalString(input.provider, 'provider', 120), requiredString(input.service, 'service', { max: 80 }), requiredString(input.usageType, 'usageType', { max: 80 }),
              requiredString(input.unit, 'unit', { max: 60 }), decimal(input.providerCostPerUnit, 'providerCostPerUnit', { min: '0' }), decimal(input.customerChargePerUnit, 'customerChargePerUnit', { min: '0' }),
              requiredString(input.currency, 'currency', { min: 3, max: 3 }).toUpperCase(), input.validFrom ? isoDate(input.validFrom, 'validFrom') : new Date(), input.validUntil ? isoDate(input.validUntil, 'validUntil') : null]
          );
          await audit(db, { workspaceId, actorUserId: current.userId, action: 'usage.rate_created', entityType: 'provider_rate', entityId: result.rows[0].id, request });
          sendJson(response, 201, result.rows[0]); return;
        }
        if (suffix === 'billing/invoices' && request.method === 'GET') {
          requirePermission(context, 'billing:manage'); const result = await db.query('SELECT * FROM invoices WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2', [workspaceId, pageSize(url)]);
          sendJson(response, 200, { data: result.rows }); return;
        }
        if (suffix === 'audit' && request.method === 'GET') {
          requirePermission(context, 'audit:read'); const result = await db.query('SELECT id, actor_user_id, action, entity_type, entity_id, metadata, created_at FROM audit_logs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2', [workspaceId, pageSize(url)]);
          sendJson(response, 200, { data: result.rows }); return;
        }

        const reportMatch = suffix.match(/^reports\/(dashboard|sales|agents|sources)$/);
        if (reportMatch && request.method === 'GET') {
          requirePermission(context, 'reports:read'); const report = reportMatch[1]; const start = url.searchParams.get('from') ? isoDate(url.searchParams.get('from'), 'from') : new Date(Date.now() - 30 * 86400_000).toISOString();
          const end = url.searchParams.get('to') ? isoDate(url.searchParams.get('to'), 'to') : new Date().toISOString();
          if (report === 'dashboard') {
            const [leads, meetings] = await Promise.all([
              db.query(
                `SELECT COUNT(*) AS total_leads,
                        COUNT(*) FILTER (WHERE lower(COALESCE(temperature::text,''))='hot' OR upper(COALESCE(status::text,''))='HOT') AS hot,
                        COUNT(*) FILTER (WHERE upper(COALESCE(status::text,''))='WON') AS won,
                        COUNT(*) FILTER (WHERE upper(COALESCE(status::text,''))='LOST') AS lost
                   FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL`, [workspaceId]
              ),
              db.query('SELECT COUNT(*) AS meetings FROM meetings WHERE workspace_id=$1 AND starts_at >= $2 AND starts_at < $3', [workspaceId, start, end])
            ]);
            const summary = { ...leads.rows[0], meetings: meetings.rows[0].meetings };
            const decided = Number(summary.won) + Number(summary.lost);
            summary.win_rate = decided ? Number((100 * Number(summary.won) / decided).toFixed(1)) : 0;
            sendJson(response, 200, { range: { from: start, to: end }, summary }); return;
          }
          const query = report === 'sales' ?
            `SELECT COUNT(*) FILTER (WHERE created_at >= $2) AS new_leads,
                    COUNT(*) FILTER (WHERE upper(status::text) = 'WON') AS won,
                    COUNT(*) FILTER (WHERE upper(status::text) = 'LOST') AS lost,
                    COUNT(*) FILTER (WHERE upper(status::text) IN ('HOT','WARM')) AS qualified,
                    COALESCE((SELECT COUNT(*) FROM meetings m WHERE m.workspace_id=$1 AND m.starts_at >= $2 AND m.starts_at < $3),0) AS meetings,
                    COALESCE((SELECT COUNT(*) FROM calls c WHERE c.workspace_id=$1 AND c.started_at >= $2 AND c.started_at < $3 AND c.status='answered'),0) AS connected_calls,
                    COALESCE((SELECT SUM(duration_seconds) FROM calls c WHERE c.workspace_id=$1 AND c.started_at >= $2 AND c.started_at < $3),0) AS talk_time_seconds,
                    COALESCE((SELECT SUM(value) FROM opportunities o WHERE o.workspace_id=$1 AND o.status='won' AND o.updated_at >= $2 AND o.updated_at < $3),0) AS revenue
               FROM leads WHERE workspace_id=$1 AND deleted_at IS NULL AND created_at < $3` :
            report === 'agents' ?
            `SELECT u.id AS user_id, u.display_name, COUNT(DISTINCT a.lead_id) AS assigned_leads,
                    COUNT(DISTINCT t.id) FILTER (WHERE t.status='completed' AND t.completed_at >= $2 AND t.completed_at < $3) AS completed_tasks,
                    COUNT(DISTINCT c.id) FILTER (WHERE c.status='answered' AND c.started_at >= $2 AND c.started_at < $3) AS connected_calls,
                    COUNT(DISTINCT m.id) FILTER (WHERE m.starts_at >= $2 AND m.starts_at < $3) AS meetings
               FROM workspace_members wm JOIN users u ON u.id=wm.user_id
               LEFT JOIN lead_assignments a ON a.workspace_id=wm.workspace_id AND a.user_id=u.id AND a.unassigned_at IS NULL
               LEFT JOIN tasks t ON t.workspace_id=wm.workspace_id AND t.assigned_to=u.id
               LEFT JOIN calls c ON c.workspace_id=wm.workspace_id AND c.user_id=u.id
               LEFT JOIN meetings m ON m.workspace_id=wm.workspace_id AND m.owner_user_id=u.id
              WHERE wm.workspace_id=$1 AND wm.active=true GROUP BY u.id, u.display_name ORDER BY assigned_leads DESC` :
            `SELECT COALESCE(s.name, 'Unattributed') AS source, COUNT(*) AS leads,
                    COUNT(*) FILTER (WHERE upper(l.status)='WON') AS won,
                    COUNT(*) FILTER (WHERE upper(l.status) IN ('HOT','WARM')) AS qualified
               FROM leads l LEFT JOIN lead_sources s ON s.workspace_id=l.workspace_id AND s.id=l.source_id
              WHERE l.workspace_id=$1 AND l.deleted_at IS NULL AND l.created_at >= $2 AND l.created_at < $3
              GROUP BY s.name ORDER BY leads DESC`;
          const result = await db.query(query, [workspaceId, start, end]);
          sendJson(response, 200, report === 'sales' ? { range: { from: start, to: end }, summary: result.rows[0] } : { range: { from: start, to: end }, data: result.rows }); return;
        }

        throw new HttpError(404, 'NOT_FOUND', 'Route was not found.');
      }

      const webhookMatch = pathname.match(/^\/api\/v1\/webhooks\/([a-z0-9-]+)\/(calls|messages)$/);
      if (request.method === 'POST' && webhookMatch) {
        const provider = webhookMatch[1];
        const secretName = `WEBHOOK_SECRET_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
        const secret = process.env[secretName]; if (!secret) throw new HttpError(404, 'WEBHOOK_NOT_CONFIGURED', 'This webhook endpoint is not configured.');
        const timestamp = String(request.headers['x-redblack-timestamp'] ?? ''); const signature = String(request.headers['x-redblack-signature'] ?? '');
        const timestampNumber = Number(timestamp);
        if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber * 1000) > 5 * 60_000) throw new HttpError(401, 'WEBHOOK_EXPIRED', 'Webhook timestamp is outside the accepted window.');
        const raw = await readRawBody(request);
        const expected = createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
        const supplied = signature.startsWith('sha256=') ? signature.slice(7) : signature;
        if (!safeEqual(expected, supplied)) throw new HttpError(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid.');
        let event;
        try { event = objectBody(JSON.parse(raw.toString('utf8'))); } catch { throw new HttpError(400, 'INVALID_JSON', 'Webhook body is not valid JSON.'); }
        const eventId = requiredString(event.eventId ?? request.headers['x-redblack-event-id'], 'eventId', { max: 240 });
        if (webhookMatch[2] === 'messages') {
          const messageEvent = objectBody(event.message);
          const workspaceId = uuid(event.workspaceId, 'workspaceId');
          const channel = enumValue(messageEvent.channel, 'channel', CHANNELS);
          const providerMessageId = requiredString(messageEvent.providerMessageId, 'providerMessageId', { max: 240 });
          const providerEventAt = event.occurredAt ? isoDate(event.occurredAt, 'occurredAt') : new Date().toISOString();
          const providerConfig = await db.query('SELECT id FROM communication_providers WHERE workspace_id=$1 AND provider_name=$2 AND channel=$3 AND active=true', [workspaceId, provider, channel]);
          if (!providerConfig.rows[0]) throw new HttpError(404, 'PROVIDER_NOT_CONFIGURED', 'The message provider is not configured in this workspace.');
          const stored = await transaction(db, async client => {
            const receipt = await client.query('INSERT INTO webhook_receipts(provider,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [provider, eventId]);
            if (!receipt.rows[0]) return { duplicate: true };
            const inserted = await client.query(
              `INSERT INTO messages(workspace_id, lead_id, provider_id, channel, direction, provider_message_id, status, subject, body, sent_at, delivered_at, provider_event_at, idempotency_key, metadata)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
               ON CONFLICT(provider_id,provider_message_id) DO UPDATE SET status=EXCLUDED.status, delivered_at=COALESCE(EXCLUDED.delivered_at,messages.delivered_at), metadata=messages.metadata || EXCLUDED.metadata
               WHERE COALESCE(EXCLUDED.provider_event_at,'epoch'::timestamptz) >= COALESCE(messages.provider_event_at,'epoch'::timestamptz)
               RETURNING id, workspace_id, lead_id, channel, direction, provider_message_id, status, sent_at, delivered_at`,
              [workspaceId, messageEvent.leadId ? uuid(messageEvent.leadId, 'leadId') : null, providerConfig.rows[0].id, channel,
                enumValue(messageEvent.direction, 'direction', ['inbound','outbound']), providerMessageId,
                requiredString(messageEvent.status, 'status', { max: 80 }), optionalString(messageEvent.subject, 'subject', 500), optionalString(messageEvent.body, 'body', 10000),
                messageEvent.sentAt ? isoDate(messageEvent.sentAt, 'sentAt') : null, messageEvent.deliveredAt ? isoDate(messageEvent.deliveredAt, 'deliveredAt') : null, providerEventAt,
                `provider:${provider}:${providerMessageId}`, JSON.stringify({ eventId })]
            );
            const message = inserted.rows[0] ?? (await client.query('SELECT id, workspace_id, lead_id, channel, direction, provider_message_id, status, sent_at, delivered_at FROM messages WHERE provider_id=$1 AND provider_message_id=$2', [providerConfig.rows[0].id, providerMessageId])).rows[0];
            await audit(client, { workspaceId, actorUserId: null, action: 'message.webhook_received', entityType: 'message', entityId: message.id, request, metadata: { provider, eventId, channel } });
            return { message, duplicate: false };
          });
          sendJson(response, 202, stored.duplicate ? { received: true, duplicate: true } : { received: true, message: stored.message }); return;
        }
        const callEvent = objectBody(event.call);
        const workspaceId = uuid(event.workspaceId, 'workspaceId');
        const leadId = callEvent.leadId ? uuid(callEvent.leadId, 'leadId') : null;
        const providerCallId = requiredString(callEvent.providerCallId, 'providerCallId', { max: 240 });
        const status = enumValue(callEvent.status, 'status', CALL_STATUSES);
        const duration = Math.trunc(finiteNumber(callEvent.durationSeconds ?? 0, 'durationSeconds', { min: 0, max: 48 * 60 * 60 }));
        const providerEventAt = event.occurredAt ? isoDate(event.occurredAt, 'occurredAt') : new Date();
        const result = await transaction(db, async client => {
          const receipt = await client.query('INSERT INTO webhook_receipts(provider,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [provider, eventId]);
          if (!receipt.rows[0]) return { duplicate: true };
          const upsert = await client.query(
            `INSERT INTO calls(workspace_id, lead_id, provider, provider_call_id, user_id, direction, status, started_at, answered_at, ended_at, duration_seconds, disposition, provider_event_at, metadata)
             VALUES($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
             ON CONFLICT(provider,provider_call_id) DO UPDATE SET status=EXCLUDED.status,
               answered_at=COALESCE(EXCLUDED.answered_at,calls.answered_at), ended_at=COALESCE(EXCLUDED.ended_at,calls.ended_at),
               duration_seconds=GREATEST(calls.duration_seconds,EXCLUDED.duration_seconds), disposition=COALESCE(EXCLUDED.disposition,calls.disposition),
               provider_event_at=EXCLUDED.provider_event_at, metadata=calls.metadata || EXCLUDED.metadata
             WHERE calls.workspace_id=EXCLUDED.workspace_id AND COALESCE(EXCLUDED.provider_event_at,'epoch'::timestamptz) >= COALESCE(calls.provider_event_at,'epoch'::timestamptz)
             RETURNING id, workspace_id, lead_id, status, answered_at, ended_at, duration_seconds`,
            [workspaceId, leadId, provider, providerCallId, enumValue(callEvent.direction, 'direction', CALL_DIRECTIONS), status,
              callEvent.startedAt ? isoDate(callEvent.startedAt, 'startedAt') : null, callEvent.answeredAt ? isoDate(callEvent.answeredAt, 'answeredAt') : null,
              callEvent.endedAt ? isoDate(callEvent.endedAt, 'endedAt') : null, duration, optionalString(callEvent.disposition, 'disposition', 160), providerEventAt, JSON.stringify({ eventId })]
          );
          let call = upsert.rows[0];
          if (!call) {
            const prior = await client.query('SELECT id, workspace_id, lead_id, status, answered_at, ended_at, duration_seconds FROM calls WHERE provider=$1 AND provider_call_id=$2', [provider, providerCallId]);
            if (!prior.rows[0] || prior.rows[0].workspace_id !== workspaceId) throw new HttpError(409, 'PROVIDER_CALL_CONFLICT', 'The provider call ID is already associated with a different workspace.');
            call = prior.rows[0];
          }
          if (callEvent.endedAt && call.duration_seconds > 0) {
            let internalCharge = null;
            try { internalCharge = (await quoteUsage(client, { workspaceId, provider, service: 'voice', usageType: 'call_duration', quantity: String(call.duration_seconds), unit: 'second' })).customerCharge; }
            catch (error) { if (error.code !== 'RATE_NOT_CONFIGURED') throw error; }
            await client.query(
              `INSERT INTO usage_events(workspace_id, provider, service, usage_type, quantity, unit, provider_cost, internal_charge, currency, external_reference, idempotency_key, metadata)
               VALUES($1,$2,'voice','call_duration',$3,'second',$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`,
              [workspaceId, provider, call.duration_seconds, callEvent.providerCost == null ? null : String(finiteNumber(callEvent.providerCost, 'providerCost', { min: 0 })), internalCharge,
                requiredString(callEvent.currency ?? 'INR', 'currency', { min: 3, max: 3 }).toUpperCase(), providerCallId, `call:${call.id}:final_duration`, JSON.stringify({ eventId })]
            );
            if (leadId) await dispatchAutomationEvent(client, { workspaceId, eventType: 'call.ended', leadId, eventId: `call-ended:${call.id}`, actorUserId: null });
          }
          return { call, duplicate: false };
        });
        sendJson(response, 202, result.duplicate ? { received: true, duplicate: true } : { received: true, call: result.call }); return;
      }

      if (request.method === 'GET' && pathname === '/api/v1/openapi.json') {
        const spec = await import('./openapi.js'); sendJson(response, 200, spec.default); return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'Route was not found.');
    } catch (error) {
      const safe = userSafeError(error);
      if (safe.status >= 500) process.stderr.write(JSON.stringify({ level: 'error', requestId, message: error.message, code: error.code ?? null }) + '\n');
      if (!response.headersSent) sendJson(response, safe.status, { error: { code: safe.code, message: safe.message, requestId } });
      else response.destroy();
    }
  });
  return server;
}

export function normalizeAutomation(input) {
  const actions = input.actions;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 25) throw new ValidationError('actions must contain between 1 and 25 items.', 'actions');
  return {
    name: requiredString(input.name, 'name', { max: 160 }),
    description: optionalString(input.description, 'description', 5000),
    triggerType: enumValue(input.triggerType, 'triggerType', ['manual', 'lead.created', 'lead.updated', 'form.submitted', 'lead.stage_changed', 'message.incoming', 'email.incoming', 'appointment.created', 'appointment.missed', 'task.completed', 'meeting.created', 'meeting.missed', 'call.completed', 'call.ended', 'lead.no_response', 'lead.score_changed', 'scheduled.time', 'webhook.received', 'ai.decision']),
    triggerConfig: objectBody(input.triggerConfig ?? {}),
    actions: actions.map((action, position) => {
      objectBody(action);
      const type = enumValue(action.type, `actions[${position}].type`, AUTOMATION_ACTIONS);
      const config = objectBody(action.config ?? {});
      if (type === 'create_task') return { type, config: { title: requiredString(config.title, 'title', { max: 240 }), description: optionalString(config.description, 'description', 5000), dueInMinutes: Math.trunc(finiteNumber(config.dueInMinutes ?? 0, 'dueInMinutes', { min: 0, max: 525600 })), assignTo: config.assignTo ? enumValue(config.assignTo, 'assignTo', ['owner', 'current']) : 'owner' } };
      if (type === 'create_activity') return { type, config: { title: requiredString(config.title, 'title', { max: 240 }), body: optionalString(config.body, 'body', 5000) } };
      if (type === 'create_lead') return { type, config: { firstName: optionalString(config.firstName, 'firstName', 120), lastName: optionalString(config.lastName, 'lastName', 120), email: optionalString(config.email, 'email', 320), phone: optionalString(config.phone, 'phone', 80), status: optionalString(config.status, 'status', 80) } };
      if (type === 'update_lead') return { type, config: objectBody(config) };
      if (type === 'assign_owner') return { type, config: { userId: config.userId ? uuid(config.userId, 'userId') : null } };
      if (type === 'create_note') return { type, config: { title: requiredString(config.title, 'title', { max: 240 }), body: optionalString(config.body, 'body', 5000) } };
      if (type === 'schedule_follow_up') return { type, config: { title: requiredString(config.title, 'title', { max: 240 }), dueInMinutes: Math.trunc(finiteNumber(config.dueInMinutes ?? 60, 'dueInMinutes', { min: 0, max: 525600 })) } };
      if (type === 'notify_user') return { type, config: { userId: config.userId ? uuid(config.userId, 'userId') : null, message: requiredString(config.message, 'message', { max: 5000 }) } };
      if (type === 'invoke_ai') return { type, config: objectBody(config) };
      if (type === 'call_webhook') return { type, config: { url: requiredString(config.url, 'url', { max: 2000 }), method: optionalString(config.method, 'method', 10) ?? 'POST' } };
      if (type === 'send_communication') return { type, config: objectBody(config) };
      if (type === 'start_call') return { type, config: { provider: requiredString(config.provider, 'provider', { max: 80 }), direction: config.direction ? enumValue(config.direction, 'direction', ['inbound', 'outbound']) : 'outbound', to: requiredString(config.to, 'to', { max: 240 }), isAi: Boolean(config.isAi) } };
      if (type === 'book_appointment') return { type, config: objectBody(config) };
      if (type === 'change_stage') return { type, config: { pipelineId: uuid(config.pipelineId, 'pipelineId'), stageId: uuid(config.stageId, 'stageId') } };
      if (type === 'wait') return { type, config: { minutes: Math.trunc(finiteNumber(config.minutes, 'minutes', { min: 1, max: 525600 })) } };
      return { type, config: { channel: enumValue(config.channel, 'channel', CHANNELS), subject: optionalString(config.subject, 'subject', 500), body: requiredString(config.body, 'body', { max: 10000 }) } };
    })
  };
}

async function queueAutomationRun(db, { workspaceId, automationId, leadId, idempotencyKey, actorUserId, test }) {
  if (leadId) {
    const lead = await db.query('SELECT id FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId, leadId]);
    if (!lead.rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND', 'Lead was not found in this workspace.');
  }
  const result = await db.query(
    `INSERT INTO automation_runs(workspace_id, automation_id, version_id, lead_id, status, idempotency_key, metadata)
     SELECT a.workspace_id, a.id, a.current_version_id, $3, 'queued', $4, $5::jsonb
       FROM automations a WHERE a.workspace_id=$1 AND a.id=$2 AND a.active=true AND a.current_version_id IS NOT NULL
     ON CONFLICT(automation_id, idempotency_key) DO NOTHING RETURNING *`,
    [workspaceId, automationId, leadId, idempotencyKey, JSON.stringify({ requestedBy: actorUserId, test })]
  );
  if (result.rows[0]) return result.rows[0];
  const prior = await db.query('SELECT * FROM automation_runs WHERE workspace_id=$1 AND automation_id=$2 AND idempotency_key=$3', [workspaceId, automationId, idempotencyKey]);
  if (prior.rows[0]) return prior.rows[0];
  throw new HttpError(404, 'AUTOMATION_NOT_ACTIVE', 'Automation is unavailable or inactive.');
}

function automationValue(source, path) {
  return String(path ?? '').split('.').filter(Boolean).reduce((value, key) => value == null ? undefined : value[key], source);
}

function automationCompare(actual, operator, expected) {
  if (operator === 'is empty') return actual === undefined || actual === null || actual === '';
  if (operator === 'is not empty') return !(actual === undefined || actual === null || actual === '');
  if (operator === 'contains') return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'does not contain') return Array.isArray(actual) ? !actual.includes(expected) : !String(actual ?? '').includes(String(expected ?? ''));
  if (operator === 'in') return Array.isArray(expected) && expected.includes(actual);
  if (operator === 'not in') return Array.isArray(expected) && !expected.includes(actual);
  if (operator === '=') return actual === expected || String(actual ?? '') === String(expected ?? '');
  if (operator === '!=') return !(actual === expected || String(actual ?? '') === String(expected ?? ''));
  const left = Number(actual); const right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  if (operator === '>') return left > right;
  if (operator === '>=') return left >= right;
  if (operator === '<') return left < right;
  if (operator === '<=') return left <= right;
  return false;
}

function automationCondition(node, event) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return true;
  if (Array.isArray(node.all)) return node.all.every(item => automationCondition(item, event));
  if (Array.isArray(node.any)) return node.any.some(item => automationCondition(item, event));
  if (node.field && node.operator) return automationCompare(automationValue(event, node.field), String(node.operator).toLowerCase(), node.value);
  return true;
}

function automationMatches(config, event) {
  if (config.pipelineId && config.pipelineId !== event.pipelineId) return false;
  if (config.fromStageId && config.fromStageId !== event.fromStageId) return false;
  if (config.toStageId && config.toStageId !== event.stageId) return false;
  if (config.status && config.status !== event.status) return false;
  if (config.all || config.any || (config.field && config.operator)) return automationCondition(config, event);
  return true;
}

async function applyLeadRules(db, { workspaceId, leadId, actorUserId = null }) {
  const leadResult = await db.query('SELECT * FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId, leadId]);
  const lead = leadResult.rows[0]; if (!lead) return { scoreChanged: false };
  const customRows = await db.query(`SELECT d.field_key,v.value FROM lead_custom_fields v JOIN custom_field_definitions d ON d.id=v.field_definition_id WHERE d.workspace_id=$1 AND v.lead_id=$2`, [workspaceId,leadId]);
  const custom = Object.fromEntries(customRows.rows.map(row => [row.field_key,row.value]));
  const context = { ...lead, custom, sourceId: lead.source_id, ownerId: lead.owner_user_id, opportunityType: lead.opportunity_type, brandProject: lead.brand_project };
  const scoring = await db.query('SELECT conditions,score_delta FROM crm_scoring_rules WHERE workspace_id=$1 AND active=true ORDER BY priority,id', [workspaceId]);
  let scoreChanged = false;
  if (scoring.rows.length) {
    const calculated = scoring.rows.reduce((total, rule) => total + (automationCondition(rule.conditions ?? {}, context) ? Number(rule.score_delta) : 0), 0);
    const nextScore = Math.max(0, calculated);
    if (nextScore !== Number(lead.score)) { await db.query('UPDATE leads SET score=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId, leadId, nextScore]); context.score = nextScore; scoreChanged = true; }
  }
  const existing = await db.query('SELECT 1 FROM lead_assignments WHERE lead_id=$1 AND unassigned_at IS NULL', [leadId]);
  if (!existing.rows[0]) {
    const rules = await db.query('SELECT * FROM crm_assignment_rules WHERE workspace_id=$1 AND active=true ORDER BY priority,id', [workspaceId]);
    const rule = rules.rows.find(item => automationCondition(item.conditions ?? {}, context));
    if (rule && rule.strategy !== 'unassigned') {
      let userId = rule.config?.userId ?? null;
      if (rule.strategy === 'round_robin') {
        const candidate = await db.query(`SELECT wm.user_id,COUNT(a.id)::int AS load FROM workspace_members wm
          LEFT JOIN lead_assignments a ON a.user_id=wm.user_id AND a.unassigned_at IS NULL
          WHERE wm.workspace_id=$1 AND wm.active=true AND wm.role IN ('agent','manager')
          GROUP BY wm.user_id ORDER BY load,wm.user_id LIMIT 1`, [workspaceId]);
        userId = candidate.rows[0]?.user_id ?? null;
      }
      if (userId) {
        const member = await db.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active=true', [workspaceId,userId]);
        if (member.rows[0]) {
          await db.query('INSERT INTO lead_assignments(workspace_id,lead_id,user_id,assigned_by,reason) VALUES($1,$2,$3,$4,$5)', [workspaceId,leadId,userId,actorUserId,`Rule: ${rule.name}`]);
          await db.query('UPDATE leads SET owner_user_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2', [workspaceId,leadId,userId]);
        }
      }
    }
  }
  return { scoreChanged };
}

export async function dispatchAutomationEvent(db, { workspaceId, eventType, leadId, eventId, actorUserId = null, eventData = {} }) {
  const automations = await db.query(
    `SELECT id, trigger_config FROM automations WHERE workspace_id=$1 AND active=true AND trigger_type=$2 ORDER BY created_at`,
    [workspaceId, eventType]
  );
  let leadContext = {};
  if (leadId) {
    const lead = await db.query('SELECT status,score,temperature,budget,source_id,owner_user_id,location,opportunity_type,brand_project FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId, leadId]);
    if (lead.rows[0]) leadContext = { ...lead.rows[0], sourceId: lead.rows[0].source_id, ownerId: lead.rows[0].owner_user_id, opportunityType: lead.rows[0].opportunity_type, brandProject: lead.rows[0].brand_project };
  }
  for (const automation of automations.rows) {
    if (!automationMatches(automation.trigger_config ?? {}, { ...leadContext, ...eventData })) continue;
    await queueAutomationRun(db, {
      workspaceId,
      automationId: automation.id,
      leadId,
      idempotencyKey: `event:${eventId}`,
      actorUserId,
      test: false
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createRedBlackServer();
  ensureDefaultAutomations().then(() => server.listen(config.port, '0.0.0.0', () => process.stdout.write(`RedBlack Core listening on ${config.port}
`))).catch(error => { process.stderr.write(`${error.stack ?? error}
`); process.exitCode = 1; });
  const shutdown = async () => { server.close(); await closeDatabase(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

