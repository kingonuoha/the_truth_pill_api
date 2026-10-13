import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { EmailsController } from './emails.controller';
import { EmailQueueController } from './email-queue.controller';
import { InternalEmailsController } from './internal-emails.controller';
import { EmailsService } from './emails.service';
import { MAIL_TRANSPORT, MailerService, SmtpMailTransport } from './mailer.service';

/**
 * Phase 08 email module — the 8 `web/convex/emails.ts` + 3 `email_actions.ts`
 * functions.
 *
 * `UsersModule` supplies the Phase 04 CSPRNG reset-token mint (DEV-036/DEV-033);
 * `AuthModule` supplies the scoped-token signer the digest uses for a signed
 * single-use unsubscribe token (DEV-035). The transport is an injectable
 * {@link MailerService} so the e2e harness substitutes a deterministic stub
 * (`EMAIL_*` is empty → a live send is ⏳ PENDING). Cron wiring is Phase 09;
 * this module registers no `@nestjs/schedule` job.
 */
@Module({
  imports: [ConfigModule, PrismaModule, AuthModule, UsersModule],
  controllers: [
    EmailsController,
    EmailQueueController,
    InternalEmailsController,
  ],
  providers: [
    EmailsService,
    MailerService,
    { provide: MAIL_TRANSPORT, useClass: SmtpMailTransport },
  ],
  exports: [EmailsService, MailerService],
})
export class EmailsModule {}
