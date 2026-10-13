import { ApiProperty } from '@nestjs/swagger';

/**
 * Response schemas for the Phase 08 AI surface. Explicit `@ApiProperty` types —
 * never `any`, never an empty schema. Dates are ISO-8601 strings.
 *
 * `AiSettingsDto` is the S-010 / DEV-048 projection: it carries **no `apiKey`
 * field at all** — only a derived boolean `hasApiKey`. The column is never
 * selected into a response.
 */

/** `getSettings` projection (`ai.ts:5`, DEV-048). */
export class AiSettingsDto {
  @ApiProperty() id: string = '';
  @ApiProperty() provider: string = '';
  @ApiProperty() model: string = '';
  @ApiProperty({ type: String, nullable: true }) promptTemplate: string | null = null;
  @ApiProperty() isActive: boolean = false;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastTested: string | null = null;
  @ApiProperty({ type: String, nullable: true, enum: ['success', 'failed'] }) testStatus: string | null = null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) isWriting: string | null = null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt: string | null = null;
  @ApiProperty({ description: 'True iff a non-empty provider key is stored. The key itself is never returned (DEV-048).' })
  hasApiKey: boolean = false;
}

/** A neutral success acknowledgement (the frozen mutations returned `void`). */
export class AiSuccessDto {
  @ApiProperty({ example: true }) success: boolean = true;
}

/** `clearAllPendingTopics` (`ai.ts:87`) — count of deleted pending topics. */
export class ClearTopicsResultDto {
  @ApiProperty() success: boolean = true;
  @ApiProperty() deleted: number = 0;
}

/** `getResearchTopics` row (`ai.ts:46`). */
export class ResearchTopicDto {
  @ApiProperty() id: string = '';
  @ApiProperty() topic: string = '';
  @ApiProperty({ type: String, nullable: true }) categoryId: string | null = null;
  @ApiProperty({ enum: ['pending', 'processed'] }) status: string = 'pending';
  @ApiProperty({ format: 'date-time' }) createdAt: string = '';
}

/** `getSchedule` / `getPendingSchedules` row (`ai.ts:100,129`, DEV-051). */
export class ScheduleDto {
  @ApiProperty() id: string = '';
  @ApiProperty({ type: [Number] }) daysOfWeek: number[] = [];
  @ApiProperty() time: string = '';
  @ApiProperty() timezone: string = '';
  @ApiProperty() isActive: boolean = false;
  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'null = never run (frozen sentinel 0 mapped, DEV-051).' })
  lastRun: string | null = null;
  @ApiProperty({ type: [String] }) topicsToResearch: string[] = [];
}

/** `testConnection` result (`ai_actions.ts:72`). */
export class ConnectionResultDto {
  @ApiProperty() success: boolean = false;
  @ApiProperty() message: string = '';
}

/** One `shuffleTopics` suggestion (`ai_actions.ts:322`). */
export class ShuffleSuggestionDto {
  @ApiProperty() topic: string = '';
  @ApiProperty() categoryName: string = '';
  @ApiProperty() seoReasoning: string = '';
}

/**
 * `processScheduleCheck` run status (`ai.ts:236`). Entirely server-side; the
 * per-topic `failed` count is surfaced so a partial batch is observable.
 */
export class ProcessScheduleResultDto {
  @ApiProperty({ description: 'Schedules due and processed.' }) processed: number = 0;
  @ApiProperty() generated: number = 0;
  @ApiProperty() failed: number = 0;
  @ApiProperty({ description: 'True when settings were inactive/keyless or nothing was due.' }) skipped: boolean = false;
}
