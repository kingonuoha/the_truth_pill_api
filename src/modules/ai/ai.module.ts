import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { ArticlesModule } from '../articles/articles.module';
import { CategoriesModule } from '../categories/categories.module';
import { AiActionsController } from './ai-actions.controller';
import { AiController } from './ai.controller';
import { InternalAiController } from './internal-ai.controller';
import { AiService } from './ai.service';
import { BilledThrottleGuard } from './billed-throttle.guard';
import { HttpAiProviderClient } from './ai-provider.client';

/**
 * Phase 08 AI module — the 16 `web/convex/ai.ts` + 6 `ai_actions.ts` functions.
 *
 * `ArticlesModule` supplies the Phase 05 `saveAIDraft` writer + `getFeatured`
 * read reused by generation; `CategoriesModule` supplies the category names for
 * `shuffleTopics`. The provider client is injectable so a test can stub live
 * calls (⏳ PENDING — no key round-trip). Cron wiring is Phase 09; this module
 * registers no `@nestjs/schedule` job.
 */
@Module({
  imports: [PrismaModule, ArticlesModule, CategoriesModule],
  controllers: [AiController, AiActionsController, InternalAiController],
  providers: [AiService, BilledThrottleGuard, HttpAiProviderClient],
  exports: [AiService, HttpAiProviderClient, BilledThrottleGuard],
})
export class AiModule {}
