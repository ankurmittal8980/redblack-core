import { randomUUID } from 'node:crypto';
import { ProviderUnavailableError } from './providers.js';

const CHANNELS = new Set(['email', 'sms', 'whatsapp']);
const STATUS_ORDER = { queued: 0, received: 1, sent: 1, delivered: 2, read: 3, failed: 99 };
function assertChannel(channel) { if (!CHANNELS.has(channel)) throw Object.assign(new Error('Unsupported communication channel.'), { code: 'CHANNEL_UNSUPPORTED', status: 400 }); }
function consentDenied() { return Object.assign(new Error('Lead has opted out of communications.'), { code: 'COMMUNICATION_CONSENT_REQUIRED', status: 403 }); }

export class CommunicationGateway {
  constructor({ db, registry, clock = () => new Date() }) { this.db = db; this.registry = registry; this.clock = clock; }
  async send({ workspaceId, leadId, channel, provider, to, subject = null, body, idempotencyKey = randomUUID(), metadata = {} }) {
    assertChannel(channel);
    const lead = await this.db.query('SELECT do_not_contact, consent FROM leads WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId, leadId]);
    if (!lead.rows[0]) throw Object.assign(new Error('Lead was not found in this workspace.'), { code: 'LEAD_NOT_FOUND', status: 404 });
    if (lead.rows[0].do_not_contact || lead.rows[0].consent === false) throw consentDenied();
    const prior = await this.db.query('SELECT * FROM messages WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey]);
    if (prior.rows[0]) return { message: prior.rows[0], duplicate: true };
    const adapter = this.registry?.get(provider); if (!adapter) throw new ProviderUnavailableError(channel);
    const providerResult = await adapter.send({ workspaceId, channel, to, subject, body, metadata });
    const inserted = await this.db.query(`INSERT INTO messages(workspace_id,lead_id,channel,direction,provider_message_id,status,subject,body,sent_at,idempotency_key,metadata)
      VALUES($1,$2,$3,'outbound',$4,'sent',$5,$6,now(),$7,$8::jsonb) RETURNING *`, [workspaceId, leadId, channel, providerResult.providerMessageId ?? null, subject, body, idempotencyKey, JSON.stringify(metadata)]);
    await this.db.query(`INSERT INTO usage_events(workspace_id,provider,service,usage_type,quantity,unit,external_reference,idempotency_key,metadata)
      VALUES($1,$2,'communications','message',1,'message',$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, [workspaceId, provider, providerResult.providerMessageId ?? null, `communication:${inserted.rows[0].id}`, JSON.stringify({ channel })]);
    return { message: inserted.rows[0], duplicate: false };
  }
  async ingest({ workspaceId, provider, channel, eventId, providerMessageId, leadId = null, status = 'received', from, body, metadata = {} }) {
    assertChannel(channel);
    const receipt = await this.db.query('INSERT INTO webhook_receipts(provider,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id', [provider, eventId]);
    if (!receipt.rows[0]) return { duplicate: true };
    const existing = await this.db.query('SELECT id FROM messages WHERE workspace_id=$1 AND provider_message_id=$2', [workspaceId, providerMessageId]);
    if (existing.rows[0]) return { duplicate: true, messageId: existing.rows[0].id };
    const inserted = await this.db.query(`INSERT INTO messages(workspace_id,lead_id,channel,direction,provider_message_id,status,body,metadata)
      VALUES($1,$2,$3,'inbound',$4,$5,$6,$7::jsonb) RETURNING *`, [workspaceId, leadId, channel, providerMessageId, status, body ?? null, JSON.stringify({ ...metadata, from })]);
    return { duplicate: false, message: inserted.rows[0] };
  }
  async updateStatus({ workspaceId, providerMessageId, status, metadata = {} }) {
    if (!(status in STATUS_ORDER)) throw Object.assign(new Error('Unsupported message status.'), { code: 'STATUS_UNSUPPORTED', status: 400 });
    const prior = await this.db.query('SELECT * FROM messages WHERE workspace_id=$1 AND provider_message_id=$2', [workspaceId, providerMessageId]);
    if (!prior.rows[0]) throw Object.assign(new Error('Message was not found in this workspace.'), { code: 'MESSAGE_NOT_FOUND', status: 404 });
    if (STATUS_ORDER[status] < STATUS_ORDER[prior.rows[0].status] && status !== 'failed') return prior.rows[0];
    const updated = await this.db.query(`UPDATE messages SET status=$3, delivered_at=CASE WHEN $3 IN ('delivered','read') THEN COALESCE(delivered_at,now()) ELSE delivered_at END, metadata=metadata || $4::jsonb WHERE workspace_id=$1 AND provider_message_id=$2 RETURNING *`, [workspaceId, providerMessageId, status, JSON.stringify(metadata)]);
    return updated.rows[0];
  }
}
export { assertChannel, consentDenied };