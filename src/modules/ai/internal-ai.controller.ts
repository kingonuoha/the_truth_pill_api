import { Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Public } from '../../shared/guards/auth.decorators';
import { InternalSecretGuard } from '../../shared/guards/internal-secret.guard';
import { INTERNAL_SECRET_SECURITY_SCHEME } from '../../shared/swagger/security';
import { AiService } from './ai.service';
import { ProcessScheduleResultDto } from './dto/ai-responses.dto';

const R401 = {
  status: 401,
  description: 'Missing or incorrect `x-internal-secret`, or `INTERNAL_JOB_SECRET` unset (fail-closed, Hard Rule 6).',
};

/**
 * `ai.processScheduleCheck` (`ai.ts:236-270`) — internal only (DEV-049/S-011).
 *
 * The frozen function was a **public `action`** wired to the 15-minute cron, so
 * any caller could trigger billed LLM runs on demand. It is now
 * `POST /api/v1/internal/ai/process-schedule-check` behind `InternalSecretGuard`;
 * the public `/api/v1/ai/process-schedule-check` path does not exist (404). The
 * Phase 09 cron calls this with the secret; cron registration is Phase 09.
 */
@ApiTags('internal-ai')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@ApiHeader({ name: 'x-internal-secret', required: true, description: 'INTERNAL_JOB_SECRET' })
@Controller('internal/ai')
export class InternalAiController {
  constructor(private readonly ai: AiService) {}

  @Post('process-schedule-check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run due AI schedules (frozen `processScheduleCheck`, DEV-049)',
    description:
      'Bails when settings are inactive/keyless or nothing is due. A failure on one topic does not abort the batch; the run status is surfaced.',
  })
  @ApiOkResponse({ type: ProcessScheduleResultDto })
  @ApiResponse(R401)
  processScheduleCheck() {
    return this.ai.processScheduleCheck();
  }
}
