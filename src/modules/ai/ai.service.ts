import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ArticlesService } from '../articles/articles.service';
import { ARTICLE_INCLUDE, toArticleDetail } from '../articles/article-projection';
import { CategoriesService } from '../categories/categories.service';
import { AI_ARTICLE_TYPES, AI_CONFIG, AiArticleType } from './ai-prompts';
import { HttpAiProviderClient } from './ai-provider.client';
import { publishAiStatus } from '../stream/stream-publishers';
import {
  AddResearchTopicDto,
  FetchModelsDto,
  GenerateArticleFromTopicDto,
  GenerateContentDto,
  LearnAuthorStyleDto,
  RunSingleResearchDto,
  SetWritingStatusDto,
  ShuffleTopicsDto,
  TestConnectionDto,
  UpdateLastRunDto,
  UpdateScheduleV2Dto,
  UpdateSettingsDto,
} from './dto/ai.dto';
import {
  AiSettingsDto,
  AiSuccessDto,
  ClearTopicsResultDto,
  ConnectionResultDto,
  ProcessScheduleResultDto,
  ResearchTopicDto,
  ScheduleDto,
  ShuffleSuggestionDto,
} from './dto/ai-responses.dto';

/** The settings row the provider path needs — includes the key, server-side only. */
interface SettingsWithKey {
  id: string;
  provider: string;
  apiKey: string | null;
  model: string;
  promptTemplate: string | null;
  isActive: boolean;
}

/** A raw `aiSettings` projection row — `hasApiKey` is derived in SQL, never the value. */
interface ParsedArticleDraft {
  title: string;
  content: string;
  excerpt: string;
  pillar: string | undefined;
  topics: string[];
  type: AiArticleType;
  metaTitle: string | undefined;
  metaDescription: string | undefined;
  focusKeyword: string | undefined;
}

const TIMEZONE_SHORTHANDS: Readonly<Record<string, string>> = {
  UTC: 'UTC',
  'GMT+1': 'Europe/London',
  EST: 'America/New_York',
  PST: 'America/Los_Angeles',
  CET: 'Europe/Paris',
  IST: 'Asia/Kolkata',
};

const DAY_NAMES: Readonly<Record<string, number>> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

const WINDOW_MINUTES = 15;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

/**
 * The 16 `web/convex/ai.ts` behaviours plus the 6 `ai_actions.ts` provider calls.
 *
 * DEV-048: `getSettings` projects the key out (only `hasApiKey`); `updateSettings`
 * is write-only. DEV-051: `lastRun` maps the frozen numeric `0` to `null`.
 * DEV-052: the singleton is resolved with `findFirst()`, never a literal-id
 * lookup. DEV-053: billed generation reads the key server-side. DEV-015: the key
 * is never logged or returned.
 */
@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly articles: ArticlesService,
    private readonly categories: CategoriesService,
    private readonly provider: HttpAiProviderClient,
  ) {}

  /* ───────────────────────────── settings ───────────────────────────── */

  /**
   * `getSettings` (`ai.ts:5-10`), projected (DEV-048/S-010). The `apiKey`
   * column is **never selected into a response**: the safe fields come from a
   * normal `select` and `hasApiKey` is derived in SQL from a boolean predicate,
   * so the value never crosses the response boundary.
   */
  async getSettings(): Promise<AiSettingsDto | null> {
    const safe = await this.prisma.aiSettings.findFirst({
      select: {
        id: true,
        provider: true,
        model: true,
        promptTemplate: true,
        isActive: true,
        lastTested: true,
        testStatus: true,
        isWriting: true,
        createdAt: true,
      },
    });
    if (!safe) return null;

    const keyRows = await this.prisma.$queryRaw<Array<{ hasApiKey: boolean }>>`
      SELECT ("apiKey" IS NOT NULL AND "apiKey" <> '') AS "hasApiKey"
      FROM "aiSettings"
      WHERE "id" = ${safe.id}
      LIMIT 1`;
    const hasApiKey = keyRows[0]?.hasApiKey === true;

    return {
      id: safe.id,
      provider: safe.provider,
      model: safe.model,
      promptTemplate: safe.promptTemplate,
      isActive: safe.isActive,
      lastTested: safe.lastTested ? safe.lastTested.toISOString() : null,
      testStatus: safe.testStatus,
      isWriting: safe.isWriting ? safe.isWriting.toISOString() : null,
      createdAt: safe.createdAt ? safe.createdAt.toISOString() : null,
      hasApiKey,
    };
  }

  /**
   * `updateSettings` (`ai.ts:12-32`), write-only key (DEV-048/DEV-015). An
   * absent or empty `apiKey` retains the stored credential; the response only
   * acknowledges success and never carries the row or the key.
   * DEV-052: the singleton is patched in place via `findFirst()`.
   */
  async updateSettings(dto: UpdateSettingsDto): Promise<AiSuccessDto> {
    const existing = await this.prisma.aiSettings.findFirst({ select: { id: true } });
    const keyPatch =
      dto.apiKey !== undefined && dto.apiKey.length > 0 ? { apiKey: dto.apiKey } : {};
    const optionalPatch =
      dto.promptTemplate !== undefined ? { promptTemplate: dto.promptTemplate } : {};

    if (existing) {
      await this.prisma.aiSettings.update({
        where: { id: existing.id },
        data: {
          provider: dto.provider,
          model: dto.model,
          isActive: dto.isActive,
          ...optionalPatch,
          ...keyPatch,
        },
      });
    } else {
      await this.prisma.aiSettings.create({
        data: {
          provider: dto.provider,
          model: dto.model,
          isActive: dto.isActive,
          promptTemplate: dto.promptTemplate ?? null,
          apiKey: dto.apiKey && dto.apiKey.length > 0 ? dto.apiKey : '',
          createdAt: new Date(),
        },
      });
    }
    return { success: true };
  }

  /** `setWritingStatus` (`ai.ts:34-44`). `false` clears the timestamp (DEV-051). */
  async setWritingStatus(dto: SetWritingStatusDto): Promise<AiSuccessDto> {
    const existing = await this.prisma.aiSettings.findFirst({ select: { id: true } });
    const startedAt = dto.isWriting ? new Date() : null;
    if (existing) {
      await this.prisma.aiSettings.update({
        where: { id: existing.id },
        data: { isWriting: startedAt },
      });
    }
    // DEV-055: the narrow `aiStatus.changed` frame. `nextRun` is not computed
    // from schedules here (under-specified in `realtime.md` §3); the key is
    // present and null, never a document.
    publishAiStatus({
      isWriting: dto.isWriting,
      lastRun: startedAt ? startedAt.toISOString() : null,
      nextRun: null,
    });
    return { success: true };
  }

  /* ───────────────────────────── research topics ───────────────────────────── */

  /** `getResearchTopics` (`ai.ts:46-51`), `createdAt DESC`. */
  async getResearchTopics(): Promise<ResearchTopicDto[]> {
    const rows = await this.prisma.researchTopic.findMany({
      select: { id: true, topic: true, categoryId: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      id: row.id,
      topic: row.topic,
      categoryId: row.categoryId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** `addResearchTopic` (`ai.ts:53-63`). A bad `categoryId` is a 422 (DEV-011 class). */
  async addResearchTopic(dto: AddResearchTopicDto): Promise<AiSuccessDto> {
    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
        select: { id: true },
      });
      if (!category) {
        throw new UnprocessableEntityException({
          message: ['categoryId: does not reference an existing category'],
        });
      }
    }
    await this.prisma.researchTopic.create({
      data: {
        topic: dto.topic,
        categoryId: dto.categoryId ?? null,
        status: 'pending',
        createdAt: new Date(),
      },
    });
    return { success: true };
  }

  /** `deleteResearchTopic` (`ai.ts:65-70`). */
  async deleteResearchTopic(id: string): Promise<AiSuccessDto> {
    await this.prisma.researchTopic.deleteMany({ where: { id } });
    return { success: true };
  }

  /** `markTopicAsProcessed` (`ai.ts:72-85`): flips the pending topic with that text. */
  async markTopicAsProcessed(topic: string): Promise<AiSuccessDto> {
    const pending = await this.prisma.researchTopic.findFirst({
      where: { status: 'pending', topic },
      select: { id: true },
    });
    if (pending) {
      await this.prisma.researchTopic.update({
        where: { id: pending.id },
        data: { status: 'processed' },
      });
    }
    return { success: true };
  }

  /** `clearAllPendingTopics` (`ai.ts:87-98`). */
  async clearAllPendingTopics(): Promise<ClearTopicsResultDto> {
    const result = await this.prisma.researchTopic.deleteMany({
      where: { status: 'pending' },
    });
    return { success: true, deleted: result.count };
  }

  /* ───────────────────────────── schedules ───────────────────────────── */

  /** `getSchedule` (`ai.ts:100-105`). */
  async getSchedule(): Promise<ScheduleDto[]> {
    const rows = await this.prisma.aiSchedule.findMany({ orderBy: { time: 'asc' } });
    return rows.map((row) => this.toScheduleDto(row));
  }

  /** `updateScheduleV2` (`ai.ts:107-127`): patch when `id`, insert when absent. */
  async updateScheduleV2(dto: UpdateScheduleV2Dto): Promise<AiSuccessDto> {
    const data = {
      daysOfWeek: dto.daysOfWeek,
      time: dto.time,
      timezone: dto.timezone,
      isActive: dto.isActive,
      topicsToResearch: dto.topicsToResearch,
    };
    if (dto.id) {
      const existing = await this.prisma.aiSchedule.findUnique({
        where: { id: dto.id },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Schedule not found');
      await this.prisma.aiSchedule.update({ where: { id: dto.id }, data });
    } else {
      // DEV-051: the frozen `lastRun: 0` sentinel maps to `null` ("never run").
      await this.prisma.aiSchedule.create({ data: { ...data, lastRun: null } });
    }
    return { success: true };
  }

  /** `getPendingSchedules` (`ai.ts:129-227`). See {@link isDue}. */
  async getPendingSchedules(): Promise<ScheduleDto[]> {
    const schedules = await this.prisma.aiSchedule.findMany({
      where: { isActive: true },
    });
    const now = new Date();
    return schedules
      .filter((schedule) => isScheduleDue(schedule, now))
      .map((schedule) => this.toScheduleDto(schedule));
  }

  /** `updateLastRun` (`ai.ts:229-234`): `lastRun = now` (DEV-051 `DateTime`). */
  async updateLastRun(dto: UpdateLastRunDto): Promise<AiSuccessDto> {
    const existing = await this.prisma.aiSchedule.findUnique({
      where: { id: dto.id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Schedule not found');
    await this.prisma.aiSchedule.update({
      where: { id: dto.id },
      data: { lastRun: new Date() },
    });
    return { success: true };
  }

  /** `deleteSchedule` (`ai.ts:294-299`). */
  async deleteSchedule(id: string): Promise<AiSuccessDto> {
    await this.prisma.aiSchedule.deleteMany({ where: { id } });
    return { success: true };
  }

  /* ───────────────────────────── drafts ───────────────────────────── */

  /** `listAIDrafts` (`ai.ts:301-310`): `status='draft'` AND `source='ai'`, desc. */
  async listAIDrafts() {
    const rows = await this.prisma.article.findMany({
      where: { status: 'draft', source: 'ai' },
      include: ARTICLE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toArticleDetail);
  }

  /* ───────────────────────────── generate ───────────────────────────── */

  /**
   * `processScheduleCheck` (`ai.ts:236-270`) — internal only (DEV-049/S-011).
   * Reads settings (bailing when inactive/keyless), generates per due topic,
   * advances `lastRun`, and always clears `isWriting` in `finally`. A failure on
   * one topic does **not** abort the batch.
   */
  async processScheduleCheck(): Promise<ProcessScheduleResultDto> {
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.isActive || !settings.apiKey) {
      return { processed: 0, generated: 0, failed: 0, skipped: true };
    }

    const pending = await this.getPendingSchedules();
    if (pending.length === 0) {
      return { processed: 0, generated: 0, failed: 0, skipped: true };
    }

    let generated = 0;
    let failed = 0;
    await this.setWritingStatus({ isWriting: true });
    try {
      for (const schedule of pending) {
        for (const topic of schedule.topicsToResearch) {
          try {
            await this.generateArticle({ settings, topic });
            generated += 1;
          } catch {
            // Per-topic failure is contained; the batch continues.
            failed += 1;
          }
        }
        await this.updateLastRun({ id: schedule.id });
      }
    } finally {
      await this.setWritingStatus({ isWriting: false });
    }
    return { processed: pending.length, generated, failed, skipped: false };
  }

  /** `runSingleResearch` (`ai.ts:272-292`): admin + billed. 422 when keyless. */
  async runSingleResearch(dto: RunSingleResearchDto): Promise<AiSuccessDto> {
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.apiKey) {
      throw new UnprocessableEntityException({ message: ['AI Settings not configured'] });
    }
    await this.setWritingStatus({ isWriting: true });
    try {
      await this.generateArticle({ settings, topic: dto.topic });
    } finally {
      await this.setWritingStatus({ isWriting: false });
    }
    return { success: true };
  }

  /* ───────────────────────────── ai_actions ───────────────────────────── */

  /** `fetchModels` (`ai_actions.ts:7-70`). Transient key allowed (DEV-053). */
  async fetchModels(dto: FetchModelsDto): Promise<string[]> {
    const apiKey = await this.resolveTransientKey(dto.apiKey);
    return this.provider.fetchModels(dto.provider, apiKey);
  }

  /** `testConnection` (`ai_actions.ts:72-134`). Transient key allowed (DEV-053). */
  async testConnection(dto: TestConnectionDto): Promise<ConnectionResultDto> {
    let apiKey: string | null;
    try {
      apiKey = await this.resolveTransientKey(dto.apiKey);
    } catch {
      return { success: false, message: 'AI provider key is not configured' };
    }
    return this.provider.testConnection(dto.provider, apiKey, dto.model);
  }

  /** `generateContent` (`ai_actions.ts:136-218`), key read server-side (DEV-053). */
  async generateContent(dto: GenerateContentDto): Promise<string> {
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.apiKey) {
      throw new UnprocessableEntityException({ message: ['AI Settings not configured'] });
    }
    return this.provider.generateContent({
      provider: dto.provider,
      model: dto.model,
      prompt: dto.prompt,
      systemPrompt: dto.systemPrompt,
      apiKey: settings.apiKey,
    });
  }

  /**
   * `generateArticleFromTopic` (`ai_actions.ts:220-291`): generate, parse,
   * validate, then reuse the Phase 05 `saveAIDraft` writer + `markTopicAsProcessed`.
   * Key server-side (DEV-053); malformed output is a 422.
   */
  async generateArticleFromTopic(
    dto: GenerateArticleFromTopicDto,
  ): Promise<AiSuccessDto> {
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.apiKey) {
      throw new UnprocessableEntityException({ message: ['AI Settings not configured'] });
    }

    const config = AI_CONFIG.articleGeneration;
    const prompt = config.userPrompt(dto.topic, dto.systemPrompt);
    const response = await this.provider.generateContent({
      provider: dto.provider,
      model: dto.model,
      prompt,
      systemPrompt: config.systemPrompt,
      apiKey: settings.apiKey,
    });

    const draft = parseArticleDraft(response);
    await this.articles.saveAIDraft(randomUUID(), {
      title: draft.title,
      content: draft.content,
      excerpt: draft.excerpt,
      pillar: draft.pillar,
      topics: draft.topics,
      type: draft.type,
      topic: dto.topic,
      metaTitle: draft.metaTitle,
      metaDescription: draft.metaDescription,
      focusKeyword: draft.focusKeyword,
    });
    await this.markTopicAsProcessed(dto.topic);
    return { success: true };
  }

  /** `learnAuthorStyle` (`ai_actions.ts:292-320`): samples the featured read. */
  async learnAuthorStyle(dto: LearnAuthorStyleDto): Promise<string> {
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.apiKey) {
      throw new UnprocessableEntityException({ message: ['AI Settings not configured'] });
    }
    const articles = await this.articles.getFeatured({ limit: 3 });
    if (articles.length === 0) {
      throw new UnprocessableEntityException({ message: ['No articles found to learn style from'] });
    }
    const contentSample = articles
      .map((a) => `TITLE: ${a.title}\nCONTENT: ${a.excerpt?.substring(0, 1000) ?? ''}`)
      .join('\n\n---\n\n');
    const config = AI_CONFIG.authorAnalysis;
    return this.provider.generateContent({
      provider: dto.provider,
      model: dto.model,
      prompt: config.userPrompt(contentSample),
      systemPrompt: config.systemPrompt,
      apiKey: settings.apiKey,
    });
  }

  /** `shuffleTopics` (`ai_actions.ts:322-362`): parses `{suggestions}` (422 on malformed). */
  async shuffleTopics(dto: ShuffleTopicsDto): Promise<ShuffleSuggestionDto[]> {
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.apiKey) {
      throw new UnprocessableEntityException({ message: ['AI Settings not configured'] });
    }
    const categories = await this.categories.listAll();
    if (categories.length === 0) {
      throw new UnprocessableEntityException({ message: ['No categories found'] });
    }
    const catNames = categories.map((c) => c.name).join(', ');
    const config = AI_CONFIG.topicSuggestions;
    const response = await this.provider.generateContent({
      provider: dto.provider,
      model: dto.model,
      prompt: config.userPrompt(catNames),
      systemPrompt: config.systemPrompt,
      apiKey: settings.apiKey,
    });

    const parsed = parseJsonObject(response);
    const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
    return suggestions.filter(isRecord).map((s) => ({
      topic: typeof s.topic === 'string' ? s.topic : '',
      categoryName: typeof s.categoryName === 'string' ? s.categoryName : '',
      seoReasoning: typeof s.seoReasoning === 'string' ? s.seoReasoning : '',
    }));
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  /** Generate a validated draft and persist it through the Phase 05 writer. */
  private async generateArticle(input: {
    settings: SettingsWithKey;
    topic: string;
  }): Promise<void> {
    await this.generateArticleFromTopic({
      provider: input.settings.provider,
      model: input.settings.model,
      topic: input.topic,
      systemPrompt: input.settings.promptTemplate ?? undefined,
    });
  }

  /** Server-side key source for the billed path — never returned (DEV-053/DEV-015). */
  private loadSettingsWithKey(): Promise<SettingsWithKey | null> {
    return this.prisma.aiSettings.findFirst({
      select: {
        id: true,
        provider: true,
        apiKey: true,
        model: true,
        promptTemplate: true,
        isActive: true,
      },
    });
  }

  /** Transient body key, else the stored key (DEV-053: test routes only). */
  private async resolveTransientKey(transient: string | undefined): Promise<string> {
    if (transient !== undefined && transient.length > 0) return transient;
    const settings = await this.loadSettingsWithKey();
    if (!settings || !settings.apiKey) {
      throw new UnprocessableEntityException({ message: ['AI provider key is not configured'] });
    }
    return settings.apiKey;
  }

  private toScheduleDto(row: {
    id: string;
    daysOfWeek: number[];
    time: string;
    timezone: string;
    isActive: boolean;
    lastRun: Date | null;
    topicsToResearch: string[];
  }): ScheduleDto {
    return {
      id: row.id,
      daysOfWeek: row.daysOfWeek,
      time: row.time,
      timezone: row.timezone,
      isActive: row.isActive,
      lastRun: row.lastRun ? row.lastRun.toISOString() : null,
      topicsToResearch: row.topicsToResearch,
    };
  }
}

/* ───────────────────────────── pure helpers ───────────────────────────── */

/**
 * The frozen `getPendingSchedules` filter (`ai.ts:150-225`), ported exactly:
 * shorthand tz map → IANA, day-of-week check, 15-minute window, and
 * "not already run today in this timezone". `lastRun` null/0 ⇒ never run.
 */
function isScheduleDue(
  schedule: {
    id: string;
    time: string;
    timezone: string;
    daysOfWeek: number[];
    lastRun: Date | null;
  },
  now: Date,
): boolean {
  const ianaTz = TIMEZONE_SHORTHANDS[schedule.timezone] ?? 'UTC';
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTz,
      hour12: false,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    const partsMap = formatParts(formatter, now);

    const dayName = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTz,
      weekday: 'long',
    }).format(now);
    const currentLocalDay = DAY_NAMES[dayName];
    if (currentLocalDay === undefined) return false;

    const currentLocalHour = Number.parseInt(partsMap.hour ?? '0', 10);
    const currentLocalMinute = Number.parseInt(partsMap.minute ?? '0', 10);
    const [scheduledHour, scheduledMinute] = schedule.time.split(':').map(Number);
    if (!Number.isFinite(scheduledHour) || !Number.isFinite(scheduledMinute)) {
      return false;
    }

    if (!schedule.daysOfWeek.includes(currentLocalDay)) return false;

    const scheduledTotalMinutes = scheduledHour * 60 + scheduledMinute;
    const currentTotalMinutes = currentLocalHour * 60 + currentLocalMinute;
    const isTime =
      currentTotalMinutes >= scheduledTotalMinutes &&
      currentTotalMinutes < scheduledTotalMinutes + WINDOW_MINUTES;
    if (!isTime) return false;

    // DEV-051: null (frozen 0) means "never run".
    if (schedule.lastRun === null) return true;

    const lastRunParts = formatParts(formatter, schedule.lastRun);
    const isAlreadyRunToday =
      lastRunParts.year === partsMap.year &&
      lastRunParts.month === partsMap.month &&
      lastRunParts.day === partsMap.day;
    return !isAlreadyRunToday;
  } catch {
    return false;
  }
}

function formatParts(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  return map;
}

/** Extract the first JSON object from a model response (frozen `/\{[\s\S]*\}/`). */
function parseJsonObject(response: string): Record<string, unknown> {
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new UnprocessableEntityException({ message: ['No JSON object found in AI response'] });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new UnprocessableEntityException({ message: ['AI response was not valid JSON'] });
  }
  if (!isRecord(parsed)) {
    throw new UnprocessableEntityException({ message: ['AI response was not a JSON object'] });
  }
  return parsed;
}

/** Validate + normalise a generated article (frozen required-field checks). */
function parseArticleDraft(response: string): ParsedArticleDraft {
  const data = parseJsonObject(response);

  const title = nonEmptyString(data.title);
  const content = nonEmptyString(data.content);
  const excerpt = nonEmptyString(data.excerpt);
  if (title === null) {
    throw new UnprocessableEntityException({ message: ['AI response missing required field: title'] });
  }
  if (content === null) {
    throw new UnprocessableEntityException({ message: ['AI response missing required field: content'] });
  }
  if (excerpt === null) {
    throw new UnprocessableEntityException({ message: ['AI response missing required field: excerpt'] });
  }

  const rawType = String(data.type ?? '').toLowerCase();
  const type: AiArticleType = (AI_ARTICLE_TYPES as readonly string[]).includes(rawType)
    ? (rawType as AiArticleType)
    : 'cluster';

  return {
    title,
    content,
    excerpt,
    pillar: data.pillar ? String(data.pillar) : undefined,
    topics: Array.isArray(data.topics) ? data.topics.map(String) : [],
    type,
    metaTitle: data.metaTitle ? String(data.metaTitle) : undefined,
    metaDescription: data.metaDescription ? String(data.metaDescription) : undefined,
    focusKeyword: data.focusKeyword ? String(data.focusKeyword) : undefined,
  };
}
