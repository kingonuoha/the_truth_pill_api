/**
 * The single error envelope every failure response is shaped into.
 *
 * Emitted by `core/errors/all-exceptions.filter.ts`. It is deliberately
 * opaque: it carries only a status code, a stable machine code, a
 * client-safe message, optional validation details, the request path, and a
 * timestamp. It never carries a stack trace, SQL text, driver internals, or a
 * raw exception message. See Hard Rule 4 and brief DoD #3.
 */
export interface ErrorEnvelope {
  /** HTTP status code. */
  statusCode: number;
  /** Stable machine-readable code, e.g. `BAD_REQUEST`, `INTERNAL_SERVER_ERROR`. */
  code: string;
  /** Client-safe human message. Opaque for any 5xx. */
  message: string;
  /** Field-level validation messages, when the failure is a 4xx validation. */
  details?: string[];
  /** Request path that produced the failure. */
  path: string;
  /** ISO-8601 timestamp of the failure. */
  timestamp: string;
}
