import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt } from 'node:crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { paginate, Paginated } from '../../shared/types/paginated';
import { PublicAuthorCard, toPublicAuthorCard } from '../users/user-projection';
import {
  GlobalStatsChangedPayload,
  publishArticleStatus,
  publishDraftStatus,
  publishGlobalStats,
} from '../stream/stream-publishers';
import {
  ARTICLE_INCLUDE,
  toArticleDetail,
  toArticleListItem,
  toArticleRecord,
  toFeaturedListItem,
  toRecentListItem,
  toSearchResult,
  toTagListItem,
} from './article-projection';
import {
  normalizeSearchText,
  rankSearchResults,
  scoreSearchArticle,
  tokenizeSearchQuery,
} from './article-search.scorer';
import {
  ByTagQueryDto,
  CreateArticleDto,
  FeaturedArticlesQueryDto,
  LimitQueryDto,
  ListAdminArticlesQueryDto,
  ListArticlesQueryDto,
  RecentArticlesQueryDto,
  SaveAIDraftDto,
  SearchArticlesQueryDto,
  TopPostTagsQueryDto,
  UpdateArticleDto,
} from './dto/articles.dto';

const GLOBAL_STATS_ID = 'global_stats';

/** `getByCategory` / `getFeatured` shape shared with the list-family reads. */
type ArticleListItem = ReturnType<typeof toArticleListItem>;

/**
 * Frozen `listByTag`/`getPopularTopics`/`getAllTopics`/`getTopPostTags` carried
 * unordered `.take(N)` truncations on the single-field `by_status` index
 * (same no-op class as the `search` `.take(300)`, §7.2 / DEV-008). The
 * replacement reads are candidate-bounded by `publishedAt DESC NULLS LAST`
 * instead of an arbitrary index window. Pending orchestrator DEV row (reported
 * in the Phase 05 completion notes).
 */
const LEGACY_READ_CAPS = {
  tagScan: 500,
  topicsSample: 100,
  corpusSample: 500,
  topTagsSample: 200,
} as const;

/** The stats delta shape mirrored from the frozen `internal.stats.incrementStats` payloads. */
interface StatsDelta {
  articleCount?: number;
  publishedArticleCount?: number;
  draftArticleCount?: number;
  scheduledArticleCount?: number;
  aiDraftCount?: number;
}

@Injectable()
export class ArticlesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /* ───────────────────────────── public reads ───────────────────────────── */

  /** `list` (`articles.ts:42-109`): published, `isArchived IS NOT TRUE`, newest first. */
  async list(q: ListArticlesQueryDto): Promise<Paginated<ArticleListItem>> {
    const where: Prisma.ArticleWhereInput = {
      status: 'published',
      OR: [{ isArchived: false }, { isArchived: null }],
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.pillar ? { pillar: q.pillar } : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.article.count({ where }),
      this.prisma.article.findMany({
        where,
        include: ARTICLE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return paginate(rows.map(toArticleListItem), total, q.page, q.pageSize);
  }

  /** `listRecent` (`articles.ts:115-148`): hard cap 100 ported verbatim. */
  async listRecent(q: RecentArticlesQueryDto): Promise<ReturnType<typeof toRecentListItem>[]> {
    const limit = Math.min(q.limit ?? 20, 100);
    const rows = await this.prisma.article.findMany({
      where: { status: 'published', OR: [{ isArchived: false }, { isArchived: null }] },
      include: ARTICLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toRecentListItem);
  }

  /** `listByTag` (`articles.ts:150-185`): Postgres array filter replaces the scan. */
  async listByTag(q: ByTagQueryDto): Promise<ReturnType<typeof toTagListItem>[]> {
    const rows = await this.prisma.article.findMany({
      where: {
        status: 'published',
        OR: [{ isArchived: false }, { isArchived: null }],
        tags: { has: q.tag },
      },
      include: ARTICLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: LEGACY_READ_CAPS.tagScan,
    });
    return rows.map(toTagListItem);
  }

  /**
   * `getBySlug` (`articles.ts:187-211`). The frozen query returned `null` for
   * a non-published/archived/absent slug; the REST equivalent is 404.
   */
  async getBySlug(slug: string) {
    const article = await this.prisma.article.findFirst({
      where: { slug, status: 'published', OR: [{ isArchived: false }, { isArchived: null }] },
      include: ARTICLE_INCLUDE,
    });
    if (!article) throw new NotFoundException('Article not found');
    return toArticleDetail(article);
  }

  /** `getFeatured` (`articles.ts:213-249`). */
  async getFeatured(q: FeaturedArticlesQueryDto): Promise<ReturnType<typeof toFeaturedListItem>[]> {
    const rows = await this.prisma.article.findMany({
      where: {
        status: 'published',
        isFeatured: true,
        OR: [{ isArchived: false }, { isArchived: null }],
      },
      include: ARTICLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 5,
    });
    return rows.map(toFeaturedListItem);
  }

  /** `getByCategory` (`articles.ts:251-291`). Unknown slug → `[]` (frozen semantics). */
  async getByCategory(categorySlug: string, limit?: number): Promise<ReturnType<typeof toFeaturedListItem>[]> {
    const category = await this.prisma.category.findUnique({
      where: { slug: categorySlug },
      select: { id: true, name: true },
    });
    if (!category) return [];

    const rows = await this.prisma.article.findMany({
      where: {
        categoryId: category.id,
        status: 'published',
        OR: [{ isArchived: false }, { isArchived: null }],
      },
      include: {
        author: { select: { name: true, profileImage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit ?? 100, 200),
    });
    return rows.map((row) =>
      toFeaturedListItem({
        ...row,
        category: { name: category.name, slug: categorySlug },
      }),
    );
  }

  /**
   * `search` (`articles.ts:293-412`) — the frozen weighted scorer ported
   * verbatim (DEV-008), NOT a Postgres relevance ranker. Candidate set: published,
   * `isArchived IS NOT TRUE`, `publishedAt DESC NULLS LAST` — the arbitrary
   * `.take(300)` window is dropped per §7.2's recommendation (registered with
   * the orchestrator alongside DEV-008).
   */
  async search(q: SearchArticlesQueryDto) {
    const nQuery = normalizeSearchText(q.query ?? '');
    if (!nQuery) return [];
    const slugifiedQuery = nQuery.replace(/\s+/g, '-');
    const tokens = tokenizeSearchQuery(nQuery);

    const [articles, categories, pillars] = await this.prisma.$transaction([
      this.prisma.article.findMany({
        where: { status: 'published', OR: [{ isArchived: false }, { isArchived: null }] },
        include: ARTICLE_INCLUDE,
        orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
      }),
      this.prisma.category.findMany({
        select: { id: true, name: true, slug: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
      this.prisma.pillar.findMany({
        select: { slug: true, name: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
    ]);

    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const pillarMap = new Map(pillars.map((p) => [p.slug, p]));

    const scored = articles.map((a) => {
      const category = a.categoryId ? categoryMap.get(a.categoryId) : null;
      const pillar = a.pillar ? pillarMap.get(a.pillar) : null;
      const score = scoreSearchArticle(a, {
        nQuery,
        slugifiedQuery,
        tokens,
        nCategoryName: normalizeSearchText(category?.name),
        nPillarName: normalizeSearchText(pillar?.name),
      });
      return { article: a, score, viewCount: a.viewCount, id: a.id, pillarName: pillar?.name ?? null };
    });

    return rankSearchResults(scored).map(({ article, pillarName }) =>
      toSearchResult(article, pillarName),
    );
  }

  /** `getPopularTopics` (`articles.ts:414-434`): count topics over the sample, most-used first. */
  async getPopularTopics(q: LimitQueryDto): Promise<string[]> {
    const rows = await this.prisma.article.findMany({
      where: { status: 'published' },
      select: { topics: true },
      orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
      take: LEGACY_READ_CAPS.topicsSample,
    });
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const topic of row.topics) {
        counts.set(topic, (counts.get(topic) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, q.limit ?? 20)
      .map(([topic]) => topic);
  }

  /** `getAllTopics` (`articles.ts:438-453`). */
  async getAllTopics(): Promise<string[]> {
    const rows = await this.prisma.article.findMany({
      where: { status: 'published' },
      select: { topics: true },
      orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
      take: LEGACY_READ_CAPS.corpusSample,
    });
    const set = new Set<string>();
    for (const row of rows) for (const topic of row.topics) set.add(topic);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** `getAllTags` (`articles.ts:455-469`). */
  async getAllTags(): Promise<string[]> {
    const rows = await this.prisma.article.findMany({
      where: { status: 'published' },
      select: { tags: true },
      orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
      take: LEGACY_READ_CAPS.corpusSample,
    });
    const set = new Set<string>();
    for (const row of rows) for (const tag of row.tags) set.add(tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** `getTopPostTags` (`articles.ts:471-489`): tags of the 2 most-viewed sampled posts. */
  async getTopPostTags(q: TopPostTagsQueryDto): Promise<string[]> {
    const rows = await this.prisma.article.findMany({
      where: { status: 'published', OR: [{ isArchived: false }, { isArchived: null }] },
      select: { viewCount: true, tags: true, id: true },
      orderBy: { publishedAt: { sort: 'desc', nulls: 'last' } },
      take: LEGACY_READ_CAPS.topTagsSample,
    });
    const top = [...rows]
      .sort((a, b) => b.viewCount - a.viewCount || (a.id < b.id ? -1 : 1))
      .slice(0, 2);
    const set = new Set<string>();
    for (const row of top) for (const tag of row.tags) set.add(tag);
    return [...set].slice(0, q.limit ?? 5);
  }

  /** `getById` (`articles.ts:490-497`). Frozen consumers: only the admin edit page. */
  async getById(id: string) {
    const article = await this.prisma.article.findUnique({ where: { id } });
    if (!article) throw new NotFoundException('Article not found');
    return toArticleRecord(article);
  }

  /**
   * `getByAuthor` (`articles.ts:1313-1335`). **DEV-041:** the frozen query
   * filtered only `status == published` and never `isArchived`, so soft-deleted
   * articles surfaced publicly on the author page while vanishing from every
   * other public list. Closed here with the same NULL-safe predicate the
   * sibling reads use (Prisma `NOT:{isArchived:true}` drops NULLs —
   * `NOT(NULL = true)` is unknown — so the explicit `false OR null` form is
   * mandatory to keep `IS NOT TRUE` semantics).
   */
  async getByAuthor(authorId: string, limit?: number) {
    const rows = await this.prisma.article.findMany({
      where: {
        authorId,
        status: 'published',
        OR: [{ isArchived: false }, { isArchived: null }],
      },
      include: ARTICLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit ?? 50, 100),
    });
    return rows.map(toArticleDetail);
  }

  /**
   * `getBookmarkedArticles` (`articles.ts:1337-1377`). The frozen `email`
   * argument (`:1338`) is DELETED — the subject comes from the verified token
   * `sub` only (DEV-029, DEV-031: no `identity || argument` fallback).
   */
  async getBookmarkedArticles(sub: string) {
    const bookmarks = await this.prisma.bookmark.findMany({
      where: { userId: sub },
      select: { articleId: true },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    if (bookmarks.length === 0) return [];
    const rows = await this.prisma.article.findMany({
      where: { id: { in: bookmarks.map((b) => b.articleId) } },
      include: ARTICLE_INCLUDE,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return bookmarks
      .map((b) => byId.get(b.articleId))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map(toArticleDetail);
  }

  /** `listAuthors` (`articles.ts:1195-1203`): S-014 fix — public author cards, never user documents. */
  async listAuthors(): Promise<PublicAuthorCard[]> {
    const users = await this.prisma.user.findMany({
      where: { role: 'admin' },
      select: { id: true, name: true, profileImage: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return users.map(toPublicAuthorCard);
  }

  /* ───────────────────────────── admin browse ───────────────────────────── */

  /**
   * `listAdmin` (`articles.ts:1092-1193`). The search branch replaces Convex's
   * `search_title` search index with the `searchVector` GIN (§7.1); no
   * a relevance-rank function anywhere. `isArchived` uses three-valued-safe predicates:
   * `IS TRUE` for archived, `IS NOT TRUE` for the default (NULLs are live rows).
   */
  async listAdmin(q: ListAdminArticlesQueryDto): Promise<Paginated<ReturnType<typeof toArticleDetail>>> {
    const archivedWhere =
      q.isArchived === 'true'
        ? { isArchived: true }
        : { OR: [{ isArchived: false }, { isArchived: null }] };

    if (q.search) {
      const ids: { id: string }[] = await this.prisma.$queryRaw`
        SELECT "id" FROM "articles"
        WHERE "searchVector" @@ plainto_tsquery('english', ${q.search})
          ${q.status && q.status !== 'all' ? Prisma.sql`AND "status" = ${q.status}::"ArticleStatus"` : Prisma.empty}
          ${q.categoryId ? Prisma.sql`AND "categoryId" = ${q.categoryId}::uuid` : Prisma.empty}
          ${q.isArchived === 'true' ? Prisma.sql`AND "isArchived" IS TRUE` : Prisma.sql`AND "isArchived" IS NOT TRUE`}
        ORDER BY "publishedAt" DESC NULLS LAST, "id" DESC` as { id: string }[];

      const total = ids.length;
      const page = ids.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      const rows = await this.prisma.article.findMany({
        where: { id: { in: page.map((r) => r.id) } },
        include: ARTICLE_INCLUDE,
      });
      const order = new Map(page.map((r, i) => [r.id, i]));
      const items = rows
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map(toArticleDetail);
      return paginate(items, total, q.page, q.pageSize);
    }

    const where: Prisma.ArticleWhereInput = {
      ...archivedWhere,
      ...(q.status && q.status !== 'all' ? { status: q.status } : {}),
      ...(q.source && q.source !== 'all' ? { source: q.source } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.article.count({ where }),
      this.prisma.article.findMany({
        where,
        include: ARTICLE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return paginate(rows.map(toArticleDetail), total, q.page, q.pageSize);
  }

  /* ───────────────────────────── admin writes ───────────────────────────── */

  /**
   * `create` (`articles.ts:499-633`). The client-supplied admin-email and `authorId` are deleted from the
   * DTO (DEV-029/030/031); author attribution = the verified `sub`.
   */
  async create(sub: string, dto: CreateArticleDto) {
    const rules = collectPublishRules(toPublishInput(dto), 'create');
    await this.assertRefsExist(dto.categoryId, dto.pillar);
    if (rules.length > 0) {
      if (dto.status !== 'draft') throw new UnprocessableEntityException({ message: rules });
    }

    const now = new Date();
    const article = await this.prisma.$transaction(async (tx) => {
      const slugTaken = await tx.article.findUnique({
        where: { slug: dto.slug },
        select: { id: true },
      });
      if (slugTaken) throw new ConflictException('Slug already exists');

      const created = await tx.article.create({
        data: {
          title: dto.title,
          slug: dto.slug,
          excerpt: dto.excerpt,
          content: dto.content,
          coverImage: dto.coverImage,
          coverImageAlt: dto.coverImageAlt,
          categoryId: dto.categoryId,
          pillar: dto.pillar,
          topics: dto.topics ?? [],
          tags: dto.tags ?? [],
          type: dto.type,
          status: dto.status,
          source: dto.source,
          scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null,
          isFeatured: dto.isFeatured,
          metaTitle: dto.metaTitle,
          metaDescription: dto.metaDescription,
          focusKeyword: dto.focusKeyword,
          isArchived: false,
          authorId: sub,
          viewCount: 0,
          uniqueViewCount: 0,
          readingTime: Math.ceil((dto.content || '').length / 1300),
          createdAt: now,
          updatedAt: now,
          publishedAt: dto.status === 'published' ? now : null,
        },
      });

      await applyStatsDelta(tx, statusCounts(dto.status, dto.source, 'add'));
      if (dto.categoryId) {
        await tx.category.update({
          where: { id: dto.categoryId },
          data: { articleCount: { increment: 1 } },
        });
      }
      if (dto.status === 'published') {
        await this.enqueueAlerts(tx, created.id);
      }
      publishArticleLifecycle(created);
      return created;
    });

    return this.getByIdWithRefs(article.id);
  }

  /**
   * `update` (`articles.ts:635-801`). DEV-011: an invalid `categoryId` or
   * `pillar` is a **422 naming the field** and the row is left UNTOUCHED —
   * the frozen code silently persisted the bad reference instead.
   */
  async update(sub: string, dto: UpdateArticleDto) {
    void sub; // attribution is never rewritten through update (DEV-030: authorId is not a request field)
    const { id, ...fields } = dto;
    await this.assertRefsExist(fields.categoryId, fields.pillar);

    const existing = await this.prisma.article.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Article not found');

    const merged = toPublishInput({ ...existing, ...fields }, existing);
    const finalStatus = fields.status ?? existing.status;
    if (finalStatus !== 'draft') {
      const rules = collectPublishRules(merged, 'update');
      if (rules.length > 0) throw new UnprocessableEntityException({ message: rules });
    }

    await this.prisma.$transaction(async (tx) => {
      if (fields.slug && fields.slug !== existing.slug) {
        const conflict = await tx.article.findFirst({
          where: { slug: fields.slug, NOT: { id } },
          select: { id: true },
        });
        if (conflict) throw new ConflictException('Slug already exists');
      }

      const now = new Date();
      const publishingNow =
        fields.status === 'published' && existing.status !== 'published';

      await tx.article.update({
        where: { id },
        data: {
          ...(fields.title !== undefined && { title: fields.title }),
          ...(fields.slug !== undefined && { slug: fields.slug }),
          ...(fields.excerpt !== undefined && { excerpt: fields.excerpt }),
          ...(fields.content !== undefined && {
            content: fields.content,
            readingTime: Math.ceil(fields.content.length / 1300),
          }),
          ...(fields.coverImage !== undefined && { coverImage: fields.coverImage }),
          ...(fields.coverImageAlt !== undefined && { coverImageAlt: fields.coverImageAlt }),
          ...(fields.categoryId !== undefined && { categoryId: fields.categoryId }),
          ...(fields.pillar !== undefined && { pillar: fields.pillar }),
          ...(fields.topics !== undefined && { topics: fields.topics }),
          ...(fields.tags !== undefined && { tags: fields.tags }),
          ...(fields.type !== undefined && { type: fields.type }),
          ...(fields.status !== undefined && { status: fields.status }),
          ...(fields.source !== undefined && { source: fields.source }),
          ...(fields.scheduledFor !== undefined && {
            scheduledFor: fields.scheduledFor ? new Date(fields.scheduledFor) : null,
          }),
          ...(fields.isFeatured !== undefined && { isFeatured: fields.isFeatured }),
          ...(fields.metaTitle !== undefined && { metaTitle: fields.metaTitle }),
          ...(fields.metaDescription !== undefined && { metaDescription: fields.metaDescription }),
          ...(fields.focusKeyword !== undefined && { focusKeyword: fields.focusKeyword }),
          ...(publishingNow && { publishedAt: now }),
          updatedAt: now,
        },
      });

      if (fields.status && fields.status !== existing.status) {
        await applyStatsDelta(tx, statusChangeDelta(existing.status, existing.source, fields.status));
      }

      if (fields.categoryId && fields.categoryId !== existing.categoryId) {
        if (existing.categoryId) await clampCategoryDecrement(tx, existing.categoryId);
        await tx.category.update({
          where: { id: fields.categoryId },
          data: { articleCount: { increment: 1 } },
        });
      }

      if (publishingNow) await this.enqueueAlerts(tx, id);

      publishArticleLifecycle({
        id,
        status: finalStatus,
        title: fields.title ?? existing.title,
        publishedAt: publishingNow ? now : existing.publishedAt,
      });
    });

    return this.getByIdWithRefs(id);
  }

  /** `remove` (`articles.ts:840-870`): soft-delete (archive), silently a no-op when absent/archived. */
  async remove(id: string): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const article = await tx.article.findUnique({ where: { id } });
      if (!article || article.isArchived) return;
      await tx.article.update({ where: { id }, data: { isArchived: true } });
      await applyStatsDelta(tx, statusCounts(article.status, article.source, 'remove'));
      if (article.categoryId) await clampCategoryDecrement(tx, article.categoryId);
    });
    return { success: true };
  }

  /** `restore` (`articles.ts:872-901`). */
  async restore(id: string): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const article = await tx.article.findUnique({ where: { id } });
      if (!article || !article.isArchived) return;
      await tx.article.update({ where: { id }, data: { isArchived: false } });
      await applyStatsDelta(tx, statusCounts(article.status, article.source, 'add'));
      if (article.categoryId) {
        await tx.category.update({
          where: { id: article.categoryId },
          data: { articleCount: { increment: 1 } },
        });
      }
    });
    return { success: true };
  }

  /**
   * `deleteForever` (`articles.ts:903-932`). DEV-025: child rows
   * (comments/reactions/bookmarks/articleViews) disappear via schema-level
   * `ON DELETE CASCADE` — the frozen delete left them dangling.
   */
  async deleteForever(id: string): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const article = await tx.article.findUnique({ where: { id } });
      if (!article) return;
      await tx.article.delete({ where: { id } });
      await applyStatsDelta(tx, statusCounts(article.status, article.source, 'remove'));
      if (article.categoryId && !article.isArchived) {
        await clampCategoryDecrement(tx, article.categoryId);
      }
    });
    return { success: true };
  }

  /** `bulkArchive` (`articles.ts:934-982`). */
  bulkArchive(ids: string[]): Promise<{ success: true }> {
    return this.bulkTransition(ids, 'archive');
  }

  /** `bulkRestore` (`articles.ts:984-1032`). */
  bulkRestore(ids: string[]): Promise<{ success: true }> {
    return this.bulkTransition(ids, 'restore');
  }

  /** `bulkDeleteForever` (`articles.ts:1034-1083`). */
  async bulkDeleteForever(ids: string[]): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const articles = await tx.article.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, source: true, categoryId: true, isArchived: true },
      });
      if (articles.length === 0) return;
      const delta: StatsDelta = { articleCount: -articles.length };
      const categoryUpdates = new Map<string, number>();
      for (const a of articles) {
        bump(delta, a.status, a.source, 'remove');
        if (a.categoryId && !a.isArchived) {
          categoryUpdates.set(a.categoryId, (categoryUpdates.get(a.categoryId) ?? 0) + 1);
        }
      }
      await tx.article.deleteMany({ where: { id: { in: articles.map((a) => a.id) } } });
      await applyStatsDelta(tx, delta);
      for (const [catId, count] of categoryUpdates) {
        await clampCategoryDecrement(tx, catId, count);
      }
    });
    return { success: true };
  }

  private async bulkTransition(ids: string[], mode: 'archive' | 'restore'): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const articles = await tx.article.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true, source: true, categoryId: true, isArchived: true },
      });
      const targets = articles.filter((a) =>
        mode === 'archive' ? !a.isArchived : a.isArchived === true,
      );
      if (targets.length === 0) return;
      const delta: StatsDelta = {};
      const categoryUpdates = new Map<string, number>();
      for (const a of targets) {
        bump(delta, a.status, a.source, mode === 'archive' ? 'remove' : 'add');
        if (a.categoryId) {
          categoryUpdates.set(a.categoryId, (categoryUpdates.get(a.categoryId) ?? 0) + (mode === 'archive' ? -1 : 1));
        }
      }
      delta.articleCount =
        (delta.articleCount ?? 0) + (mode === 'archive' ? -targets.length : targets.length);
      await tx.article.updateMany({
        where: { id: { in: targets.map((a) => a.id) } },
        data: { isArchived: mode === 'archive' },
      });
      await applyStatsDelta(tx, delta);
      for (const [catId, count] of categoryUpdates) {
        if (count < 0) await clampCategoryDecrement(tx, catId, -count);
        else if (count > 0)
          await tx.category.update({
            where: { id: catId },
            data: { articleCount: { increment: count } },
          });
      }
    });
    return { success: true };
  }

  /** `toggleFeatured` (`articles.ts:1085-1090`). */
  async toggleFeatured(id: string, isFeatured: boolean): Promise<{ success: true }> {
    const result = await this.prisma.article.updateMany({ where: { id }, data: { isFeatured } });
    if (result.count === 0) throw new NotFoundException('Article not found');
    return { success: true };
  }

  /* ───────────────────────────── internal fan-outs ───────────────────────── */

  /**
   * `publishScheduledArticles` (`articles.ts:7-39`). Idempotent: a re-run
   * finds no `scheduled` rows left, publishes nothing, and queues no second
   * alert wave (the alert insert itself is deduplicated by recipient+subject).
   */
  async publishScheduled(): Promise<{ publishedCount: number }> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.article.findMany({
        where: { status: 'scheduled', scheduledFor: { lte: now } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (due.length === 0) return { publishedCount: 0 };
      await tx.article.updateMany({
        where: { id: { in: due.map((a) => a.id) } },
        data: { status: 'published', publishedAt: now },
      });
      await applyStatsDelta(tx, {
        publishedArticleCount: due.length,
        scheduledArticleCount: -due.length,
      });
      for (const article of due) await this.enqueueAlerts(tx, article.id);
      for (const article of due) {
        publishArticleStatus(article.id, {
          articleId: article.id,
          status: 'published',
          publishedAt: now.toISOString(),
        });
      }
      return { publishedCount: due.length };
    });
  }

  /**
   * `queueNewArticleAlerts` (`articles.ts:803-838`). Idempotent: subscribers
   * already holding a pending `New Insight: <title>` row are skipped, so a
   * second call inserts 0 duplicates.
   */
  async queueAlerts(articleId: string): Promise<{ queued: number }> {
    return this.prisma.$transaction(async (tx) => {
      const article = await tx.article.findUnique({ where: { id: articleId } });
      if (!article || article.status !== 'published') return { queued: 0 };
      return { queued: await this.enqueueAlerts(tx, articleId) };
    });
  }

  /**
   * `saveAIDraft` (`articles.ts:1205-1312`) as `PUT /internal/ai-drafts/{id}`.
   * The path id is the idempotency key: the slug suffix is derived from it
   * (frozen used `Math.random()`), so a re-run returns the existing draft.
   */
  async saveAIDraft(
    key: string,
    dto: SaveAIDraftDto,
  ): Promise<{ id: string; created: boolean }> {
    await this.assertRefsExist(undefined, dto.pillar);
    const suffix = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 5);
    const slug = `${slugifyTitle(dto.title)}-${suffix}`;

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.article.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };

      const admins = await tx.user.findMany({
        where: { role: 'admin' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      let authorId: string;
      if (admins.length > 0) {
        authorId = admins[randomInt(0, admins.length)].id;
      } else {
        const aiAuthor = await tx.user.upsert({
          where: { email: 'ai@thetruthpill.org' },
          update: {},
          create: {
            name: 'TruthPill AI',
            email: 'ai@thetruthpill.org',
            role: 'admin',
            provider: 'system',
            newsletterSubscribed: false,
            createdAt: new Date(),
          },
          select: { id: true },
        });
        authorId = aiAuthor.id;
      }

      const category = await tx.category.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!category) {
        throw new UnprocessableEntityException({
          message: ['categories: need at least one category to generate drafts'],
        });
      }

      const now = new Date();
      const created = await tx.article.create({
        data: {
          title: dto.title,
          slug,
          excerpt: dto.excerpt,
          content: dto.content,
          pillar: dto.pillar,
          topics: dto.topics ?? [],
          type: dto.type,
          metaTitle: dto.metaTitle,
          metaDescription: dto.metaDescription,
          focusKeyword: dto.focusKeyword,
          isArchived: false,
          coverImage:
            'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&q=80',
          authorId,
          categoryId: category.id,
          status: 'draft',
          source: 'ai',
          viewCount: 0,
          uniqueViewCount: 0,
          readingTime: Math.ceil(dto.content.length / 1300),
          createdAt: now,
          updatedAt: now,
        },
        select: { id: true },
      });

      await applyStatsDelta(tx, { articleCount: 1, draftArticleCount: 1, aiDraftCount: 1 });
      await tx.category.update({
        where: { id: category.id },
        data: { articleCount: { increment: 1 } },
      });
      publishDraftStatus({ id: created.id, status: 'draft', title: dto.title });
      return { id: created.id, created: true };
    });
  }

  /* ───────────────────────────── shared helpers ─────────────────────────── */

  /**
   * DEV-011: a reference that does not resolve is a 422 **naming the field**,
   * raised before any write happens (the frozen code persisted it silently).
   */
  private async assertRefsExist(
    categoryId: string | undefined,
    pillar: string | undefined,
  ): Promise<void> {
    const errors: string[] = [];
    if (categoryId) {
      const found = await this.prisma.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      });
      if (!found) errors.push('categoryId: does not reference an existing category');
    }
    if (pillar) {
      const found = await this.prisma.pillar.findUnique({
        where: { slug: pillar },
        select: { slug: true },
      });
      if (!found) errors.push('pillar: does not reference an existing pillar');
    }
    if (errors.length > 0) throw new UnprocessableEntityException({ message: errors });
  }

  private async getByIdWithRefs(id: string) {
    const article = await this.prisma.article.findUnique({
      where: { id },
      include: ARTICLE_INCLUDE,
    });
    if (!article) throw new NotFoundException('Article not found');
    return toArticleDetail(article);
  }

  /**
   * The `new_article` email-queue fan-out (`articles.ts:803-838`). Queued for
   * draining by the Phase 08 worker; no SMTP is sent here. Deduplication by
   * (recipient, template, subject) makes every caller idempotent.
   */
  private async enqueueAlerts(tx: Prisma.TransactionClient, articleId: string): Promise<number> {
    const article = await tx.article.findUnique({
      where: { id: articleId },
      include: {
        author: { select: { name: true } },
        category: { select: { name: true } },
      },
    });
    if (!article || article.status !== 'published') return 0;

    const subscribers = await tx.user.findMany({
      where: { newsletterSubscribed: true },
      select: { email: true },
    });
    if (subscribers.length === 0) return 0;

    const subject = `New Insight: ${article.title}`;
    const already = await tx.emailQueue.findMany({
      where: {
        recipient: { in: subscribers.map((s) => s.email) },
        templateName: 'new_article',
        subject,
        status: { in: ['pending', 'sending'] },
      },
      select: { recipient: true },
    });
    const queuedSet = new Set(already.map((r) => r.recipient));
    const targets = subscribers.filter((s) => !queuedSet.has(s.email));
    if (targets.length === 0) return 0;

    const siteUrl = this.config.get<string>('SITE_URL') ?? 'https://thetruthpill.org';
    const now = new Date();
    await tx.emailQueue.createMany({
      data: targets.map((s) => ({
        recipient: s.email,
        subject,
        templateName: 'new_article',
        templateData: {
          articleTitle: article.title,
          excerpt: article.excerpt || '',
          articleUrl: `${siteUrl}/${article.slug}`,
          authorName: article.author?.name || 'The Truth Pill',
          categoryName: article.category?.name || 'Psychology',
          unsubscribeUrl: `${siteUrl}/unsubscribe?email=${encodeURIComponent(s.email)}`,
        },
        status: 'pending',
        scheduledFor: now,
        retries: 0,
      })),
    });
    return targets.length;
  }
}

/* ────────────────────────────── publish rules ──────────────────────────── */

interface PublishInput {
  status: string;
  source: string;
  excerpt?: string | null;
  content?: string | null;
  coverImage?: string | null;
  categoryId?: string | null;
  topics?: string[] | null;
  tags?: string[] | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
}

function toPublishInput(
  partial: Partial<CreateArticleDto> | Partial<PublishInput>,
  existing?: { status: string; source: string },
): PublishInput {
  const p = partial as Record<string, unknown>;
  return {
    status: (p.status as string) ?? existing?.status ?? 'draft',
    source: (p.source as string) ?? existing?.source ?? 'human',
    excerpt: p.excerpt as string | null | undefined,
    content: p.content as string | null | undefined,
    coverImage: p.coverImage as string | null | undefined,
    categoryId: p.categoryId as string | null | undefined,
    topics: p.topics as string[] | null | undefined,
    tags: p.tags as string[] | null | undefined,
    metaTitle: p.metaTitle as string | null | undefined,
    metaDescription: p.metaDescription as string | null | undefined,
  };
}

/**
 * The publish-time validation of `articles.ts:535-572` (create) and
 * `:700-741` (update) as explicit rules — never `v.any()`. Every failing rule
 * is reported at once (frozen code threw on the first); each message names the
 * offending field. Returns `[]` when publication is valid.
 */
function collectPublishRules(input: PublishInput, mode: 'create' | 'update'): string[] {
  if (input.status === 'draft') return [];
  const suffix = mode === 'create' ? ' for publishing' : '';
  const errors: string[] = [];
  if (!input.excerpt) errors.push(`excerpt: required${suffix}`);
  if (!input.content) errors.push(`content: required${suffix}`);
  if (!input.coverImage) errors.push(`coverImage: required${suffix}`);
  if (!input.categoryId) errors.push(`categoryId: required${suffix}`);
  if (!input.topics || input.topics.length === 0) errors.push(`topics: required${suffix}`);
  else if (input.topics.length > 1) errors.push('topics: only one topic is allowed per article');
  if (!input.tags || input.tags.length < 4) errors.push(`tags: at least 4 required${suffix}`);
  if (!input.metaTitle) errors.push(`metaTitle: required${suffix}`);
  if (!input.metaDescription) {
    errors.push(`metaDescription: required${suffix}`);
  } else if (input.metaDescription.length > 255) {
    errors.push('metaDescription: must be 255 characters or less');
  }
  const charCount = (input.content || '').length;
  if (input.content && charCount < 800) {
    errors.push(
      `content: too short (${charCount} characters), minimum 800 required for publication`,
    );
  }
  if (input.content && !input.content.includes('<h2')) {
    errors.push('content: at least one H2 subheading is required for SEO structure');
  }
  return errors;
}

/* ────────────────────────────── stats helpers ──────────────────────────── */

/**
 * Convex deferred these counters through a scheduled mutation, which is how
 * they went stale (DEV-021/022). Every counter touch here is an ATOMIC
 * increment inside the same `$transaction` (Migration Rule 5), so the cache
 * cannot drift the way the legacy fan-out did.
 */
function statusCounts(
  status: string,
  source: string,
  mode: 'add' | 'remove',
): StatsDelta {
  const sign = mode === 'add' ? 1 : -1;
  const delta: StatsDelta = { articleCount: sign };
  if (status === 'published') delta.publishedArticleCount = sign;
  if (status === 'draft') delta.draftArticleCount = sign;
  if (status === 'scheduled') delta.scheduledArticleCount = sign;
  if (source === 'ai' && status === 'draft') delta.aiDraftCount = sign;
  return delta;
}

function statusChangeDelta(
  from: string,
  source: string,
  to: string,
): StatsDelta {
  const delta: StatsDelta = {};
  const move = (status: string, sign: number) => {
    if (status === 'published') delta.publishedArticleCount = (delta.publishedArticleCount ?? 0) + sign;
    if (status === 'draft') delta.draftArticleCount = (delta.draftArticleCount ?? 0) + sign;
    if (status === 'scheduled') delta.scheduledArticleCount = (delta.scheduledArticleCount ?? 0) + sign;
  };
  move(from, -1);
  move(to, 1);
  if (source === 'ai') {
    if (to === 'draft' && from !== 'draft') delta.aiDraftCount = 1;
    else if (from === 'draft' && to !== 'draft') delta.aiDraftCount = -1;
  }
  return delta;
}

function bump(delta: StatsDelta, status: string, source: string, mode: 'add' | 'remove'): void {
  const part = statusCounts(status, source, mode);
  delete part.articleCount;
  for (const [key, value] of Object.entries(part)) {
    const k = key as keyof StatsDelta;
    delta[k] = (delta[k] ?? 0) + (value ?? 0);
  }
}

async function applyStatsDelta(tx: Prisma.TransactionClient, delta: StatsDelta): Promise<void> {
  const articleCount = delta.articleCount ?? 0;
  const publishedArticleCount = delta.publishedArticleCount ?? 0;
  const draftArticleCount = delta.draftArticleCount ?? 0;
  const scheduledArticleCount = delta.scheduledArticleCount ?? 0;
  const aiDraftCount = delta.aiDraftCount ?? 0;
  if (
    articleCount === 0 &&
    publishedArticleCount === 0 &&
    draftArticleCount === 0 &&
    scheduledArticleCount === 0 &&
    aiDraftCount === 0
  ) {
    return;
  }
  const row = await tx.globalStats.upsert({
    where: { id: GLOBAL_STATS_ID },
    update: {
      ...(articleCount !== 0 && { articleCount: { increment: articleCount } }),
      ...(publishedArticleCount !== 0 && { publishedArticleCount: { increment: publishedArticleCount } }),
      ...(draftArticleCount !== 0 && { draftArticleCount: { increment: draftArticleCount } }),
      ...(scheduledArticleCount !== 0 && { scheduledArticleCount: { increment: scheduledArticleCount } }),
      ...(aiDraftCount !== 0 && { aiDraftCount: { increment: aiDraftCount } }),
    },
    create: {
      id: GLOBAL_STATS_ID,
      articleCount,
      publishedArticleCount,
      draftArticleCount,
      scheduledArticleCount,
      aiDraftCount,
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

/** Frozen clamps the category counter at 0 (`Math.max(0, …)`) — done atomically in SQL. */
async function clampCategoryDecrement(
  tx: Prisma.TransactionClient,
  categoryId: string,
  by = 1,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "categories"
    SET "articleCount" = GREATEST(0, "articleCount" - ${by}::int)
    WHERE "id" = ${categoryId}::uuid`;
}

/**
 * Publish the narrow article lifecycle frames: `article.status` on the
 * per-article topic, plus `draft.status` on `admin:drafts` for a draft.
 * Identifiers + the changed fields only (DEV-007).
 */
function publishArticleLifecycle(article: {
  id: string;
  status: string;
  title: string;
  publishedAt: Date | null;
}): void {
  publishArticleStatus(article.id, {
    articleId: article.id,
    status: article.status,
    publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
  });
  if (article.status === 'draft') {
    publishDraftStatus({ id: article.id, status: article.status, title: article.title });
  }
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}
