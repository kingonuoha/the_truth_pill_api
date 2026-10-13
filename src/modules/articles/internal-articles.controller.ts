import { Body, Controller, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../shared/guards/auth.decorators';
import { InternalSecretGuard } from '../../shared/guards/internal-secret.guard';
import { INTERNAL_SECRET_SECURITY_SCHEME } from '../../shared/swagger/security';
import { ArticlesService } from './articles.service';
import {
  AiDraftResultDto,
  PublishScheduledResultDto,
  QueueAlertsResultDto,
} from './dto/article-responses.dto';
import { QueueAlertsDto, SaveAIDraftDto } from './dto/articles.dto';

const INTERNAL_401 = {
  status: 401,
  description: 'Missing or incorrect `x-internal-secret` (AGENTS.md Hard Rule 6, timing-safe compare).',
};

/**
 * Internal article fan-outs (`publishScheduledArticles`, `queueNewArticleAlerts`).
 * `@Public()` only removes the JWT requirement; `InternalSecretGuard` is the
 * sole boundary and fails closed when `INTERNAL_JOB_SECRET` is unset. The
 * scheduler that calls these lands in Phase 09.
 */
@ApiTags('internal-articles')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@ApiHeader({ name: 'x-internal-secret', required: true, description: 'INTERNAL_JOB_SECRET' })
@Controller('internal/articles')
export class InternalArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @ApiOkResponse({ type: PublishScheduledResultDto })
  @Post('publish-scheduled')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish due scheduled articles (frozen `articles.publishScheduledArticles`)',
    description: 'Idempotent: a re-run finds nothing due and publishes nothing.',
  })
  @ApiResponse(INTERNAL_401)
  publishScheduled() {
    return this.articles.publishScheduled();
  }

  @ApiOkResponse({ type: QueueAlertsResultDto })
  @Post('queue-alerts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Queue new-article emails for subscribers (frozen `articles.queueNewArticleAlerts`)',
    description: 'Queues only — the Phase 08 worker sends. Idempotent: a second call inserts no duplicate queue rows.',
  })
  @ApiResponse(INTERNAL_401)
  queueAlerts(@Body() dto: QueueAlertsDto) {
    return this.articles.queueAlerts(dto.articleId);
  }
}

/**
 * `saveAIDraft` as `PUT /internal/ai-drafts/{id}` (convex-ownership Target).
 * The path id is the caller's idempotency key (Phase 08 AI action supplies it):
 * the slug suffix is derived from it deterministically, so a replayed PUT
 * returns the same draft id instead of inserting twice.
 */
@ApiTags('internal-ai-drafts')
@Public()
@ApiSecurity(INTERNAL_SECRET_SECURITY_SCHEME)
@UseGuards(InternalSecretGuard)
@ApiHeader({ name: 'x-internal-secret', required: true, description: 'INTERNAL_JOB_SECRET' })
@Controller('internal/ai-drafts')
export class InternalAiDraftsController {
  constructor(private readonly articles: ArticlesService) {}

  @ApiOkResponse({ type: AiDraftResultDto })
  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Store an AI draft (frozen `articles.saveAIDraft`), idempotent on the path key' })
  @ApiResponse(INTERNAL_401)
  @ApiResponse({ status: 422, description: 'No category exists to attach the draft to, or an unresolvable pillar (names the field).' })
  saveAIDraft(@Param('id') id: string, @Body() dto: SaveAIDraftDto) {
    return this.articles.saveAIDraft(id, dto);
  }
}
