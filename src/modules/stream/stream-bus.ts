/**
 * The in-process topic bus (ADR-005).
 *
 * A single `EventEmitter` is the fan-out point between the Nest write paths
 * (article counters/status, engagement, analytics `globalStats`, email status,
 * `aiStatus`) and the open SSE connections. It is deliberately **not** a data
 * layer and holds **no** database connection: the DB is touched only at ticket
 * mint/redeem and per-topic refreshed reads, released immediately (ADR-018).
 *
 * One module-level instance (`streamBus`) is imported directly by the write
 * paths, so no feature module depends on `StreamModule` for DI and no circular
 * import is created.
 *
 * DEV-007 / DEV-055: every published payload is a narrow, absolute-value
 * projection — identifiers plus only the fields that changed. No helper here
 * ever accepts an article/comment document.
 */
import { EventEmitter } from 'node:events';
import type { StreamEventType } from './topics';

/** A published topic event: the changed topic, its event type, and narrow data. */
export interface StreamEvent {
  topic: string;
  type: StreamEventType;
  data: object;
}

/**
 * The narrow, frozen frame payloads (`realtime.md` §3, matrix §3.1). These are
 * the only shapes a publisher may send; none carries a document field.
 */
export type ArticleCountersPayload = {
  articleId: string;
  viewCount: number;
  uniqueViewCount: number;
  actualReadingTime: number;
};

export type ArticleStatusPayload = {
  articleId: string;
  status: string;
  publishedAt: string | null;
};

export type EngagementChangedPayload = {
  articleId: string;
  likeCount: number;
  loveCount: number;
  insightfulCount: number;
  totalReactions: number;
  commentsCount: number;
  bookmarksCount: number;
};

/** The public author card only — never a user document (DEV-034). */
export type CommentCreatedPayload = {
  articleId: string;
  comment: {
    id: string;
    parentId: string | null;
    content: string;
    status: string;
    createdAt: string;
    authorName: string;
    authorImage: string | null;
  };
};

/** The ten scalar counters only (no `id`/`updatedAt`). */
export type GlobalStatsChangedPayload = {
  articleCount: number;
  publishedArticleCount: number;
  draftArticleCount: number;
  scheduledArticleCount: number;
  aiDraftCount: number;
  usersCount: number;
  commentsCount: number;
  pendingCommentsCount: number;
  totalViews: number;
  totalUniqueViews: number;
};

/** The new activity row only, projected narrow (no IP, no document). */
export type ActivityAppendedPayload = {
  id: string;
  url: string;
  device: string;
  browser: string;
  os: string;
  timestamp: string;
};

export type EmailStatusPayload = {
  id: string;
  status: string;
  retries: number;
  error?: string | null;
};

export type DraftStatusPayload = {
  id: string;
  status: string;
  title: string;
};

export type AiStatusPayload = {
  isWriting: boolean;
  lastRun: string | null;
  nextRun: string | null;
};

/**
 * One active session inside `analytics.realtime` (`realtime.md` §3). Narrow and
 * PII-free: no `visitorId`, `userRef`, `ipAddress`, `geoLocation`, and never a
 * document field (DEV-007 / DEV-055).
 */
export type RealtimeSessionProjection = {
  url: string;
  device: string;
  browser: string;
  os: string;
  referrer: string | null;
  timestamp: string;
};

/**
 * `analytics.realtime` on `analytics:realtime` — absolute values only, the same
 * source/dedupe as `getRealTimeActivity` (latest ≤ 100 `pageVisits` within 1 h,
 * one per visitor). No identifiers, no IP, no geo, never a document.
 */
export type RealtimeActivityPayload = {
  windowSeconds: number;
  activeSessions: number;
  sessions: RealtimeSessionProjection[];
};

/** The bus contract consumed by the SSE connection and produced by writers. */
export interface TopicBus {
  publish(event: StreamEvent): void;
  subscribe(listener: (event: StreamEvent) => void): () => void;
}

class InProcessTopicBus implements TopicBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Connections subscribe/ unsubscribe for their whole lifetime; there is no
    // fixed listener ceiling (a 1000-connection cap is the real bound).
    this.emitter.setMaxListeners(0);
  }

  publish(event: StreamEvent): void {
    this.emitter.emit('topic-event', event);
  }

  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.emitter.on('topic-event', listener);
    return () => {
      this.emitter.off('topic-event', listener);
    };
  }
}

/** The one and only bus (ADR-005). */
export const streamBus: TopicBus = new InProcessTopicBus();
