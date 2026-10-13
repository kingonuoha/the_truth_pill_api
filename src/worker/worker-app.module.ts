import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from '../infra/config/app-config.module';
import { SchedulerModule } from './scheduler.module';

/**
 * The Render Background Worker composition root (ADR-006).
 *
 * Booted with `NestFactory.createApplicationContext` (no HTTP server, no global
 * JWT/Roles guards, no controllers) so the six crons run in a process separate
 * from the web service. `ScheduleModule.forRoot()` is registered **only** here
 * — the API web service never schedules a job.
 */
@Module({
  imports: [AppConfigModule, ScheduleModule.forRoot(), SchedulerModule],
})
export class WorkerAppModule {}
