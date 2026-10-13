import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequestWithUser } from '../../shared/guards/auth.decorators';
import { FixedWindowThrottle } from '../../shared/throttle';

/** Frozen DEV-049 limit: one admin spends at most 10 billed calls per 60 s. */
export const BILLED_THROTTLE_LIMIT = 10;
export const BILLED_THROTTLE_WINDOW_MS = 60_000;

/**
 * Per-admin fixed-window limiter for the seven billed AI routes (DEV-049, S-011).
 *
 * Keyed on the verified token `sub` — never the request IP — because the
 * control bounds **one operator's spend**, not one host's request rate (matrix
 * §4 adjudication C). Runs after the global `JwtAuthGuard`/`RolesGuard`, so
 * `request.user` is always present for an admin route; a burst over the limit is
 * a 429 with a bounded `Retry-After`.
 *
 * ⚠️ The window store is per-instance (same caveat as the Phase 04/06/07
 * limiters); the shared-store hardening is Phase 11.
 */
@Injectable()
export class BilledThrottleGuard implements CanActivate {
  private readonly throttle = new FixedWindowThrottle(
    BILLED_THROTTLE_LIMIT,
    BILLED_THROTTLE_WINDOW_MS,
  );

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const response = context.switchToHttp().getResponse<Response>();
    const key = request.user?.sub ?? 'anonymous';
    const decision = this.throttle.consume(key);
    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      response.setHeader('Retry-After', String(retryAfterSeconds));
      throw new HttpException(
        { message: 'Too many requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
