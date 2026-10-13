import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './infra/app.module';
import { configureApp } from './infra/bootstrap/bootstrap';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const port = app.get(ConfigService).get<number>('PORT', 3001);
  await app.listen(port);

  new Logger('Bootstrap').log(`API listening on http://localhost:${port}/api/v1`);
}

bootstrap().catch((error: unknown) => {
  // Server-side startup diagnostics only. Never part of an HTTP response.
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  new Logger('Bootstrap').error('API failed to start', detail);
  process.exitCode = 1;
});
