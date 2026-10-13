import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker/worker-app.module';

/**
 * Render Background Worker entry (ADR-006): `node dist/main-worker.js`.
 *
 * Boots the Nest application context **without** the HTTP server. The six
 * `@nestjs/schedule` jobs (DEV-056) keep the event loop alive; the worker holds
 * no Neon socket and uses a bounded keepalive (ADR-018). A per-job failure is
 * caught inside `ScheduledJobsService`, so the process is not expected to exit.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('Background worker started; 6 cron jobs registered');
}

bootstrap().catch((error: unknown) => {
  // Server-side startup diagnostics only — never part of an HTTP response.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  new Logger('Worker').error('Worker failed to start', detail);
  process.exitCode = 1;
});
