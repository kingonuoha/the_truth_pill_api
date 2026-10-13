import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsString,
} from 'class-validator';

/**
 * Request body for `POST /api/v1/stream/tickets`.
 *
 * DEV-006 / ADR-010: strict DTO. `topics` is the **only** accepted body field;
 * a body carrying `userId` / `userEmail` / `adminEmail` / `role` / `token` is a
 * 400 via the global `forbidNonWhitelisted` pipe (DEV-029 class, matrix §6).
 * The 8-element ceiling is the frozen default; the service additionally checks
 * the env-resolved cap.
 */
export class CreateTicketDto {
  @ApiProperty({
    description: 'Topics to subscribe to (1–8). Validated + authorized at issuance.',
    example: ['article:0f8fad5b-d9cb-469f-a165-70867728950e'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  topics!: string[];
}

/**
 * Query for `GET /api/v1/stream`. `ticket` is the only accepted key; the topics
 * travel **inside** the ticket, never the URL.
 */
export class StreamQueryDto {
  // OpenAPI has no `sensitive` keyword; `format: password` is the generator's
  // mask hint so tooling/UI can redact the URL credential. Never logged
  // (Hard Rule 8).
  @ApiProperty({ description: 'Single-use, 30 s SSE ticket (send as a URL credential; never logged).', format: 'password' })
  @IsString()
  @IsNotEmpty()
  ticket!: string;
}

/** The single-use ticket response (`realtime.md` §2). */
export class TicketResponseDto {
  @ApiProperty({ description: 'Opaque single-use ticket (base64url, 256-bit).' })
  ticket!: string;

  @ApiProperty({ description: 'Ticket lifetime in seconds.', example: 30 })
  expiresIn!: number;
}
