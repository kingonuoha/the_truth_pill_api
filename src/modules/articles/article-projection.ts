/**
 * Response projections for the articles surface (§10, DEV-034 class).
 *
 * Rules enforced here structurally:
 * - A joined author is NEVER a user document — only `authorName` +
 *   `authorImage` are spread, exactly as the frozen queries projected
 *   (`web/convex/articles.ts:100-102` and siblings). No `email`, `role`,
 *   `password`, `resetToken`, `confirmationToken` field can appear because
 *   the mappers read from an explicit column set, never a row spread of
 *   `users`.
 * - `searchVector` (an `Unsupported` column) is never selected.
 * - `id` replaces Convex's `_id` (the Phase 03/04 convention; the users
 *   module established it). Every SEO-bearing field keeps its exact name:
 *   `slug`, `metaTitle`, `metaDescription`, `excerpt`, `coverImage`,
 *   `coverImageAlt`, `publishedAt`, `updatedAt`, `topics`, `tags`,
 *   `categoryName`, `categorySlug`, `pillar`.
 */
import type { Article, Category, User } from '../../generated/prisma/client';

/** Minimal author join shape — the only author columns any read may touch. */
export interface AuthorRef {
  name: string;
  profileImage: string | null;
}

export interface CategoryRef {
  name: string;
  slug: string;
}

type ArticleWithRefs = Article & {
  author: AuthorRef | null;
  category: CategoryRef | null;
};

/** Epoch-free date rendering: ISO-8601 strings (Phase 04 convention). */
function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

const AUTHOR_FALLBACK = 'Unknown Author';
const CATEGORY_FALLBACK = 'Uncategorized';

/** The per-item projection of `list` (`articles.ts:89-103`). */
export function toArticleListItem(a: ArticleWithRefs) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    excerpt: a.excerpt,
    coverImage: a.coverImage,
    publishedAt: iso(a.publishedAt),
    createdAt: a.createdAt.toISOString(),
    viewCount: a.viewCount,
    authorId: a.authorId,
    categoryId: a.categoryId,
    authorName: a.author?.name || AUTHOR_FALLBACK,
    authorImage: a.author?.profileImage ?? null,
    categoryName: a.category?.name || CATEGORY_FALLBACK,
  };
}

/** The per-item projection of `listRecent` (`articles.ts:132-144`). */
export function toRecentListItem(a: ArticleWithRefs) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    excerpt: a.excerpt,
    coverImage: a.coverImage,
    publishedAt: iso(a.publishedAt),
    updatedAt: a.updatedAt.toISOString(),
    authorName: a.author?.name || AUTHOR_FALLBACK,
    authorImage: a.author?.profileImage ?? null,
    categoryName: a.category?.name || CATEGORY_FALLBACK,
    viewCount: a.viewCount,
  };
}

/** The per-item projection of `listByTag` (`articles.ts:168-181`) — recent + tags. */
export function toTagListItem(a: ArticleWithRefs) {
  return { ...toRecentListItem(a), tags: a.tags };
}

/** The per-item projection of `getFeatured` / `getByCategory` (`articles.ts:235-245, 276-287`). */
export function toFeaturedListItem(a: ArticleWithRefs) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    excerpt: a.excerpt,
    coverImage: a.coverImage,
    publishedAt: iso(a.publishedAt),
    authorName: a.author?.name || AUTHOR_FALLBACK,
    authorImage: a.author?.profileImage ?? null,
    categoryName: a.category?.name || CATEGORY_FALLBACK,
    viewCount: a.viewCount,
  };
}

/** Full article record + author/category augmentation (getBySlug, getByAuthor, bookmarked, admin rows). */
export function toArticleDetail(a: ArticleWithRefs) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    excerpt: a.excerpt,
    content: a.content,
    coverImage: a.coverImage,
    coverImageAlt: a.coverImageAlt,
    authorId: a.authorId,
    categoryId: a.categoryId,
    pillar: a.pillar,
    topics: a.topics,
    tags: a.tags,
    type: a.type,
    status: a.status,
    source: a.source,
    scheduledFor: iso(a.scheduledFor),
    publishedAt: iso(a.publishedAt),
    viewCount: a.viewCount,
    uniqueViewCount: a.uniqueViewCount,
    reactionsCount: a.reactionsCount,
    readingTime: a.readingTime,
    actualReadingTime: a.actualReadingTime,
    metaTitle: a.metaTitle,
    metaDescription: a.metaDescription,
    focusKeyword: a.focusKeyword,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    isFeatured: a.isFeatured,
    isArchived: a.isArchived,
    authorName: a.author?.name || AUTHOR_FALLBACK,
    authorImage: a.author?.profileImage ?? null,
    categoryName: a.category?.name || CATEGORY_FALLBACK,
    categorySlug: a.category?.slug ?? null,
  };
}

/** Bare article record without joins (`getById`, admin single-row views). */
export function toArticleRecord(a: Article) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    excerpt: a.excerpt,
    content: a.content,
    coverImage: a.coverImage,
    coverImageAlt: a.coverImageAlt,
    authorId: a.authorId,
    categoryId: a.categoryId,
    pillar: a.pillar,
    topics: a.topics,
    tags: a.tags,
    type: a.type,
    status: a.status,
    source: a.source,
    scheduledFor: iso(a.scheduledFor),
    publishedAt: iso(a.publishedAt),
    viewCount: a.viewCount,
    uniqueViewCount: a.uniqueViewCount,
    reactionsCount: a.reactionsCount,
    readingTime: a.readingTime,
    actualReadingTime: a.actualReadingTime,
    metaTitle: a.metaTitle,
    metaDescription: a.metaDescription,
    focusKeyword: a.focusKeyword,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    isFeatured: a.isFeatured,
    isArchived: a.isArchived,
  };
}

/** `search` result item (`articles.ts:397-409`). */
export function toSearchResult(a: ArticleWithRefs, pillarName: string | null) {
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    excerpt: a.excerpt,
    coverImage: a.coverImage,
    publishedAt: iso(a.publishedAt),
    categoryName: a.category?.name || 'Unknown',
    pillarName,
    authorName: a.author?.name || AUTHOR_FALLBACK,
    authorImage: a.author?.profileImage ?? null,
    viewCount: a.viewCount,
  };
}

/** The user column set every articles read selects for the author join. */
export const AUTHOR_SELECT_FIELDS = { name: true, profileImage: true } as const satisfies Record<string, boolean>;

/** The category column set every articles read selects for the category join. */
export const CATEGORY_SELECT_FIELDS = { name: true, slug: true } as const satisfies Record<string, boolean>;

/** Shared `include` for the two safe joins. Never `users: true` wholesale. */
export const ARTICLE_INCLUDE = {
  author: { select: AUTHOR_SELECT_FIELDS },
  category: { select: CATEGORY_SELECT_FIELDS },
} as const;

export type { Article, Category, User };
