import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../../shared/guards/auth.decorators';
import { AiService } from './ai.service';
import { BilledThrottleGuard } from './billed-throttle.guard';
import {
  FetchModelsDto,
  GenerateArticleFromTopicDto,
  GenerateContentDto,
  LearnAuthorStyleDto,
  ShuffleTopicsDto,
  TestConnectionDto,
} from './dto/ai.dto';
import {
  AiSuccessDto,
  ConnectionResultDto,
  ShuffleSuggestionDto,
} from './dto/ai-responses.dto';

const R400 = { status: 400, description: 'Invalid input or an unknown-field body — a deleted caller-supplied `apiKey` is a 400 (DEV-053).' };
const R401 = { status: 401, description: 'Missing or invalid bearer token (default-deny).' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };
const R422 = { status: 422, description: 'The provider key is not configured, or the model output could not be parsed.' };
const R429 = { status: 429, description: 'Per-admin billed-action throttle exceeded (`Retry-After`).' };

/**
 * The frozen `web/convex/ai_actions.ts` surface (6 functions), all billed.
 *
 * Every route is `@Roles('admin')` **and** `BilledThrottleGuard`-limited
 * (10/60 s per admin `sub` → 429), per DEV-049/S-011. Billed generation reads
 * the key server-side from `aiSettings`; only `fetchModels`/`testConnection`
 * accept a transient body key, and never echo or persist it (DEV-053/DEV-015).
 */
@ApiTags('ai-actions')
@Roles('admin')
@UseGuards(BilledThrottleGuard)
@Controller('ai-actions')
export class AiActionsController {
  constructor(private readonly ai: AiService) {}

  @Post('models')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List provider chat models (frozen `fetchModels`)',
    description: 'OpenAI `gpt-*`/`o1-*` or Gemini generateContent-capable models, sorted. A transient `apiKey` is accepted, never echoed (DEV-053).',
  })
  @ApiOkResponse({ type: [String] })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  @ApiResponse(R422)
  @ApiResponse(R429)
  fetchModels(@Body() dto: FetchModelsDto) {
    return this.ai.fetchModels(dto);
  }

  @Post('test-connection')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test a provider credential (frozen `testConnection`)',
    description: 'A transient `apiKey` is accepted, never echoed or persisted. A failure returns a generic message with no provider internals (Hard Rule 4).',
  })
  @ApiOkResponse({ type: ConnectionResultDto })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  @ApiResponse(R429)
  testConnection(@Body() dto: TestConnectionDto) {
    return this.ai.testConnection(dto);
  }

  @Post('generate-content')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate raw content (frozen `generateContent`, DEV-053)',
    description: 'The key is read server-side; a body carrying `apiKey` is a 400 (deleted field).',
  })
  @ApiOkResponse({ type: String })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  @ApiResponse(R422)
  @ApiResponse(R429)
  generateContent(@Body() dto: GenerateContentDto) {
    return this.ai.generateContent(dto);
  }

  @Post('generate-article-from-topic')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate + persist an AI draft from a topic (frozen `generateArticleFromTopic`, DEV-053)',
    description: 'Reuses the Phase 05 `saveAIDraft` writer and marks the topic processed. Malformed model output is 422.',
  })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  @ApiResponse(R422)
  @ApiResponse(R429)
  generateArticleFromTopic(@Body() dto: GenerateArticleFromTopicDto) {
    return this.ai.generateArticleFromTopic(dto);
  }

  @Post('learn-author-style')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Learn the author style from featured articles (frozen `learnAuthorStyle`, DEV-053)',
  })
  @ApiOkResponse({ type: String })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  @ApiResponse(R422)
  @ApiResponse(R429)
  learnAuthorStyle(@Body() dto: LearnAuthorStyleDto) {
    return this.ai.learnAuthorStyle(dto);
  }

  @Post('shuffle-topics')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Suggest 5 topics from the category names (frozen `shuffleTopics`, DEV-053)',
  })
  @ApiOkResponse({ type: [ShuffleSuggestionDto] })
  @ApiBadRequestResponse(R400)
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  @ApiResponse(R422)
  @ApiResponse(R429)
  shuffleTopics(@Body() dto: ShuffleTopicsDto) {
    return this.ai.shuffleTopics(dto);
  }
}
