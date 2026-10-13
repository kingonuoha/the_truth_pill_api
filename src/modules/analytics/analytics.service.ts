import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { withUniqueRetry } from '../../shared/db/unique-retry';
import { resolveClientIp } from '../../shared/net/client-ip';
import {
  GlobalStatsChangedPayload,
  RealtimeActivityPayload,
  RealtimeSessionProjection,
  publishActivityAppended,
  publishArticleCounters,
  publishGlobalStats,
  publishRealtimeActivity,
} from '../stream/stream-publishers';
import {
  GeoLocationDto,
  LogArticleViewDto,
  LogHeartbeatDto,
  LogPageVisitDto,
  RawVisitTypeValue,
  RawVisitsQueryDto,
  RAW_VISITS_DEFAULT_LIMIT,
} from './dto/analytics.dto';
import {
  DeviceStatsDto,
  GeographicStatDto,
  GeoLocationResponseDto,
  PageVisitDto,
  RawVisitRowDto,
  RawVisitsPageDto,
  ReferrerStatDto,
  TopContentDto,
  TrafficChartPointDto,
  TrafficStatsDto,
} from './dto/analytics-responses.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Frozen 24-hour `viewCount` cooldown (`analytics.ts:113`). */
const VIEW_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Interactive-transaction ceiling. Analytics transactions are multi-query and
 * the Neon dev branch's scale-to-zero resume can transiently exceed the 5 s
 * default (P05-SEC-003, carried to Phase 09's keepalive design). This is resume
 * headroom, not lock-wait.
 */
const ANALYTICS_TX_TIMEOUT_MS = 15_000;

/** `globalStats` is a singleton keyed by this id. */
const GLOBAL_STATS_ID = 'global_stats';

/**
 * Project the 10 scalar counters only — never `id`/`updatedAt`
 * (`realtime.md` §3).
 */
function toGlobalStatsPayload(row: {
  articleCount: number;
  publishedArticleCount: number;
  draftArticleCount: number;
  scheduledArticleCount: number;
  aiDraftCount: number;
  usersCount: number;
  commentsCount: number;
  pendingCommentsCount: number;
  totalViews: number;
  totalUniqueViews: number;
}): GlobalStatsChangedPayload {
  return {
    articleCount: row.articleCount,
    publishedArticleCount: row.publishedArticleCount,
    draftArticleCount: row.draftArticleCount,
    scheduledArticleCount: row.scheduledArticleCount,
    aiDraftCount: row.aiDraftCount,
    usersCount: row.usersCount,
    commentsCount: row.commentsCount,
    pendingCommentsCount: row.pendingCommentsCount,
    totalViews: row.totalViews,
    totalUniqueViews: row.totalUniqueViews,
  };
}

/** The narrow `article.counters` frame — identifiers + changed fields (DEV-007). */
function toCountersPayload(
  articleId: string,
  row: { viewCount: number; uniqueViewCount: number; actualReadingTime: number | null },
): {
  articleId: string;
  viewCount: number;
  uniqueViewCount: number;
  actualReadingTime: number;
} {
  return {
    articleId,
    viewCount: row.viewCount,
    uniqueViewCount: row.uniqueViewCount,
    actualReadingTime: row.actualReadingTime ?? 0,
  };
}

/** Frozen safety cap for the referrer/geo/device reads (`analytics.ts:216,244,261`). */
const RAW_READ_TAKE = 5000;
/** Frozen realtime cap (`analytics.ts:361`). */
const REALTIME_TAKE = 100;
/** Frozen top-content source cap (`analytics.ts:295`). */
const TOP_CONTENT_TAKE = 200;
const TOP_CONTENT_LIMIT = 10;
/** Frozen dailyStats read cap (`analytics.ts:157`). */
const DAILY_READ_TAKE = 500;
/** Frozen cold-start raw fallback cap (`analytics.ts:187`). */
const TRAFFIC_FALLBACK_TAKE = 100;

/** Frozen `isPublicRoute` (`analytics.ts:7-8`) — admin/auth flows never count. */
export function isPublicRoute(url: string): boolean {
  return !/(^|\/)(admin|dashboard|login|signup|auth)(\/|$)/.test(url);
}

/** Narrow a stored JSON value to a plain object, no cast. */
function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

/** Build the stored geo JSON object from the validated client payload. */
function toGeoJson(geo: GeoLocationDto): Record<string, string> {
  const out: Record<string, string> = {};
  if (geo.country !== undefined) out.country = geo.country;
  if (geo.city !== undefined) out.city = geo.city;
  return out;
}

/** Normalise a stored geo object to the response shape. */
function toGeoResponse(value: Prisma.JsonValue | null): GeoLocationResponseDto | null {
  const obj = jsonObject(value);
  if (!obj) return null;
  return {
    country: typeof obj.country === 'string' ? obj.country : null,
    city: typeof obj.city === 'string' ? obj.city : null,
  };
}

/** UTC `YYYY-MM-DD` from a Date. */
function utcDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

/** A UTC midnight Date for a `YYYY-MM-DD` key (the `dailyStats.date` column). */
function utcDateValue(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/** Opaque keyset cursor: `<epochMillis>:<id>`, base64url. */
function encodeCursor(date: Date, id: string): string {
  return Buffer.from(`${date.getTime()}:${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { date: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = raw.indexOf(':');
    if (separator <= 0) return null;
    const millis = Number.parseInt(raw.slice(0, separator), 10);
    const id = raw.slice(separator + 1);
    if (!Number.isFinite(millis) || id.length === 0) return null;
    return { date: new Date(millis), id };
  } catch {
    return null;
  }
}

function isDeviceKey(value: string): value is 'mobile' | 'tablet' | 'desktop' {
  return value === 'mobile' || value === 'tablet' || value === 'desktop';
}

interface PageVisitRow {
  id: string;
  visitorId: string;
  url: string;
  ipAddress: string;
  geoLocation: Prisma.JsonValue;
  device: string;
  browser: string;
  os: string;
  referrer: string | null;
  timestamp: Date;
  user: { id: string } | null;
}

function toPageVisitDto(row: PageVisitRow): PageVisitDto {
  return {
    id: row.id,
    visitorId: row.visitorId,
    userRef: row.user?.id ?? null,
    url: row.url,
    ipAddress: row.ipAddress,
    geoLocation: toGeoResponse(row.geoLocation),
    device: row.device,
    browser: row.browser,
    os: row.os,
    referrer: row.referrer,
    timestamp: row.timestamp.toISOString(),
  };
}

/**
 * The narrow, PII-free `analytics.realtime` session row (`realtime.md` §3): the
 * six display fields only. No `visitorId`, `userRef` (the dedupe key, dropped),
 * `ipAddress`, or `geoLocation`, and never a document field (DEV-055).
 */
function toRealtimeSession(row: {
  url: string;
  device: string;
  browser: string;
  os: string;
  referrer: string | null;
  timestamp: Date;
}): RealtimeSessionProjection {
  return {
    url: row.url,
    device: row.device,
    browser: row.browser,
    os: row.os,
    referrer: row.referrer,
    timestamp: row.timestamp.toISOString(),
  };
}

/**
 * The Phase 07 public-ingest + admin-read surface (10 of the frozen
 * `web/convex/analytics.ts` functions).
 *
 * Ingest attribution resolves only from the verified token `sub` or is `null`
 * (DEV-030 analytics half); `pageVisits.ipAddress` is a validated first hop
 * (DEV-024); every counter write is atomic with the row it describes, in the
 * same `$transaction` (DEV-047, Migration Rule 5). One `logArticleView`
 * increment per article per session with the frozen 24 h cooldown (DEV-016).
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* ─────────────────────────── public ingest ─────────────────────────── */

  /**
   * `logPageVisit` (`analytics.ts:10-75`). Upserts `visitorTracking` by
   * `trackingCode`, inserts the `pageVisits` row with the validated IP, and —
   * only for a public route — moves `globalStats.totalViews` / `totalUniqueViews`
   * **in the same `$transaction`** (DEV-047; the frozen code deferred this
   * through `runAfter`, which loses the delta). The unique
   * `visitorTracking.trackingCode` first-visit race is resolved by
   * `withUniqueRetry` (P07-SEC-002), mirroring `logArticleView`.
   */
  async logPageVisit(
    dto: LogPageVisitDto,
    sub: string | null,
    forwardedFor: string | undefined,
  ): Promise<{ success: true }> {
    const now = new Date();
    const ipAddress = resolveClientIp(forwardedFor ?? null);
    const geoLocation = dto.geoLocation ? toGeoJson(dto.geoLocation) : undefined;
    const publicRoute = isPublicRoute(dto.url);

    const result = await withUniqueRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const tracking = await tx.visitorTracking.findUnique({
            where: { trackingCode: dto.visitorId },
            select: { id: true },
          });
          const isNewVisitor = tracking === null;

          if (tracking) {
            await tx.visitorTracking.update({
              where: { trackingCode: dto.visitorId },
              data: {
                lastVisit: now,
                totalVisits: { increment: 1 },
                ...(sub ? { user: { connect: { id: sub } } } : {}),
              },
            });
          } else {
            await tx.visitorTracking.create({
              data: {
                trackingCode: dto.visitorId,
                firstVisit: now,
                lastVisit: now,
                totalVisits: 1,
                ...(sub ? { user: { connect: { id: sub } } } : {}),
              },
            });
          }

          const visit = await tx.pageVisit.create({
            data: {
              visitorId: dto.visitorId,
              url: dto.url,
              ipAddress,
              device: dto.device,
              browser: dto.browser,
              os: dto.os,
              referrer: dto.referrer ?? null,
              timestamp: now,
              ...(sub ? { user: { connect: { id: sub } } } : {}),
              ...(geoLocation ? { geoLocation } : {}),
            },
            select: { id: true },
          });

          // DoD #16 / isPublicRoute (`analytics.ts:7`): admin/auth browsing must
          // not publish a `globalStats.changed` frame nor move `totalViews`.
          const stats = publicRoute
            ? await tx.globalStats.upsert({
                where: { id: GLOBAL_STATS_ID },
                update: {
                  totalViews: { increment: 1 },
                  ...(isNewVisitor ? { totalUniqueViews: { increment: 1 } } : {}),
                },
                create: {
                  id: GLOBAL_STATS_ID,
                  totalViews: 1,
                  totalUniqueViews: isNewVisitor ? 1 : 0,
                },
              })
            : null;

          return { visitId: visit.id, stats };
        },
        { timeout: ANALYTICS_TX_TIMEOUT_MS },
      ),
    );

    // Publish after commit, absolute values only (DEV-047 / DEV-055).
    if (result.stats) publishGlobalStats(toGlobalStatsPayload(result.stats));
    if (publicRoute) {
      publishActivityAppended({
        id: result.visitId,
        url: dto.url,
        device: dto.device,
        browser: dto.browser,
        os: dto.os,
        timestamp: now.toISOString(),
      });
    }
    // The admin `analytics:realtime` aggregate, coalesced on the connection's
    // 10 s window. Fire-and-forget: its read must not add latency to the ingest
    // (absolute values self-heal on the next visit).
    void this.publishRealtimeSnapshot();

    return { success: true };
  }

  /**
   * Build the `analytics.realtime` payload — the same source and dedupe as
   * `getRealTimeActivity` (`analytics.ts:354-373`): the latest ≤ 100
   * `pageVisits` within 1 h, one row per visitor — projected narrow and
   * **PII-free** (`realtime.md` §3). `visitorId` is used only as the dedupe key
   * and is never emitted; no `userRef`, `ipAddress`, or `geoLocation`, and never
   * a document field (DEV-007 / DEV-055).
   */
  private async buildRealtimeActivityPayload(): Promise<RealtimeActivityPayload> {
    const latest = await this.prisma.pageVisit.findMany({
      where: { timestamp: { gt: new Date(Date.now() - HOUR_MS) } },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: REALTIME_TAKE,
      select: {
        visitorId: true,
        url: true,
        device: true,
        browser: true,
        os: true,
        referrer: true,
        timestamp: true,
      },
    });
    const seen = new Set<string>();
    const sessions: RealtimeSessionProjection[] = [];
    for (const visit of latest) {
      if (seen.has(visit.visitorId)) continue;
      seen.add(visit.visitorId);
      sessions.push(toRealtimeSession(visit));
    }
    return {
      windowSeconds: Math.floor(HOUR_MS / 1000),
      activeSessions: sessions.length,
      sessions,
    };
  }

  /**
   * Publish the coalesced `analytics.realtime` frame after a committed visit.
   * Best-effort by design: a failed snapshot must never fail the ingest. The
   * warning is static because a Prisma driver error can echo the connection
   * string, so its text is never logged (P05-SEC-001).
   */
  private async publishRealtimeSnapshot(): Promise<void> {
    try {
      publishRealtimeActivity(await this.buildRealtimeActivityPayload());
    } catch {
      this.logger.warn('analytics.realtime snapshot failed; frame skipped');
    }
  }

  /**
   * `logArticleView` (`analytics.ts:77-128`). Server-side dedup on the unique
   * `(articleId, visitorId)` (DEV-016):
   * - no row → `uniqueViewCount +1`, `viewCount +1`, insert the row;
   * - row and `now - viewedAt > 24 h` → `viewCount +1`, refresh the watermark;
   * - row within 24 h → no change (a refresh cannot inflate).
   * Unknown article → opaque no-op (matrix adjudication D). Atomic counters
   * (DEV-047); the unique index + retry resolves a concurrent same-key race.
   */
  async logArticleView(dto: LogArticleViewDto, sub: string | null): Promise<{ success: true }> {
    const counters = await withUniqueRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const article = await tx.article.findUnique({
            where: { id: dto.articleId },
            select: { id: true },
          });
          if (!article) return null; // opaque no-op 200 (adjudication D)

          const existing = await tx.articleView.findUnique({
            where: {
              articleId_visitorId: { articleId: dto.articleId, visitorId: dto.visitorId },
            },
            select: { id: true, viewedAt: true },
          });
          const now = new Date();

          if (!existing) {
            await tx.articleView.create({
              data: {
                visitorId: dto.visitorId,
                viewedAt: now,
                article: { connect: { id: dto.articleId } },
                ...(sub ? { user: { connect: { id: sub } } } : {}),
              },
            });
            return tx.article.update({
              where: { id: dto.articleId },
              data: {
                uniqueViewCount: { increment: 1 },
                viewCount: { increment: 1 },
              },
              select: { viewCount: true, uniqueViewCount: true, actualReadingTime: true },
            });
          }

          if (now.getTime() - existing.viewedAt.getTime() > VIEW_COOLDOWN_MS) {
            await tx.articleView.update({
              where: { id: existing.id },
              data: {
                viewedAt: now,
                ...(sub ? { user: { connect: { id: sub } } } : {}),
              },
            });
            return tx.article.update({
              where: { id: dto.articleId },
              data: { viewCount: { increment: 1 } },
              select: { viewCount: true, uniqueViewCount: true, actualReadingTime: true },
            });
          }
          return null;
        },
        { timeout: ANALYTICS_TX_TIMEOUT_MS },
      ),
    );

    // DEV-007 / DEV-055: a narrow, absolute-value `article.counters` frame —
    // identifiers plus only the fields that moved, never the document.
    if (counters) publishArticleCounters(dto.articleId, toCountersPayload(dto.articleId, counters));
    return { success: true };
  }

  /**
   * `logHeartbeat` (`analytics.ts:323-352`). `articles.actualReadingTime +=
   * seconds`; `articleViews.engagementTime += seconds` when the session row
   * exists. Both columns are nullable, so the increments COALESCE. Unknown
   * article → opaque no-op.
   */
  async logHeartbeat(dto: LogHeartbeatDto): Promise<{ success: true }> {
    const counters = await this.prisma.$transaction(
      async (tx) => {
        const article = await tx.article.findUnique({
          where: { id: dto.articleId },
          select: { id: true },
        });
        if (!article) return null;

        await tx.$executeRaw`
          UPDATE "articles"
          SET "actualReadingTime" = COALESCE("actualReadingTime", 0) + ${dto.seconds}
          WHERE "id" = ${dto.articleId}::uuid`;

        const view = await tx.articleView.findUnique({
          where: {
            articleId_visitorId: { articleId: dto.articleId, visitorId: dto.visitorId },
          },
          select: { id: true },
        });
        if (view) {
          await tx.$executeRaw`
            UPDATE "articleViews"
            SET "engagementTime" = COALESCE("engagementTime", 0) + ${dto.seconds}
            WHERE "id" = ${view.id}::uuid`;
        }

        return tx.article.findUnique({
          where: { id: dto.articleId },
          select: { viewCount: true, uniqueViewCount: true, actualReadingTime: true },
        });
      },
      { timeout: ANALYTICS_TX_TIMEOUT_MS },
    );

    if (counters) publishArticleCounters(dto.articleId, toCountersPayload(dto.articleId, counters));
    return { success: true };
  }

  /* ─────────────────────────── admin reads ─────────────────────────── */

  /** `getTrafficStats` (`analytics.ts:130-205`). Zero-filled window, dailyStats preferred. */
  async getTrafficStats(daysInput?: number): Promise<TrafficStatsDto> {
    const days = Math.min(daysInput ?? 30, 90);
    const now = Date.now();
    const startTime = now - days * DAY_MS;
    const prevStartTime = startTime - days * DAY_MS;

    const dateKeys: string[] = [];
    const stats = new Map<string, TrafficChartPointDto>();
    for (let i = 0; i < days; i++) {
      const key = utcDateKey(new Date(now - (days - 1 - i) * DAY_MS));
      dateKeys.push(key);
      stats.set(key, { date: key, visits: 0, uniqueVisitors: 0 });
    }
    const firstKey = dateKeys[0];
    const lastKey = dateKeys[dateKeys.length - 1];

    const dailyRows = await this.prisma.dailyStat.findMany({
      where: { date: { gte: utcDateValue(firstKey), lte: utcDateValue(lastKey) } },
      orderBy: { date: 'asc' },
      take: DAILY_READ_TAKE,
    });

    let currentCount = 0;
    let prevCount = 0;

    if (dailyRows.length > 0) {
      for (const row of dailyRows) {
        const bucket = stats.get(utcDateKey(row.date));
        if (bucket) {
          bucket.visits = row.visits;
          bucket.uniqueVisitors = row.uniqueVisitors;
        }
        currentCount += row.visits;
      }
      const prevStartKey = utcDateKey(new Date(prevStartTime));
      const prevRows = await this.prisma.dailyStat.findMany({
        where: { date: { gte: utcDateValue(prevStartKey), lt: utcDateValue(firstKey) } },
        take: DAILY_READ_TAKE,
      });
      prevCount = prevRows.reduce((sum, row) => sum + row.visits, 0);
    } else {
      // Cold start: bounded raw fallback until the first daily rollup runs.
      const visits = await this.prisma.pageVisit.findMany({
        where: { timestamp: { gt: new Date(startTime) } },
        orderBy: { timestamp: 'asc' },
        take: TRAFFIC_FALLBACK_TAKE,
      });
      for (const visit of visits) {
        const bucket = stats.get(utcDateKey(visit.timestamp));
        if (bucket) bucket.visits++;
      }
      currentCount = visits.length;
    }

    const trend = prevCount === 0 ? 100 : ((currentCount - prevCount) / prevCount) * 100;
    return {
      chartData: [...stats.values()],
      totalVisits: currentCount,
      trend: trend.toFixed(1),
      isTrendUp: trend >= 0,
    };
  }

  /** `getReferrerStats` (`analytics.ts:207-240`). Hostname buckets, top 10. */
  async getReferrerStats(daysInput?: number): Promise<ReferrerStatDto[]> {
    const days = daysInput ?? 30;
    const startTime = new Date(Date.now() - days * DAY_MS);
    const visits = await this.prisma.pageVisit.findMany({
      where: { timestamp: { gt: startTime } },
      select: { referrer: true },
      take: RAW_READ_TAKE,
    });

    const referrers = new Map<string, number>();
    for (const visit of visits) {
      let domain = 'Direct / Bookmark';
      const ref = visit.referrer;
      if (ref && ref !== '') {
        try {
          domain = new URL(ref).hostname;
        } catch {
          domain = 'External Link';
        }
      }
      referrers.set(domain, (referrers.get(domain) ?? 0) + 1);
    }

    return [...referrers.entries()]
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }

  /** `getGeographicStats` (`analytics.ts:242-257`). Country counts desc. */
  async getGeographicStats(): Promise<GeographicStatDto[]> {
    const visits = await this.prisma.pageVisit.findMany({
      select: { geoLocation: true },
      take: RAW_READ_TAKE,
    });
    const counts = new Map<string, GeographicStatDto>();
    for (const visit of visits) {
      const obj = jsonObject(visit.geoLocation);
      const country =
        obj && typeof obj.country === 'string' && obj.country !== '' ? obj.country : 'Unknown';
      const bucket = counts.get(country) ?? { country, count: 0 };
      bucket.count += 1;
      counts.set(country, bucket);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }

  /** `getDeviceStats` (`analytics.ts:259-288`). mobile/tablet/desktop + browsers + OS. */
  async getDeviceStats(): Promise<DeviceStatsDto> {
    const visits = await this.prisma.pageVisit.findMany({
      select: { device: true, browser: true, os: true },
      take: RAW_READ_TAKE,
    });
    const devices: Record<'mobile' | 'tablet' | 'desktop', number> = {
      mobile: 0,
      tablet: 0,
      desktop: 0,
    };
    const browsers = new Map<string, number>();
    const oss = new Map<string, number>();
    for (const visit of visits) {
      if (isDeviceKey(visit.device)) devices[visit.device] += 1;
      browsers.set(visit.browser, (browsers.get(visit.browser) ?? 0) + 1);
      oss.set(visit.os, (oss.get(visit.os) ?? 0) + 1);
    }
    return {
      devices: Object.entries(devices).map(([name, value]) => ({ name, value })),
      browsers: [...browsers.entries()].map(([name, value]) => ({ name, value })),
      oss: [...oss.entries()].map(([name, value]) => ({ name, value })),
    };
  }

  /** `getTopContent` (`analytics.ts:290-321`). Published-only, `uniqueViews` desc, top 10. */
  async getTopContent(): Promise<TopContentDto[]> {
    const articles = await this.prisma.article.findMany({
      where: { status: 'published' },
      select: {
        id: true,
        title: true,
        viewCount: true,
        uniqueViewCount: true,
        reactionsCount: true,
        actualReadingTime: true,
      },
      take: TOP_CONTENT_TAKE,
    });
    const stats = articles.map((a) => {
      const reactions = a.reactionsCount ?? 0;
      const unique = a.uniqueViewCount;
      const avgReadTime =
        a.actualReadingTime && unique > 0 ? Math.round(a.actualReadingTime / unique) : 0;
      return {
        id: a.id,
        title: a.title,
        views: a.viewCount,
        uniqueViews: unique,
        reactions,
        avgReadTime,
        engagementRate: unique > 0 ? (reactions / unique) * 100 : 0,
      };
    });
    return stats.sort((a, b) => b.uniqueViews - a.uniqueViews).slice(0, TOP_CONTENT_LIMIT);
  }

  /** `getRealTimeActivity` (`analytics.ts:354-373`). Latest 100 within 1 h, one per visitor. */
  async getRealTimeActivity(): Promise<PageVisitDto[]> {
    const latest = await this.prisma.pageVisit.findMany({
      where: { timestamp: { gt: new Date(Date.now() - HOUR_MS) } },
      orderBy: { timestamp: 'desc' },
      take: REALTIME_TAKE,
      include: { user: { select: { id: true } } },
    });
    const seen = new Set<string>();
    const out: PageVisitDto[] = [];
    for (const visit of latest) {
      if (seen.has(visit.visitorId)) continue;
      seen.add(visit.visitorId);
      out.push(toPageVisitDto(visit));
    }
    return out;
  }

  /**
   * `getRawVisits` (`analytics.ts:375-461`). Convex `paginationOpts` becomes a
   * bounded keyset `cursor`; an invalid cursor resets to the first page. The
   * reaction branch's visitor label is the opaque frozen fallback — the
   * `user?.email` branch (`analytics.ts:410`) is deleted (DEV-045 / DEV-034).
   */
  async getRawVisits(query: RawVisitsQueryDto): Promise<RawVisitsPageDto> {
    const type: RawVisitTypeValue = query.type ?? 'all';
    const days = query.days ?? 30;
    const limit = query.limit ?? RAW_VISITS_DEFAULT_LIMIT;
    const startTime = new Date(Date.now() - days * DAY_MS);
    const search = query.search?.toLowerCase();

    if (type === 'reaction') {
      const cursor = decodeCursor(query.cursor);
      const where: Prisma.ReactionWhereInput = { createdAt: { gt: startTime } };
      if (cursor) {
        where.AND = [
          {
            OR: [
              { createdAt: { lt: cursor.date } },
              { createdAt: cursor.date, id: { lt: cursor.id } },
            ],
          },
        ];
      }
      const rows = await this.prisma.reaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: {
          article: { select: { title: true } },
          user: { select: { id: true } },
        },
      });
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      let data: RawVisitRowDto[] = page.map((r) => ({
        id: r.id,
        timestamp: r.createdAt.toISOString(),
        type: 'reaction',
        url: r.article?.title
          ? `Reaction: ${r.type} on "${r.article.title}"`
          : `Reaction: ${r.type}`,
        // Opaque handle only — never a user email (DEV-045 / DEV-034).
        visitorId: `User ${r.user.id.substring(0, 8)}`,
        ipAddress: '---',
        geoLocation: { country: 'N/A', city: 'N/A' },
        device: 'user',
        browser: '---',
        os: '---',
      }));
      if (search) {
        data = data.filter(
          (row) =>
            row.url.toLowerCase().includes(search) ||
            row.visitorId.toLowerCase().includes(search),
        );
      }
      const last = page[page.length - 1];
      return {
        data,
        page: {
          limit,
          hasMore,
          nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
        },
      };
    }

    // Visit / article branches share the `pageVisits` source.
    const and: Prisma.PageVisitWhereInput[] = [];
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      and.push({
        OR: [
          { timestamp: { lt: cursor.date } },
          { timestamp: cursor.date, id: { lt: cursor.id } },
        ],
      });
    }
    if (type === 'article') {
      and.push({ url: { contains: '/article/', mode: 'insensitive' } });
    }
    if (search) {
      and.push({
        OR: [
          { url: { contains: search, mode: 'insensitive' } },
          { ipAddress: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.PageVisitWhereInput = {
      timestamp: { gt: startTime },
      ...(and.length > 0 ? { AND: and } : {}),
    };
    const rows = await this.prisma.pageVisit.findMany({
      where,
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { user: { select: { id: true } } },
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      data: page.map(toPageVisitDto),
      page: {
        limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.timestamp, last.id) : null,
      },
    };
  }
}
