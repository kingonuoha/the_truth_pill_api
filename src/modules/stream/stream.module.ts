import { Module } from '@nestjs/common';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { OptionalAuthGuard } from '../../shared/guards/optional-auth.guard';
import { StreamController } from './stream.controller';
import { StreamTicketGuard } from './stream-ticket.guard';
import { StreamTicketService } from './stream-ticket.service';
import { StreamTicketStore } from './stream-ticket.store';
import { StreamRegistryService } from './stream-registry.service';

/**
 * Phase 09 SSE module (DEV-007 / DEV-054 / DEV-055).
 *
 * `PrismaModule` supplies the role lookup at ticket issuance; `AuthModule`
 * supplies the `TokenService` + `JtiDenylistService` the shared
 * `@OptionalAuth()` guard re-verifies with (DEV-044). The global
 * `JwtAuthGuard`/`RolesGuard` remain the default-deny boundary (registered in
 * `AppModule`); both stream routes are explicitly `@Public()` and carry their
 * own credential (optional-auth / ticket guard).
 *
 * The in-process topic bus is a module-level singleton (`stream-bus`), not a
 * provider, so write paths publish without importing this module (ADR-005).
 */
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [StreamController],
  providers: [
    StreamTicketStore,
    StreamTicketService,
    StreamTicketGuard,
    OptionalAuthGuard,
    StreamRegistryService,
  ],
  exports: [
    StreamTicketStore,
    StreamTicketService,
    StreamTicketGuard,
    OptionalAuthGuard,
    StreamRegistryService,
  ],
})
export class StreamModule {}
