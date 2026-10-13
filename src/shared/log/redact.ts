/**
 * Log-redaction helpers (AGENTS.md Hard Rule 8; SSE matrix §9 D, DEV-054).
 *
 * The SSE ticket is a 30-second bearer credential that travels in the query
 * string (`?ticket=…`). It must never be written to a log line, an error
 * envelope, or an access trace. This module is the single redactor every
 * stream-aware log/error path uses.
 *
 * The raw ticket value is never returned by these helpers; only the redacted
 * URL or a placeholder.
 */

/** The token written in place of a ticket value. */
export const REDACTED = '***';

const TICKET_QUERY = /([?&]ticket=)[^&#\s]*/gi;

/**
 * Redact every `ticket=` query value from a URL or arbitrary string.
 *
 * Matches `?ticket=` and `&ticket=` regardless of case, leaves the surrounding
 * URL intact, and is safe to call on any string (a non-URL string is returned
 * unchanged unless it contains a `ticket=` segment).
 */
export function redactTicket(input: string): string {
  return input.replace(TICKET_QUERY, `$1${REDACTED}`);
}

/**
 * Redact a request URL for logging. Express `req.url` carries the query string,
 * so this is the function every error/log path calls before writing the URL.
 */
export function redactUrl(url: string): string {
  return redactTicket(url);
}
