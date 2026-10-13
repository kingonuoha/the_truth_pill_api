import { ApiProperty } from '@nestjs/swagger';

/** The derived-counter block of `getDashboardStats` (`admin.ts:12-43`). */
export class ArticleCountersDto {
  @ApiProperty() total: number = 0;
  @ApiProperty() published: number = 0;
  @ApiProperty() draft: number = 0;
  @ApiProperty() scheduled: number = 0;
  @ApiProperty() aiDrafts: number = 0;
}

/** `GET /admin/dashboard-stats` — reads only the derived `globalStats` row. */
export class DashboardStatsDto {
  @ApiProperty({ type: ArticleCountersDto }) articles: ArticleCountersDto = new ArticleCountersDto();
  @ApiProperty() usersCount: number = 0;
  @ApiProperty({ description: 'Signed-off cache value; never recomputed per-request.' }) totalViews: number = 0;
  @ApiProperty() totalUniqueViews: number = 0;
  @ApiProperty({ description: 'Stays 0 in the frozen contract (no visitor counter yet).' }) totalReach: number = 0;
  @ApiProperty() pendingCommentsCount: number = 0;
}

/** `GET /admin/recent-activity` item — projected; names only, never user documents. */
export class ActivityItemDto {
  @ApiProperty() id: string = '';
  @ApiProperty({ enum: ['comment', 'signup', 'article'] }) type: string = '';
  @ApiProperty() content: string = '';
  @ApiProperty({ type: String, format: 'date-time' }) timestamp: string = '';
  @ApiProperty({ type: String, nullable: true, required: false }) articleId?: string;
  @ApiProperty({ type: String, nullable: true, required: false }) userId?: string;
}

/** `POST /internal/admin/admin-dedupe-articles` result. */
export class DedupeResultDto {
  @ApiProperty({ type: [String], description: 'Slugs collapsed by this run; [] on a clean (unique-slug) table — idempotent.' })
  dedupedSlugs: string[] = [];
}
