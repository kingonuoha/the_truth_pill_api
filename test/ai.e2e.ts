/**
 * Phase 08 AI-module e2e suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (global default-deny `JwtAuthGuard` + `RolesGuard`)
 * and exercises the frozen 22-function AI surface across its guard groups:
 * the S-010 / DEV-048 `getSettings` projection (recursive key-walk finds no
 * `apiKey`), the write-only `updateSettings` retention (no second sentinel row,
 * DEV-052), the DEV-049 internal `processScheduleCheck` (public path 404,
 * secret required), the DEV-049 per-admin billed throttle (429 on burst), the
 * DEV-051 `lastRun` `0`→`null` mapping, the DEV-053 server-side key sourcing
 * (a body `apiKey` on a billed route is 400), and dev-DB hygiene.
 *
 * ⚠️ Writes to the dev Neon branch. Every fixture carries a unique
 * `p08-ai-<stamp>` marker. Live provider calls are stubbed via the injectable
 * `HttpAiProviderClient` (⏳ PENDING — no key round-trip). Every created row is
 * deleted at teardown, and the `aiSettings` singleton is snapshotted/restored.
 * `generateArticleFromTopic` writes through `saveAIDraft`, which bumps
 * `globalStats` (articleCount/draftArticleCount/aiDraftCount) and
 * `Category.articleCount`; both are snapshotted at suite start and restored
 * BEFORE fixture deletion so the shared counters cannot drift (Phase 05/07
 * lesson). Run: `npm run test:ai`.
 */
import 'reflect-metadata';
import './test-env';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { configureApp } from '../src/infra/bootstrap/bootstrap';
import { AppModule } from '../src/infra/app.module';
import { TokenService } from '../src/modules/auth/token.service';
import { AiService } from '../src/modules/ai/ai.service';
import { HttpAiProviderClient } from '../src/modules/ai/ai-provider.client';
import { TEST_INTERNAL_JOB_SECRET } from './test-env';

/**
 * Stubs the provider client so no live LLM call is made (⏳ PENDING). Every
 * method returns deterministic output; the key argument is never asserted on or
 * printed (DEV-015).
 */
class StubProviderClient {
  generateContentCalls = 0;

  async fetchModels(): Promise<string[]> {
    return ['gpt-stub', 'o1-stub'];
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    return { success: true, message: 'stub connection successful' };
  }

  async generateContent(): Promise<string> {
    this.generateContentCalls += 1;
    return JSON.stringify({
      title: 'Stub Title',
      content: '<p>Stub content</p>',
      excerpt: 'Stub excerpt',
      topics: ['stub-topic'],
      type: 'cluster',
    });
  }
}

@Module({ imports: [AppModule] })
class TestAppModule {}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseResponse(response: Response, text: string): HttpResult {
  let body: unknown;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text };
}

/** One retry on a bare 500: the Neon dev branch scale-to-zero resume flakes. */
async function request(url: string, init?: RequestInit): Promise<HttpResult> {
  let response = await fetch(url, init);
  let text = await response.text();
  if (response.status === 500) {
    await sleep(1_500);
    response = await fetch(url, init);
    text = await response.text();
  }
  return parseResponse(response, text);
}

const send = (
  url: string,
  method: string,
  payload?: unknown,
  headers?: Record<string, string>,
): Promise<HttpResult> =>
  request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const base = `${await app.getUrl()}/api/v1`;
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);

  // Swap in the stub provider (live calls ⏳ PENDING) via the module export.
  const stub = new StubProviderClient();
  const aiService = app.get(AiService);
  // The provider is a constructor dependency; replace the resolved instance.
  const providerToken = HttpAiProviderClient;
  const container = app as unknown as {
    get: (token: unknown) => unknown;
    getHttpAdapter?: unknown;
  };
  void providerToken;
  void container;
  // Nest's module ref allows overriding an existing provider via `overrideProvider`
  // only before instantiation; instead, re-point the service's reference for the
  // duration of the suite. The service field is private, so inject through the
  // public generate path by monkey-patching the prototype method.
  const originalGenerate = HttpAiProviderClient.prototype.generateContent;
  const originalFetchModels = HttpAiProviderClient.prototype.fetchModels;
  const originalTest = HttpAiProviderClient.prototype.testConnection;
  HttpAiProviderClient.prototype.generateContent = stub.generateContent.bind(stub);
  HttpAiProviderClient.prototype.fetchModels = stub.fetchModels.bind(stub);
  HttpAiProviderClient.prototype.testConnection = stub.testConnection.bind(stub);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const marker = `p08-ai-${stamp}`;
  const addr = (tag: string): string => `${marker}-${tag}@example.test`;
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const internal = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET };

  const createdUserIds = new Set<string>();
  const createdScheduleIds = new Set<string>();
  const createdTopicIds = new Set<string>();
  const createdArticleIds = new Set<string>();
  let pass = 0;
  let fail = 0;

  const check = (name: string, condition: boolean): void => {
    if (condition) {
      pass += 1;
      console.log(`  ok   ${name}`);
    } else {
      fail += 1;
      console.log(`  FAIL ${name}`);
    }
  };

  const mkUser = async (tag: string, role: 'admin' | 'user'): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        name: `P08 ${tag}`,
        email: addr(tag),
        provider: 'email',
        role,
        newsletterSubscribed: false,
        createdAt: new Date(),
      },
      select: { id: true },
    });
    createdUserIds.add(user.id);
    return user.id;
  };

  const settingsBefore = await prisma.aiSettings.findFirst();

  /* ─────────────────────── shared-state snapshot (Phase 08) ─────────────────────── */
  // `generateArticleFromTopic` reuses `saveAIDraft`, which applies an atomic
  // `articleCount +1 / draftArticleCount +1 / aiDraftCount +1` delta and
  // increments `Category.articleCount`. Snapshot both before any fixture so the
  // teardown restore returns the pre-run baseline instead of preserving drift.
  const gsBefore = await prisma.globalStats.findUnique({ where: { id: 'global_stats' } });
  if (!gsBefore) throw new Error('globalStats row is missing — cannot run the AI e2e');
  const categoriesBefore = await prisma.category.findMany({
    select: { id: true, articleCount: true },
  });

  const adminId = await mkUser('admin', 'admin');
  const memberId = await mkUser('member', 'user');
  const admin = tokens.sign(adminId).token;
  const member = tokens.sign(memberId).token;

  try {
    /* ─────────────── 1. getSettings projection + admin gate (S-010/DEV-048) ─────────────── */

    const anonSettings = await send(`${base}/ai/settings`, 'GET');
    check('DEV-048: GET /ai/settings anonymous -> 401 (was a public query)', anonSettings.status === 401);

    const memberSettings = await send(`${base}/ai/settings`, 'GET', undefined, auth(member));
    check('DEV-048: GET /ai/settings member -> 403', memberSettings.status === 403);

    const adminSettings = await send(`${base}/ai/settings`, 'GET', undefined, auth(admin));
    check('DEV-048: GET /ai/settings admin -> 200', adminSettings.status === 200);
    const settingsKeys = collectKeys(adminSettings.body);
    check('DEV-048/S-010: recursive key-walk finds no apiKey', !settingsKeys.has('apiKey'));
    check('DEV-048: response exposes hasApiKey boolean only', settingsKeys.has('hasApiKey'));
    check('DEV-048: no secret string appears in the settings body', !adminSettings.text.includes('apiKey'));

    /* ─────────────── 2. updateSettings write-only + sentinel singleton (DEV-048/DEV-052) ─────────────── */

    const rowCountBefore = await prisma.aiSettings.count();
    const updateOne = await send(
      `${base}/ai/update-settings`,
      'PATCH',
      { provider: 'gemini', model: 'stub-model', isActive: true },
      auth(admin),
    );
    check('DEV-048: updateSettings without a key -> 200', updateOne.status === 200);
    check('DEV-048: updateSettings response carries no apiKey', !updateOne.text.includes('apiKey'));

    const updateTwo = await send(
      `${base}/ai/update-settings`,
      'PATCH',
      { provider: 'gemini', model: 'stub-model-2', isActive: true },
      auth(admin),
    );
    check('DEV-052: second updateSettings -> 200', updateTwo.status === 200);
    const rowCountAfter = await prisma.aiSettings.count();
    check('DEV-052: two updates leave exactly one aiSettings row (findFirst, no literal-id insert)', rowCountAfter === rowCountBefore && rowCountAfter === 1);

    // The stored key was retained across an update with no key field (DEV-048).
    const keyRows = await prisma.$queryRaw<Array<{ len: number }>>`
      SELECT length("apiKey") AS len FROM "aiSettings" LIMIT 1`;
    check('DEV-048: updateSettings with no key retains a non-empty stored key (length-only)', (keyRows[0]?.len ?? 0) > 0);

    /* ─────────────── 3. research-topic CRUD parity ─────────────── */

    const anonTopics = await send(`${base}/ai/research-topics`, 'GET');
    check('matrix: GET /ai/research-topics anonymous -> 401', anonTopics.status === 401);

    const addTopic = await send(`${base}/ai/add-research-topic`, 'PATCH', { topic: `${marker}-topic` }, auth(admin));
    check('addResearchTopic: -> 200', addTopic.status === 200);
    const topicRow = await prisma.researchTopic.findFirst({ where: { topic: `${marker}-topic` }, select: { id: true, status: true } });
    assert.ok(topicRow);
    createdTopicIds.add(topicRow.id);
    check('addResearchTopic: inserted with status pending', topicRow.status === 'pending');

    const topics = await send(`${base}/ai/research-topics`, 'GET', undefined, auth(admin));
    check('getResearchTopics: -> 200 array', topics.status === 200 && Array.isArray(topics.body));

    const mark = await send(`${base}/ai/mark-topic-as-processed`, 'PATCH', { topic: `${marker}-topic` }, auth(admin));
    check('markTopicAsProcessed: -> 200', mark.status === 200);
    const topicAfter = await prisma.researchTopic.findUnique({ where: { id: topicRow.id }, select: { status: true } });
    check('markTopicAsProcessed: pending -> processed', topicAfter?.status === 'processed');

    const delTopic = await send(`${base}/ai/delete-research-topic?id=${topicRow.id}`, 'DELETE', undefined, auth(admin));
    check('deleteResearchTopic: -> 200', delTopic.status === 200);
    createdTopicIds.delete(topicRow.id);

    /* ─────────────── 4. schedule insert maps lastRun 0 -> null (DEV-051) ─────────────── */

    const insertSchedule = await send(
      `${base}/ai/update-schedule-v2`,
      'PATCH',
      { daysOfWeek: [1], time: '08:00', timezone: 'UTC', isActive: false, topicsToResearch: [`${marker}-sched-topic`] },
      auth(admin),
    );
    check('updateScheduleV2: insert -> 200', insertSchedule.status === 200);
    const schedRow = await prisma.aiSchedule.findFirst({ where: { topicsToResearch: { has: `${marker}-sched-topic` } }, select: { id: true, lastRun: true } });
    assert.ok(schedRow);
    createdScheduleIds.add(schedRow.id);
    check('DEV-051: inserted schedule lastRun is null (frozen 0 mapped)', schedRow.lastRun === null);

    const updateLastRun = await send(`${base}/ai/update-last-run`, 'PATCH', { id: schedRow.id }, auth(admin));
    check('DEV-051: update-last-run -> 200', updateLastRun.status === 200);
    const schedAfter = await prisma.aiSchedule.findUnique({ where: { id: schedRow.id }, select: { lastRun: true } });
    check('DEV-051: updateLastRun writes a real DateTime', schedAfter?.lastRun instanceof Date);

    const schedules = await send(`${base}/ai/schedule`, 'GET', undefined, auth(admin));
    check('getSchedule: -> 200 array', schedules.status === 200 && Array.isArray(schedules.body));

    const pendingSchedules = await send(`${base}/ai/pending-schedules`, 'GET', undefined, auth(admin));
    check('getPendingSchedules: -> 200 array', pendingSchedules.status === 200 && Array.isArray(pendingSchedules.body));

    const delSchedule = await send(`${base}/ai/delete-schedule?id=${schedRow.id}`, 'DELETE', undefined, auth(admin));
    check('deleteSchedule: -> 200', delSchedule.status === 200);
    createdScheduleIds.delete(schedRow.id);

    /* ─────────────── 5. processScheduleCheck internal only (S-011/DEV-049) ─────────────── */

    const publicPath = await send(`${base}/ai/process-schedule-check`, 'POST', {});
    check('DEV-049/S-011: public /ai/process-schedule-check -> 404 (path removed)', publicPath.status === 404);

    const internalNoSecret = await send(`${base}/internal/ai/process-schedule-check`, 'POST', {});
    check('DEV-049: internal without secret -> 401', internalNoSecret.status === 401);

    const internalWrong = await send(`${base}/internal/ai/process-schedule-check`, 'POST', {}, { 'x-internal-secret': 'nope' });
    check('DEV-049: internal wrong secret -> 401', internalWrong.status === 401);

    await prisma.aiSettings.updateMany({ data: { isActive: false } });
    const internalOk = await send(`${base}/internal/ai/process-schedule-check`, 'POST', {}, internal);
    check('DEV-049: internal with secret -> 200 (inactive settings => skipped)', internalOk.status === 200);

    /* ─────────────── 6. billed actions admin-gated + throttled (DEV-049/DEV-053) ─────────────── */

    const anonModels = await send(`${base}/ai-actions/models`, 'POST', { provider: 'openai' });
    check('matrix: POST /ai-actions/models anonymous -> 401', anonModels.status === 401);
    const memberModels = await send(`${base}/ai-actions/models`, 'POST', { provider: 'openai' }, auth(member));
    check('matrix: POST /ai-actions/models member -> 403', memberModels.status === 403);

    const adminModels = await send(`${base}/ai-actions/models`, 'POST', { provider: 'openai' }, auth(admin));
    check('fetchModels: admin -> 200 array', adminModels.status === 200 && Array.isArray(adminModels.body));

    // DEV-053: a body carrying apiKey on the billed generation path is a 400.
    const clientKeyBody = await send(
      `${base}/ai-actions/generate-content`,
      'POST',
      { provider: 'openai', model: 'stub', prompt: 'hi', apiKey: 'attacker-key' },
      auth(admin),
    );
    check('DEV-053: client apiKey on generate-content -> 400 (deleted field)', clientKeyBody.status === 400);

    // The throttled billed routes are keyed per admin sub (10/60s -> 429).
    const burst = await Promise.all(
      Array.from({ length: 12 }, () =>
        send(`${base}/ai-actions/test-connection`, 'POST', { provider: 'openai', model: 'stub' }, auth(admin)),
      ),
    );
    const throttled = burst.filter((r) => r.status === 429).length;
    check('DEV-049: a burst over 10/60s yields at least one 429', throttled >= 1);
    const ok200 = burst.filter((r) => r.status === 200).length;
    check('DEV-049: at most 10 billed calls pass in the window', ok200 <= 10);

    /* ─────────────── 7. generateArticleFromTopic reuses saveAIDraft + marks the topic ─────────────── */

    // A fresh admin: the burst above exhausted the first admin's billed window.
    const genAdminId = await mkUser('genadmin', 'admin');
    const genAdmin = tokens.sign(genAdminId).token;
    const genTopic = `${marker}-gen-topic`;
    await prisma.researchTopic.create({
      data: { topic: genTopic, status: 'pending', createdAt: new Date() },
      select: { id: true },
    });
    const genTopicRow = await prisma.researchTopic.findFirst({ where: { topic: genTopic }, select: { id: true } });
    if (genTopicRow) createdTopicIds.add(genTopicRow.id);

    const gen = await send(
      `${base}/ai-actions/generate-article-from-topic`,
      'POST',
      { provider: 'gemini', model: 'stub', topic: genTopic },
      auth(genAdmin),
    );
    check('DEV-053: generateArticleFromTopic (server-side key) -> 200', gen.status === 200);
    const genAfter = await prisma.researchTopic.findFirst({ where: { topic: genTopic }, select: { status: true } });
    check('generateArticleFromTopic: markTopicAsProcessed applied', genAfter?.status === 'processed');
    const draft = await prisma.article.findFirst({ where: { title: 'Stub Title', source: 'ai', status: 'draft' }, select: { id: true } });
    check('generateArticleFromTopic: a draft row was written via saveAIDraft', draft !== null);
    if (draft) {
      createdArticleIds.add(draft.id);
    }

    /* ─────────────── 8. aidrafts read ─────────────── */

    const anonDrafts = await send(`${base}/ai/aidrafts`, 'GET');
    check('matrix: GET /ai/aidrafts anonymous -> 401', anonDrafts.status === 401);
    const drafts = await send(`${base}/ai/aidrafts`, 'GET', undefined, auth(admin));
    check('listAIDrafts: admin -> 200 array', drafts.status === 200 && Array.isArray(drafts.body));

    /* ─────────────── 9. runSingleResearch admin + billed ─────────────── */

    const anonRun = await send(`${base}/ai/run-single-research`, 'POST', { topic: 'x' });
    check('matrix: POST /ai/run-single-research anonymous -> 401', anonRun.status === 401);
    const memberRun = await send(`${base}/ai/run-single-research`, 'POST', { topic: 'x' }, auth(member));
    check('matrix: POST /ai/run-single-research member -> 403', memberRun.status === 403);
  } finally {
    // Restore prototype methods and the singleton so the dev DB is unchanged.
    HttpAiProviderClient.prototype.generateContent = originalGenerate;
    HttpAiProviderClient.prototype.fetchModels = originalFetchModels;
    HttpAiProviderClient.prototype.testConnection = originalTest;

    // ── shared-state restore FIRST (before fixture deletes) ──────────────
    // `saveAIDraft` bumped globalStats + Category.articleCount; put both back
    // exactly as they were before the run touched them.
    await prisma.globalStats.update({
      where: { id: 'global_stats' },
      data: {
        articleCount: gsBefore.articleCount,
        publishedArticleCount: gsBefore.publishedArticleCount,
        draftArticleCount: gsBefore.draftArticleCount,
        scheduledArticleCount: gsBefore.scheduledArticleCount,
        aiDraftCount: gsBefore.aiDraftCount,
        usersCount: gsBefore.usersCount,
        commentsCount: gsBefore.commentsCount,
        pendingCommentsCount: gsBefore.pendingCommentsCount,
        totalViews: gsBefore.totalViews,
        totalUniqueViews: gsBefore.totalUniqueViews,
        updatedAt: gsBefore.updatedAt,
      },
    });
    for (const category of categoriesBefore) {
      await prisma.category.update({
        where: { id: category.id },
        data: { articleCount: category.articleCount },
      });
    }

    if (settingsBefore) {
      await prisma.aiSettings.updateMany({
        data: {
          provider: settingsBefore.provider,
          model: settingsBefore.model,
          promptTemplate: settingsBefore.promptTemplate,
          isActive: settingsBefore.isActive,
          isWriting: settingsBefore.isWriting,
        },
      });
    }
    for (const id of createdScheduleIds) await prisma.aiSchedule.deleteMany({ where: { id } });
    for (const id of createdTopicIds) await prisma.researchTopic.deleteMany({ where: { id } });
    await prisma.researchTopic.deleteMany({ where: { topic: { startsWith: marker } } });
    await prisma.aiSchedule.deleteMany({ where: { topicsToResearch: { has: `${marker}-sched-topic` } } });
    await prisma.emailQueue.deleteMany({ where: { recipient: { contains: marker } } });
    for (const id of createdArticleIds) await prisma.article.deleteMany({ where: { id } });
    await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
    void aiService;
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  await app.close();
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
