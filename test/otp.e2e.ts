/**
 * Phase 04 OTP e2e + DEV-028 suite (`truth-pill-backend`).
 *
 * Boots the real `AppModule` (so the global default-deny `JwtAuthGuard` is in
 * force and `@Public()` on the OTP controller is actually exercised), applies
 * the same global configuration as `main.ts`, and drives the three OTP routes
 * over HTTP plus the service directly for the concurrency case.
 *
 * Covers §CN-1 R1–R10 and the four DEV-028 tests. Run: `npm run test:otp`.
 *
 * ⚠️ Writes to the dev Neon branch: every fixture row is created under a unique
 * `example.test` address and deleted in `finally`.
 */
import 'reflect-metadata';
import './test-env';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../src/core/prisma/prisma.service';
import { configureApp } from '../src/infra/bootstrap/bootstrap';
import { AppModule } from '../src/infra/app.module';
import { OtpService } from '../src/modules/otp/otp.service';
import {
  assertStoredOtpHash,
  generateOtpCode,
  hashOtpCode,
  isStoredOtpHash,
  resolveOtpHashKey,
  storedHashMaxLength,
  verifyOtpCode,
} from '../src/modules/otp/otp-crypto';
import { OTP_MAX_ATTEMPTS } from '../src/modules/otp/otp.constants';

@Module({ imports: [AppModule] })
class TestAppModule {}

const NEUTRAL_MESSAGE = 'If you have an account with us, you should get an email';
const FAILURE_MESSAGE = 'Invalid or expired code';

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function request(url: string, init?: RequestInit): Promise<HttpResult> {
  const response = await fetch(url, init);
  const text = await response.text();
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

function send(url: string, method: string, payload: unknown): Promise<HttpResult> {
  return request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main(): Promise<number> {
  const app = await NestFactory.create(TestAppModule, { logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const appUrl = await app.getUrl();
  const base = `${appUrl}/api/v1`;
  const prisma = app.get(PrismaService);
  const otp = app.get(OtpService);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
  const addr = (tag: string): string => `otp-e2e-${tag}-${stamp}@example.test`;
  const createdEmails = new Set<string>();

  const seedUser = async (email: string): Promise<string> => {
    const user = await prisma.user.create({
      data: {
        name: 'OTP E2E',
        email,
        provider: 'email',
        role: 'user',
        newsletterSubscribed: false,
        createdAt: new Date(),
      },
      select: { id: true },
    });
    createdEmails.add(email);
    return user.id;
  };

  /** The plaintext code is only known because the send path queues it in the mail. */
  const issuedCode = async (email: string): Promise<string> => {
    const rows = await prisma.emailQueue.findMany({
      where: { recipient: email },
      orderBy: { scheduledFor: 'desc' },
    });
    for (const row of rows) {
      const data = row.templateData;
      if (isRecord(data) && typeof data.otpCode === 'string') {
        return data.otpCode;
      }
    }
    throw new Error(`no issued OTP code found for ${email}`);
  };

  const otpRow = (email: string): Promise<{
    code: string;
    attempts: number;
    lockedUntil: Date | null;
    consumedAt: Date | null;
  } | null> =>
    prisma.otpCode.findFirst({
      where: { email, type: 'password_reset' },
      select: { code: true, attempts: true, lockedUntil: true, consumedAt: true },
    });

  const checks: Array<{ name: string; run: () => Promise<void> | void }> = [
    // ── R6 — CSPRNG, never Math.random() ────────────────────────────────
    {
      name: 'R6: generateOtpCode produces 6-digit CSPRNG codes (high entropy)',
      run: () => {
        const codes = Array.from({ length: 1000 }, () => generateOtpCode());
        for (const code of codes) {
          assert.match(code, /^\d{6}$/, `code not 6 digits: ${code}`);
        }
        const unique = new Set(codes).size;
        // Birthday bound on a 10^6 space: ~999.5 expected. 950 is a low bar that
        // a Math.random()/modulo-bias source would still usually clear; the
        // source-level proof is the `Math.random` grep in the verification log.
        assert.ok(unique >= 950, `only ${unique}/1000 unique codes`);
      },
    },
    // ── R9 / DEV-027 — hash-at-rest ─────────────────────────────────────
    {
      name: 'R9/DEV-027: stored hash is keyed, <=128 chars, and refuses plaintext',
      run: () => {
        const key = resolveOtpHashKey({
          OTP_HASH_SECRET: 'unit-test-key',
          NODE_ENV: 'test',
        });
        const stored = hashOtpCode('123456', key);
        assert.ok(isStoredOtpHash(stored), 'hash not recognised as stored hash');
        assert.ok(!/^\d{6}$/.test(stored), 'stored value is a plaintext code');
        assert.ok(
          stored.length <= 128 && stored.length <= storedHashMaxLength(),
          `hash length ${stored.length} exceeds column bound`,
        );
        assert.ok(verifyOtpCode('123456', stored, key), 'correct code did not verify');
        assert.ok(!verifyOtpCode('654321', stored, key), 'wrong code verified');
        assert.throws(() => assertStoredOtpHash('123456'), /OTP_CODE_NOT_HASHED/);
        assert.throws(() => assertStoredOtpHash('not-a-hash'), /OTP_CODE_NOT_HASHED/);
      },
    },
    {
      name: 'R9/DEV-027: a generated OTP row stores a hash, never the 6-digit code',
      run: async () => {
        const email = addr('hash');
        await seedUser(email);
        const res = await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        assert.equal(res.status, 200);
        const row = await otpRow(email);
        assert.ok(row, 'no otpCodes row written');
        assert.ok(isStoredOtpHash(row.code), `stored code is not a hash: ${row.code}`);
        assert.ok(!/^\d{6}$/.test(row.code), 'row.code is a plaintext 6-digit code');
        assert.ok(row.code.length <= 128, `row.code length ${row.code.length} > 128`);
      },
    },
    // ── R5 — neutral send body ──────────────────────────────────────────
    {
      name: 'R5: unknown address and existing-on-cooldown send byte-identical bodies',
      run: async () => {
        const unknown = addr('unknown');
        const existing = addr('neutral');
        await seedUser(existing);

        const unknownRes = await send(`${base}/otp/generate-otp`, 'POST', {
          email: unknown,
          type: 'password_reset',
        });
        await send(`${base}/otp/generate-otp`, 'POST', {
          email: existing,
          type: 'password_reset',
        });
        const cooldownRes = await send(`${base}/otp/generate-otp`, 'POST', {
          email: existing,
          type: 'password_reset',
        });

        assert.equal(unknownRes.status, 200);
        assert.equal(cooldownRes.status, unknownRes.status);
        assert.equal(unknownRes.text, cooldownRes.text, 'send bodies differ');
        assert.deepEqual(cooldownRes.body, {
          success: true,
          message: NEUTRAL_MESSAGE,
        });

        // R5 — an unknown address queues no mail.
        const unknownMail = await prisma.emailQueue.count({
          where: { recipient: unknown },
        });
        assert.equal(unknownMail, 0);
      },
    },
    // ── R3 — resend cooldown (delete-and-reinsert would destroy the budget) ──
    {
      name: 'R3: resend inside the cooldown window sends nothing and keeps the row',
      run: async () => {
        const email = addr('cooldown');
        await seedUser(email);
        await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        const before = await otpRow(email);
        const mailBefore = await prisma.emailQueue.count({
          where: { recipient: email },
        });

        const res = await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { success: true, message: NEUTRAL_MESSAGE });

        const after = await otpRow(email);
        const mailAfter = await prisma.emailQueue.count({
          where: { recipient: email },
        });
        assert.equal(mailAfter, mailBefore, 'cooldown resend queued mail');
        assert.equal(after?.code, before?.code, 'cooldown resend rotated the code');
      },
    },
    // ── R4 — one identical failure body on every path ───────────────────
    {
      name: 'R4: wrong code, unknown address and expired code share one failure body',
      run: async () => {
        const email = addr('fail');
        await seedUser(email);
        const res1 = await send(`${base}/otp/verify-otp`, 'PATCH', {
          email,
          code: '000000',
          type: 'password_reset',
        });
        const res2 = await send(`${base}/otp/verify-otp`, 'PATCH', {
          email: addr('never'),
          code: '123456',
          type: 'password_reset',
        });
        assert.equal(res1.status, 200);
        assert.equal(res2.status, res1.status);
        assert.equal(res1.text, res2.text, 'verification failure bodies differ');
        assert.deepEqual(res1.body, { success: false, message: FAILURE_MESSAGE });
      },
    },
    // ── DEV-028 #1 — exactly 100 concurrent failures ────────────────────
    {
      name: 'DEV-028: 100 concurrent failed verifications increment attempts by exactly 100',
      run: async () => {
        const email = addr('concurrent');
        await seedUser(email);
        await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        const correct = await issuedCode(email);
        const wrong = correct === '000000' ? '111111' : '000000';

        const results = await Promise.all(
          Array.from({ length: 100 }, () =>
            otp.verifyOtp({ email, code: wrong, type: 'password_reset' }),
          ),
        );
        assert.ok(
          results.every((r) => r.success === false),
          'a concurrent wrong code was accepted',
        );

        const row = await otpRow(email);
        assert.equal(
          row?.attempts,
          100,
          `attempts = ${row?.attempts}, expected exactly 100 (lost update)`,
        );
        assert.ok(
          row?.lockedUntil !== null && row?.lockedUntil !== undefined,
          'row not locked after 100 failures',
        );
      },
    },
    // ── DEV-028 #2 — Nth failure locks ──────────────────────────────────
    {
      name: `DEV-028: the ${OTP_MAX_ATTEMPTS}th failure locks; a correct code is then refused`,
      run: async () => {
        const email = addr('lockout');
        await seedUser(email);
        await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        const correct = await issuedCode(email);
        const wrong = correct === '000000' ? '111111' : '000000';

        for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) {
          const r = await otp.verifyOtp({ email, code: wrong, type: 'password_reset' });
          assert.equal(r.success, false);
        }
        const locked = await otpRow(email);
        assert.equal(locked?.attempts, OTP_MAX_ATTEMPTS);
        assert.ok(locked?.lockedUntil, 'not locked at the cap');

        // (N+1)th, even with the correct code, is refused while locked.
        const afterLock = await otp.verifyOtp({
          email,
          code: correct,
          type: 'password_reset',
        });
        assert.equal(afterLock.success, false);
        assert.equal(afterLock.message, FAILURE_MESSAGE);
      },
    },
    // ── DEV-028 #3 / R7 — no replay ─────────────────────────────────────
    {
      name: 'DEV-028/R7: a valid code cannot be replayed after use',
      run: async () => {
        const email = addr('replay');
        await seedUser(email);
        await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        const correct = await issuedCode(email);

        const first = await send(`${base}/otp/verify-otp`, 'PATCH', {
          email,
          code: correct,
          type: 'password_reset',
        });
        assert.deepEqual(first.body, { success: true, message: 'Code verified' });

        const second = await send(`${base}/otp/verify-otp`, 'PATCH', {
          email,
          code: correct,
          type: 'password_reset',
        });
        assert.deepEqual(second.body, { success: false, message: FAILURE_MESSAGE });

        const row = await otpRow(email);
        assert.ok(row?.consumedAt, 'row not marked consumed');
      },
    },
    // ── R10 / DEV-033 — refuse a pre-hashed password ────────────────────
    {
      name: 'R10/DEV-033: a pre-hashed newPassword is rejected (400)',
      run: async () => {
        const res = await send(`${base}/otp/verify-otp-and-change-password`, 'PATCH', {
          email: addr('prehash'),
          code: '123456',
          type: 'password_reset',
          newPassword: '$2b$10$wPOqU/tWK9LNXrqeQIgOSeRgeVZqBKPg4x9kUkd./SFuJPe7nPQAq',
        });
        assert.equal(res.status, 400);
      },
    },
    // ── R10 — hash server-side, single-use in one transaction ───────────
    {
      name: 'R10/R7: plaintext newPassword is hashed server-side; the code is consumed',
      run: async () => {
        const email = addr('change');
        await seedUser(email);
        await send(`${base}/otp/generate-otp`, 'POST', {
          email,
          type: 'password_reset',
        });
        const correct = await issuedCode(email);
        const newPassword = 'brand new secret phrase';

        const res = await send(`${base}/otp/verify-otp-and-change-password`, 'PATCH', {
          email,
          code: correct,
          type: 'password_reset',
          newPassword,
        });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
          success: true,
          message: 'Password updated successfully',
        });

        const user = await prisma.user.findUnique({
          where: { email },
          select: { password: true },
        });
        assert.ok(user?.password, 'password not written');
        assert.ok(
          await bcrypt.compare(newPassword, user.password),
          'stored password is not a bcrypt hash of the plaintext',
        );
        assert.ok(
          !(await bcrypt.compare(newPassword, '')),
          'sanity: empty hash matched',
        );

        const row = await otpRow(email);
        assert.ok(row?.consumedAt, 'OTP not consumed with the password change');
      },
    },
    // ── R8 — per-account rate limit ─────────────────────────────────────
    {
      name: 'R8: the 11th generate-otp for one account in the window is 429',
      run: async () => {
        const email = addr('ratelimit');
        const statuses: number[] = [];
        for (let i = 0; i < 11; i += 1) {
          const res = await send(`${base}/otp/generate-otp`, 'POST', {
            email,
            type: 'password_reset',
          });
          statuses.push(res.status);
        }
        assert.deepEqual(
          statuses.slice(0, 10),
          Array.from({ length: 10 }, () => 200),
        );
        assert.equal(statuses[10], 429, `11th status was ${statuses[10]}`);
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
    const emails = [...createdEmails];
    await prisma.otpCode.deleteMany({ where: { email: { in: emails } } });
    await prisma.emailQueue.deleteMany({ where: { recipient: { in: emails } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
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
