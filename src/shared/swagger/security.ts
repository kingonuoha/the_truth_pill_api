import { applyDecorators } from '@nestjs/common';
import { ApiSecurity } from '@nestjs/swagger';

/**
 * OpenAPI security-scheme names, and the decorator that makes a deliberately
 * anonymous operation say so in the generated contract.
 *
 * The runtime model is default-deny: `JwtAuthGuard` is registered globally
 * (`infra/app.module.ts`) and a route is only reachable anonymously when it
 * carries `@Public()`. The spec mirrors that exactly — `buildOpenApiDocument`
 * declares `security: [{ bearerAuth: [] }]` at the document root, so **every**
 * operation is bearer-protected unless it says otherwise here. A new controller
 * that forgets its auth metadata therefore lands in the spec as protected, the
 * same way it lands in the runtime as guarded.
 *
 * The four postures an operation can have, and their spec expression:
 *
 * | Runtime                                        | Spec                       |
 * | ---------------------------------------------- | -------------------------- |
 * | global `JwtAuthGuard` (default-deny)          | inherited `bearerAuth`     |
 * | `@Public()`                                    | `PublicOperation()` → `{}` |
 * | `@Public()` + `@OptionalAuth()`                | `OptionalAuthOperation()` → `[{}, {bearerAuth: []}]` |
 * | `@Public()` + `InternalSecretGuard`            | `@ApiSecurity(internalJobSecret)` |
 *
 * `PublicOperation()` emits an **empty** Security Requirement Object. In
 * OpenAPI an empty requirement is the anonymous alternative, which is exactly
 * what `@Public()` means; `security: []` is not usable here because
 * `@nestjs/swagger` strips empty array metadata before it reaches the document
 * (`omitBy(methodMetadata, isEmpty)` in `swagger-explorer.js`) and the operation
 * would silently fall back to the inherited `bearerAuth` default.
 */

/** `components.securitySchemes.bearerAuth` — ADR-017's `Authorization: Bearer <jwt>`. */
export const BEARER_SECURITY_SCHEME = 'bearerAuth';

/**
 * `components.securitySchemes.internalJobSecret` — the `x-internal-secret`
 * header compared timing-safely against `INTERNAL_JOB_SECRET` on `/internal/*`
 * (AGENTS.md Hard Rule 6). An apiKey scheme, not a bearer: the worker and Render
 * Cron present a shared secret, not an ADR-017 token.
 */
export const INTERNAL_SECRET_SECURITY_SCHEME = 'internalJobSecret';

/** The header `InternalSecretGuard` reads. Mirrors the guard, do not drift from it. */
export const INTERNAL_SECRET_HEADER = 'x-internal-secret';

/**
 * Mark an operation as deliberately anonymous, mirroring `@Public()`.
 *
 * Apply it on the **same** target as `@Public()` — controller level when the
 * whole controller is public, method level otherwise. A divergence between the
 * two decorators publishes a route in the spec with the wrong posture; the two
 * are the runtime and contract halves of one decision.
 */
export const PublicOperation = (): MethodDecorator & ClassDecorator =>
  ApiSecurity({});

/**
 * Mark an operation as **token-optional**: anonymous is permitted *and* a bearer
 * token is honoured when one arrives (DEV-058).
 *
 * `OptionalAuthGuard` serves an anonymous caller and, separately, resolves a
 * valid token to attach the subject — visitor dedupe, per-viewer reaction and
 * bookmark state, and SSE topic authorisation all depend on that token arriving.
 * `PublicOperation()` alone publishes `security: [{}]`, which instructs a
 * generated client to send **no** credential; the token then never arrives and
 * the operation silently degrades to anonymous with no error anywhere. So this
 * publishes both alternatives:
 *
 * ```yaml
 * security:
 *   - {}                    # anonymous is permitted
 *   - bearerAuth: []        # a token is accepted and changes the result
 * ```
 *
 * ## Why it replaces `PublicOperation()` rather than stacking on it
 *
 * `@nestjs/swagger` concatenates security metadata (`extendMetadata` →
 * `existing.concat(new)` in `extend-metadata.util.js`), and
 * `exploreApiSecurityMetadata` publishes that array verbatim. Stacking
 * `@PublicOperation()` on top would therefore emit
 * `[{}, {bearerAuth: []}, {}]` — a duplicate requirement, not a wider one, but
 * wrong. This decorator is the whole contract: apply **this or**
 * `PublicOperation()`, never both.
 *
 * Apply it on the same target as `@OptionalAuth()` — they are the runtime and
 * contract halves of one decision, and a divergence publishes a route with the
 * wrong posture.
 */
export const OptionalAuthOperation = (): MethodDecorator & ClassDecorator =>
  applyDecorators(ApiSecurity({}), ApiSecurity(BEARER_SECURITY_SCHEME));