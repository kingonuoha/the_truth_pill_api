import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** The exact `aud` ADR-017 pins for every API access token. */
export const API_TOKEN_AUDIENCE = 'truth-pill-api';

/** Fallback issuer when `API_TOKEN_ISSUER` is unset (ADR-017: site URL). */
export const DEFAULT_API_TOKEN_ISSUER = 'https://thetruthpill.org';

/** ADR-017: TTL 300 s. */
export const API_TOKEN_TTL_SECONDS = 300;

/** ADR-017: verifier `clockTolerance` 30 s. */
export const API_TOKEN_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * The verified token payload. A named type with explicit field checks — never
 * `any`, never an unchecked cast (AGENTS.md Engineering Rule 2).
 *
 * Deliberately **no `role` / `roles` / `email` field**: ADR-007 forbids reading
 * a role from the token, so the type cannot carry one.
 */
export interface ApiTokenPayload {
  /** Issuer — the site URL, no trailing slash. */
  iss: string;
  /** Audience — always `truth-pill-api`. */
  aud: string;
  /** Postgres `users.id` (UUID v7). The only identity input. */
  sub: string;
  /** One-time token id — the revocation key. */
  jti: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

interface JwtHeader {
  alg: string;
  typ: string;
}

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

/**
 * Runtime-validate a decoded JWT payload. Returns the payload or `null` — never
 * throws and never casts. A token that carries a `role` claim parses fine; the
 * claim is simply dropped (it is not part of `ApiTokenPayload`).
 */
function parseApiTokenPayload(value: unknown): ApiTokenPayload | null {
  if (!isRecord(value)) return null;
  const { iss, aud, sub, jti, iat, exp } = value;

  if (typeof iss !== 'string' || iss.length === 0) return null;
  if (typeof aud !== 'string') return null;
  if (typeof sub !== 'string' || sub.length === 0) return null;
  if (typeof jti !== 'string' || jti.length === 0) return null;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;

  return { iss, aud, sub, jti, iat, exp };
}

function parseJwtHeader(value: unknown): JwtHeader | null {
  if (!isRecord(value)) return null;
  const { alg, typ } = value;
  if (typeof alg !== 'string' || typeof typ !== 'string') return null;
  return { alg, typ };
}

/**
 * Mints and verifies the ADR-017 purpose-issued API access token.
 *
 * HS256, signed with `API_TOKEN_SECRET`. An optional verify-only
 * `API_TOKEN_SECRET_PREVIOUS` forms a two-key ring so a secret rotation is
 * zero-downtime. The secret is **never** `AUTH_SECRET` and never a
 * `NEXT_PUBLIC_*` value (ADR-017).
 *
 * Fail closed — an absent secret, malformed token, bad signature, or claim
 * mismatch throws `UnauthorizedException` (401). Minting with no configured
 * secret also throws — there is no unsigned fallback.
 */
@Injectable()
export class TokenService {
  constructor(private readonly config: ConfigService) {}

  private primarySecret(): string | null {
    const secret = this.config.get<string>('API_TOKEN_SECRET');
    return typeof secret === 'string' && secret.length > 0 ? secret : null;
  }

  private verifySecrets(): string[] {
    const secrets: string[] = [];
    const primary = this.primarySecret();
    if (primary) secrets.push(primary);
    const previous = this.config.get<string>('API_TOKEN_SECRET_PREVIOUS');
    if (typeof previous === 'string' && previous.length > 0) {
      secrets.push(previous);
    }
    return secrets;
  }

  private issuer(): string {
    const configured = this.config.get<string>('API_TOKEN_ISSUER');
    return typeof configured === 'string' && configured.length > 0
      ? configured
      : DEFAULT_API_TOKEN_ISSUER;
  }

  /**
   * Sign a token for `sub`. Server-side callers only (Next RSC / action /
   * route handler). The browser never receives one (ADR-017).
   */
  sign(
    sub: string,
    options?: { ttlSeconds?: number },
  ): { token: string; expiresIn: number; jti: string } {
    const secret = this.primarySecret();
    if (!secret) {
      throw new UnauthorizedException('API token signing is not configured');
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = options?.ttlSeconds ?? API_TOKEN_TTL_SECONDS;
    const jti = randomUUID();

    const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
    const payload: ApiTokenPayload = {
      iss: this.issuer(),
      aud: API_TOKEN_AUDIENCE,
      sub,
      jti,
      iat: now,
      exp: now + ttl,
    };

    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
      JSON.stringify(payload),
    )}`;
    const signature = base64UrlEncode(
      createHmac('sha256', secret).update(signingInput).digest(),
    );

    return { token: `${signingInput}.${signature}`, expiresIn: ttl, jti };
  }

  /**
   * Verify a token from the `Authorization: Bearer` header value. Throws 401 on
   * any failure. The claim contract (issuer/audience/expiry/tolerance) is
   * enforced in exactly this one place.
   */
  verify(bearerValue: string | undefined): ApiTokenPayload {
    const secrets = this.verifySecrets();
    if (secrets.length === 0) {
      throw new UnauthorizedException('API token verification is not configured');
    }
    if (typeof bearerValue !== 'string' || bearerValue.length === 0) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const parts = bearerValue.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedException('Malformed token');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    let header: JwtHeader | null;
    let payload: ApiTokenPayload | null;
    let signature: Buffer;
    try {
      header = parseJwtHeader(
        JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')),
      );
      payload = parseApiTokenPayload(
        JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')),
      );
      signature = base64UrlDecode(encodedSignature);
    } catch {
      throw new UnauthorizedException('Malformed token');
    }

    if (!header || header.alg !== 'HS256' || header.typ !== 'JWT') {
      throw new UnauthorizedException('Unsupported token algorithm');
    }
    if (!payload) {
      throw new UnauthorizedException('Malformed token payload');
    }

    const signingInput = `${encodedHeader}.${encodedPayload}`;
    if (!this.signatureMatches(signingInput, signature, secrets)) {
      throw new UnauthorizedException('Invalid token signature');
    }

    if (payload.aud !== API_TOKEN_AUDIENCE) {
      throw new UnauthorizedException('Invalid token audience');
    }
    if (payload.iss !== this.issuer()) {
      throw new UnauthorizedException('Invalid token issuer');
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now - API_TOKEN_CLOCK_TOLERANCE_SECONDS) {
      throw new UnauthorizedException('Token expired');
    }
    if (payload.iat > now + API_TOKEN_CLOCK_TOLERANCE_SECONDS) {
      throw new UnauthorizedException('Token issued in the future');
    }

    return payload;
  }

  private signatureMatches(
    signingInput: string,
    signature: Buffer,
    secrets: string[],
  ): boolean {
    for (const secret of secrets) {
      const expected = createHmac('sha256', secret)
        .update(signingInput)
        .digest();
      if (
        expected.length === signature.length &&
        timingSafeEqual(expected, signature)
      ) {
        return true;
      }
    }
    return false;
  }
}
