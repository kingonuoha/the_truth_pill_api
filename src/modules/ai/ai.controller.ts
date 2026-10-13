import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
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
import { ArticleDetailDto } from '../articles/dto/article-responses.dto';
import { AiService } from './ai.service';
import { BilledThrottleGuard } from './billed-throttle.guard';
import {
  AddResearchTopicDto,
  IdQueryDto,
  MarkTopicAsProcessedDto,
  RunSingleResearchDto,
  SetWritingStatusDto,
  UpdateLastRunDto,
  UpdateScheduleV2Dto,
  UpdateSettingsDto,
} from './dto/ai.dto';
import {
  AiSettingsDto,
  AiSuccessDto,
  ClearTopicsResultDto,
  ResearchTopicDto,
  ScheduleDto,
} from './dto/ai-responses.dto';

const R400 = { status: 400, description: 'Invalid input or an unknown-field body (global whitelist pipe, ADR-010).' };
const R401 = { status: 401, description: 'Missing or invalid bearer token (default-deny).' };
const R403 = { status: 403, description: 'The caller is not an admin (DB-resolved role).' };

/**
 * The admin AI surface (`web/convex/ai.ts`, 15 of 16 functions). Every route is
 * `@Roles('admin')` backed by `RolesGuard` (frozen matrix §2.1). The lone
 * internal helper is `POST /internal/ai/process-schedule-check`
 * (`InternalAiController`, DEV-049). No route accepts a caller-supplied
 * identity, and no response carries the provider key (S-010/DEV-048/DEV-015).
 */
@ApiTags('ai')
@Roles('admin')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('settings')
  @ApiOperation({
    summary: 'AI settings, projected without the key (frozen `getSettings`, DEV-048/S-010)',
    description: 'Returns the settings minus `apiKey`, plus a derived `hasApiKey` boolean. The key never transits a response.',
  })
  @ApiOkResponse({ type: AiSettingsDto })
  @ApiUnauthorizedResponse(R401)
  @ApiForbiddenResponse(R403)
  getSettings() {
    return this.ai.getSettings();
  }

  @Patch('update-settings')
  @ApiOperation({
    summary: 'Update AI settings; the key is write-only (frozen `updateSettings`, DEV-048/DEV-015)',
    description: 'An absent or empty `apiKey` retains the stored credential. The response is `{success:true}` and never echoes the key.',
  })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  updateSettings(@Body() dto: UpdateSettingsDto) {
    return this.ai.updateSettings(dto);
  }

  @Patch('set-writing-status')
  @ApiOperation({ summary: 'Set/clear the writing flag (frozen `setWritingStatus`, DEV-051)' })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  setWritingStatus(@Body() dto: SetWritingStatusDto) {
    return this.ai.setWritingStatus(dto);
  }

  @Get('research-topics')
  @ApiOperation({ summary: 'Research topics, newest first (frozen `getResearchTopics`)' })
  @ApiOkResponse({ type: [ResearchTopicDto] })
  @ApiResponse(R401)
  @ApiResponse(R403)
  getResearchTopics() {
    return this.ai.getResearchTopics();
  }

  @Patch('add-research-topic')
  @ApiOperation({ summary: 'Add a pending research topic (frozen `addResearchTopic`)' })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse({ status: 422, description: '`categoryId` does not resolve.' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  addResearchTopic(@Body() dto: AddResearchTopicDto) {
    return this.ai.addResearchTopic(dto);
  }

  @Delete('delete-research-topic')
  @ApiOperation({ summary: 'Delete a research topic by id (frozen `deleteResearchTopic`)' })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  deleteResearchTopic(@Query() q: IdQueryDto) {
    return this.ai.deleteResearchTopic(q.id);
  }

  @Patch('mark-topic-as-processed')
  @ApiOperation({ summary: 'Mark the pending topic with this text processed (frozen `markTopicAsProcessed`)' })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  markTopicAsProcessed(@Body() dto: MarkTopicAsProcessedDto) {
    return this.ai.markTopicAsProcessed(dto.topic);
  }

  @Patch('clear-all-pending-topics')
  @ApiOperation({ summary: 'Delete every pending research topic (frozen `clearAllPendingTopics`)' })
  @ApiOkResponse({ type: ClearTopicsResultDto })
  @ApiResponse(R401)
  @ApiResponse(R403)
  clearAllPendingTopics() {
    return this.ai.clearAllPendingTopics();
  }

  @Get('schedule')
  @ApiOperation({ summary: 'All AI schedules (frozen `getSchedule`, DEV-051)' })
  @ApiOkResponse({ type: [ScheduleDto] })
  @ApiResponse(R401)
  @ApiResponse(R403)
  getSchedule() {
    return this.ai.getSchedule();
  }

  @Patch('update-schedule-v2')
  @ApiOperation({
    summary: 'Patch a schedule by id, else insert (frozen `updateScheduleV2`, DEV-051)',
    description: 'An insert maps the frozen `lastRun: 0` sentinel to `null` ("never run").',
  })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse({ status: 404, description: 'The `id` does not resolve.' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  updateScheduleV2(@Body() dto: UpdateScheduleV2Dto) {
    return this.ai.updateScheduleV2(dto);
  }

  @Get('pending-schedules')
  @ApiOperation({
    summary: 'Active schedules inside the 15-min window, not yet run today in their tz (frozen `getPendingSchedules`)',
  })
  @ApiOkResponse({ type: [ScheduleDto] })
  @ApiResponse(R401)
  @ApiResponse(R403)
  getPendingSchedules() {
    return this.ai.getPendingSchedules();
  }

  @Patch('update-last-run')
  @ApiOperation({ summary: 'Set a schedule lastRun to now (frozen `updateLastRun`, DEV-051)' })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse({ status: 404, description: 'The `id` does not resolve.' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  updateLastRun(@Body() dto: UpdateLastRunDto) {
    return this.ai.updateLastRun(dto);
  }

  @Post('run-single-research')
  @HttpCode(HttpStatus.OK)
  @UseGuards(BilledThrottleGuard)
  @ApiOperation({
    summary: 'Generate one article for a topic (frozen `runSingleResearch`, DEV-049/DEV-053)',
    description: 'Admin + per-admin throttled (10/60s → 429). The provider key is read server-side; a missing key is 422.',
  })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiResponse(R400)
  @ApiResponse({ status: 422, description: 'AI settings/key are not configured.' })
  @ApiResponse({ status: 429, description: 'Per-admin billed-action throttle exceeded (`Retry-After`).' })
  @ApiResponse(R401)
  @ApiResponse(R403)
  runSingleResearch(@Body() dto: RunSingleResearchDto) {
    return this.ai.runSingleResearch(dto);
  }

  @Delete('delete-schedule')
  @ApiOperation({ summary: 'Delete a schedule by id (frozen `deleteSchedule`)' })
  @ApiOkResponse({ type: AiSuccessDto })
  @ApiBadRequestResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  deleteSchedule(@Query() q: IdQueryDto) {
    return this.ai.deleteSchedule(q.id);
  }

  @Get('aidrafts')
  @ApiOperation({ summary: "AI drafts: status='draft' AND source='ai', newest first (frozen `listAIDrafts`)" })
  @ApiOkResponse({ type: [ArticleDetailDto] })
  @ApiResponse(R401)
  @ApiResponse(R403)
  listAIDrafts() {
    return this.ai.listAIDrafts();
  }
}
