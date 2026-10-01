import { SlidingWindowLimiter } from './auth.js';

export const loginByIp = new SlidingWindowLimiter({ limit: 20, windowMs: 60_000 });
export const loginByEmail = new SlidingWindowLimiter({ limit: 8, windowMs: 15 * 60_000 });
export const bootstrapByIp = new SlidingWindowLimiter({ limit: 5, windowMs: 60 * 60_000 });

