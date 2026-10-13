/**
 * The frozen SSE topic / event model (`docs/endpoints/realtime.md` §3, matrix §2).
 *
 * One place defines: the two dynamic topic patterns, the six fixed admin topic
 * names, the twelve event types, the per-topic throttle window, and the
 * envelope shape. Both the issuance validator and the connection coalescer read
 * from here so the authorization rule and the projection rule cannot drift.
 *
 * DEV-055: this module is the Nest mechanism that closes DEV-007 — no frame
 * type defined here ever carries a document field.
 */

/** The schema version carried on every frame (`realtime.md` §3). */
export const SSE_SCHEMA_VERSION = 1;

/** The six fixed, non-`article:*`/`engagement:*` topic names (matrix §2). */
export const ADMIN_TOPICS = [
  'analytics:realtime',
  'admin:globalStats',
  'admin:activity',
  'admin:emails',
  'admin:drafts',
  'admin:aiStatus',
] as const;

export type AdminTopic = (typeof ADMIN_TOPICS)[number];

/** The twelve frozen event types (`realtime.md` §3, incl. Adjudication A). */
export const STREAM_EVENT_TYPES = [
  'article.counters',
  'article.status',
  'engagement.changed',
  'comment.created',
  'globalStats.changed',
  'activity.appended',
  'email.status',
  'draft.status',
  'aiStatus.changed',
  'analytics.realtime',
  'stream.error',
  'stream.shutdown',
] as const;

export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];

/** Coarse topic class used by the authorization matrix (matrix §2). */
export type TopicClass = 'article' | 'engagement' | 'analytics' | 'admin' | 'unknown';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ARTICLE_TOPIC = new RegExp(`^article:${UUID}$`);
const ENGAGEMENT_TOPIC = new RegExp(`^engagement:${UUID}$`);

const ADMIN_TOPIC_SET: ReadonlySet<string> = new Set(ADMIN_TOPICS);

/** The article id inside `article:{id}` / `engagement:{id}`, or `null`. */
export function topicSubject(topic: string): string | null {
  const match = /^(?:article|engagement):(.+)$/.exec(topic);
  return match ? match[1] : null;
}

/** Classify a topic string against the frozen patterns. */
export function classifyTopic(topic: string): TopicClass {
  if (ARTICLE_TOPIC.test(topic)) return 'article';
  if (ENGAGEMENT_TOPIC.test(topic)) return 'engagement';
  if (topic === 'analytics:realtime') return 'analytics';
  if (ADMIN_TOPIC_SET.has(topic)) return 'admin';
  return 'unknown';
}

/** Whether a topic matches a frozen pattern (issuance shape check, matrix §2.1). */
export function isKnownTopic(topic: string): boolean {
  return classifyTopic(topic) !== 'unknown';
}

/** Whether a topic requires an admin (DB-resolved) role (matrix §2). */
export function isAdminClassTopic(topic: string): boolean {
  const cls = classifyTopic(topic);
  return cls === 'admin' || cls === 'analytics';
}

/** The envelope written into every SSE `data:` line (`realtime.md` §3). */
export interface StreamEnvelope<T extends StreamEventType = StreamEventType> {
  v: number;
  type: T;
  ts: number;
  data: Record<string, unknown>;
}

/** The two event types a single `article:{id}` topic may carry. */
export const ARTICLE_EVENT_TYPES: readonly StreamEventType[] = ['article.counters', 'article.status'];

/** The two event types a single `engagement:{id}` topic may carry. */
export const ENGAGEMENT_EVENT_TYPES: readonly StreamEventType[] = [
  'engagement.changed',
  'comment.created',
];

/**
 * Throttle windows in milliseconds, per topic class (`realtime.md` §3). The
 * values are env-overridable (matrix §4.1: "no cap is hard-coded"); these are
 * the frozen defaults. `hardCeilingMs` names the guarantee: N writes inside one
 * window produce exactly one coalesced frame.
 */
export interface ThrottleWindows {
  articleMs: number;
  engagementMs: number;
  analyticsMs: number;
  globalStatsMs: number;
  adminMs: number;
}

export const DEFAULT_THROTTLE_WINDOWS: ThrottleWindows = {
  articleMs: 10_000,
  engagementMs: 10_000,
  analyticsMs: 10_000,
  globalStatsMs: 30_000,
  adminMs: 2_000,
};

/** Resolve the coalescing window for a topic. */
export function throttleWindowFor(topic: string, windows: ThrottleWindows): number {
  switch (classifyTopic(topic)) {
    case 'article':
      return windows.articleMs;
    case 'engagement':
      return windows.engagementMs;
    case 'analytics':
      return windows.analyticsMs;
    default:
      return topic === 'admin:globalStats' ? windows.globalStatsMs : windows.adminMs;
  }
}
