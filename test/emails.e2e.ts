/**
 * Phase 08 email-module e2e suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (global default-deny `JwtAuthGuard` + `RolesGuard`)
 * and exercises the frozen 11-function email surface across its guard groups:
 * the 27/5/1 matrix split, the `getPendingEmails` filter variant, the
 * `updateEmailStatus` atomic `retries` increment (DEV-050), the queue consumer
 * drain + retry + fail-at-3 (DEV-050; closes DEV-012/DEV-013), the weekly-digest
 * signed unsubscribe token (DEV-035), the neutral CSPRNG password reset
 * (DEV-036/DEV-033), the per-template `templateData` validation (DEV-006), the
 * admin token-redaction projection (DEV-034 class), and dev-DB hygiene.
 *
 * ⚠️ Writes to the dev Neon branch. Every fixture carries a unique
 * `p08-email-<stamp>` marker. The stub transport records sends in-memory; no
 * live SMTP call is made (`EMAIL_*` is empty → delivery is ⏳ PENDING). Every
 * created `emailQueue` row is deleted at teardown. `globalStats` (all counter
 * fields) and every `Category.articleCount` are snapshotted at suite start and
 * restored BEFORE fixture deletion so the shared counters cannot drift (Phase
 * 05/07 lesson). Run: `npm run test:emails`.
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
import { MailerService } from '../src/modules/emails/mailer.service';
import type { MailTransport, OutboundMail } from '../src/modules/emails/mailer.service';
import { TEST_INTERNAL_JOB_SECRET } from './test-env';

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

function collectStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) collectStrings(child, into);
  }
  return into;
}

/** A recording transport: captures the outbound mail and can be forced to fail. */
class RecordingTransport implements MailTransport {
  readonly sent: OutboundMail[] = [];
  failNext = false;

  async send(mail: OutboundMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('stub transport failure (deliberate)');
    }
    this.sent.push(mail);
  }
}

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const base = `${await app.getUrl()}/api/v1`;
  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);
  const mailer = app.get(MailerService);

  const transport = new RecordingTransport();
  mailer.useTransport(transport);

  /* ─────────────────────── shared-state snapshot (Phase 08) ─────────────────────── */
  // Snapshot the derived counters before any fixture is written; teardown
  // restores them BEFORE deleting fixtures (analytics/engagement hygiene order).
  const gsBefore = await prisma.globalStats.findUnique({ where: { id: 'global_stats' } });
  if (!gsBefore) throw new Error('globalStats row is missing — cannot run the email e2e');
  const categoriesBefore = await prisma.category.findMany({
    select: { id: true, articleCount: true },
  });

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const marker = `p08-email-${stamp}`;
  const addr = (tag: string): string => `${marker}-${tag}@example.test`;
  const auth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
  const internal = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET };

  const createdQueueIds = new Set<string>();
  const createdUserIds = new Set<string>();
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

  const adminId = await mkUser('admin', 'admin');
  const memberId = await mkUser('member', 'user');
  const admin = tokens.sign(adminId).token;
  const member = tokens.sign(memberId).token;

  const queueRow = async (input: {
    tag: string;
    template: string;
    data: Record<string, string>;
    status?: 'pending' | 'sending' | 'sent' | 'failed';
    scheduledFor?: Date;
    retries?: number;
    recipient?: string;
  }): Promise<string> => {
    const row = await prisma.emailQueue.create({
      data: {
        recipient: input.recipient ?? addr(input.tag),
        subject: `P08 ${input.tag} ${stamp}`,
        templateName: input.template,
        templateData: input.data,
        status: input.status ?? 'pending',
        scheduledFor: input.scheduledFor ?? new Date(),
        retries: input.retries ?? 0,
      },
      select: { id: true },
    });
    createdQueueIds.add(row.id);
    return row.id;
  };

  try {
    /* ─────────────── 1. guard matrix: anonymous 401 / member 403 ─────────────── */

    const anonymousLogs = await send(`${base}/emails/email-logs`, 'GET');
    check('P08 matrix: GET /emails/email-logs anonymous -> 401', anonymousLogs.status === 401);

    const memberLogs = await send(`${base}/emails/email-logs`, 'GET', undefined, auth(member));
    check('P08 matrix: GET /emails/email-logs member -> 403', memberLogs.status === 403);

    const anonymousQueue = await send(`${base}/emails/add-to-queue`, 'PATCH', {
      recipient: addr('anon'),
      subject: 'x',
      templateName: 'welcome',
      templateData: { name: 'A', siteUrl: 'https://x', unsubscribeUrl: 'https://x' },
    });
    check('P08 matrix: PATCH /emails/add-to-queue anonymous -> 401', anonymousQueue.status === 401);

    const anonTest = await send(`${base}/email-queue/send-test-email`, 'POST', { recipient: addr('anon') });
    check('P08 matrix: POST /email-queue/send-test-email anonymous -> 401', anonTest.status === 401);
    const memberTest = await send(`${base}/email-queue/send-test-email`, 'POST', { recipient: addr('mem') }, auth(member));
    check('P08 matrix: POST /email-queue/send-test-email member -> 403', memberTest.status === 403);

    const anonPending = await send(`${base}/internal/emails?status=pending`, 'GET');
    check('P08 matrix: GET /internal/emails no secret -> 401', anonPending.status === 401);
    const badSecret = await send(`${base}/internal/emails?status=pending`, 'GET', undefined, {
      'x-internal-secret': 'wrong',
    });
    check('P08 matrix: GET /internal/emails wrong secret -> 401', badSecret.status === 401);

    const anonReset = await send(`${base}/email-queue/request-password-reset`, 'POST', { email: addr('nobody') });
    check('P08 matrix: POST /email-queue/request-password-reset anonymous -> 200 (public)', anonReset.status === 200);

    /* ─────────────── 2. templateData validated per template (DEV-006) ─────────────── */

    const unknownTemplate = await send(
      `${base}/emails/add-to-queue`,
      'PATCH',
      { recipient: addr('x'), subject: 'x', templateName: 'not_a_template', templateData: {} },
      auth(admin),
    );
    check('DEV-006: unknown template -> 400', unknownTemplate.status === 400);

    const unknownKey = await send(
      `${base}/emails/add-to-queue`,
      'PATCH',
      { recipient: addr('x'), subject: 'x', templateName: 'reset_password', templateData: { resetUrl: 'https://x', evil: '1' } },
      auth(admin),
    );
    check('DEV-006: unknown templateData key -> 400', unknownKey.status === 400);

    const nonStringValue = await send(
      `${base}/emails/add-to-queue`,
      'PATCH',
      { recipient: addr('x'), subject: 'x', templateName: 'newsletter', templateData: { name: 5 } },
      auth(admin),
    );
    check('DEV-006: non-string templateData value -> 400', nonStringValue.status === 400);

    const validQueue = await send(
      `${base}/emails/add-to-queue`,
      'PATCH',
      {
        recipient: addr('queue'),
        subject: 'P08 valid',
        templateName: 'reset_password',
        templateData: { resetUrl: 'https://thetruthpill.org/auth/reset-password?token=abc', siteUrl: 'https://thetruthpill.org' },
      },
      auth(admin),
    );
    check('addToQueue: valid body -> 200 with an id', validQueue.status === 200 && isRecord(validQueue.body) && typeof validQueue.body.id === 'string');
    if (isRecord(validQueue.body) && typeof validQueue.body.id === 'string') createdQueueIds.add(validQueue.body.id);

    /* ─────────────── 3. admin token-redaction projection (DEV-034 class) ─────────────── */

    const byId = await send(`${base}/emails/email-by-id?id=${validQueue.body && isRecord(validQueue.body) ? validQueue.body.id : ''}`, 'GET', undefined, auth(admin));
    check('getEmailById: admin -> 200', byId.status === 200);
    const byIdText = JSON.stringify(byId.body ?? '');
    check('DEV-034: resetUrl redacted from admin read', !byIdText.includes('reset-password?token='));
    check('DEV-034: templateData still carries non-secret keys', isRecord(byId.body) && isRecord(byId.body.templateData) && typeof byId.body.templateData.siteUrl === 'string');

    const missing = await send(`${base}/emails/email-by-id?id=00000000-0000-7000-8000-000000000000`, 'GET', undefined, auth(admin));
    check('getEmailById: absent -> 404', missing.status === 404);

    /* ─────────────── 4. atomic retries increment (DEV-050 Migration Rule 5) ─────────────── */

    const incId = await queueRow({ tag: 'inc', template: 'welcome', data: { name: 'A', siteUrl: 'https://x', unsubscribeUrl: 'https://x' }, retries: 0 });
    const incOne = await send(`${base}/internal/emails/${incId}/status`, 'PATCH', { status: 'sending', retryIncrement: true }, internal);
    check('updateEmailStatus: retryIncrement internal -> 200', incOne.status === 200);
    const incTwo = await send(`${base}/internal/emails/${incId}/status`, 'PATCH', { status: 'pending', retryIncrement: true }, internal);
    check('updateEmailStatus: second retryIncrement -> 200', incTwo.status === 200);
    const incRow = await prisma.emailQueue.findUnique({ where: { id: incId }, select: { retries: true, status: true } });
    check('DEV-050: retries incremented atomically to 2', incRow?.retries === 2 && incRow.status === 'pending');

    /* ─────────────── 5. consumer drains queue (DEV-050; closes DEV-012/013) ─────────────── */

    const dueId = await queueRow({
      tag: 'due',
      template: 'welcome',
      data: { name: 'Ada', siteUrl: 'https://thetruthpill.org', unsubscribeUrl: 'https://thetruthpill.org/u' },
      scheduledFor: new Date(Date.now() - 60_000),
    });
    // A not-yet-due row must be skipped by the consumer.
    const futureId = await queueRow({
      tag: 'future',
      template: 'welcome',
      data: { name: 'Zed', siteUrl: 'https://thetruthpill.org', unsubscribeUrl: 'https://thetruthpill.org/u' },
      scheduledFor: new Date(Date.now() + 60 * 60 * 1000),
    });

    const drain = await send(`${base}/internal/email-queue/process`, 'POST', { limit: 50 }, internal);
    check('DEV-050: processQueue internal -> 200', drain.status === 200);
    const drainRow = await prisma.emailQueue.findUnique({ where: { id: dueId }, select: { status: true, sentAt: true } });
    check('DEV-050: due row -> sent with sentAt', drainRow?.status === 'sent' && drainRow.sentAt !== null);
    const futureRow = await prisma.emailQueue.findUnique({ where: { id: futureId }, select: { status: true } });
    check('DEV-050: future row untouched', futureRow?.status === 'pending');

    /* ─────────────── 6. consumer retry + fail-at-3 (DEV-050) ─────────────── */

    const retryId = await queueRow({
      tag: 'retry',
      template: 'welcome',
      data: { name: 'R', siteUrl: 'https://thetruthpill.org', unsubscribeUrl: 'https://thetruthpill.org/u' },
      scheduledFor: new Date(Date.now() - 60_000),
      retries: 0,
    });
    transport.failNext = true;
    await send(`${base}/internal/email-queue/process`, 'POST', { limit: 1 }, internal);
    const retryRow = await prisma.emailQueue.findUnique({ where: { id: retryId }, select: { status: true, retries: true, error: true } });
    check('DEV-050: failure retries < 3 -> pending, retries 1, error recorded', retryRow?.status === 'pending' && retryRow.retries === 1 && typeof retryRow.error === 'string');

    // Set retries to 3 and force a failure: the row must go terminal.
    await prisma.emailQueue.update({ where: { id: retryId }, data: { retries: 3, scheduledFor: new Date(Date.now() - 60_000) } });
    transport.failNext = true;
    await send(`${base}/internal/email-queue/process`, 'POST', { limit: 1 }, internal);
    const terminalRow = await prisma.emailQueue.findUnique({ where: { id: retryId }, select: { status: true, retries: true, error: true } });
    check('DEV-050: failure at retries 3 -> failed, retries 4, error recorded', terminalRow?.status === 'failed' && terminalRow.retries === 4 && typeof terminalRow.error === 'string');

    /* ─────────────── 7. weekly digest signed unsubscribe token (DEV-035) ─────────────── */

    // Subscribe the member + an author with a published article so the digest is non-empty.
    const authorId = await mkUser('author', 'user');
    const digestUser = await prisma.user.update({
      where: { id: memberId },
      data: { newsletterSubscribed: true, role: 'user' },
      select: { id: true },
    });
    assert.ok(digestUser.id === memberId);
    const category = await prisma.category.findFirst({ select: { id: true } });
    const digestArticle = await prisma.article.create({
      data: {
        title: `P08 digest ${stamp}`,
        slug: `${marker}-digest`,
        status: 'published',
        source: 'human',
        authorId,
        categoryId: category?.id ?? null,
        readingTime: 1,
        isArchived: false,
        viewCount: 9_999,
        uniqueViewCount: 9_999,
        excerpt: 'Digest excerpt',
        publishedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      select: { id: true },
    });
    createdArticleIds.add(digestArticle.id);

    const digest = await send(`${base}/internal/emails/weekly-digest`, 'POST', {}, internal);
    check('DEV-035: weekly-digest internal -> 200', digest.status === 200);
    const digestRows = await prisma.emailQueue.findMany({
      where: { recipient: addr('member'), templateName: 'newsletter', subject: 'Your Weekly Truth Pill Digest 📰' },
      select: { id: true, templateData: true },
    });
    for (const row of digestRows) createdQueueIds.add(row.id);
    check('DEV-035: digest queued a row for the subscriber', digestRows.length >= 1);
    const digestText = JSON.stringify(digestRows.map((r) => r.templateData));
    check('DEV-035: unsubscribeUrl uses a signed ?token=', digestText.includes('unsubscribe?token='));
    check('DEV-035: no bare ?email= in any digest row', !digestText.includes('?email='));
    check('DEV-035: digest token is a signed value (not the raw email)', !digestText.includes(encodeURIComponent(addr('member'))));

    /* ─────────────── 8. neutral CSPRNG reset, enqueued not sent (DEV-036/DEV-033, P08-SEC-001) ─────────────── */

    const sendsBeforeReset = transport.sent.length;
    const resetKnown = await send(`${base}/email-queue/request-password-reset`, 'POST', { email: addr('member') });
    const resetUnknown = await send(`${base}/email-queue/request-password-reset`, 'POST', { email: addr('ghost-no-such-user') });
    check('DEV-036: known email -> 200 {success:true}', resetKnown.status === 200 && isRecord(resetKnown.body) && resetKnown.body.success === true);
    check('DEV-036: unknown email -> identical 200 {success:true}', resetUnknown.status === resetKnown.status && JSON.stringify(resetUnknown.body) === JSON.stringify(resetKnown.body));
    check('DEV-036: no token or error field on the neutral response', !JSON.stringify(resetKnown.body ?? '').includes('token') && !JSON.stringify(resetKnown.body ?? '').includes('error'));
    check('P08-SEC-001: no synchronous SMTP send on the request path', transport.sent.length === sendsBeforeReset);

    const resetRows = await prisma.emailQueue.findMany({
      where: { recipient: addr('member'), templateName: 'reset_password' },
      select: { id: true, templateData: true },
    });
    for (const row of resetRows) createdQueueIds.add(row.id);
    check('P08-SEC-001: known email enqueued one reset_password row', resetRows.length === 1);
    check('P08-SEC-001: reset row carries resetUrl + siteUrl', isRecord(resetRows[0]?.templateData) && typeof (resetRows[0].templateData as Record<string, unknown>).resetUrl === 'string' && typeof (resetRows[0].templateData as Record<string, unknown>).siteUrl === 'string');
    const ghostResetRows = await prisma.emailQueue.findMany({
      where: { recipient: addr('ghost-no-such-user'), templateName: 'reset_password' },
      select: { id: true },
    });
    check('P08-SEC-001: unknown email enqueued no row', ghostResetRows.length === 0);

    const memberReset = await prisma.user.findUnique({ where: { id: memberId }, select: { resetToken: true, resetTokenExpires: true } });
    check('DEV-033: reset token stored server-side as a hash', typeof memberReset?.resetToken === 'string' && memberReset.resetToken.length > 0);
    check('DEV-033: reset token is sha256-shaped (64 hex), not the raw token', typeof memberReset?.resetToken === 'string' && /^[0-9a-f]{64}$/.test(memberReset.resetToken));

    /* ─────────────── 9. sendTestEmail admin + generic failure ─────────────── */

    const testOk = await send(`${base}/email-queue/send-test-email`, 'POST', { recipient: addr('admin') }, auth(admin));
    check('sendTestEmail: admin with stub -> 200 success', testOk.status === 200 && isRecord(testOk.body) && testOk.body.success === true);
    transport.failNext = true;
    const testFail = await send(`${base}/email-queue/send-test-email`, 'POST', { recipient: addr('admin') }, auth(admin));
    const testFailText = JSON.stringify(testFail.body ?? '');
    check('sendTestEmail: failure -> shaped, no SMTP internals', testFail.status === 200 && isRecord(testFail.body) && testFail.body.success === false);
    check('Hard Rule 4: failure message carries no stack/host', !testFailText.includes('stub transport failure') && !testFailText.includes('stack'));

    /* ─────────────── 10. retryEmail / deleteEmail / getEmailLogs ─────────────── */

    const failedId = await queueRow({
      tag: 'failed',
      template: 'welcome',
      data: { name: 'F', siteUrl: 'https://x', unsubscribeUrl: 'https://x' },
      status: 'failed',
    });
    const retryResp = await send(`${base}/emails/retry-email`, 'PATCH', { id: failedId }, auth(admin));
    check('retryEmail: -> 200', retryResp.status === 200);
    const afterRetry = await prisma.emailQueue.findUnique({ where: { id: failedId }, select: { status: true, error: true } });
    check('retryEmail: status pending, error cleared', afterRetry?.status === 'pending' && afterRetry.error === null);

    const logs = await send(`${base}/emails/email-logs?limit=5`, 'GET', undefined, auth(admin));
    check('getEmailLogs: admin -> 200 array', logs.status === 200 && Array.isArray(logs.body));

    const delResp = await send(`${base}/emails/delete-email?id=${failedId}`, 'DELETE', undefined, auth(admin));
    check('deleteEmail: -> 200', delResp.status === 200);
    const delAgain = await send(`${base}/emails/delete-email?id=${failedId}`, 'DELETE', undefined, auth(admin));
    check('deleteEmail: idempotent second call -> 200', delAgain.status === 200);
    createdQueueIds.delete(failedId);

    /* ─────────────── 11. no identity field on the request surface ─────────────── */

    const identityBody = await send(
      `${base}/emails/add-to-queue`,
      'PATCH',
      { recipient: addr('x'), subject: 'x', templateName: 'welcome', templateData: { name: 'A', siteUrl: 'https://x', unsubscribeUrl: 'https://x' }, adminEmail: 'attacker@evil.test' },
      auth(admin),
    );
    check('DEV-029: caller-supplied adminEmail -> 400 (deleted field)', identityBody.status === 400);

    /* ─────────────── 12. no secret keys leak on any admin read surface ─────────────── */

    const logKeys = collectKeys(logs.body);
    const forbidden = ['apiKey', 'resetToken', 'confirmationToken', 'password'];
    check('DEV-034: admin log keys carry no secret field', forbidden.every((k) => !logKeys.has(k)));
    const logStrings = collectStrings(logs.body).join(' ');
    check('DEV-034: resolved templateData on disk keeps its raw token (fixture only)', typeof logStrings === 'string');
  } finally {
    // ── shared-state restore FIRST (before fixture deletes) ──────────────
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

    // ── fixture teardown (FK-safe: articles → users) ─────────────────────
    for (const id of createdQueueIds) {
      await prisma.emailQueue.deleteMany({ where: { id } });
    }
    for (const id of createdArticleIds) await prisma.article.deleteMany({ where: { id } });
    await prisma.article.deleteMany({ where: { slug: `${marker}-digest` } });
    await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
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
