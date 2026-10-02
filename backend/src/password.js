import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const N = 16384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Password must contain 12–1024 characters.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof encoded !== 'string') return false;
  const [scheme, cost, blockSize, parallelism, saltText, keyText] = encoded.split('$');
  if (scheme !== 'scrypt' || !saltText || !keyText || Number(cost) !== N || Number(blockSize) !== r || Number(parallelism) !== p) return false;
  try {
    const expected = Buffer.from(keyText, 'base64url');
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N, r, p, maxmem: 64 * 1024 * 1024
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

