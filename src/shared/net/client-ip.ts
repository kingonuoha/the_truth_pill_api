import { isIP } from 'node:net';

/**
 * Client-IP parsing for the analytics ingest path (DEV-024 / DEV-039).
 *
 * Ported — never imported from `web/` — from the frozen `parseClientIp`
 * semantics in `web/lib/server-action-guards.ts:66-105` (S-026). The web helper
 * exists to keep a raw `x-forwarded-for` out of a third-party URL path; the same
 * validation is what the Phase 07 ingest needs so an attacker-controlled header
 * is never stored verbatim on `pageVisits.ipAddress` (DEV-024).
 *
 * Contract:
 * - first comma-separated hop only;
 * - an optional `[v6]:port` / `host:port` wrapper is stripped;
 * - an IPv4-mapped IPv6 value (`::ffff:1.2.3.4`) normalises to `1.2.3.4`;
 * - a value is accepted only when `node:net` `isIP` confirms it is v4/v6;
 * - anything malformed / multi-value-with-bad-first-hop / absent → `null`.
 *
 * The stored column stays `VARCHAR(45)` and historical rows stay byte-identical.
 */

/** The frozen sentinel the admin UI already compares against. */
export const CLIENT_IP_SENTINEL = '127.0.0.1';

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normaliseIp(raw: string): string | null {
  let candidate = raw.trim();
  if (candidate === '') return null;

  // Strip an optional port: `[::1]:443` -> `::1`, `1.2.3.4:443` -> `1.2.3.4`.
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) {
    candidate = bracketed[1];
  } else {
    const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(candidate);
    if (withPort) candidate = withPort[1];
  }

  const mapped = IPV4_MAPPED.exec(candidate);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];

  if (isIP(candidate) === 0) return null;
  return candidate;
}

/**
 * First hop of an `x-forwarded-for` header, or `null` when it is not a valid
 * address. Never returns the raw header.
 */
export function parseClientIp(
  headerValue: string | null | undefined,
): string | null {
  if (typeof headerValue !== 'string') return null;
  const firstHop = headerValue.split(',')[0] ?? '';
  return normaliseIp(firstHop);
}

/**
 * The value to store on `pageVisits.ipAddress`: a validated first hop, or the
 * `127.0.0.1` sentinel for malformed / multi-value-with-invalid-first-hop /
 * absent input. The raw header is never returned.
 */
export function resolveClientIp(
  headerValue: string | null | undefined,
): string {
  return parseClientIp(headerValue) ?? CLIENT_IP_SENTINEL;
}
