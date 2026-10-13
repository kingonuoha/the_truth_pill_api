import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../core/prisma/prisma.service';
import {
  AppRole,
  RequestWithUser,
  ROLES_KEY,
} from './auth.decorators';

/**
 * Role authorisation resolution (ADR-007, brief §2 prohibition 3).
 *
 * The role is read from the **`users` row** for the verified `sub` — never from
 * `token.role`, `token.roles`, or any custom claim. A validly signed token that
 * carries `"role": "admin"` while the DB row says `user` is rejected with 403;
 * a token naming a deleted user is rejected with 401 (the `JwtAuthGuard`
 * already 401s an unknown `sub`).
 *
 * No cache is introduced: Phase 00 recommends a 30-60s cache, and the brief
 * requires that any cache be a `DEV-` row rather than a silent addition. Until
 * one is registered, every decision reads the DB.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) {
      // RolesGuard runs after JwtAuthGuard; a missing user means the route was
      // misconfigured. Fail closed.
      throw new UnauthorizedException('Authentication required');
    }

    const row = await this.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { role: true },
    });
    if (!row) {
      throw new UnauthorizedException('Unknown subject');
    }
    if (!required.includes(row.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
