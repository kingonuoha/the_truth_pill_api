/**
 * Phase 03 e2e harness (D14).
 *
 * Boots the real `AppModule` plus a probe module that exists only here, applies
 * the same global configuration as `main.ts` via `configureApp`, then asserts
 * the security-critical behaviours:
 *
 *   - `/api/v1` prefix is enforced
 *   - the global `ValidationPipe` rejects unknown fields (400)
 *   - a forced internal error returns an opaque 500 envelope (no leak)
 *   - `PrismaService` is a single instance and can read the live dev branch
 *
 * Run: `npm test`.
 */
import 'reflect-metadata';
import './test-env';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { configureApp } from '../src/infra/bootstrap/bootstrap';
import { AppModule } from '../src/infra/app.module';
import { Public } from '../src/shared/guards/auth.decorators';
import { PasswordService } from '../src/modules/auth/password.service';
import { TokenService } from '../src/modules/auth/token.service';
import { ScopedTokenService } from '../src/modules/auth/scoped-token.service';
import { UsersService } from '../src/modules/users/users.service';
import type { ErrorEnvelope } from '../src/shared/types/error-envelope';
import { TEST_API_TOKEN_SECRET, TEST_INTERNAL_JOB_SECRET, TEST_ISSUER } from './test-env';

/** Marker used to prove the opaque 500 path leaks nothing. */
const SECRET =
  'SECRET_INTERNAL DETAIL: SELECT * FROM users WHERE token = \'x\' at Object.<anonymous> (src/leak.ts:1:1)';

class ProbeDto {
  @ApiProperty({ example: 'alice' })
  @IsString()
  @IsNotEmpty()
  name!: string;
}

@Public()
@Controller('probe')
class ProbeController {
  @Post('echo')
  echo(@Body() dto: ProbeDto): { name: string } {
    return { name: dto.name };
  }

  @Get('boom')
  boom(): never {
    // Represents an unexpected internal failure (Prisma/driver/unknown).
    throw new Error(SECRET);
  }

  @Get('bad')
  bad(): never {
    // Represents a careless `BadRequestException(e.message)` carrying a raw
    // Prisma/SQL/stack message under a 4xx status (P03-SEC-002).
    throw new BadRequestException(SECRET);
  }

  @Get('bad-validation')
  badValidation(): never {
    // Represents a 4xx whose details array carries internals.
    throw new BadRequestException({
      message: ['P2002 Unique constraint failed on the fields: (slug)'],
    });
  }
}

/**
 * A probe controller with **no** `@Public()` decorator — it stands in for any
 * route not on the §10 allowlist. The global default-deny guard must 401 it
 * (brief DoD #6, §1.6.2 test 9).
 */
@Controller('unlisted')
class UnlistedProbeController {
  @Get('secret')
  secret(): { ok: true } {
    return { ok: true };
  }
}

@Module({
  imports: [AppModule],
  controllers: [ProbeController, UnlistedProbeController],
})
class TestAppModule {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Runtime-validate the envelope shape without asserting a type. */
function readEnvelope(value: unknown): ErrorEnvelope {
  assert.ok(isRecord(value), 'response body is not an object');
  const { statusCode, code, message, path, timestamp, details } = value;
  assert.ok(typeof statusCode === 'number', 'statusCode is not a number');
  assert.ok(typeof code === 'string', 'code is not a string');
  assert.ok(typeof message === 'string', 'message is not a string');
  assert.ok(typeof path === 'string', 'path is not a string');
  assert.ok(typeof timestamp === 'string', 'timestamp is not a string');
  return {
    statusCode,
    code,
    message,
    path,
    timestamp,
    ...(Array.isArray(details) ? { details: details.map((d) => String(d)) } : {}),
  };
}

interface ProbeResponse {
  status: number;
  body: unknown;
  text: string;
}

async function request(
  url: string,
  init?: RequestInit,
): Promise<ProbeResponse> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  return { status: response.status, body, text };
}

function postJson(url: string, payload: unknown): Promise<ProbeResponse> {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** `POST` with an explicit header set — used for the `/internal/*` secret. */
function postJsonWithHeaders(
  url: string,
  payload: unknown,
  headers: Record<string, string>,
): Promise<ProbeResponse> {
  return request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

function patchJson(
  url: string,
  payload: unknown,
  token?: string,
): Promise<ProbeResponse> {
  return request(url, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function getWithAuth(url: string, token?: string): Promise<ProbeResponse> {
  return request(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Forge a validly signed token carrying an extra claim (e.g. a stale
 * `role: "admin"`). Used to prove the guard ignores claims and reads the DB
 * (DEV-032 / `roles-db.spec`).
 */
function forgeToken(sub: string, extra: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64Url(
    JSON.stringify({
      iss: TEST_ISSUER,
      aud: 'truth-pill-api',
      sub,
      jti: `forged-${Math.random().toString(16).slice(2)}`,
      iat: now,
      exp: now + 300,
      ...extra,
    }),
  )}`;
  const signature = createHmac('sha256', TEST_API_TOKEN_SECRET)
    .update(signingInput)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${signingInput}.${signature}`;
}

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const appUrl = await app.getUrl();
  const base = `${appUrl}/api/v1`;

  // ── Phase 04 fixtures ────────────────────────────────────────────────
  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);
  const tokens = app.get(TokenService);
  const scoped = app.get(ScopedTokenService);
  const usersService = app.get(UsersService);

  const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const adminEmail = `e2e-admin-${suffix}@example.test`;
  const victimEmail = `e2e-victim-${suffix}@example.test`;
  const targetEmail = `e2e-target-${suffix}@example.test`;
  const guestEmail = `e2e-guest-${suffix}@example.test`;
  const hijackEmail = `e2e-hijack-${suffix}@example.test`;
  const googleEmail = `e2e-google-${suffix}@example.test`;
  const guestAdoptEmail = `e2e-guest-adopt-${suffix}@example.test`;
  const systemEmail = `e2e-system-${suffix}@example.test`;
  const passwordPlain = 'correct horse battery staple';
  const passwordHash = await passwords.hash(passwordPlain);

  const admin = await prisma.user.create({
    data: { name: 'E2E Admin', email: adminEmail, password: passwordHash, provider: 'email', role: 'admin', createdAt: new Date() },
    select: { id: true },
  });
  const victim = await prisma.user.create({
    data: { name: 'E2E Victim', email: victimEmail, password: passwordHash, provider: 'email', role: 'user', createdAt: new Date() },
    select: { id: true },
  });
  const target = await prisma.user.create({
    data: { name: 'E2E Target', email: targetEmail, password: passwordHash, provider: 'email', role: 'user', createdAt: new Date() },
    select: { id: true },
  });

  // A `system` row shaped like production's (role admin, no password). DEV-065
  // requires it to stay adoptable: it holds no password, so a 409 would leave it
  // with no reachable sign-in at all.
  const systemRow = await prisma.user.create({
    data: { name: 'E2E System', email: systemEmail, provider: 'system', role: 'admin', createdAt: new Date() },
    select: { id: true },
  });

  const adminToken = tokens.sign(admin.id).token;
  const victimToken = tokens.sign(victim.id).token;
  const internal = { 'x-internal-secret': TEST_INTERNAL_JOB_SECRET as string };

  const cleanup = async (): Promise<void> => {
    await prisma.user.deleteMany({
      where: {
        email: {
          in: [
            adminEmail,
            victimEmail,
            targetEmail,
            guestEmail,
            hijackEmail,
            googleEmail,
            guestAdoptEmail,
            systemEmail,
          ],
        },
      },
    });
  };

  const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
    {
      name: 'global prefix /api/v1 is enforced (bare path is 404)',
      run: async () => {
        const res = await request(`${appUrl}/probe/echo`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'alice' }),
        });
        assert.equal(res.status, 404);
      },
    },
    {
      name: 'POST /api/v1/probe/echo valid body -> 201 and echoes',
      run: async () => {
        const res = await postJson(`${base}/probe/echo`, { name: 'alice' });
        assert.equal(res.status, 201);
        assert.deepEqual(res.body, { name: 'alice' });
      },
    },
    {
      name: 'unknown body field -> 400 (forbidNonWhitelisted)',
      run: async () => {
        const res = await postJson(`${base}/probe/echo`, {
          name: 'alice',
          role: 'admin',
        });
        assert.equal(res.status, 400);
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.code, 'BAD_REQUEST');
        assert.equal(envelope.statusCode, 400);
      },
    },
    {
      name: 'missing required field -> 400 (whitelist validation)',
      run: async () => {
        const res = await postJson(`${base}/probe/echo`, {});
        assert.equal(res.status, 400);
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.code, 'BAD_REQUEST');
      },
    },
    {
      name: 'forced internal error -> opaque 500, leaks nothing',
      run: async () => {
        const res = await request(`${base}/probe/boom`);
        assert.equal(res.status, 500);
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.code, 'INTERNAL_SERVER_ERROR');
        assert.equal(envelope.message, 'Internal server error');
        assert.ok(!res.text.includes('SECRET_INTERNAL'), 'raw secret leaked');
        assert.ok(!res.text.includes('SELECT'), 'SQL text leaked');
        assert.ok(!res.text.includes('at Object'), 'stack frame leaked');
        assert.ok(!res.text.includes('.ts:'), 'source path leaked');
        assert.ok(!res.text.includes('Prisma'), 'Prisma internals leaked');
        assert.ok(!res.text.includes('stack'), 'stack field leaked');
      },
    },
    {
      name: 'unknown route -> 404 opaque envelope, no stack',
      run: async () => {
        const res = await request(`${base}/definitely-not-here`);
        assert.equal(res.status, 404);
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.code, 'NOT_FOUND');
        assert.ok(!res.text.includes('at '), 'stack frame leaked');
        assert.ok(!res.text.includes('.ts:'), 'source path leaked');
      },
    },
    {
      name: 'forced 4xx -> generic message, raw 4xx message not forwarded (P03-SEC-002)',
      run: async () => {
        const res = await request(`${base}/probe/bad`);
        assert.equal(res.status, 400);
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.code, 'BAD_REQUEST');
        assert.equal(envelope.message, 'Bad request');
        assert.ok(!res.text.includes('SECRET_INTERNAL'), 'raw 4xx message leaked');
        assert.ok(!res.text.includes('SELECT'), 'SQL text leaked in 4xx');
        assert.ok(!res.text.includes('at Object'), 'stack frame leaked in 4xx');
        assert.ok(!res.text.includes('.ts:'), 'source path leaked in 4xx');
        assert.ok(!res.text.includes('Prisma'), 'Prisma internals leaked in 4xx');
      },
    },
    {
      name: '4xx validation details carrying internals are dropped (P03-SEC-002)',
      run: async () => {
        const res = await request(`${base}/probe/bad-validation`);
        assert.equal(res.status, 400);
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.message, 'Bad request');
        assert.equal(envelope.details, undefined);
        assert.ok(!res.text.includes('P2002'), 'Prisma error code leaked');
        assert.ok(!res.text.includes('Unique constraint'), 'Prisma text leaked');
      },
    },
    {
      name: 'PrismaService is a single instance (no second client)',
      run: () => {
        const first = app.get(PrismaService);
        const second = app.get(PrismaService);
        assert.equal(first, second);
      },
    },
    {
      name: 'live DB read against the Neon dev branch succeeds',
      run: async () => {
        const prisma = app.get(PrismaService);
        const rows = await prisma.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`;
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0].one), 1);
      },
    },
    /* ── Phase 04: guard matrix (§1.6.2 tests 1–4, 6, 9; brief DoD #4/#5/#6) ── */
    {
      name: 'DEV-001 / §1.6.2 test 1: updateUserRole with no Authorization -> 401',
      run: async () => {
        const res = await patchJson(`${base}/admin/users/${target.id}/role`, {
          role: 'admin',
        });
        assert.equal(res.status, 401);
      },
    },
    {
      name: 'DEV-001 / §1.6.2 test 2: valid non-admin token -> 403 (not 401)',
      run: async () => {
        const res = await patchJson(
          `${base}/admin/users/${target.id}/role`,
          { role: 'admin' },
          victimToken,
        );
        assert.equal(res.status, 403);
        const row = await prisma.user.findUnique({
          where: { id: target.id },
          select: { role: true },
        });
        assert.equal(row?.role, 'user', 'role must be unchanged');
      },
    },
    {
      name: 'DEV-001 / §1.6.2 test 3: valid admin token -> 200 and the role changes',
      run: async () => {
        const res = await patchJson(
          `${base}/admin/users/${target.id}/role`,
          { role: 'admin' },
          adminToken,
        );
        assert.equal(res.status, 200);
        const row = await prisma.user.findUnique({
          where: { id: target.id },
          select: { role: true },
        });
        assert.equal(row?.role, 'admin');
      },
    },
    {
      name: 'DEV-001 / §1.6.2 test 4: forged adminEmail in body -> 400 (field does not exist)',
      run: async () => {
        const res = await patchJson(
          `${base}/admin/users/${target.id}/role`,
          { role: 'user', adminEmail },
          adminToken,
        );
        assert.equal(res.status, 400);
      },
    },
    {
      name: '§1.6.2 test 9 / default-deny: unlisted route with no token -> 401',
      run: async () => {
        const res = await getWithAuth(`${base}/unlisted/secret`);
        assert.equal(res.status, 401);
      },
    },
    {
      name: 'DEV-032 / roles-db.spec: stale admin claim on a user row -> 403',
      run: async () => {
        const forged = forgeToken(victim.id, { role: 'admin', roles: ['admin'] });
        const res = await patchJson(
          `${base}/admin/users/${target.id}/role`,
          { role: 'user' },
          forged,
        );
        assert.equal(res.status, 403);
      },
    },
    {
      name: 'DEV-032 / roles-db.spec: claim for a deleted user -> 401',
      run: async () => {
        const forged = forgeToken('00000000-0000-7000-8000-000000000000', {
          role: 'admin',
        });
        const res = await getWithAuth(`${base}/users/me`, forged);
        assert.equal(res.status, 401);
      },
    },
    {
      name: 'DEV-034 / §1.6.2 test 6: /users/me projection leaks no secrets',
      run: async () => {
        const res = await getWithAuth(`${base}/users/me`, victimToken);
        assert.equal(res.status, 200);
        const body = res.body as Record<string, unknown>;
        for (const secret of [
          'password',
          'resetToken',
          'resetTokenExpires',
          'confirmationToken',
          'confirmationTokenExpires',
        ]) {
          assert.ok(!(secret in body), `${secret} leaked in /users/me`);
        }
        assert.ok(!res.text.includes('$2'), 'a bcrypt hash leaked');
      },
    },
    {
      name: 'auth login: valid credentials -> 200 with a token and projected user',
      run: async () => {
        const res = await postJson(`${base}/auth/login`, {
          email: adminEmail,
          password: passwordPlain,
        });
        assert.equal(res.status, 200);
        const body = res.body as Record<string, unknown>;
        assert.equal(typeof body.accessToken, 'string');
        assert.equal(body.tokenType, 'Bearer');
        assert.ok(!res.text.includes('$2'), 'a bcrypt hash leaked from login');
        assert.ok(!res.text.includes('"password"'), 'password field leaked');
      },
    },
    {
      name: 'auth login: wrong password -> 401 (uniform failure)',
      run: async () => {
        const res = await postJson(`${base}/auth/login`, {
          email: adminEmail,
          password: 'definitely-not-it-123',
        });
        assert.equal(res.status, 401);
      },
    },
    {
      name: 'DEV-033 / password-hash.spec: a pre-hashed password is rejected 400',
      run: async () => {
        const preHashed = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
        const res = await postJson(`${base}/auth/login`, {
          email: adminEmail,
          password: preHashed,
        });
        assert.equal(res.status, 400);
      },
    },
    {
      name: 'DEV-037 / register-enumeration.spec: duplicate register -> identical neutral 200',
      run: async () => {
        const first = await postJson(`${base}/users/register`, {
          name: 'Guest One',
          email: guestEmail,
          password: passwordPlain,
        });
        const second = await postJson(`${base}/users/register`, {
          name: 'Guest Two',
          email: guestEmail,
          password: passwordPlain,
        });
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.deepEqual(first.body, second.body);
        assert.deepEqual(second.body, { status: 'ok' });
      },
    },
    {
      name: 'DEV-035/DEV-036 / unsubscribe.spec + token-csprng.spec: signed single-use, replay 401',
      run: async () => {
        const minted = scoped.mint('newsletter-unsubscribe', victim.id, 3600);
        const first = await postJson(`${base}/users/newsletter/unsubscribe`, {
          token: minted.token,
        });
        assert.equal(first.status, 200);
        const second = await postJson(`${base}/users/newsletter/unsubscribe`, {
          token: minted.token,
        });
        assert.equal(second.status, 401);
      },
    },
    {
      name: 'DEV-036 / token-csprng.spec: tokens are long and unique',
      run: async () => {
        const a = scoped.mint('newsletter-confirm', victim.id, 3600).token;
        const b = scoped.mint('newsletter-confirm', victim.id, 3600).token;
        assert.notEqual(a, b);
        const jtiLength = scoped.mint('newsletter-confirm', victim.id, 3600).jti.length;
        assert.ok(jtiLength * 4 >= 128, `jti entropy too low (${jtiLength})`);
      },
    },
    {
      name: 'P02-SEC-001 / newsletter-confirm.spec: hash-at-rest, single-use, already-confirmed refused',
      run: async () => {
        const issued = await usersService.subscribeToNewsletter({
          email: victimEmail,
        });
        assert.equal(issued.status, 'verification_sent');
        assert.ok(typeof issued.token === 'string');
        const stored = await prisma.user.findUnique({
          where: { id: victim.id },
          select: { confirmationToken: true },
        });
        assert.ok(stored?.confirmationToken, 'no token stored');
        assert.notEqual(
          stored?.confirmationToken,
          issued.token,
          'token must be hashed at rest, not stored raw',
        );

        const token = issued.token as string;
        const first = await postJson(`${base}/users/newsletter/confirm`, { token });
        assert.equal(first.status, 200);
        assert.deepEqual(first.body, { success: true });

        // Replay is refused (single-use).
        const replay = await postJson(`${base}/users/newsletter/confirm`, { token });
        assert.deepEqual(replay.body, { success: false });

        // A fresh token on an already-confirmed user is refused.
        const again = await usersService.subscribeToNewsletter({
          email: victimEmail,
        });
        assert.equal(again.status, 'subscribed');
        assert.equal(again.token, undefined);
      },
    },
    {
      name: 'P02-SEC-001: a legacy plaintext confirmation token never validates',
      run: async () => {
        await prisma.user.update({
          where: { id: victim.id },
          data: { confirmationToken: 'legacy-plaintext-token', emailConfirmed: false },
        });
        const res = await postJson(`${base}/users/newsletter/confirm`, {
          token: 'legacy-plaintext-token',
        });
        assert.equal(res.status, 401);
      },
    },
    {
      name: '§1.6.2 test 5 / resetPassword.spec: a stolen/unknown reset token -> 401',
      run: async () => {
        const res = await postJson(`${base}/users/password/reset`, {
          token: 'stolen-token-not-minted-here',
          password: 'a-brand-new-passphrase',
        });
        assert.equal(res.status, 401);
      },
    },
    {
      name: '§1.6.2 test 8 / DEV-003: there is no admin-seed HTTP route (404)',
      run: async () => {
        const res = await postJson(`${base}/seed`, {});
        assert.equal(res.status, 404);
      },
    },
    {
      name: 'DEV-029 / identity-params.spec: userId in a body -> 400',
      run: async () => {
        const res = await patchJson(
          `${base}/users/me`,
          { name: 'Renamed', userId: victim.id },
          victimToken,
        );
        assert.equal(res.status, 400);
      },
    },
    {
      name: 'DEV-029 / identity-params.spec: userEmail in a body -> 400',
      run: async () => {
        const res = await postJson(`${base}/users/register`, {
          name: 'Sneaky',
          email: guestEmail,
          password: passwordPlain,
          userEmail: adminEmail,
        });
        assert.equal(res.status, 400);
      },
    },
    /* ── S-R2 / DEV-065: the Google upsert must not adopt a row that already
     *    carries a password a third party planted. ── */
    {
      name: 'DEV-065 / S-R2: /users/register then /internal/users/store for the same address -> 409, no borrowed id',
      run: async () => {
        // The attack, step 1: anyone, unauthenticated, plants a password on an
        // address they do not own.
        const registered = await postJson(`${base}/users/register`, {
          name: 'Planted Account',
          email: hijackEmail,
          password: passwordPlain,
        });
        assert.equal(registered.status, 200);

        const planted = await prisma.user.findUnique({
          where: { email: hijackEmail },
          select: { id: true, provider: true, password: true, name: true },
        });
        assert.equal(planted?.provider, 'email', 'register must mint provider "email"');
        assert.ok(planted?.password, 'register must store the caller-chosen password');

        // Step 2: the victim's Google sign-in must be refused, not merged into
        // the planted row. On the pre-fix code this returned 200 `{id: planted.id}`.
        const res = await postJsonWithHeaders(
          `${base}/internal/users/store`,
          { name: 'Victim Via Google', email: hijackEmail },
          internal,
        );
        assert.equal(res.status, 409, 'adopting a password-bearing row is the pre-hijack');
        const envelope = readEnvelope(res.body);
        assert.equal(envelope.code, 'CONFLICT');
        assert.ok(
          !res.text.includes(planted?.id ?? 'no-id'),
          'the 409 must not disclose the planted row id',
        );

        // The refusal is side-effect free: the planted row is untouched, so the
        // attacker's password is neither honoured nor silently scrubbed.
        const after = await prisma.user.findUnique({
          where: { email: hijackEmail },
          select: { provider: true, name: true, password: true, profileImage: true },
        });
        assert.equal(after?.provider, 'email');
        assert.equal(after?.name, 'Planted Account');
        assert.ok(after?.password, 'the refusal must not touch the row');
        assert.equal(after?.profileImage, null);
      },
    },
    {
      name: 'DEV-065: a genuine Google row still upserts idempotently -> 200, same id',
      run: async () => {
        const first = await postJsonWithHeaders(
          `${base}/internal/users/store`,
          { name: 'Real Google User', email: googleEmail, profileImage: 'https://cdn.test/a.png' },
          internal,
        );
        assert.equal(first.status, 200);
        const firstId = (first.body as { id: string }).id;
        assert.equal(typeof firstId, 'string');

        const second = await postJsonWithHeaders(
          `${base}/internal/users/store`,
          { name: 'Real Google User', email: googleEmail, profileImage: 'https://cdn.test/b.png' },
          internal,
        );
        assert.equal(second.status, 200);
        assert.equal((second.body as { id: string }).id, firstId, 're-login must reuse the row');

        const row = await prisma.user.findUnique({
          where: { email: googleEmail },
          select: { provider: true, profileImage: true, password: true },
        });
        assert.equal(row?.provider, 'google');
        assert.equal(row?.profileImage, 'https://cdn.test/b.png');
        assert.equal(row?.password, null, 'a Google row must carry no password');
      },
    },
    {
      name: 'DEV-065: guest and system rows are still adopted -> 200 (a 409 would lock the address out)',
      run: async () => {
        // `guest` is minted by the public newsletter double opt-in and holds no
        // password, so nobody can authenticate as it. Refusing it would let an
        // unauthenticated subscribe deny Google sign-in for any address.
        const subscribed = await postJson(`${base}/users/newsletter/subscribe`, {
          email: guestAdoptEmail,
        });
        assert.equal(subscribed.status, 200);
        const guestRow = await prisma.user.findUnique({
          where: { email: guestAdoptEmail },
          select: { id: true, provider: true },
        });
        assert.equal(guestRow?.provider, 'guest');

        const guestStore = await postJsonWithHeaders(
          `${base}/internal/users/store`,
          { name: 'Newsletter Reader', email: guestAdoptEmail },
          internal,
        );
        assert.equal(guestStore.status, 200);
        assert.equal(
          (guestStore.body as { id: string }).id,
          guestRow?.id,
          'the guest row must be adopted, not duplicated (email is unique)',
        );

        // `system` is the machine-authored provider and holds no password; it is
        // not reachable from any public write, so it is not attacker-plantable.
        const systemStore = await postJsonWithHeaders(
          `${base}/internal/users/store`,
          { name: 'System Owner', email: systemEmail },
          internal,
        );
        assert.equal(systemStore.status, 200);
        assert.equal(
          (systemStore.body as { id: string }).id,
          systemRow.id,
          'the system row must be adopted, not refused',
        );
      },
    },
  ];

  const results: Array<{ name: string; ok: boolean }> = [];
  try {
    for (const check of checks) {
      try {
        await check.run();
        results.push({ name: check.name, ok: true });
        console.log(`PASS  ${check.name}`);
      } catch (error) {
        results.push({ name: check.name, ok: false });
        console.error(`FAIL  ${check.name}`);
        console.error(error);
      }
    }
  } finally {
    await cleanup().catch(() => undefined);
    await app.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
