/**
 * The release builder's Google Desktop pilot client decision.
 *
 * Every Gmail and Google Drive connect path a host offers — the standalone
 * dashboard, the native OpenClaw page, ChatGPT's olympus_connect_source — goes
 * through Olympus's publisher clients. The Desktop pilot client is an optional
 * operator fallback. Source ships none since #765 (2026-11-10: the beta.11
 * client's Google project was deleted), so a build with the variable unset
 * packages no Desktop client:
 *
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=<id>.apps.googleusercontent.com  packages that client
 *   OLYMPUS_GOOGLE_PILOT_CLIENT_ID=none, or unset                   packages no Desktop client
 *   anything else, or the retired beta.11 client                    refuses
 */

import { isRetiredGooglePilotClientId, RETIRED_GOOGLE_PILOT_CLIENT_ID_SHA256 } from '../src/core/google-pilot-client.ts';

export const GOOGLE_PILOT_CLIENT_NONE = 'none';

export const GOOGLE_PILOT_CLIENT_MISSING_MESSAGE = 'OLYMPUS_GOOGLE_PILOT_CLIENT_ID must name a live publisher-owned Google Desktop OAuth client, '
  + 'or be "none" (or unset) to build a release with no Desktop client (Gmail and Drive then connect through the publisher clients). '
  + 'The retired 0.4.0-beta.11 client is refused: its Google project was deleted.';

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
  if (clientId === '') return { kind: 'none' };
  if (isRetiredGooglePilotClientId(clientId)) return undefined;
  return GOOGLE_DESKTOP_CLIENT_ID.test(clientId) ? { kind: 'client', clientId } : undefined;
}

/** The release builder's stand-in for src/core/google-pilot-client.ts. */
export function packagedGooglePilotClientModule(choice: ReleaseGooglePilotChoice): string {
  const id = choice.kind === 'client' ? choice.clientId : '';
  return "import { createHash } from 'node:crypto';\n"
    + `export const DEFAULT_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(id)};\n`
    + `export const PACKAGED_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(id)};\n`
    + 'export function resolveGooglePilotClientId(packaged, shipped) { return (packaged || \'\').trim() || (shipped || \'\').trim() || undefined; }\n'
    + 'export function packagedGooglePilotClientId() { return resolveGooglePilotClientId(PACKAGED_GOOGLE_PILOT_CLIENT_ID, DEFAULT_GOOGLE_PILOT_CLIENT_ID); }\n'
    + `const RETIRED_GOOGLE_PILOT_CLIENT_ID_SHA256 = new Set(${JSON.stringify([...RETIRED_GOOGLE_PILOT_CLIENT_ID_SHA256])});\n`
    + 'export function isRetiredGooglePilotClientId(clientId) { const t = (clientId || \'\').trim(); return t !== \'\' && RETIRED_GOOGLE_PILOT_CLIENT_ID_SHA256.has(createHash(\'sha256\').update(t).digest(\'hex\')); }\n';
}

/** One line for the build log, so the choice is on record either way. */
export function describeReleaseGooglePilotChoice(choice: ReleaseGooglePilotChoice): string {
  return choice.kind === 'client'
    ? `Google Desktop pilot client: ${choice.clientId}`
    : 'Google Desktop pilot client: none; Gmail and Drive connect through the publisher Web client and relay.';
}
