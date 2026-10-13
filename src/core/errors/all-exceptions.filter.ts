import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorEnvelope } from '../../shared/types/error-envelope';
import { redactUrl } from '../../shared/log/redact';

/** HTTP status → stable machine code. Unknown statuses fall back to `HTTP_ERROR`. */
const STATUS_CODES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'METHOD_NOT_ALLOWED',
  [HttpStatus.NOT_ACCEPTABLE]: 'NOT_ACCEPTABLE',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'GONE',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'INTERNAL_SERVER_ERROR',
  [HttpStatus.BAD_GATEWAY]: 'BAD_GATEWAY',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
  [HttpStatus.GATEWAY_TIMEOUT]: 'GATEWAY_TIMEOUT',
};

/**
 * HTTP status → client-facing message (P03-SEC-002). The 4xx message is derived
 * from this fixed table, **never** from `exception.message`, so a careless
 * `BadRequestException(prismaError.message)` cannot forward SQL, Prisma, or
 * stack detail to the client (Hard Rule 4). Unknown statuses fall back to
 * `FALLBACK_CLIENT_MESSAGE`.
 */
const STATUS_MESSAGES: Readonly<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'Method not allowed',
  [HttpStatus.NOT_ACCEPTABLE]: 'Not acceptable',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.GONE]: 'Gone',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable entity',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
};

const INTERNAL_MESSAGE = 'Internal server error';
const VALIDATION_MESSAGE = 'Validation failed';
const FALLBACK_CLIENT_MESSAGE = 'Request failed';

/**
 * Shapes that must never reach a client (Hard Rule 4): Prisma error codes and
 * class names, SQL statements, stack frames, source paths, and filesystem
 * paths. Used to drop unsafe entries from validation `details`, the only
 * exception-derived strings the envelope still carries.
 */
const INTERNAL_DETAIL =
  /(?:P\d{4}|PrismaClient|Prisma\.|Unique constraint|Foreign key constraint|Constraint failed|\bSELECT\b[\s\S]*\bFROM\b|\bINSERT\b[\s\S]*\bINTO\b|\bUPDATE\b[\s\S]*\bSET\b|\bDELETE\b[\s\S]*\bFROM\b|at Object\.|\.ts:\d+:\d+|[A-Za-z]:\\|\/node_modules\/|\/(?:Users|home)\/)/i;

function isSafeDetail(value: string): boolean {
  return value.length <= 200 && !INTERNAL_DETAIL.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Pull a client-safe message and, for validation failures, safe field-level
 * details out of a 4xx `HttpException`.
 *
 * The message is **always** taken from `STATUS_MESSAGES`, never from
 * `exception.message` (P03-SEC-002). Details survive only when they are an
 * array of short, non-internal strings — the shape the global `ValidationPipe`
 * produces; anything resembling SQL, Prisma, or a stack is dropped.
 *
 * Only 4xx responses reach this. Any 5xx is replaced with an opaque message
 * before it is serialised (see `catch` below), so a careless
 * `InternalServerErrorException('...stack...')` cannot leak.
 */
function extractClientMessage(
  exception: HttpException,
  status: number,
): {
  message: string;
  details?: string[];
} {
  const response = exception.getResponse();

  if (isRecord(response) && Array.isArray(response.message)) {
    const details = response.message.filter(
      (item): item is string => typeof item === 'string' && isSafeDetail(item),
    );
    if (details.length > 0) {
      return { message: VALIDATION_MESSAGE, details };
    }
  }

  return { message: STATUS_MESSAGES[status] ?? FALLBACK_CLIENT_MESSAGE };
}

/**
 * The single global exception filter. Shapes every failure into one
 * `ErrorEnvelope`.
 *
 * Hard Rule 4: no stack trace, SQL text, or Prisma internals ever reach the
 * client. Unexpected exceptions become an opaque 500; the real cause is logged
 * server-side only. Do NOT add the exception message to the response body.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = INTERNAL_MESSAGE;
    let details: string[] | undefined;

    if (status < HttpStatus.INTERNAL_SERVER_ERROR && exception instanceof HttpException) {
      ({ message, details } = extractClientMessage(exception, status));
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Server-side log only. `stack` and the raw message stay here; they are
      // never serialised into the response envelope.
      const cause =
        exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
      // Hard Rule 8 / DEV-054: a stream URL carries `?ticket=…`; redact it before
      // it can reach the log line.
      this.logger.error(`${request.method} ${redactUrl(request.url)} -> ${status}`, cause);
    }

    const body: ErrorEnvelope = {
      statusCode: status,
      code: STATUS_CODES[status] ?? 'HTTP_ERROR',
      message,
      ...(details ? { details } : {}),
      path: redactUrl(request.url),
      timestamp: new Date().toISOString(),
    };

    response.status(status).json(body);
  }
}
