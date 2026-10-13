/**
 * Response projections for the engagement surface (Phase 06, DEV-034 class).
 *
 * Structural rules enforced here:
 * - A joined author is **never** a user document. Only `name` + `profileImage`
 *   are selected and only `authorName` / `authorImage` are emitted — the frozen
 *   quirk's `web/convex/engagement.ts:217-226` projection, hardened so no
 *   `email` / `role` / `password` / token column can appear (DEV-034).
 * - Every column is read from an explicit `select` set; a `users` row is never
 *   spread (`grep 'users: true'` must be 0).
 * - `userId` on a public comment is a **bare UUID reference** — the same Phase
 *   05 rule that permits a bare `authorId` on public article lists. It is not a
 *   selector and cannot be used to read or write another user's rows
 *   (`engagement-guard-matrix.md` §2.1).
 * - Dates are ISO-8601 strings (the Phase 04/05 convention).
 */
import { Prisma } from '../../generated/prisma/client';
import type { AdminCommentDto, CommentDto, EngagementDto } from './dto/engagement-responses.dto';

/** Minimal author join shape — the only `users` columns any read may touch. */
export const COMMENT_AUTHOR_SELECT = {
  name: true,
  profileImage: true,
} as const satisfies Prisma.UserSelect;

/** Minimal article join shape for the moderation view. */
export const COMMENT_ARTICLE_SELECT = {
  title: true,
  slug: true,
} as const satisfies Prisma.ArticleSelect;

/** The public `listComments` join. Never `users: true` wholesale. */
export const PUBLIC_COMMENT_INCLUDE = {
  user: { select: COMMENT_AUTHOR_SELECT },
} as const satisfies Prisma.CommentInclude;

/** The admin `listAllComments` join — author card + article context, still no secret. */
export const ADMIN_COMMENT_INCLUDE = {
  user: { select: COMMENT_AUTHOR_SELECT },
  article: { select: COMMENT_ARTICLE_SELECT },
} as const satisfies Prisma.CommentInclude;

export type PublicCommentRow = Prisma.CommentGetPayload<{
  include: typeof PUBLIC_COMMENT_INCLUDE;
}>;

export type AdminCommentRow = Prisma.CommentGetPayload<{
  include: typeof ADMIN_COMMENT_INCLUDE;
}>;

/** Frozen author-name fallback (`engagement.ts:222`). */
const AUTHOR_FALLBACK = 'Unknown';
/** Frozen article-title fallback for the moderation view (`engagement.ts:241`). */
const ARTICLE_FALLBACK = 'Deleted Article';

/** The exact 8-key `getEngagement` payload (`engagement.ts:57-66`). */
export function toEngagement(input: {
  likeCount: number;
  loveCount: number;
  insightfulCount: number;
  commentsCount: number;
  bookmarksCount: number;
  userReaction: EngagementDto['userReaction'];
  isBookmarked: boolean;
}): EngagementDto {
  return {
    likeCount: input.likeCount,
    loveCount: input.loveCount,
    insightfulCount: input.insightfulCount,
    totalReactions: input.likeCount + input.loveCount + input.insightfulCount,
    commentsCount: input.commentsCount,
    bookmarksCount: input.bookmarksCount,
    userReaction: input.userReaction,
    isBookmarked: input.isBookmarked,
  };
}

/** Public comment item — frozen fields + the public author card only. */
export function toPublicComment(row: PublicCommentRow): CommentDto {
  return {
    id: row.id,
    articleId: row.articleId,
    userId: row.userId,
    parentId: row.parentId,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    authorName: row.user?.name || AUTHOR_FALLBACK,
    authorImage: row.user?.profileImage ?? null,
  };
}

/** Moderation item — public shape + `articleTitle` / `articleSlug`, still no user secret. */
export function toAdminComment(row: AdminCommentRow): AdminCommentDto {
  return {
    ...toPublicComment(row),
    articleTitle: row.article?.title || ARTICLE_FALLBACK,
    articleSlug: row.article?.slug ?? null,
  };
}
