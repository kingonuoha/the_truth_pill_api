import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Request DTOs for the Phase 08 AI surface.
 *
 * Identity is never a request field: the acting admin resolves from the
 * verified token `sub`; there is no `adminEmail`/`userEmail` argument. Every
 * field is explicitly validated (ADR-010, DEV-006). The provider key
 * (`apiKey`) is accepted **only** on `fetchModels`/`testConnection` as a
 * transient value and only as an optional field — it is **deleted** from the
 * billed generation DTOs, so a body carrying one is a 400 via the global
 * whitelist pipe (DEV-053).
 */

/** The provider string; handled by the client (unknown values are a no-op / 422). */
const PROVIDER_MAX_LENGTH = 50;
const MODEL_MAX_LENGTH = 200;
const KEY_MAX_LENGTH = 256;
const TIMEZONE_MAX_LENGTH = 100;
const TOPIC_MAX_LENGTH = 500;
const PROMPT_MAX_LENGTH = 20_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `updateSettings` (`ai.ts:12`). Key is write-only; absent/empty retains it. */
export class UpdateSettingsDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiPropertyOptional({
    maxLength: KEY_MAX_LENGTH,
    description:
      'Write-only (DEV-048). An absent or empty value retains the stored key; never echoed back.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(KEY_MAX_LENGTH)
  apiKey?: string;

  @ApiProperty({ maxLength: MODEL_MAX_LENGTH })
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  model!: string;

  @ApiPropertyOptional({ maxLength: PROMPT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROMPT_MAX_LENGTH)
  promptTemplate?: string;

  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;
}

/** `setWritingStatus` (`ai.ts:34`). */
export class SetWritingStatusDto {
  @ApiProperty()
  @IsBoolean()
  isWriting!: boolean;
}

/** `addResearchTopic` (`ai.ts:53`). */
export class AddResearchTopicDto {
  @ApiProperty({ maxLength: TOPIC_MAX_LENGTH })
  @IsString()
  @MaxLength(TOPIC_MAX_LENGTH)
  topic!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

/** `markTopicAsProcessed` (`ai.ts:72`). */
export class MarkTopicAsProcessedDto {
  @ApiProperty({ maxLength: TOPIC_MAX_LENGTH })
  @IsString()
  @MaxLength(TOPIC_MAX_LENGTH)
  topic!: string;
}

/** Path/query id for the AI delete routes (frozen `id` argument). */
export class IdQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

/** `updateScheduleV2` (`ai.ts:107`). `id` absent means insert. */
export class UpdateScheduleV2Dto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ type: [Number], minimum: 0, maximum: 6, description: 'Days 0 (Sun) … 6 (Sat).' })
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek!: number[];

  @ApiProperty({ example: '08:30', pattern: 'HH:MM' })
  @IsString()
  @MaxLength(5)
  @Matches(TIME_PATTERN, { message: 'time must be HH:MM' })
  time!: string;

  @ApiProperty({ maxLength: TIMEZONE_MAX_LENGTH })
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  timezone!: string;

  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(TOPIC_MAX_LENGTH, { each: true })
  topicsToResearch!: string[];
}

/** `updateLastRun` (`ai.ts:229`). */
export class UpdateLastRunDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

/** `runSingleResearch` (`ai.ts:272`). Key is read server-side (DEV-053). */
export class RunSingleResearchDto {
  @ApiProperty({ maxLength: TOPIC_MAX_LENGTH })
  @IsString()
  @MaxLength(TOPIC_MAX_LENGTH)
  topic!: string;
}

/* ─────────────────────────── ai_actions.ts (billed) ─────────────────────────── */

/** `fetchModels` (`ai_actions.ts:7`). Transient key allowed (DEV-053). */
export class FetchModelsDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiPropertyOptional({ maxLength: KEY_MAX_LENGTH, description: 'Transient test key; never echoed or persisted (DEV-053).' })
  @IsOptional()
  @IsString()
  @MaxLength(KEY_MAX_LENGTH)
  apiKey?: string;
}

/** `testConnection` (`ai_actions.ts:72`). Transient key allowed (DEV-053). */
export class TestConnectionDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiPropertyOptional({ maxLength: KEY_MAX_LENGTH, description: 'Transient test key; never echoed or persisted (DEV-053).' })
  @IsOptional()
  @IsString()
  @MaxLength(KEY_MAX_LENGTH)
  apiKey?: string;

  @ApiProperty({ maxLength: MODEL_MAX_LENGTH })
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  model!: string;
}

/**
 * `generateContent` (`ai_actions.ts:136`). `apiKey` is **deleted**: the key is
 * read server-side from `aiSettings` (DEV-053); a body carrying it is a 400.
 */
export class GenerateContentDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiProperty({ maxLength: MODEL_MAX_LENGTH })
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  model!: string;

  @ApiProperty({ maxLength: PROMPT_MAX_LENGTH })
  @IsString()
  @MaxLength(PROMPT_MAX_LENGTH)
  prompt!: string;

  @ApiPropertyOptional({ maxLength: PROMPT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROMPT_MAX_LENGTH)
  systemPrompt?: string;
}

/** `generateArticleFromTopic` (`ai_actions.ts:220`). `apiKey` deleted (DEV-053). */
export class GenerateArticleFromTopicDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiProperty({ maxLength: MODEL_MAX_LENGTH })
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  model!: string;

  @ApiProperty({ maxLength: TOPIC_MAX_LENGTH })
  @IsString()
  @MaxLength(TOPIC_MAX_LENGTH)
  topic!: string;

  @ApiPropertyOptional({ maxLength: PROMPT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(PROMPT_MAX_LENGTH)
  systemPrompt?: string;
}

/** `learnAuthorStyle` (`ai_actions.ts:292`). `apiKey` deleted (DEV-053). */
export class LearnAuthorStyleDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiProperty({ maxLength: MODEL_MAX_LENGTH })
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  model!: string;
}

/** `shuffleTopics` (`ai_actions.ts:322`). `apiKey` deleted (DEV-053). */
export class ShuffleTopicsDto {
  @ApiProperty({ maxLength: PROVIDER_MAX_LENGTH })
  @IsString()
  @MaxLength(PROVIDER_MAX_LENGTH)
  provider!: string;

  @ApiProperty({ maxLength: MODEL_MAX_LENGTH })
  @IsString()
  @MaxLength(MODEL_MAX_LENGTH)
  model!: string;
}
