import { Module } from '@nestjs/common';
import { PrismaModule } from '../core/prisma/prisma.module';
import { ArticlesModule } from '../modules/articles/articles.module';
import { AiModule } from '../modules/ai/ai.module';
import { EmailsModule } from '../modules/emails/emails.module';
import { InternalAnalyticsService } from '../modules/analytics/internal-analytics.service';
import { ScheduledJobsService } from './scheduled-jobs.service';
import { DbKeepaliveService } from './db-keepalive.service';

/**
 * Phase 09 worker services (ADR-006, DEV-056).
 *
 * Reuses the Phase 05/07/08 service classes directly — `ArticlesService`,
 * `EmailsService`, `AiService` via their modules' exports, and
 * `InternalAnalyticsService` declared here (it depends only on `PrismaService`).
 * No job body is forked; the scheduler only wires the six frozen periods.
 */
@Module({
  imports: [PrismaModule, ArticlesModule, AiModule, EmailsModule],
  providers: [InternalAnalyticsService, ScheduledJobsService, DbKeepaliveService],
  exports: [ScheduledJobsService],
})
export class SchedulerModule {}
