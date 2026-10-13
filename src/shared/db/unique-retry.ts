/**
 * Prisma unique-conflict retry (shared). Promoted out of the Phase 06 engagement
 * service so Phase 07 ingest can reuse the exact same mechanism rather than fork
 * it — the same anti-fork rule the counter discipline follows.
 *
 * A unique-index race (P2002) is the signal that a concurrent same-key writer
 * won; the retry re-reads the now-committed row and completes this caller's
 * logical operation. `isUniqueViolation` is deliberately runtime-narrowed, never
 * cast (AGENTS.md Engineering Rule 2).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A Prisma unique-constraint violation — the concurrent same-key race signal. */
export function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

/**
 * Retry `fn` when a concurrent same-key writer wins the unique index. The retry
 * re-reads the (now changed) row and completes this caller's logical write — no
 * double insert, no negative counter.
 */
export async function withUniqueRetry<T>(
  fn: () => Promise<T>,
  attempts = 6,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt < attempts - 1 && isUniqueViolation(error)) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}
