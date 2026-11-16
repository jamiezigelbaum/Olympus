/** Setup proof on the machine that will run the leg, before any fixture or long phase. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { rehash } from './upgrade-split.ts';

export const OLD_STATUS_WAIT_MS = 120_000;

/** Testable bounded status read. Candidate callers keep their existing bound. */
export async function firstStatus<T>(host: { now(): number; sleep(ms: number): Promise<void>; read(remainingMs: number): T; answers(value: T): boolean }, waitMs: number): Promise<T> {
  const end = host.now() + waitMs;
  let value = host.read(Math.max(1, waitMs));
  while (!host.answers(value) && host.now() < end) {
    await host.sleep(Math.min(3_000, end - host.now()));
    if (host.now() >= end) break;
    value = host.read(end - host.now());
  }
  return value;
}

const OLD_STATUS = `  "$WORK/bun" --no-env-file "$WORK/unpacked/package/dist/cli.js" engine status > "$WORK/status.json" \\\n    || die 'Lifecycle status failed; do not treat this as a healthy installation.'`;

/** Only the historical install gets this accommodation; its install/rollback transaction is unchanged. */
export function oldInstallerStatusRetry(text: string): string {
  if (!text.includes(OLD_STATUS)) return text;
  return text.replace(OLD_STATUS, `  status_end=$(( $(date +%s) + 120 ))
  while :; do
    status_left=$(( status_end - $(date +%s) ))
    [ "$status_left" -gt 0 ] || die 'setup.old-install: historical release status did not answer within 120 s.'
    if timeout "$status_left" "$WORK/bun" --no-env-file "$WORK/unpacked/package/dist/cli.js" engine status > "$WORK/status.json"; then break; fi
    [ "$(date +%s)" -lt "$status_end" ] || die 'setup.old-install: historical release status did not answer within 120 s.'
    status_left=$(( status_end - $(date +%s) ))
    if [ "$status_left" -gt 3 ]; then sleep 3; elif [ "$status_left" -gt 0 ]; then sleep "$status_left"; fi
  done`);
}

/** A scratch copy only when the old Linux installer predates d710747e; never edit either input bundle. */
export function oldInstallBundle(source: string, workDir: string): string {
  const installer = join(source, 'install-linux.sh');
  if (!existsSync(installer)) return source;
  const text = readFileSync(installer, 'utf8');
  const patched = oldInstallerStatusRetry(text);
  if (patched === text) return source;
  const copy = join(workDir, 'old-install');
  cpSync(source, copy, { recursive: true });
  writeFileSync(join(copy, 'install-linux.sh'), patched);
  const sums = join(copy, 'SHA256SUMS');
  if (existsSync(sums)) writeFileSync(sums, rehash(readFileSync(sums, 'utf8'), { 'install-linux.sh': digest(join(copy, 'install-linux.sh')) }));
  return copy;
}

export const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Refuse writable paths and symlinks. ancestorRoot is a filesystem-root seam for isolated fixtures; production checks through /. */
export function verifyStagedBundle(root: string, ancestorRoot = '/'): void {
  const safe = (path: string): void => {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || (st.mode & 0o022) !== 0) throw new Error(`unsafe staged path: ${path}`);
  };
  for (let path = resolve(root); ; path = dirname(path)) {
    safe(path);
    if (path === resolve(ancestorRoot) || dirname(path) === path) break;
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      safe(path);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`unsupported staged path: ${path}`);
    }
  };
  walk(root);
  const sums = readFileSync(join(root, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const pinned = new Set<string>();
  for (const line of sums) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error('malformed candidate SHA256SUMS');
    const name = match[2]!;
    if (name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) throw new Error('unsafe candidate checksum path');
    const path = join(root, name);
    if (!files.includes(path) || digest(path) !== match[1]) throw new Error(`candidate checksum mismatch: ${name}`);
    pinned.add(path);
  }
  if (!files.some(path => /\/olympus-[^/]+\.tgz$/.test(path) && pinned.has(path))) throw new Error('candidate tarball missing from SHA256SUMS');
}

export async function preflightProbes(probes: { bundle(): Promise<void>; browser(): Promise<void>; protocol(): Promise<void> }): Promise<void> {
  for (const name of ['bundle', 'browser', 'protocol'] as const) {
    try { await probes[name](); } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
