/** One Linux layout shared by installers, services and consumers. No OpenClaw dependency. */
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';

type Env = Record<string, string | undefined>;
export interface LinuxEngineLayout {
  home: string; configHome: string; dataHome: string; stateHome: string; cacheHome: string;
  runtimeHome: string; configDir: string; dataDir: string; stateDir: string; cacheDir: string;
  runtimeDir: string; packageDir: string; unitPath: string; configPath: string; sovereigntyPath: string;
  workerEnvPath: string; workerSocketPath: string; receiptPath: string; lifecycleLockPath: string;
  secretsPath: string; secretsKeyPath: string;
}
export interface LinuxEngineReceipt {
  schema: 'olympus.engine.install.v1'; uid: number; layout: LinuxEngineLayout;
  ownedUnitLinks: string[]; lingerPredated?: boolean;
  rotation: { mechanism: 'host-copytruncate'; maxBytes: number; retained: number };
}
function absolute(value: string, name: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path without control characters.`);
  return resolve(value);
}
function rawLayout(env: Env): LinuxEngineLayout {
  const home = absolute(env.HOME || homedir(), 'HOME');
  const root = (key: string, fallback: string) => absolute(env[key] || join(home, fallback), key);
  const configHome = root('XDG_CONFIG_HOME', '.config'); const dataHome = root('XDG_DATA_HOME', '.local/share');
  const stateHome = root('XDG_STATE_HOME', '.local/state'); const cacheHome = root('XDG_CACHE_HOME', '.cache');
  const runtimeHome = env.XDG_RUNTIME_DIR ? absolute(env.XDG_RUNTIME_DIR, 'XDG_RUNTIME_DIR') : '';
  const configDir = join(configHome, 'olympus'); const runtimeDir = runtimeHome ? join(runtimeHome, 'olympus') : '';
  return { home, configHome, dataHome, stateHome, cacheHome, runtimeHome, configDir,
    dataDir: join(dataHome, 'openclaw/olympus'), stateDir: join(stateHome, 'olympus/engine'), cacheDir: join(cacheHome, 'olympus/engine'), runtimeDir,
    packageDir: join(dataHome, 'olympus/engine'), unitPath: join(configHome, 'systemd/user/olympus-engine.service'),
    configPath: join(configDir, 'engine.json'), sovereigntyPath: join(configDir, 'sovereignty.json'), workerEnvPath: join(configDir, 'worker.env'),
    workerSocketPath: runtimeDir ? join(runtimeDir, 'worker.sock') : '', lifecycleLockPath: runtimeDir ? join(runtimeDir, 'lifecycle') : '',
    receiptPath: join(configDir, 'install-receipt.json'), secretsPath: join(configDir, 'secrets.enc'), secretsKeyPath: join(configDir, 'secrets.key') };
}
function stat(path: string) { try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
/** Validate the whole ancestor chain without chmod-ing any shared XDG parent. */
export function assertLinuxManagedPath(path: string, uid = process.getuid!(), leaf: 'file' | 'directory' | 'socket' = 'file'): void {
  const full = absolute(path, 'managed path'); let current = full;
  while (true) {
    const info = stat(current);
    if (info) {
      if (info.isSymbolicLink()) throw new Error(`${current} is a symbolic link; nothing was changed.`);
      if (info.uid !== uid && info.uid !== 0) throw new Error(`${current} has a foreign owner; nothing was changed.`);
      if ((info.mode & 0o022) !== 0 && !(info.uid === 0 && info.isDirectory() && (info.mode & 0o1000) !== 0)) throw new Error(`${current} has unsafe writable permissions.`);
      if (current === full) {
        if (info.uid !== uid) throw new Error(`${current} has a foreign owner.`);
        if (leaf === 'directory' ? !info.isDirectory() : leaf === 'socket' ? !info.isSocket() : !info.isFile()) throw new Error(`${current} is not a regular ${leaf}.`);
      } else if (!info.isDirectory()) throw new Error(`${current} is not a directory.`);
    }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export function readLinuxEngineReceipt(path: string, uid = process.getuid!()): LinuxEngineReceipt | undefined {
  if (!stat(path)) return undefined;
  assertLinuxManagedPath(path, uid);
  if ((lstatSync(path).mode & 0o077) !== 0) throw new Error(`${path} must be private (0600).`);
  const receipt = JSON.parse(readFileSync(path, 'utf8')) as LinuxEngineReceipt;
  if (receipt.schema !== 'olympus.engine.install.v1' || receipt.uid !== uid || !receipt.layout) throw new Error(`${path} is a foreign or invalid install receipt.`);
  const l = receipt.layout;
  const expected = rawLayout({ HOME: l.home, XDG_CONFIG_HOME: l.configHome, XDG_DATA_HOME: l.dataHome, XDG_STATE_HOME: l.stateHome, XDG_CACHE_HOME: l.cacheHome, XDG_RUNTIME_DIR: l.runtimeHome });
  if (JSON.stringify(l) !== JSON.stringify(expected) || l.receiptPath !== path) throw new Error(`${path} has an inconsistent install layout.`);
  if (!Array.isArray(receipt.ownedUnitLinks) || receipt.ownedUnitLinks.some(p => typeof p !== 'string' || !isAbsolute(p))) throw new Error(`${path} has invalid unit links.`);
  return receipt;
}
/** Discover the default and explicitly selected config root; receipt roots win over shell drift. */
export function resolveLinuxEngineLayout(env: Env = process.env): LinuxEngineLayout {
  const requested = rawLayout(env);
  const candidates = [...new Set([join(requested.home, '.config/olympus/install-receipt.json'), requested.receiptPath])];
  const present = candidates.filter(p => stat(p));
  if (present.length > 1) throw new Error(`Found multiple Olympus install receipts: ${present.join(', ')}. Select one installation after moving the other aside.`);
  const receipt = present[0] ? readLinuxEngineReceipt(present[0]) : undefined;
  if (receipt && receipt.layout.home !== requested.home) throw new Error(`${present[0]} belongs to another home.`);
  return receipt?.layout ?? requested;
}
export function linuxEngineEnvironment(layout: LinuxEngineLayout): Record<string, string> {
  return { HOME: layout.home, XDG_CONFIG_HOME: layout.configHome, XDG_DATA_HOME: layout.dataHome, XDG_STATE_HOME: layout.stateHome,
    XDG_CACHE_HOME: layout.cacheHome, XDG_RUNTIME_DIR: layout.runtimeHome, OLYMPUS_SOVEREIGNTY_CONFIG: layout.sovereigntyPath };
}
export function preflightLinuxEngineLayout(layout: LinuxEngineLayout, options: { uid?: number; fresh?: boolean } = {}): void {
  const uid = options.uid ?? process.getuid!();
  for (const path of [layout.configDir, layout.dataDir, layout.stateDir, layout.cacheDir, layout.packageDir]) {
    assertLinuxManagedPath(path, uid, 'directory');
    if (stat(path) && (stat(path)!.mode & 0o077) !== 0) throw new Error(`${path} must be a private Olympus directory (0700).`);
  }
  if (!layout.runtimeHome) throw new Error('XDG_RUNTIME_DIR from a working systemd user session is required; no temporary-directory fallback is allowed.');
  assertLinuxManagedPath(layout.runtimeHome, uid, 'directory');
  const runtime = stat(layout.runtimeHome);
  if (!runtime || (runtime.mode & 0o077) !== 0) throw new Error(`${layout.runtimeHome} must be an existing private runtime directory (0700).`);
  assertLinuxManagedPath(layout.runtimeDir, uid, 'directory');
  for (const path of [layout.unitPath, layout.configPath, layout.sovereigntyPath, layout.workerEnvPath, layout.receiptPath, layout.secretsPath, layout.secretsKeyPath]) assertLinuxManagedPath(path, uid);
  if (options.fresh !== false) {
    const owned = readLinuxEngineReceipt(layout.receiptPath, uid);
    const candidates = [join(layout.home, '.olympus'), join(layout.home, '.config/olympus'), join(layout.home, '.local/share/openclaw/olympus'),
      join(layout.home, '.local/share/olympus/engine'), layout.configDir, layout.dataDir, layout.packageDir, layout.stateDir, layout.unitPath, join(layout.home, '.config/systemd/user/olympus-engine.service'),
      join(layout.home, '.config/systemd/user/olympus-worker.service'), join(layout.configHome, 'systemd/user/olympus-worker.service')];
    const managed = new Set([layout.configDir, layout.dataDir, layout.packageDir, layout.stateDir, layout.unitPath]);
    const ownedRegistration = (p: string): boolean => {
      if (!owned || p !== join(layout.home, '.config/systemd/user/olympus-engine.service')) return false;
      const info = stat(p);
      if (!info?.isSymbolicLink() || info.uid !== uid) return false;
      try { assertLinuxManagedPath(dirname(p), uid, 'directory'); return realpathSync(p) === layout.unitPath; } catch { return false; }
    };
    const conflicts = [...new Set(candidates)].filter(p => stat(p) && !(owned && managed.has(p)) && !ownedRegistration(p));
    if (conflicts.length) throw new Error(`Existing Olympus data or competing custodian: ${conflicts.join(', ')}. Keep using the existing installation, or stop its custodian and explicitly back up and move the listed Olympus-owned data aside before retrying a fresh install. Nothing was changed.`);
  }
}
/** Creates only missing directories; existing shared parents retain their modes. */
export function createLinuxPrivateDirectory(path: string): void {
  if (stat(path)) { assertLinuxManagedPath(path, process.getuid!(), 'directory'); return; }
  const parent = dirname(path); if (!stat(parent)) createLinuxPrivateDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
}
export function publishLinuxEngineReceipt(layout: LinuxEngineLayout, updates: Partial<Pick<LinuxEngineReceipt, 'ownedUnitLinks' | 'lingerPredated'>> = {}): LinuxEngineReceipt {
  preflightLinuxEngineLayout(layout);
  const previous = readLinuxEngineReceipt(layout.receiptPath);
  createLinuxPrivateDirectory(layout.configDir);
  const receipt: LinuxEngineReceipt = { schema: 'olympus.engine.install.v1', uid: process.getuid!(), layout, ownedUnitLinks: [],
    rotation: { mechanism: 'host-copytruncate', maxBytes: 10 * 1024 * 1024, retained: 3 }, ...previous, ...updates };
  writePrivateFileAtomicSync(layout.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}
