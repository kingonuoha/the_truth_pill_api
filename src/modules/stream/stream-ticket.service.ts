/**
 * Ticket issuance + per-topic authorization (matrix §2.1, DEV-054).
 *
 * The caller's principal comes **only** from the verified token (attached by
 * `@OptionalAuth()`); the role is read from the `users` row — never a token
 * claim and never a request field (ADR-007, DEV-029 class). The requested topic
 * set is shape-validated, authorized as a whole, and bound into the ticket. A
 * refused request mints nothing.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppRole } from '../../shared/guards/auth.decorators';
import { PrismaService } from '../../core/prisma/prisma.service';
import { isAdminClassTopic, isKnownTopic } from './topics';
import { resolveCaps, StreamCaps } from './stream.config';
import { StreamTicketStore, TICKET_TTL_SECONDS } from './stream-ticket.store';

@Injectable()
export class StreamTicketService {
  private readonly caps: StreamCaps;

  constructor(
    private readonly store: StreamTicketStore,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.caps = resolveCaps(config);
  }

  /**
   * Validate, authorize, and mint. Throws `400` for a malformed/unknown/empty
   * or over-cap topic set, and `403 TOPIC_FORBIDDEN` for a topic the caller may
   * not read (`admin:*` / `analytics:realtime` without the DB-resolved admin
   * role). Only a fully authorized set mints a ticket.
   */
  async issue(
    principal: string | null,
    requested: string[],
  ): Promise<{ ticket: string; expiresIn: number }> {
    const topics = [...new Set(requested)];
    if (topics.length === 0) {
      throw new BadRequestException({ message: ['topics: at least one topic is required'] });
    }
    if (topics.length > this.caps.maxTopicsPerConnection) {
      throw new BadRequestException({
        message: [`topics: at most ${this.caps.maxTopicsPerConnection} topics per connection`],
      });
    }
    for (const topic of topics) {
      if (!isKnownTopic(topic)) {
        throw new BadRequestException({ message: [`topics: unknown topic '${topic}'`] });
      }
    }

    const isAdmin = await this.resolveIsAdmin(principal);
    if (!isAdmin) {
      for (const topic of topics) {
        if (isAdminClassTopic(topic)) {
          throw new ForbiddenException({ message: ['TOPIC_FORBIDDEN'] });
        }
      }
    }

    return this.store.mint(principal, topics, TICKET_TTL_SECONDS);
  }

  /** The DB-resolved role check — the same source `RolesGuard` uses (ADR-007). */
  private async resolveIsAdmin(principal: string | null): Promise<boolean> {
    if (!principal) return false;
    const row = await this.prisma.user.findUnique({
      where: { id: principal },
      select: { role: true },
    });
    const role: AppRole | undefined = row?.role;
    return role === 'admin';
  }
}
