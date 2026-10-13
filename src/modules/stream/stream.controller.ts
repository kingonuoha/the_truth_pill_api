/**
 * The two frozen SSE routes (`docs/endpoints/realtime.md` §2, matrix §1/§2):
 *
 *   POST /api/v1/stream/tickets  → 201 { ticket, expiresIn: 30 }
 *   GET  /api/v1/stream?ticket=… → 200 text/event-stream
 *
 * There is **no** unsubscribe route and no mid-stream topic add (matrix §2.3):
 * a topic set is immutable for a connection's life; navigation is close +
 * reconnect. Both routes are `@Public()` — the ticket is the only stream
 * credential and the ticket controller is token-optional (fail-closed via
 * `@OptionalAuth()`).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiCreatedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthenticatedUser, Public } from '../../shared/guards/auth.decorators';
import {
  OptionalAuth,
  OptionalCurrentUser,
} from '../../shared/guards/optional-auth.guard';
import { resolveClientIp } from '../../shared/net/client-ip';
import { CreateTicketDto, StreamQueryDto, TicketResponseDto } from './dto/stream.dto';
import { StreamConnection } from './stream-connection';
import { streamBus } from './stream-bus';
import { StreamRegistryService } from './stream-registry.service';
import { StreamTicketGuard, StreamRequest } from './stream-ticket.guard';
import { StreamTicketService } from './stream-ticket.service';
import { resolveThrottleWindows } from './stream.config';
import { ThrottleWindows } from './topics';
import { OptionalAuthOperation, PublicOperation } from '../../shared/swagger/security';

const R400 = {
  status: 400,
  description: 'Malformed, unknown, empty, or over-cap topic set (global whitelist + issuance validation).',
};
const R401 = {
  status: 401,
  description: 'A present-but-invalid bearer token at issuance (fail-closed, DEV-044).',
};
const R403 = {
  status: 403,
  description: '`TOPIC_FORBIDDEN` at issuance, or `TICKET_INVALID` / `TICKET_EXPIRED` on the stream.',
};

@ApiTags('stream')
@Controller('stream')
export class StreamController {
  private readonly logger = new Logger(StreamController.name);
  private readonly windows: ThrottleWindows;

  constructor(
    private readonly tickets: StreamTicketService,
    private readonly registry: StreamRegistryService,
    config: ConfigService,
  ) {
    this.windows = resolveThrottleWindows(config);
  }

  @Public()
  @OptionalAuthOperation() // DEV-058: anonymous permitted, token honoured — not PublicOperation()
  @OptionalAuth()
  @Post('tickets')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Mint a single-use SSE ticket (DEV-054)',
    description:
      'Token-optional and fail-closed: an anonymous caller may request public topics only; `admin:*` / `analytics:realtime` require the DB-resolved admin role and are refused with 403 `TOPIC_FORBIDDEN` at issuance. The 256-bit ticket is stored as a SHA-256 digest with a 30 s TTL and is single-use.',
  })
  @ApiCreatedResponse({ type: TicketResponseDto, description: 'The raw ticket, returned exactly once.' })
  @ApiResponse(R400)
  @ApiResponse(R401)
  @ApiResponse(R403)
  issue(
    @OptionalCurrentUser() caller: AuthenticatedUser | null,
    @Body() dto: CreateTicketDto,
  ): Promise<{ ticket: string; expiresIn: number }> {
    return this.tickets.issue(caller ? caller.sub : null, dto.topics);
  }

  @Public()
  @PublicOperation()
  @UseGuards(StreamTicketGuard)
  @Get()
  @ApiOperation({
    summary: 'Open the event stream (DEV-007/DEV-055)',
    description:
      'Consumes the ticket via its own guard; topics come from the ticket, never the query string. Frames are the narrow `{v,type,ts,data}` envelope, coalesced per topic per connection. Missing/unknown/spent ticket → 403 `TICKET_INVALID`; expired → 403 `TICKET_EXPIRED`, both before the stream opens.',
  })
  // The stream response is not JSON — declare it as `text/event-stream` (a
  // string schema), never a JSON body. See `docs/endpoints/realtime.md` §2.
  @ApiResponse({
    status: 200,
    description: 'An open `text/event-stream`.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiResponse({ status: 400, description: 'Missing or empty `ticket` query parameter.' })
  @ApiResponse(R403)
  open(
    @Req() req: StreamRequest,
    @Res() res: Response,
    @Query() query: StreamQueryDto,
  ): void {
    void query; // strict shape: `ticket` is the only accepted query key
    const ticket = req.streamTicket;
    if (!ticket) {
      // Unreachable behind `StreamTicketGuard`; fail closed rather than open an
      // unbounded stream. With `@Res()` (no passthrough) the response must be
      // written and ended explicitly.
      res.status(HttpStatus.FORBIDDEN).json({ error: 'TICKET_INVALID' });
      res.end();
      return;
    }

    const forwardedFor = req.headers['x-forwarded-for'];
    const ip = resolveClientIp(Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor);

    // `@Res()` without passthrough: this handler owns the response for the
    // life of the stream and never returns into Nest's auto-end path.
    res.writeHead(HttpStatus.OK, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const overTopicCap = ticket.topics.length > this.registry.caps.maxTopicsPerConnection;
    const reservation = overTopicCap
      ? { allowed: false as const, reason: 'CONNECTION_CAP' as const }
      : this.registry.tryRegister(ip);

    if (!reservation.allowed) {
      this.rejectOverCap(res, ticket);
      return;
    }

    let release: () => void = () => undefined;
    let released = false;
    const connection = new StreamConnection(
      (chunk) => {
        res.write(chunk);
      },
      {
        ticket,
        windows: this.windows,
        subscribe: (listener) => streamBus.subscribe(listener),
        onClose: () => {
          if (released) return;
          released = true;
          release();
        },
      },
    );
    release = this.registry.attach(connection, ip);

    // Disconnect detection: `req` emits `close` when the client socket drops.
    // (The Express `res` is owned for the stream's life; do not attach a
    //  competing `res` 'close' handler.)
    req.on('close', () => connection.close());

    connection.open();
    // Log only the topic count — never the ticket or the URL (Hard Rule 8).
    this.logger.log(`SSE stream opened topics=${ticket.topics.length}`);
  }

  /** Over a cap: a `CONNECTION_CAP` frame then close (matrix §4.2, DEV-057). */
  private rejectOverCap(res: Response, ticket: StreamRequest['streamTicket']): void {
    if (!ticket) {
      res.end();
      return;
    }
    const reject = new StreamConnection((chunk) => res.write(chunk), {
      ticket,
      windows: this.windows,
      subscribe: () => () => undefined,
    });
    reject.open();
    reject.emitError('CONNECTION_CAP', 'Connection cap reached', true);
    reject.close();
    res.end();
  }
}
