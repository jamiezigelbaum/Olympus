/**
 * The release builder's Google Desktop pilot client decision, made explicitly.
 *
 * Every Gmail and Google Drive connect path a host offers — the standalone
 * dashboard, the native OpenClaw page, ChatGPT's olympus_connect_source — goes
 * through the publisher Google Web client, the relay and the publisher
 * exchange. The Desktop pilot client is a fallback for a dashboard with no
 * publisher Web client, and keeps publisher recognition for installs that
 * connected through it. Olympus 1.0 ships the beta.11 Desktop client as the
 * source default (owner decision, 2026-10-03; docs/V0_4_RELEASE.md,
 * Decisions); a release may be built either way, but never by omission:
 *
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=<id>.apps.googleusercontent.com  packages that client
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=none                            packages no Desktop client
 *   unset or anything else                                         refuses (unless
 *                                                                  DEFAULT_GOOGLE_PILOT_CLIENT_ID
 *                                                                  carries a client in source)
 */

export const GOOGLE_PILOT_CLIENT_NONE = 'none';

export const GOOGLE_PILOT_CLIENT_MISSING_MESSAGE = 'OLYMPUS_GOOGLE_PILOT_CLIENT_ID must name the publisher-owned Google Desktop OAuth client, '
  + 'or be "none" to build a release with no Desktop client (Gmail and Drive then connect only through the publisher Web client and relay), '
  + 'unless DEFAULT_GOOGLE_PILOT_CLIENT_ID carries one in src/core/google-pilot-client.ts.';

const GOOGLE_DESKTOP_CLIENT_ID = /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

export type ReleaseGooglePilotChoice =
  | { kind: 'client'; clientId: string }
  | { kind: 'none' };

/** The env var wins, so a release can pin a client (or none) without a source edit. */
export function releaseGooglePilotChoice(
  envValue: string | undefined,
  shippedDefault: string,
): ReleaseGooglePilotChoice | undefined {
  const requested = envValue?.trim() ?? '';
  if (requested === GOOGLE_PILOT_CLIENT_NONE) return { kind: 'none' };
  const clientId = requested || shippedDefault.trim();
  return GOOGLE_DESKTOP_CLIENT_ID.test(clientId) ? { kind: 'client', clientId } : undefined;
}

/** The release builder's stand-in for src/core/google-pilot-client.ts. */
export function packagedGooglePilotClientModule(choice: ReleaseGooglePilotChoice): string {
  const id = choice.kind === 'client' ? choice.clientId : '';
  return `export const DEFAULT_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(id)};\n`
    + `export const PACKAGED_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(id)};\n`
    + 'export function resolveGooglePilotClientId(packaged, shipped) { return (packaged || \'\').trim() || (shipped || \'\').trim() || undefined; }\n'
    + 'export function packagedGooglePilotClientId() { return resolveGooglePilotClientId(PACKAGED_GOOGLE_PILOT_CLIENT_ID, DEFAULT_GOOGLE_PILOT_CLIENT_ID); }\n';
}

/** One line for the build log, so the choice is on record either way. */
export function describeReleaseGooglePilotChoice(choice: ReleaseGooglePilotChoice): string {
  return choice.kind === 'client'
    ? `Google Desktop pilot client: ${choice.clientId}`
    : 'Google Desktop pilot client: none (OLYMPUS_GOOGLE_PILOT_CLIENT_ID=none); Gmail and Drive connect through the publisher Web client and relay.';
}
