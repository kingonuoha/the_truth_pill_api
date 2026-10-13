import { ApiProperty, ApiPropertyOptional, PartialType, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../shared/dto/pagination-query.dto';

/** Mirrors the Prisma `ArticleStatus` enum — a `v.any()` is never ported (ADR-010). */
export const ARTICLE_STATUSES = ['draft', 'scheduled', 'published'] as const;
export const ARTICLE_SOURCES = ['human', 'ai'] as const;
export const ARTICLE_TYPES = ['pillar', 'cluster', 'micro', 'insight', 'observant'] as const;

/* ────────────────────────────── public reads ────────────────────────────── */

/** `list` (`articles.ts:42-109`). Convex cursor pagination becomes the D5 page/pageSize convention. */
export class ListArticlesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Filter by category id.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Filter by pillar slug.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  pillar?: string;

  @ApiPropertyOptional({ enum: ARTICLE_TYPES })
  @IsOptional()
  @IsIn(ARTICLE_TYPES)
  type?: (typeof ARTICLE_TYPES)[number];
}

export class RecentArticlesQueryDto {
  @ApiPropertyOptional({ description: 'Items to return (hard cap 100, `articles.ts:123`).', default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class ByTagQueryDto {
  @ApiProperty({ example: 'habits' })
  @IsString()
  @MaxLength(100)
  tag!: string;
}

export class BySlugQueryDto {
  @ApiProperty({ description: 'Public URL segment — preserved byte-for-byte.' })
  @IsString()
  @MaxLength(255)
  slug!: string;
}

export class FeaturedArticlesQueryDto {
  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class ByCategoryArticlesQueryDto {
  @ApiProperty({ description: 'Category slug.' })
  @IsString()
  @MaxLength(255)
  categorySlug!: string;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** `search` (`articles.ts:293`). The param keeps the Convex arg name (`query`). */
export class SearchArticlesQueryDto {
  @ApiPropertyOptional({ description: 'Free-text query. Empty returns [].', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string;
}

export class LimitQueryDto {
  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class TopPostTagsQueryDto {
  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

/**
 * A DTO with no properties: used on routes that must accept NO query string at
 * all. Combined with the global `forbidNonWhitelisted` pipe, a leftover frozen
 * selector such as `?email=` is rejected with 400 rather than silently read
 * (DEV-029).
 */
export class NoQueryDto {}

export class ByAuthorQueryDto {
  @ApiProperty({ description: 'Author (user) id — a content selector, never caller identity.' })
  @IsUUID()
  authorId!: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/* ────────────────────────────── admin browse ────────────────────────────── */

/**
 * `listAdmin` (`articles.ts:1092-1193`). Search runs against the `searchVector`
 * GIN (§7.1); `isArchived` uses `IS NOT TRUE` semantics for the non-archived
 * branch (a NULL row is not archived) — §7.1 warning.
 */
export class ListAdminArticlesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'One of the statuses, or `all`.' })
  @IsOptional()
  @IsIn([...ARTICLE_STATUSES, 'all'])
  status?: (typeof ARTICLE_STATUSES)[number] | 'all';

  @ApiPropertyOptional({ description: 'One of the sources, or `all`.' })
  @IsOptional()
  @IsIn([...ARTICLE_SOURCES, 'all'])
  source?: (typeof ARTICLE_SOURCES)[number] | 'all';

  @ApiPropertyOptional({ description: 'Title full-text search (`searchVector @@ tsquery`).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'true → archived only; false/absent → not archived (NULL counts as not archived).', enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  isArchived?: 'true' | 'false';
}

/* ────────────────────────────── admin writes ────────────────────────────── */

/**
 * `create` (`articles.ts:499-633`). The frozen admin-email (`:531`) and the
 * client-supplied `authorId` (`:532`) are DELETED: identity and attribution
 * come only from the verified token (DEV-029, DEV-030, DEV-031). Sending
 * either is a 400 via the global `forbidNonWhitelisted` pipe.
 */
export class CreateArticleDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  title!: string;

  @ApiProperty({ description: 'Public URL segment. Slug drift 404s live URLs — treated as immutable once published.' })
  @IsString()
  @MaxLength(255)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  excerpt?: string;

  @ApiPropertyOptional({ description: 'Rich text (HTML).' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ description: 'Stored image URL — no vendor call is made here.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  coverImage?: string;

  @ApiPropertyOptional({ description: 'Stored image alt text.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  coverImageAlt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Pillar slug. Must reference an existing pillar (422 otherwise, DEV-023 FK class).' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  pillar?: string;

  @ApiPropertyOptional({ type: [String], description: 'Intended single item (publish rule enforces ≤ 1).' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topics?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Publish rule enforces ≥ 4.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: ARTICLE_TYPES })
  @IsOptional()
  @IsIn(ARTICLE_TYPES)
  type?: (typeof ARTICLE_TYPES)[number];

  @ApiProperty({ enum: ARTICLE_STATUSES })
  @IsIn(ARTICLE_STATUSES)
  status!: (typeof ARTICLE_STATUSES)[number];

  @ApiProperty({ enum: ARTICLE_SOURCES })
  @IsIn(ARTICLE_SOURCES)
  source!: (typeof ARTICLE_SOURCES)[number];

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp (Convex carried epoch millis).' })
  @IsOptional()
  @IsDateString()
  scheduledFor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  metaTitle?: string;

  @ApiPropertyOptional({ description: 'Publish rule enforces ≤ 255 characters.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  metaDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  focusKeyword?: string;
}

/** `update` (`articles.ts:635-801`). `id` moves to the body's required key; identity params stay deleted. */
export class UpdateArticleDto extends PartialType(
  OmitType(CreateArticleDto, ['slug'] as const),
) {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiPropertyOptional({ description: 'Public URL segment. A change colliding with another article is 409 (frozen semantics, `articles.ts:689-698`).' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;
}

export class ArticleIdDto {
  @ApiProperty()
  @IsUUID()
  id!: string;
}

export class BulkArticleIdsDto {
  @ApiProperty({ type: [String], description: 'Article ids. Non-existent / already-in-state ids are skipped (frozen semantics).' })
  @IsArray()
  @IsUUID(undefined, { each: true }) // any version — ids are uuid(7)
  ids!: string[];
}

export class ToggleFeaturedDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiProperty()
  @IsBoolean()
  isFeatured!: boolean;
}

/* ────────────────────────────── internal fan-outs ───────────────────────── */

/** `queueNewArticleAlerts` (`articles.ts:803-838`). */
export class QueueAlertsDto {
  @ApiProperty()
  @IsUUID()
  articleId!: string;
}

/**
 * `saveAIDraft` (`articles.ts:1205-1312`) as `PUT /internal/ai-drafts/{id}` —
 * the path `id` is the caller's idempotency key: the slug suffix is derived
 * from it, so a re-run returns the same draft instead of inserting twice
 * (brief DoD #13).
 */
export class SaveAIDraftDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  title!: string;

  @ApiProperty()
  @IsString()
  content!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(5000)
  excerpt!: string;

  @ApiPropertyOptional({ description: 'Pillar slug (validated against the pillars table, DEV-023 class).' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  pillar?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  topics?: string[];

  @ApiPropertyOptional({ enum: ARTICLE_TYPES })
  @IsOptional()
  @IsIn(ARTICLE_TYPES)
  type?: (typeof ARTICLE_TYPES)[number];

  @ApiProperty({ description: 'Kept for the frozen arg contract; unused by the handler (`articles.ts:1234`).' })
  @IsString()
  @MaxLength(500)
  topic!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  metaTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  metaDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  focusKeyword?: string;
}
