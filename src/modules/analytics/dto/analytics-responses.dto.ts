import { ApiProperty } from '@nestjs/swagger';
import { RAW_VISIT_TYPES } from './analytics.dto';

/**
 * Response schemas for the Phase 07 analytics surface. Plain property classes
 * with explicit `@ApiProperty` types — never `any`, never an empty schema
 * object. Dates are ISO-8601 strings (Phase 04/05 convention), nullable columns
 * are declared `nullable`.
 *
 * Projection rules:
 * - Admin rows may carry counters, `visitorId`, `ipAddress` and a bare
 *   attribution reference (the frozen parity fields the admin analytics UI
 *   renders). They never carry `email`, `role`, `password`, or a token
 *   (DEV-034 class).
 * - The attributed-subject reference is named `userRef` so the request-surface
 *   identity scan can prove the module carries no caller-supplied identity field
 *   (DEV-030). It is write-once attribution, never read from a request.
 * - The `getRawVisits` reaction label is an opaque `User <first8>` handle, never
 *   a user email (DEV-045 / adjudication C).
 */

/** Ingest acknowledgement — the frozen mutations returned void; Nest acks. */
export class AnalyticsSuccessDto {
  @ApiProperty({ example: true }) success: boolean = true;
}

/** Stored geo object (`{country, city}`, either may be null). */
export class GeoLocationResponseDto {
  @ApiProperty({ type: String, nullable: true }) country: string | null = null;
  @ApiProperty({ type: String, nullable: true }) city: string | null = null;
}

/** A stored `pageVisits` row (`getRealTimeActivity`, `getRawVisits` visit branch). */
export class PageVisitDto {
  @ApiProperty() id: string = '';
  @ApiProperty({ format: 'uuid' }) visitorId: string = '';
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Bare attribution reference (write-once) — never caller identity.',
  })
  userRef: string | null = null;
  @ApiProperty({ maxLength: 2048 }) url: string = '';
  @ApiProperty({ maxLength: 45 }) ipAddress: string = '';
  @ApiProperty({ type: GeoLocationResponseDto, nullable: true })
  geoLocation: GeoLocationResponseDto | null = null;
  @ApiProperty() device: string = '';
  @ApiProperty() browser: string = '';
  @ApiProperty() os: string = '';
  @ApiProperty({ type: String, nullable: true }) referrer: string | null = null;
  @ApiProperty({ format: 'date-time' }) timestamp: string = '';
}

/** `getTrafficStats` chart point. */
export class TrafficChartPointDto {
  @ApiProperty({ description: 'YYYY-MM-DD (UTC).' }) date: string = '';
  @ApiProperty() visits: number = 0;
  @ApiProperty() uniqueVisitors: number = 0;
}

/** `getTrafficStats` (`analytics.ts:198-203`). */
export class TrafficStatsDto {
  @ApiProperty({ type: [TrafficChartPointDto] }) chartData: TrafficChartPointDto[] = [];
  @ApiProperty() totalVisits: number = 0;
  @ApiProperty({ description: 'One-decimal percentage string, frozen shape.' }) trend: string = '0.0';
  @ApiProperty() isTrendUp: boolean = true;
}

/** `{name, value}` bucket. */
export class NameValueDto {
  @ApiProperty() name: string = '';
  @ApiProperty() value: number = 0;
}

/** `getReferrerStats` — top-10 `{name, value}[]`. */
export class ReferrerStatDto extends NameValueDto {}

/** `getGeographicStats` — country counts desc. */
export class GeographicStatDto {
  @ApiProperty() country: string = '';
  @ApiProperty() count: number = 0;
}

/** `getDeviceStats` (`analytics.ts:276-287`). */
export class DeviceStatsDto {
  @ApiProperty({ type: [NameValueDto] }) devices: NameValueDto[] = [];
  @ApiProperty({ type: [NameValueDto] }) browsers: NameValueDto[] = [];
  @ApiProperty({ type: [NameValueDto] }) oss: NameValueDto[] = [];
}

/** `getTopContent` item (`analytics.ts:305-316`). */
export class TopContentDto {
  @ApiProperty({ format: 'uuid' }) id: string = '';
  @ApiProperty() title: string = '';
  @ApiProperty() views: number = 0;
  @ApiProperty() uniqueViews: number = 0;
  @ApiProperty() reactions: number = 0;
  @ApiProperty({ description: 'Average seconds per unique view.' }) avgReadTime: number = 0;
  @ApiProperty({ description: 'reactions / uniqueViews * 100.' }) engagementRate: number = 0;
}

/**
 * One `getRawVisits` row. Visit rows carry the stored page-visit fields; reaction
 * rows carry the opaque label and the frozen `---` / `N/A` placeholders. The two
 * shapes are merged into one schema with optional discriminators so the OpenAPI
 * contract has a single typed row ($ref).
 */
export class RawVisitRowDto {
  @ApiProperty() id: string = '';
  @ApiProperty({ format: 'date-time' }) timestamp: string = '';
  @ApiProperty({
    type: String,
    required: false,
    description: 'Present on reaction rows only (`reaction`).',
  })
  type?: string;
  @ApiProperty() url: string = '';
  @ApiProperty({
    description:
      'Visit rows: the visitor tracking UUID. Reaction rows: an opaque `User <first8>` handle — never a user email.',
  })
  visitorId: string = '';
  @ApiProperty({ type: String, nullable: true, required: false })
  userRef?: string | null;
  @ApiProperty() ipAddress: string = '';
  @ApiProperty({ type: GeoLocationResponseDto, nullable: true })
  geoLocation: GeoLocationResponseDto | null = null;
  @ApiProperty() device: string = '';
  @ApiProperty() browser: string = '';
  @ApiProperty() os: string = '';
  @ApiProperty({ type: String, nullable: true, required: false })
  referrer?: string | null;
}

/** Keyset page metadata (README list convention). */
export class RawVisitsPageMetaDto {
  @ApiProperty() limit: number = 0;
  @ApiProperty() hasMore: boolean = false;
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null = null;
}

/** `getRawVisits` envelope: `{ data, page }` (README list convention). */
export class RawVisitsPageDto {
  @ApiProperty({ type: [RawVisitRowDto] }) data: RawVisitRowDto[] = [];
  @ApiProperty({ type: RawVisitsPageMetaDto }) page: RawVisitsPageMetaDto = new RawVisitsPageMetaDto();
}

/**
 * `initGlobalStats` result — the recomputed singleton id (frozen returned the
 * row id).
 */
export class RecomputeStatsDto {
  @ApiProperty() id: string = '';
}

/** `incrementStats` result: `false` when no `globalStats` row exists (no-op). */
export class IncrementStatsResultDto {
  @ApiProperty() success: boolean = true;
}

/** `rollupDailyStats` (`rollup.ts:74-78`). */
export class RollupResultDto {
  @ApiProperty() processed: number = 0;
  @ApiProperty() dates: number = 0;
  @ApiProperty() isDone: boolean = true;
}

/** `purgeOldAnalytics` (`analytics_cleanup.ts:31-34`). */
export class PurgeResultDto {
  @ApiProperty() deletedCount: number = 0;
  @ApiProperty() isDone: boolean = true;
}

/** `backfillIsArchived` (`migrations.ts:19`). */
export class BackfillResultDto {
  @ApiProperty() updated: number = 0;
  @ApiProperty() total: number = 0;
}

/** Re-exported for the controller's enum metadata. */
export { RAW_VISIT_TYPES };
