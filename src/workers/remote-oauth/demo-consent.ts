/**
 * Reviewer sign-in on a demo install.
 *
 * A directory reviewer has no Mac running Olympus, so the loopback-only
 * approval that protects every real install cannot work for them. A demo
 * install (synthetic sample data only) may instead approve ChatGPT with a
 * username and password over the relay, at `/connect/demo/authorize`. It is
 * active only when ALL of these hold:
 *
 * - relay mode (the install has a relay id);
 * - `remote.demoConsent.enabled` is true, with a username and an Argon2id
 *   `passwordHash` (never the password);
 * - the data directory carries the demo marker (core/remote-access.ts
 *   `demoInstallMarked`), which no real install has.
 *
 * Wrong attempts are rate limited across all callers (relayed requests carry
 * no caller address; a right one gives its token back, so reviewers signing
 * in correctly never lock each other out), and five wrong passwords end an
 * approval page. A demo grant gets the read-only ChatGPT surface
 * (`isDemoGrant`).
 */
import { timingSafeEqual } from 'node:crypto';
import type { OlympusConfig } from '../../core/config.ts';
import { pinnedClient } from './pinned-clients.ts';

export interface DemoConsentSettings {
  readonly username: string;
  readonly passwordHash: string;
}

/** Wrong sign-ins allowed in a burst, refilled over the window. */
export const DEMO_SIGN_IN_BURST = 10;
export const DEMO_SIGN_IN_WINDOW_MS = 15 * 60_000;

/** The active demo settings, or undefined (the usual case: not a demo install). */
export function resolveDemoConsent(
  remote: OlympusConfig['remote'],
  markerPresent: () => boolean,
): DemoConsentSettings | undefined {
  const demo = remote?.demoConsent;
  if (!demo?.enabled || !demo.username || !demo.passwordHash?.startsWith('$argon2')) return undefined;
  if (!markerPresent()) return undefined;
  return { username: demo.username, passwordHash: demo.passwordHash };
}

/** Constant-time username check, then the password against its hash. */
export async function verifyDemoSignIn(settings: DemoConsentSettings, username: string, password: string): Promise<boolean> {
  const presented = Buffer.from(username);
  const expected = Buffer.from(settings.username);
  const userOk = presented.length === expected.length && timingSafeEqual(presented, expected);
  let passwordOk = false;
  try {
    passwordOk = password.length > 0 && password.length <= 1024 && await Bun.password.verify(password, settings.passwordHash);
  } catch {
    passwordOk = false;
  }
  return userOk && passwordOk;
}

/**
 * A token bucket over all demo sign-in attempts. Each attempt takes a token
 * before its password check (so concurrent guesses cannot all pass) and a
 * right sign-in refunds it: only wrong sign-ins spend the budget.
 */
export function demoSignInLimiter(now: () => number): { take(): boolean; refund(): void } {
  let tokens = DEMO_SIGN_IN_BURST;
  let last = now();
  const refill = () => {
    const at = now();
    tokens = Math.min(DEMO_SIGN_IN_BURST, tokens + ((at - last) / DEMO_SIGN_IN_WINDOW_MS) * DEMO_SIGN_IN_BURST);
    last = at;
  };
  return {
    take() {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    refund() {
      refill();
      tokens = Math.min(DEMO_SIGN_IN_BURST, tokens + 1);
    },
  };
}

/** A demo grant's connection name: the pinned client's name, marked. */
export function demoGrantDisplayName(clientName: string): string {
  return `${clientName} (demo sign-in)`;
}

/**
 * Whether a connection is a grant made through demo sign-in: a pinned
 * client's grant carrying the demo name. A pinned client's ordinary grant is
 * named by the pin alone, so only the demo path makes this name for one.
 */
export function isDemoGrant(connection: { clientId?: string | null; displayName: string }): boolean {
  const pinned = connection.clientId ? pinnedClient(connection.clientId) : undefined;
  return pinned !== undefined && connection.displayName === demoGrantDisplayName(pinned.clientName);
}
