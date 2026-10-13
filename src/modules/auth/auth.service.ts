import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AuthenticatedUser } from '../../shared/guards/auth.decorators';
import {
  toSelfProjection,
  USER_PROJECTION_FIELDS,
  SelfUserProjection,
} from '../users/user-projection';
import { LoginDto } from './dto/auth.dto';
import { JtiDenylistService } from './jti-denylist.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface LoginResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: SelfUserProjection;
}

/**
 * The login ceremony (ADR-017, Option 1). Credentials are verified server-side
 * against the Postgres bcrypt hash — the web's `authorize()` now calls this
 * endpoint instead of reading Convex.
 *
 * The failure response is deliberately uniform ("Invalid credentials") for an
 * unknown address, a password-less (OAuth/guest) account, and a bad password,
 * so the endpoint is not an account-enumeration oracle.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly denylist: JtiDenylistService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...USER_PROJECTION_FIELDS, password: true },
    });

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await this.passwords.verify(dto.password, user.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const { token, expiresIn } = this.tokens.sign(user.id);

    return {
      accessToken: token,
      tokenType: 'Bearer',
      expiresIn,
      user: toSelfProjection(user),
    };
  }

  /** Revoke the caller's own token until its natural expiry. */
  revoke(caller: AuthenticatedUser): void {
    this.denylist.revoke(caller.jti, caller.exp * 1000);
  }
}
