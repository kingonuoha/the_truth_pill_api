import { createHash } from 'node:crypto';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';
import { OTP_ACCOUNT_THROTTLE, OTP_IP_THROTTLE } from '../otp.constants';

/**
 * R8 — rate limit the OTP routes per IP **and** per account.
 *
 * Two named throttlers, both applied to every OTP route by the base
 * `ThrottlerGuard` (imported once, globally, via `ThrottlerModule.forRoot`):
 *
 *   - `otp-ip`      — keyed on the connection IP. Bounds a burst from one host.
 *   - `otp-account` — keyed on a SHA-256 of the normalized `email` in the body,
 *                     so many IPs guessing one account are bounded too, not just
 *                     one IP guessing many accounts.
 *
 * The account tracker runs in the guard, **before** the validation pipe, so it
 * treats the body as untrusted: a non-string or absent `email` falls back to an
 * anonymous-per-IP key rather than throwing. The plaintext address is never the
 * key — it is hashed, so the in-memory store holds no PII.
 *
 * In-memory storage is per-process. With more than one Render instance the
 * effective limit is per-instance; a shared store is a Phase 11 concern.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requestIp(req: Record<string, unknown>): string {
  return typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : 'unknown';
}

export const OTP_THROTTLER_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [
    {
      name: 'otp-ip',
      ttl: OTP_IP_THROTTLE.ttlMs,
      limit: OTP_IP_THROTTLE.limit,
      getTracker: (req) => `ip:${requestIp(req)}`,
    },
    {
      name: 'otp-account',
      ttl: OTP_ACCOUNT_THROTTLE.ttlMs,
      limit: OTP_ACCOUNT_THROTTLE.limit,
      getTracker: (req) => {
        const body = req.body;
        const email =
          isRecord(body) && typeof body.email === 'string'
            ? body.email.trim().toLowerCase()
            : '';
        if (email.length === 0) {
          return `acct-anon:${requestIp(req)}`;
        }
        return `acct:${createHash('sha256').update(email).digest('hex')}`;
      },
    },
  ],
};

/** The configured throttler module, imported by `OtpModule`. */
export const OtpThrottlerModule = ThrottlerModule.forRoot(OTP_THROTTLER_OPTIONS);
