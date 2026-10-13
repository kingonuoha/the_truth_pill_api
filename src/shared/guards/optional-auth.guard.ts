import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { TokenService } from '../../modules/auth/token.service';
import { JtiDenylistService } from '../../modules/auth/jti-denylist.service';
import { AuthenticatedUser, RequestWithUser } from './auth.decorators';
import { extractBearerToken } from './jwt-auth.guard';

/**
 * Shared `@OptionalAuth()` mechanism for token-optional public routes.
 *
 * Promoted out of `api/src/modules/engagement/optional-auth.guard.ts` in Phase 07
 * (matrix adjudication A) so the analytics ingest routes reuse ONE fail-closed
 * implementation instead of forking a second copy. Behaviour is byte-identical —
 * this changes no route semantics. The Phase 06 `getEngagement` contract
 * (DEV-044) is preserved: the engagement controller re-points to this export.
 *
 * The Phase 04 guard set is binary (`@Public()` xor default-deny) and cannot
 * express "public, but authenticate if a token is offered". This guard sits on an
 * already-`@Public()` route and only adds optional attribution / per-viewer state.
 *
 * Fail-closed contract:
 * - no token  → anonymous, `request.user` unset;
 * - valid token → the caller from the verified `sub`;
 * - present-but-invalid / expired / wrong `aud`/`iss` / revoked `jti` /
 *   unknown `sub` → **401**, never a silent anonymous downgrade.
 *
 * It reads `Authorization` only; a `token`/`apiToken` in query or body is a 400
 * via the global `forbidNonWhitelisted` pipe.
 */
@Injectable()
export class OptionalAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly denylist: JtiDenylistService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = extractBearerToken(request);
    if (!token) return true; // anonymous — counts only

    let payload;
    try {
      payload = this.tokens.verify(token);
    } catch {
      // Fail closed: a present token that does not verify is never anonymous.
      throw new UnauthorizedException('Invalid token');
    }

    if (this.denylist.isRevoked(payload.jti)) {
      throw new UnauthorizedException('Token has been revoked');
    }

    const exists = await this.userExists(payload.sub);
    if (!exists) {
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

  private async userExists(sub: string): Promise<boolean> {
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: sub },
        select: { id: true },
      });
      return row !== null;
    } catch {
      // A `sub` that is not a valid UUID throws at the driver; it names no row.
      return false;
    }
  }
}

/**
 * Route decorator that installs the fail-closed optional-authentication layer.
 * Compose with `@Public()` and `@OptionalCurrentUser()` (DEV-044).
 */
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(OptionalAuthGuard));

/**
 * Injects the optional caller resolved by `OptionalAuthGuard`, or `null` when
 * the request was anonymous. Never reads a body/query value (DEV-029/DEV-030).
 */
export const OptionalCurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | null => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    return request.user ?? null;
  },
);
