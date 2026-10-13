import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { EngagementController } from './engagement.controller';
import { EngagementService } from './engagement.service';
import { OptionalAuthGuard } from '../../shared/guards/optional-auth.guard';

/**
 * Phase 06 engagement module (the 8 `web/convex/engagement.ts` functions).
 *
 * `PrismaModule` supplies the data client; `AuthModule` supplies the
 * `TokenService` + `JtiDenylistService` the module-local `OptionalAuthGuard`
 * re-verifies with (DEV-044). The global `JwtAuthGuard`/`RolesGuard` remain the
 * default-deny boundary (registered in `AppModule`).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [EngagementController],
  providers: [EngagementService, OptionalAuthGuard],
})
export class EngagementModule {}
