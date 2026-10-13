/**
 * What a tool call gets while its install is offline: one fixed result, the
 * same for every tool on both MCP endpoints, so an always-on agent backs off
 * and tries again later (docs/design/background-agents.md, section E). The
 * relay produces it (server/relay-mcp.ts); the engine's remote error schema
 * declares its shape (src/core/remote-result.ts), and a test holds the two
 * together.
 *
 * "Last seen" is said coarsely: under an hour, then whole hours, then whole
 * days. It says nothing else about the install.
 */

/** The remote error code of the offline result (src/core/remote-result.ts RemoteErrorCode). */
export const OFFLINE_ERROR_CODE = 'olympus_offline';
/** How long an agent is asked to wait before trying again: the result's field and the HTTP Retry-After. */
export const OFFLINE_RETRY_AFTER_SECONDS = 300;
/** The sentence when the relay has no last-seen time for the install. */
export const OFFLINE_SENTENCE_UNKNOWN = 'Olympus is off; try again later.';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** "less than an hour ago", "about 3 hours ago", "about 2 days ago"; undefined without a time. */
export function lastSeenPhrase(lastSeenAt: number | undefined, now: number): string | undefined {
  if (lastSeenAt === undefined || !Number.isFinite(lastSeenAt)) return undefined;
  const ago = Math.max(0, now - lastSeenAt);
  if (ago < HOUR_MS) return 'less than an hour ago';
  if (ago < 2 * DAY_MS) {
    const hours = Math.floor(ago / HOUR_MS);
    return `about ${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return `about ${Math.floor(ago / DAY_MS)} days ago`;
}

/** "Olympus is off; last seen about 3 hours ago; try again later." */
export function offlineSentence(lastSeenAt: number | undefined, now: number): string {
  const seen = lastSeenPhrase(lastSeenAt, now);
  return seen ? `Olympus is off; last seen ${seen}; try again later.` : OFFLINE_SENTENCE_UNKNOWN;
}

/** The remote surface's error body for an offline call: exactly these three fields. */
export function offlineErrorBody(lastSeenAt: number | undefined, now: number): {
  error: typeof OFFLINE_ERROR_CODE;
  message: string;
  retry_after_seconds: number;
} {
  return { error: OFFLINE_ERROR_CODE, message: offlineSentence(lastSeenAt, now), retry_after_seconds: OFFLINE_RETRY_AFTER_SECONDS };
}
