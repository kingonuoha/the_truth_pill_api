import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  BCRYPT_COST,
  OTP_DEFAULT_SITE_URL,
  OTP_FAILURE_MESSAGE,
  OTP_LOCK_DURATION_MS,
  OTP_MAX_ATTEMPTS,
  OTP_NEUTRAL_SEND_MESSAGE,
  OTP_PASSWORD_CHANGED_MESSAGE,
  OTP_RESEND_COOLDOWN_MS,
  OTP_SUBJECTS,
  OTP_TEMPLATE_NAME,
  OTP_TTL_MS,
  OTP_VERIFIED_MESSAGE,
} from './otp.constants';
import {
  assertStoredOtpHash,
  generateOtpCode,
  hashOtpCode,
  resolveOtpHashKey,
  verifyOtpCode,
} from './otp-crypto';
import type { GenerateOtpDto } from './dto/generate-otp.dto';
import type { VerifyOtpAndChangePasswordDto } from './dto/verify-otp-and-change-password.dto';
import type { VerifyOtpDto } from './dto/verify-otp.dto';
import type { OtpSendResult, OtpType, OtpVerifyResult } from './otp.types';

/** Fields needed to make a verification decision. Never the whole row. */
interface OtpRow {
  id: string;
  code: string;
  expiresAt: Date;
  lockedUntil: Date | null;
  consumedAt: Date | null;
}

const OTP_ROW_SELECT = {
  id: true,
  code: true,
  expiresAt: true,
  lockedUntil: true,
  consumedAt: true,
} as const;

const NEUTRAL_SEND: OtpSendResult = {
  success: true,
  message: OTP_NEUTRAL_SEND_MESSAGE,
};

const FAILURE: OtpVerifyResult = {
  success: false,
  message: OTP_FAILURE_MESSAGE,
};

const VERIFIED: OtpVerifyResult = {
  success: true,
  message: OTP_VERIFIED_MESSAGE,
};

const PASSWORD_CHANGED: OtpVerifyResult = {
  success: true,
  message: OTP_PASSWORD_CHANGED_MESSAGE,
};

/**
 * The OTP service — §CN-1 R1–R10.
 *
 * Ported from `web/convex/otp.ts` (frozen). Validation, ordering, and response
 * *shapes* are matched; the security deficiencies are not (ADR-014). The
 * differences are DEV-027 (hash at rest), DEV-028 (atomic attempt counter,
 * lockout, cooldown, single-use), DEV-033 (server-side password hashing) and
 * R6 (CSPRNG).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly hashKey: string;
  private readonly siteUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    // Resolved once. In production this throws when neither secret is set
    // (fail closed — DEV-027); in dev/test it falls back to a non-secret key.
    this.hashKey = resolveOtpHashKey({
      OTP_HASH_SECRET: config.get<string>('OTP_HASH_SECRET'),
      AUTH_SECRET: config.get<string>('AUTH_SECRET'),
      NODE_ENV: config.get<string>('NODE_ENV'),
    });
    this.siteUrl = config.get<string>('SITE_URL') ?? OTP_DEFAULT_SITE_URL;
  }

  /**
   * R3/R5/R6/R9. Returns the neutral body on **every** branch — unknown
   * address, existing address, and cooldown — so the endpoint is not an
   * account-existence oracle.
   *
   * A resend inside the cooldown window patches nothing and queues no mail, but
   * returns the identical body. The row is always patched, never deleted and
   * re-inserted, so the attempt budget and cooldown survive (`web/convex/otp.ts`
   * deleted-and-reinserted, which destroyed both).
   */
  async generateOtp(dto: GenerateOtpDto): Promise<OtpSendResult> {
    const { email, type } = dto;
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      // R5 — no write, no mail, identical body.
      return NEUTRAL_SEND;
    }

    const existing = await this.prisma.otpCode.findFirst({
      where: { email, type },
      select: { id: true, lastSentAt: true },
    });

    if (
      existing !== null &&
      existing.lastSentAt !== null &&
      now.getTime() - existing.lastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      // R3 — inside cooldown: send nothing, return the neutral body.
      return NEUTRAL_SEND;
    }

    const code = generateOtpCode();
    const codeHash = hashOtpCode(code, this.hashKey);
    // R9 / DEV-027 — refuse to persist anything that is not a keyed hash.
    assertStoredOtpHash(codeHash);

    const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

    if (existing) {
      await this.prisma.otpCode.update({
        where: { id: existing.id },
        data: {
          code: codeHash,
          expiresAt,
          attempts: 0,
          lockedUntil: null,
          consumedAt: null,
          lastSentAt: now,
        },
      });
    } else {
      await this.prisma.otpCode.create({
        data: {
          email,
          type,
          code: codeHash,
          expiresAt,
          attempts: 0,
          lastSentAt: now,
        },
      });
    }

    await this.enqueueOtpEmail(email, type, code, now);
    return NEUTRAL_SEND;
  }

  /**
   * R1/R2/R4/R7. `verifyOtp` is a public read-only check (frozen Convex declared
   * it a `query` but it charged an attempt, which a query cannot do — hence
   * `PATCH`). It never changes state except on success (single-use consume).
   */
  async verifyOtp(dto: VerifyOtpDto): Promise<OtpVerifyResult> {
    const { email, code, type } = dto;
    const now = new Date();

    const row = await this.findOtpRow(email, type);
    if (row === null || this.isUnusable(row, now)) {
      return FAILURE;
    }

    if (!verifyOtpCode(code, row.code, this.hashKey)) {
      // R1 — atomic increment; one lost update would let an attacker reset the
      // budget by racing. This is the Prisma trap AGENTS.md Rule 5 warns about.
      await this.registerFailedAttempt(row.id, now);
      return FAILURE;
    }

    // R2 — a correct code inside the lockout window is still refused. The
    // window is a gate on the *code*, not merely on guessing.
    if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) {
      return FAILURE;
    }

    // R7 — single-use. Only one concurrent caller can win the conditional
    // consume; every later replay sees `consumedAt` and fails.
    const consumed = await this.consumeAtomically(row.id, now);
    return consumed ? VERIFIED : FAILURE;
  }

  /**
   * R1/R2/R4/R7/R10. Verifies the code, then changes the password in the same
   * transaction as the consume, so a successful verify cannot be replayed and a
   * failed consume cannot leave a half-applied password change.
   *
   * `newPassword` is **plaintext** and hashed here (R10 / DEV-033). The legacy
   * mutation trusted a caller-supplied hash, which is account takeover via a
   * disclosed hash.
   */
  async verifyOtpAndChangePassword(
    dto: VerifyOtpAndChangePasswordDto,
  ): Promise<OtpVerifyResult> {
    const { email, code, type, newPassword } = dto;
    const now = new Date();

    const row = await this.findOtpRow(email, type);
    if (row === null || this.isUnusable(row, now)) {
      return FAILURE;
    }
    if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) {
      return FAILURE;
    }
    if (!verifyOtpCode(code, row.code, this.hashKey)) {
      await this.registerFailedAttempt(row.id, now);
      return FAILURE;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (!user) {
      return FAILURE;
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

    const applied = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "otpCodes"
        SET "consumedAt" = ${now}
        WHERE "id" = ${row.id} AND "consumedAt" IS NULL
        RETURNING "id"`;
      if (consumed.length !== 1) {
        return false;
      }
      await tx.user.update({
        where: { id: user.id },
        data: {
          password: passwordHash,
          resetToken: null,
          resetTokenExpires: null,
        },
      });
      return true;
    });

    return applied ? PASSWORD_CHANGED : FAILURE;
  }

  /** Most-recent row for `(email, type)`; the table is one-row-per-pair. */
  private findOtpRow(email: string, type: OtpType): Promise<OtpRow | null> {
    return this.prisma.otpCode.findFirst({
      where: { email, type },
      select: OTP_ROW_SELECT,
    });
  }

  /** Consumed or expired rows are refused before any attempt is charged. */
  private isUnusable(row: OtpRow, now: Date): boolean {
    return (
      row.consumedAt !== null || row.expiresAt.getTime() <= now.getTime()
    );
  }

  /**
   * R1 — the atomic raw update. Never `findUnique` → `update`: at Postgres'
   * default `READ COMMITTED` two concurrent read-then-writes both commit and the
   * second silently loses an increment (`$transaction` does not rescue it).
   *
   * The `CASE` sets `lockedUntil` exactly when the post-increment count reaches
   * the cap and the row is not already locked, and otherwise leaves it
   * unchanged, so a locked row's further failures do not extend the window.
   *
   * Note (deliberate): a **wrong** code always increments, even while locked —
   * the lock gates acceptance of a correct code, not the counter. This is what
   * makes the DEV-028 100-concurrent-failures test assert exactly 100 rather
   * than "however many requests happened to read the lock after it committed".
   */
  private async registerFailedAttempt(id: string, now: Date): Promise<void> {
    const lockUntil = new Date(now.getTime() + OTP_LOCK_DURATION_MS);
    await this.prisma.$executeRaw`
      UPDATE "otpCodes"
      SET "attempts" = "attempts" + 1,
          "lockedUntil" = CASE
            WHEN ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
                 AND ("attempts" + 1) >= ${OTP_MAX_ATTEMPTS}
            THEN ${lockUntil}
            ELSE "lockedUntil"
          END
      WHERE "id" = ${id}`;
  }

  /**
   * R7 — conditional consume is itself atomic: `consumedAt` is set only if it is
   * still `NULL`, and the affected-row count tells the caller whether it won.
   */
  private async consumeAtomically(id: string, now: Date): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "otpCodes"
      SET "consumedAt" = ${now}
      WHERE "id" = ${id} AND "consumedAt" IS NULL
      RETURNING "id"`;
    return rows.length === 1;
  }

  /**
   * Queue the OTP mail. A failure here must **not** surface to the caller: only
   * an existing-address request reaches this point, so a 500 would itself be an
   * existence oracle. Log server-side, return the neutral body regardless.
   *
   * `EMAIL_*` is empty, so the SMTP leg is ⏳ PENDING — queue insertion is what
   * is verified here (brief DoD #9 / task caveat).
   */
  private async enqueueOtpEmail(
    email: string,
    type: OtpType,
    code: string,
    now: Date,
  ): Promise<void> {
    try {
      await this.prisma.emailQueue.create({
        data: {
          recipient: email,
          subject: OTP_SUBJECTS[type],
          templateName: OTP_TEMPLATE_NAME,
          templateData: { otpCode: code, siteUrl: this.siteUrl },
          status: 'pending',
          scheduledFor: now,
          retries: 0,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Never include the code or the address in the log line.
      this.logger.error(`OTP email enqueue failed: ${detail}`);
    }
  }
}
