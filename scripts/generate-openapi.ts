import { NestFactory } from '@nestjs/core';
import { dump } from 'js-yaml';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/infra/app.module';
import { GLOBAL_PREFIX } from '../src/infra/bootstrap/bootstrap';
import { buildOpenApiDocument } from '../src/infra/bootstrap/swagger';
import { sortOpenApiDocument } from './sort-openapi';

/**
 * Offline OpenAPI generation (D8, ADR-009).
 *
 * Builds the Nest application in `preview` mode: metadata and routes are
 * scanned, but lifecycle hooks are not run and **no port is bound and no
 * Postgres connection is opened** (`PrismaService.onModuleInit` is skipped).
 * That is what lets `api:check` run on a machine with no secrets.
 *
 * Output is sorted (see `sort-openapi.ts`) so regeneration is a no-op diff.
 * Never hand-edit `api/openapi.yaml` — it is a build output (Rule 7).
 */

function parseOutPath(argv: string[]): string {
  const flag = argv.indexOf('--out');
  const value = flag >= 0 ? argv[flag + 1] : undefined;
  return resolve(value ?? 'openapi.yaml');
}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { preview: true, logger: false });
  app.setGlobalPrefix(GLOBAL_PREFIX);

  const document = sortOpenApiDocument(buildOpenApiDocument(app));
  const yaml = dump(document, { noRefs: true, lineWidth: -1, sortKeys: false });

  writeFileSync(parseOutPath(process.argv.slice(2)), yaml, 'utf8');
  process.stdout.write('openapi.yaml generated\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`openapi generation failed: ${message}\n`);
  process.exitCode = 1;
});
