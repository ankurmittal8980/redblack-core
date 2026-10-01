export class ValidationError extends Error {
  constructor(message, field = undefined) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export function objectBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('A JSON object is required.');
  }
  return value;
}

export function requiredString(value, field, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text.`, field);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw new ValidationError(`${field} must contain ${min}–${max} characters.`, field);
  }
  return result;
}

export function optionalString(value, field, max = 5000) {
  if (value === undefined || value === null || value === '') return null;
  return requiredString(value, field, { min: 0, max });
}

export function uuid(value, field = 'id') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${field} must be a UUID.`, field);
  }
  return value;
}

export function enumValue(value, field, choices) {
  if (!choices.includes(value)) throw new ValidationError(`${field} must be one of: ${choices.join(', ')}.`, field);
  return value;
}

export function finiteNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new ValidationError(`${field} must be a number between ${min} and ${max}.`, field);
  }
  return result;
}

export function isoDate(value, field, { optional = false } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a valid ISO-8601 date.`, field);
  }
  return new Date(value).toISOString();
}

export function slug(value) {
  const result = requiredString(value, 'slug', { max: 80 }).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) {
    throw new ValidationError('slug may contain lowercase letters, numbers, and hyphens.');
  }
  return result;
}

export function normalizeEmail(value) {
  if (!value) return null;
  const email = requiredString(value, 'email', { max: 320 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('email is not valid.', 'email');
  return email;
}

export function normalizePhone(value) {
  if (!value) return null;
  const original = requiredString(value, 'phone', { max: 80 });
  const digits = original.replace(/[^\d+]/g, '');
  if (!/^\+?\d{7,15}$/.test(digits)) throw new ValidationError('phone must contain 7–15 digits.', 'phone');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function parseCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || Number.isNaN(Date.parse(value[0])) || typeof value[1] !== 'string') return null;
    return [new Date(value[0]).toISOString(), uuid(value[1], 'cursor id')];
  } catch {
    return null;
  }
}

export function makeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify([new Date(createdAt).toISOString(), id])).toString('base64url');
}

export function decimalToUnits(value, scale = 8) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidationError('amount must be a decimal number.');
  const input = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(input)) throw new ValidationError('amount must be a decimal number.');
  const negative = input.startsWith('-');
  const unsigned = negative ? input.slice(1) : input;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) throw new ValidationError(`amount supports at most ${scale} decimal places.`);
  const units = BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale));
  return negative ? -units : units;
}

export function unitsToDecimal(units, scale = 8) {
  const value = BigInt(units);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(scale);
  const whole = absolute / base;
  const fraction = String(absolute % base).padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function decimalProduct(a, b, scale = 8) {
  const product = decimalToUnits(a, scale) * decimalToUnits(b, scale) / (10n ** BigInt(scale));
  return unitsToDecimal(product, scale);
}

