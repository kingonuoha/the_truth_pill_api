import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response schemas for the Phase 08 email surface. Explicit `@ApiProperty`
 * types — never `any`, never an empty schema. Dates are ISO-8601 strings.
 *
 * `EmailLogDto.templateData` omits the token-bearing keys (`resetUrl`,
 * `unsubscribeUrl`, `confirmUrl`, `otpCode`) — an admin response is
 * browser-facing (DEV-034 class, Hard Rule 8). The **internal** consumer reads
 * carry `templateData` in full because they are `InternalSecretGuard`-only.
 */

/** `addToQueue` (`emails.ts:9`) — the inserted queue-row id. */
export class QueuedEmailDto {
  @ApiProperty({ format: 'uuid' }) id: string = '';
}

/** A neutral success acknowledgement. */
export class EmailSuccessDto {
  @ApiProperty({ example: true }) success: boolean = true;
}

/** One queue row as an admin log read (`emails.ts:150,160`) — token fields redacted. */
export class EmailLogDto {
  @ApiProperty({ format: 'uuid' }) id: string = '';
  @ApiProperty() recipient: string = '';
  @ApiProperty() subject: string = '';
  @ApiProperty() templateName: string = '';
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Token-bearing keys (`resetUrl`, `unsubscribeUrl`, `confirmUrl`, `otpCode`) are omitted.',
  })
  templateData: Record<string, string> = {};
  @ApiProperty({ enum: ['pending', 'sending', 'sent', 'failed'] })
  status: string = 'pending';
  @ApiProperty({ format: 'date-time' }) scheduledFor: string = '';
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  sentAt: string | null = null;
  @ApiProperty({ type: String, nullable: true }) error: string | null = null;
  @ApiProperty() retries: number = 0;
}

/** `getPendingEmails` (`emails.ts:31`) — the **internal** consumer view (full `templateData`). */
export class PendingEmailDto {
  @ApiProperty({ format: 'uuid' }) id: string = '';
  @ApiProperty() recipient: string = '';
  @ApiProperty() subject: string = '';
  @ApiProperty() templateName: string = '';
  @ApiProperty({ type: 'object', additionalProperties: true })
  templateData: Record<string, string> = {};
  @ApiProperty() scheduledFor: string = '';
  @ApiProperty() retries: number = 0;
}

/** `generateWeeklyNewsletter` (`emails.ts:79`) run result. */
export class WeeklyDigestResultDto {
  @ApiProperty({ description: 'Subscribed users found.' }) subscribers: number = 0;
  @ApiProperty({ description: 'Queue rows inserted.' }) queued: number = 0;
  @ApiProperty({ description: 'True when no article qualified in the 7-day window.' })
  skipped: boolean = false;
}

/** `processQueue` (`email_actions.ts:148`) run status — closes DEV-012's silent no-op. */
export class ProcessQueueResultDto {
  @ApiProperty() processed: number = 0;
  @ApiProperty() sent: number = 0;
  @ApiProperty() failed: number = 0;
  @ApiProperty({ description: 'True when the due-pending set was empty.' })
  skipped: boolean = false;
}

/** `sendTestEmail` (`email_actions.ts:205`) — failure carries a generic message only. */
export class SendTestEmailResultDto {
  @ApiProperty() success: boolean = false;
  @ApiPropertyOptional({ description: 'A generic, SMTP-internals-free message on failure.' })
  message?: string;
}

/** `requestPasswordReset` (`email_actions.ts:237`) — the single neutral shape. */
export class PasswordResetNeutralDto {
  @ApiProperty({ example: true }) success: boolean = true;
}
