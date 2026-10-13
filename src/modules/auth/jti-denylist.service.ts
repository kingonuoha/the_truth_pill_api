import { Injectable, Logger } from '@nestjs/common';

/**
 * In-process `jti` deny-list for API access tokens (ADR-017).
 *
 * Per-entry TTL equals the token's own `exp`, so the list self-sweeps: a `jti`
 * is dropped the instant the token it names could no longer be accepted anyway.
 * A revoked token is 401 until it expires; roles are never revoked here — a
 * demotion lands on the next request because the role is read from the DB.
 *
 * ⚠️ Per-instance limitation: the list lives on the single Render web service.
 * A horizontally scaled API needs a shared store (Phase 11). Recorded in
 * ADR-017; not introduced silently.
 */
@Injectable()
export class JtiDenylistService {
  private readonly logger = new Logger(JtiDenylistService.name);
  private readonly revoked = new Map<string, number>();
  private lastSweepMs = 0;
  private static readonly SWEEP_INTERVAL_MS = 30_000;

  /** Revoke `jti` until `expMsSinceEpoch` (the token's own expiry). */
  revoke(jti: string, expMsSinceEpoch: number): void {
    if (typeof jti !== 'string' || jti.length === 0) return;
    this.sweep(Date.now());
    this.revoked.set(jti, expMsSinceEpoch);
  }

  isRevoked(jti: string, nowMs: number = Date.now()): boolean {
    if (typeof jti !== 'string' || jti.length === 0) return false;
    this.sweep(nowMs);
    const expiresAt = this.revoked.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt <= nowMs) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }

  /** Sweep expired entries, at most once per interval (lazy, no timer). */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < JtiDenylistService.SWEEP_INTERVAL_MS) return;
    this.lastSweepMs = nowMs;
    const sizeBefore = this.revoked.size;
    for (const [jti, expiresAt] of this.revoked) {
      if (expiresAt <= nowMs) this.revoked.delete(jti);
    }
    if (sizeBefore !== this.revoked.size) {
      this.logger.debug(
        `jti deny-list swept ${sizeBefore - this.revoked.size} expired entries`,
      );
    }
  }
}
