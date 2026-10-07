/**
 * The worker-private secret that signs dashboard control sessions
 * (workers/http.ts). Independent of the worker bearer, so a bearer holder
 * cannot forge a session cookie; durable across worker restarts, so the
 * owner is not logged out of the dashboard every time the worker restarts.
 *
 * Stored next to the worker token (`~/.config/olympus/worker.env`), as
 * `dashboard-session.secret`: 32 random bytes, base64url, in an owner-only
 * regular file (0600, no symlink, this user's). Loaded at worker start and
 * created when missing. Anything unreadable, foreign or malformed is
 * regenerated (every session is then lost, which is fine) and nothing ever
 * falls back to the bearer. When the file cannot be written at all the
 * worker runs on an in-memory secret for its lifetime.
 *
 * Residual, accepted: a local process that can read this file can forge a
 * session, a local-grade one included; the secret removes bearer-derived
 * authority, not local-process authority.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { workerSetupEnvPath, type WorkerAuthTokenLookupOptions } from './worker-auth.ts';

export const DASHBOARD_SESSION_SECRET_FILE = 'dashboard-session.secret';
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function dashboardSessionSecretPath(options: WorkerAuthTokenLookupOptions = {}): string {
  return join(dirname(workerSetupEnvPath(options)), DASHBOARD_SESSION_SECRET_FILE);
}

export function newDashboardSessionSecret(): string {
  return randomBytes(32).toString('base64url');
}

export type DashboardSessionSecretSource = 'file' | 'created' | 'regenerated' | 'memory';

/**
 * Load the secret, or create it. Never throws and never returns anything
 * derived from the bearer. `source` says what happened, for the worker log.
 */
export function loadOrCreateDashboardSessionSecret(
  options: WorkerAuthTokenLookupOptions & { path?: string } = {},
): { secret: string; source: DashboardSessionSecretSource; path: string } {
  const path = options.path ?? dashboardSessionSecretPath(options);
  let existing: 'valid' | 'missing' | 'invalid' = 'missing';
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) existing = 'invalid';
    else if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) existing = 'invalid';
    else if ((stats.mode & 0o077) !== 0) existing = 'invalid';
    else {
      const text = readFileSync(path, 'utf8').trim();
      if (SECRET_PATTERN.test(text)) return { secret: text, source: 'file', path };
      existing = 'invalid';
    }
  } catch (error) {
    existing = (error as { code?: string })?.code === 'ENOENT' ? 'missing' : 'invalid';
  }
  const secret = newDashboardSessionSecret();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // A symlink or a foreign file at the path is replaced by the rename, never written through.
    writePrivateFileAtomicSync(path, `${secret}\n`);
    chmodSync(path, 0o600);
    return { secret, source: existing === 'missing' ? 'created' : 'regenerated', path };
  } catch {
    return { secret, source: 'memory', path };
  }
}
