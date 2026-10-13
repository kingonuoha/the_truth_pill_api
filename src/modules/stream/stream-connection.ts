/**
 * One SSE connection: the frame writer, coalescer, and heartbeat.
 *
 * The connection subscribes to the in-process topic bus (ADR-005) for the topic
 * set bound into its ticket, coalesces events **per topic, per connection**
 * inside the frozen throttle window, and writes one union frame per window with
 * the latest absolute value per field (`realtime.md` §3, DEV-055).
 *
 * It holds **no** database connection (ADR-018): it only writes to a sink and
 * listens to the bus. `Date.now()` is used for `ts`/`ping`; the throttle uses a
 * single timer per topic, so N writes inside one window yield exactly one frame.
 *
 * DEV-007: every frame is the narrow `{v,type,ts,data}` envelope. No method here
 * ever receives or emits an article/comment document.
 */
import { StreamEvent } from './stream-bus';
import {
  RedeemedTicket,
} from './stream-ticket.store';
import {
  isKnownTopic,
  SSE_SCHEMA_VERSION,
  StreamEnvelope,
  StreamEventType,
  throttleWindowFor,
  ThrottleWindows,
} from './topics';

/** Where frame bytes are written (the Express response in production). */
export type StreamSink = (chunk: string) => void;

export interface StreamConnectionDeps {
  ticket: RedeemedTicket;
  windows: ThrottleWindows;
  subscribe: (listener: (event: StreamEvent) => void) => () => void;
  /** Heartbeat interval; defaults to the frozen 15 s. */
  heartbeatMs?: number;
  /** Reconnect hint written at open; defaults to the frozen 5000 ms. */
  retryMs?: number;
  onClose?: () => void;
}

interface PendingWindow {
  timer: NodeJS.Timeout;
  bags: Map<StreamEventType, Record<string, unknown>>;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RETRY_MS = 5_000;

export class StreamConnection {
  private readonly topics = new Set<string>();
  private readonly pending = new Map<string, PendingWindow>();
  private readonly retryMs: number;
  private readonly heartbeatMs: number;
  private readonly onClose: () => void;

  private nextId = 0;
  private closed = false;
  private unsubscribe: () => void = () => undefined;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly sink: StreamSink,
    private readonly deps: StreamConnectionDeps,
  ) {
    this.retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onClose = deps.onClose ?? (() => undefined);
  }

  /**
   * Write `retry:`, register the ticket's topics, subscribe to the bus, and
   * start the heartbeat. An unknown topic is a non-closing `TOPIC_UNKNOWN`
   * frame (matrix §4.2) and is not subscribed.
   */
  open(): void {
    if (this.closed) return;
    this.sink(`retry: ${this.retryMs}\n\n`);

    for (const topic of this.deps.ticket.topics) {
      if (!isKnownTopic(topic)) {
        this.emitError('TOPIC_UNKNOWN', 'Unknown topic', false, topic);
        continue;
      }
      this.topics.add(topic);
    }

    this.unsubscribe = this.deps.subscribe((event) => this.onEvent(event));
    this.heartbeat = setInterval(() => this.ping(), this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /** Emit a typed error frame. `TOPIC_UNKNOWN` deliberately does not close. */
  emitError(
    code: 'TOPIC_UNKNOWN' | 'TOPIC_FORBIDDEN' | 'CONNECTION_CAP',
    message: string,
    retryable: boolean,
    topic?: string,
  ): void {
    this.writeFrame('stream.error', {
      code,
      message,
      retryable,
      ...(topic !== undefined ? { topic } : {}),
    });
  }

  /** Emit the shutdown frame and close the connection. */
  emitShutdown(code: string, retryAfterMs: number): void {
    this.writeFrame('stream.shutdown', { code, retryAfterMs });
    this.close();
  }

  /** Tear down timers, the bus subscription, and any pending window. */
  close(): void {
    if (this.closed) return;
    // Flush any coalesced-but-unwritten window first (absolute values, so this
    // is a best-effort last frame, not required for correctness).
    for (const [topic] of this.pending) {
      const window = this.pending.get(topic);
      if (window) clearTimeout(window.timer);
      this.flush(topic);
    }
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe();
    this.onDone();
  }

  isClosed(): boolean {
    return this.closed;
  }

  /* ───────────────────────────── internals ───────────────────────────── */

  private onDone(): void {
    this.pending.clear();
    this.onClose();
  }

  private onEvent(event: StreamEvent): void {
    if (this.closed || !this.topics.has(event.topic)) return;

    let window = this.pending.get(event.topic);
    if (!window) {
      const windowMs = throttleWindowFor(event.topic, this.deps.windows);
      const timer = setTimeout(() => this.flush(event.topic), windowMs);
      timer.unref?.();
      window = { timer, bags: new Map() };
      this.pending.set(event.topic, window);
    }

    const bag = window.bags.get(event.type) ?? {};
    Object.assign(bag, event.data);
    window.bags.set(event.type, bag);
  }

  private flush(topic: string): void {
    const window = this.pending.get(topic);
    if (!window) return;
    this.pending.delete(topic);
    for (const [type, data] of window.bags) this.writeFrame(type, data);
  }

  private ping(): void {
    if (this.closed) return;
    this.sink(`: ping ${Date.now()}\n\n`);
  }

  private writeFrame(type: StreamEventType, data: Record<string, unknown>): void {
    if (this.closed) return;
    this.nextId += 1;
    const envelope: StreamEnvelope = {
      v: SSE_SCHEMA_VERSION,
      type,
      ts: Date.now(),
      data: { ...data },
    };
    this.sink(`event: ${type}\nid: ${this.nextId}\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
}
