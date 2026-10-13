/**
 * The open-connection registry and cap enforcement (`realtime.md` §6, DEV-057).
 *
 * A bounded, in-process set of open connections plus a per-IP counter. Over a
 * cap the controller writes a `CONNECTION_CAP` frame then closes (the call
 * returns `allowed:false`). On shutdown every open stream receives a
 * `stream.shutdown` frame before the socket closes.
 *
 * ⚠️ Per-instance only (ADR-005): a horizontally scaled API needs a shared
 * store — a Phase 11 constraint, matching the ticket store and denylist.
 */
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StreamConnection } from './stream-connection';
import { resolveCaps, StreamCaps } from './stream.config';

/** The reconnect hint a shutdown frame carries (`realtime.md` §5). */
const SHUTDOWN_RETRY_MS = 5_000;

@Injectable()
export class StreamRegistryService implements OnApplicationShutdown {
  private readonly logger = new Logger(StreamRegistryService.name);
  private readonly connections = new Set<StreamConnection>();
  private readonly perIp = new Map<string, number>();
  readonly caps: StreamCaps;

  constructor(config: ConfigService) {
    this.caps = resolveCaps(config);
  }

  /**
   * Reserve a slot for a new connection if no cap is exceeded. On success the
   * caller **must** call {@link release} exactly once for the same IP.
   */
  tryRegister(ip: string): { allowed: boolean; reason: 'CONNECTION_CAP' | null } {
    if (this.connections.size >= this.caps.maxConnections) {
      return { allowed: false, reason: 'CONNECTION_CAP' };
    }
    const forIp = this.perIp.get(ip) ?? 0;
    if (forIp >= this.caps.maxConnectionsPerIp) {
      return { allowed: false, reason: 'CONNECTION_CAP' };
    }
    this.perIp.set(ip, forIp + 1);
    return { allowed: true, reason: null };
  }

  /** Attach a live connection and return its release closure (idempotent). */
  attach(connection: StreamConnection, ip: string): () => void {
    this.connections.add(connection);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.connections.delete(connection);
      const count = (this.perIp.get(ip) ?? 1) - 1;
      if (count <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, count);
    };
  }

  /** The number of currently open connections (observability/tests). */
  openCount(): number {
    return this.connections.size;
  }

  /** Open connections currently attributed to an IP (observability/tests). */
  openForIp(ip: string): number {
    return this.perIp.get(ip) ?? 0;
  }

  /** Tell every open stream the server is going away, then it closes itself. */
  onApplicationShutdown(): void {
    for (const connection of [...this.connections]) {
      if (connection.isClosed()) continue;
      connection.emitShutdown('SERVER_SHUTDOWN', SHUTDOWN_RETRY_MS);
    }
    this.logger.log(`SSE registry shut down ${this.connections.size} connection(s)`);
  }
}
