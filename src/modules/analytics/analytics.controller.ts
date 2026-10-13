import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser, Public, Roles } from '../../shared/guards/auth.decorators';
import { OptionalAuth, OptionalCurrentUser } from '../../shared/guards/optional-auth.guard';
import { AnalyticsService } from './analytics.service';
import {
  DaysQueryDto,
  EmptyQueryDto,
  LogArticleViewDto,
  LogHeartbeatDto,
  LogPageVisitDto,
  RawVisitsQueryDto,
} from './dto/analytics.dto';
import {
  AnalyticsSuccessDto,
  DeviceStatsDto,
  GeographicStatDto,
  PageVisitDto,
  RawVisitsPageDto,
  ReferrerStatDto,
  TopContentDto,
  TrafficStatsDto,
} from './dto/analytics-responses.dto';
import { OptionalAuthOperation } from '../../shared/swagger/security';

const R400 = {
  status: 400,
  description: 'Invalid input, or a deleted caller-supplied identity/IP selector in the body or query (DEV-030/DEV-024).',
};
const R401 = { status: 401, description: 'Present-but-invalid bearer token, or missing on an admin route (fail-closed).' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };

/**
 * The analytics surface — the 10 frozen `web/convex/analytics.ts` functions.
 *
 * Groups (frozen matrix `docs/endpoints/analytics-guard-matrix.md`):
 * - **Public-ingest (3):** `@Public()` + `@OptionalAuth()` (fail-closed) — anonymous
 *   served, a valid token attaches the subject, a present-but-invalid token is 401
 *   (DEV-044). Published as `security: [{}, {bearerAuth: []}]` via
 *   `OptionalAuthOperation()` (DEV-058) so a generated client still sends the
 *   token it is able to send. `logPageVisit` derives `ipAddress` server-side
 *   (DEV-024).
 * - **Admin-read (7):** `@Roles('admin')` (DB role) — the frozen reads were public
 *   and exposed raw visitor IPs (DEV-045).
 *
 * No route accepts a caller-supplied identity selector; a body/query carrying one
 * is a 400 (DEV-030, ADR-007).
 */
@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /* ─────────────────────────── public ingest ─────────────────────────── */

  @Public()
  @OptionalAuthOperation() // DEV-058: anonymous permitted, token honoured — not PublicOperation()
  @OptionalAuth()
  @Post('log-page-visit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record a page visit (frozen `logPageVisit`, DEV-024/DEV-030/DEV-047)',
    description:
      'Anonymous or token-attributed. `ipAddress` is derived from the validated first `x-forwarded-for` hop and is never a body field; `globalStats` moves only for a public URL, atomically with the row.',
  })
  @ApiOkResponse({ type: AnalyticsSuccessDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  logPageVisit(
    @Body() dto: LogPageVisitDto,
    @OptionalCurrentUser() caller: AuthenticatedUser | null,
    @Headers('x-forwarded-for') forwardedFor?: string,
  ) {
    return this.analytics.logPageVisit(dto, caller ? caller.sub : null, forwardedFor);
  }

  @Public()
  @OptionalAuthOperation() // DEV-058: anonymous permitted, token honoured — not PublicOperation()
  @OptionalAuth()
  @Post('log-article-view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record an article view (frozen `logArticleView`, DEV-016/DEV-047)',
    description:
      'Server-side dedup on `(articleId, visitorId)` with the frozen 24 h `viewCount` cooldown; a refresh cannot inflate. Unknown article → opaque no-op 200.',
  })
  @ApiOkResponse({ type: AnalyticsSuccessDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  logArticleView(@Body() dto: LogArticleViewDto, @OptionalCurrentUser() caller: AuthenticatedUser | null) {
    return this.analytics.logArticleView(dto, caller ? caller.sub : null);
  }

  @Public()
  @OptionalAuthOperation() // DEV-058: anonymous permitted, token honoured — not PublicOperation()
  @OptionalAuth()
  @Post('log-heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record reading time (frozen `logHeartbeat`)',
    description: '`articles.actualReadingTime += seconds`; `articleViews.engagementTime += seconds` when the session row exists. Unknown article → opaque no-op 200.',
  })
  @ApiOkResponse({ type: AnalyticsSuccessDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  logHeartbeat(@Body() dto: LogHeartbeatDto) {
    return this.analytics.logHeartbeat(dto);
  }

  /* ─────────────────────────── admin reads ─────────────────────────── */

  @Roles('admin')
  @Get('traffic-stats')
  @ApiOperation({
    summary: 'Traffic series + trend (frozen `getTrafficStats`, admin-gated per DEV-045)',
    description: 'Zero-filled window (days clamped ≤ 90); prefers `dailyStats` with a bounded raw fallback; trend vs the previous equal window.',
  })
  @ApiOkResponse({ type: TrafficStatsDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  trafficStats(@Query() q: DaysQueryDto) {
    return this.analytics.getTrafficStats(q.days);
  }

  @Roles('admin')
  @Get('referrer-stats')
  @ApiOperation({
    summary: 'Referrer hostname buckets, top 10 (frozen `getReferrerStats`, DEV-045)',
    description: 'Grouped by `new URL(ref).hostname`; `Direct / Bookmark` for empty, `External Link` for unparseable.',
  })
  @ApiOkResponse({ type: [ReferrerStatDto] })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  referrerStats(@Query() q: DaysQueryDto) {
    return this.analytics.getReferrerStats(q.days);
  }

  @Roles('admin')
  @Get('geographic-stats')
  @ApiOperation({ summary: 'Country visit counts desc (frozen `getGeographicStats`, DEV-045)' })
  @ApiOkResponse({ type: [GeographicStatDto] })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  geographicStats(@Query() whitelist: EmptyQueryDto) {
    void whitelist;
    return this.analytics.getGeographicStats();
  }

  @Roles('admin')
  @Get('device-stats')
  @ApiOperation({ summary: 'Device / browser / OS counts (frozen `getDeviceStats`, DEV-045)' })
  @ApiOkResponse({ type: DeviceStatsDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  deviceStats(@Query() whitelist: EmptyQueryDto) {
    void whitelist;
    return this.analytics.getDeviceStats();
  }

  @Roles('admin')
  @Get('top-content')
  @ApiOperation({
    summary: 'Top published content by unique views (frozen `getTopContent`, DEV-045)',
    description: 'Published-only, sorted `uniqueViews` desc, top 10, with `avgReadTime` / `engagementRate`.',
  })
  @ApiOkResponse({ type: [TopContentDto] })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  topContent(@Query() whitelist: EmptyQueryDto) {
    void whitelist;
    return this.analytics.getTopContent();
  }

  @Roles('admin')
  @Get('real-time-activity')
  @ApiOperation({
    summary: 'Latest unique active sessions within 1 h (frozen `getRealTimeActivity`, DEV-045)',
    description: 'Latest 100 `pageVisits` within 1 h, one row per visitor. Admin PII shape (visitorId/ipAddress), frozen parity.',
  })
  @ApiOkResponse({ type: [PageVisitDto] })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  realTimeActivity(@Query() whitelist: EmptyQueryDto) {
    void whitelist;
    return this.analytics.getRealTimeActivity();
  }

  @Roles('admin')
  @Get('raw-visits')
  @ApiOperation({
    summary: 'Paginated raw visits / reactions (frozen `getRawVisits`, DEV-045)',
    description:
      '`type ∈ {all,visit,article,reaction}` + `days` + `search` + keyset `cursor`; invalid cursor resets to the first page. The reaction branch label is an opaque `User <first8>` handle — never a user email (DEV-034).',
  })
  @ApiOkResponse({ type: RawVisitsPageDto })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  rawVisits(@Query() q: RawVisitsQueryDto) {
    return this.analytics.getRawVisits(q);
  }
}
