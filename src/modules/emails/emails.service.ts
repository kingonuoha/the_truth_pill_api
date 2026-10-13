import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../core/prisma/prisma.service';
import { ScopedTokenService } from '../auth/scoped-token.service';
import { UNSUBSCRIBE_TTL_SECONDS, UsersService } from '../users/users.service';
import { publishEmailStatus } from '../stream/stream-publishers';
import { MailerService } from './mailer.service';
import { EMAIL_TEMPLATE_KEYS, renderTemplate } from './templates';
import {
  AddToQueueDto,
  ProcessQueueDto,
  RequestPasswordResetDto,
  SendTestEmailDto,
  UpdateEmailStatusDto,
} from './dto/emails.dto';
import {
  EmailLogDto,
  EmailSuccessDto,
  PasswordResetNeutralDto,
  PendingEmailDto,
  ProcessQueueResultDto,
  QueuedEmailDto,
  SendTestEmailResultDto,
  WeeklyDigestResultDto,
} from './dto/email-responses.dto';

/** `templateData` keys that carry secret material — omitted from an admin read. */
const REDACTED_TEMPLATE_KEYS = new Set([
  'resetUrl',
  'unsubscribeUrl',
  'confirmUrl',
  'otpCode',
]);

const DEFAULT_SITE_URL = 'https://thetruthpill.org';
const MAX_RETRIES = 3;
const GENERIC_SEND_ERROR = 'Email delivery failed';

/**
 * The subset of the Prisma client the weekly digest reads and writes. Both
 * `PrismaService` and an interactive-transaction client (`tx`) satisfy it, so
 * the digest can run inside the worker's dedupe transaction (P09-SEC-002).
 */
type EmailDbContext = Pick<PrismaService, 'article' | 'user' | 'quote' | 'emailQueue'>;

/** The subset of a queue row this service reads. `templateData` is a JSON object. */
interface QueueRow {
  id: string;
  recipient: string;
  subject: string;
  templateName: string;
  templateData: unknown;
  status: string;
  scheduledFor: Date;
  sentAt: Date | null;
  error: string | null;
  retries: number;
}

const QUEUE_ROW_SELECT = {
  id: true,
  recipient: true,
  subject: true,
  templateName: true,
  templateData: true,
  status: true,
  scheduledFor: true,
  sentAt: true,
  error: true,
  retries: true,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Coerce a JSON object column into the string map the templates interpolate. */
function toStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = typeof child === 'string' ? child : String(child);
  }
  return out;
}

/**
 * The 8 `web/convex/emails.ts` behaviours and the 3 `email_actions.ts`
 * behaviours (consumer, test send, password reset).
 *
 * DEV-050: `processQueue` drains the queue (closing DEV-012/DEV-013) and surfaces
 * the run status. DEV-035: the digest carries a signed single-use unsubscribe
 * token, never a bare `?email=`. DEV-036/DEV-033: the reset path reuses the
 * Phase 04 CSPRNG token + server-side hashing. DEV-006: `templateData` is
 * validated per template, never the frozen `v.any()`.
 */
@Injectable()
export class EmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    private readonly users: UsersService,
    private readonly scopedTokens: ScopedTokenService,
    private readonly config: ConfigService,
  ) {}

  /* ───────────────────────────── queue ───────────────────────────── */

  /**
   * `addToQueue` (`emails.ts:9-29`). `templateData` is validated against the
   * template's key set — an unknown template, an unknown key, or a non-string
   * value is a 400 (ADR-010, DEV-006).
   */
  async addToQueue(dto: AddToQueueDto): Promise<QueuedEmailDto> {
    const data = this.validateTemplateData(dto.templateName, dto.templateData);
    const scheduledFor =
      dto.scheduledFor !== undefined ? new Date(dto.scheduledFor) : new Date();
    const row = await this.prisma.emailQueue.create({
      data: {
        recipient: dto.recipient,
        subject: dto.subject,
        templateName: dto.templateName,
        templateData: data,
        status: 'pending',
        scheduledFor,
        retries: 0,
      },
      select: { id: true },
    });
    return { id: row.id };
  }

  /**
   * `getPendingEmails` (`emails.ts:31-43`): due pending rows, bounded by `limit`.
   * The internal consumer view carries the full `templateData`.
   */
  async getPendingEmails(limit = 50): Promise<PendingEmailDto[]> {
    const rows = await this.prisma.emailQueue.findMany({
      where: { status: 'pending', scheduledFor: { lte: new Date() } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: QUEUE_ROW_SELECT,
    });
    return rows.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      subject: row.subject,
      templateName: row.templateName,
      templateData: toStringMap(row.templateData),
      scheduledFor: row.scheduledFor.toISOString(),
      retries: row.retries,
    }));
  }

  /**
   * `updateEmailStatus` (`emails.ts:45-77`). `retries` is incremented with an
   * **atomic** Prisma `increment` (Migration Rule 5) — never a read-then-write.
   */
  async updateEmailStatus(
    id: string,
    dto: UpdateEmailStatusDto,
  ): Promise<EmailSuccessDto> {
    await this.prisma.emailQueue.updateMany({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.error !== undefined ? { error: dto.error } : {}),
        ...(dto.sentAt !== undefined ? { sentAt: new Date(dto.sentAt) } : {}),
        ...(dto.retryIncrement ? { retries: { increment: 1 } } : {}),
      },
    });

    // Dev-055: the narrow `email.status` frame on `admin:emails` — the new
    // absolute `retries`/`status`/`error`, never the row or the recipient.
    const row = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: { id: true, status: true, retries: true, error: true },
    });
    if (row) {
      publishEmailStatus({
        id: row.id,
        status: row.status,
        retries: row.retries,
        error: row.error,
      });
    }
    return { success: true };
  }

  /** `getEmailLogs` (`emails.ts:150-158`): newest first, token fields redacted. */
  async getEmailLogs(limit = 50): Promise<EmailLogDto[]> {
    const rows = await this.prisma.emailQueue.findMany({
      orderBy: { id: 'desc' },
      take: limit,
      select: QUEUE_ROW_SELECT,
    });
    return rows.map((row) => this.toEmailLog(row));
  }

  /** `getEmailById` (`emails.ts:160-165`). 404 when absent. */
  async getEmailById(id: string): Promise<EmailLogDto> {
    const row = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: QUEUE_ROW_SELECT,
    });
    if (!row) throw new NotFoundException('Email not found');
    return this.toEmailLog(row);
  }

  /** `retryEmail` (`emails.ts:166-178`): reset to pending, clear error, due now. 404 when absent. */
  async retryEmail(id: string): Promise<EmailSuccessDto> {
    const row = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Email not found');
    await this.prisma.emailQueue.update({
      where: { id },
      data: { status: 'pending', error: null, scheduledFor: new Date() },
    });
    return { success: true };
  }

  /** `deleteEmail` (`emails.ts:180-185`): idempotent. */
  async deleteEmail(id: string): Promise<EmailSuccessDto> {
    await this.prisma.emailQueue.deleteMany({ where: { id } });
    return { success: true };
  }

  /* ───────────────────────────── newsletter ───────────────────────────── */

  /**
   * `generateWeeklyNewsletter` (`emails.ts:79-148`): the top-3 by views among
   * articles published in the last 7 days, queued for every subscribed user.
   *
   * DEV-035: `unsubscribeUrl` carries the Phase 04 signed single-use token —
   * **never** the frozen bare `?email=`. The token is never logged.
   */
  async generateWeeklyNewsletter(
    db: EmailDbContext = this.prisma,
  ): Promise<WeeklyDigestResultDto> {
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recent = await db.article.findMany({
      where: { status: 'published', publishedAt: { gt: lastWeek } },
      orderBy: { publishedAt: 'desc' },
      take: 10,
      select: { id: true, title: true, excerpt: true, slug: true, viewCount: true },
    });
    const featured = [...recent]
      .sort((a, b) => b.viewCount - a.viewCount)
      .slice(0, 3);
    if (featured.length === 0) {
      return { subscribers: 0, queued: 0, skipped: true };
    }

    const users = await db.user.findMany({
      where: { role: 'user', newsletterSubscribed: true },
      select: { id: true, email: true, name: true },
    });
    const siteUrl = this.siteUrl();

    const quotes = await db.quote.findMany({
      select: { text: true, author: true },
    });
    const randomQuote =
      quotes.length > 0 ? quotes[Math.floor(Math.random() * quotes.length)] : null;

    const articlesHtml = featured
      .map(
        (art) => `
      <div style="margin-bottom: 20px; border-bottom: 1px solid #f1f5f9; padding-bottom: 20px;">
        <h3 style="margin: 0 0 10px 0; color: #1e293b;">${art.title}</h3>
        <p style="margin: 0 0 15px 0; color: #64748b; font-size: 14px;">${art.excerpt ?? ''}</p>
        <a href="${siteUrl}/${art.slug}" style="color: #0ea5e9; text-decoration: none; font-weight: bold;">Read Article &rarr;</a>
      </div>
    `,
      )
      .join('');

    let queued = 0;
    for (const user of users) {
      // DEV-035: a signed single-use token, not the frozen bare email address.
      const minted = this.scopedTokens.mint(
        'newsletter-unsubscribe',
        user.id,
        UNSUBSCRIBE_TTL_SECONDS,
      );
      await db.emailQueue.create({
        data: {
          recipient: user.email,
          subject: 'Your Weekly Truth Pill Digest 📰',
          templateName: 'newsletter',
          templateData: {
            name: user.name,
            articlesHtml,
            quoteText:
              randomQuote?.text ??
              'The only way to do great work is to love what you do.',
            quoteAuthor: randomQuote?.author ?? 'Steve Jobs',
            siteUrl,
            unsubscribeUrl: `${siteUrl}/unsubscribe?token=${encodeURIComponent(minted.token)}`,
          },
          status: 'pending',
          scheduledFor: new Date(),
          retries: 0,
        },
      });
      queued += 1;
    }

    return { subscribers: users.length, queued, skipped: false };
  }

  /* ───────────────────────────── consumer ───────────────────────────── */

  /**
   * `processQueue` (`email_actions.ts:148-203`) — **the consumer** (DEV-050).
   *
   * Drains due pending rows: `sending` → render → send → `sent` (`sentAt=now`).
   * A failure with `retries < 3` returns the row to `pending`; at 3 it becomes
   * `failed`, with `retries + 1` atomic and a generic `error` recorded. The batch
   * does **not** abort on one failure, and the run returns its counters. No
   * document is ever published (SSE is Phase 09, DEV-007).
   *
   * ⚠️ Cron scheduling is **Phase 09** — this endpoint is called by the future
   * `process-email-queue` job; no `@nestjs/schedule` job is registered here.
   */
  async processQueue(dto: ProcessQueueDto = {}): Promise<ProcessQueueResultDto> {
    const pending = await this.getPendingEmails(dto.limit ?? 50);
    if (pending.length === 0) {
      return { processed: 0, sent: 0, failed: 0, skipped: true };
    }

    let sent = 0;
    let failed = 0;
    for (const email of pending) {
      await this.updateEmailStatus(email.id, { status: 'sending' });
      try {
        const html = renderTemplate(email.templateName, email.templateData);
        await this.mailer.send({
          to: email.recipient,
          subject: email.subject,
          html,
        });
        await this.updateEmailStatus(email.id, {
          status: 'sent',
          sentAt: Date.now(),
        });
        sent += 1;
      } catch {
        const shouldRetry = email.retries < MAX_RETRIES;
        await this.updateEmailStatus(email.id, {
          status: shouldRetry ? 'pending' : 'failed',
          error: GENERIC_SEND_ERROR,
          retryIncrement: true,
        });
        failed += 1;
      }
    }
    return { processed: pending.length, sent, failed, skipped: false };
  }

  /* ───────────────────────────── direct send + reset ───────────────────────────── */

  /** `sendTestEmail` (`email_actions.ts:205-235`): admin; failure is a generic message. */
  async sendTestEmail(dto: SendTestEmailDto): Promise<SendTestEmailResultDto> {
    const html = `
          <div style="padding: 20px; font-family: sans-serif; text-align: center;">
            <h1 style="color: #0ea5e9;">Test Successful!</h1>
            <p>If you're reading this, your SMTP configuration for <strong>The Truth Pill</strong> is working correctly.</p>
            <div style="margin: 20px; padding: 10px; background: linear-gradient(135deg, #0ea5e9 0%, #a855f7 100%); color: white; display: inline-block; border-radius: 8px;">
              Email System Online
            </div>
          </div>
        `;
    try {
      await this.mailer.send({
        to: dto.recipient,
        subject: 'The Truth Pill - Test Email',
        html,
      });
      return { success: true };
    } catch {
      // Hard Rule 4: no SMTP host/port/credential or stack is surfaced.
      return { success: false, message: GENERIC_SEND_ERROR };
    }
  }

  /**
   * `requestPasswordReset` (`email_actions.ts:237-271`) — public and **neutral**.
   *
   * It reuses the Phase 04 reset-token machinery: a CSPRNG signed token
   * (DEV-036) whose hash + expiry are stored server-side (DEV-033). An unknown
   * address mints nothing and returns the **identical** `{ success: true }`, so
   * there is no enumeration oracle.
   *
   * P08-SEC-001 (matrix §7.1 "enqueue"): the reset email is **enqueued**, never
   * sent synchronously. The handler does bounded DB-only work and the Phase 09
   * consumer performs the SMTP round-trip, so response time cannot distinguish a
   * registered address. The token travels only inside the queued link — never a
   * log line, never the response.
   */
  async requestPasswordReset(
    dto: RequestPasswordResetDto,
  ): Promise<PasswordResetNeutralDto> {
    const minted = await this.users.mintResetToken({ email: dto.email });
    if (!minted) return { success: true };

    const siteUrl = this.siteUrl();
    const resetUrl = `${siteUrl}/auth/reset-password?token=${minted.token}`;
    await this.prisma.emailQueue.create({
      data: {
        recipient: dto.email,
        subject: 'Reset your password - The Truth Pill',
        templateName: 'reset_password',
        templateData: { resetUrl, siteUrl },
        status: 'pending',
        scheduledFor: new Date(),
        retries: 0,
      },
    });
    return { success: true };
  }

  /* ───────────────────────────── helpers ───────────────────────────── */

  /** Validate `templateData` against the template's key set (ADR-010, DEV-006). */
  private validateTemplateData(
    templateName: string,
    raw: Record<string, unknown>,
  ): Record<string, string> {
    const allowed = EMAIL_TEMPLATE_KEYS[templateName];
    if (!allowed) {
      throw new BadRequestException({
        message: [`templateName: unknown template '${templateName}'`],
      });
    }
    const allowedSet = new Set(allowed);
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!allowedSet.has(key)) {
        throw new BadRequestException({
          message: [`templateData.${key}: unknown key for template '${templateName}'`],
        });
      }
      if (typeof value !== 'string') {
        throw new BadRequestException({
          message: [`templateData.${key}: must be a string`],
        });
      }
      data[key] = value;
    }
    return data;
  }

  /** Admin projection — token-bearing `templateData` keys are omitted (DEV-034 class). */
  private toEmailLog(row: QueueRow): EmailLogDto {
    const full = toStringMap(row.templateData);
    const redacted: Record<string, string> = {};
    for (const [key, value] of Object.entries(full)) {
      if (REDACTED_TEMPLATE_KEYS.has(key)) continue;
      redacted[key] = value;
    }
    return {
      id: row.id,
      recipient: row.recipient,
      subject: row.subject,
      templateName: row.templateName,
      templateData: redacted,
      status: row.status,
      scheduledFor: row.scheduledFor.toISOString(),
      sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      error: row.error,
      retries: row.retries,
    };
  }

  /** Site URL, no trailing slash (SEO trap, `AGENTS.md`). */
  private siteUrl(): string {
    const raw = this.config.get<string>('NEXT_PUBLIC_SITE_URL') ?? DEFAULT_SITE_URL;
    return raw.replace(/\/+$/, '');
  }
}
