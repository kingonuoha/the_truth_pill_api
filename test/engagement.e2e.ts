/**
 * Phase 06 engagement-modules e2e suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (global default-deny `JwtAuthGuard` + `RolesGuard`
 * in force) and exercises the guard matrix, the exact 8-key `getEngagement`
 * shape, DEV-044 fail-closed optional auth, DEV-029 selector deletion,
 * DEV-021/DEV-022 counter discipline, DEV-034 projections, DEV-042 moderation
 * gating, DEV-043 comment-parent cascade, idempotent toggles and concurrency.
 * Run: `npm run test:engagement`.
 *
 * ⚠️ Writes to the dev Neon branch. Every fixture row carries a unique
 * `p06-e2e-<stamp>` marker and is deleted in `finally`; the `globalStats` cache
 * row and every touched `articles.reactionsCount` are snapshotted and restored
 * BEFORE fixture deletion (the Phase 05 lesson: a skipped restore drifts the
 * cache). A post-cleanup residue check must report 0.
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
 * deterministic 500 still fails — the retry surfaces it twice.
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

/** §10 / DEV-034: user-secret keys that must never appear on an engagement surface. */
const SECRET_KEYS = [
  'password',
  'email',
  'role',
  'resetToken',
  'resetTokenExpires',
  'confirmationToken',
  'confirmationTokenExpires',
] as const;

const ENGAGEMENT_KEYS = [
  'likeCount',
  'loveCount',
  'insightfulCount',
  'totalReactions',
  'commentsCount',
  'bookmarksCount',
  'userReaction',
  'isBookmarked',
].sort();

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const base = `${await app.getUrl()}/api/v1`;
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);
  const denylist = app.get(JtiDenylistService);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const addr = (tag: string): string => `p06-e2e-${tag}-${stamp}@example.test`;
  const createdUserIds = new Set<string>();
  const createdArticleIds = new Set<string>();
  /** Article id → pre-run `reactionsCount`, restored on teardown. */
  const reactionCountBefore = new Map<string, number | null>();

  const mkUser = async (tag: string, role: 'admin' | 'user'): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        name: `P06 ${tag}`,
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

  const mkArticle = async (tag: string): Promise<string> => {
    const article = await prisma.article.create({
      data: {
        title: `P06 E2E ${tag} ${stamp}`,
        slug: `p06-e2e-${tag}-${stamp}`,
        status: 'published',
        source: 'human',
        authorId: adminId,
        readingTime: 1,
        isArchived: false,
        reactionsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as Prisma.ArticleUncheckedCreateInput,
      select: { id: true, reactionsCount: true },
    });
    createdArticleIds.add(article.id);
    reactionCountBefore.set(article.id, article.reactionsCount);
    return article.id;
  };

  const mkComment = async (input: {
    articleId: string;
    userId: string;
    status: 'approved' | 'pending' | 'spam' | 'removed';
    content?: string;
    parentId?: string | null;
    createdAt?: Date;
  }): Promise<string> => {
    const comment = await prisma.comment.create({
      data: {
        articleId: input.articleId,
        userId: input.userId,
        parentId: input.parentId ?? null,
        content: input.content ?? `P06 comment ${stamp}`,
        status: input.status,
        createdAt: input.createdAt ?? new Date(),
      },
      select: { id: true },
    });
    return comment.id;
  };

  const adminId = await mkUser('admin', 'admin');
  const memberId = await mkUser('member', 'user');
  const victimId = await mkUser('victim', 'user');
  const admin = tokens.sign(adminId).token;
  const member = tokens.sign(memberId).token;
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  const artMain = await mkArticle('main');
  const artOther = await mkArticle('other');

  // Aggregate seed for getEngagement: victim likes artMain directly, and the
  // derived `reactionsCount` is kept in step at fixture time (DEV-021).
  await prisma.reaction.create({
    data: { articleId: artMain, userId: victimId, type: 'like', createdAt: new Date() },
  });
  await prisma.article.update({
    where: { id: artMain },
    data: { reactionsCount: 1 },
  });
  reactionCountBefore.set(artMain, 1);

  const gsBefore = await prisma.globalStats.findFirst({
    select: {
      articleCount: true,
      publishedArticleCount: true,
      draftArticleCount: true,
      scheduledArticleCount: true,
      aiDraftCount: true,
      usersCount: true,
      commentsCount: true,
      pendingCommentsCount: true,
      totalViews: true,
      totalUniqueViews: true,
    },
  });

  const globalComments = async (): Promise<{ commentsCount: number; pendingCommentsCount: number }> => {
    const row = await prisma.globalStats.findFirst({
      select: { commentsCount: true, pendingCommentsCount: true },
    });
    if (!row) throw new Error('globalStats row is missing');
    return row;
  };

  const reactionCount = (articleId: string): Promise<number> =>
    prisma.reaction.count({ where: { articleId } });

  const storedReactionCount = async (articleId: string): Promise<number> => {
    const row = await prisma.article.findUnique({
      where: { id: articleId },
      select: { reactionsCount: true },
    });
    return row?.reactionsCount ?? 0;
  };

  const assertReactionCounterInStep = async (articleId: string, label: string): Promise<void> => {
    const [count, stored] = await Promise.all([
      reactionCount(articleId),
      storedReactionCount(articleId),
    ]);
    assert.equal(stored, count, `${label}: articles.reactionsCount ${stored} != count(reactions) ${count}`);
  };

  const orphanCount = async (): Promise<number> => {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM "comments" child
      LEFT JOIN "comments" parent ON child."parentId" = parent."id"
      WHERE child."parentId" IS NOT NULL AND parent."id" IS NULL`;
    return rows[0]?.count ?? 0;
  };

  /* ─────────────────────────── checks ─────────────────────────── */

  const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
    // ── guard matrix ──────────────────────────────────────────────────────
    {
      name: 'Guard matrix DEV-042: moderation routes 401 anonymous / 403 non-admin / 200-or-404 admin; auth-owner writes 401 anonymous',
      run: async () => {
        const adminRoutes: Array<{ name: string; method: string; path: string; body?: unknown }> = [
          { name: 'GET /engagement/all-comments', method: 'GET', path: '/engagement/all-comments' },
          { name: 'PATCH /engagement/update-comment-status', method: 'PATCH', path: '/engagement/update-comment-status', body: { id: randomUUID(), status: 'approved' } },
          { name: 'DELETE /engagement/delete-comment', method: 'DELETE', path: `/engagement/delete-comment?id=${randomUUID()}` },
        ];
        for (const row of adminRoutes) {
          const url = `${base}${row.path}`;
          const anon = await send(url, row.method, row.body);
          assert.equal(anon.status, 401, `${row.name}: anonymous expected 401, got ${anon.status}`);
          const nonAdmin = await send(url, row.method, row.body, auth(member));
          assert.equal(nonAdmin.status, 403, `${row.name}: non-admin expected 403, got ${nonAdmin.status}`);
          const asAdmin = await send(url, row.method, row.body, auth(admin));
          assert.ok(
            asAdmin.status === 200 || asAdmin.status === 404,
            `${row.name}: admin expected 200/404, got ${asAdmin.status} ${asAdmin.text.slice(0, 160)}`,
          );
        }

        const authRoutes: Array<{ name: string; method: string; path: string; body: unknown }> = [
          { name: 'PATCH /engagement/toggle-reaction', method: 'PATCH', path: '/engagement/toggle-reaction', body: { articleId: artMain, type: 'like' } },
          { name: 'PATCH /engagement/toggle-bookmark', method: 'PATCH', path: '/engagement/toggle-bookmark', body: { articleId: artMain } },
          { name: 'PATCH /engagement/add-comment', method: 'PATCH', path: '/engagement/add-comment', body: { articleId: artMain, content: 'x' } },
        ];
        for (const row of authRoutes) {
          const anon = await send(`${base}${row.path}`, row.method, row.body);
          assert.equal(anon.status, 401, `${row.name}: anonymous expected 401, got ${anon.status}`);
        }
      },
    },
    // ── public reads reachable without a token ────────────────────────────
    {
      name: 'Public reads: GET /engagement/engagement and GET /engagement/comments reachable without any token',
      run: async () => {
        const counts = await request(`${base}/engagement/engagement?articleId=${artMain}`);
        assert.equal(counts.status, 200, counts.text.slice(0, 200));
        const comments = await request(`${base}/engagement/comments?articleId=${artMain}`);
        assert.equal(comments.status, 200, comments.text.slice(0, 200));
      },
    },
    // ── exact 8-key shape + anonymous state (DoD #4) ──────────────────────
    {
      name: 'DEV-044: getEngagement returns exactly the frozen 8 keys; anonymous → counts + userReaction null / isBookmarked false',
      run: async () => {
        const res = await request(`${base}/engagement/engagement?articleId=${artMain}`);
        assert.equal(res.status, 200, res.text.slice(0, 200));
        assert.ok(isRecord(res.body));
        assert.deepEqual(Object.keys(res.body as Record<string, unknown>).sort(), ENGAGEMENT_KEYS);
        const body = res.body as Record<string, unknown>;
        assert.equal(body.likeCount, 1, 'victim seed like must be counted');
        assert.equal(body.loveCount, 0);
        assert.equal(body.insightfulCount, 0);
        assert.equal(body.totalReactions, 1);
        assert.equal(body.userReaction, null, 'anonymous viewer must be null');
        assert.equal(body.isBookmarked, false, 'anonymous viewer must be false');
      },
    },
    // ── DEV-029 identity-selector deletion ────────────────────────────────
    {
      name: 'DEV-029: getEngagement ?userEmail → 400; userEmail/userId/adminEmail in a write body → 400',
      run: async () => {
        const query = await request(`${base}/engagement/engagement?articleId=${artMain}&userEmail=${encodeURIComponent(addr('member'))}`);
        assert.equal(query.status, 400, 'userEmail query selector must be rejected by forbidNonWhitelisted');

        const cases: Array<{ path: string; body: Record<string, unknown> }> = [
          { path: '/engagement/toggle-reaction', body: { articleId: artMain, type: 'like', userEmail: addr('member') } },
          { path: '/engagement/toggle-bookmark', body: { articleId: artMain, userId: memberId } },
          { path: '/engagement/add-comment', body: { articleId: artMain, content: 'x', adminEmail: addr('admin') } },
        ];
        for (const c of cases) {
          const res = await send(`${base}${c.path}`, 'PATCH', c.body, auth(member));
          assert.equal(res.status, 400, `${c.path}: identity selector must be a 400`);
        }
      },
    },
    // ── DEV-044 fail-closed + valid-token personalization ────────────────
    {
      name: 'DEV-044: valid token → own state; invalid/expired/revoked/unknown-sub token → 401 (never silent anonymous)',
      run: async () => {
        await prisma.reaction.deleteMany({ where: { articleId: artMain, userId: memberId } });
        await prisma.bookmark.deleteMany({ where: { articleId: artMain, userId: memberId } });

        const clean = await send(`${base}/engagement/engagement?articleId=${artMain}`, 'GET', undefined, auth(member));
        assert.equal(clean.status, 200);
        assert.equal((clean.body as Record<string, unknown>).userReaction, null);

        const toggled = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'love' }, auth(member));
        assert.equal(toggled.status, 200, toggled.text.slice(0, 200));

        const mine = await send(`${base}/engagement/engagement?articleId=${artMain}`, 'GET', undefined, auth(member));
        assert.equal(mine.status, 200);
        assert.equal((mine.body as Record<string, unknown>).userReaction, 'love', 'viewer state must follow the token sub');

        const anon = await request(`${base}/engagement/engagement?articleId=${artMain}`);
        assert.equal((anon.body as Record<string, unknown>).userReaction, null, 'anonymous must not inherit another viewer’s state');

        await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'love' }, auth(member));

        const bad = await send(`${base}/engagement/engagement?articleId=${artMain}`, 'GET', undefined, { authorization: 'Bearer not.a.jwt' });
        assert.equal(bad.status, 401, 'malformed token must be 401, not anonymous');

        const expired = tokens.sign(memberId, { ttlSeconds: -120 }).token;
        const exp = await send(`${base}/engagement/engagement?articleId=${artMain}`, 'GET', undefined, auth(expired));
        assert.equal(exp.status, 401, 'expired token must be 401, not anonymous');

        const revoked = tokens.sign(memberId);
        denylist.revoke(revoked.jti, Date.now() + 300_000);
        const rev = await send(`${base}/engagement/engagement?articleId=${artMain}`, 'GET', undefined, auth(revoked.token));
        assert.equal(rev.status, 401, 'revoked token must be 401, not anonymous');

        const ghost = tokens.sign(randomUUID()).token;
        const unknown = await send(`${base}/engagement/engagement?articleId=${artMain}`, 'GET', undefined, auth(ghost));
        assert.equal(unknown.status, 401, 'token for a non-existent subject must be 401, not anonymous');
      },
    },
    // ── toggleReaction transitions + DEV-021 counter ─────────────────────
    {
      name: 'DEV-021: toggleReaction none→insert / same→delete / different→patch; articles.reactionsCount === count(reactions) after each',
      run: async () => {
        // Reset member state; victim seed remains (count 1).
        await prisma.reaction.deleteMany({ where: { articleId: artMain, userId: memberId } });
        await prisma.article.update({ where: { id: artMain }, data: { reactionsCount: 1 } });

        const first = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'like' }, auth(member));
        assert.equal(first.status, 200, first.text.slice(0, 200));
        assert.deepEqual(first.body, { active: true, type: 'like' });
        assert.equal(await reactionCount(artMain), 2);
        await assertReactionCounterInStep(artMain, 'after insert');

        const second = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'like' }, auth(member));
        assert.deepEqual(second.body, { active: false, type: null }, 'same type must delete');
        assert.equal(await reactionCount(artMain), 1);
        await assertReactionCounterInStep(artMain, 'after delete');

        const third = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'like' }, auth(member));
        assert.deepEqual(third.body, { active: true, type: 'like' });
        const fourth = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'love' }, auth(member));
        assert.deepEqual(fourth.body, { active: true, type: 'love' }, 'different type must patch');
        assert.equal(await reactionCount(artMain), 2, 'patch must not add a row');
        await assertReactionCounterInStep(artMain, 'after patch');

        const fifth = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'love' }, auth(member));
        assert.deepEqual(fifth.body, { active: false, type: null });
        await assertReactionCounterInStep(artMain, 'after final delete');

        // Invalid type → 400 (enum DTO).
        const badType = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'angry' }, auth(member));
        assert.equal(badType.status, 400);

        // Unknown article → 404.
        const missing = await send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: randomUUID(), type: 'like' }, auth(member));
        assert.equal(missing.status, 404);
      },
    },
    // ── toggleBookmark round-trip + Phase 05 integration (DoD #6/#7) ─────
    {
      name: 'DEV-029/DoD#7: toggleBookmark false→true→false; a toggled-on bookmark appears in GET /articles/bookmarked-articles and disappears on toggle-off',
      run: async () => {
        await prisma.bookmark.deleteMany({ where: { articleId: artMain, userId: memberId } });

        const on = await send(`${base}/engagement/toggle-bookmark`, 'PATCH', { articleId: artMain }, auth(member));
        assert.equal(on.status, 200, on.text.slice(0, 200));
        assert.equal(on.body, true, 'first toggle must return the frozen boolean true');
        assert.equal(await prisma.bookmark.count({ where: { articleId: artMain, userId: memberId } }), 1);

        const listed = await send(`${base}/articles/bookmarked-articles`, 'GET', undefined, auth(member));
        assert.equal(listed.status, 200);
        const listedIds = (listed.body as { id: string }[]).map((a) => a.id);
        assert.ok(listedIds.includes(artMain), 'toggled-on bookmark must surface in the Phase 05 read (shared table/key)');

        const off = await send(`${base}/engagement/toggle-bookmark`, 'PATCH', { articleId: artMain }, auth(member));
        assert.equal(off.body, false, 'second toggle must return false');
        assert.equal(await prisma.bookmark.count({ where: { articleId: artMain, userId: memberId } }), 0);
        const relisted = await send(`${base}/articles/bookmarked-articles`, 'GET', undefined, auth(member));
        const relistedIds = (relisted.body as { id: string }[]).map((a) => a.id);
        assert.ok(!relistedIds.includes(artMain), 'toggled-off bookmark must disappear');

        const missing = await send(`${base}/engagement/toggle-bookmark`, 'PATCH', { articleId: randomUUID() }, auth(member));
        assert.equal(missing.status, 404);
      },
    },
    // ── addComment: auth + validation + parent + counter + email queue ───
    {
      name: 'DEV-022/DEV-043: addComment auth, empty/oversize → 422, cross-article/missing parentId → 422, valid → userId === sub + commentsCount +1 + comment_alert row',
      run: async () => {
        const anon = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: 'hello' });
        assert.equal(anon.status, 401);

        const before = await globalComments();

        const empty = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: '' }, auth(member));
        assert.equal(empty.status, 422, empty.text.slice(0, 200));
        assert.ok((empty.body as { details?: string[] }).details?.some((d) => d.includes('content')));

        const oversize = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: 'x'.repeat(5001) }, auth(member));
        assert.equal(oversize.status, 422);
        assert.ok((oversize.body as { details?: string[] }).details?.some((d) => d.includes('content')));

        const afterInvalid = await globalComments();
        assert.equal(afterInvalid.commentsCount, before.commentsCount, 'rejected comments must not move the counter');

        const foreign = await mkComment({ articleId: artOther, userId: victimId, status: 'approved' });
        const cross = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: 'reply', parentId: foreign }, auth(member));
        assert.equal(cross.status, 422, cross.text.slice(0, 200));
        assert.ok((cross.body as { details?: string[] }).details?.some((d) => d.includes('parentId')));

        const missingParent = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: 'reply', parentId: randomUUID() }, auth(member));
        assert.equal(missingParent.status, 422);
        assert.ok((missingParent.body as { details?: string[] }).details?.some((d) => d.includes('parentId')));

        const created = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: `P06 valid comment ${stamp}` }, auth(member));
        assert.equal(created.status, 200, created.text.slice(0, 200));
        const commentId = (created.body as { id: string }).id;
        const row = await prisma.comment.findUnique({
          where: { id: commentId },
          select: { userId: true, status: true, articleId: true, parentId: true },
        });
        assert.equal(row?.userId, memberId, 'commenter must be the token subject (DEV-029)');
        assert.equal(row?.status, 'approved', 'status must default approved');
        assert.equal(row?.articleId, artMain);
        assert.equal(row?.parentId, null);

        const afterValid = await globalComments();
        assert.equal(afterValid.commentsCount, before.commentsCount + 1, 'valid comment must increment commentsCount by exactly 1');

        const reply = await send(`${base}/engagement/add-comment`, 'PATCH', { articleId: artMain, content: `P06 reply ${stamp}`, parentId: commentId }, auth(member));
        assert.equal(reply.status, 200, reply.text.slice(0, 200));
        const replyRow = await prisma.comment.findUnique({ where: { id: (reply.body as { id: string }).id }, select: { parentId: true } });
        assert.equal(replyRow?.parentId, commentId, 'same-article reply must persist its parentId');

        const queuedRows = await prisma.emailQueue.findMany({
          where: { templateName: 'comment_alert', subject: { contains: stamp } },
        });
        const queued = queuedRows.find(
          (row) =>
            (row.templateData as Record<string, unknown>).commentContent ===
            `P06 valid comment ${stamp}`,
        );
        assert.ok(queued, 'the frozen comment_alert emailQueue row must be inserted');
        assert.equal(queued?.status, 'pending');
        assert.equal(queued?.retries, 0);
        assert.ok(queued?.scheduledFor instanceof Date);
        assert.equal(queued?.recipient, process.env.ADMIN_EMAIL || 'admin@thetruthpill.org', 'recipient must be ADMIN_EMAIL with the frozen fallback');
        const templateData = queued?.templateData as Record<string, unknown>;
        assert.equal(templateData.commenterName, 'P06 member');
        assert.equal(templateData.articleTitle, `P06 E2E main ${stamp}`);
        assert.ok(typeof templateData.adminUrl === 'string' && (templateData.adminUrl as string).includes('/admin/comments'));
        assert.equal(templateData.commentContent, `P06 valid comment ${stamp}`);
      },
    },
    // ── listComments projection + status filter + order ──────────────────
    {
      name: 'DEV-034: listComments returns approved only, createdAt DESC, public author card only — no user document / secret key',
      run: async () => {
        const older = new Date(Date.now() - 60_000);
        const newer = new Date(Date.now() - 30_000);
        await mkComment({ articleId: artMain, userId: victimId, status: 'approved', content: `P06 approved older ${stamp}`, createdAt: older });
        await mkComment({ articleId: artMain, userId: victimId, status: 'approved', content: `P06 approved newer ${stamp}`, createdAt: newer });
        const pendingId = await mkComment({ articleId: artMain, userId: victimId, status: 'pending', content: `P06 pending ${stamp}` });
        const spamId = await mkComment({ articleId: artMain, userId: victimId, status: 'spam', content: `P06 spam ${stamp}` });

        const res = await request(`${base}/engagement/comments?articleId=${artMain}`);
        assert.equal(res.status, 200);
        const items = res.body as Array<Record<string, unknown>>;
        assert.ok(Array.isArray(items));
        assert.ok(items.length >= 2);

        for (const item of items) {
          assert.equal(item.status, 'approved', 'only approved comments may be returned');
          assert.notEqual(item.id, pendingId);
          assert.notEqual(item.id, spamId);
        }
        const newerComment = items.find((i) => i.content === `P06 approved newer ${stamp}`);
        const olderComment = items.find((i) => i.content === `P06 approved older ${stamp}`);
        assert.ok(newerComment, 'the newer ordering fixture must be present');
        assert.ok(olderComment, 'the older ordering fixture must be present');
        const newerIndex = items.indexOf(newerComment);
        const olderIndex = items.indexOf(olderComment);
        assert.ok(newerIndex < olderIndex, 'createdAt DESC: the newer approved comment must precede the older');

        const keys = collectKeys(res.body);
        for (const secret of SECRET_KEYS) {
          assert.ok(!keys.has(secret), `listComments leaks key "${secret}"`);
        }
        const sample = items[0] as Record<string, unknown>;
        assert.deepEqual(
          Object.keys(sample).sort(),
          ['articleId', 'authorImage', 'authorName', 'content', 'createdAt', 'id', 'parentId', 'status', 'userId'].sort(),
        );
        assert.equal(typeof sample.userId, 'string', 'userId must be a bare reference string');

        const missingArticle = await request(`${base}/engagement/comments`);
        assert.equal(missingArticle.status, 400, 'missing articleId must be a 400');
      },
    },
    // ── listAllComments admin-only + projection (DEV-042) ────────────────
    {
      name: 'DEV-042: listAllComments 401 anonymous / 403 non-admin / 200 admin; carries articleTitle/articleSlug and no user secret',
      run: async () => {
        const anon = await request(`${base}/engagement/all-comments`);
        assert.equal(anon.status, 401);
        const nonAdmin = await send(`${base}/engagement/all-comments`, 'GET', undefined, auth(member));
        assert.equal(nonAdmin.status, 403);

        const adminRes = await send(`${base}/engagement/all-comments`, 'GET', undefined, auth(admin));
        assert.equal(adminRes.status, 200, adminRes.text.slice(0, 200));
        const items = adminRes.body as Array<Record<string, unknown>>;
        assert.ok(items.length >= 1);
        const sample = items.find((i) => i.articleId === artMain);
        assert.ok(sample, 'moderation view must include the fixture comment');
        assert.equal(sample?.articleTitle, `P06 E2E main ${stamp}`);
        assert.equal(sample?.articleSlug, `p06-e2e-main-${stamp}`);
        const keys = collectKeys(adminRes.body);
        for (const secret of SECRET_KEYS) {
          assert.ok(!keys.has(secret), `listAllComments leaks key "${secret}"`);
        }

        const stray = await send(`${base}/engagement/all-comments?foo=1`, 'GET', undefined, auth(admin));
        assert.equal(stray.status, 400, 'any query key must be rejected (EmptyQueryDto + forbidNonWhitelisted)');
      },
    },
    // ── updateCommentStatus counter discipline (DEV-022) ─────────────────
    {
      name: 'DEV-022: updateCommentStatus 401/403/200; invalid status 400; pendingCommentsCount ±1 only on a real transition',
      run: async () => {
        const id = await mkComment({ articleId: artMain, userId: victimId, status: 'approved', content: `P06 status ${stamp}` });

        const anon = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id, status: 'pending' });
        assert.equal(anon.status, 401);
        const nonAdmin = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id, status: 'pending' }, auth(member));
        assert.equal(nonAdmin.status, 403);
        const badStatus = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id, status: 'archived' }, auth(admin));
        assert.equal(badStatus.status, 400);

        const before = await globalComments();
        const toPending = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id, status: 'pending' }, auth(admin));
        assert.equal(toPending.status, 200, toPending.text.slice(0, 200));
        const afterPending = await globalComments();
        assert.equal(afterPending.pendingCommentsCount, before.pendingCommentsCount + 1, 'approved→pending must +1 pendingCommentsCount');
        assert.equal(afterPending.commentsCount, before.commentsCount, 'status change must not move commentsCount');

        const noop = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id, status: 'pending' }, auth(admin));
        assert.equal(noop.status, 200);
        const afterNoop = await globalComments();
        assert.equal(afterNoop.pendingCommentsCount, afterPending.pendingCommentsCount, 'no-op status write must not move the counter');

        const toApproved = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id, status: 'approved' }, auth(admin));
        assert.equal(toApproved.status, 200);
        const afterApproved = await globalComments();
        assert.equal(afterApproved.pendingCommentsCount, before.pendingCommentsCount, 'pending→approved must -1 pendingCommentsCount');

        const missing = await send(`${base}/engagement/update-comment-status`, 'PATCH', { id: randomUUID(), status: 'approved' }, auth(admin));
        assert.equal(missing.status, 404);
      },
    },
    // ── deleteComment cascade + counter (DEV-042/DEV-043) ────────────────
    {
      name: 'DEV-043: deleteComment 401/403/200; parent delete cascades the reply subtree; orphan check 0; commentsCount drops by the exact subtree',
      run: async () => {
        const parent = await mkComment({ articleId: artMain, userId: memberId, status: 'approved', content: `P06 parent ${stamp}` });
        const child = await mkComment({ articleId: artMain, userId: victimId, status: 'approved', content: `P06 child ${stamp}`, parentId: parent });
        const grandchild = await mkComment({ articleId: artMain, userId: victimId, status: 'approved', content: `P06 grandchild ${stamp}`, parentId: child });

        const anon = await send(`${base}/engagement/delete-comment?id=${parent}`, 'DELETE');
        assert.equal(anon.status, 401);
        const nonAdmin = await send(`${base}/engagement/delete-comment?id=${parent}`, 'DELETE', undefined, auth(member));
        assert.equal(nonAdmin.status, 403);

        const before = await globalComments();
        const del = await send(`${base}/engagement/delete-comment?id=${parent}`, 'DELETE', undefined, auth(admin));
        assert.equal(del.status, 200, del.text.slice(0, 200));
        assert.deepEqual(del.body, { success: true });

        const remaining = await prisma.comment.count({ where: { id: { in: [parent, child, grandchild] } } });
        assert.equal(remaining, 0, 'the whole reply subtree must be removed');
        assert.equal(await orphanCount(), 0, 'no orphaned replies may remain (DEV-043)');

        const after = await globalComments();
        assert.equal(after.commentsCount, before.commentsCount - 3, 'commentsCount must drop by the exact subtree size');

        // Idempotent on an absent id — no counter change.
        const absent = await send(`${base}/engagement/delete-comment?id=${randomUUID()}`, 'DELETE', undefined, auth(admin));
        assert.equal(absent.status, 200);
        const afterAbsent = await globalComments();
        assert.equal(afterAbsent.commentsCount, after.commentsCount);
      },
    },
    // ── concurrency (Migration Rule 5) ───────────────────────────────────
    {
      name: 'DEV-021/Rule 5: 5 concurrent reaction toggles and 5 concurrent bookmark toggles keep each unique pair to at most one row and the counter in step (P05-SEC-003 headroom)',
      run: async () => {
        await prisma.reaction.deleteMany({ where: { articleId: artMain, userId: memberId } });
        await prisma.article.update({ where: { id: artMain }, data: { reactionsCount: 1 } });
        await prisma.bookmark.deleteMany({ where: { articleId: artMain, userId: memberId } });

        const reactionCalls = Array.from({ length: 5 }, () =>
          send(`${base}/engagement/toggle-reaction`, 'PATCH', { articleId: artMain, type: 'insightful' }, auth(member)),
        );
        const bookmarkCalls = Array.from({ length: 5 }, () =>
          send(`${base}/engagement/toggle-bookmark`, 'PATCH', { articleId: artMain }, auth(member)),
        );
        const [reactionResults, bookmarkResults] = await Promise.all([
          Promise.all(reactionCalls),
          Promise.all(bookmarkCalls),
        ]);

        for (const res of reactionResults) {
          assert.equal(res.status, 200, `concurrent reaction expected 200, got ${res.status} ${res.text.slice(0, 120)}`);
        }
        for (const res of bookmarkResults) {
          assert.equal(res.status, 200, `concurrent bookmark expected 200, got ${res.status} ${res.text.slice(0, 120)}`);
        }

        const memberReactions = await prisma.reaction.count({ where: { articleId: artMain, userId: memberId } });
        assert.ok(
          memberReactions === 0 || memberReactions === 1,
          `the unique (articleId, userId) pair must hold at most one row, got ${memberReactions}`,
        );
        await assertReactionCounterInStep(artMain, 'after concurrent reactions');

        const memberBookmarks = await prisma.bookmark.count({ where: { articleId: artMain, userId: memberId } });
        assert.ok(
          memberBookmarks === 0 || memberBookmarks === 1,
          `the unique (userId, articleId) pair must hold at most one row, got ${memberBookmarks}`,
        );
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
    for (const [articleId, count] of reactionCountBefore) {
      await prisma.article.updateMany({ where: { id: articleId }, data: { reactionsCount: count } });
    }

    // Fixture teardown (FK-safe: comments/reactions/bookmarks → articles → users).
    await prisma.emailQueue.deleteMany({
      where: { templateName: 'comment_alert', subject: { contains: stamp } },
    });
    await prisma.comment.deleteMany({
      where: { OR: [{ articleId: { in: [...createdArticleIds] } }, { userId: { in: [...createdUserIds] } }] },
    });
    await prisma.reaction.deleteMany({
      where: { OR: [{ articleId: { in: [...createdArticleIds] } }, { userId: { in: [...createdUserIds] } }] },
    });
    await prisma.bookmark.deleteMany({
      where: { OR: [{ articleId: { in: [...createdArticleIds] } }, { userId: { in: [...createdUserIds] } }] },
    });
    await prisma.article.deleteMany({ where: { slug: { startsWith: 'p06-e2e' } } });
    await prisma.user.deleteMany({ where: { email: { contains: 'p06-e2e-' } } });

    // Residue check (still connected).
    const [users, articles, comments, reactions, bookmarks, queued, orphans] = await Promise.all([
      prisma.user.count({ where: { email: { contains: 'p06-e2e-' } } }),
      prisma.article.count({ where: { slug: { startsWith: 'p06-e2e' } } }),
      prisma.comment.count({ where: { OR: [{ articleId: { in: [...createdArticleIds] } }, { userId: { in: [...createdUserIds] } }] } }),
      prisma.reaction.count({ where: { OR: [{ articleId: { in: [...createdArticleIds] } }, { userId: { in: [...createdUserIds] } }] } }),
      prisma.bookmark.count({ where: { OR: [{ articleId: { in: [...createdArticleIds] } }, { userId: { in: [...createdUserIds] } }] } }),
      prisma.emailQueue.count({ where: { templateName: 'comment_alert', subject: { contains: stamp } } }),
      orphanCount(),
    ]);
    const residue = users + articles + comments + reactions + bookmarks + queued + orphans;
    const residueName = `Dev-DB hygiene: 0 p06-e2e residue after teardown (got ${residue}; orphans ${orphans})`;
    results.push({ name: residueName, ok: residue === 0 });
    console.log(`${residue === 0 ? 'PASS' : 'FAIL'}  ${residueName}`);

    if (gsBefore) {
      const restored = await prisma.globalStats.findFirst({ select: { commentsCount: true, pendingCommentsCount: true } });
      const restoredOk =
        restored?.commentsCount === gsBefore.commentsCount &&
        restored?.pendingCommentsCount === gsBefore.pendingCommentsCount;
      const restoreName = `Dev-DB hygiene: globalStats commentsCount/pendingCommentsCount restored to pre-run baseline (got ${restored?.commentsCount ?? 'null'}/${restored?.pendingCommentsCount ?? 'null'})`;
      results.push({ name: restoreName, ok: restoredOk });
      console.log(`${restoredOk ? 'PASS' : 'FAIL'}  ${restoreName}`);
    }

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
