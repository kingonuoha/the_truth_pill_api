import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

/** Activity item of the frozen `admin.getRecentActivity` (`admin.ts:48-94`). */
interface ActivityItem {
  id: string;
  type: 'comment' | 'signup' | 'article';
  content: string;
  timestamp: string;
  articleId?: string;
  userId?: string;
}

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `getDashboardStats` (`admin.ts:12-43`): reads the derived `globalStats`
   * cache row — never a full-table scan. `totalReach` stays 0 exactly as the
   * frozen code returns it (visitorTracking has no counter yet).
   */
  async getDashboardStats() {
    const stats = await this.prisma.globalStats.findFirst();
    if (!stats) {
      return {
        articles: { total: 0, published: 0, draft: 0, scheduled: 0, aiDrafts: 0 },
        usersCount: 0,
        totalViews: 0,
        totalUniqueViews: 0,
        totalReach: 0,
        pendingCommentsCount: 0,
      };
    }
    return {
      articles: {
        total: stats.articleCount,
        published: stats.publishedArticleCount,
        draft: stats.draftArticleCount,
        scheduled: stats.scheduledArticleCount,
        aiDrafts: stats.aiDraftCount,
      },
      usersCount: stats.usersCount,
      totalViews: stats.totalViews,
      totalUniqueViews: stats.totalUniqueViews,
      totalReach: 0,
      pendingCommentsCount: stats.pendingCommentsCount,
    };
  }

  /** `getRecentActivity` (`admin.ts:48-94`). Projected: names only, never user documents. */
  async getRecentActivity(limit = 10): Promise<ActivityItem[]> {
    const [comments, users, articles] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, createdAt: true, articleId: true, userId: true },
      }),
      this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, name: true, createdAt: true },
      }),
      this.prisma.article.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, title: true, source: true, createdAt: true },
      }),
    ]);

    const activities: ActivityItem[] = [
      ...comments.map((c) => ({
        id: c.id,
        type: 'comment' as const,
        content: 'New comment on article',
        timestamp: c.createdAt.toISOString(),
        articleId: c.articleId,
        userId: c.userId,
      })),
      ...users.map((u) => ({
        id: u.id,
        type: 'signup' as const,
        content: `New user: ${u.name}`,
        timestamp: u.createdAt.toISOString(),
      })),
      ...articles.map((a) => ({
        id: a.id,
        type: 'article' as const,
        content: `${a.source === 'ai' ? 'AI' : 'Human'} drafted: ${a.title}`,
        timestamp: a.createdAt.toISOString(),
      })),
    ];

    return activities
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  /**
   * `adminDedupeArticles` (`admin.ts:102-167`), internal/worker-only, wrapped
   * in a transaction-scoped advisory lock so two workers cannot interleave.
   * For every published slug group the winner is the highest `viewCount`
   * (tie: longer content); children are REPOINTED then the loser is deleted in
   * the same `$transaction` (DEV-025 class). The Phase 02 schema puts a real
   * UNIQUE on `articles.slug`, so a well-behaved database yields `[]` — this
   * is the defensive repair path, idempotent by construction (second run is a
   * no-op). Unique-key collisions between winner and loser (reactions
   * `(articleId,userId)`, bookmarks `(userId,articleId)`, articleViews
   * `(articleId,visitorId)`) are dropped from the loser first — the frozen
   * code would have crashed on them instead.
   */
  async adminDedupeArticles(): Promise<{ dedupedSlugs: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('p05_admin_dedupe_articles'))`;

      const published = await tx.article.findMany({
        where: { status: 'published' },
        select: {
          id: true,
          slug: true,
          viewCount: true,
          uniqueViewCount: true,
          reactionsCount: true,
          content: true,
        },
        orderBy: { slug: 'asc' },
      });

      const bySlug = new Map<string, typeof published>();
      for (const a of published) {
        const list = bySlug.get(a.slug) ?? [];
        list.push(a);
        bySlug.set(a.slug, list);
      }

      const dedupedSlugs: string[] = [];
      for (const [slug, docs] of bySlug) {
        if (docs.length < 2) continue;
        docs.sort((a, b) => {
          const viewDiff = b.viewCount - a.viewCount;
          if (viewDiff !== 0) return viewDiff;
          return (b.content?.length ?? 0) - (a.content?.length ?? 0);
        });

        const keep = docs[0];
        for (const dup of docs.slice(1)) {
          await this.repointChildren(tx, keep.id, dup.id);
          const loser = await tx.article.findUnique({
            where: { id: dup.id },
            select: { viewCount: true, uniqueViewCount: true, reactionsCount: true },
          });
          await tx.article.update({
            where: { id: keep.id },
            data: {
              viewCount: keep.viewCount + (loser?.viewCount ?? 0),
              uniqueViewCount: keep.uniqueViewCount + (loser?.uniqueViewCount ?? 0),
              ...(keep.reactionsCount !== null || loser?.reactionsCount != null
                ? {
                    reactionsCount:
                      (keep.reactionsCount ?? 0) + (loser?.reactionsCount ?? 0),
                  }
                : {}),
            },
          });
          keep.viewCount += loser?.viewCount ?? 0;
          keep.uniqueViewCount += loser?.uniqueViewCount ?? 0;
          await tx.article.delete({ where: { id: dup.id } });
        }
        dedupedSlugs.push(slug);
      }
      return { dedupedSlugs };
    });
  }

  /** Repoint views/reactions/comments/bookmarks, dropping winner-side unique-key collisions first. */
  private async repointChildren(
    tx: Prisma.TransactionClient,
    keepId: string,
    dupId: string,
  ): Promise<void> {
    const [keepViewers, keepReactors, keepBookmarkUsers] = await Promise.all([
      tx.articleView.findMany({ where: { articleId: keepId }, select: { visitorId: true } }),
      tx.reaction.findMany({ where: { articleId: keepId }, select: { userId: true } }),
      tx.bookmark.findMany({ where: { articleId: keepId }, select: { userId: true } }),
    ]);

    await tx.articleView.deleteMany({
      where: { articleId: dupId, visitorId: { in: keepViewers.map((r) => r.visitorId) } },
    });
    await tx.reaction.deleteMany({
      where: { articleId: dupId, userId: { in: keepReactors.map((r) => r.userId) } },
    });
    await tx.bookmark.deleteMany({
      where: { articleId: dupId, userId: { in: keepBookmarkUsers.map((r) => r.userId) } },
    });

    await Promise.all([
      tx.articleView.updateMany({ where: { articleId: dupId }, data: { articleId: keepId } }),
      tx.reaction.updateMany({ where: { articleId: dupId }, data: { articleId: keepId } }),
      tx.bookmark.updateMany({ where: { articleId: dupId }, data: { articleId: keepId } }),
      tx.comment.updateMany({ where: { articleId: dupId }, data: { articleId: keepId } }),
    ]);
  }
}
