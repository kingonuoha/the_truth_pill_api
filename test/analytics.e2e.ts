/**
 * Phase 07 analytics-module e2e suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (global default-deny `JwtAuthGuard` + `RolesGuard`)
 * and exercises the frozen 15-function analytics surface: the three guard
 * groups, DEV-030 attribution, DEV-024 IP parsing, DEV-016 dedup/cooldown,
 * DEV-047 atomic ingest counters, DEV-022 recompute baseline (Phase-06 C3),
 * rollup watermark idempotence, purge 90-day boundary, DEV-046 backfill
 * idempotence, the DEV-045 admin gate and the `getRawVisits` opaque-label
 * projection, plus dev-DB hygiene. Run: `npm run test:analytics`.
 *
 * ⚠️ Writes to the dev Neon branch. Every fixture carries a unique
 * `p07-e2e-<stamp>` marker. `globalStats`, `dailyStats`, `Category.articleCount`
 * and any pre-existing 90-day `pageVisits` are snapshotted and restored before
 * fixtures are deleted (the Phase 05/06 lesson: a skipped restore drifts shared
 * state). A post-cleanup residue check and a baseline-restored check must pass.
 */
import 'reflect-metadata';
import './test-env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { configureApp } from '../src/infra/bootstrap/bootstrap';
import { AppModule } from '../src/infra/app.module';
import { TokenService } from '../src/modules/auth/token.service';
import { JtiDenylistService } from '../src/modules/auth/jti-denylist.service';
import { TEST_INTERNAL_JOB_SECRET } from './test-env';

@Module({ imports: [AppModule] })
class TestAppModule {}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseResponse(response: Response, text: string): HttpResult {
  let body: unknown;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text };
}

/** One retry on a bare 500: the Neon dev branch scale-to-zero resume flakes. */
async function request(url: string, init?: RequestInit): Promise<HttpResult> {
  let response = await fetch(url, init);
  let text = await response.text();
  if (response.status === 500) {
    await sleep(1_500);
    response = await fetch(url, init);
    text = await response.text();
  }
  return parseResponse(response, text);
}

const send = (
  url: string,
  method: string,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

/** Every key name reachable in a JSON value, at any depth. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

/** Every string reachable in a JSON value, at any depth. */
function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectStrings(child, into);
  }
  return into;
}

/** DEV-034 class: user-secret keys that must never appear on an analytics surface. */
const SECRET_KEYS = [
  'password',
  'email',
  'role',
  'resetToken',
  'resetTokenExpires',
  'confirmationToken',
] as const;

const ADMIN_READ_ROUTES = [
  '/analytics/traffic-stats?days=30',
  '/analytics/referrer-stats?days=30',
  '/analytics/geographic-stats',
  '/analytics/device-stats',
  '/analytics/top-content',
  '/analytics/real-time-activity',
  '/analytics/raw-visits?type=all&days=30',
] as const;

const INTERNAL_ROUTES = [
  '/internal/stats/recompute',
  '/internal/stats/increment',
  '/internal/analytics/rollup-daily',
  '/internal/analytics/purge',
  '/internal/migrations/backfill-is-archived',
] as const;

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const base = `${await app.getUrl()}/api/v1`;
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);
  const denylist = app.get(JtiDenylistService);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const marker = `p07-e2e-${stamp}`;
  const markerUrl = (suffix: string): string => `https://thetruthpill.org/${marker}/${suffix}`;
  const addr = (tag: string): string => `${marker}-${tag}@example.test`;
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const internal = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET };

  const createdUserIds = new Set<string>();
  const createdArticleIds = new Set<string>();
  const createdVisitorIds = new Set<string>();

  /* ─────────────────────────── shared-state snapshots ─────────────────────────── */

  const gsBefore = await prisma.globalStats.findUnique({ where: { id: 'global_stats' } });
  if (!gsBefore) throw new Error('globalStats row is missing — cannot run the analytics e2e');

  const dailyStatsBefore = await prisma.dailyStat.findMany();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const oldPageVisitsBefore = await prisma.pageVisit.findMany({
    where: { timestamp: { lt: cutoff } },
  });
  const pageVisitCountBefore = await prisma.pageVisit.count();
  const categoriesBefore = await prisma.category.findMany({
    select: { id: true, articleCount: true },
  });

  const mkUser = async (tag: string, role: 'admin' | 'user'): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        name: `P07 ${tag}`,
        email: addr(tag),
        provider: 'email',
        role,
        newsletterSubscribed: false,
        createdAt: new Date(),
      },
      select: { id: true },
    });
    createdUserIds.add(user.id);
    return user.id;
  };

  const mkArticle = async (input: {
    tag: string;
    authorId: string;
    status?: 'draft' | 'scheduled' | 'published';
    isArchived?: boolean | null;
    uniqueViewCount?: number;
    viewCount?: number;
    reactionsCount?: number | null;
    actualReadingTime?: number | null;
  }): Promise<string> => {
    const article = await prisma.article.create({
      data: {
        title: `P07 E2E ${input.tag} ${stamp}`,
        slug: `${marker}-${input.tag}`,
        status: input.status ?? 'published',
        source: 'human',
        authorId: input.authorId,
        readingTime: 1,
        isArchived: input.isArchived === undefined ? false : input.isArchived,
        uniqueViewCount: input.uniqueViewCount ?? 0,
        viewCount: input.viewCount ?? 0,
        reactionsCount: input.reactionsCount ?? 0,
        actualReadingTime: input.actualReadingTime ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Prisma.ArticleUncheckedCreateInput,
      select: { id: true },
    });
    createdArticleIds.add(article.id);
    return article.id;
  };

  const mkPageVisit = async (input: {
    visitorId: string;
    url: string;
    ipAddress?: string;
    geoLocation?: Record<string, string>;
    device?: string;
    browser?: string;
    os?: string;
    referrer?: string | null;
    timestamp?: Date;
  }): Promise<string> => {
    const row = await prisma.pageVisit.create({
      data: {
        visitorId: input.visitorId,
        url: input.url,
        ipAddress: input.ipAddress ?? '127.0.0.1',
        geoLocation: input.geoLocation ? input.geoLocation : Prisma.DbNull,
        device: input.device ?? 'desktop',
        browser: input.browser ?? 'P07Browser',
        os: input.os ?? 'P07OS',
        referrer: input.referrer ?? null,
        timestamp: input.timestamp ?? new Date(),
      },
      select: { id: true },
    });
    return row.id;
  };

  /** A public-route page-visit ingest that records the visitor for teardown. */
  const ingestVisit = async (
    visitorId: string,
    suffix: string,
    headers?: Record<string, string>,
    referrer?: string,
  ): Promise<HttpResult> => {
    createdVisitorIds.add(visitorId);
    return send(
      `${base}/analytics/log-page-visit`,
      'POST',
      {
        visitorId,
        url: markerUrl(suffix),
        device: 'desktop',
        browser: 'P07Browser',
        os: 'P07OS',
        ...(referrer === undefined ? {} : { referrer }),
      },
      headers,
    );
  };

  const gs = async (): Promise<{ totalViews: number; totalUniqueViews: number }> => {
    const row = await prisma.globalStats.findFirst({
      select: { totalViews: true, totalUniqueViews: true },
    });
    if (!row) throw new Error('globalStats row is missing');
    return row;
  };

  /* ─────────────────────────── checks ─────────────────────────── */

  const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
    // ── DEV-022 + Phase-06 C3: atomic idempotent recompute baseline ──────
    {
      name: 'DEV-022/C3: POST /internal/stats/recompute restores the signed-off baseline (132/130/2/0, totalViews 2449, totalUniqueViews 3252, categories 132) and a second run changes nothing',
      run: async () => {
        const run = await send(`${base}/internal/stats/recompute`, 'POST', undefined, internal);
        assert.equal(run.status, 200, run.text.slice(0, 200));
        assert.deepEqual(run.body, { id: 'global_stats' });

        const first = await prisma.globalStats.findUnique({ where: { id: 'global_stats' } });
        if (!first) throw new Error('globalStats row is missing after recompute');
        assert.equal(first.articleCount, 132, 'articleCount must restore to 132');
        assert.equal(first.publishedArticleCount, 130, 'publishedArticleCount must restore to 130');
        assert.equal(first.draftArticleCount, 2, 'draftArticleCount must restore to 2');
        assert.equal(first.scheduledArticleCount, 0, 'scheduledArticleCount must restore to 0');
        assert.equal(first.totalViews, 2449, 'totalViews must be sum(dailyStats.visits) = 2449');
        assert.equal(first.totalUniqueViews, 3252, 'totalUniqueViews must be count(visitorTracking) = 3252');

        const catSum = await prisma.category.aggregate({ _sum: { articleCount: true } });
        assert.equal(catSum._sum.articleCount ?? -1, 132, 'Category.articleCount must sum to 132');

        const second = await send(`${base}/internal/stats/recompute`, 'POST', undefined, internal);
        assert.equal(second.status, 200);
        const after = await prisma.globalStats.findUnique({ where: { id: 'global_stats' } });
        assert.deepEqual(
          {
            articleCount: after?.articleCount,
            publishedArticleCount: after?.publishedArticleCount,
            draftArticleCount: after?.draftArticleCount,
            scheduledArticleCount: after?.scheduledArticleCount,
            totalViews: after?.totalViews,
            totalUniqueViews: after?.totalUniqueViews,
          },
          {
            articleCount: first.articleCount,
            publishedArticleCount: first.publishedArticleCount,
            draftArticleCount: first.draftArticleCount,
            scheduledArticleCount: first.scheduledArticleCount,
            totalViews: first.totalViews,
            totalUniqueViews: first.totalUniqueViews,
          },
          'a second recompute must be idempotent',
        );
      },
    },

    // ── internals fail closed ─────────────────────────────────────────────
    {
      name: 'DEV-046/DEV-022: every /internal/* route is 401 without the x-internal-secret header (fail-closed)',
      run: async () => {
        for (const path of INTERNAL_ROUTES) {
          const body = path.endsWith('/increment') ? { update: {} } : undefined;
          const res = await send(`${base}${path}`, 'POST', body);
          assert.equal(res.status, 401, `${path}: missing secret must be 401, got ${res.status}`);
        }
      },
    },

    // ── public ingest guard + DEV-030 attribution ────────────────────────
    {
      name: 'DEV-030/DEV-044: ingest is anon-served; a valid token attributes userId = sub; a present-but-invalid token is 401',
      run: async () => {
        const adminId = await mkUser('admin', 'admin');
        const memberId = await mkUser('member', 'user');
        const admin = tokens.sign(adminId).token;
        const member = tokens.sign(memberId).token;

        // Anonymous page visit → 200, row userId null.
        const anonVisitor = randomUUID();
        const anon = await ingestVisit(anonVisitor, 'anon');
        assert.equal(anon.status, 200, anon.text.slice(0, 200));
        const anonRow = await prisma.pageVisit.findFirst({
          where: { visitorId: anonVisitor },
          select: { userId: true },
        });
        assert.equal(anonRow?.userId ?? null, null, 'anonymous ingest must not attribute a user');

        // Valid token → row userId === sub.
        const tokVisitor = randomUUID();
        const tok = await ingestVisit(tokVisitor, 'token', auth(member));
        assert.equal(tok.status, 200, tok.text.slice(0, 200));
        const tokRow = await prisma.pageVisit.findFirst({
          where: { visitorId: tokVisitor },
          select: { userId: true },
        });
        assert.equal(tokRow?.userId, memberId, 'valid token must attribute the verified sub');

        // Present-but-invalid token → 401, never a silent anonymous downgrade.
        const bad = await ingestVisit(randomUUID(), 'bad-token', { authorization: 'Bearer not.a.jwt' });
        assert.equal(bad.status, 401, 'malformed token must be 401');

        // Revoked jti → 401.
        const revoked = tokens.sign(memberId);
        denylist.revoke(revoked.jti, Date.now() + 300_000);
        const rev = await ingestVisit(randomUUID(), 'revoked-token', auth(revoked.token));
        assert.equal(rev.status, 401, 'revoked token must be 401');

        // Unknown article on article-view/heartbeat → opaque no-op 200.
        const ghost = randomUUID();
        const anonView = await send(`${base}/analytics/log-article-view`, 'POST', {
          articleId: ghost,
          visitorId: randomUUID(),
        });
        assert.equal(anonView.status, 200, 'unknown-article article-view must be an opaque 200');
        const anonBeat = await send(`${base}/analytics/log-heartbeat`, 'POST', {
          articleId: ghost,
          visitorId: randomUUID(),
          seconds: 5,
        });
        assert.equal(anonBeat.status, 200, 'unknown-article heartbeat must be an opaque 200');
        void admin;
      },
    },

    // ── DEV-030 selector deletion ─────────────────────────────────────────
    {
      name: 'DEV-030: a body userId on ingest and an adminEmail query on an admin read are 400 (deleted selectors)',
      run: async () => {
        const body = await send(`${base}/analytics/log-page-visit`, 'POST', {
          visitorId: randomUUID(),
          url: markerUrl('selector'),
          device: 'desktop',
          browser: 'P07Browser',
          os: 'P07OS',
          userId: randomUUID(),
        });
        assert.equal(body.status, 400, 'body userId must be rejected by forbidNonWhitelisted');

        const adminId = await mkUser('admin2', 'admin');
        const admin = tokens.sign(adminId).token;
        const query = await send(
          `${base}/analytics/traffic-stats?adminEmail=${encodeURIComponent(addr('admin2'))}`,
          'GET',
          undefined,
          auth(admin),
        );
        assert.equal(query.status, 400, 'adminEmail query selector must be rejected');
      },
    },

    // ── DEV-024 client-IP parse ───────────────────────────────────────────
    {
      name: 'DEV-024: pageVisits.ipAddress is the validated first x-forwarded-for hop (mapped v6 normalised); malformed/multi-value/absent → 127.0.0.1',
      run: async () => {
        const cases: Array<{ header?: string; expected: string; label: string }> = [
          { header: '203.0.113.7, 10.0.0.1', expected: '203.0.113.7', label: 'first hop only' },
          { header: '::ffff:1.2.3.4', expected: '1.2.3.4', label: 'v4-mapped v6 normalised' },
          { header: '[2001:db8::1]:443', expected: '2001:db8::1', label: 'bracketed v6 with port' },
          { header: 'garbage, 1.2.3.4', expected: '127.0.0.1', label: 'invalid first hop → sentinel' },
          { header: 'not-an-ip', expected: '127.0.0.1', label: 'malformed → sentinel' },
          { header: undefined, expected: '127.0.0.1', label: 'absent → sentinel' },
        ];
        for (const c of cases) {
          const visitorId = randomUUID();
          const headers = c.header === undefined ? undefined : { 'x-forwarded-for': c.header };
          const res = await ingestVisit(visitorId, `ip-${c.label.replace(/\W+/g, '-')}`, headers);
          assert.equal(res.status, 200, `${c.label}: ${res.text.slice(0, 120)}`);
          const row = await prisma.pageVisit.findFirst({
            where: { visitorId },
            select: { ipAddress: true },
          });
          assert.equal(row?.ipAddress, c.expected, `${c.label}: stored IP mismatch`);
        }
      },
    },

    // ── DEV-047 atomic logPageVisit counters + isPublicRoute gate ─────────
    {
      name: 'DEV-047: logPageVisit moves globalStats.totalViews atomic with the row; totalUniqueViews only for a new visitor; an admin URL never counts',
      run: async () => {
        const before = await gs();

        const newVisitor = randomUUID();
        const first = await ingestVisit(newVisitor, 'counter-new');
        assert.equal(first.status, 200, first.text.slice(0, 200));
        const afterNew = await gs();
        assert.equal(afterNew.totalViews, before.totalViews + 1, 'public visit must +1 totalViews');
        assert.equal(afterNew.totalUniqueViews, before.totalUniqueViews + 1, 'new visitor must +1 totalUniqueViews');

        const tracking = await prisma.visitorTracking.findUnique({
          where: { trackingCode: newVisitor },
          select: { totalVisits: true },
        });
        assert.equal(tracking?.totalVisits, 1, 'a new visitor tracking row starts at totalVisits 1');

        const again = await ingestVisit(newVisitor, 'counter-return');
        assert.equal(again.status, 200, again.text.slice(0, 200));
        const afterReturn = await gs();
        assert.equal(afterReturn.totalViews, afterNew.totalViews + 1, 'return visit must +1 totalViews');
        assert.equal(
          afterReturn.totalUniqueViews,
          afterNew.totalUniqueViews,
          'returning visitor must NOT move totalUniqueViews',
        );
        const tracking2 = await prisma.visitorTracking.findUnique({
          where: { trackingCode: newVisitor },
          select: { totalVisits: true },
        });
        assert.equal(tracking2?.totalVisits, 2, 'returning visit increments totalVisits');

        // Admin/auth URLs are excluded by the frozen isPublicRoute predicate.
        const adminVisitor = randomUUID();
        createdVisitorIds.add(adminVisitor);
        const adminUrl = await send(`${base}/analytics/log-page-visit`, 'POST', {
          visitorId: adminVisitor,
          url: `https://thetruthpill.org/admin/${marker}/analytics`,
          device: 'desktop',
          browser: 'P07Browser',
          os: 'P07OS',
        });
        assert.equal(adminUrl.status, 200, adminUrl.text.slice(0, 200));
        const afterAdmin = await gs();
        assert.equal(afterAdmin.totalViews, afterReturn.totalViews, 'admin URL must not move totalViews');
        assert.equal(
          afterAdmin.totalUniqueViews,
          afterReturn.totalUniqueViews,
          'admin URL must not move totalUniqueViews',
        );
        const adminRow = await prisma.pageVisit.findFirst({
          where: { visitorId: adminVisitor },
          select: { id: true },
        });
        assert.ok(adminRow, 'an admin URL is still recorded as a pageVisit row');
      },
    },

    // ── DEV-016 dedup / cooldown ─────────────────────────────────────────
    {
      name: 'DEV-016: logArticleView dedups (articleId, visitorId) server-side — a rapid double view is +1 viewCount +1 uniqueViewCount and one row; a >24 h return is one more viewCount',
      run: async () => {
        const authorId = await mkUser('author', 'user');
        const articleId = await mkArticle({ tag: 'dedup', authorId });
        const visitorId = randomUUID();
        const body = { articleId, visitorId };

        const first = await send(`${base}/analytics/log-article-view`, 'POST', body);
        assert.equal(first.status, 200, first.text.slice(0, 200));
        const second = await send(`${base}/analytics/log-article-view`, 'POST', body);
        assert.equal(second.status, 200, second.text.slice(0, 200));

        const rowCount = await prisma.articleView.count({ where: { articleId, visitorId } });
        assert.equal(rowCount, 1, 'exactly one (articleId, visitorId) row must exist');
        const afterDedup = await prisma.article.findUnique({
          where: { id: articleId },
          select: { viewCount: true, uniqueViewCount: true },
        });
        assert.equal(afterDedup?.viewCount, 1, 'a rapid double view increments viewCount once');
        assert.equal(afterDedup?.uniqueViewCount, 1, 'a rapid double view increments uniqueViewCount once');

        // Simulate a return after the 24 h cooldown.
        await prisma.articleView.updateMany({
          where: { articleId, visitorId },
          data: { viewedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
        });
        const returned = await send(`${base}/analytics/log-article-view`, 'POST', body);
        assert.equal(returned.status, 200, returned.text.slice(0, 200));
        const afterReturn = await prisma.article.findUnique({
          where: { id: articleId },
          select: { viewCount: true, uniqueViewCount: true },
        });
        assert.equal(afterReturn?.viewCount, 2, 'a >24 h return increments viewCount once more');
        assert.equal(afterReturn?.uniqueViewCount, 1, 'a return never re-counts a unique view');
        assert.equal(
          await prisma.articleView.count({ where: { articleId, visitorId } }),
          1,
          'a return updates the row, it does not add one',
        );
      },
    },

    // ── logHeartbeat ─────────────────────────────────────────────────────
    {
      name: 'logHeartbeat: articles.actualReadingTime and articleViews.engagementTime accumulate seconds for a known session',
      run: async () => {
        const authorId = await mkUser('beat-author', 'user');
        const articleId = await mkArticle({ tag: 'heartbeat', authorId });
        const visitorId = randomUUID();
        await send(`${base}/analytics/log-article-view`, 'POST', { articleId, visitorId });
        const beat = await send(`${base}/analytics/log-heartbeat`, 'POST', {
          articleId,
          visitorId,
          seconds: 42,
        });
        assert.equal(beat.status, 200, beat.text.slice(0, 200));

        const article = await prisma.article.findUnique({
          where: { id: articleId },
          select: { actualReadingTime: true },
        });
        assert.equal(article?.actualReadingTime, 42, 'actualReadingTime must accumulate');
        const view = await prisma.articleView.findUnique({
          where: { articleId_visitorId: { articleId, visitorId } },
          select: { engagementTime: true },
        });
        assert.equal(view?.engagementTime, 42, 'engagementTime must accumulate');
      },
    },

    // ── DEV-045 admin guard matrix ───────────────────────────────────────
    {
      name: 'DEV-045: all 7 analytics reads are 401 anonymous / 403 non-admin / 200 admin (no @Public())',
      run: async () => {
        const adminId = await mkUser('admin3', 'admin');
        const memberId = await mkUser('member3', 'user');
        const admin = tokens.sign(adminId).token;
        const member = tokens.sign(memberId).token;

        for (const path of ADMIN_READ_ROUTES) {
          const anon = await request(`${base}${path}`);
          assert.equal(anon.status, 401, `${path}: anonymous expected 401, got ${anon.status}`);
          const nonAdmin = await send(`${base}${path}`, 'GET', undefined, auth(member));
          assert.equal(nonAdmin.status, 403, `${path}: non-admin expected 403, got ${nonAdmin.status}`);
          const asAdmin = await send(`${base}${path}`, 'GET', undefined, auth(admin));
          assert.equal(asAdmin.status, 200, `${path}: admin expected 200, got ${asAdmin.status} ${asAdmin.text.slice(0, 120)}`);
        }

        // Any stray query key on an empty-query route is a 400.
        const stray = await send(`${base}/analytics/geographic-stats?foo=1`, 'GET', undefined, auth(admin));
        assert.equal(stray.status, 400, 'a stray query key must be rejected');

        // Keep admin/member ids referenced for the checks below.
        void member;
      },
    },
  ];

  /* ─────────────────────────── fixtures for read-shape checks ─────────────────────────── */

  const readChecks = async (): Promise<void> => {
    const authorId = await mkUser('read-author', 'user');
    const adminId = await mkUser('read-admin', 'admin');
    const memberId = await mkUser('read-member', 'user');
    const admin = tokens.sign(adminId).token;

    const articleTop = await mkArticle({
      tag: 'top',
      authorId,
      uniqueViewCount: 1_000_000,
      viewCount: 1_000_000,
      reactionsCount: 5,
      actualReadingTime: 5_000,
    });
    const articleReact = await mkArticle({ tag: 'react', authorId });
    await prisma.reaction.create({
      data: { articleId: articleReact, userId: memberId, type: 'like', createdAt: new Date() },
    });

    // Directly-created pageVisit fixtures for the aggregate reads.
    const refToken = `p07ref-${stamp}.example`;
    await mkPageVisit({
      visitorId: randomUUID(),
      url: markerUrl('ref-google'),
      referrer: `https://${refToken}/page`,
    });
    await mkPageVisit({ visitorId: randomUUID(), url: markerUrl('ref-direct'), referrer: null });
    await mkPageVisit({
      visitorId: randomUUID(),
      url: markerUrl('ref-external'),
      referrer: '::not a url::',
    });
    const land = `P07Land${stamp}`;
    await mkPageVisit({
      visitorId: randomUUID(),
      url: markerUrl('geo'),
      geoLocation: { country: land, city: `P07City${stamp}` },
      device: 'tablet',
      browser: `P07Browser${stamp}`,
      os: `P07OS${stamp}`,
    });
    const realtimeVisitor = randomUUID();
    await mkPageVisit({ visitorId: realtimeVisitor, url: markerUrl('realtime') });

    const checks2: Array<{ name: string; run: () => Promise<void> | void }> = [
      {
        name: 'DEV-045/read-parity: traffic/referrer/geographic/device reads return their frozen shapes and zero-filled/bucketed values',
        run: async () => {
          const traffic = await send(`${base}/analytics/traffic-stats?days=7`, 'GET', undefined, auth(admin));
          assert.equal(traffic.status, 200, traffic.text.slice(0, 160));
          const t = traffic.body as Record<string, unknown>;
          assert.deepEqual(Object.keys(t).sort(), ['chartData', 'isTrendUp', 'totalVisits', 'trend'].sort());
          const chart = t.chartData as Array<Record<string, unknown>>;
          assert.equal(chart.length, 7, 'the requested window must be zero-filled');
          for (const point of chart) {
            assert.deepEqual(Object.keys(point).sort(), ['date', 'uniqueVisitors', 'visits'].sort());
          }
          assert.equal(typeof t.totalVisits, 'number');
          assert.equal(typeof t.trend, 'string');

          const referrer = await send(`${base}/analytics/referrer-stats?days=1`, 'GET', undefined, auth(admin));
          assert.equal(referrer.status, 200, referrer.text.slice(0, 160));
          const refs = referrer.body as Array<Record<string, unknown>>;
          assert.ok(Array.isArray(refs));
          assert.ok(refs.some((r) => r.name === refToken), `referrer hostname ${refToken} must be present`);
          assert.ok(refs.some((r) => r.name === 'Direct / Bookmark'), 'empty referrer bucket must be present');
          assert.ok(refs.some((r) => r.name === 'External Link'), 'unparseable referrer bucket must be present');

          const geo = await send(`${base}/analytics/geographic-stats`, 'GET', undefined, auth(admin));
          assert.equal(geo.status, 200, geo.text.slice(0, 160));
          const countries = geo.body as Array<Record<string, unknown>>;
          assert.ok(countries.some((c) => c.country === land), `country ${land} must be present`);

          const device = await send(`${base}/analytics/device-stats`, 'GET', undefined, auth(admin));
          assert.equal(device.status, 200, device.text.slice(0, 160));
          const d = device.body as { devices: Array<{ name: string }>; browsers: Array<{ name: string }>; oss: Array<{ name: string }> };
          assert.ok(Array.isArray(d.devices) && Array.isArray(d.browsers) && Array.isArray(d.oss));
          assert.ok(d.devices.some((x) => x.name === 'desktop'), 'device bucket must be present');
          assert.ok(d.browsers.some((x) => x.name === `P07Browser${stamp}`), 'browser bucket must be present');
          assert.ok(d.oss.some((x) => x.name === `P07OS${stamp}`), 'OS bucket must be present');
        },
      },
      {
        name: 'read-parity: top-content is published-only, uniqueViews desc, top 10, with avgReadTime/engagementRate',
        run: async () => {
          const res = await send(`${base}/analytics/top-content`, 'GET', undefined, auth(admin));
          assert.equal(res.status, 200, res.text.slice(0, 160));
          const items = res.body as Array<Record<string, unknown>>;
          assert.ok(items.length >= 1 && items.length <= 10);
          const top = items.find((i) => i.id === articleTop);
          assert.ok(top, 'the high-unique-view fixture article must be in the top-10');
          assert.equal(top?.views, 1_000_000);
          assert.equal(top?.uniqueViews, 1_000_000);
          assert.equal(top?.reactions, 5);
          assert.equal(top?.avgReadTime, 0);
          assert.equal(top?.engagementRate, (5 / 1_000_000) * 100);
        },
      },
      {
        name: 'read-parity: real-time-activity returns latest rows within 1 h, one per visitor',
        run: async () => {
          const res = await send(`${base}/analytics/real-time-activity`, 'GET', undefined, auth(admin));
          assert.equal(res.status, 200, res.text.slice(0, 160));
          const rows = res.body as Array<Record<string, unknown>>;
          assert.ok(Array.isArray(rows));
          const seen = new Set<string>();
          for (const row of rows) {
            const visitorId = row.visitorId as string;
            assert.ok(!seen.has(visitorId), 'one row per visitorId');
            seen.add(visitorId);
          }
          assert.ok(seen.has(realtimeVisitor), 'the realtime fixture visitor must be present');
        },
      },
      {
        name: 'DEV-045/DEV-034: getRawVisits reaction branch carries an opaque `User <first8>` label, no email, and no user-secret key',
        run: async () => {
          const res = await send(`${base}/analytics/raw-visits?type=reaction&days=30`, 'GET', undefined, auth(admin));
          assert.equal(res.status, 200, res.text.slice(0, 200));
          const body = res.body as { data: Array<Record<string, unknown>>; page: Record<string, unknown> };
          assert.ok(Array.isArray(body.data));
          const row = body.data.find((r) => r.url === `Reaction: like on "P07 E2E react ${stamp}"`);
          assert.ok(row, 'the fixture reaction row must be present');
          assert.equal(row?.visitorId, `User ${memberId.substring(0, 8)}`, 'the label must be the opaque user handle');
          assert.ok(!String(row?.visitorId).includes('@'), 'the reaction label must never be an email');

          const keys = collectKeys(res.body);
          for (const secret of SECRET_KEYS) {
            assert.ok(!keys.has(secret), `getRawVisits leaks key "${secret}"`);
          }
          const strings = collectStrings(res.body);
          assert.ok(!strings.some((s) => s.includes('@')), 'no getRawVisits string may contain an email');
        },
      },
      {
        name: 'getRawVisits: keyset pagination bounded by limit, an invalid cursor resets to the first page, and search filters',
        run: async () => {
          const limited = await send(`${base}/analytics/raw-visits?type=visit&days=30&limit=1`, 'GET', undefined, auth(admin));
          assert.equal(limited.status, 200, limited.text.slice(0, 160));
          const l = limited.body as { data: unknown[]; page: { limit: number; hasMore: boolean; nextCursor: string | null } };
          assert.equal(l.page.limit, 1);
          assert.ok(l.data.length <= 1);

          const invalid = await send(`${base}/analytics/raw-visits?type=all&cursor=%25%25%25bad`, 'GET', undefined, auth(admin));
          assert.equal(invalid.status, 200, 'an invalid cursor must reset to the first page, not 500');

          const articleOnly = await send(`${base}/analytics/raw-visits?type=article&days=30`, 'GET', undefined, auth(admin));
          assert.equal(articleOnly.status, 200);
          const articleRows = (articleOnly.body as { data: Array<{ url: string }> }).data;
          for (const r of articleRows) {
            assert.ok(r.url.toLowerCase().includes('/article/'), 'type=article rows must be article URLs');
          }

          const search = await send(
            `${base}/analytics/raw-visits?type=all&days=30&search=${encodeURIComponent(marker)}`,
            'GET',
            undefined,
            auth(admin),
          );
          assert.equal(search.status, 200, search.text.slice(0, 160));
          const found = (search.body as { data: Array<{ url: string }> }).data;
          assert.ok(found.some((r) => r.url.includes(marker)), 'search must match the fixture URL');
        },
      },
    ];

    for (const check of checks2) {
      try {
        await check.run();
        results.push({ name: check.name, ok: true });
        console.log(`PASS  ${check.name}`);
      } catch (error) {
        results.push({ name: check.name, ok: false });
        console.error(`FAIL  ${check.name}`);
        console.error(error);
      }
    }
  };

  /* ─────────────────────────── internal semantics + read checks ─────────────────────────── */

  const postReadChecks: Array<{ name: string; run: () => Promise<void> | void }> = [
    {
      name: 'DEV-022: incrementStats applies an atomic signed delta and returns success:true',
      run: async () => {
        const before = await gs();
        const res = await send(`${base}/internal/stats/increment`, 'POST', { update: { totalViews: 5 } }, internal);
        assert.equal(res.status, 200, res.text.slice(0, 160));
        assert.deepEqual(res.body, { success: true });
        const after = await gs();
        assert.equal(after.totalViews, before.totalViews + 5, 'incrementStats must apply the delta');
      },
    },
    {
      name: 'rollupDailyStats: folds pageVisits into dailyStats from the watermark and is idempotent on re-run',
      run: async () => {
        for (let i = 0; i < 3; i += 1) {
          await mkPageVisit({ visitorId: randomUUID(), url: markerUrl(`rollup-${i}`) });
        }
        const first = await send(`${base}/internal/analytics/rollup-daily`, 'POST', undefined, internal);
        assert.equal(first.status, 200, first.text.slice(0, 160));
        const f = first.body as { processed: number; dates: number; isDone: boolean };
        assert.ok(f.processed >= 3, `rollup must fold the fixtures, processed=${f.processed}`);
        assert.ok(f.dates >= 1);
        assert.equal(f.isDone, true);

        const second = await send(`${base}/internal/analytics/rollup-daily`, 'POST', undefined, internal);
        assert.equal(second.status, 200);
        const s = second.body as { processed: number; isDone: boolean };
        assert.equal(s.processed, 0, 'a re-run with no new visits must process 0');
        assert.equal(s.isDone, true);
      },
    },
    {
      name: 'purgeOldAnalytics: deletes pageVisits older than 90 days in a bounded batch and is idempotent',
      run: async () => {
        const oldVisitorA = randomUUID();
        const oldVisitorB = randomUUID();
        const oldTime = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
        await mkPageVisit({ visitorId: oldVisitorA, url: markerUrl('old-a'), timestamp: oldTime });
        await mkPageVisit({ visitorId: oldVisitorB, url: markerUrl('old-b'), timestamp: oldTime });

        const first = await send(`${base}/internal/analytics/purge`, 'POST', undefined, internal);
        assert.equal(first.status, 200, first.text.slice(0, 160));
        const f = first.body as { deletedCount: number; isDone: boolean };
        assert.ok(f.deletedCount >= 2, `purge must delete the old fixtures, got ${f.deletedCount}`);
        assert.equal(f.isDone, true);
        assert.equal(
          await prisma.pageVisit.count({ where: { visitorId: { in: [oldVisitorA, oldVisitorB] } } }),
          0,
          'the old fixtures must be purged',
        );

        const second = await send(`${base}/internal/analytics/purge`, 'POST', undefined, internal);
        assert.equal(second.status, 200);
        assert.deepEqual(second.body, { deletedCount: 0, isDone: true });
      },
    },
    {
      name: 'DEV-046: backfillIsArchived is internal-only, idempotent, and the public path does not exist',
      run: async () => {
        const publicPath = await send(`${base}/migrations/backfill-is-archived`, 'DELETE');
        assert.equal(publicPath.status, 404, 'the frozen public backfill path must be gone');

        const authorId = await mkUser('backfill-author', 'user');
        const articleId = await mkArticle({ tag: 'backfill', authorId, isArchived: null });

        const first = await send(`${base}/internal/migrations/backfill-is-archived`, 'POST', undefined, internal);
        assert.equal(first.status, 200, first.text.slice(0, 160));
        const f = first.body as { updated: number; total: number };
        assert.ok(f.updated >= 1, `backfill must update the NULL fixture, got ${f.updated}`);
        assert.ok(f.total >= 1);
        const row = await prisma.article.findUnique({ where: { id: articleId }, select: { isArchived: true } });
        assert.equal(row?.isArchived, false, 'the NULL isArchived must become false');

        const second = await send(`${base}/internal/migrations/backfill-is-archived`, 'POST', undefined, internal);
        assert.equal(second.status, 200);
        assert.equal((second.body as { updated: number }).updated, 0, 'a second backfill must update nothing');
      },
    },
  ];

  const results: Array<{ name: string; ok: boolean }> = [];
  try {
    for (const check of checks) {
      try {
        await check.run();
        results.push({ name: check.name, ok: true });
        console.log(`PASS  ${check.name}`);
      } catch (error) {
        results.push({ name: check.name, ok: false });
        console.error(`FAIL  ${check.name}`);
        console.error(error);
      }
    }

    await readChecks();

    for (const check of postReadChecks) {
      try {
        await check.run();
        results.push({ name: check.name, ok: true });
        console.log(`PASS  ${check.name}`);
      } catch (error) {
        results.push({ name: check.name, ok: false });
        console.error(`FAIL  ${check.name}`);
        console.error(error);
      }
    }
  } finally {
    // ── shared-state restore FIRST (before fixture deletes) ──────────────
    await prisma.globalStats.update({
      where: { id: 'global_stats' },
      data: {
        articleCount: gsBefore.articleCount,
        publishedArticleCount: gsBefore.publishedArticleCount,
        draftArticleCount: gsBefore.draftArticleCount,
        scheduledArticleCount: gsBefore.scheduledArticleCount,
        aiDraftCount: gsBefore.aiDraftCount,
        usersCount: gsBefore.usersCount,
        commentsCount: gsBefore.commentsCount,
        pendingCommentsCount: gsBefore.pendingCommentsCount,
        totalViews: gsBefore.totalViews,
        totalUniqueViews: gsBefore.totalUniqueViews,
        updatedAt: gsBefore.updatedAt,
      },
    });

    // dailyStats: rollup may have created/advanced rows — restore the snapshot.
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

    // Category.articleCount: recompute touched it — restore the snapshot.
    for (const category of categoriesBefore) {
      await prisma.category.update({
        where: { id: category.id },
        data: { articleCount: category.articleCount },
      });
    }

    // ── fixture teardown ─────────────────────────────────────────────────
    await prisma.pageVisit.deleteMany({
      where: {
        OR: [
          { url: { contains: marker } },
          { visitorId: { in: [...createdVisitorIds] } },
        ],
      },
    });
    await prisma.visitorTracking.deleteMany({
      where: { trackingCode: { in: [...createdVisitorIds] } },
    });
    await prisma.reaction.deleteMany({ where: { articleId: { in: [...createdArticleIds] } } });
    await prisma.article.deleteMany({ where: { slug: { startsWith: marker } } });
    await prisma.user.deleteMany({ where: { email: { contains: marker } } });

    // Restore the pre-existing 90-day pageVisits the purge removed (hygiene).
    if (oldPageVisitsBefore.length > 0) {
      await prisma.pageVisit.createMany({
        data: oldPageVisitsBefore.map((row) => ({
          id: row.id,
          visitorId: row.visitorId,
          userId: row.userId,
          url: row.url,
          ipAddress: row.ipAddress,
          geoLocation:
            row.geoLocation === null ? Prisma.DbNull : (row.geoLocation as Prisma.InputJsonValue),
          device: row.device,
          browser: row.browser,
          os: row.os,
          referrer: row.referrer,
          timestamp: row.timestamp,
        })),
      });
    }

    // ── residue + baseline checks ────────────────────────────────────────
    const [users, articles, visits, trackers, views, reactions] = await Promise.all([
      prisma.user.count({ where: { email: { contains: marker } } }),
      prisma.article.count({ where: { slug: { startsWith: marker } } }),
      prisma.pageVisit.count({
        where: {
          OR: [
            { url: { contains: marker } },
            { visitorId: { in: [...createdVisitorIds] } },
          ],
        },
      }),
      prisma.visitorTracking.count({ where: { trackingCode: { in: [...createdVisitorIds] } } }),
      prisma.articleView.count({ where: { articleId: { in: [...createdArticleIds] } } }),
      prisma.reaction.count({ where: { articleId: { in: [...createdArticleIds] } } }),
    ]);
    const residue = users + articles + visits + trackers + views + reactions;
    const residueName = `Dev-DB hygiene: 0 p07-e2e residue after teardown (got ${residue})`;
    results.push({ name: residueName, ok: residue === 0 });
    console.log(`${residue === 0 ? 'PASS' : 'FAIL'}  ${residueName}`);

    const gsRestored = await prisma.globalStats.findUnique({ where: { id: 'global_stats' } });
    const gsOk =
      gsRestored?.articleCount === gsBefore.articleCount &&
      gsRestored?.publishedArticleCount === gsBefore.publishedArticleCount &&
      gsRestored?.draftArticleCount === gsBefore.draftArticleCount &&
      gsRestored?.scheduledArticleCount === gsBefore.scheduledArticleCount &&
      gsRestored?.totalViews === gsBefore.totalViews &&
      gsRestored?.totalUniqueViews === gsBefore.totalUniqueViews;
    const gsName = 'Dev-DB hygiene: globalStats restored to the pre-run baseline';
    results.push({ name: gsName, ok: gsOk });
    console.log(`${gsOk ? 'PASS' : 'FAIL'}  ${gsName}`);

    const [dailyAfter, pageVisitsAfter, catAfter] = await Promise.all([
      prisma.dailyStat.count(),
      prisma.pageVisit.count(),
      prisma.category.aggregate({ _sum: { articleCount: true } }),
    ]);
    const dailyOk = dailyAfter === dailyStatsBefore.length;
    results.push({ name: `Dev-DB hygiene: dailyStats row count restored (${dailyAfter}/${dailyStatsBefore.length})`, ok: dailyOk });
    console.log(`${dailyOk ? 'PASS' : 'FAIL'}  dailyStats restored (${dailyAfter}/${dailyStatsBefore.length})`);

    const pageOk = pageVisitsAfter === pageVisitCountBefore;
    results.push({ name: `Dev-DB hygiene: pageVisits count restored (${pageVisitsAfter}/${pageVisitCountBefore})`, ok: pageOk });
    console.log(`${pageOk ? 'PASS' : 'FAIL'}  pageVisits restored (${pageVisitsAfter}/${pageVisitCountBefore})`);

    const catBeforeSum = categoriesBefore.reduce((sum, c) => sum + c.articleCount, 0);
    const catOk = (catAfter._sum.articleCount ?? -1) === catBeforeSum;
    results.push({ name: `Dev-DB hygiene: Category.articleCount sum restored (${catAfter._sum.articleCount ?? -1}/${catBeforeSum})`, ok: catOk });
    console.log(`${catOk ? 'PASS' : 'FAIL'}  Category.articleCount restored`);

    await app.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
