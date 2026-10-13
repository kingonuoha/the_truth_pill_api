/**
 * A minimal fixed-window, in-process throttle.
 *
 * Used where a route needs a brute-force bound but no distributed store exists
 * yet. ⚠️ Per-instance only; a horizontally scaled API needs a shared store
 * (Phase 11). `now` is injectable so window behaviour is deterministic under
 * test.
 */
export interface ThrottleDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowThrottle {
  private static readonly MAX_KEYS = 10_000;

  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  consume(key: string, now: number = Date.now()): ThrottleDecision {
    this.evict(now);

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfterMs: 0 };
    }
    if (existing.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
    }
    existing.count += 1;
    return { allowed: true, remaining: this.limit - existing.count, retryAfterMs: 0 };
  }

  private evict(now: number): void {
    if (this.buckets.size < FixedWindowThrottle.MAX_KEYS) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
