import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OptionalAuthGuard } from '../../shared/guards/optional-auth.guard';
import { AnalyticsController } from './analytics.controller';
import { InternalAnalyticsController } from './internal-analytics.controller';
import { AnalyticsService } from './analytics.service';
import { InternalAnalyticsService } from './internal-analytics.service';

/**
 * Phase 07 analytics module (the 15 frozen functions across `analytics.ts`,
 * `stats.ts`, `rollup.ts`, `analytics_cleanup.ts`, `migrations.ts`).
 *
 * `PrismaModule` supplies the data client; `AuthModule` supplies the
 * `TokenService` + `JtiDenylistService` the shared `OptionalAuthGuard`
 * re-verifies with (DEV-044). The global `JwtAuthGuard`/`RolesGuard`
 * remain the default-deny boundary (registered in `AppModule`).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AnalyticsController, InternalAnalyticsController],
  providers: [AnalyticsService, InternalAnalyticsService, OptionalAuthGuard],
})
export class AnalyticsModule {}
