import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaNeon } from '@prisma/adapter-neon';

// ADR-004: import the client from the GENERATED PATH, never `@prisma/client`.
// The generator output lives at `api/src/generated/prisma` (see
// `prisma/schema.prisma` generator block) and is compiled into `dist` with the
// rest of `src`.
import { PrismaClient } from '../../generated/prisma/client';

/**
 * The one and only Prisma client.
 *
 * ADR-004: a single `PrismaClient` instance, bound to `@prisma/adapter-neon`
 * over the pooled `DATABASE_URL`, disconnected exactly once on shutdown. A
 * second client (or a missing `$disconnect()`) exhausts the Neon pool.
 *
 * Runtime URL is the pooled host (`-pooler`). `DIRECT_URL` is migration-only
 * and is never read here (ADR-003).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaNeon({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to Postgres (pooled Neon adapter)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Disconnected from Postgres');
  }
}
