/**
 * The in-process SSE ticket store (matrix §1.2, DEV-054).
 *
 * A ticket is a **single-use, 30-second, 256-bit** credential. Only its
 * **SHA-256 digest** is stored; the raw value is returned once at mint and is
 * never persisted or logged. Redemption deletes the record, so a replay is
 * inert. The record is bound to the principal and the authorized topic set, so
 * a stolen ticket cannot be re-aimed at `admin:*`.
 *
 * ⚠️ In-process and single-instance by design (ADR-005, brief caveat). A
 * horizontally scaled API needs a shared store — a Phase 11 constraint,
 * matching `JtiDenylistService`.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

/** Frozen ticket lifetime (`realtime.md` §2). */
export const TICKET_TTL_SECONDS = 30;

/** A redemption failure is a normal HTTP 403 **before** the stream opens. */
export class TicketInvalidException extends ForbiddenException {
  constructor() {
    super({ message: ['TICKET_INVALID'] });
  }
}

/** An expired ticket is a normal HTTP 403 **before** the stream opens. */
export class TicketExpiredException extends ForbiddenException {
  constructor() {
    super({ message: ['TICKET_EXPIRED'] });
  }
}

interface TicketRecord {
  principal: string | null;
  topics: string[];
  expiresAt: number;
}

/** The redeemed ticket the connection is bound to. */
export interface RedeemedTicket {
  principal: string | null;
  topics: string[];
  expiresAt: number;
}

/** SHA-256 hex digest of a ticket value — the only form ever stored. */
export function ticketDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

@Injectable()
export class StreamTicketStore {
  private readonly tickets = new Map<string, TicketRecord>();

  /**
   * Mint a ticket bound to `principal` (verified `sub` or `null`) and the
   * authorized `topics`. Returns the raw value **once**.
   */
  mint(
    principal: string | null,
    topics: string[],
    ttlSeconds: number = TICKET_TTL_SECONDS,
  ): { ticket: string; expiresIn: number } {
    this.evictExpired();
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticketDigest(ticket), {
      principal,
      topics: [...topics],
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return { ticket, expiresIn: ttlSeconds };
  }

  /**
   * Redeem a ticket exactly once. The record is deleted before any check
   * completes, so even an expired ticket cannot be raced into a second use.
   */
  redeem(raw: string): RedeemedTicket {
    const digest = ticketDigest(raw);
    const record = this.tickets.get(digest);
    if (!record) throw new TicketInvalidException();
    this.tickets.delete(digest);
    if (record.expiresAt <= Date.now()) throw new TicketExpiredException();
    return { principal: record.principal, topics: record.topics, expiresAt: record.expiresAt };
  }

  /**
   * Test/observability only: the stored **digests**, never the raw tickets.
   * Proves the raw value is never persisted (DEV-054).
   */
  storedDigests(): string[] {
    return [...this.tickets.keys()];
  }

  /** Drop expired entries so the map cannot grow without bound. */
  private evictExpired(): void {
    const now = Date.now();
    for (const [digest, record] of this.tickets) {
      if (record.expiresAt <= now) this.tickets.delete(digest);
    }
  }
}
