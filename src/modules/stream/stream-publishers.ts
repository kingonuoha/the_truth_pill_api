/**
 * Narrow publisher helpers for the existing Nest write paths.
 *
 * Each helper targets exactly one topic and one event type, and each payload is
 * the frozen `realtime.md` §3 projection — identifiers plus the changed fields,
 * **absolute values only**. No helper accepts or forwards a document
 * (DEV-007 / DEV-055).
 *
 * Write paths call these **after** their transaction commits, with the final
 * committed values, so a frame always carries an absolute value rather than a
 * delta. Publishing touches no database connection.
 */
import { streamBus } from './stream-bus';
import type {
  ActivityAppendedPayload,
  AiStatusPayload,
  ArticleCountersPayload,
  ArticleStatusPayload,
  CommentCreatedPayload,
  DraftStatusPayload,
  EmailStatusPayload,
  EngagementChangedPayload,
  GlobalStatsChangedPayload,
  RealtimeActivityPayload,
  RealtimeSessionProjection,
} from './stream-bus';

export type {
  ActivityAppendedPayload,
  AiStatusPayload,
  ArticleCountersPayload,
  ArticleStatusPayload,
  CommentCreatedPayload,
  DraftStatusPayload,
  EmailStatusPayload,
  EngagementChangedPayload,
  GlobalStatsChangedPayload,
  RealtimeActivityPayload,
  RealtimeSessionProjection,
};

/** `article.counters` on `article:{id}` — the DEV-007 frame. */
export function publishArticleCounters(articleId: string, payload: ArticleCountersPayload): void {
  streamBus.publish({ topic: `article:${articleId}`, type: 'article.counters', data: payload });
}

/** `article.status` on `article:{id}`. */
export function publishArticleStatus(articleId: string, payload: ArticleStatusPayload): void {
  streamBus.publish({ topic: `article:${articleId}`, type: 'article.status', data: payload });
}

/** `engagement.changed` on `engagement:{id}`. */
export function publishEngagementChanged(
  articleId: string,
  payload: EngagementChangedPayload,
): void {
  streamBus.publish({ topic: `engagement:${articleId}`, type: 'engagement.changed', data: payload });
}

/** `comment.created` on `engagement:{id}` — public author card only (DEV-034). */
export function publishCommentCreated(articleId: string, payload: CommentCreatedPayload): void {
  streamBus.publish({ topic: `engagement:${articleId}`, type: 'comment.created', data: payload });
}

/** `globalStats.changed` on `admin:globalStats` — the ten scalars only. */
export function publishGlobalStats(payload: GlobalStatsChangedPayload): void {
  streamBus.publish({ topic: 'admin:globalStats', type: 'globalStats.changed', data: payload });
}

/** `activity.appended` on `admin:activity` — the narrow new-row projection. */
export function publishActivityAppended(payload: ActivityAppendedPayload): void {
  streamBus.publish({ topic: 'admin:activity', type: 'activity.appended', data: payload });
}

/** `email.status` on `admin:emails`. */
export function publishEmailStatus(payload: EmailStatusPayload): void {
  streamBus.publish({ topic: 'admin:emails', type: 'email.status', data: payload });
}

/** `draft.status` on `admin:drafts`. */
export function publishDraftStatus(payload: DraftStatusPayload): void {
  streamBus.publish({ topic: 'admin:drafts', type: 'draft.status', data: payload });
}

/** `aiStatus.changed` on `admin:aiStatus`. */
export function publishAiStatus(payload: AiStatusPayload): void {
  streamBus.publish({ topic: 'admin:aiStatus', type: 'aiStatus.changed', data: payload });
}

/**
 * `analytics.realtime` on `analytics:realtime` — the admin real-time session
 * aggregate, absolute values only. The connection coalesces it on the frozen
 * 10 s window (`topics.ts`). Narrow and PII-free: no `visitorId`, `userRef`,
 * `ipAddress`, or `geoLocation`, and never a document (DEV-007 / DEV-055).
 */
export function publishRealtimeActivity(payload: RealtimeActivityPayload): void {
  streamBus.publish({ topic: 'analytics:realtime', type: 'analytics.realtime', data: payload });
}
