import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import {
  BEARER_SECURITY_SCHEME,
  INTERNAL_SECRET_HEADER,
  INTERNAL_SECRET_SECURITY_SCHEME,
} from '../../shared/swagger/security';

/** Where the interactive Swagger UI is mounted (dev convenience only). */
export const SWAGGER_UI_PATH = 'docs';

/**
 * Whether the interactive Swagger UI is mounted (P03-SEC-001).
 *
 * The UI and its spec JSON expose the full route/schema surface, so they are
 * a production attack-surface disclosure. Mount in every environment **except**
 * `production`. `validateEnv` guarantees `NODE_ENV` is always a non-empty
 * string (`development` when unset), so an unset value is treated as non-prod.
 *
 * The offline generator (`scripts/generate-openapi.ts`) calls
 * `buildOpenApiDocument` directly and is unaffected by this gate.
 */
export function isSwaggerEnabled(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'production';
}

/**
 * Build the OpenAPI document from the decorators (D6–D9, ADR-009).
 *
 * This is the source end of the generated chain
 * `@nestjs/swagger decorators → api/openapi.yaml → docs/types/api.ts`. The
 * `scripts/generate-openapi.ts` entry point calls this, then serialises the
 * result; the api-organizer agent owns that downstream step and never
 * hand-edits its output.
 *
 * Determinism (see `docs/types/README.md`): the `servers` entry is a fixed
 * constant, never read from the environment, and nothing here writes a
 * timestamp or an environment-derived version into the document.
 *
 * ## Security (P04-SEC-002, closed in Phase 10)
 *
 * `addSecurityRequirements` sets a **document-level default** of
 * `security: [{ bearerAuth: [] }]`. This is the spec-side image of the
 * default-deny `JwtAuthGuard` registered in `infra/app.module.ts`: every
 * operation is bearer-protected unless it overrides it. The two deliberate
 * overrides are `PublicOperation()` on `@Public()` routes and
 * `@ApiSecurity(internalJobSecret)` on `/internal/*` — see
 * `shared/swagger/security.ts`.
 *
 * Because the default is inherited, a controller added without auth metadata is
 * published as protected rather than as open. That is the same failure direction
 * the runtime guard has, which is the point.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('The Truth Pill API')
      .setDescription(
        'Public REST + SSE API for The Truth Pill. Generated from NestJS ' +
          'decorators — never hand-edited (ADR-009).',
      )
      .setVersion('1.0')
      .addServer('/')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'ADR-017 purpose-issued API token, HS256, `aud: truth-pill-api`, ' +
            'TTL 300 s. Sent as `Authorization: Bearer <token>`, minted ' +
            'server-side only. A token in a query string or body is ignored.',
        },
        BEARER_SECURITY_SCHEME,
      )
      .addApiKey(
        {
          type: 'apiKey',
          in: 'header',
          name: INTERNAL_SECRET_HEADER,
          description:
            '`INTERNAL_JOB_SECRET` on `/internal/*`, compared timing-safely. ' +
            'Worker/cron only; fails closed when unset (Hard Rule 6).',
        },
        INTERNAL_SECRET_SECURITY_SCHEME,
      )
      .addSecurityRequirements(BEARER_SECURITY_SCHEME)
      .build(),
  );
}

/** Mount the Swagger UI. The document itself comes from `buildOpenApiDocument`. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(SWAGGER_UI_PATH, app, buildOpenApiDocument(app));
}
