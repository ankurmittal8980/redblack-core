import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { hashToken, safeEqual } from './password.js';

export function cookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
  }));
}

function cookie(name, value, { httpOnly, maxAge = 0 } = {}) {
  const secure = config.isProduction ? '; Secure' : '';
  const http = httpOnly ? '; HttpOnly' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Strict${http}${secure}; Max-Age=${maxAge}`;
}

export function setSessionCookies(response, sessionToken, csrfToken, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  response.setHeader('Set-Cookie', [cookie('rb_session', sessionToken, { httpOnly: true, maxAge }), cookie('rb_csrf', csrfToken, { maxAge })]);
}

export function clearSessionCookies(response) {
  response.setHeader('Set-Cookie', [cookie('rb_session', '', { httpOnly: true }), cookie('rb_csrf', '')]);
}

export async function createSession(db, { userId, workspaceId = null }) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);
  const result = await db.query(
    `INSERT INTO auth_sessions(user_id, workspace_id, token_hash, csrf_hash, expires_at)
     VALUES($1, $2, $3, $4, $5) RETURNING id, expires_at`,
    [userId, workspaceId, hashToken(token), hashToken(csrf), expiresAt]
  );
  return { id: result.rows[0].id, token, csrf, expiresAt: result.rows[0].expires_at };
}

export async function readSession(db, request) {
  const token = cookies(request.headers.cookie).rb_session;
  if (!token) return null;
  const result = await db.query(
    `SELECT s.id AS session_id, s.user_id, s.workspace_id, s.csrf_hash, s.expires_at,
            u.email, u.display_name, wm.role, wm.active AS membership_active
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       LEFT JOIN workspace_members wm ON wm.workspace_id = s.workspace_id AND wm.user_id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row || (row.workspace_id && !row.membership_active)) return null;
  await db.query("UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '10 minutes'", [row.session_id]);
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role ?? null,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at
  };
}

export function requireCsrf(session, request) {
  const suppliedCookie = cookies(request.headers.cookie).rb_csrf;
  const suppliedHeader = request.headers['x-csrf-token'];
  if (!suppliedCookie || typeof suppliedHeader !== 'string' || !safeEqual(suppliedCookie, suppliedHeader) || !safeEqual(hashToken(suppliedCookie), session.csrfHash)) {
    const error = new Error('The request could not be verified. Refresh the page and try again.');
    error.status = 403;
    error.code = 'CSRF_INVALID';
    throw error;
  }
}

export function assertSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let allowed;
  try { allowed = new URL(config.appBaseUrl).origin; }
  catch { throw new Error('APP_BASE_URL must be a valid URL.'); }
  if (origin !== allowed) {
    const error = new Error('Cross-origin requests are not allowed.');
    error.status = 403;
    error.code = 'ORIGIN_NOT_ALLOWED';
    throw error;
  }
}

export class SlidingWindowLimiter {
  constructor({ limit, windowMs, maxKeys = 10000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key, now = Date.now()) {
    if (this.buckets.size > this.maxKeys) {
      for (const [bucketKey, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
      while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    }
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterMs: 0 };
    }
    current.count += 1;
    return {
      allowed: current.count <= this.limit,
      remaining: Math.max(0, this.limit - current.count),
      retryAfterMs: Math.max(0, current.resetAt - now)
    };
  }
}

