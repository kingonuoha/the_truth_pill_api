/**
 * The six frozen cron jobs (`web/convex/crons.ts`) as a `@nestjs/schedule`
 * worker (ADR-006, DEV-056).
 *
 * Each handler invokes the **same service method** the Phase 05/07/08 internal
 * endpoint exposes — no logic fork — inside a failure boundary (F9): a job that
 * throws is caught and logged **opaque** (Hard Rule 4), and the worker survives
 * so the next tick still runs. Every underlying operation is idempotent; the
 * weekly digest is additionally guarded against a second enqueue within the
 * same week.
 *
 * Times are pinned to `UTC`, matching the Convex scheduler the jobs are ported
 * from, so the published schedule is unambiguous regardless of the host `TZ`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { PrismaService } from '../core/prisma/prisma.service';
import { ArticlesService } from '../modules/articles/articles.service';
import { AiService } from '../modules/ai/ai.service';
import { EmailsService } from '../modules/emails/emails.service';
import { InternalAnalyticsService } from '../modules/analytics/internal-analytics.service';

const MINUTE = 60_000;
const WEEK_MS = 7 * 24 * 60 * MINUTE;
/** The frozen digest subject (`emails.ts` `generateWeeklyNewsletter`). */
const DIGEST_SUBJECT = 'Your Weekly Truth Pill Digest 📰';
/**
 * Transaction-scoped Postgres advisory-lock key for the weekly digest
 * (P09-SEC-002). Any stable 64-bit value works; it only has to be unique to
 * this job. The lock is released automatically when the transaction ends.
 */
const DIGEST_ADVISORY_LOCK_KEY = 90201801;

@Injectable()
export class ScheduledJobsService {
  private readonly logger = new Logger(ScheduledJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly articles: ArticlesService,
    private readonly emails: EmailsService,
    private readonly ai: AiService,
    private readonly internal: InternalAnalyticsService,
  ) {}

  /** `check-and-run-ai-schedule` — every 15 min. Idempotent (schedule-run guard). */
  @Interval('check-and-run-ai-schedule', 15 * MINUTE)
  async checkAndRunAiSchedule(): Promise<void> {
    await this.run('check-and-run-ai-schedule', () => this.ai.processScheduleCheck());
  }

  /** `process-email-queue` — every 5 min, `limit:50`. */
  @Interval('process-email-queue', 5 * MINUTE)
  async processEmailQueue(): Promise<void> {
    await this.run('process-email-queue', () => this.emails.processQueue({ limit: 50 }));
  }

  /** `weekly-newsletter-digest` — Mon 08:00 UTC. Deduped to one per week. */
  @Cron('0 8 * * 1', { name: 'weekly-newsletter-digest', timeZone: 'UTC' })
  async weeklyNewsletterDigest(): Promise<void> {
    await this.run('weekly-newsletter-digest', () =>
      // P09-SEC-002: the guard runs BEFORE the enqueue, not after. A
      // transaction-scoped advisory lock serializes a concurrent trigger, and
      // the check and the enqueue share one transaction — the loser of the race
      // wakes on the released lock, sees the winner's wave, and enqueues nothing.
      this.prisma.$transaction(
        async (tx) => {
          // `pg_advisory_xact_lock` returns `void`, which Prisma cannot
          // deserialize — cast to text so the raw call is usable.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(${DIGEST_ADVISORY_LOCK_KEY}::bigint)::text AS locked`;
          if (await this.digestAlreadyQueuedThisWeek(tx)) {
            this.logger.log('weekly-newsletter-digest deduped to one wave this week');
            return;
          }
          return this.emails.generateWeeklyNewsletter(tx);
        },
        // Generous bounds: Neon can cold-resume under the first statement, and
        // enqueuing a full subscriber wave can exceed the 5 s default (P05-SEC-003).
        { maxWait: 15_000, timeout: 30_000 },
      ),
    );
  }

  /** `publish-scheduled-articles` — every 1 min. Idempotent (row-state guard). */
  @Interval('publish-scheduled-articles', MINUTE)
  async publishScheduledArticles(): Promise<void> {
    await this.run('publish-scheduled-articles', () => this.articles.publishScheduled());
  }

  /** `rollup-daily-stats` — 02:00 UTC daily. Watermark-idempotent. */
  @Cron('0 2 * * *', { name: 'rollup-daily-stats', timeZone: 'UTC' })
  async rollupDailyStats(): Promise<void> {
    await this.run('rollup-daily-stats', () => this.internal.rollupDailyStats());
  }

  /** `purge-old-analytics` — 03:00 UTC daily. Bounded batch, re-runnable. */
  @Cron('0 3 * * *', { name: 'purge-old-analytics', timeZone: 'UTC' })
  async purgeOldAnalytics(): Promise<void> {
    await this.run('purge-old-analytics', () => this.internal.purgeOldAnalytics());
  }

  /**
   * F7/F9: run a job in a failure boundary. The error message, stack, SQL, and
   * any secret stay out of the log (Hard Rule 4) — only the job name is written.
   */
  private async run(name: string, job: () => Promise<unknown>): Promise<void> {
    try {
      const result = await job();
      void result;
      this.logger.log(`job ${name} completed`);
    } catch {
      this.logger.error(`job ${name} failed`);
    }
  }

  /**
   * DEV-056 idempotency / P09-SEC-002: is a digest already queued in the last 7
   * days? Runs on the caller's transaction client when one is supplied, so the
   * check and the enqueue that follows it are atomic.
   */
  private async digestAlreadyQueuedThisWeek(
    db: Pick<PrismaService, 'emailQueue'> = this.prisma,
  ): Promise<boolean> {
    const since = new Date(Date.now() - WEEK_MS);
    const existing = await db.emailQueue.findFirst({
      where: {
        templateName: 'newsletter',
        subject: DIGEST_SUBJECT,
        scheduledFor: { gt: since },
      },
      select: { id: true },
    });
    return existing !== null;
  }
}
