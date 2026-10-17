/**
 * Relay logging policy, in one place: one JSON line per event, carrying no
 * request or response body, no token or credential, no query string, and no
 * caller address. An install appears only as a short hash of its id, enough
 * to correlate one install's events without naming it.
 */
import { createHash } from 'node:crypto';

export type RelayEvent =
  | 'session_ready'
  | 'panel_origin_refused'
  | 'session_closed'
  | 'session_replaced'
  | 'session_rejected'
  | 'register'
  | 'request_refused'
  | 'request_failed'
  | 'install_revoked'
  | 'install_restored'
  | 'registration_expired'
  /** A `surfaces` frame that did not parse (shared/protocol.ts); the install's mapping is unchanged. */
  | 'surfaces_refused'
  /** An OAuth client registration answered (client-registration.ts); `ok` only. */
  | 'client_registration'
  /** A demo sign-in page answered: the app, its return address (a pinned one, else a fixed word) and the status (relay.ts demoSignIn). */
  | 'demo_sign_in_page'
  /** A relay-wide budget (registrations, returning registrations, egress) ran dry; once per episode. */
  | 'budget_exhausted';

export type RelayLog = (event: RelayEvent, fields?: Record<string, string | number | boolean>) => void;

/** 8 hex characters of SHA-256 over the install id. */
export function installTag(installId: string): string {
  return createHash('sha256').update(`olympus-relay-log\n${installId}`).digest('hex').slice(0, 8);
}

export function jsonLineLog(write: (line: string) => void = (line) => console.log(line)): RelayLog {
  return (event, fields = {}) => write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
