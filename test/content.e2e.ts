/**
 * Phase 05 content-modules e2e suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (global default-deny `JwtAuthGuard` + `RolesGuard`
 * in force) and exercises the guard matrix, projections, DEV rows, internal
 * idempotence, and the DEV-008 ranked-search parity across the seven Phase 05
 * modules. Run: `npm run test:content`.
 *
 * ⚠️ Writes to the dev Neon branch. Every fixture row carries a unique
 * `p05-e2e-<stamp>` marker and is deleted in `finally`; the `globalStats`
 * cache row is snapshotted and restored (Phase 02 signed-off counters).
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
import {
  normalizeSearchText,
  scoreSearchArticle,
  tokenizeSearchQuery,
} from '../src/modules/articles/article-search.scorer';
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

/**
 * One retry on a bare 500: the Neon dev branch scale-to-zero resume fails
 * connections transiently (documented environment caveat, AGENTS.md). A
 * deterministic 500 still fails — the retry surfaces it twice, and the
 * server-side stack is logged by the real exception filter (logger errors on).
 */
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

const send = (url: string, method: string, payload?: unknown, headers?: Record<string, string>): Promise<HttpResult> =>
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

/** §10 / DEV-034: user-secret keys that must never appear on a content surface. */
const SECRET_KEYS = [
  'password',
  'resetToken',
  'resetTokenExpires',
  'confirmationToken',
  'confirmationTokenExpires',
  'email',
  'role',
] as const;

const LONG_CONTENT =
  `<h2>Section</h2>${'lorem ipsum dolor sit amet '.repeat(45)}`; // > 800 chars, has H2

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const base = `${await app.getUrl()}/api/v1`;
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const addr = (tag: string): string => `p05-e2e-${tag}-${stamp}@example.test`;
  const createdEmails = new Set<string>();
  const createdArticleIds = new Set<string>();
  const publishedSubjects: string[] = [];
  const createdCategoryIds = new Set<string>();
  const createdPillarIds = new Set<string>();
  const createdQuoteIds = new Set<string>();
  /** Categories touched by the AI-draft path (first category in DB) → restore counts. */
  const aiDraftCategoryAdjustments = new Map<string, number>();

  const mkUser = async (
    tag: string,
    role: 'admin' | 'user',
    extra: { newsletterSubscribed?: boolean } = {},
  ): Promise<string> => {
    const email = addr(tag);
    const user = await prisma.user.create({
      data: {
        name: `P05 ${tag}`,
        email,
        provider: 'email',
        role,
        newsletterSubscribed: extra.newsletterSubscribed ?? false,
        createdAt: new Date(),
      },
      select: { id: true },
    });
    createdEmails.add(email);
    return user.id;
  };

  const mkArticle = async (tag: string, data: Record<string, unknown>): Promise<string> => {
    const article = await prisma.article.create({
      data: {
        title: data.title ?? `P05 E2E ${tag} ${stamp}`,
        slug: `p05-e2e-${tag}-${stamp}`,
        status: 'draft',
        source: 'human',
        authorId: (data.adminId as string) ?? adminId,
        readingTime: 1,
        isArchived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      } as Prisma.ArticleUncheckedCreateInput,
      select: { id: true },
    });
    createdArticleIds.add(article.id);
    return article.id;
  };

  const adminId = await mkUser('admin', 'admin');
  const memberId = await mkUser('member', 'user');
  const subscriberId = await mkUser('subscriber', 'user', { newsletterSubscribed: true });
  const victimId = await mkUser('victim', 'user');
  const admin = tokens.sign(adminId).token;
  const member = tokens.sign(memberId).token;
  const subscriber = tokens.sign(subscriberId).token;
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  const catA = await prisma.category.create({
    data: { name: `P05 Cat A ${stamp}`, slug: `p05-e2e-cat-a-${stamp}`, createdAt: new Date() },
  });
  const catB = await prisma.category.create({
    data: { name: `P05 Cat B ${stamp}`, slug: `p05-e2e-cat-b-${stamp}`, createdAt: new Date() },
  });
  createdCategoryIds.add(catA.id);
  createdCategoryIds.add(catB.id);
  const pillarP = await prisma.pillar.create({
    data: { name: `P05 Pillar ${stamp}`, slug: `p05-e2e-pillar-${stamp}`, categoryId: catA.id, createdAt: new Date() },
  });
  createdPillarIds.add(pillarP.id);

  const artPub = await mkArticle('pub', {
    title: `P05 E2E Published ${stamp}`,
    excerpt: 'pub excerpt',
    content: LONG_CONTENT,
    coverImage: 'https://images.example.test/pub.jpg',
    coverImageAlt: 'pub alt',
    categoryId: catA.id,
    pillar: pillarP.slug,
    topics: ['vexium'],
    tags: ['alpha', 'beta', 'gamma', 'delta'],
    type: 'insight',
    status: 'published',
    publishedAt: new Date(),
    isFeatured: true,
    metaTitle: 'P05 meta title',
    metaDescription: 'P05 meta description',
    focusKeyword: 'vexium',
    viewCount: 5,
  });
  const artDraft = await mkArticle('draft', { excerpt: 'd', content: 'short' });
  const artArchived = await mkArticle('arch', {
    status: 'published',
    publishedAt: new Date(),
    isArchived: true,
  });
  const artNullArch = await mkArticle('nullarch', {
    status: 'published',
    publishedAt: new Date(),
    isArchived: null,
  });
  const artGmDel = await mkArticle('gmdel', {});
  const artSched = await mkArticle('sched', {
    title: `P05 E2E Scheduled ${stamp}`,
    status: 'scheduled',
    scheduledFor: new Date(Date.now() - 60_000),
  });
  publishedSubjects.push(`New Insight: ${`P05 E2E Scheduled ${stamp}`}`);
  publishedSubjects.push(`New Insight: ${`P05 E2E Published ${stamp}`}`);

  const gsBefore = await prisma.globalStats.findFirst({
    select: {
      articleCount: true,
      publishedArticleCount: true,
      draftArticleCount: true,
      scheduledArticleCount: true,
      aiDraftCount: true,
    },
  });
  const adsRowExisted = (await prisma.adsSettings.count()) > 0;
  const settingsBefore = await prisma.siteSettings.findFirst();

  /* search fixtures (rare tokens so real corpus rows cannot outrank them) */
  const searchIds: Record<string, string> = {};
  searchIds.exact = await mkArticle('s1', {
    title: 'Vexium Quokka Fieldnotes',
    slug: `p05-e2e-s1-${stamp}`,
    status: 'published',
    publishedAt: new Date(),
    content: LONG_CONTENT,
    excerpt: 's1',
    tags: ['alpha', 'beta', 'gamma', 'delta'],
    viewCount: 1,
  });
  searchIds.contains = await mkArticle('s2', {
    title: 'Fieldnotes on Vexium Quokka Migration',
    slug: `p05-e2e-s2-${stamp}`,
    status: 'published',
    publishedAt: new Date(),
    content: LONG_CONTENT,
    excerpt: 's2',
    tags: ['alpha', 'beta', 'gamma', 'delta'],
    viewCount: 2,
  });
  searchIds.token = await mkArticle('s3', {
    title: 'Quokka Migration Notes',
    slug: `p05-e2e-s3-${stamp}`,
    status: 'published',
    publishedAt: new Date(),
    content: LONG_CONTENT,
    excerpt: 's3',
    tags: ['alpha', 'beta', 'gamma', 'vexium'],
    viewCount: 0,
  });

  await prisma.bookmark.create({ data: { userId: subscriberId, articleId: artPub, createdAt: new Date() } });

  const draftBody = (tag: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: `P05 E2E Created ${tag} ${stamp}`,
    slug: `p05-e2e-created-${tag}-${stamp}`,
    status: 'draft',
    source: 'human',
    ...over,
  });
  const publishableBody = (tag: string): Record<string, unknown> =>
    draftBody(tag, {
      status: 'published',
      excerpt: 'an excerpt',
      content: LONG_CONTENT,
      coverImage: 'https://images.example.test/x.jpg',
      categoryId: catA.id,
      topics: ['t'],
      tags: ['a', 'b', 'c', 'd'],
      metaTitle: 'mt',
      metaDescription: 'md',
    });

  /* ─────────────────────────── checks ─────────────────────────── */

  const guardMatrix: Array<{ name: string; method: string; path: string; body?: unknown; query?: string }> = [
    { name: 'POST /articles/create', method: 'POST', path: '/articles/create', body: draftBody('gm') },
    { name: 'PATCH /articles/update', method: 'PATCH', path: '/articles/update', body: { id: artDraft, title: 'P05 renamed' } },
    { name: 'PATCH /articles/remove', method: 'PATCH', path: '/articles/remove', body: { id: artDraft } },
    { name: 'POST /articles/restore', method: 'POST', path: '/articles/restore', body: { id: artDraft } },
    { name: 'DELETE /articles/delete-forever', method: 'DELETE', path: `/articles/delete-forever?id=${artGmDel}` },
    { name: 'POST /articles/bulk-archive', method: 'POST', path: '/articles/bulk-archive', body: { ids: [artDraft] } },
    { name: 'POST /articles/bulk-restore', method: 'POST', path: '/articles/bulk-restore', body: { ids: [artDraft] } },
    { name: 'POST /articles/bulk-delete-forever', method: 'POST', path: '/articles/bulk-delete-forever', body: { ids: [artDraft] } },
    { name: 'PATCH /articles/toggle-featured', method: 'PATCH', path: '/articles/toggle-featured', body: { id: artPub, isFeatured: true } },
    { name: 'GET /articles/admin', method: 'GET', path: '/articles/admin' },
    { name: 'GET /articles/by-id', method: 'GET', path: `/articles/by-id?id=${artPub}` },
    { name: 'POST /categories/create', method: 'POST', path: '/categories/create', body: { name: `P05 GM ${stamp}`, slug: `p05-e2e-gm-cat-${stamp}` } },
    { name: 'PATCH /categories/update', method: 'PATCH', path: '/categories/update', body: { id: catB.id, name: `P05 Cat B2 ${stamp}` } },
    { name: 'PATCH /categories/remove', method: 'PATCH', path: '/categories/remove', body: { id: '00000000-0000-0000-0000-000000000000' } },
    { name: 'POST /pillars/create', method: 'POST', path: '/pillars/create', body: { name: `P05 GM ${stamp}`, slug: `p05-e2e-gm-pil-${stamp}`, categoryId: catA.id } },
    { name: 'PATCH /pillars/update', method: 'PATCH', path: '/pillars/update', body: { id: pillarP.id, name: `P05 Pillar2 ${stamp}` } },
    { name: 'PATCH /pillars/remove', method: 'PATCH', path: '/pillars/remove', body: { id: '00000000-0000-0000-0000-000000000000' } },
    { name: 'PATCH /quotes/add', method: 'PATCH', path: '/quotes/add', body: { text: 'P05 quote', author: 'Nietzsche' } },
    { name: 'PATCH /quotes/remove', method: 'PATCH', path: '/quotes/remove', body: { id: '00000000-0000-0000-0000-000000000000' } },
    { name: 'PATCH /site-settings/update-site-settings (S-012 closed in Nest)', method: 'PATCH', path: '/site-settings/update-site-settings', body: { siteName: 'x', siteDescription: 'y', email: 'a@b.test', socials: {} } },
    { name: 'PATCH /ads-settings/update-ads-settings', method: 'PATCH', path: '/ads-settings/update-ads-settings', body: { adsEnabled: false, adsenseScriptCode: '', adsenseAdUnitCode: '', showAdTopOfArticle: false, showAdMiddleOfArticle: false, showAdBottomOfArticle: false, showAdSidebar: false } },
    { name: 'GET /admin/dashboard-stats', method: 'GET', path: '/admin/dashboard-stats' },
    { name: 'GET /admin/recent-activity', method: 'GET', path: '/admin/recent-activity' },
  ];

  const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
    // ── guard matrix (DoD #5) ─────────────────────────────────────────────
    {
      name: 'Guard matrix DEV-031/S-012/S-015/S-016: every content write 401 anonymous / 403 non-admin / 200 admin',
      run: async () => {
        for (const row of guardMatrix) {
          const url = `${base}${row.path}`;
          const noToken = await send(url, row.method, row.body);
          assert.equal(noToken.status, 401, `${row.name}: anonymous expected 401, got ${noToken.status}`);
          const nonAdmin = await send(url, row.method, row.body, auth(member));
          assert.equal(nonAdmin.status, 403, `${row.name}: non-admin expected 403, got ${nonAdmin.status}`);
          const asAdmin = await send(url, row.method, row.body, auth(admin));
          // 200, or a controlled 404/409 for the deliberately-absent ids.
          assert.ok(
            asAdmin.status === 200 || asAdmin.status === 404 || asAdmin.status === 409,
            `${row.name}: admin expected 200/404/409, got ${asAdmin.status} ${asAdmin.text.slice(0, 160)}`,
          );
        }
      },
    },
    // ── public reads reachable without a token (DoD #7) ───────────────────
    {
      name: 'Public reads: 200 without any token',
      run: async () => {
        const publicPaths = [
          '/articles?pageSize=5',
          '/articles/recent?limit=5',
          '/articles/by-tag?tag=alpha',
          `/articles/by-slug?slug=p05-e2e-pub-${stamp}`,
          '/articles/featured',
          `/articles/by-category?categorySlug=${catA.slug}`,
          '/articles/search?query=vexium',
          '/articles/popular-topics',
          '/articles/all-topics',
          '/articles/all-tags',
          '/articles/top-post-tags',
          `/articles/by-author?authorId=${adminId}`,
          '/articles/authors',
          `/categories/by-slug?slug=${catA.slug}`,
          `/categories/by-id?id=${catA.id}`,
          '/categories/all',
          `/pillars/by-category?categoryId=${catA.id}`,
          '/pillars/all',
          `/pillars/by-slug?slug=${pillarP.slug}`,
          '/quotes/random',
          '/quotes/all',
          '/ads-settings/ads-settings',
          '/site-settings/site-settings',
        ];
        for (const path of publicPaths) {
          const res = await request(`${base}${path}`);
          assert.equal(res.status, 200, `${path} -> ${res.status}`);
        }
      },
    },
    // ── §10 projection / S-014 / DEV-018 ─────────────────────────────────
    {
      name: '§10 projection: no user document / secret key on any public content surface',
      run: async () => {
        const surfaces = [
          '/articles?pageSize=5',
          `/articles/by-slug?slug=p05-e2e-pub-${stamp}`,
          '/articles/search?query=vexium',
          '/articles/by-author?authorId=' + adminId,
        ];
        for (const path of surfaces) {
          const res = await request(`${base}${path}`);
          const keys = collectKeys(res.body);
          for (const secret of SECRET_KEYS) {
            assert.ok(!keys.has(secret), `${path} leaks key "${secret}"`);
          }
        }
        // S-014: listAuthors → public author card ONLY.
        const authors = await request(`${base}/articles/authors`);
        assert.equal(authors.status, 200);
        assert.ok(Array.isArray(authors.body));
        for (const card of authors.body as Record<string, unknown>[]) {
          assert.deepEqual(Object.keys(card).sort(), ['id', 'name', 'profileImage']);
          assert.notEqual(card.id, subscriberId); // subscriber is not an admin → absent
        }
        // DEV-018: the site-settings surface carries no SITE_KEY / secret material.
        const settings = await request(`${base}/site-settings/site-settings`);
        const settingKeys = collectKeys(settings.body);
        for (const key of ['SITE_KEY', 'siteKey', 'apiKey', 'password']) {
          assert.ok(!settingKeys.has(key), `site-settings carries "${key}"`);
        }
      },
    },
    // ── DEV-029 bookmarks ────────────────────────────────────────────────
    {
      name: 'DEV-029: bookmarked-articles derives the subject from sub; email selector 400; cannot read another user',
      run: async () => {
        const anon = await request(`${base}/articles/bookmarked-articles`);
        assert.equal(anon.status, 401);
        const mine = await send(`${base}/articles/bookmarked-articles`, 'GET', undefined, auth(subscriber));
        assert.equal(mine.status, 200);
        const ids = (mine.body as { id: string }[]).map((a) => a.id);
        assert.ok(ids.includes(artPub), 'own bookmark missing');
        const victim = await send(`${base}/articles/bookmarked-articles`, 'GET', undefined, auth(tokens.sign(victimId).token));
        const victimIds = (victim.body as { id: string }[]).map((a) => a.id);
        assert.ok(!victimIds.includes(artPub), 'victim can read subscriber bookmarks');
        const viaEmail = await send(`${base}/articles/bookmarked-articles?email=${encodeURIComponent(addr('subscriber'))}`, 'GET', undefined, auth(tokens.sign(victimId).token));
        assert.equal(viaEmail.status, 400, 'email query param must be rejected by forbidNonWhitelisted');
      },
    },
    // ── DEV-030/031 identity params ──────────────────────────────────────
    {
      name: 'DEV-029/030/031: adminEmail/authorId in the body → 400; attribution taken from sub',
      run: async () => {
        const withAdminEmail = await send(`${base}/articles/create`, 'POST', { ...draftBody('idt'), adminEmail: 'evil@example.test' }, auth(admin));
        assert.equal(withAdminEmail.status, 400);
        const withAuthorId = await send(`${base}/articles/create`, 'POST', { ...draftBody('idt2'), authorId: victimId }, auth(admin));
        assert.equal(withAuthorId.status, 400);
        const ok = await send(`${base}/articles/create`, 'POST', draftBody('idt3'), auth(admin));
        assert.equal(ok.status, 200, ok.text.slice(0, 200));
        const created = ok.body as { id: string; authorId: string };
        createdArticleIds.add(created.id);
        assert.equal(created.authorId, adminId, 'authorId must be the token subject (DEV-030)');
      },
    },
    // ── DEV-011 422 + unchanged row ──────────────────────────────────────
    {
      name: 'DEV-011: invalid categoryId/pillar on update → 422 naming the field, row unchanged; valid → 200',
      run: async () => {
        const before = await prisma.article.findUnique({ where: { id: artPub }, select: { updatedAt: true, categoryId: true } });
        const badCat = await send(`${base}/articles/update`, 'PATCH', { id: artPub, categoryId: randomUUID() }, auth(admin));
        assert.equal(badCat.status, 422, badCat.text.slice(0, 200));
        assert.ok(
          (badCat.body as { details?: string[] }).details?.some((d) => d.includes('categoryId')),
          '422 must name categoryId',
        );
        const unchanged = await prisma.article.findUnique({ where: { id: artPub }, select: { updatedAt: true, categoryId: true } });
        assert.equal(unchanged?.updatedAt.getTime(), before?.updatedAt.getTime(), 'row was mutated despite 422');
        assert.equal(unchanged?.categoryId, before?.categoryId);

        const badPillar = await send(`${base}/articles/update`, 'PATCH', { id: artPub, pillar: `no-such-${randomUUID().slice(0, 8)}` }, auth(admin));
        assert.equal(badPillar.status, 422);
        assert.ok((badPillar.body as { details?: string[] }).details?.some((d) => d.includes('pillar')));

        const good = await send(`${base}/articles/update`, 'PATCH', { id: artPub, categoryId: catB.id }, auth(admin));
        assert.equal(good.status, 200, good.text.slice(0, 200));
        await send(`${base}/articles/update`, 'PATCH', { id: artPub, categoryId: catA.id }, auth(admin));
      },
    },
    // ── publish-time validation rules (DoD, articles.ts:535-572) ─────────
    {
      name: 'Publish-time validation as 422 rules: content<800, tags<4, metaDescription>255, no H2, missing excerpt; valid publish → 200',
      run: async () => {
        const short = await send(`${base}/articles/create`, 'POST', { ...draftBody('pv1'), status: 'published', excerpt: 'e', content: 'too short', coverImage: 'x', categoryId: catA.id, topics: ['t'], tags: ['a', 'b', 'c', 'd'], metaTitle: 'm', metaDescription: 'n' }, auth(admin));
        assert.equal(short.status, 422);
        assert.ok((short.body as { details: string[] }).details.some((d) => d.startsWith('content')));

        const fewTags = await send(`${base}/articles/create`, 'POST', { ...publishableBody('pv2'), tags: ['a'] }, auth(admin));
        assert.ok((fewTags.body as { details: string[] }).details.some((d) => d.startsWith('tags')));

        const longMeta = await send(`${base}/articles/create`, 'POST', { ...publishableBody('pv3'), metaDescription: 'x'.repeat(300) }, auth(admin));
        assert.ok((longMeta.body as { details: string[] }).details.some((d) => d.startsWith('metaDescription')));

        const noH2 = await send(`${base}/articles/create`, 'POST', { ...publishableBody('pv4'), content: 'z'.repeat(900) }, auth(admin));
        assert.ok((noH2.body as { details: string[] }).details.some((d) => d.includes('H2')));

        const noExcerpt = await send(`${base}/articles/create`, 'POST', { ...publishableBody('pv5'), excerpt: undefined }, auth(admin));
        assert.ok((noExcerpt.body as { details: string[] }).details.some((d) => d.startsWith('excerpt')));

        const topicOver = await send(`${base}/articles/create`, 'POST', { ...publishableBody('pv6'), topics: ['a', 'b'] }, auth(admin));
        assert.ok((topicOver.body as { details: string[] }).details.some((d) => d.startsWith('topics')));

        const good = await send(`${base}/articles/create`, 'POST', publishableBody('pvok'), auth(admin));
        assert.equal(good.status, 200, good.text.slice(0, 200));
        const created = good.body as { id: string; title: string };
        createdArticleIds.add(created.id);
        publishedSubjects.push(`New Insight: ${created.title}`);
      },
    },
    // ── slug conflict 409 ────────────────────────────────────────────────
    {
      name: 'create with an existing slug → 409 (frozen Slug-already-exists guard)',
      run: async () => {
        const dup = await send(`${base}/articles/create`, 'POST', draftBody('dup', { slug: `p05-e2e-pub-${stamp}` }), auth(admin));
        assert.equal(dup.status, 409);
      },
    },
    // ── internal routes secret gate (DoD #6) ─────────────────────────────
    {
      name: 'Internal fan-outs: missing or wrong x-internal-secret → 401 (Hard Rule 6)',
      run: async () => {
        const routes: Array<[string, string, unknown]> = [
          ['POST', '/internal/articles/publish-scheduled', undefined],
          ['POST', '/internal/articles/queue-alerts', { articleId: artPub }],
          ['PUT', `/internal/ai-drafts/${stamp}-key`, { title: 'T', content: 'C', excerpt: 'E', topic: 'x' }],
          ['POST', '/internal/admin/admin-dedupe-articles', undefined],
        ];
        for (const [method, path, body] of routes) {
          const missing = await send(`${base}${path}`, method, body);
          assert.equal(missing.status, 401, `${path} without secret`);
          const wrong = await send(`${base}${path}`, method, body, { 'x-internal-secret': 'definitely-not-the-secret' });
          assert.equal(wrong.status, 401, `${path} wrong secret`);
        }
      },
    },
    // ── publish-scheduled idempotence (DoD #13) ──────────────────────────
    {
      name: 'publishScheduledArticles: publishes due rows once; re-run publishes nothing (DEV-031-class internal idempotence)',
      run: async () => {
        const secret = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET as string };
        const first = await send(`${base}/internal/articles/publish-scheduled`, 'POST', undefined, secret);
        assert.equal(first.status, 200, first.text.slice(0, 200));
        const art = await prisma.article.findUnique({ where: { id: artSched }, select: { status: true, publishedAt: true } });
        assert.equal(art?.status, 'published');
        assert.ok(art?.publishedAt);
        const queueAfterFirst = await prisma.emailQueue.count({ where: { recipient: addr('subscriber'), subject: `New Insight: P05 E2E Scheduled ${stamp}` } });
        assert.equal(queueAfterFirst, 1, 'first publish must queue exactly one alert for the fixture subscriber');
        const second = await send(`${base}/internal/articles/publish-scheduled`, 'POST', undefined, secret);
        assert.equal((second.body as { publishedCount: number }).publishedCount, 0, 'second run must publish nothing');
        const queueAfterSecond = await prisma.emailQueue.count({ where: { recipient: addr('subscriber'), subject: `New Insight: P05 E2E Scheduled ${stamp}` } });
        assert.equal(queueAfterSecond, 1, 'second run must not duplicate queue rows');
      },
    },
    // ── queue-alerts idempotence ─────────────────────────────────────────
    {
      name: 'queueNewArticleAlerts: second identical call inserts no duplicate queue rows',
      run: async () => {
        const secret = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET as string };
        const body = { articleId: artPub };
        await send(`${base}/internal/articles/queue-alerts`, 'POST', body, secret);
        const afterFirst = await prisma.emailQueue.count({ where: { recipient: addr('subscriber'), subject: `New Insight: P05 E2E Published ${stamp}` } });
        const again = await send(`${base}/internal/articles/queue-alerts`, 'POST', body, secret);
        assert.equal(again.status, 200);
        assert.equal((again.body as { queued: number }).queued, 0);
        const afterSecond = await prisma.emailQueue.count({ where: { recipient: addr('subscriber'), subject: `New Insight: P05 E2E Published ${stamp}` } });
        assert.equal(afterSecond, afterFirst);
      },
    },
    // ── saveAIDraft idempotence (PUT + deterministic slug suffix) ────────
    {
      name: 'saveAIDraft: PUT with the same key twice → same article id, second call created=false',
      run: async () => {
        const secret = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET as string };
        const key = `${stamp}-ai-key`;
        const body = { title: `P05 E2E AI Draft ${stamp}`, content: LONG_CONTENT, excerpt: 'ai excerpt', topic: 'vexium', topics: ['vexium'] };
        const first = await send(`${base}/internal/ai-drafts/${key}`, 'PUT', body, secret);
        assert.equal(first.status, 200, first.text.slice(0, 200));
        const created = first.body as { id: string; created: boolean };
        assert.equal(created.created, true);
        createdArticleIds.add(created.id);
        const article = await prisma.article.findUnique({ where: { id: created.id }, select: { categoryId: true, source: true, status: true } });
        assert.ok(article?.categoryId);
        aiDraftCategoryAdjustments.set(article.categoryId, (aiDraftCategoryAdjustments.get(article.categoryId) ?? 0) + 1);
        const second = await send(`${base}/internal/ai-drafts/${key}`, 'PUT', body, secret);
        const replayed = second.body as { id: string; created: boolean };
        assert.equal(replayed.id, created.id, 'replay created a second draft');
        assert.equal(replayed.created, false);
        assert.equal(article?.source, 'ai');
        assert.equal(article?.status, 'draft');
      },
    },
    // ── adminDedupeArticles internal + idempotent (DoD #12/#13) ──────────
    {
      name: 'adminDedupeArticles: internal-only, advisory-locked, no-op on a clean table (DEV-025 class)',
      run: async () => {
        const secret = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET as string };
        const first = await send(`${base}/internal/admin/admin-dedupe-articles`, 'POST', undefined, secret);
        assert.equal(first.status, 200);
        assert.deepEqual((first.body as { dedupedSlugs: string[] }).dedupedSlugs, [], 'articles.slug is UNIQUE — a clean table must dedupe nothing');
        const second = await send(`${base}/internal/admin/admin-dedupe-articles`, 'POST', undefined, secret);
        assert.deepEqual((second.body as { dedupedSlugs: string[] }).dedupedSlugs, []);
      },
    },
    // ── DEV-025 cascade on deleteForever ─────────────────────────────────
    {
      name: 'DEV-025: deleteForever cascades reactions/bookmarks/comments — 0 orphans',
      run: async () => {
        const scratch = await mkArticle('cascade', {});
        await prisma.bookmark.create({ data: { userId: memberId, articleId: scratch, createdAt: new Date() } });
        await prisma.reaction.create({ data: { userId: memberId, articleId: scratch, type: 'like', createdAt: new Date() } });
        await prisma.comment.create({ data: { userId: memberId, articleId: scratch, content: 'hi', status: 'pending', createdAt: new Date() } });
        const del = await send(`${base}/articles/delete-forever?id=${scratch}`, 'DELETE', undefined, auth(admin));
        assert.equal(del.status, 200, del.text.slice(0, 160));
        createdArticleIds.delete(scratch);
        const [bm, rx, cm] = await Promise.all([
          prisma.bookmark.count({ where: { articleId: scratch } }),
          prisma.reaction.count({ where: { articleId: scratch } }),
          prisma.comment.count({ where: { articleId: scratch } }),
        ]);
        assert.deepEqual([bm, rx, cm], [0, 0, 0], 'dangling children after deleteForever');
      },
    },
    // ── delete-forever matrix cleanup fix: use id query param ────────────
    {
      name: 'DELETE /articles/delete-forever with an extra query key → 400 (whitelist)',
      run: async () => {
        const res = await send(`${base}/articles/delete-forever?scratch=1&id=${artPub}`, 'DELETE', undefined, auth(admin));
        assert.equal(res.status, 400, 'the scratch=1 probe param must be rejected');
      },
    },
    // ── delete-guard tests (categories/pillars) ──────────────────────────
    {
      name: 'Category delete guard 409 while linked; pillar delete guard 409 while linked (frozen semantics)',
      run: async () => {
        const catBlock = await send(`${base}/categories/remove`, 'PATCH', { id: catA.id }, auth(admin));
        assert.equal(catBlock.status, 409);
        const pilBlock = await send(`${base}/pillars/remove`, 'PATCH', { id: pillarP.id }, auth(admin));
        assert.equal(pilBlock.status, 409);
        const pilDup = await send(`${base}/pillars/create`, 'POST', { name: 'dup', slug: pillarP.slug, categoryId: catA.id }, auth(admin));
        assert.equal(pilDup.status, 409);
      },
    },
    // ── listAdmin archived/NULL semantics (§7.1) ─────────────────────────
    {
      name: '§7.1: listAdmin isArchived uses IS NOT TRUE — NULL-archived row browses as live, archived=true branch finds the archived row',
      run: async () => {
        const browse = await send(`${base}/articles/admin?pageSize=100&status=published`, 'GET', undefined, auth(admin));
        assert.equal(browse.status, 200);
        const items = (browse.body as { items: { id: string }[] }).items;
        const ids = items.map((i) => i.id);
        assert.ok(ids.includes(artNullArch), 'NULL isArchived row dropped by = false semantics');
        assert.ok(!ids.includes(artArchived), 'archived row leaked into the default browse');
        const archived = await send(`${base}/articles/admin?pageSize=100&isArchived=true`, 'GET', undefined, auth(admin));
        const archivedIds = (archived.body as { items: { id: string }[] }).items.map((i) => i.id);
        assert.ok(archivedIds.includes(artArchived));
      },
    },
    // ── DEV-008 scorer unit parity vs the §7.2 table ─────────────────────
    {
      name: 'DEV-008 §7.2: verbatim normalisation, 83-word stopword list, additive weights (exact 100 / contains 60 / slug 50 / meta 30 / focus 25 / +10/+7/+6/+5/+4/+4/+4 / all-title 15)',
      run: () => {
        // normalisation deletes non-ASCII (em-dash/accents) — documented limitation, ported as-is.
        assert.equal(normalizeSearchText('Élan!  Test—It'), 'lan test it');
        assert.deepEqual(tokenizeSearchQuery('the how does work'), ['work']);
        assert.deepEqual(tokenizeSearchQuery('a an of to in'), []);

        const ctx = { nQuery: 'alpha beta', slugifiedQuery: 'alpha-beta', tokens: ['alpha', 'beta'], nCategoryName: 'alpha stuff', nPillarName: '' };
        const base = { slug: 'zzz', metaTitle: null, focusKeyword: null, excerpt: null, tags: [], topics: [] };

        // category 'alpha stuff' contributes +4 for token 'alpha' to every case below.
        const exact = scoreSearchArticle({ ...base, title: 'Alpha Beta' }, ctx); // +100, +10+10, +15, cat +4
        assert.equal(exact, 100 + 20 + 15 + 4, `exact-title score ${exact}`);
        const exactWithSlug = scoreSearchArticle({ ...base, title: 'Alpha Beta', slug: 'alpha-beta-post' }, ctx);
        assert.equal(exactWithSlug, 100 + 20 + 15 + 4 + 50);
        const contains = scoreSearchArticle({ ...base, title: 'The alpha beta war' }, ctx); // +60 +10+10 +15, category alpha +4
        assert.equal(contains, 60 + 20 + 15 + 4, `contains score ${contains}`);
        const meta = scoreSearchArticle({ ...base, title: 'Nothing', metaTitle: 'alpha beta here', focusKeyword: 'alpha' }, ctx);
        // meta contains the whole query (+30); per token the meta/focus pair (+7 each = 14); category alpha +4.
        assert.equal(meta, 30 + 14 + 4);
        const tags = scoreSearchArticle({ ...base, title: 'x', tags: ['ALPHA rocks'], topics: ['beta'] }, ctx);
        assert.equal(tags, 6 + 5 + 4); // tags 6 + topics 5 + category alpha 4
        const allTitleBonusAbsent = scoreSearchArticle({ ...base, title: 'only alpha' }, ctx);
        assert.equal(allTitleBonusAbsent, 10 + 4); // one token hits title (+10) + category alpha (+4); NO +15
      },
    },
    // ── DEV-008 ranked ordering end-to-end over fixtures ─────────────────
    {
      name: 'DEV-008: GET /articles/search reproduces score DESC, viewCount DESC over the fixtures (exact > phrase > token)',
      run: async () => {
        const res = await request(`${base}/articles/search?query=vexium%20quokka%20fieldnotes`);
        assert.equal(res.status, 200);
        const results = res.body as { id: string; slug: string }[];
        assert.ok(results.length <= 8, 'LIMIT 8 must hold');
        const mine = results
          .map((r, i) => ({ i, id: r.id }))
          .filter((r) => Object.values(searchIds).includes(r.id));
        assert.equal(mine.length, 3, 'all three fixtures must rank within top 8');
        const pos = (which: 'exact' | 'contains' | 'token'): number => {
          const found = mine.find((m) => m.id === searchIds[which]);
          assert.ok(found, `${which} fixture missing from results`);
          return found.i;
        };
        assert.ok(pos('exact') < pos('contains'), 'exact-title must outrank title-contains');
        assert.ok(pos('contains') < pos('token'), 'title-contains must outrank token-overlap-only');
        const empty = await request(`${base}/articles/search?query=the%20a%20an`);
        assert.deepEqual(empty.body, [], 'stopword-only query → [] (no tokens, no phrase hit)');
      },
    },
    // ── SEO field preservation (DoD #18) ─────────────────────────────────
    {
      name: 'DoD #18: getBySlug carries the SEO-bearing fields byte-for-byte (slug/metaTitle/metaDescription/excerpt/coverImage/publishedAt)',
      run: async () => {
        const res = await request(`${base}/articles/by-slug?slug=p05-e2e-pub-${stamp}`);
        assert.equal(res.status, 200);
        const body = res.body as Record<string, unknown>;
        assert.equal(body.slug, `p05-e2e-pub-${stamp}`);
        assert.equal(body.metaTitle, 'P05 meta title');
        assert.equal(body.metaDescription, 'P05 meta description');
        assert.equal(body.excerpt, 'pub excerpt');
        assert.equal(body.coverImage, 'https://images.example.test/pub.jpg');
        assert.equal(body.coverImageAlt, 'pub alt');
        assert.equal(body.pillar, pillarP.slug);
        assert.ok(typeof body.publishedAt === 'string' && (body.publishedAt as string).length > 0);
        assert.deepEqual(body.topics, ['vexium']);
        assert.deepEqual(body.tags, ['alpha', 'beta', 'gamma', 'delta']);
      },
    },
    // ── public lists exclude archived (frozen neq-true semantics) ────────
    {
      name: 'Public lists exclude isArchived rows (neq true, NULLs kept); by-slug 404 for archived',
      run: async () => {
        const list = await request(`${base}/articles?pageSize=100`);
        const ids = (list.body as { items: { id: string }[] }).items.map((i) => i.id);
        assert.ok(!ids.includes(artArchived));
        assert.ok(ids.includes(artNullArch));
        const slug = await request(`${base}/articles/by-slug?slug=p05-e2e-arch-${stamp}`);
        assert.equal(slug.status, 404);
      },
    },
    // ── toggle-featured + restore/remove transitions ─────────────────────
    {
      name: 'remove→archived, restore→live, toggle-featured flips (frozen no-op semantics on missing rows)',
      run: async () => {
        const scratch = await mkArticle('flow', {});
        const rm = await send(`${base}/articles/remove`, 'PATCH', { id: scratch }, auth(admin));
        assert.equal(rm.status, 200);
        assert.equal((await prisma.article.findUnique({ where: { id: scratch } }))?.isArchived, true);
        await send(`${base}/articles/restore`, 'POST', { id: scratch }, auth(admin));
        assert.equal((await prisma.article.findUnique({ where: { id: scratch } }))?.isArchived, false);
        await send(`${base}/articles/toggle-featured`, 'PATCH', { id: scratch, isFeatured: true }, auth(admin));
        assert.equal((await prisma.article.findUnique({ where: { id: scratch } }))?.isFeatured, true);
        const missing = await send(`${base}/articles/toggle-featured`, 'PATCH', { id: randomUUID(), isFeatured: true }, auth(admin));
        assert.equal(missing.status, 404);
      },
    },
    // ── quotes public/admin separation (S-015/016 class) ─────────────────
    {
      name: 'quotes: add/remove are admin-only (frozen public writes closed); random+listAll public',
      run: async () => {
        const added = await send(`${base}/quotes/add`, 'PATCH', { text: 'P05 e2e quote', author: 'Nietzsche', category: 'pill' }, auth(admin));
        assert.equal(added.status, 200);
        createdQuoteIds.add((added.body as { id: string }).id);
        const anonAdd = await send(`${base}/quotes/add`, 'PATCH', { text: 'x', author: 'y' });
        assert.equal(anonAdd.status, 401);
        const list = await request(`${base}/quotes/all`);
        assert.equal(list.status, 200);
        const rnd = await request(`${base}/quotes/random`);
        assert.equal(rnd.status, 200);
      },
    },
    // ── site-settings S-012 end-to-end ───────────────────────────────────
    {
      name: 'S-012 closed: anonymous 401 / non-admin 403 / admin 200 on update-site-settings; public read keeps its content',
      run: async () => {
        const cur = await request(`${base}/site-settings/site-settings`);
        const c = cur.body as Record<string, unknown>;
        const body = {
          siteName: c.siteName,
          siteDescription: c.siteDescription,
          email: c.email,
          phone: c.phone ?? undefined,
          address: c.address ?? undefined,
          socials: c.socials ?? {},
          footerText: c.footerText ?? undefined,
        };
        const anon = await send(`${base}/site-settings/update-site-settings`, 'PATCH', body);
        assert.equal(anon.status, 401);
        const nonAdmin = await send(`${base}/site-settings/update-site-settings`, 'PATCH', body, auth(member));
        assert.equal(nonAdmin.status, 403);
        const ok = await send(`${base}/site-settings/update-site-settings`, 'PATCH', body, auth(admin));
        assert.equal(ok.status, 200, ok.text.slice(0, 200));
        const after = await request(`${base}/site-settings/site-settings`);
        assert.equal((after.body as Record<string, unknown>).siteName, c.siteName);
      },
    },
    // ── DEV-064: blank email clears, malformed email still rejected ──────
    {
      name: "DEV-064: update-site-settings blank email clears to '' (200); malformed non-empty email → 400",
      run: async () => {
        const cur = await request(`${base}/site-settings/site-settings`);
        const c = cur.body as Record<string, unknown>;
        const baseBody = {
          siteName: c.siteName,
          siteDescription: c.siteDescription,
          phone: c.phone ?? undefined,
          address: c.address ?? undefined,
          socials: c.socials ?? {},
          footerText: c.footerText ?? undefined,
        };
        // A blank string is the explicit "clear the contact address" action the
        // frozen mutation allowed and the Phase 05 required `@IsEmail()` broke.
        const cleared = await send(
          `${base}/site-settings/update-site-settings`,
          'PATCH',
          { ...baseBody, email: '' },
          auth(admin),
        );
        assert.equal(cleared.status, 200, cleared.text.slice(0, 200));
        assert.equal((cleared.body as Record<string, unknown>).email, '');
        const afterClear = await request(`${base}/site-settings/site-settings`);
        assert.equal((afterClear.body as Record<string, unknown>).email, '');

        // A non-empty value that is not an email is still refused, and the
        // stored value is left untouched.
        const malformed = await send(
          `${base}/site-settings/update-site-settings`,
          'PATCH',
          { ...baseBody, email: 'not-an-email' },
          auth(admin),
        );
        assert.equal(malformed.status, 400, malformed.text.slice(0, 200));
        const afterBad = await request(`${base}/site-settings/site-settings`);
        assert.equal((afterBad.body as Record<string, unknown>).email, '');

        // JSON null must be a controlled 400, never a NOT NULL write → 500.
        const nulled = await send(
          `${base}/site-settings/update-site-settings`,
          'PATCH',
          { ...baseBody, email: null },
          auth(admin),
        );
        assert.equal(nulled.status, 400, nulled.text.slice(0, 200));
        const afterNull = await request(`${base}/site-settings/site-settings`);
        assert.equal((afterNull.body as Record<string, unknown>).email, '');
      },
    },
    // ── listAdmin search branch (searchVector GIN) ───────────────────────
    {
      name: '§7.1 admin search: listAdmin?search=vexium uses the searchVector GIN (no ts_rank) and filters hold',
      run: async () => {
        const res = await send(`${base}/articles/admin?search=vexium&pageSize=20`, 'GET', undefined, auth(admin));
        assert.equal(res.status, 200, res.text.slice(0, 200));
        const ids = (res.body as { items: { id: string }[] }).items.map((i) => i.id);
        assert.ok(ids.includes(searchIds.exact), 'searchVector must match the exact-title fixture');
        const filtered = await send(`${base}/articles/admin?status=published&categoryId=${catA.id}&pageSize=50`, 'GET', undefined, auth(admin));
        for (const item of (filtered.body as { items: { status: string; categoryId: string | null }[] }).items) {
          assert.equal(item.status, 'published');
          assert.equal(item.categoryId, catA.id);
        }
      },
    },
    // ── DEV-041: getByAuthor archived filter ─────────────────────────────
    {
      name: 'DEV-041: archived published article disappears from GET /articles/by-author; NULL-isArchived row stays visible',
      run: async () => {
        // artArchived (published + isArchived:true) and artNullArch (published +
        // isArchived:null) are both authored by adminId — the two cases the frozen
        // query failed to separate.
        const res = await request(`${base}/articles/by-author?authorId=${adminId}&limit=100`);
        assert.equal(res.status, 200, res.text.slice(0, 200));
        const ids = (res.body as { id: string }[]).map((a) => a.id);
        assert.ok(!ids.includes(artArchived), 'DEV-041: archived article still surfaced on the public author page');
        assert.ok(ids.includes(artNullArch), 'DEV-041: NULL-isArchived article wrongly dropped (IS NOT TRUE must keep NULLs)');
        assert.ok(ids.includes(artPub), 'sanity: the live published article is present');
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
  } finally {
    // Shared-state restore FIRST, so a later FK-ordering failure can never skip
    // it (that skipped restore is what drifted globalStats on 2026-10-01).
    if (gsBefore) {
      await prisma.globalStats.update({ where: { id: 'global_stats' }, data: gsBefore });
    }
    if (settingsBefore) {
      const restore = {
        id: settingsBefore.id,
        siteName: settingsBefore.siteName,
        siteDescription: settingsBefore.siteDescription,
        email: settingsBefore.email,
        phone: settingsBefore.phone,
        address: settingsBefore.address,
        socials: settingsBefore.socials as Prisma.InputJsonValue,
        footerText: settingsBefore.footerText,
        updatedAt: settingsBefore.updatedAt,
      };
      await prisma.siteSettings.upsert({ where: { id: 'site_settings' }, update: restore, create: restore });
    }
    if (!adsRowExisted) await prisma.adsSettings.deleteMany({ where: { id: 'ads_settings' } });

    // Fixture teardown: articles → pillars → categories → users (FK-safe order).
    await prisma.emailQueue.deleteMany({ where: { subject: { in: publishedSubjects } } });
    await prisma.article.deleteMany({ where: { slug: { startsWith: 'p05-e2e' } } });
    for (const [categoryId, n] of aiDraftCategoryAdjustments) {
      await prisma.category.updateMany({ where: { id: categoryId }, data: { articleCount: { decrement: n } } });
    }
    await prisma.pillar.deleteMany({ where: { slug: { startsWith: 'p05-e2e' } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'p05-e2e' } } });
    await prisma.quote.deleteMany({ where: { id: { in: [...createdQuoteIds] } } });
    await prisma.quote.deleteMany({ where: { text: { in: ['P05 quote', 'P05 e2e quote'] } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'p05-e2e-' } } });
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
