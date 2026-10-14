import { readOpenClawPluginRemote } from './config.ts';
import { linuxDesktopEntryPaths } from './linux-desktop-entry.ts';
/** One Linux layout shared by installers, services and consumers. No OpenClaw dependency. */
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';

type Env = Record<string, string | undefined>;
export interface LinuxEngineLayout {
  home: string; configHome: string; dataHome: string; stateHome: string; cacheHome: string;
  runtimeHome: string; configDir: string; dataDir: string; stateDir: string; cacheDir: string;
  runtimeDir: string; packageDir: string; unitPath: string; configPath: string; sovereigntyPath: string;
  workerEnvPath: string; workerSocketPath: string; receiptPath: string; lifecycleLockPath: string; launcherPath: string;
  openHandlerPath: string; mimeappsPath: string; secretsPath: string; secretsKeyPath: string;
}
export interface LinuxMachineArtifact {
  path: string;
  kind: 'file' | 'symlink' | 'tree';
  sha256: string;
  rootDevice?: number;
  rootInode?: number;
  markerPath?: string;
  markerSha256?: string;
}
export interface LinuxEngineReceipt {
  schema: 'olympus.engine.install.v1'; uid: number; layout: LinuxEngineLayout;
  installationState: 'installed' | 'recovery_pending' | 'data_retained';
  ownedUnitLinks: string[]; lingerPredated?: boolean;
  machineArtifacts: LinuxMachineArtifact[];
  /** Only parents created by this installer; old receipts confer no cleanup authority. */
  ownedEmptyParents?: Array<{ path: string; device: number; inode: number }>;
  mimeOwnership?: { path: string; scheme: 'x-scheme-handler/olympus'; desktopId: 'ai.olympusplugin.open.desktop' };
  openHandlerPending?: boolean;
  rotation: { mechanism: 'host-copytruncate'; maxBytes: number; retained: number };
}
function absolute(value: string, name: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path without control characters.`);
  return resolve(value);
}
function rawLayout(env: Env, recordedDataDir?: string): LinuxEngineLayout {
  const home = absolute(env.HOME || homedir(), 'HOME');
  const root = (key: string, fallback: string) => absolute(env[key] || join(home, fallback), key);
  const configHome = root('XDG_CONFIG_HOME', '.config'); const dataHome = root('XDG_DATA_HOME', '.local/share');
  const stateHome = root('XDG_STATE_HOME', '.local/state'); const cacheHome = root('XDG_CACHE_HOME', '.cache');
  const runtimeHome = env.XDG_RUNTIME_DIR ? absolute(env.XDG_RUNTIME_DIR, 'XDG_RUNTIME_DIR') : '';
  const configDir = join(configHome, 'olympus'); const runtimeDir = runtimeHome ? join(runtimeHome, 'olympus') : '';
  const xdgDataDir = join(dataHome, 'olympus');
  const legacyDirs = [...new Set([join(dataHome, 'openclaw/olympus'), join(home, '.local/share/openclaw/olympus')])];
  // Receipts remain authoritative even after keep-data, partial purge or shell drift.
  // Never move an existing database tree during startup or upgrade.
  if (recordedDataDir && ![xdgDataDir, ...legacyDirs].includes(recordedDataDir)) throw new Error('Invalid Linux data root in install receipt.');
  const hasData = (path: string) => {
    const info = stat(path);
    if (!info) return false;
    // A non-directory or symlink is not absence; the managed-path preflight refuses it.
    return !info.isDirectory() || info.isSymbolicLink() || readdirSync(path).some(name => path !== xdgDataDir || name !== 'engine');
  };
  const dataDir = recordedDataDir ?? (hasData(xdgDataDir) ? xdgDataDir : legacyDirs.find(hasData) ?? xdgDataDir);
  const stateDir = join(stateHome, 'olympus/engine'), cacheDir = join(cacheHome, 'olympus/engine');
  // New installs keep executable generations outside the purgeable user-data tree.
  // Legacy receipts retain their original package directory byte for byte.
  const packageDir = dataDir === xdgDataDir ? join(dataHome, 'olympus-engine') : join(dataHome, 'olympus/engine');
  const managedRoots=[configDir,dataDir,stateDir,cacheDir,packageDir];
  for(let i=0;i<managedRoots.length;i+=1)for(let j=i+1;j<managedRoots.length;j+=1){const forward=relative(managedRoots[i]!,managedRoots[j]!),reverse=relative(managedRoots[j]!,managedRoots[i]!);
   if(forward===''||(!forward.startsWith(`..${sep}`)&&forward!=='..'&&!isAbsolute(forward))||(!reverse.startsWith(`..${sep}`)&&reverse!=='..'&&!isAbsolute(reverse)))throw new Error(`Linux Olympus managed roots must not overlap: ${managedRoots[i]} and ${managedRoots[j]}.`);}
  return { home, configHome, dataHome, stateHome, cacheHome, runtimeHome, configDir,
    dataDir, stateDir, cacheDir, runtimeDir,
    packageDir, unitPath: join(configHome, 'systemd/user/olympus-engine.service'),
    configPath: join(configDir, 'engine.json'), sovereigntyPath: join(configDir, 'sovereignty.json'), workerEnvPath: join(configDir, 'worker.env'),
    workerSocketPath: runtimeDir ? join(runtimeDir, 'worker.sock') : '', lifecycleLockPath: runtimeDir ? join(runtimeDir, 'lifecycle.lock') : '',
    launcherPath: join(home, '.local/bin/olympus'), openHandlerPath:join(dataHome,'applications/ai.olympusplugin.open.desktop'),mimeappsPath:join(configHome,'mimeapps.list'),
    receiptPath: join(configDir, 'install-receipt.json'), secretsPath: join(configDir, 'secrets.enc'), secretsKeyPath: join(configDir, 'secrets.key') };
}
function stat(path: string) { try { return lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } }
export function linuxEngineLayoutsEqual(left:unknown,right:LinuxEngineLayout):left is LinuxEngineLayout{
 if(!left||typeof left!=='object'||Array.isArray(left))return false;const record=left as Record<string,unknown>,expected=right as unknown as Record<string,unknown>;
 const keys=Object.keys(record).sort(),expectedKeys=Object.keys(expected).sort();return keys.length===expectedKeys.length&&keys.every((key,index)=>key===expectedKeys[index]&&record[key]===expected[key]);
}
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
  if(!['installed','recovery_pending','data_retained'].includes(receipt.installationState))throw new Error(`${path} has an invalid installation state.`);
  const l = receipt.layout;
  const expected = rawLayout({ HOME: l.home, XDG_CONFIG_HOME: l.configHome, XDG_DATA_HOME: l.dataHome, XDG_STATE_HOME: l.stateHome, XDG_CACHE_HOME: l.cacheHome, XDG_RUNTIME_DIR: l.runtimeHome }, l.dataDir);
  if (!linuxEngineLayoutsEqual(l,expected) || l.receiptPath !== path) throw new Error(`${path} has an inconsistent install layout.`);
  const parentPaths = new Set([dirname(l.stateDir), dirname(l.cacheDir)]);
  if (receipt.ownedEmptyParents !== undefined && (!Array.isArray(receipt.ownedEmptyParents)
    || new Set(receipt.ownedEmptyParents.map(entry => entry?.path)).size !== receipt.ownedEmptyParents.length
    || receipt.ownedEmptyParents.some(entry => !entry || !parentPaths.has(entry.path)
      || !Number.isSafeInteger(entry.device) || entry.device < 0 || !Number.isSafeInteger(entry.inode) || entry.inode <= 0))) {
    throw new Error(`${path} has invalid empty-directory ownership.`);
  }
  const allowedLinkParents=new Set([join(l.configHome,'systemd/user'),join(l.home,'.config/systemd/user')]);
  if (!Array.isArray(receipt.ownedUnitLinks) || receipt.ownedUnitLinks.some(p => typeof p !== 'string' || !isAbsolute(p)
    || p===l.unitPath||!allowedLinkParents.has(dirname(p))||!p.endsWith('/olympus-engine.service'))) throw new Error(`${path} has invalid unit links.`);
  if (!Array.isArray(receipt.machineArtifacts)
    || receipt.machineArtifacts.some((entry) => !entry || typeof entry.path !== 'string' || !isAbsolute(entry.path)
      || !['file', 'symlink', 'tree'].includes(entry.kind) || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || (entry.kind==='tree'&&(!Number.isSafeInteger(entry.rootDevice)||entry.rootDevice!<0||!Number.isSafeInteger(entry.rootInode)||entry.rootInode!<=0
        ||entry.markerPath!==join(entry.path,'.olympus-generation.json')||!/^[0-9a-f]{64}$/.test(entry.markerSha256??'')))
      ||(entry.kind!=='tree'&&(entry.rootDevice!==undefined||entry.rootInode!==undefined||entry.markerPath!==undefined||entry.markerSha256!==undefined)))) {
    throw new Error(`${path} has invalid machine artifacts.`);
  }
  if(receipt.mimeOwnership&&(receipt.mimeOwnership.path!==l.mimeappsPath||receipt.mimeOwnership.scheme!=='x-scheme-handler/olympus'||receipt.mimeOwnership.desktopId!=='ai.olympusplugin.open.desktop'))throw new Error(`${path} has invalid MIME ownership.`);
  if(receipt.openHandlerPending!==undefined&&typeof receipt.openHandlerPending!=='boolean')throw new Error(`${path} has invalid open-handler transaction state.`);
  const fileArtifacts=new Set([...Object.values(linuxDesktopEntryPaths(l)),l.unitPath,l.launcherPath,l.openHandlerPath,join(l.stateDir,'service-current.json'),join(l.stateDir,'service-previous.json'),join(l.stateDir,'install-transaction.json')]);
  const unitLinks=new Set(receipt.ownedUnitLinks);
  const artifactPaths=new Set<string>();
  for(const artifact of receipt.machineArtifacts){
    if(artifactPaths.has(artifact.path))throw new Error(`${path} has duplicate machine artifacts.`);artifactPaths.add(artifact.path);
    const valid=artifact.kind==='file'?fileArtifacts.has(artifact.path)
      :artifact.kind==='symlink'?unitLinks.has(artifact.path)&&artifact.path.endsWith('/olympus-engine.service')
      :dirname(artifact.path)===join(l.packageDir,'generations')&&artifact.sha256===artifact.path.slice(artifact.path.lastIndexOf('/')+1);
    if(!valid)throw new Error(`${path} has a machine artifact outside the install contract.`);
  }
  if(receipt.installationState!=='installed'&&(receipt.machineArtifacts.length!==0||receipt.ownedUnitLinks.length!==0||receipt.mimeOwnership||receipt.openHandlerPending))throw new Error(`${path} has machinery in a non-installed receipt.`);
  if(receipt.installationState==='recovery_pending'&&typeof receipt.lingerPredated!=='boolean')throw new Error(`${path} recovery receipt has no original linger state.`);
  return receipt;
}
/** Discover the default and explicitly selected config root; receipt roots win over shell drift. */
export function resolveLinuxEngineLayout(env: Env = process.env): LinuxEngineLayout {
  const home = absolute(env.HOME || homedir(), 'HOME');
  const configHome = absolute(env.XDG_CONFIG_HOME || join(home, '.config'), 'XDG_CONFIG_HOME');
  const candidates = [...new Set([join(home, '.config/olympus/install-receipt.json'), join(configHome, 'olympus/install-receipt.json')])];
  const present = candidates.filter(p => stat(p));
  if (present.length > 1) throw new Error(`Found multiple Olympus install receipts: ${present.join(', ')}. Select one installation after moving the other aside.`);
  const receipt = present[0] ? readLinuxEngineReceipt(present[0]) : undefined;
  if (receipt && receipt.layout.home !== home) throw new Error(`${present[0]} belongs to another home.`);
  return receipt?.layout ?? rawLayout(env);
}
export function linuxEngineEnvironment(layout: LinuxEngineLayout): Record<string, string> {
  return { HOME: layout.home, XDG_CONFIG_HOME: layout.configHome, XDG_DATA_HOME: layout.dataHome, XDG_STATE_HOME: layout.stateHome,
    XDG_CACHE_HOME: layout.cacheHome, XDG_RUNTIME_DIR: layout.runtimeHome, OLYMPUS_SOVEREIGNTY_CONFIG: layout.sovereigntyPath };
}
export const LEGACY_LINUX_POLICY_FILES = ['privacy.json', 'tier-rules.json', 'consult.json',
  'sources/dropbox.personal.ingestion.json', 'sources/ingestion-exclusions.json'] as const;
/** Files the pre-XDG Linux writers could create. Never adopt an arbitrary tree. */
export function isLegacyLinuxSetting(name: string): boolean {
  const temporary = name.match(/^(.*)[.][0-9a-f-]{36}[.]tmp$/);
  if (temporary) return isLegacyLinuxSetting(temporary[1]!);
  return ['privacy.json', 'tier-rules.json', 'consult.json', 'consult.json.lock', 'consult.json.lock.commit', 'sovereignty.json',
    'sources/dropbox.personal.ingestion.json', 'sources/ingestion-exclusions.json',
    'consult/vocabulary/manifest.json', 'consult/vocabulary/de-hunspell.txt.gz', 'consult/vocabulary/it-hunspell.txt.gz'].includes(name)
    || /^consult\/vocabulary\/[a-z]{2}(?:[.]txt[.]gz|[.]LICENSE[.]txt)$/.test(name)
    || /^pending-oauth\/[a-zA-Z0-9_-]+[.][a-zA-Z0-9_.-]+[.]json(?:[.]request[.][0-9]+[.][0-9]+[.]json)?$/.test(name)
    || /^logs\/[a-zA-Z0-9_-]+[.][a-zA-Z0-9_.:-]+[.][0-9TZ-]+[.]log$/.test(name);
}
export const LEGACY_LINUX_SETTINGS_DIRECTORIES = ['sources', 'consult', 'consult/vocabulary', 'pending-oauth', 'logs'] as const;
/** Read-only inventory. Receipt custody is required even for an empty legacy directory. */
export function legacyLinuxSettings(layout: LinuxEngineLayout): string[] {
  const root = join(layout.home, '.olympus');
  if (!stat(root)) return [];
  const receipt = readLinuxEngineReceipt(layout.receiptPath);
  if (receipt?.installationState !== 'installed' || !linuxEngineLayoutsEqual(receipt.layout, layout)) {
    throw new Error(`Existing Olympus data or competing custodian: ${root}. Explicitly back up and move it before a fresh install. Nothing was changed.`);
  }
  const files: string[] = [];
  const visit = (directory: string) => {
    const path = join(root, directory); assertLinuxManagedPath(path, process.getuid!(), 'directory');
    if ((lstatSync(path).mode & 0o077) !== 0) throw new Error(`${path} must be private (0700).`);
    for (const entry of readdirSync(path).sort()) {
      const name = directory ? `${directory}/${entry}` : entry;
      const child = join(root, name), info = lstatSync(child);
      if (info.isDirectory() && (LEGACY_LINUX_SETTINGS_DIRECTORIES as readonly string[]).includes(name)) visit(name);
      else {
        if (!isLegacyLinuxSetting(name)) throw new Error(`Unrecognized legacy Olympus data: ${child}. Nothing was changed.`);
        assertLinuxManagedPath(child);
        if (info.nlink !== 1) throw new Error(`${child} must be singly linked.`);
        files.push(name);
      }
    }
  };
  visit(''); return files;
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
  for (const path of [layout.unitPath, layout.launcherPath, layout.openHandlerPath, layout.configPath, layout.sovereigntyPath, layout.workerEnvPath, layout.receiptPath, layout.secretsPath, layout.secretsKeyPath]) assertLinuxManagedPath(path, uid);
  if (options.fresh !== false) {
    const owned = readLinuxEngineReceipt(layout.receiptPath, uid);
    if(owned?.installationState==='data_retained')throw new Error(`Olympus data was retained after uninstall at ${layout.configDir}. Run the Linux uninstaller with --purge --yes to remove it, or back up and move the retained Olympus data before a fresh install. Nothing was changed.`);
    const candidates = [join(layout.home, '.olympus'), join(layout.home, '.config/olympus'), join(layout.home, '.local/share/openclaw/olympus'),
      join(layout.home, '.local/share/olympus/engine'), layout.configDir, layout.dataDir, layout.packageDir, layout.stateDir, layout.unitPath, join(layout.home, '.config/systemd/user/olympus-engine.service'),
      layout.launcherPath,
      layout.openHandlerPath,
      join(layout.home, '.config/systemd/user/olympus-worker.service'), join(layout.configHome, 'systemd/user/olympus-worker.service')];
    const managed = new Set([layout.configDir, layout.dataDir, layout.packageDir, layout.stateDir, layout.unitPath, layout.launcherPath, layout.openHandlerPath]);
    // The engine writes its status under its own XDG data root (dataDir/engine).
    // Once the receipt owns that root, the subdirectory is ours, not a legacy
    // package directory, so a re-check during the install transaction must not
    // refuse the engine it just started.
    if (layout.dataDir === join(layout.dataHome, 'olympus')) managed.add(join(layout.dataDir, 'engine'));
    const recoverableEmptyDirectory = (p: string): boolean => {
      const info=stat(p);
      return managed.has(p)&&Boolean(info?.isDirectory()&&info.uid===uid&&(info.mode&0o077)===0&&readdirSync(p).length===0);
    };
    const ownedRegistration = (p: string): boolean => {
      if (!owned || p !== join(layout.home, '.config/systemd/user/olympus-engine.service')) return false;
      const info = stat(p);
      if (!info?.isSymbolicLink() || info.uid !== uid) return false;
      try { assertLinuxManagedPath(dirname(p), uid, 'directory'); return realpathSync(p) === layout.unitPath; } catch { return false; }
    };
    if (owned && stat(join(layout.home, '.olympus'))) { legacyLinuxSettings(layout); managed.add(join(layout.home, '.olympus')); }
    const conflicts = [...new Set(candidates)].filter(p => stat(p) && !(owned && managed.has(p)) && !ownedRegistration(p) && !recoverableEmptyDirectory(p));
    if (conflicts.length) throw new Error(`Existing Olympus data or competing custodian: ${conflicts.join(', ')}. Keep using the existing installation, or stop its custodian and explicitly back up and move the listed Olympus-owned data aside before retrying a fresh install. Nothing was changed.`);
  }
}
/** Creates only missing directories; existing shared parents retain their modes. */
export function createLinuxPrivateDirectory(path: string): void {
  if (stat(path)) { assertLinuxManagedPath(path, process.getuid!(), 'directory'); return; }
  const parent = dirname(path); if (!stat(parent)) createLinuxPrivateDirectory(parent);
  mkdirSync(path, { mode: 0o700 });
}
export function publishLinuxEngineReceipt(layout: LinuxEngineLayout, updates: Partial<Pick<LinuxEngineReceipt, 'installationState' | 'ownedUnitLinks' | 'lingerPredated' | 'machineArtifacts' | 'ownedEmptyParents' | 'mimeOwnership' | 'openHandlerPending'>> = {}): LinuxEngineReceipt {
  preflightLinuxEngineLayout(layout);
  const previous = readLinuxEngineReceipt(layout.receiptPath);
  createLinuxPrivateDirectory(layout.configDir);
  const receipt: LinuxEngineReceipt = { schema: 'olympus.engine.install.v1', uid: process.getuid!(), layout, installationState: 'installed', ownedUnitLinks: [], machineArtifacts: [],
    rotation: { mechanism: 'host-copytruncate', maxBytes: 10 * 1024 * 1024, retained: 3 }, ...previous, ...updates };
  writePrivateFileAtomicSync(layout.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Only standalone Linux processes/receipts opt into the new data root.
 * OpenClaw-hosted and Mac callers keep their existing defaults.
 */
export function standaloneLinuxDataDir(env: Env = process.env): string | undefined {
  if (process.platform !== 'linux') return undefined;
  // The installed CLI and daemon select the receipt before consulting any
  // unrelated (including unreadable) OpenClaw config in the same home.
  if (env.OLYMPUS_STANDALONE === '1' || env.OLYMPUS_ENGINE_HOST === '1') return resolveLinuxEngineLayout(env).dataDir;
  if (env.OPENCLAW_STATE_DIR || env.OPENCLAW_CONFIG_PATH || readOpenClawPluginRemote(env).hosted) return undefined;
  const layout = resolveLinuxEngineLayout(env);
  if (readLinuxEngineReceipt(layout.receiptPath)) return layout.dataDir;
  return undefined;
}
