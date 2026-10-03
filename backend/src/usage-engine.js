import { quoteUsage } from './pricing.js';

export async function recordUsage(db, { workspaceId, provider = null, service, usageType, quantity, unit, currency = 'INR', externalReference = null, idempotencyKey, metadata = {} }) {
  if (!workspaceId || !idempotencyKey) throw Object.assign(new Error('workspaceId and idempotencyKey are required.'), { code: 'USAGE_IDEMPOTENCY_REQUIRED', status: 400 });
  const quote = await quoteUsage(db, { workspaceId, provider, service, usageType, quantity, unit, currency });
  const result = await db.query(`INSERT INTO usage_events(workspace_id,provider,service,usage_type,quantity,unit,provider_cost,internal_charge,currency,external_reference,idempotency_key,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,
    [workspaceId, provider, service, usageType, quote.quantity, unit, quote.providerCost, quote.customerCharge, quote.currency, externalReference, idempotencyKey, JSON.stringify({ ...metadata, rateId: quote.rateId })]);
  if (result.rows[0]) return { event: result.rows[0], duplicate: false, quote };
  const prior = await db.query('SELECT * FROM usage_events WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey]);
  return { event: prior.rows[0], duplicate: true, quote };
}

export async function usageSummary(db, { workspaceId, from, to, currency = 'INR' }) {
  const result = await db.query(`SELECT service, provider, usage_type, unit, currency, SUM(quantity) quantity, SUM(provider_cost) provider_cost, SUM(internal_charge) client_charge
    FROM usage_events WHERE workspace_id=$1 AND occurred_at >= $2 AND occurred_at < $3 AND currency=$4
    GROUP BY service, provider, usage_type, unit, currency ORDER BY service, provider, usage_type`, [workspaceId, from, to, currency]);
  return result.rows;
}

export async function budgetStatus(db, { workspaceId, from, to }) {
  const result = await db.query(`SELECT b.id, b.name, b.period_limit, b.currency, COALESCE(SUM(u.internal_charge),0) spent
    FROM usage_budgets b LEFT JOIN usage_events u ON u.workspace_id=b.workspace_id AND u.currency=b.currency AND u.occurred_at >= $2 AND u.occurred_at < $3
    WHERE b.workspace_id=$1 AND b.active=true GROUP BY b.id ORDER BY b.name`, [workspaceId, from, to]);
  return result.rows.map(row => ({ ...row, remaining: Math.max(0, Number(row.period_limit) - Number(row.spent)), exceeded: Number(row.spent) >= Number(row.period_limit) }));
}
