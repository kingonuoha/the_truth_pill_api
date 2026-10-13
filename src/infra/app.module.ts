import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../core/prisma/prisma.module';
import { JwtAuthGuard } from '../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../shared/guards/roles.guard';
import { AppConfigModule } from './config/app-config.module';
import { AuthModule } from '../modules/auth/auth.module';
import { OtpModule } from '../modules/otp/otp.module';
import { UsersModule } from '../modules/users/users.module';
import { ArticlesModule } from '../modules/articles/articles.module';
import { CategoriesModule } from '../modules/categories/categories.module';
import { PillarsModule } from '../modules/pillars/pillars.module';
import { QuotesModule } from '../modules/quotes/quotes.module';
import { AdminModule } from '../modules/admin/admin.module';
import { AdsModule } from '../modules/ads/ads.module';
import { SiteSettingsModule } from '../modules/site-settings/site-settings.module';
import { EngagementModule } from '../modules/engagement/engagement.module';
import { AnalyticsModule } from '../modules/analytics/analytics.module';
import { AiModule } from '../modules/ai/ai.module';
import { EmailsModule } from '../modules/emails/emails.module';
import { StreamModule } from '../modules/stream/stream.module';

/**
 * The composition root (D1).
 *
 * Phase 03 registered infrastructure only. Phase 04 adds the auth modules and
 * the two **global, default-deny** guards (ADR-007 + ADR-017):
 *
 * 1. `JwtAuthGuard` — verifies the bearer token and resolves `sub`; every route
 *    not marked `@Public()` requires a valid token.
 * 2. `RolesGuard` — for routes marked `@Roles(...)`, reads the role from the
 *    `users` row (never a token claim).
 *
 * Order matters: `JwtAuthGuard` runs first so `request.user` exists before
 * `RolesGuard` consults it. Feature modules land in Phases 05–08.
 *
 * Layer direction: `infra` depends on `core` and `shared`; `core` depends on
 * `shared`; `modules` depends on all three.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    OtpModule,
    ArticlesModule,
    CategoriesModule,
    PillarsModule,
    QuotesModule,
    AdminModule,
    AdsModule,
    SiteSettingsModule,
    EngagementModule,
    AnalyticsModule,
    AiModule,
    EmailsModule,
    StreamModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
