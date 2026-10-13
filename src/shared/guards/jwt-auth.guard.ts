import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../core/prisma/prisma.service';
import { TokenService } from '../../modules/auth/token.service';
import { JtiDenylistService } from '../../modules/auth/jti-denylist.service';
import {
  AuthenticatedUser,
  IS_PUBLIC_KEY,
  RequestWithUser,
} from './auth.decorators';

/**
 * The global default-deny guard (ADR-007 + ADR-017, brief §2).
 *
 * Reads the token from `Authorization: Bearer` **only**. A token in a body
 * field, a query string, or any client-settable header is ignored. Verified
 * identity is the single source of truth for the whole app: this guard is the
 * only place `sub` is resolved, and it populates `request.user` with
 * `{ sub, jti, exp }` — never a role.
 *
 * Fail closed: absent / malformed / expired / wrong-aud / wrong-iss /
 * revoked-jti / unknown-sub → **401**. A route is public only when it carries
 * `@Public()`; absence of that decorator means guarded.
 *
 * On a `@Public()` route an optional token is resolved for attribution
 * (e.g. `logPageVisit`), but an invalid one is ignored rather than fatal — the
 * route is public either way, and no protected path is reachable.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly denylist: JtiDenylistService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.isPublic(context);
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const token = extractBearerToken(request);
    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Authentication required');
    }

    let payload;
    try {
      payload = this.tokens.verify(token);
    } catch (error) {
      if (isPublic) return true;
      throw error instanceof UnauthorizedException
        ? error
        : new UnauthorizedException('Invalid token');
    }

    if (this.denylist.isRevoked(payload.jti)) {
      if (isPublic) return true;
      throw new UnauthorizedException('Token has been revoked');
    }

    const exists = await this.userExists(payload.sub);
    if (!exists) {
      if (isPublic) return true;
      // A validly signed token for a row that no longer exists is 401, not a
      // claim-based authorisation (brief §2 prohibition 3).
      throw new UnauthorizedException('Unknown subject');
    }

    const user: AuthenticatedUser = {
      sub: payload.sub,
      jti: payload.jti,
      exp: payload.exp,
    };
    request.user = user;
    return true;
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  private async userExists(sub: string): Promise<boolean> {
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: sub },
        select: { id: true },
      });
      return row !== null;
    } catch {
      // A `sub` that is not a valid UUID throws at the driver. It cannot name a
      // row, so it is treated as unknown (401).
      return false;
    }
  }
}

/** Extract the bearer value from the `Authorization` header only. */
export function extractBearerToken(request: {
  headers?: Record<string, unknown>;
}): string | undefined {
  const raw = request.headers?.authorization;
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : undefined;
}
