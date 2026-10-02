const integer = (value, fallback) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('PORT must be a positive integer.');
  return parsed;
};

export const config = Object.freeze({
  env: process.env.APP_ENV ?? 'development',
  port: integer(process.env.PORT, 3000),
  appBaseUrl: process.env.APP_BASE_URL ?? 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseSsl: process.env.DATABASE_SSL === 'true',
  sessionTtlHours: integer(process.env.SESSION_TTL_HOURS, 12),
  bootstrapToken: process.env.BOOTSTRAP_TOKEN ?? '',
  trustProxy: process.env.TRUST_PROXY === 'true',
  bodyLimitBytes: 1024 * 1024,
  isProduction: (process.env.APP_ENV ?? 'development') === 'production'
});

if (config.isProduction) {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required in production.');
  if (config.appBaseUrl.startsWith('http://')) throw new Error('APP_BASE_URL must use HTTPS in production.');
}

