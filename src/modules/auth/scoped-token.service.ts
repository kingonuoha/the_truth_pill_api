import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Purposes a scoped token may be minted for. A token is not valid across purposes. */
export type TokenPurpose =
  | 'newsletter-confirm'
  | 'newsletter-unsubscribe'
  | 'password-reset';

export interface ScopedTokenPayload {
  /** Purpose this token was minted for. */
  pur: TokenPurpose;
  /** Subject — the Postgres `users.id` the token acts on. */
  sub: string;
  /** One-time id — burned after first use. */
  jti: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

const TERMINATOR = '.';

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPurpose(value: unknown): value is TokenPurpose {
  return (
    value === 'newsletter-confirm' ||
    value === 'newsletter-unsubscribe' ||
    value === 'password-reset'
  );
}

function parseScopedPayload(value: unknown): ScopedTokenPayload | null {
  if (!isRecord(value)) return null;
  const { pur, sub, jti, exp } = value;
  if (!isPurpose(pur)) return null;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof jti !== 'string' || jti.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return { pur, sub, jti, exp };
}

/**
 * Mints and verifies the scoped bearer tokens used by the newsletter
 * confirmation, unsubscribe, and password-reset flows (DEV-035, DEV-036,
 * DEV-037).
 *
 * These are keyed by `API_TOKEN_SECRET` via a per-purpose HMAC, so a token for
 * one purpose cannot be replayed against another. Tokens are deliberately
 * **not** stored in plaintext anywhere: the database keeps only
 * `sha256(token)` (hash-at-rest, P02-SEC-001), and the raw token travels only
 * inside a link.
 *
 * CSPRNG: the `jti` and the confirmation nonce use `randomBytes`, never
 * `Math.random()` (DEV-036).
 */
@Injectable()
export class ScopedTokenService {
  /** Entropy carried by every token, in bytes (~192 bits of jti + nonce). */
  static readonly TOKEN_ENTROPY_BYTES = 24;

  constructor(private readonly config: ConfigService) {}

  private secret(): string {
    const secret = this.config.get<string>('API_TOKEN_SECRET');
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new UnauthorizedException('Token signing is not configured');
    }
    return secret;
  }

  /**
   * Mint a scoped token. Returns the raw token (for the link/email) plus its
   * SHA-256 hash (for the at-rest column).
   */
  mint(
    purpose: TokenPurpose,
    sub: string,
    ttlSeconds: number,
  ): { token: string; tokenHash: string; jti: string; expiresAt: Date } {
    const secret = this.secret();
    const now = Math.floor(Date.now() / 1000);
    const jti = `${randomUUID()}.${randomBytes(ScopedTokenService.TOKEN_ENTROPY_BYTES).toString('hex')}`;
    const payload: ScopedTokenPayload = {
      pur: purpose,
      sub,
      jti,
      exp: now + ttlSeconds,
    };

    const body = base64UrlEncode(JSON.stringify(payload));
    const mac = createHmac('sha256', `${secret}:${purpose}`)
      .update(body)
      .digest();
    const token = `${body}${TERMINATOR}${base64UrlEncode(mac)}`;

    return {
      token,
      tokenHash: this.hash(token),
      jti,
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  /** Verify a scoped token against an expected purpose. Throws 401 on any failure. */
  verify(purpose: TokenPurpose, token: string | undefined): ScopedTokenPayload {
    let secret: string;
    try {
      secret = this.secret();
    } catch {
      throw new UnauthorizedException('Token verification is not configured');
    }
    if (typeof token !== 'string' || token.length === 0) {
      throw new UnauthorizedException('Missing token');
    }

    const separator = token.lastIndexOf(TERMINATOR);
    if (separator <= 0 || separator === token.length - 1) {
      throw new UnauthorizedException('Malformed token');
    }
    const body = token.slice(0, separator);
    const providedMac = base64UrlDecode(token.slice(separator + 1));

    const expectedMac = createHmac('sha256', `${secret}:${purpose}`)
      .update(body)
      .digest();
    if (
      expectedMac.length !== providedMac.length ||
      !timingSafeEqual(expectedMac, providedMac)
    ) {
      throw new UnauthorizedException('Invalid token signature');
    }

    let payload: ScopedTokenPayload | null;
    try {
      payload = parseScopedPayload(
        JSON.parse(base64UrlDecode(body).toString('utf8')),
      );
    } catch {
      throw new UnauthorizedException('Malformed token payload');
    }

    if (!payload || payload.pur !== purpose) {
      throw new UnauthorizedException('Invalid token purpose');
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Token expired');
    }
    return payload;
  }

  /** SHA-256 hex of a token — the only form stored at rest. */
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
