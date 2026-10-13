import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from '../../core/errors/all-exceptions.filter';
import { isSwaggerEnabled, setupSwagger } from './swagger';

/**
 * The one version prefix (D4). Declared here so the runtime bootstrap and the
 * offline OpenAPI generator cannot drift apart.
 */
export const GLOBAL_PREFIX = 'api/v1';

/** Parse `CORS_ORIGIN` (comma-separated) into the allow-list. */
function resolveCorsOrigin(raw: string | undefined): string[] | false {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    // Secure default: no cross-origin browser access until explicitly allowed.
    return false;
  }
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * One place where every global concern is wired onto the app. Both `main.ts`
 * and the e2e harness call this, so the harness exercises the real runtime
 * configuration rather than a copy of it.
 *
 * Applies, in order:
 * 1. `/api/v1` global prefix (D4) — no route is reachable without it.
 * 2. The global `ValidationPipe` — `whitelist`, `forbidNonWhitelisted`,
 *    `transform` (ADR-010 / C10). Unknown body/query fields are rejected with
 *    a 400, not silently dropped.
 * 3. The global exception filter — one opaque error envelope (D3, Hard Rule 4).
 * 4. CORS from `CORS_ORIGIN` (secure default: disabled when unset).
 * 5. Swagger mount (D6–D9) — **not in production** (P03-SEC-001).
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService);

  app.setGlobalPrefix(GLOBAL_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: resolveCorsOrigin(config.get<string>('CORS_ORIGIN')),
    credentials: true,
  });

  // P03-SEC-001: the interactive UI + spec JSON are a production attack-surface
  // disclosure, so they are mounted in every environment except production.
  if (isSwaggerEnabled(config.get<string>('NODE_ENV'))) {
    setupSwagger(app);
  }
}
