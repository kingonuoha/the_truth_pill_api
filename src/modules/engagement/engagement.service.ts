import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { withUniqueRetry } from '../../shared/db/unique-retry';
import {
  EngagementChangedPayload,
  GlobalStatsChangedPayload,
  publishCommentCreated,
  publishEngagementChanged,
  publishGlobalStats,
} from '../stream/stream-publishers';
import {
  ADMIN_COMMENT_INCLUDE,
  PUBLIC_COMMENT_INCLUDE,
  toAdminComment,
  toEngagement,
  toPublicComment,
} from './engagement-projection';
import {
  AddCommentDto,
  CommentStatusValue,
  COMMENT_CONTENT_MAX_LENGTH,
  ToggleBookmarkDto,
  ToggleReactionDto,
} from './dto/engagement.dto';

/** `globalStats` is a singleton keyed by this id (`web/convex/stats.ts`). */
const GLOBAL_STATS_ID = 'global_stats';

/** Frozen `engagement.ts:189` admin-alert recipient fallback. */
const ADMIN_ALERT_FALLBACK = 'admin@thetruthpill.org';
/** Frozen `engagement.ts:196` admin-URL base fallback. */
const ADMIN_URL_FALLBACK = 'https://thetruthpill.org';

/**
 * Interactive-transaction ceiling. The default 5 s abort is too tight on the
 * Neon dev branch, whose scale-to-zero resume can transiently exceed it
 * (P05-SEC-003, carried to Phase 09's keepalive design). Toggles no longer hold
 * an advisory lock, so this is a resume headroom, not lock-wait.
 */
const TOGGLE_TX_TIMEOUT_MS = 15_000;

/**
 * The 8 `web/convex/engagement.ts` behaviours.
 *
 * Every write takes the acting subject as an explicit `sub` argument resolved
 * by the guard — never from a request body or query (DEV-029, ADR-007). Every
 * counter write runs in the **same** `$transaction` as the row it describes
 * (Migration Rule 5, DEV-021/DEV-022), and reaction/bookmark toggles serialize
 * on a transaction-scoped advisory lock so a concurrent same-key pair cannot
 * double-insert or drive a counter negative.
 */
@Injectable()
export class EngagementService {
  constructor(private readonly prisma: PrismaService) {}

  /* ─────────────────────────── public read + viewer state ─────────────────────────── */

  /**
   * `getEngagement` (`engagement.ts:5-68`). Exact 8-key shape. Counts are
   * public; per-viewer state comes from the verified `sub` when present, else
   * null/false (DEV-044 fail-closed; the caller-supplied email selector is deleted —
   * DEV-029). Counts are exact (the frozen `.take(1000)` safety caps are not
   * carried; a capped count under-reports and the caps were arbitrary).
   */
  async getEngagement(articleId: string, sub: string | null) {
    const [grouped, commentsCount, bookmarksCount] = await Promise.all([
      this.prisma.reaction.groupBy({
        by: ['type'],
        where: { articleId },
        _count: { _all: true },
      }),
      this.prisma.comment.count({ where: { articleId, status: 'approved' } }),
      this.prisma.bookmark.count({ where: { articleId } }),
    ]);

    const countOf = (type: 'like' | 'love' | 'insightful'): number =>
      grouped.find((group) => group.type === type)?._count._all ?? 0;

    let userReaction: 'like' | 'love' | 'insightful' | null = null;
    let isBookmarked = false;
    if (sub) {
      const [reaction, bookmark] = await Promise.all([
        this.prisma.reaction.findUnique({
          where: { articleId_userId: { articleId, userId: sub } },
          select: { type: true },
        }),
        this.prisma.bookmark.findUnique({
          where: { userId_articleId: { userId: sub, articleId } },
          select: { id: true },
        }),
      ]);
      userReaction = reaction?.type ?? null;
      isBookmarked = bookmark !== null;
    }

    return toEngagement({
      likeCount: countOf('like'),
      loveCount: countOf('love'),
      insightfulCount: countOf('insightful'),
      commentsCount,
      bookmarksCount,
      userReaction,
      isBookmarked,
    });
  }

  /* ─────────────────────────── auth-owner toggles ─────────────────────────── */

  /**
   * `toggleReaction` (`engagement.ts:70-121`). None → insert; same type →
   * delete; different type → patch the type. `articles.reactionsCount` stays
   * exactly `count(reactions)` for the article in the same `$transaction`
   * (DEV-021). The `(articleId, userId)` unique key is the concurrency control:
   * a racing insert fails fast with P2002 and is retried, so there is no double
   * insert and no negative counter.
   */
  async toggleReaction(
    sub: string,
    dto: ToggleReactionDto,
  ): Promise<{ active: boolean; type: 'like' | 'love' | 'insightful' | null }> {
    await this.assertArticleExists(dto.articleId);

    const result = await withUniqueRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.reaction.findUnique({
          where: { articleId_userId: { articleId: dto.articleId, userId: sub } },
          select: { id: true, type: true },
        });

        if (existing) {
          if (existing.type === dto.type) {
            const removed = await tx.reaction.deleteMany({
              where: { articleId: dto.articleId, userId: sub },
            });
            // Only this transaction's own removal moves the counter; a racing
            // delete already decremented it (keeps the cache in step).
            if (removed.count > 0) await decrementArticleReactionCount(tx, dto.articleId);
            return { active: false, type: null };
          }
          await tx.reaction.updateMany({
            where: { articleId: dto.articleId, userId: sub },
            data: { type: dto.type },
          });
          return { active: true, type: dto.type };
        }

        await tx.reaction.create({
          data: {
            articleId: dto.articleId,
            userId: sub,
            type: dto.type,
            createdAt: new Date(),
          },
        });
        await incrementArticleReactionCount(tx, dto.articleId);
        return { active: true, type: dto.type };
      }, { timeout: TOGGLE_TX_TIMEOUT_MS }),
    );

    await this.publishEngagement(dto.articleId);
    return result;
  }

  /**
   * `toggleBookmark` (`engagement.ts:123-154`). Returns the frozen boolean
   * (`true` = now bookmarked). Upsert/delete on the unique `(userId, articleId)`;
   * a racing insert fails fast with P2002 and is retried. Shares the `bookmarks`
   * table + key with the Phase 05 `GET /articles/bookmarked-articles` read — no
   * shape divergence (DoD #7).
   */
  async toggleBookmark(sub: string, dto: ToggleBookmarkDto): Promise<boolean> {
    await this.assertArticleExists(dto.articleId);

    const active = await withUniqueRetry(() =>
      this.prisma.$transaction(async (tx) => {
        const existing = await tx.bookmark.findUnique({
          where: { userId_articleId: { userId: sub, articleId: dto.articleId } },
          select: { id: true },
        });
        if (existing) {
          await tx.bookmark.deleteMany({
            where: { userId: sub, articleId: dto.articleId },
          });
          return false;
        }
        await tx.bookmark.create({
          data: { userId: sub, articleId: dto.articleId, createdAt: new Date() },
        });
        return true;
      }, { timeout: TOGGLE_TX_TIMEOUT_MS }),
    );

    await this.publishEngagement(dto.articleId);
    return active;
  }

  /**
   * `addComment` (`engagement.ts:156-205`). Commenter = `sub`; `content`
   * validated (non-empty, bounded → **422** naming the field); an optional
   * `parentId` must resolve to a comment on the **same** article, else **422**
   * naming `parentId` (DEV-043). Inserts the comment **and**
   * `globalStats.commentsCount + 1` in one `$transaction` (DEV-022), plus the
   * frozen `comment_alert` `emailQueue` row (the consumer is Phase 08; Phase 06
   * writes the row for parity only).
   */
  async addComment(sub: string, dto: AddCommentDto): Promise<{ id: string }> {
    const errors: string[] = [];
    if (dto.content.trim().length === 0) {
      errors.push('content: must be a non-empty string');
    }
    if (dto.content.length > COMMENT_CONTENT_MAX_LENGTH) {
      errors.push(`content: must be ${COMMENT_CONTENT_MAX_LENGTH} characters or fewer`);
    }
    if (errors.length > 0) {
      throw new UnprocessableEntityException({ message: errors });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const article = await tx.article.findUnique({
        where: { id: dto.articleId },
        select: { id: true, title: true },
      });
      if (!article) throw new NotFoundException('Article not found');

      if (dto.parentId) {
        const parent = await tx.comment.findUnique({
          where: { id: dto.parentId },
          select: { articleId: true },
        });
        if (!parent || parent.articleId !== dto.articleId) {
          throw new UnprocessableEntityException({
            message: ['parentId: does not reference a comment on this article'],
          });
        }
      }

      const commenter = await tx.user.findUnique({
        where: { id: sub },
        select: { name: true, profileImage: true },
      });

      const now = new Date();
      const comment = await tx.comment.create({
        data: {
          articleId: dto.articleId,
          userId: sub,
          parentId: dto.parentId ?? null,
          content: dto.content,
          status: 'approved',
          createdAt: now,
        },
        select: {
          id: true,
          parentId: true,
          content: true,
          status: true,
          createdAt: true,
        },
      });

      // DEV-022: derived counter, written atomically with the row it describes.
      await bumpGlobalStats(tx, { commentsCount: 1 });

      // Frozen `engagement.ts:187-201`. Recipient/content are never logged.
      const articleTitle = article.title || 'Unknown Article';
      await tx.emailQueue.create({
        data: {
          recipient: process.env.ADMIN_EMAIL || ADMIN_ALERT_FALLBACK,
          subject: `New comment on: ${articleTitle}`,
          templateName: 'comment_alert',
          templateData: {
            commenterName: commenter?.name ?? 'Unknown',
            articleTitle,
            commentContent: dto.content,
            adminUrl: `${process.env.NEXT_PUBLIC_SITE_URL || ADMIN_URL_FALLBACK}/admin/comments`,
          },
          status: 'pending',
          scheduledFor: now,
          retries: 0,
        },
      });

      return {
        id: comment.id,
        parentId: comment.parentId,
        content: comment.content,
        status: comment.status,
        createdAt: comment.createdAt.toISOString(),
        authorName: commenter?.name ?? 'Unknown',
        authorImage: commenter?.profileImage ?? null,
      };
    });

    // DEV-034: the public author card only — never a user document.
    publishCommentCreated(dto.articleId, { articleId: dto.articleId, comment: created });
    await this.publishEngagement(dto.articleId);
    return { id: created.id };
  }

  /* ─────────────────────────── public + admin reads ─────────────────────────── */

  /**
   * `listComments` (`engagement.ts:207-228`). Public: approved only,
   * `createdAt DESC`, capped at 1000 (frozen safety cap). Each item carries the
   * public author card only — never a user document (DEV-034).
   */
  async listComments(articleId: string) {
    const rows = await this.prisma.comment.findMany({
      where: { articleId, status: 'approved' },
      include: PUBLIC_COMMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    return rows.map(toPublicComment);
  }

  /**
   * `listAllComments` (`engagement.ts:229-247`). **Admin** (frozen was public —
   * DEV-042). Moderation view adds `articleTitle` / `articleSlug`; still no
   * user secret.
   */
  async listAllComments() {
    const rows = await this.prisma.comment.findMany({
      include: ADMIN_COMMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toAdminComment);
  }

  /* ─────────────────────────── admin moderation ─────────────────────────── */

  /**
   * `updateCommentStatus` (`engagement.ts:249-288`). **Admin** (DEV-042).
   * Applies the `pendingCommentsCount` ±1 delta **only when the status actually
   * changes**, in the same `$transaction` (DEV-022).
   */
  async updateCommentStatus(
    id: string,
    status: CommentStatusValue,
  ): Promise<{ success: true }> {
    const transitioned = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.comment.findUnique({
        where: { id },
        select: { status: true, articleId: true },
      });
      if (!existing) throw new NotFoundException('Comment not found');
      if (existing.status === status) return null;

      // P06-SEC-001: the delta must be conditional on THIS transaction actually
      // performing the transition. A plain read-then-write lets two concurrent
      // callers each observe the same old status and each apply a delta, so the
      // counter moves twice for one transition. The conditional updateMany — on
      // the status we observed — is the concurrency control: the first writer
      // changes the row (count 1); a racing writer's predicate no longer
      // matches (count 0) and it applies nothing.
      const changed = await tx.comment.updateMany({
        where: { id, status: existing.status },
        data: { status },
      });
      if (changed.count === 0) return null;

      let pendingDelta = 0;
      if (existing.status === 'pending') pendingDelta -= 1;
      if (status === 'pending') pendingDelta += 1;
      if (pendingDelta !== 0) {
        await bumpGlobalStats(tx, { pendingCommentsCount: pendingDelta });
      }
      return existing.articleId;
    });

    if (transitioned) await this.publishEngagement(transitioned);
    return { success: true };
  }

  /**
   * `deleteComment` (`engagement.ts:290-302`). **Admin** (frozen was an
   * unauthenticated destructive delete — DEV-042). The `comments.parentId`
   * self-reference cascades; the reply subtree is enumerated explicitly
   * (recursive CTE) so `globalStats.commentsCount` is decremented by the exact
   * number of removed rows — the frozen code -1'd while orphaning replies
   * (DEV-043). Idempotent on an absent id.
   */
  async deleteComment(id: string): Promise<{ success: true }> {
    const deletedFrom = await this.prisma.$transaction(async (tx) => {
      const root = await tx.comment.findUnique({
        where: { id },
        select: { articleId: true },
      });
      if (!root) return null;

      const rows = await tx.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE subtree AS (
          SELECT "id" FROM "comments" WHERE "id" = ${id}::uuid
          UNION ALL
          SELECT child."id" FROM "comments" child
          JOIN subtree parent ON child."parentId" = parent."id"
        )
        SELECT "id" FROM subtree`;

      if (rows.length === 0) return null;
      // P06-SEC-001: decrement by the COUNT the delete actually removed, never
      // the pre-read CTE snapshot. The CTE `rows` is a read that can race a
      // concurrent delete; `removed.count` is the committed effect of THIS
      // transaction, so the counter cannot double-decrement.
      const removed = await tx.comment.deleteMany({
        where: { id: { in: rows.map((row) => row.id) } },
      });
      if (removed.count > 0) {
        await bumpGlobalStats(tx, { commentsCount: -removed.count });
      }
      return root.articleId;
    });

    if (deletedFrom) await this.publishEngagement(deletedFrom);
    return { success: true };
  }

  /* ─────────────────────────── shared helpers ─────────────────────────── */

  private async assertArticleExists(articleId: string): Promise<void> {
    const found = await this.prisma.article.findUnique({
      where: { id: articleId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Article not found');
  }

  /**
   * Read the narrow `engagement.changed` projection and publish it on
   * `engagement:{id}`. Counters only — no document, no user record (DEV-007 /
   * DEV-034).
   */
  private async publishEngagement(articleId: string): Promise<void> {
    const [grouped, commentsCount, bookmarksCount] = await Promise.all([
      this.prisma.reaction.groupBy({
        by: ['type'],
        where: { articleId },
        _count: { _all: true },
      }),
      this.prisma.comment.count({ where: { articleId, status: 'approved' } }),
      this.prisma.bookmark.count({ where: { articleId } }),
    ]);
    const countOf = (type: 'like' | 'love' | 'insightful'): number =>
      grouped.find((group) => group.type === type)?._count._all ?? 0;
    const likeCount = countOf('like');
    const loveCount = countOf('love');
    const insightfulCount = countOf('insightful');
    const payload: EngagementChangedPayload = {
      articleId,
      likeCount,
      loveCount,
      insightfulCount,
      totalReactions: likeCount + loveCount + insightfulCount,
      commentsCount,
      bookmarksCount,
    };
    publishEngagementChanged(articleId, payload);
  }
}

/* ─────────────────────────── atomic counter helpers ─────────────────────────── */

/**
 * `reactionsCount` is nullable (`Article.reactionsCount Int?`), so an atomic
 * `+1`/`-1` must `COALESCE`; the decrement also clamps at 0 so a counter can
 * never go negative even against pre-existing drift.
 */
async function incrementArticleReactionCount(
  tx: Prisma.TransactionClient,
  articleId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "articles"
    SET "reactionsCount" = COALESCE("reactionsCount", 0) + 1
    WHERE "id" = ${articleId}::uuid`;
}

async function decrementArticleReactionCount(
  tx: Prisma.TransactionClient,
  articleId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "articles"
    SET "reactionsCount" = GREATEST(0, COALESCE("reactionsCount", 0) - 1)
    WHERE "id" = ${articleId}::uuid`;
}

/**
 * `globalStats` is a derived cache (DEV-022). Every touch is an atomic
 * increment inside the caller's `$transaction` — never a read-then-write.
 *
 * Phase 07 intersection: the future `POST /internal/stats/increment` and
 * `POST /internal/stats/recompute` endpoints MUST reuse this counter discipline
 * (atomic delta, same transaction as the row it describes) — not fork it.
 */
async function bumpGlobalStats(
  tx: Prisma.TransactionClient,
  delta: { commentsCount?: number; pendingCommentsCount?: number },
): Promise<void> {
  const commentsCount = delta.commentsCount ?? 0;
  const pendingCommentsCount = delta.pendingCommentsCount ?? 0;
  if (commentsCount === 0 && pendingCommentsCount === 0) return;

  const row = await tx.globalStats.upsert({
    where: { id: GLOBAL_STATS_ID },
    update: {
      ...(commentsCount !== 0 && { commentsCount: { increment: commentsCount } }),
      ...(pendingCommentsCount !== 0 && {
        pendingCommentsCount: { increment: pendingCommentsCount },
      }),
    },
    create: {
      id: GLOBAL_STATS_ID,
      commentsCount: Math.max(0, commentsCount),
      pendingCommentsCount: Math.max(0, pendingCommentsCount),
    },
  });

  // Absolute-value summary frame on `admin:globalStats` (DEV-022 / DEV-055).
  const payload: GlobalStatsChangedPayload = {
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
  publishGlobalStats(payload);
}
