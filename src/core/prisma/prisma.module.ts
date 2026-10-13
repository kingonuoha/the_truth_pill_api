import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Exposes the single `PrismaService` to every feature module.
 *
 * Not `@Global()` on purpose — a feature module imports `PrismaModule`
 * explicitly, which keeps the data-access dependency visible in the module
 * graph (D1, D2).
 */
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
