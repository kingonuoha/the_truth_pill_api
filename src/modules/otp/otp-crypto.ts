import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  OTP_HASH_HEX_LENGTH,
  OTP_HASH_PREFIX,
  OTP_STORED_HASH_LENGTH,
} from './otp.constants';

/**
 * OTP cryptography — pure functions, no Nest, no DB, so the R6 and DEV-027
 * checks unit-test without an application or a connection.
 *
 * R6: codes come from `crypto.randomInt`, never `Math.random()`. `randomInt` is
 * rejection-sampled by Node, so there is no modulo bias to hand-roll (and no
 * `Math.random()` anywhere in this module — greppable).
 *
 * R9 / DEV-027: the code is stored as an HMAC-SHA256 keyed hash, never in
 * plaintext. The keyed form means a database reader cannot verify a guess
 * offline without the application secret.
 */

/** R6: a uniformly distributed 6-digit code, zero-padded. */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** R9: HMAC-SHA256 over the code, rendered `hmac-sha256:<64 hex>`. */
export function hashOtpCode(code: string, key: string): string {
  const digest = createHmac('sha256', key).update(code, 'utf8').digest('hex');
  return `${OTP_HASH_PREFIX}${digest}`;
}

/**
 * R9: format-and-length check for a value already in the column.
 *
 * A plaintext 6-digit code fails this, which is the point of DEV-027.
 */
export function isStoredOtpHash(value: string): boolean {
  if (!value.startsWith(OTP_HASH_PREFIX)) {
    return false;
  }
  const hex = value.slice(OTP_HASH_PREFIX.length);
  return (
    hex.length === OTP_HASH_HEX_LENGTH && /^[0-9a-f]+$/.test(hex)
  );
}

/**
 * R9 / DEV-027: refuse to persist anything that is not a keyed hash. Every
 * write to `otpCodes.code` goes through this, so a future refactor cannot
 * silently reintroduce a plaintext write.
 *
 * @throws Error when `value` is a plaintext code or any non-hash string.
 */
export function assertStoredOtpHash(value: string): void {
  if (!isStoredOtpHash(value)) {
    throw new Error(
      'OTP_CODE_NOT_HASHED: refusing to persist a value that is not a keyed ' +
        'hash — §CN-1 R9 / DEV-027.',
    );
  }
}

/** Maximum length the hash may occupy; asserted explicitly in the DEV-027 test. */
export function storedHashMaxLength(): number {
  return OTP_STORED_HASH_LENGTH;
}

/**
 * R9: constant-time comparison of a candidate code against the stored hash.
 * Returns `false` on any malformed stored value rather than throwing, so a
 * corrupt row is a normal verification failure, not a 500.
 */
export function verifyOtpCode(
  code: string,
  storedHash: string,
  key: string,
): boolean {
  if (!isStoredOtpHash(storedHash)) {
    return false;
  }
  const candidate = Buffer.from(hashOtpCode(code, key), 'utf8');
  const stored = Buffer.from(storedHash, 'utf8');
  return (
    candidate.length === stored.length && timingSafeEqual(candidate, stored)
  );
}

/** Environment slice needed to resolve the HMAC key. */
export interface OtpHashKeyEnv {
  OTP_HASH_SECRET?: string;
  AUTH_SECRET?: string;
  NODE_ENV?: string;
}

/**
 * Deliberate, documented, **non-secret** dev/test fallback. It is used only
 * when neither `OTP_HASH_SECRET` nor `AUTH_SECRET` is set and the app is not in
 * production; production fails closed instead (below). It is a convenience for
 * local runs, not a key.
 */
export const DEV_OTP_HASH_KEY =
  'truth-pill-dev-otp-hash-key-not-a-production-secret';

/**
 * Resolve the HMAC key for hash-at-rest. Precedence:
 *   1. `OTP_HASH_SECRET` — the dedicated key.
 *   2. `AUTH_SECRET`     — the app secret, if a dedicated one is not set.
 *   3. non-production     — `DEV_OTP_HASH_KEY`, so local dev/tests run.
 *   4. production         — **throw**. A keyed hash with no key is worse than
 *                           none: it looks safe and is not.
 */
export function resolveOtpHashKey(env: OtpHashKeyEnv): string {
  const dedicated = env.OTP_HASH_SECRET?.trim();
  if (dedicated) {
    return dedicated;
  }
  const authSecret = env.AUTH_SECRET?.trim();
  if (authSecret) {
    return authSecret;
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'OTP_HASH_SECRET (or AUTH_SECRET) is required in production to hash ' +
        'OTPs at rest — §CN-1 R9 / DEV-027.',
    );
  }
  return DEV_OTP_HASH_KEY;
}
