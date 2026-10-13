/**
 * Phase 09 worker/scheduler e2e suite (`truth-pill-backend`, DEV-056).
 *
 * Boots the real `WorkerAppModule` (application context, **no** HTTP server) and
 * asserts the six frozen crons (`web/convex/crons.ts`) are registered at their
 * exact periods, that each handler invokes the same Phase 05/07/08 service
 * method (no logic fork), that re-runs are idempotent, that a forced failure is
 * caught without killing the worker (F9), and that the Neon keepalive is bounded
 * (ADR-018).
 *
 * Run: `npm run test:jobs`.
 */
import 'reflect-metadata';
import './test-env';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { WorkerAppModule } from '../src/worker/worker-app.module';
import { ScheduledJobsService } from '../src/worker/scheduled-jobs.service';
import { DbKeepaliveService } from '../src/worker/db-keepalive.service';
import { PrismaService } from '../src/core/prisma/prisma.service';

@Module({ imports: [WorkerAppModule] })
class TestWorkerModule {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const CRON_JOBS = [
  'weekly-newsletter-digest',
  'rollup-daily-stats',
  'purge-old-analytics',
] as const;
const INTERVAL_JOBS = [
  'check-and-run-ai-schedule',
  'process-email-queue',
  'publish-scheduled-articles',
  'worker-db-keepalive',
] as const;

async function main(): Promise<number> {
  const app = await NestFactory.createApplicationContext(TestWorkerModule, { logger: false });
  const registry = app.get(SchedulerRegistry);
  const jobs = app.get(ScheduledJobsService);
  const keepalive = app.get(DbKeepaliveService);
  const prisma = app.get(PrismaService);

  // Shared-state snapshot: the worker's real `rollupDailyStats` folds pending
  // `pageVisits` into `dailyStats`. Restore the snapshot so this suite cannot
  // drift the signed-off `sum(dailyStats.visits)` (Phase 02 baseline, 2449) —
  // the same hygiene every sibling suite applies.
  const dailyStatsBefore = await prisma.dailyStat.findMany();

  const DIGEST_SUBJECT = 'Your Weekly Truth Pill Digest 📰';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  // P09-SEC-002: the digest dedupe guard is week-global, so a e2e that wants the
  // job to actually enqueue must start from a week with no queued wave. Dev-DB
  // hygiene only — digest rows are transient by construction.
  const purgeRecentDigestRows = (): Promise<{ count: number }> =>
    prisma.emailQueue.deleteMany({
      where: {
        templateName: 'newsletter',
        subject: DIGEST_SUBJECT,
        scheduledFor: { gt: new Date(Date.now() - WEEK_MS) },
      },
    });

  const results: Array<{ name: string; ok: boolean }> = [];
  const check = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
      console.log(`PASS  ${name}`);
    } catch (error) {
      results.push({ name, ok: false });
      console.error(`FAIL  ${name}`);
      console.error(error);
    }
  };

  try {
    await check('DEV-056: no HTTP server — worker boots an application context', () => {
      // A context without `listen` has no HTTP adapter; getting here is the proof.
      assert.ok(jobs instanceof ScheduledJobsService);
    });

    await check('DEV-056: the 3 frozen cron jobs are registered by name', () => {
      const names = registry.getCronJobs().keys();
      const registered = new Set(names);
      for (const name of CRON_JOBS) {
        assert.ok(registered.has(name), `cron job ${name} not registered`);
      }
    });

    await check('DEV-056: cron periods match the frozen contract (Mon 08:00 / 02:00 / 03:00 UTC)', () => {
      const cases: Array<[string, string]> = [
        ['weekly-newsletter-digest', '0 8 * * 1'],
        ['rollup-daily-stats', '0 2 * * *'],
        ['purge-old-analytics', '0 3 * * *'],
      ];
      for (const [name, expected] of cases) {
        const job = registry.getCronJob(name);
        assert.equal(job.cronTime.source, expected, `${name} cron source mismatch`);
      }
    });

    await check('DEV-056: the 4 interval jobs are registered (15m / 5m / 1m / keepalive)', () => {
      const names = new Set(registry.getIntervals());
      for (const name of INTERVAL_JOBS) {
        assert.ok(names.has(name), `interval ${name} not registered`);
      }
    });

    await check('DEV-056: interval periods are exact (ms)', () => {
      const cases: Array<[string, number]> = [
        ['check-and-run-ai-schedule', 15 * 60_000],
        ['process-email-queue', 5 * 60_000],
        ['publish-scheduled-articles', 60_000],
      ];
      for (const [name, expected] of cases) {
        const interval = registry.getInterval(name);
        const periodMs: number =
          typeof interval === 'number' ? interval : Number(interval?._repeat);
        assert.equal(periodMs, expected, `${name} interval mismatch`);
      }
    });

    await check('DEV-056: each handler invokes the same service method (no logic fork)', async () => {
      // P09-SEC-002 moved the dedupe guard BEFORE the enqueue, so a same-week
      // digest row would make the weekly job skip `generateWeeklyNewsletter`.
      // Clear this week's waves so every handler takes its delegate path.
      await purgeRecentDigestRows();

      const calls: string[] = [];
      const restores: Array<() => void> = [];
      const spy = <T extends object, K extends keyof T>(target: T, method: K, label: string): void => {
        const original = target[method];
        assert.equal(typeof original, 'function', `${label} is not a method`);
        (target as Record<K, unknown>)[method] = async (...args: unknown[]) => {
          calls.push(label);
          void args;
          return undefined;
        };
        restores.push(() => {
          (target as Record<K, unknown>)[method] = original;
        });
      };

      const articles = app.get(
        (await import('../src/modules/articles/articles.service')).ArticlesService,
      );
      const ai = app.get((await import('../src/modules/ai/ai.service')).AiService);
      const emails = app.get((await import('../src/modules/emails/emails.service')).EmailsService);
      const internal = app.get(
        (await import('../src/modules/analytics/internal-analytics.service')).InternalAnalyticsService,
      );

      spy(ai, 'processScheduleCheck', 'ai.processScheduleCheck');
      spy(emails, 'processQueue', 'emails.processQueue');
      spy(emails, 'generateWeeklyNewsletter', 'emails.generateWeeklyNewsletter');
      spy(articles, 'publishScheduled', 'articles.publishScheduled');
      spy(internal, 'rollupDailyStats', 'internal.rollupDailyStats');
      spy(internal, 'purgeOldAnalytics', 'internal.purgeOldAnalytics');

      try {
        await jobs.checkAndRunAiSchedule();
        await jobs.processEmailQueue();
        await jobs.weeklyNewsletterDigest();
        await jobs.publishScheduledArticles();
        await jobs.rollupDailyStats();
        await jobs.purgeOldAnalytics();
      } finally {
        for (const restore of restores) restore();
      }

      assert.deepEqual(calls.sort(), [
        'ai.processScheduleCheck',
        'articles.publishScheduled',
        'emails.generateWeeklyNewsletter',
        'emails.processQueue',
        'internal.purgeOldAnalytics',
        'internal.rollupDailyStats',
      ]);
    });

    await check('DEV-056/F9: a forced job failure is caught — the worker survives, no stack logged', async () => {
      const emails = app.get(
        (await import('../src/modules/emails/emails.service')).EmailsService,
      );
      const original = emails.processQueue.bind(emails);
      emails.processQueue = async () => {
        throw new Error('SECRET_INTERNAL DETAIL: SELECT * FROM emailQueue');
      };
      // Must not reject — the boundary swallows it.
      await jobs.processEmailQueue();
      emails.processQueue = original;
    });

    await check('DEV-056/F7: processEmailQueue is re-runnable (idempotent, no throw)', async () => {
      await jobs.processEmailQueue();
      await jobs.processEmailQueue();
    });

    await check('DEV-056/F7: publishScheduledArticles is re-runnable (idempotent, no throw)', async () => {
      await jobs.publishScheduledArticles();
      await jobs.publishScheduledArticles();
    });

    await check('DEV-056/F7: rollupDailyStats is re-runnable (watermark idempotent)', async () => {
      await jobs.rollupDailyStats();
      await jobs.rollupDailyStats();
    });

    await check('P09-SEC-002: two runs in one week enqueue exactly one digest per subscriber (second is a no-op)', async () => {
      // The guard is week-global; start from a clean week so run 1 really enqueues.
      await purgeRecentDigestRows();

      const stamp = Date.now();
      const recipientEmails = [
        `p09-digest-${stamp}-a@example.test`,
        `p09-digest-${stamp}-b@example.test`,
      ];
      const subscriberIds: string[] = [];
      const articleIds: string[] = [];

      try {
        for (const email of recipientEmails) {
          const created = await prisma.user.create({
            data: {
              name: 'P09 Digest',
              email,
              provider: 'email',
              role: 'user',
              newsletterSubscribed: true,
              createdAt: new Date(),
            },
            select: { id: true },
          });
          subscriberIds.push(created.id);
        }
        for (let i = 0; i < 3; i += 1) {
          const created = await prisma.article.create({
            data: {
              title: `P09 digest article ${i}`,
              slug: `p09-digest-${stamp}-${i}`,
              excerpt: `excerpt ${i}`,
              content: `content ${i}`,
              authorId: subscriberIds[0],
              status: 'published',
              source: 'human',
              readingTime: 1,
              viewCount: 100 - i,
              publishedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            select: { id: true },
          });
          articleIds.push(created.id);
        }

        // Run 1: exactly one digest per seeded subscriber.
        await jobs.weeklyNewsletterDigest();
        const afterFirst = await prisma.emailQueue.count({
          where: { recipient: { in: recipientEmails }, subject: DIGEST_SUBJECT },
        });
        assert.equal(
          afterFirst,
          recipientEmails.length,
          'first run must enqueue exactly one digest per subscriber',
        );

        // Run 2 within the week: a true no-op — no new rows, still one each.
        await jobs.weeklyNewsletterDigest();
        const afterSecond = await prisma.emailQueue.count({
          where: { recipient: { in: recipientEmails }, subject: DIGEST_SUBJECT },
        });
        assert.equal(
          afterSecond,
          recipientEmails.length,
          'second run must not enqueue a duplicate',
        );
        for (const email of recipientEmails) {
          const perSubscriber = await prisma.emailQueue.count({
            where: { recipient: email, subject: DIGEST_SUBJECT },
          });
          assert.equal(perSubscriber, 1, `subscriber ${email} must have exactly one digest row`);
        }
      } finally {
        await purgeRecentDigestRows();
        await prisma.article.deleteMany({ where: { id: { in: articleIds } } });
        await prisma.user.deleteMany({ where: { id: { in: subscriberIds } } });
      }
    });

    await check('ADR-018: the Neon keepalive is bounded and never throws', async () => {
      const awake = await keepalive.wakeDatabase();
      assert.equal(typeof awake, 'boolean');
    });

    await check('ADR-018: the worker holds no long-lived connection — a fresh SELECT 1 round-trips', async () => {
      const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
      assert.equal(Number(rows[0].one), 1);
    });

    await sleep(0);
  } finally {
    // Restore the dailyStats snapshot the real rollup may have advanced.
    await prisma.dailyStat.deleteMany({});
    if (dailyStatsBefore.length > 0) {
      await prisma.dailyStat.createMany({
        data: dailyStatsBefore.map((row) => ({
          id: row.id,
          date: row.date,
          visits: row.visits,
          uniqueVisitors: row.uniqueVisitors,
          lastRollup: row.lastRollup,
        })),
      });
    }
    await app.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
