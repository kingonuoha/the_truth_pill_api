import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../shared/guards/auth.decorators';
import { InternalSecretGuard } from '../../shared/guards/internal-secret.guard';
import { INTERNAL_SECRET_SECURITY_SCHEME } from '../../shared/swagger/security';
import { EmailsService } from './emails.service';
import {
  PendingEmailsQueryDto,
  ProcessQueueDto,
  UpdateEmailStatusDto,
} from './dto/emails.dto';
import {
  EmailSuccessDto,
  PendingEmailDto,
  ProcessQueueResultDto,
  WeeklyDigestResultDto,
} from './dto/email-responses.dto';

const R400 = {
  status: 400,
  description: 'Invalid input: malformed, empty, or unknown-field body (global whitelist pipe).',
};
const R401 = {
  status: 401,
  description: 'Missing or incorrect `x-internal-secret`, or `INTERNAL_JOB_SECRET` unset (fail-closed, Hard Rule 6).',
};

/**
 * The five frozen internal email functions (frozen matrix §2.2), worker-only.
 *
 * Group: `@Public()` + `InternalSecretGuard` (timing-safe, fail-closed). These
 * carry full `templateData` because the consumer must render it — an accepted
 * internal-secret-guarded surface, never public. Cron **scheduling** is Phase 09;
 * this phase exposes the services + endpoints those crons call.
 */
@ApiTags('internal-emails')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@ApiHeader({ name: 'x-internal-secret', required: true, description: 'INTERNAL_JOB_SECRET' })
@Controller('internal')
export class InternalEmailsController {
  constructor(private readonly emails: EmailsService) {}

  @Get('emails')
  @ApiOperation({
    summary: 'Due pending queue rows, bounded (frozen `getPendingEmails`, consumer view)',
  })
  @ApiOkResponse({ type: [PendingEmailDto] })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  getPendingEmails(@Query() query: PendingEmailsQueryDto) {
    return this.emails.getPendingEmails(query.limit ?? 50);
  }

  @Patch('emails/:id/status')
  @ApiOperation({
    summary: 'Update a queue row status, `retries` atomic (frozen `updateEmailStatus`)',
  })
  @ApiOkResponse({ type: EmailSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiNotFoundResponse({ description: 'No queue row with that id (the read no-ops).' })
  @ApiResponse(R401)
  updateEmailStatus(
    @Param('id') id: string,
    @Body() dto: UpdateEmailStatusDto,
  ) {
    return this.emails.updateEmailStatus(id, dto);
  }

  @Post('emails/weekly-digest')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue the weekly digest for subscribers (frozen `generateWeeklyNewsletter`, DEV-035)',
    description: 'Top-3 by views in the last 7 days; the unsubscribe URL carries a signed single-use token, never a bare email.',
  })
  @ApiOkResponse({ type: WeeklyDigestResultDto })
  @ApiResponse(R401)
  generateWeeklyNewsletter() {
    return this.emails.generateWeeklyNewsletter();
  }

  @Post('email-queue/process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Drain due pending email rows (frozen `processQueue`, DEV-050)',
    description: 'sending → sent; failure retries < 3 → pending else failed; the run status is surfaced. Cron scheduling is Phase 09.',
  })
  @ApiOkResponse({ type: ProcessQueueResultDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  processQueue(@Body() dto: ProcessQueueDto) {
    return this.emails.processQueue(dto);
  }
}
