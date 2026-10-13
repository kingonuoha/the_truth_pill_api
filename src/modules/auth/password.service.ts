import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';

/** bcrypt cost, matching the legacy `bcrypt.hash(password, 10)` call sites. */
export const BCRYPT_COST = 10;

/** bcrypt's input limit; a longer plaintext is rejected rather than truncated. */
export const MAX_PASSWORD_BYTES = 72;

const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

/**
 * Server-side password hashing and verification (DEV-033).
 *
 * The legacy API accepted a caller-supplied, pre-hashed `password` and stored it
 * as the new credential. Here the plaintext is hashed server-side, and a value
 * that already looks like a bcrypt hash is refused (see `isPreHashedBcrypt`) so
 * a client cannot plant its own hash chain.
 *
 * Stored hashes are portable `$2b$` modular-crypt, copied verbatim from Convex
 * (AGENTS.md "Non-deviations"): `compare` never re-hashes a stored value.
 */
@Injectable()
export class PasswordService {
  /** Return true when `value` is already a bcrypt hash (a caller-supplied hash). */
  isPreHashedBcrypt(value: string): boolean {
    return BCRYPT_HASH_PATTERN.test(value);
  }

  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, BCRYPT_COST);
  }

  async verify(plaintext: string, storedHash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plaintext, storedHash);
    } catch {
      // A malformed stored hash must fail closed, not throw a 500.
      return false;
    }
  }
}
