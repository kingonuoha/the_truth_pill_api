/**
 * Test-only environment bootstrap (Phase 04).
 *
 * `ConfigModule.forRoot({ validate })` validates synchronously when
 * `AppModule` is loaded, so these must be set before that import runs. Imported
 * first in `app.e2e.ts`; dotenv never overrides an already-set variable, so
 * these win over `api/.env`. A locally-set test secret — never a live value.
 */
process.env.API_TOKEN_SECRET =
  process.env.API_TOKEN_SECRET ?? 'test-api-token-secret-0123456789abcdef';
process.env.INTERNAL_JOB_SECRET =
  process.env.INTERNAL_JOB_SECRET ?? 'test-internal-job-secret-0123456789';
process.env.API_TOKEN_ISSUER =
  process.env.API_TOKEN_ISSUER ?? 'https://thetruthpill.org';

// Phase 09: shrink the SSE coalescing windows so an e2e can observe a frame
// without waiting the production 10 s/30 s. The coalescing property is still
// proven (two writes inside one short window → one frame). Test-local only.
process.env.SSE_THROTTLE_MS_ARTICLE = process.env.SSE_THROTTLE_MS_ARTICLE ?? '80';
process.env.SSE_THROTTLE_MS_ENGAGEMENT = process.env.SSE_THROTTLE_MS_ENGAGEMENT ?? '80';
process.env.SSE_THROTTLE_MS_ANALYTICS = process.env.SSE_THROTTLE_MS_ANALYTICS ?? '80';
process.env.SSE_THROTTLE_MS_GLOBAL_STATS = process.env.SSE_THROTTLE_MS_GLOBAL_STATS ?? '80';
process.env.SSE_THROTTLE_MS_ADMIN = process.env.SSE_THROTTLE_MS_ADMIN ?? '80';

export const TEST_API_TOKEN_SECRET = process.env.API_TOKEN_SECRET;
export const TEST_INTERNAL_JOB_SECRET = process.env.INTERNAL_JOB_SECRET;
export const TEST_ISSUER = process.env.API_TOKEN_ISSUER;
