/**
 * The dedicated SSE ticket guard (`GET /api/v1/stream?ticket=…`, matrix §2.2).
 *
 * The route is `@Public()` so the global `JwtAuthGuard` does not demand a
 * bearer token — the SSE client (`EventSource`) cannot set an `Authorization`
 * header. This guard is the sole credential boundary: it reads the `ticket`
 * query param **only**, redeems it exactly once, and binds the resolved
 * principal + topic set to the request. Any other query value is ignored; the
 * topic set never comes from the URL.
 *
 * A missing / unknown / spent ticket is `403 TICKET_INVALID`; an expired ticket
 * is `403 TICKET_EXPIRED` — both raised here, **before** the stream opens.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import {
  RedeemedTicket,
  StreamTicketStore,
  TicketInvalidException,
} from './stream-ticket.store';

/** An Express request carrying the redeemed ticket bound by the guard. */
export interface StreamRequest extends Request {
  streamTicket?: RedeemedTicket;
}

@Injectable()
export class StreamTicketGuard implements CanActivate {
  constructor(private readonly store: StreamTicketStore) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<StreamRequest>();
    const raw = request.query.ticket;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new TicketInvalidException();
    }
    // Redeems (deletes) the record; throws TICKET_INVALID / TICKET_EXPIRED.
    request.streamTicket = this.store.redeem(raw);
    return true;
  }
}
