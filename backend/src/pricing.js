import { decimalProduct } from './validation.js';

export function calculateEstimate({ quantity, providerCostPerUnit, customerChargePerUnit }) {
  const normalizedQuantity = String(quantity);
  return {
    quantity: normalizedQuantity,
    providerCost: decimalProduct(normalizedQuantity, String(providerCostPerUnit)),
    customerCharge: decimalProduct(normalizedQuantity, String(customerChargePerUnit))
  };
}

export async function quoteUsage(db, { workspaceId, provider = null, service, usageType, quantity, unit, currency = 'INR' }) {
  const rate = await db.query(
    `SELECT id, provider, provider_cost_per_unit, customer_charge_per_unit, currency, valid_from
       FROM provider_rates
      WHERE (workspace_id = $1 OR workspace_id IS NULL)
        AND (provider = $2 OR provider IS NULL)
        AND service = $3 AND usage_type = $4 AND unit = $5 AND currency = $6
        AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())
      ORDER BY (workspace_id IS NOT NULL) DESC, (provider IS NOT NULL) DESC, valid_from DESC
      LIMIT 1`,
    [workspaceId, provider, service, usageType, unit, currency]
  );
  if (!rate.rows[0]) {
    const error = new Error('No active RedBlack rate is configured for this usage.');
    error.status = 409;
    error.code = 'RATE_NOT_CONFIGURED';
    throw error;
  }
  return {
    rateId: rate.rows[0].id,
    provider: rate.rows[0].provider,
    service,
    usageType,
    unit,
    currency: rate.rows[0].currency,
    ...calculateEstimate({ quantity, providerCostPerUnit: rate.rows[0].provider_cost_per_unit, customerChargePerUnit: rate.rows[0].customer_charge_per_unit })
  };
}

