const ROLE_PERMISSIONS = Object.freeze({
  owner: new Set(['crm:read', 'crm:write', 'workspace:manage', 'members:manage', 'automation:manage', 'communications:send', 'usage:read', 'usage:manage', 'reports:read', 'billing:manage', 'audit:read']),
  admin: new Set(['crm:read', 'crm:write', 'workspace:manage', 'members:manage', 'automation:manage', 'communications:send', 'usage:read', 'usage:manage', 'reports:read', 'billing:manage', 'audit:read']),
  manager: new Set(['crm:read', 'crm:write', 'automation:manage', 'communications:send', 'usage:read', 'reports:read']),
  agent: new Set(['crm:read', 'crm:write', 'communications:send']),
  reporting: new Set(['crm:read', 'usage:read', 'reports:read']),
  service: new Set(['crm:read', 'crm:write', 'communications:send', 'usage:manage'])
});

export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function requirePermission(context, permission) {
  if (!context?.role || !hasPermission(context.role, permission)) {
    const error = new Error('Your workspace role cannot perform this action.');
    error.status = 403;
    error.code = 'FORBIDDEN';
    throw error;
  }
}

export function visibleLeadPredicate(context, leadAlias = 'l') {
  if (context.role !== 'agent') return { sql: '', values: [] };
  return {
    sql: ` AND EXISTS (SELECT 1 FROM lead_assignments la WHERE la.workspace_id = $1 AND la.lead_id = ${leadAlias}.id AND la.user_id = $2 AND la.unassigned_at IS NULL)`,
    values: [context.workspaceId, context.userId]
  };
}

