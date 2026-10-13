import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';

/** The minimal outbound-message shape the templates produce. */
export interface OutboundMail {
  from: string;
  to: string;
  subject: string;
  html: string;
}

/**
 * The injectable transport abstraction. `SmtpMailTransport` is the production
 * implementation; the e2e harness (SMTP keys are empty, so a live send is
 * ⏳ PENDING) swaps it for a deterministic stub via {@link MailerService.useTransport}.
 */
export interface MailTransport {
  send(mail: OutboundMail): Promise<void>;
}

/** DI token for the default transport. */
export const MAIL_TRANSPORT = 'MAIL_TRANSPORT';

/**
 * The frozen `getTransporter` (`email_actions.ts:8-28`) behind an object.
 *
 * `EMAIL_*` is empty in this environment, so the send throws a generic,
 * key-free error the consumer records — never a connection attempt at
 * construction (nodemailer dials lazily). No host, port, or credential is ever
 * attached to the error message (Hard Rule 4).
 */
export class SmtpMailTransport implements MailTransport {
  constructor(private readonly config: ConfigService) {}

  async send(mail: OutboundMail): Promise<void> {
    const host = this.config.get<string>('EMAIL_HOST');
    const port = Number.parseInt(
      this.config.get<string>('EMAIL_PORT') ?? '587',
      10,
    );
    const user = this.config.get<string>('EMAIL_USER');
    const pass = this.config.get<string>('EMAIL_PASS');
    if (!host || !user || !pass) {
      throw new Error('Email transport is not configured');
    }

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
      pool: true,
    });
    await transporter.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
    });
  }
}

/**
 * Sends a rendered message. The `from` is resolved from `EMAIL_FROM` (falling
 * back to `EMAIL_USER`) here so the transport only sees a fully formed message.
 *
 * DEV-015 class: the SMTP password is read from config at call time and is never
 * logged or returned.
 */
@Injectable()
export class MailerService {
  constructor(
    @Inject(MAIL_TRANSPORT) private transport: MailTransport,
    private readonly config: ConfigService,
  ) {}

  /**
   * Test-only transport swap. The e2e harness injects a deterministic stub
   * because `EMAIL_*` is empty and a live SMTP round-trip is ⏳ PENDING.
   */
  useTransport(transport: MailTransport): void {
    this.transport = transport;
  }

  send(input: Omit<OutboundMail, 'from'>): Promise<void> {
    const fromAddress =
      this.config.get<string>('EMAIL_FROM') ??
      this.config.get<string>('EMAIL_USER') ??
      'noreply@thetruthpill.org';
    return this.transport.send({
      from: `"The Truth Pill" <${fromAddress}>`,
      ...input,
    });
  }
}
