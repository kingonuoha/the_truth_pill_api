import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../infra/app.module';
import { PrismaService } from '../core/prisma/prisma.service';

/**
 * CLI-only admin bootstrap (DEV-003).
 *
 * The legacy `web/convex/seed.ts:12-20` exposed a public, unauthenticated,
 * repeatable admin-seeding mutation over HTTP. This replaces it with a
 * deployment task: there is **no route** that creates an admin. Run:
 *
 *   npm run seed:admin
 *
 * Idempotent — a second run creates nothing. Requires `ADMIN_EMAIL`. The
 * created row has no password; the operator signs in via the reset flow or an
 * OAuth provider.
 */
async function run(): Promise<number> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const logger = new Logger('seed-admin');

  try {
    const config = app.get(ConfigService);
    const email = config.get<string>('ADMIN_EMAIL');
    if (typeof email !== 'string' || email.trim().length === 0) {
      logger.error('ADMIN_EMAIL is not set. Refusing to seed.');
      return 1;
    }

    const prisma = app.get(PrismaService);
    const existing = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });

    if (existing) {
      if (existing.role === 'admin') {
        logger.log(`Admin already present (${email}). Nothing to do.`);
      } else {
        await prisma.user.update({
          where: { id: existing.id },
          data: { role: 'admin' },
        });
        logger.log(`Promoted existing user (${email}) to admin.`);
      }
      return 0;
    }

    await prisma.user.create({
      data: {
        name: 'Truth Seeker',
        email,
        provider: 'email',
        role: 'admin',
        newsletterSubscribed: true,
        createdAt: new Date(),
      },
    });
    logger.log(`Created admin (${email}).`);
    return 0;
  } finally {
    await app.close();
  }
}

run()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    new Logger('seed-admin').error('Admin seed failed', detail);
    process.exit(1);
  });
