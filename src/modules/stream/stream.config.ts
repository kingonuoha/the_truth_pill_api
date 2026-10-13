/**
 * Environment-tunable SSE configuration (matrix §4.1, DEV-057).
 *
 * No cap and no window is hard-coded: each reads an env var and falls back to
 * the frozen default. This is what makes the caps and throttle windows
 * testable without exposing a production knob that changes the contract.
 */
import { ConfigService } from '@nestjs/config';
import { DEFAULT_THROTTLE_WINDOWS, ThrottleWindows } from './topics';

export interface StreamCaps {
  maxConnections: number;
  maxTopicsPerConnection: number;
  maxConnectionsPerIp: number;
}

export const DEFAULT_CAPS: StreamCaps = {
  maxConnections: 1000,
  maxTopicsPerConnection: 8,
  maxConnectionsPerIp: 6,
};

/** Read a positive integer from config, falling back on missing/invalid input. */
export function readInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string>(key);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** The per-topic coalescing windows (`realtime.md` §3), env-overridable. */
export function resolveThrottleWindows(config: ConfigService): ThrottleWindows {
  return {
    articleMs: readInt(config, 'SSE_THROTTLE_MS_ARTICLE', DEFAULT_THROTTLE_WINDOWS.articleMs),
    engagementMs: readInt(config, 'SSE_THROTTLE_MS_ENGAGEMENT', DEFAULT_THROTTLE_WINDOWS.engagementMs),
    analyticsMs: readInt(config, 'SSE_THROTTLE_MS_ANALYTICS', DEFAULT_THROTTLE_WINDOWS.analyticsMs),
    globalStatsMs: readInt(config, 'SSE_THROTTLE_MS_GLOBAL_STATS', DEFAULT_THROTTLE_WINDOWS.globalStatsMs),
    adminMs: readInt(config, 'SSE_THROTTLE_MS_ADMIN', DEFAULT_THROTTLE_WINDOWS.adminMs),
  };
}

/** The connection/topic caps (`realtime.md` §6), env-overridable. */
export function resolveCaps(config: ConfigService): StreamCaps {
  return {
    maxConnections: readInt(config, 'SSE_MAX_CONNECTIONS', DEFAULT_CAPS.maxConnections),
    maxTopicsPerConnection: readInt(
      config,
      'SSE_MAX_TOPICS_PER_CONNECTION',
      DEFAULT_CAPS.maxTopicsPerConnection,
    ),
    maxConnectionsPerIp: readInt(
      config,
      'SSE_MAX_CONNECTIONS_PER_IP',
      DEFAULT_CAPS.maxConnectionsPerIp,
    ),
  };
}
