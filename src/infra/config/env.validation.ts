/**
 * Environment validation, run by `ConfigModule.forRoot({ validate })`.
 *
 * Rules:
 * - `DATABASE_URL` (the pooled Neon host) is required at runtime. Missing or
 *   empty → throw at boot, not a confusing driver error later.
 * - `PORT` is optional; defaults to 3001.
 * - `DIRECT_URL` is NOT required here. It is migration-only and read by
 *   `prisma.config.ts`, never at runtime (ADR-003).
 * - Phase 04 (ADR-017) auth keys are **optional at boot**. `API_TOKEN_SECRET`
 *   and `INTERNAL_JOB_SECRET` are empty in this environment; requiring them
 *   would make the app unbootable. Instead the guards fail closed when they
 *   are unset (401), which is the same posture as a missing token. A value is
 *   NEVER logged. Thrown messages name the key only.
 */
export interface ValidatedEnv extends Record<string, unknown> {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  /** HS256 key for ADR-017 API tokens. Optional; guards fail closed if unset. */
  API_TOKEN_SECRET?: string;
  /** Verify-only previous key for a zero-downtime rotation (ADR-017). */
  API_TOKEN_SECRET_PREVIOUS?: string;
  /** Expected token `iss`. Defaults to the site URL (ADR-017). */
  API_TOKEN_ISSUER?: string;
  /** Timing-safe secret for `/internal/*` (AGENTS.md Hard Rule 6). */
  INTERNAL_JOB_SECRET?: string;
  /** Bootstrap admin address for the CLI-only seed (DEV-003). */
  ADMIN_EMAIL?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): ValidatedEnv {
  const databaseUrl = config.DATABASE_URL;

  if (typeof databaseUrl !== 'string' || databaseUrl.trim().length === 0) {
    throw new Error(
      'Invalid environment: DATABASE_URL is required (the pooled Neon host).',
    );
  }

  const rawPort = config.PORT;
  const port =
    rawPort === undefined || rawPort === ''
      ? 3001
      : typeof rawPort === 'number'
        ? rawPort
        : Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Invalid environment: PORT must be an integer between 1 and 65535.',
    );
  }

  return {
    ...config,
    NODE_ENV:
      typeof config.NODE_ENV === 'string' && config.NODE_ENV.length > 0
        ? config.NODE_ENV
        : 'development',
    PORT: port,
    DATABASE_URL: databaseUrl,
  };
}
