import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';

/** `users.role` values. The role is always read from the DB row, never a claim. */
export type AppRole = 'admin' | 'user';

/** Metadata key set by `@Public()`. */
export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Metadata key set by `@Roles(...)`. */
export const ROLES_KEY = 'auth:roles';

/**
 * The authenticated caller, resolved by `JwtAuthGuard` from the verified token
 * only. Carries **no role** — the role is a separate DB read (ADR-007).
 */
export interface AuthenticatedUser {
  /** Postgres `users.id` (UUID v7) from the verified token `sub`. */
  sub: string;
  /** Token id, for `POST /auth/revoke`. */
  jti: string;
  /** Token expiry, seconds since epoch. */
  exp: number;
}

/** An Express request carrying the guard-resolved caller. */
export interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

/**
 * Mark a route (or controller) as deliberately public. This is the **only** way
 * off the default-deny `JwtAuthGuard`. Absence of this decorator means guarded
 * (brief: the §10 matrix is an allowlist; absence never means "open").
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Require the caller's DB-resolved role to be one of `roles`. Enforced by
 * `RolesGuard` against the `users` row, never against a token claim.
 */
export const Roles = (...roles: AppRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Injects the guard-resolved `AuthenticatedUser`. Identity comes from the
 * verified token populated by `JwtAuthGuard`; a service never reads it from the
 * body, query, or a client-settable header (brief §2 prohibition 2).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      // Unreachable behind `JwtAuthGuard`; fail closed rather than return
      // undefined into a service (AGENTS.md Engineering Rule 2: no cast).
      throw new Error('CurrentUser used on an unguarded route');
    }
    return request.user;
  },
);
