/**
 * Bounded Neon `SELECT 1` keepalive for the worker (ADR-018).
 *
 * Neon suspends compute after ~5 minutes idle. The worker holds no socket: on
 * its idle interval it wakes a suspended compute with a short-lived `SELECT 1`,
 * bounded by retry/backoff so a cold resume cannot wedge a tick (P05-SEC-003).
 * Nothing about the result is logged beyond success/failure — no host, no
 * connection string, no error text (Hard Rule 8).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../core/prisma/prisma.service';

const MINUTE = 60_000;
/** Idle liveness interval. */
const DB_KEEPALIVE_MS = 5 * MINUTE;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class DbKeepaliveService {
  private readonly logger = new Logger(DbKeepaliveService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Interval('worker-db-keepalive', DB_KEEPALIVE_MS)
  async keepalive(): Promise<void> {
    const awake = await this.wakeDatabase();
    if (!awake) this.logger.warn('db keepalive: compute did not respond');
  }

  /**
   * Wake a suspended compute with bounded retry/backoff. Returns `true` on the
   * first successful round-trip, `false` after the attempts are exhausted. Never
   * throws, never logs internals.
   */
  async wakeDatabase(): Promise<boolean> {
    const backoffMs = [0, 250, 1_000];
    for (const delay of backoffMs) {
      if (delay > 0) await sleep(delay);
      try {
        await this.prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        // Bounded retry — the next backoff attempt follows.
      }
    }
    return false;
  }
}
