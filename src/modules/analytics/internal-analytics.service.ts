import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import {
  BackfillResultDto,
  IncrementStatsResultDto,
  PurgeResultDto,
  RecomputeStatsDto,
  RollupResultDto,
} from './dto/analytics-responses.dto';
import { IncrementStatsUpdateDto } from './dto/analytics.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * DAY_MS;
const ROLLUP_BATCH_SIZE = 5000;
const PURGE_BATCH_SIZE = 500;
const GLOBAL_STATS_ID = 'global_stats';
const ANALYTICS_TX_TIMEOUT_MS = 15_000;

/**
 * The Phase 07 internal maintenance surface (5 of the frozen functions):
 * `initGlobalStats`, `incrementStats`, `rollupDailyStats`, `purgeOldAnalytics`,
 * `backfillIsArchived`.
 *
 * These are worker/CLI operations, reachable only through
 * `InternalSecretGuard` under `/internal/*`. Every derived-counter write is an
 * atomic increment or an absolute recompute inside one `$transaction`
 * (DEV-022, Migration Rule 5). `purgeOldAnalytics` never touches `dailyStats`
 * or `totalViews` (DEV-022).
 */
@Injectable()
export class InternalAnalyticsService {
  private readonly logger = new Logger(InternalAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * `initGlobalStats` (`stats.ts:5-61`) — an atomic, idempotent **recompute**,
   * not an increment. Restores the Phase-02 signed-off baseline and closes the
   * Phase-06 C3 drift. `totalViews` is `sum(dailyStats.visits)` — NOT
   * `count(pageVisits)` (DEV-022). `Category.articleCount` is recomputed in the
   * same `$transaction`.
   */
  async recomputeGlobalStats(): Promise<RecomputeStatsDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const activeArticles = await tx.article.findMany({
          where: { NOT: { isArchived: true } },
          select: { status: true, source: true, categoryId: true },
        });

        const publishedCount = activeArticles.filter((a) => a.status === 'published').length;
        const draftCount = activeArticles.filter((a) => a.status === 'draft').length;
        const scheduledCount = activeArticles.filter((a) => a.status === 'scheduled').length;
        const aiDraftsCount = activeArticles.filter(
          (a) => a.source === 'ai' && a.status === 'draft',
        ).length;

        const usersCount = await tx.user.count();
        const comments = await tx.comment.findMany({ select: { status: true } });
        const pendingCommentsCount = comments.filter((c) => c.status === 'pending').length;
        const totalUniqueViews = await tx.visitorTracking.count();

        const dailySum = await tx.dailyStat.aggregate({ _sum: { visits: true } });
        const totalViews = dailySum._sum.visits ?? 0;

        const statsData = {
          articleCount: activeArticles.length,
          publishedArticleCount: publishedCount,
          draftArticleCount: draftCount,
          scheduledArticleCount: scheduledCount,
          aiDraftCount: aiDraftsCount,
          usersCount,
          commentsCount: comments.length,
          pendingCommentsCount,
          totalViews,
          totalUniqueViews,
        };

        const categories = await tx.category.findMany({ select: { id: true } });
        const byCategory = new Map<string, number>();
        for (const article of activeArticles) {
          if (!article.categoryId) continue;
          byCategory.set(article.categoryId, (byCategory.get(article.categoryId) ?? 0) + 1);
        }
        for (const category of categories) {
          await tx.category.update({
            where: { id: category.id },
            data: { articleCount: byCategory.get(category.id) ?? 0 },
          });
        }

        const saved = await tx.globalStats.upsert({
          where: { id: GLOBAL_STATS_ID },
          update: { ...statsData, updatedAt: new Date() },
          create: { id: GLOBAL_STATS_ID, ...statsData },
        });
        return { id: saved.id };
      },
      { timeout: ANALYTICS_TX_TIMEOUT_MS },
    );
  }

  /**
   * `incrementStats` (`stats.ts:63-99`) — a thin internal delta applier. Maps
   * the frozen `update` keys to columns and applies each as an atomic SQL
   * `increment` (never read-then-write). No-op when the singleton row is absent.
   */
  async incrementStats(update: IncrementStatsUpdateDto): Promise<IncrementStatsResultDto> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.globalStats.findUnique({
        where: { id: GLOBAL_STATS_ID },
        select: { id: true },
      });
      if (!row) return { success: false };

      const data: Prisma.GlobalStatsUpdateInput = {};
      if (update.totalArticles !== undefined) data.articleCount = { increment: update.totalArticles };
      if (update.publishedArticles !== undefined)
        data.publishedArticleCount = { increment: update.publishedArticles };
      if (update.draftArticles !== undefined)
        data.draftArticleCount = { increment: update.draftArticles };
      if (update.scheduledArticles !== undefined)
        data.scheduledArticleCount = { increment: update.scheduledArticles };
      if (update.aiDraftCount !== undefined)
        data.aiDraftCount = { increment: update.aiDraftCount };
      if (update.usersCount !== undefined) data.usersCount = { increment: update.usersCount };
      if (update.commentsCount !== undefined)
        data.commentsCount = { increment: update.commentsCount };
      if (update.pendingCommentsCount !== undefined)
        data.pendingCommentsCount = { increment: update.pendingCommentsCount };
      if (update.totalViews !== undefined) data.totalViews = { increment: update.totalViews };
      if (update.totalUniqueViews !== undefined)
        data.totalUniqueViews = { increment: update.totalUniqueViews };

      if (Object.keys(data).length > 0) {
        data.updatedAt = new Date();
        await tx.globalStats.update({ where: { id: GLOBAL_STATS_ID }, data });
      }
      return { success: true };
    }, { timeout: ANALYTICS_TX_TIMEOUT_MS });
  }

  /**
   * `rollupDailyStats` (`rollup.ts:21-79`). Resumes from the `dailyStats`
   * `lastRollup` watermark (default `now - 90 d`); folds `pageVisits` by UTC
   * date; advances the watermark to the max folded timestamp. Idempotent: a
   * re-run with no new visits processes 0.
   */
  async rollupDailyStats(): Promise<RollupResultDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const latestRow = await tx.dailyStat.findFirst({
          orderBy: { date: 'desc' },
          select: { lastRollup: true },
        });
        const watermark = latestRow?.lastRollup ?? new Date(Date.now() - RETENTION_MS);

        const visits = await tx.pageVisit.findMany({
          where: { timestamp: { gt: watermark } },
          orderBy: { timestamp: 'asc' },
          take: ROLLUP_BATCH_SIZE,
          select: { timestamp: true, visitorId: true },
        });

        const buckets = new Map<string, { visits: number; visitors: Set<string> }>();
        let maxTimestamp = watermark;
        for (const visit of visits) {
          const date = visit.timestamp.toISOString().split('T')[0];
          const bucket = buckets.get(date) ?? { visits: 0, visitors: new Set<string>() };
          bucket.visits += 1;
          bucket.visitors.add(visit.visitorId);
          buckets.set(date, bucket);
          if (visit.timestamp > maxTimestamp) maxTimestamp = visit.timestamp;
        }

        for (const [date, bucket] of buckets) {
          const dateValue = new Date(`${date}T00:00:00.000Z`);
          await tx.dailyStat.upsert({
            where: { date: dateValue },
            update: {
              visits: { increment: bucket.visits },
              uniqueVisitors: { increment: bucket.visitors.size },
              lastRollup: maxTimestamp,
            },
            create: {
              date: dateValue,
              visits: bucket.visits,
              uniqueVisitors: bucket.visitors.size,
              lastRollup: maxTimestamp,
            },
          });
        }

        return {
          processed: visits.length,
          dates: buckets.size,
          isDone: visits.length < ROLLUP_BATCH_SIZE,
        };
      },
      { timeout: ANALYTICS_TX_TIMEOUT_MS },
    );
  }

  /**
   * `purgeOldAnalytics` (`analytics_cleanup.ts:10-35`). Deletes `pageVisits`
   * older than 90 days in a bounded batch. Never touches `dailyStats` or
   * `totalViews` (DEV-022). Logs a count only — never a row value.
   */
  async purgeOldAnalytics(): Promise<PurgeResultDto> {
    const result = await this.prisma.$transaction(
      async (tx) => {
        const cutoff = new Date(Date.now() - RETENTION_MS);
        const oldVisits = await tx.pageVisit.findMany({
          where: { timestamp: { lt: cutoff } },
          orderBy: { timestamp: 'asc' },
          take: PURGE_BATCH_SIZE,
          select: { id: true },
        });
        if (oldVisits.length === 0) {
          return { deletedCount: 0, isDone: true };
        }
        const removed = await tx.pageVisit.deleteMany({
          where: { id: { in: oldVisits.map((row) => row.id) } },
        });
        return { deletedCount: removed.count, isDone: oldVisits.length < PURGE_BATCH_SIZE };
      },
      { timeout: ANALYTICS_TX_TIMEOUT_MS },
    );
    this.logger.log(`purgeOldAnalytics deleted ${result.deletedCount} row(s)`);
    return result;
  }

  /**
   * `backfillIsArchived` (`migrations.ts:8-20`), internal/CLI only (DEV-046).
   * One-shot idempotent backfill of `isArchived` where it is NULL.
   */
  async backfillIsArchived(): Promise<BackfillResultDto> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.article.updateMany({
        where: { isArchived: null },
        data: { isArchived: false },
      });
      const total = await tx.article.count();
      return { updated: updated.count, total };
    });
  }
}
