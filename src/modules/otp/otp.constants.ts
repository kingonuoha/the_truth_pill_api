import type { OtpType } from './otp.types';

/**
 * §CN-1 R1–R10 constants. One place, so the verifier, the send path, and the
 * tests all reason about the same numbers.
 */

/** OTP lifetime (R1/expiry). Frozen Convex used 10 minutes. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * R3 resend cooldown. A second `generateOtp` inside this window sends nothing
 * and returns the neutral body.
 */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * R2 lockout window. Deliberately **longer than `OTP_TTL_MS`**: once the cap is
 * hit, the code expires before the lock does, so "the Nth failure invalidates
 * the code" holds for the whole life of the code, not just the window.
 */
export const OTP_LOCK_DURATION_MS = 15 * 60 * 1000;

/**
 * R1 cap. The 5th failed verification sets `lockedUntil`; the 6th is refused
 * even with the correct code (CN-1 test 2).
 */
export const OTP_MAX_ATTEMPTS = 5;

/** R5 neutral send body — byte-identical on every send branch. */
export const OTP_NEUTRAL_SEND_MESSAGE =
  'If you have an account with us, you should get an email';

/** R4 single failure body — byte-identical on every verification branch. */
export const OTP_FAILURE_MESSAGE = 'Invalid or expired code';

export const OTP_VERIFIED_MESSAGE = 'Code verified';
export const OTP_PASSWORD_CHANGED_MESSAGE = 'Password updated successfully';

/** Subjects, verbatim from `web/convex/otp.ts:51-55`. */
export const OTP_SUBJECTS: Readonly<Record<OtpType, string>> = {
  password_reset: 'Reset Your Password - The Truth Pill',
  password_change: 'Verify Password Change - The Truth Pill',
};

export const OTP_TEMPLATE_NAME = 'otp_verification';
export const OTP_DEFAULT_SITE_URL = 'https://thetruthpill.org';

/**
 * R9 hash-at-rest. The stored value is `hmac-sha256:` + 64 hex chars = 76
 * characters, comfortably inside the `varchar(128)` column widened by DEV-027
 * (`20260930000000_otp_code_width`).
 */
export const OTP_HASH_PREFIX = 'hmac-sha256:';
export const OTP_HASH_HEX_LENGTH = 64;
/** Exact maximum length a valid stored hash can have. */
export const OTP_STORED_HASH_LENGTH = OTP_HASH_PREFIX.length + OTP_HASH_HEX_LENGTH;

/** The one shape a user-supplied code may take. */
export const OTP_CODE_PATTERN = /^\d{6}$/;

/**
 * R10 / DEV-033 password policy lives in `shared/dto/is-plaintext-password.ts`,
 * so the OTP and users modules enforce the same rule from one place. This module
 * only needs the bcrypt cost for hashing the accepted plaintext.
 */

/** bcrypt cost, matching the legacy hashes (`web/app/actions/auth.ts`). */
export const BCRYPT_COST = 10;

/** R8 rate limits. Per-account is the tight one; per-IP bounds a burst. */
export const OTP_ACCOUNT_THROTTLE = { limit: 10, ttlMs: 60_000 } as const;
export const OTP_IP_THROTTLE = { limit: 300, ttlMs: 60_000 } as const;
