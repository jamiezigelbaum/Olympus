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
 * Attempts are rate limited across all callers (relayed requests carry no
 * caller address), and five wrong passwords end an approval page.
 */
import { timingSafeEqual } from 'node:crypto';
import type { OlympusConfig } from '../../core/config.ts';

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

/** A token bucket over all demo sign-in attempts. */
export function demoSignInLimiter(now: () => number): { take(): boolean } {
  let tokens = DEMO_SIGN_IN_BURST;
  let last = now();
  return {
    take() {
      const at = now();
      tokens = Math.min(DEMO_SIGN_IN_BURST, tokens + ((at - last) / DEMO_SIGN_IN_WINDOW_MS) * DEMO_SIGN_IN_BURST);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
