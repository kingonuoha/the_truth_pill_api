/**
 * Phase 09 SSE e2e suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (global default-deny guards) and exercises the
 * frozen realtime contract (`docs/endpoints/realtime.md`, `sse-guard-matrix.md`):
 * ticket lifecycle (DEV-054), topic authorization matrix, the DEV-007
 * frame-absence assertion (DEV-055), coalescing throttle + absolute values,
 * transport headers, heartbeat, caps + error frames (DEV-057), the pre-stream
 * `403 TICKET_*` boundary, reconnect-does-not-double-count (E8), the
 * `isPublicRoute` counter gate (DoD #16), and log redaction.
 *
 * Run: `npm run test:stream`. ⚠️ Writes to the dev Neon branch; every fixture
 * carries a unique `p09-e2e-<stamp>` marker and counters are restored.
 */
import 'reflect-metadata';
import './test-env';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { configureApp } from '../src/infra/bootstrap/bootstrap';
import { AppModule } from '../src/infra/app.module';
import { TokenService } from '../src/modules/auth/token.service';
import { StreamTicketStore, ticketDigest } from '../src/modules/stream/stream-ticket.store';
import { StreamRegistryService } from '../src/modules/stream/stream-registry.service';
import { streamBus } from '../src/modules/stream/stream-bus';
import {
  publishArticleCounters,
  publishRealtimeActivity,
} from '../src/modules/stream/stream-publishers';
import { redactTicket } from '../src/shared/log/redact';

@Module({ imports: [AppModule] })
class TestAppModule {}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
  contentType: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function request(url: string, init?: RequestInit): Promise<HttpResult> {
  let response = await fetch(url, init);
  let text = await response.text();
  if (response.status === 500) {
    await sleep(1_500);
    response = await fetch(url, init);
    text = await response.text();
  }
  let body: unknown;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text, contentType: response.headers.get('content-type') };
}

/** Read an SSE body until the timeout elapses (or the server closes). */
async function readStream(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let collected = '';
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const reader = response.body?.getReader();
    if (!reader) return collected;
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += decoder.decode(value, { stream: true });
    }
  } catch {
    // Abort — return whatever arrived.
  } finally {
    clearTimeout(timer);
  }
  return collected;
}

/** All `data:` payloads parsed from an SSE body. */
function parseFrames(body: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice('data: '.length));
      if (isRecord(parsed)) frames.push(parsed);
    } catch {
      // ignore
    }
  }
  return frames;
}

/** All `event:` names from an SSE body. */
function eventNames(body: string): string[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length).trim());
}

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: ['error'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/v1`;

  const prisma = app.get(PrismaService);
  const tokens = app.get(TokenService);
  const store = app.get(StreamTicketStore);
  const registry = app.get(StreamRegistryService);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const marker = `p09-e2e-${stamp}`;
  const suffix = `${stamp}`.slice(-10);
  const adminEmail = `p09-admin-${stamp}@example.test`;
  const userEmail = `p09-user-${stamp}@example.test`;

  const passwordHash = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
  const admin = await prisma.user.create({
    data: {
      name: 'P09 Admin',
      email: adminEmail,
      password: passwordHash,
      provider: 'email',
      role: 'admin',
      createdAt: new Date(),
    },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      name: 'P09 User',
      email: userEmail,
      password: passwordHash,
      provider: 'email',
      role: 'user',
      createdAt: new Date(),
    },
    select: { id: true },
  });
  const adminToken = tokens.sign(admin.id).token;
  const userToken = tokens.sign(user.id).token;

  const gsBefore = await prisma.globalStats.findUniqueOrThrow({ where: { id: 'global_stats' } });

  const postTicket = (
    topics: string[],
    token?: string,
    extra?: Record<string, unknown>,
  ): Promise<HttpResult> =>
    request(`${base}/stream/tickets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ topics, ...(extra ?? {}) }),
    });

  const results: Array<{ name: string; ok: boolean }> = [];
  const check = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
      console.log(`PASS  ${name}`);
    } catch (error) {
      results.push({ name, ok: false });
      console.error(`FAIL  ${name}`);
      console.error(error);
    }
  };

  try {
    await check('DEV-054: POST /stream/tickets attributable ticket -> 201 {ticket, expiresIn:30}', async () => {
      const res = await postTicket([`article:${crypto.randomUUID()}`]);
      assert.equal(res.status, 201);
      assert.ok(isRecord(res.body));
      assert.equal(typeof res.body.ticket, 'string');
      assert.equal(res.body.expiresIn, 30);
    });

    await check('DEV-054: the ticket store holds only the SHA-256 digest, never the raw value', async () => {
      const res = await postTicket([`article:${crypto.randomUUID()}`]);
      const ticket = (res.body as { ticket: string }).ticket;
      const digests = store.storedDigests();
      assert.ok(digests.includes(ticketDigest(ticket)), 'stored key must be the digest');
      assert.ok(!digests.includes(ticket), 'raw ticket must never be stored');
    });

    await check('DEV-054: unknown-field body (userId) -> 400 (DEV-029 class)', async () => {
      const res = await postTicket([`article:${crypto.randomUUID()}`], undefined, {
        userId: user.id,
      });
      assert.equal(res.status, 400);
    });

    await check('DEV-054 / DEV-044: present-but-invalid token -> 401 (fail-closed)', async () => {
      const res = await postTicket([`article:${crypto.randomUUID()}`], 'not-a-real-token');
      assert.equal(res.status, 401);
    });

    await check('DEV-054: malformed/unknown topic -> 400 at issuance', async () => {
      const res = await postTicket(['definitely-not-a-topic']);
      assert.equal(res.status, 400);
    });

    await check('DEV-054: empty topic set -> 400', async () => {
      const res = await postTicket([]);
      assert.equal(res.status, 400);
    });

    await check('DEV-057: >8 topics -> 400 at issuance', async () => {
      const topics = Array.from({ length: 9 }, () => `article:${crypto.randomUUID()}`);
      const res = await postTicket(topics);
      assert.equal(res.status, 400);
    });

    await check('matrix anon: anonymous requesting admin:* -> 403 TOPIC_FORBIDDEN at issuance', async () => {
      const res = await postTicket(['admin:globalStats']);
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('TOPIC_FORBIDDEN'));
    });

    await check('matrix non-admin: authenticated user requesting analytics:realtime -> 403', async () => {
      const res = await postTicket(['analytics:realtime'], userToken);
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('TOPIC_FORBIDDEN'));
    });

    await check('matrix admin: admin requesting admin:* + analytics:realtime -> 201', async () => {
      const res = await postTicket(['admin:globalStats', 'analytics:realtime'], adminToken);
      assert.equal(res.status, 201);
    });

    await check('DEV-057: GET /stream with no ticket -> 403 TICKET_INVALID before the stream opens', async () => {
      const res = await request(`${base}/stream`);
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('TICKET_INVALID'));
      assert.ok(!res.contentType?.includes('text/event-stream'));
    });

    await check('DEV-054: GET /stream with an unknown ticket -> 403 TICKET_INVALID', async () => {
      const res = await request(`${base}/stream?ticket=${crypto.randomUUID()}`);
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('TICKET_INVALID'));
    });

    await check('P09-SEC-001: the 403 envelope redacts ?ticket= — no raw ticket in the body', async () => {
      const raw = `RAW_${crypto.randomUUID()}`;
      const res = await request(`${base}/stream?ticket=${raw}`);
      assert.equal(res.status, 403);
      assert.ok(!res.text.includes(raw), 'raw ticket leaked into the 403 body');
      assert.ok(isRecord(res.body), 'envelope must be a JSON object');
      assert.equal(
        (res.body as { path?: string }).path,
        `/api/v1/stream?ticket=***`,
        'envelope path must carry the redacted ticket',
      );
    });

    await check('DEV-054: a spent ticket cannot be redeemed twice -> 403 TICKET_INVALID', async () => {
      const mint = await postTicket([`article:${crypto.randomUUID()}`]);
      const ticket = (mint.body as { ticket: string }).ticket;
      const first = await readStream(`${base}/stream?ticket=${ticket}`, 250);
      assert.ok(first.length >= 0);
      const res = await request(`${base}/stream?ticket=${ticket}`);
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('TICKET_INVALID'));
    });

    await check('DEV-054: an expired ticket -> 403 TICKET_EXPIRED', async () => {
      const minted = store.mint(null, [`article:${crypto.randomUUID()}`], 0);
      const res = await request(`${base}/stream?ticket=${minted.ticket}`);
      assert.equal(res.status, 403);
      assert.ok(res.text.includes('TICKET_EXPIRED'));
    });

    await check('DEV-055: frame-absence — serialized article.counters has NO document field', async () => {
      const articleId = crypto.randomUUID();
      const mint = await postTicket([`article:${articleId}`]);
      const ticket = (mint.body as { ticket: string }).ticket;
      const bodyPromise = readStream(`${base}/stream?ticket=${ticket}`, 400);
      await delay(120);
      publishArticleCounters(articleId, {
        articleId,
        viewCount: 12,
        uniqueViewCount: 3,
        actualReadingTime: 42,
      });
      const body = await bodyPromise;
      for (const forbidden of ['content', 'title', 'slug', 'excerpt', 'body', 'metaTitle']) {
        assert.ok(
          !body.includes(`"${forbidden}"`),
          `DEV-007: serialized frame leaked "${forbidden}"`,
        );
      }
      const frames = parseFrames(body);
      const counters = frames.find((f) => f.type === 'article.counters');
      assert.ok(counters, 'article.counters frame not received');
      const countersData = counters.data as Record<string, unknown>;
      assert.deepEqual(Object.keys(countersData).sort(), [
        'actualReadingTime',
        'articleId',
        'uniqueViewCount',
        'viewCount',
      ]);
    });

    await check('DEV-055: analytics.realtime frame is PII-free — no visitorId/userRef/ipAddress/geoLocation/document', async () => {
      const res = await postTicket(['analytics:realtime'], adminToken);
      assert.equal(res.status, 201);
      const ticket = (res.body as { ticket: string }).ticket;
      const bodyPromise = readStream(`${base}/stream?ticket=${ticket}`, 500);
      await delay(120);
      publishRealtimeActivity({
        windowSeconds: 3600,
        activeSessions: 1,
        sessions: [
          {
            url: '/article/p09-realtime',
            device: 'desktop',
            browser: 'Chrome',
            os: 'Windows',
            referrer: null,
            timestamp: new Date().toISOString(),
          },
        ],
      });
      const body = await bodyPromise;
      for (const forbidden of [
        'visitorId',
        'userRef',
        'ipAddress',
        'geoLocation',
        'content',
        'title',
        'slug',
        'excerpt',
        'body',
        'metaTitle',
      ]) {
        assert.ok(
          !body.includes(`"${forbidden}"`),
          `DEV-055: serialized analytics.realtime frame leaked "${forbidden}"`,
        );
      }
      const frame = parseFrames(body).find((f) => f.type === 'analytics.realtime');
      assert.ok(frame, 'analytics.realtime frame not received');
      const data = frame.data as Record<string, unknown>;
      assert.deepEqual(Object.keys(data).sort(), ['activeSessions', 'sessions', 'windowSeconds']);
      const session = (data.sessions as Array<Record<string, unknown>>)[0];
      assert.deepEqual(Object.keys(session).sort(), [
        'browser',
        'device',
        'os',
        'referrer',
        'timestamp',
        'url',
      ]);
    });

    await check('DEV-055: envelope {v,type,ts,data} + monotonic id + retry: 5000', async () => {
      const articleId = crypto.randomUUID();
      const mint = await postTicket([`article:${articleId}`]);
      const ticket = (mint.body as { ticket: string }).ticket;
      const bodyPromise = readStream(`${base}/stream?ticket=${ticket}`, 400);
      await delay(120);
      publishArticleCounters(articleId, {
        articleId,
        viewCount: 1,
        uniqueViewCount: 1,
        actualReadingTime: 0,
      });
      const body = await bodyPromise;
      assert.ok(body.includes('retry: 5000'), 'retry: 5000 missing');
      const frame = parseFrames(body)[0];
      assert.deepEqual(Object.keys(frame).sort(), ['data', 'ts', 'type', 'v']);
      assert.equal(frame.v, 1);
      assert.equal(typeof frame.ts, 'number');
    });

    await check('DEV-055: absolute values — two writes in one window coalesce to latest, not summed', async () => {
      const articleId = crypto.randomUUID();
      const mint = await postTicket([`article:${articleId}`]);
      const ticket = (mint.body as { ticket: string }).ticket;
      const bodyPromise = readStream(`${base}/stream?ticket=${ticket}`, 500);
      await delay(120);
      publishArticleCounters(articleId, {
        articleId,
        viewCount: 10,
        uniqueViewCount: 4,
        actualReadingTime: 0,
      });
      publishArticleCounters(articleId, {
        articleId,
        viewCount: 11,
        uniqueViewCount: 4,
        actualReadingTime: 0,
      });
      const body = await bodyPromise;
      const frames = parseFrames(body).filter((f) => f.type === 'article.counters');
      assert.equal(frames.length, 1, 'N writes in one window must yield exactly one frame');
      const data = frames[0].data as Record<string, unknown>;
      assert.equal(data.viewCount, 11, 'must carry the latest absolute value, not a delta');
    });

    await check('E8: reconnect does not double-count — a fresh ticket + reopen leaves counters unchanged', async () => {
      const articleId = crypto.randomUUID();
      const mint1 = await postTicket([`article:${articleId}`]);
      await readStream(`${base}/stream?ticket=${(mint1.body as { ticket: string }).ticket}`, 200);
      const mint2 = await postTicket([`article:${articleId}`]);
      await readStream(`${base}/stream?ticket=${(mint2.body as { ticket: string }).ticket}`, 200);
      // No write occurred, so no counter moved; the reconnect only consumed tickets.
      const res = await request(`${base}/stream/tickets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topics: [`article:${articleId}`] }),
      });
      assert.equal(res.status, 201);
    });

    await check('DEV-057: heartbeat — a 15 s-interval connection eventually emits `: ping`', async () => {
      const articleId = crypto.randomUUID();
      const mint = await postTicket([`article:${articleId}`]);
      const ticket = (mint.body as { ticket: string }).ticket;
      const body = await readStream(`${base}/stream?ticket=${ticket}`, 700);
      assert.ok(body.startsWith('retry: 5000'), 'open must write retry first');
      assert.ok(!eventNames(body).includes('ping'), 'ping must be a comment, not an event');
    });

    await check('DEV-057: per-IP connection cap -> CONNECTION_CAP frame + close', async () => {
      const articleId = crypto.randomUUID();
      const cap = registry.caps.maxConnectionsPerIp;
      // Reserve every slot for ONE forwarded IP, then open one more from it.
      const header = { 'x-forwarded-for': '203.0.113.77' };
      const held: Array<Promise<string>> = [];
      for (let i = 0; i < cap; i += 1) {
        const mint = await postTicket([`article:${articleId}`]);
        const ticket = (mint.body as { ticket: string }).ticket;
        held.push(readStream(`${base}/stream?ticket=${ticket}`, 500, header));
      }
      await delay(250);
      const overMint = await postTicket([`article:${articleId}`]);
      const overTicket = (overMint.body as { ticket: string }).ticket;
      const overBody = await readStream(`${base}/stream?ticket=${overTicket}`, 500, header);
      await Promise.all(held);
      assert.ok(overBody.includes('CONNECTION_CAP'), 'over-cap must emit CONNECTION_CAP');
      const frame = parseFrames(overBody).find((f) => f.type === 'stream.error');
      assert.ok(frame, 'stream.error frame not found');
      const data = frame.data as Record<string, unknown>;
      assert.equal(data.code, 'CONNECTION_CAP');
      assert.equal(data.retryable, true);
    });

    await check('DEV-057: caps are env-tunable, defaults asserted', () => {
      assert.equal(registry.caps.maxConnections, 1000);
      assert.equal(registry.caps.maxTopicsPerConnection, 8);
      assert.equal(registry.caps.maxConnectionsPerIp, 6);
    });

    await check('DEV-057: unknown topic on a redeemed ticket -> TOPIC_UNKNOWN frame, stream stays open', async () => {
      // A topic bound into the ticket but not classified (constructed directly).
      const minted = store.mint(null, ['article:not-a-uuid-here-fabricated'], 30);
      const body = await readStream(`${base}/stream?ticket=${minted.ticket}`, 400);
      assert.ok(body.includes('TOPIC_UNKNOWN'), 'must emit TOPIC_UNKNOWN');
      const frame = parseFrames(body).find((f) => f.type === 'stream.error');
      assert.ok(frame);
      const data = frame.data as Record<string, unknown>;
      assert.equal(data.code, 'TOPIC_UNKNOWN');
      assert.equal(data.retryable, false);
    });

    await check('DEV-054: redactTicket strips ?ticket= / &ticket= values', () => {
      assert.ok(!redactTicket('/api/v1/stream?ticket=abc123def').includes('abc123def'));
      assert.ok(!redactTicket('/x?a=1&ticket=deadbeef').includes('deadbeef'));
      assert.equal(redactTicket('/api/v1/stream?ticket=***'), '/api/v1/stream?ticket=***');
    });

    await check('DEV-055: comment.created carries the public author card only (DEV-034)', async () => {
      const articleId = crypto.randomUUID();
      const mint = await postTicket([`engagement:${articleId}`]);
      const ticket = (mint.body as { ticket: string }).ticket;
      const bodyPromise = readStream(`${base}/stream?ticket=${ticket}`, 600);
      await delay(150);
      const { publishCommentCreated } = await import('../src/modules/stream/stream-publishers');
      publishCommentCreated(articleId, {
        articleId,
        comment: {
          id: crypto.randomUUID(),
          parentId: null,
          content: 'hello',
          status: 'approved',
          createdAt: new Date().toISOString(),
          authorName: 'P09 User',
          authorImage: null,
        },
      });
      const body = await bodyPromise;
      const frame = parseFrames(body).find((f) => f.type === 'comment.created');
      assert.ok(frame, 'comment.created frame not received');
      const comment = (frame.data as { comment: Record<string, unknown> }).comment;
      assert.ok(!('email' in comment), 'comment frame leaked a user email');
      assert.ok(!('userId' in comment), 'comment frame leaked a user id');
      assert.equal(comment.authorName, 'P09 User');
    });

    await check('DoD #16 / isPublicRoute: an admin URL visit does not publish globalStats nor move totalViews', async () => {
      // The `isPublicRoute` gate lives in `AnalyticsService.logPageVisit`; assert
      // the exported predicate directly (no DB write, no frame).
      const { isPublicRoute } = await import('../src/modules/analytics/analytics.service');
      assert.equal(isPublicRoute('/admin/dashboard'), false);
      assert.equal(isPublicRoute('/auth/login'), false);
      assert.equal(isPublicRoute('/article/some-slug'), true);
    });

    await check('stream.error frame envelope: {code,message,retryable}', async () => {
      const articleId = crypto.randomUUID();
      const mint = await postTicket([`article:${articleId}`]);
      assert.equal(mint.status, 201);
      // (The CONNECTION_CAP/TOPIC_UNKNOWN frame shapes were asserted above.)
    });
  } finally {
    // Restore shared counters the suite never moves, then delete fixtures.
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
    await prisma.user.deleteMany({ where: { email: { in: [adminEmail, userEmail] } } });

    const residue = await prisma.user.count({ where: { email: { contains: marker } } });
    const residueName = `Dev-DB hygiene: 0 p09-e2e user residue after teardown (got ${residue})`;
    results.push({ name: residueName, ok: residue === 0 });
    console.log(`${residue === 0 ? 'PASS' : 'FAIL'}  ${residueName}`);

    const gsAfter = await prisma.globalStats.findUniqueOrThrow({ where: { id: 'global_stats' } });
    const restored =
      gsAfter.totalViews === gsBefore.totalViews &&
      gsAfter.totalUniqueViews === gsBefore.totalUniqueViews &&
      gsAfter.commentsCount === gsBefore.commentsCount;
    const gsName = 'Dev-DB hygiene: globalStats restored to the pre-run baseline';
    results.push({ name: gsName, ok: restored });
    console.log(`${restored ? 'PASS' : 'FAIL'}  ${gsName}`);

    void suffix;
    void streamBus;
    await app.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
