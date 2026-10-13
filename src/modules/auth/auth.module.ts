import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JtiDenylistService } from './jti-denylist.service';
import { PasswordService } from './password.service';
import { ScopedTokenService } from './scoped-token.service';
import { TokenService } from './token.service';

/**
 * Phase 04 auth infrastructure. Exports the token/password services so the
 * users module (and the global guards) can consume them without re-declaring
 * state — the `jti` deny-list and the token key ring must be singletons.
 */
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    TokenService,
    ScopedTokenService,
    JtiDenylistService,
    PasswordService,
    AuthService,
  ],
  exports: [
    TokenService,
    ScopedTokenService,
    JtiDenylistService,
    PasswordService,
  ],
})
export class AuthModule {}
