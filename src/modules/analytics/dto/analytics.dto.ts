import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Request DTOs for the Phase 07 analytics surface.
 *
 * Identity is **never** a request field: the attributed subject resolves only
 * from the verified token `sub` via `@OptionalAuth()` (DEV-030 analytics half),
 * or is `null` for an anonymous caller. Any body/query carrying a caller-supplied
 * identity selector is a **400** via the global
 * `ValidationPipe({ whitelist, forbidNonWhitelisted })` — deleted, not ignored
 * (ADR-010, `analytics.ts:13,81`). `ipAddress` is likewise never a body field —
 * it is derived server-side from the validated first `x-forwarded-for` hop
 * (DEV-024).
 *
 * The allowed fields below are analytics data, not identity: `visitorId` is a
 * client-stored pseudonymous UUID (`crypto.randomUUID()`), the
 * `visitorTracking.trackingCode`. It names no account and authorizes nothing.
 */

/** Bound for `url` and `referrer` — the frozen column widths. */
export const URL_MAX_LENGTH = 2048;
export const REFERRER_MAX_LENGTH = 2048;
/** Bound for `device` / `browser` / `os`. The frozen mutation had none. */
export const USER_AGENT_FIELD_MAX_LENGTH = 100;
/** Upper bound for a single heartbeat, in seconds. */
export const HEARTBEAT_MAX_SECONDS = 3600;

/** The frozen `days` clamp ceiling (`analytics.ts:133`, `rollup`/`purge` window). */
export const ANALYTICS_MAX_DAYS = 90;

/** Mirrors the frozen `getRawVisits.type` union (`analytics.ts:379`). */
export const RAW_VISIT_TYPES = ['all', 'visit', 'article', 'reaction'] as const;
export type RawVisitTypeValue = (typeof RAW_VISIT_TYPES)[number];

/** Bounded page size for `getRawVisits` (replaces Convex `paginationOpts`). */
export const RAW_VISITS_MAX_LIMIT = 100;
export const RAW_VISITS_DEFAULT_LIMIT = 20;

/** `geoLocation` — client-supplied analytics data, never an authorization input. */
export class GeoLocationDto {
  @ApiPropertyOptional({ maxLength: USER_AGENT_FIELD_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(USER_AGENT_FIELD_MAX_LENGTH)
  country?: string;

  @ApiPropertyOptional({ maxLength: USER_AGENT_FIELD_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(USER_AGENT_FIELD_MAX_LENGTH)
  city?: string;
}

/** `logPageVisit` (`analytics.ts:10-75`). No identity, no IP. */
export class LogPageVisitDto {
  @ApiProperty({ format: 'uuid', description: 'Visitor tracking code (client UUID).' })
  @IsUUID()
  visitorId!: string;

  @ApiProperty({ maxLength: URL_MAX_LENGTH })
  @IsString()
  @MaxLength(URL_MAX_LENGTH)
  url!: string;

  @ApiProperty({ maxLength: USER_AGENT_FIELD_MAX_LENGTH })
  @IsString()
  @MaxLength(USER_AGENT_FIELD_MAX_LENGTH)
  device!: string;

  @ApiProperty({ maxLength: USER_AGENT_FIELD_MAX_LENGTH })
  @IsString()
  @MaxLength(USER_AGENT_FIELD_MAX_LENGTH)
  browser!: string;

  @ApiProperty({ maxLength: USER_AGENT_FIELD_MAX_LENGTH })
  @IsString()
  @MaxLength(USER_AGENT_FIELD_MAX_LENGTH)
  os!: string;

  @ApiPropertyOptional({ maxLength: REFERRER_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(REFERRER_MAX_LENGTH)
  referrer?: string;

  @ApiPropertyOptional({ type: GeoLocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GeoLocationDto)
  geoLocation?: GeoLocationDto;
}

/** `logArticleView` (`analytics.ts:77-128`). No identity. */
export class LogArticleViewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  articleId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  visitorId!: string;
}

/** `logHeartbeat` (`analytics.ts:323-352`). No identity. */
export class LogHeartbeatDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  articleId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  visitorId!: string;

  @ApiProperty({ minimum: 0, maximum: HEARTBEAT_MAX_SECONDS })
  @IsInt()
  @Min(0)
  @Max(HEARTBEAT_MAX_SECONDS)
  seconds!: number;
}

/** `days` for the admin traffic/referrer reads. Service clamps to 90. */
export class DaysQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;
}

/**
 * A DTO with no properties: combined with the global `forbidNonWhitelisted`
 * pipe, any query key is a 400 rather than silently read (DEV-029/DEV-030).
 */
export class EmptyQueryDto {}

/** `getRawVisits` (`analytics.ts:375-461`) — keyset pagination, not `paginationOpts`. */
export class RawVisitsQueryDto {
  @ApiPropertyOptional({ enum: RAW_VISIT_TYPES, default: 'all' })
  @IsOptional()
  @IsIn([...RAW_VISIT_TYPES])
  type?: RawVisitTypeValue;

  @ApiPropertyOptional({ minimum: 1, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ maxLength: 512, description: 'Opaque keyset cursor; an invalid value resets to the first page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: RAW_VISITS_MAX_LIMIT, default: RAW_VISITS_DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RAW_VISITS_MAX_LIMIT)
  limit?: number;
}

/**
 * `incrementStats` (`stats.ts:63-99`) — the frozen `update` key set. Maps to
 * columns in the service; values are signed deltas.
 */
export class IncrementStatsUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() totalArticles?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() publishedArticles?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() draftArticles?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() scheduledArticles?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() aiDraftCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() usersCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() commentsCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() pendingCommentsCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() totalViews?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() totalUniqueViews?: number;
}

/** Body of `POST /internal/stats/increment`. */
export class IncrementStatsDto {
  @ApiProperty({ type: IncrementStatsUpdateDto })
  @ValidateNested()
  @Type(() => IncrementStatsUpdateDto)
  update!: IncrementStatsUpdateDto;
}
