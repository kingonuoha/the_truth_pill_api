/**
 * Response schemas for the articles surface (api-organizer decorator audit,
 * follow-up #2). Plain property classes with explicit `@ApiProperty` types —
 * never `any`, never an empty schema object. Shapes mirror the projection
 * functions in `article-projection.ts`; dates are ISO strings (Phase 04
 * convention), nullable columns are declared `nullable`.
 */
import { ApiProperty } from '@nestjs/swagger';
import { ARTICLE_SOURCES, ARTICLE_STATUSES, ARTICLE_TYPES } from './articles.dto';

/** `toArticleRecord` — the bare document (`GET /articles/by-id`). */
export class ArticleRecordDto {
  @ApiProperty() id: string = '';
  @ApiProperty() title: string = '';
  @ApiProperty({ description: 'Public URL segment — byte-preserved.' }) slug: string = '';
  @ApiProperty({ type: String, nullable: true }) excerpt: string | null = null;
  @ApiProperty({ type: String, nullable: true }) content: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImage: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImageAlt: string | null = null;
  @ApiProperty() authorId: string = '';
  @ApiProperty({ type: String, nullable: true }) categoryId: string | null = null;
  @ApiProperty({ type: String, nullable: true }) pillar: string | null = null;
  @ApiProperty({ type: [String] }) topics: string[] = [];
  @ApiProperty({ type: [String] }) tags: string[] = [];
  @ApiProperty({ enum: ARTICLE_TYPES, type: String, nullable: true }) type: string | null = null;
  @ApiProperty({ enum: ARTICLE_STATUSES }) status: string = '';
  @ApiProperty({ enum: ARTICLE_SOURCES }) source: string = '';
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) scheduledFor: string | null = null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt: string | null = null;
  @ApiProperty() viewCount: number = 0;
  @ApiProperty() uniqueViewCount: number = 0;
  @ApiProperty({ type: Number, nullable: true }) reactionsCount: number | null = null;
  @ApiProperty() readingTime: number = 0;
  @ApiProperty({ type: Number, nullable: true }) actualReadingTime: number | null = null;
  @ApiProperty({ type: String, nullable: true }) metaTitle: string | null = null;
  @ApiProperty({ type: String, nullable: true }) metaDescription: string | null = null;
  @ApiProperty({ type: String, nullable: true }) focusKeyword: string | null = null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: string = '';
  @ApiProperty({ type: Boolean, nullable: true }) isFeatured: boolean | null = null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'NULL counts as not archived (§7.1).' }) isArchived: boolean | null = null;
}

/** `toArticleDetail` — the document plus the §10-safe author/category joins. */
export class ArticleDetailDto extends ArticleRecordDto {
  @ApiProperty({ description: 'Resolved byline name; "Unknown Author" when absent.' }) authorName: string = '';
  @ApiProperty({ type: String, nullable: true }) authorImage: string | null = null;
  @ApiProperty() categoryName: string = '';
  @ApiProperty({ type: String, nullable: true }) categorySlug: string | null = null;
}

/** `Paginated<ArticleDetail>` — the `GET /articles/admin` envelope (D5 shape). */
export class PaginatedArticleDetailDto {
  @ApiProperty({ type: [ArticleDetailDto] }) items: ArticleDetailDto[] = [];
  @ApiProperty() total: number = 0;
  @ApiProperty() page: number = 1;
  @ApiProperty() pageSize: number = 20;
  @ApiProperty() totalPages: number = 0;
}

/** `toArticleListItem` — the `GET /articles` page item (`articles.ts:89-103`). */
export class ArticleListItemDto {
  @ApiProperty() id: string = '';
  @ApiProperty() title: string = '';
  @ApiProperty() slug: string = '';
  @ApiProperty({ type: String, nullable: true }) excerpt: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImage: string | null = null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt: string | null = null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt: string = '';
  @ApiProperty() viewCount: number = 0;
  @ApiProperty() authorId: string = '';
  @ApiProperty({ type: String, nullable: true }) categoryId: string | null = null;
  @ApiProperty() authorName: string = '';
  @ApiProperty({ type: String, nullable: true }) authorImage: string | null = null;
  @ApiProperty() categoryName: string = '';
}

/** `Paginated<ArticleListItem>` — the `GET /articles` envelope. */
export class PaginatedArticleListItemDto {
  @ApiProperty({ type: [ArticleListItemDto] }) items: ArticleListItemDto[] = [];
  @ApiProperty() total: number = 0;
  @ApiProperty() page: number = 1;
  @ApiProperty() pageSize: number = 20;
  @ApiProperty() totalPages: number = 0;
}

/** `toFeaturedListItem` — `getFeatured` / `getByCategory` item. */
export class FeaturedListItemDto {
  @ApiProperty() id: string = '';
  @ApiProperty() title: string = '';
  @ApiProperty() slug: string = '';
  @ApiProperty({ type: String, nullable: true }) excerpt: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImage: string | null = null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt: string | null = null;
  @ApiProperty() authorName: string = '';
  @ApiProperty({ type: String, nullable: true }) authorImage: string | null = null;
  @ApiProperty() categoryName: string = '';
  @ApiProperty() viewCount: number = 0;
}

/** `toRecentListItem` — `listRecent` item (featured + updatedAt). */
export class RecentListItemDto extends FeaturedListItemDto {
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt: string = '';
}

/** `toTagListItem` — `listByTag` item (recent + tags). */
export class TagListItemDto extends RecentListItemDto {
  @ApiProperty({ type: [String] }) tags: string[] = [];
}

/** `toSearchResult` — one of the top-8 ranked hits (DEV-008 scorer output). */
export class SearchResultDto {
  @ApiProperty() id: string = '';
  @ApiProperty() title: string = '';
  @ApiProperty() slug: string = '';
  @ApiProperty({ type: String, nullable: true }) excerpt: string | null = null;
  @ApiProperty({ type: String, nullable: true }) coverImage: string | null = null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt: string | null = null;
  @ApiProperty({ description: 'Resolved category name; "Unknown" when unresolved (frozen fallback).' }) categoryName: string = '';
  @ApiProperty({ type: String, nullable: true, description: 'Resolved pillar name; null when the slug matches no pillar.' }) pillarName: string | null = null;
  @ApiProperty() authorName: string = '';
  @ApiProperty({ type: String, nullable: true }) authorImage: string | null = null;
  @ApiProperty() viewCount: number = 0;
}

/** Public author card (`GET /articles/authors`) — S-014's §10 shape: exactly these three keys. */
export class AuthorCardResponseDto {
  @ApiProperty() id: string = '';
  @ApiProperty() name: string = '';
  @ApiProperty({ type: String, nullable: true }) profileImage: string | null = null;
}

/** Void-mutation acknowledgement (remove/restore/bulk family/toggle-featured, category/pillar/quote removes). */
export class SuccessDto {
  @ApiProperty({ example: true }) success: boolean = true;
}

/** `POST /internal/articles/publish-scheduled` result. */
export class PublishScheduledResultDto {
  @ApiProperty({ description: 'Articles flipped from scheduled to published by this call (0 on a re-run).' })
  publishedCount: number = 0;
}

/** `POST /internal/articles/queue-alerts` result. */
export class QueueAlertsResultDto {
  @ApiProperty({ description: 'New queue rows inserted (0 when every subscriber already holds one — idempotent).' })
  queued: number = 0;
}

/** `PUT /internal/ai-drafts/{id}` result — `created:false` marks an idempotent replay. */
export class AiDraftResultDto {
  @ApiProperty() id: string = '';
  @ApiProperty({ description: 'false when the key was already stored (replay returned the existing draft).' })
  created: boolean = false;
}
