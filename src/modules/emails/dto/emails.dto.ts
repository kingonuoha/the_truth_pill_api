import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Request DTOs for the Phase 08 email surface.
 *
 * Identity is never a request field — the acting admin resolves from the
 * verified token `sub`; the internal routes are `InternalSecretGuard`-only; the
 * public reset route reads no identity. Every field is explicitly validated
 * (ADR-010, DEV-006), and `templateData` is validated per template in the
 * service (never the frozen `v.any()`).
 */

const RECIPIENT_MAX_LENGTH = 320;
const SUBJECT_MAX_LENGTH = 500;
const TEMPLATE_NAME_MAX_LENGTH = 100;
const TEXT_MAX_LENGTH = 5_000;

/** `addToQueue` (`emails.ts:9`). `templateData` is validated per template. */
export class AddToQueueDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: RECIPIENT_MAX_LENGTH })
  @IsEmail()
  @MaxLength(RECIPIENT_MAX_LENGTH)
  recipient!: string;

  @ApiProperty({ maxLength: SUBJECT_MAX_LENGTH })
  @IsString()
  @MaxLength(SUBJECT_MAX_LENGTH)
  subject!: string;

  @ApiProperty({ maxLength: TEMPLATE_NAME_MAX_LENGTH, description: 'A known template name (unknown → 400).' })
  @IsString()
  @MaxLength(TEMPLATE_NAME_MAX_LENGTH)
  templateName!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Per-template data. Unknown keys or a non-string value → 400 (ADR-010, not `v.any()`).',
  })
  @IsObject()
  templateData!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Epoch-ms send time; defaults to now.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  scheduledFor?: number;
}

/** `getEmailLogs` (`emails.ts:150`) query. */
export class EmailLogsQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** `getPendingEmails` (`emails.ts:31`) query. `status` is fixed to `pending`. */
export class PendingEmailsQueryDto {
  @ApiPropertyOptional({ enum: ['pending'], default: 'pending' })
  @IsOptional()
  @IsIn(['pending'])
  status?: 'pending' = 'pending' as const;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** `updateEmailStatus` (`emails.ts:45`). `retryIncrement` bumps `retries` atomically. */
export class UpdateEmailStatusDto {
  @ApiProperty({ enum: ['pending', 'sending', 'sent', 'failed'] })
  @IsIn(['pending', 'sending', 'sent', 'failed'])
  status!: 'pending' | 'sending' | 'sent' | 'failed';

  @ApiPropertyOptional({ maxLength: TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX_LENGTH)
  error?: string;

  @ApiPropertyOptional({ description: 'Epoch-ms sent timestamp.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sentAt?: number;

  @ApiPropertyOptional({ description: 'When true, increments `retries` by one atomically.' })
  @IsOptional()
  @IsBoolean()
  retryIncrement?: boolean;
}

/** Body id for `retryEmail` (`emails.ts:166`). */
export class EmailIdDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

/** Query id for the id-addressable email reads/deletes (`emails.ts:160,180`). */
export class EmailIdQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

/** `processQueue` (`email_actions.ts:148`) optional bound. */
export class ProcessQueueDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** `sendTestEmail` (`email_actions.ts:205`). */
export class SendTestEmailDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: RECIPIENT_MAX_LENGTH })
  @IsEmail()
  @MaxLength(RECIPIENT_MAX_LENGTH)
  recipient!: string;
}

/** `requestPasswordReset` (`email_actions.ts:237`). Neutral response regardless. */
export class RequestPasswordResetDto {
  @ApiProperty({ example: 'ada@example.com', maxLength: RECIPIENT_MAX_LENGTH })
  @IsEmail()
  @MaxLength(RECIPIENT_MAX_LENGTH)
  email!: string;
}
