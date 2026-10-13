import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersController } from './admin-users.controller';
import { InternalUsersController } from './internal-users.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * The 16 `users.ts` behaviours, identity-free. Imports `AuthModule` for the
 * token/password/deny-list services it shares; `AuthModule` does not import this
 * module, so there is no cycle.
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [UsersController, AdminUsersController, InternalUsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
