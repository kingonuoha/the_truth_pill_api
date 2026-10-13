import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/guards/auth.decorators';
import { InternalSecretGuard } from '../../shared/guards/internal-secret.guard';
import { INTERNAL_SECRET_SECURITY_SCHEME } from '../../shared/swagger/security';
import { InternalAnalyticsService } from './internal-analytics.service';
import { IncrementStatsDto } from './dto/analytics.dto';
import {
  BackfillResultDto,
  IncrementStatsResultDto,
  PurgeResultDto,
  RecomputeStatsDto,
  RollupResultDto,
} from './dto/analytics-responses.dto';

const R400 = {
  status: 400,
  description: 'Invalid input: malformed, empty, or unknown-field body (global whitelist pipe).',
};
const R401 = {
  status: 401,
  description: 'Missing or incorrect `x-internal-secret`, or `INTERNAL_JOB_SECRET` unset (fail-closed, Hard Rule 6).',
};

/**
 * The five frozen internal maintenance functions (Phase 07), worker/CLI only.
 *
 * Group (frozen matrix §2.3): `@Public()` + `InternalSecretGuard` (timing-safe,
 * fail-closed). `backfillIsArchived` is **no longer public** (DEV-046); the old
 * `DELETE /api/v1/migrations/backfill-is-archived` path does not exist.
 */
@ApiTags('internal-analytics')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@ApiHeader({ name: 'x-internal-secret', required: true, description: 'INTERNAL_JOB_SECRET' })
@Controller('internal')
export class InternalAnalyticsController {
  constructor(private readonly internal: InternalAnalyticsService) {}

  @Post('stats/recompute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recompute globalStats + Category.articleCount (frozen `initGlobalStats`, DEV-022)',
    description: 'Atomic, idempotent recompute in one `$transaction`; restores the Phase-02 baseline (`totalViews = sum(dailyStats.visits)`).',
  })
  @ApiOkResponse({ type: RecomputeStatsDto })
  @ApiResponse(R401)
  recompute() {
    return this.internal.recomputeGlobalStats();
  }

  @Post('stats/increment')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply signed deltas to globalStats (frozen `incrementStats`, DEV-022)',
    description: 'Maps the frozen `update` keys to columns; each is an atomic SQL increment. No-op 200 when the singleton row is absent.',
  })
  @ApiOkResponse({ type: IncrementStatsResultDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  increment(@Body() dto: IncrementStatsDto) {
    return this.internal.incrementStats(dto.update);
  }

  @Post('analytics/rollup-daily')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fold pageVisits into dailyStats (frozen `rollupDailyStats`)',
    description: 'Resumes from the `lastRollup` watermark (default 90 d back); idempotent on re-run.',
  })
  @ApiOkResponse({ type: RollupResultDto })
  @ApiResponse(R401)
  rollup() {
    return this.internal.rollupDailyStats();
  }

  @Post('analytics/purge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Purge pageVisits older than 90 days (frozen `purgeOldAnalytics`)',
    description: 'Bounded batch of 500. Never touches `dailyStats` or `totalViews` (DEV-022).',
  })
  @ApiOkResponse({ type: PurgeResultDto })
  @ApiResponse(R401)
  purge() {
    return this.internal.purgeOldAnalytics();
  }

  @Post('migrations/backfill-is-archived')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Backfill isArchived where NULL (frozen `backfillIsArchived`, DEV-046)',
    description: 'One-shot idempotent maintenance; internal/CLI only — the public path is gone (404).',
  })
  @ApiOkResponse({ type: BackfillResultDto })
  @ApiResponse(R401)
  backfill() {
    return this.internal.backfillIsArchived();
  }
}
