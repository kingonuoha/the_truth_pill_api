import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Guard for `/internal/*` routes (AGENTS.md Hard Rule 6). Requires the
 * `x-internal-secret` header to equal `INTERNAL_JOB_SECRET`, compared
 * timing-safely.
 *
 * Fails closed when `INTERNAL_JOB_SECRET` is unset: an internal route with no
 * configured secret is 401, never open. This guard is applied per-controller
 * (`@UseGuards`) and is independent of the global `JwtAuthGuard` — internal
 * routes are marked `@Public()` so the JWT guard does not also demand a bearer
 * token, and this guard alone is the boundary.
 */
@Injectable()
export class InternalSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configured = this.config.get<string>('INTERNAL_JOB_SECRET');
    if (typeof configured !== 'string' || configured.length === 0) {
      throw new UnauthorizedException('Internal routes are not configured');
    }

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-internal-secret'];
    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException('Missing internal secret');
    }

    if (!timingSafeStringEqual(provided, configured)) {
      throw new UnauthorizedException('Invalid internal secret');
    }
    return true;
  }
}

/** Constant-time string comparison over equal-length SHA-256 digests. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
