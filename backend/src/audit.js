export async function audit(db, { workspaceId, actorUserId = null, action, entityType = null, entityId = null, request, metadata = {} }) {
  await db.query(
    `INSERT INTO audit_logs(workspace_id, actor_user_id, action, entity_type, entity_id, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [workspaceId, actorUserId, action, entityType, entityId, request?.socket?.remoteAddress ?? null,
      request?.headers?.['user-agent']?.slice(0, 500) ?? null, JSON.stringify(metadata)]
  );
}

