import {
  Body,
  Controller,
  Delete,
  Get,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../../shared/guards/auth.decorators';
import { EmailsService } from './emails.service';
import {
  AddToQueueDto,
  EmailIdDto,
  EmailIdQueryDto,
  EmailLogsQueryDto,
} from './dto/emails.dto';
import {
  EmailLogDto,
  EmailSuccessDto,
  QueuedEmailDto,
} from './dto/email-responses.dto';

const R400 = {
  status: 400,
  description: 'Invalid input, or an unknown template/key in `templateData` (ADR-010).',
};
const R401 = { status: 401, description: 'Missing or invalid bearer token (default-deny).' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };

/**
 * The admin email surface (frozen matrix §2.1): `addToQueue` plus the
 * `emailQueue` admin reads/writes. Every route is `@Roles('admin')` backed by
 * `RolesGuard` (DB role). Admin reads redact token-bearing `templateData` keys
 * (DEV-034 class, Hard Rule 8); the consumer-facing internal reads do not.
 */
@ApiTags('emails')
@Roles('admin')
@Controller('emails')
export class EmailsController {
  constructor(private readonly emails: EmailsService) {}

  @Patch('add-to-queue')
  @ApiOperation({
    summary: 'Enqueue an email (frozen `addToQueue`, DEV-006)',
    description: '`templateData` is validated per template; an unknown template, unknown key, or non-string value is a 400.',
  })
  @ApiOkResponse({ type: QueuedEmailDto })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  addToQueue(@Body() dto: AddToQueueDto) {
    return this.emails.addToQueue(dto);
  }

  @Get('email-logs')
  @ApiOperation({
    summary: 'Recent queue rows, newest first, token fields redacted (frozen `getEmailLogs`)',
  })
  @ApiOkResponse({ type: [EmailLogDto] })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  getEmailLogs(@Query() query: EmailLogsQueryDto) {
    return this.emails.getEmailLogs(query.limit ?? 50);
  }

  @Get('email-by-id')
  @ApiOperation({ summary: 'One queue row by id, token fields redacted (frozen `getEmailById`)' })
  @ApiOkResponse({ type: EmailLogDto })
  @ApiNotFoundResponse({ description: 'No queue row with that id.' })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  getEmailById(@Query() query: EmailIdQueryDto) {
    return this.emails.getEmailById(query.id);
  }

  @Patch('retry-email')
  @ApiOperation({ summary: 'Reset a failed email to pending (frozen `retryEmail`)' })
  @ApiOkResponse({ type: EmailSuccessDto })
  @ApiNotFoundResponse({ description: 'No queue row with that id.' })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  retryEmail(@Body() dto: EmailIdDto) {
    return this.emails.retryEmail(dto.id);
  }

  @Delete('delete-email')
  @ApiOperation({ summary: 'Delete a queue row by id, idempotent (frozen `deleteEmail`)' })
  @ApiOkResponse({ type: EmailSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  deleteEmail(@Query() query: EmailIdQueryDto) {
    return this.emails.deleteEmail(query.id);
  }
}
