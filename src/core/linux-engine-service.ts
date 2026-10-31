import { FileLeaseBusyError, isFileLeaseSidecarName, parseProcessInstanceIdentity, recordedProcessOwnerIsAlive, withFileLeaseSync } from './file-lease.ts';
import { environmentWithWorkerSetupEnv } from './worker-auth.ts';
import { linuxDesktopEntryPaths, assertLinuxDesktopEntryOwnership, preflightLinuxDesktopEntry, writeLinuxDesktopEntry, removeLinuxDesktopEntry, refreshLinuxDesktopCaches, LINUX_APP_ICON } from './linux-desktop-entry.ts';
/** systemd user-manager mechanics. Shared config and health stay in engine-service. */
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { userInfo } from 'node:os';
import { legacyLinuxManifestTemporaryPid, assertLinuxManagedPath, type LinuxEngineLayout, type LinuxMachineArtifact } from './linux-engine-layout.ts';
import type { EngineExec, EngineProgram } from './engine-service.ts';
export const SYSTEMD_ENGINE_UNIT = 'olympus-engine.service';
export function linuxEngineExec(command: string, args: string[]) {
 const r = spawnSync(command, args, { encoding: 'utf8', timeout: 35_000, env: { ...process.env, SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' } });
 return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? r.error?.message ?? '' };
}
function value(s: string, exec = false): string {
 if (/[\x00-\x1f\x7f]/.test(s)) throw new Error('A systemd value contains control characters.');
 return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, exec ? '$$$$' : '$');
}
/** Unquoted path settings (WorkingDirectory=, StandardOutput=append:) take no quoting or escapes: refuse what they cannot carry. */
function pathValue(s: string): string {
 if (/[\x00-\x1f\x7f"\\]/.test(s) || s !== s.trim() || !s.startsWith('/')) throw new Error('A systemd path setting needs an absolute path without quotes, backslashes, control characters or surrounding spaces.');
 return s.replace(/%/g, '%%');
}
export function renderEngineSystemdUnit(l: LinuxEngineLayout, p: EngineProgram): string {
 const env = { HOME: l.home, PATH: `${dirname(p.runtimePath)}:/usr/bin:/bin`, OLYMPUS_ENGINE_HOST: '1', OLYMPUS_ENGINE_BUILD: p.build ?? '',
 XDG_CONFIG_HOME: l.configHome, XDG_DATA_HOME: l.dataHome, XDG_STATE_HOME: l.stateHome, XDG_CACHE_HOME: l.cacheHome, XDG_RUNTIME_DIR: l.runtimeHome,
 OLYMPUS_SOVEREIGNTY_CONFIG: l.sovereigntyPath };
 return `[Unit]\nDescription=Olympus standalone engine\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nExecStart="${value(p.runtimePath,true)}" --no-env-file "${value(p.entryPath,true)}" __engine-run\nWorkingDirectory=${pathValue(p.workingDirectory)}\nEnvironment=${Object.entries(env).map(([k,v]) => `"${k}=${value(v)}"`).join(' ')}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nRestartSteps=5\nRestartMaxDelaySec=300\nRestartPreventExitStatus=78\nKillMode=mixed\nTimeoutStopSec=30\nSendSIGKILL=yes\nStandardOutput=append:${pathValue(join(l.stateDir,'engine.log'))}\nStandardError=append:${pathValue(join(l.stateDir,'engine.err'))}\n\n[Install]\nWantedBy=default.target\n`;
}
export interface SystemdEngineFacts {
 state: 'running' | 'loaded' | 'not_loaded' | 'unknown'; enabled: boolean | null; enabled_runtime?: boolean; active: boolean | null; failed: boolean | null;
 pid: number | null; last_exit_code: number | null; control_group: string | null; result: string | null; fragment_path: string | null; detail: string;
}
export function inspectSystemdEngine(l: LinuxEngineLayout, exec: EngineExec = linuxEngineExec): SystemdEngineFacts {
 const unknown: SystemdEngineFacts = { state: 'unknown', enabled: null, active: null, failed: null, pid: null, last_exit_code: null, control_group: null, result: null, fragment_path: null, detail: 'The systemd user manager is unreachable; custody is unknown. Restore the user session and retry.' };
 const r = exec('systemctl', ['--user','show',SYSTEMD_ENGINE_UNIT,'--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ControlGroup,Result,ExecMainStatus,FragmentPath']);
 if (r.status !== 0) return unknown;
 const f = Object.fromEntries(r.stdout.trim().split('\n').map(line => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
 if (f.LoadState === 'not-found') return { ...unknown, state: 'not_loaded', enabled: false, active: false, failed: false, detail: 'The engine is not installed; run olympus engine install.' };
 if (f.LoadState !== 'loaded' || !f.ActiveState || !f.UnitFileState || !/^\d+$/.test(f.MainPID ?? '')) return unknown;
 if (f.FragmentPath !== l.unitPath) {
   try { if (!f.FragmentPath || realpathSync(f.FragmentPath) !== l.unitPath) return { ...unknown, detail: `Conflicting unit fragment ${f.FragmentPath || '(unknown)'}; expected ${l.unitPath}. Stop its custodian before retrying.` }; }
   catch { return { ...unknown, detail: `Cannot verify unit fragment ${f.FragmentPath || '(unknown)'}; expected ${l.unitPath}.` }; }
 }
 const active = f.ActiveState === 'active'; const failed = f.ActiveState === 'failed'; const pid = Number(f.MainPID) || null;
 const code = /^\d+$/.test(f.ExecMainStatus ?? '') ? Number(f.ExecMainStatus) : null;
 return { state: active && pid ? 'running' : ['inactive','failed'].includes(f.ActiveState) ? (failed ? 'loaded' : 'not_loaded') : 'loaded',
 enabled: ['enabled','enabled-runtime'].includes(f.UnitFileState) ? true : ['disabled','linked','linked-runtime'].includes(f.UnitFileState) ? false : null,
 enabled_runtime: f.UnitFileState === 'enabled-runtime',
 active, failed, pid, last_exit_code: code, control_group: f.ControlGroup || null, result: f.Result || null, fragment_path: f.FragmentPath || null,
 detail: code === 78 ? 'Configuration failed (exit 78). Repair engine.json, then run systemctl --user reset-failed olympus-engine.service followed by olympus engine start.'
 : f.Result === 'start-limit-hit' ? 'Start limit reached; repair the unit and run systemctl --user reset-failed olympus-engine.service, then olympus engine start.'
 : active ? `Running (pid ${pid ?? 'unknown'}); application health still needs verification.` : `Engine ${f.ActiveState}; transient failures retry with bounded backoff. See olympus engine logs.` };
}
export function readEngineLinger(exec: EngineExec = linuxEngineExec, uid = process.getuid!()): boolean | undefined {
 const r = exec('loginctl',['show-user',String(uid),'--property=Linger','--value']);
 return r.status === 0 && ['yes','no'].includes(r.stdout.trim()) ? r.stdout.trim() === 'yes' : undefined;
}
export function ensureEngineLinger(exec: EngineExec = linuxEngineExec, uid = process.getuid!(), user = userInfo().username, notice: (s:string)=>void = s => console.error(s)): { predated: boolean } {
 const before = readEngineLinger(exec,uid);
 if (before === undefined) throw new Error('Olympus requires systemd-logind and a working user session. Linger could not be inspected; nothing was installed or upgraded.');
 if (before) return { predated: true };
 notice('Olympus will enable account-wide linger to keep your user services running after logout and start them before login.');
 exec('loginctl',['--no-ask-password','enable-linger',user]);
 const after = readEngineLinger(exec,uid);
 if (after === undefined) throw new Error('Olympus requires systemd-logind and a working user session. Linger could not be verified; nothing was installed or upgraded.');
 if (!after) throw new Error(`Olympus needs permission to keep running after you log out and to start before you log in. This account cannot enable that permission without an administrator. Ask an administrator to run: \`sudo loginctl enable-linger '${user.replace(/'/g, `'\\''`)}'\`. Then run the installer again. Olympus was not installed or upgraded; an existing installation was left running.`);
 return { predated: false };
}
export function preflightSystemdEngine(l: LinuxEngineLayout, exec: EngineExec = linuxEngineExec, uid = process.getuid!()): void {
 if (uid === 0) throw new Error('Olympus refuses root installs. Use an ordinary account and its systemd user manager.');
 const v = exec('systemctl',['--version']);
 if (v.status !== 0 || Number(/^systemd (\d+)/.exec(v.stdout)?.[1] ?? 0) < 254) throw new Error('Olympus requires systemd 254 or newer for bounded restart backoff. Upgrade systemd using your distribution package manager, then retry. Nothing was changed.');
 const manager = exec('systemctl',['--user','show','--property=Version','--value']);
 if (manager.status !== 0 || Number(/^(\d+)/.exec(manager.stdout.trim())?.[1] ?? 0) < 254) throw new Error('A reachable systemd 254+ user manager is required. Log in as this user and retry; no fake bus or temporary runtime directory is supported.');
 const competing = exec('systemctl',['--user','show','olympus-worker.service','--property=LoadState,ActiveState,FragmentPath']);
 if (competing.status !== 0) throw new Error('Cannot inspect the competing olympus-worker.service; custody is unknown.');
 if (!competing.stdout.includes('LoadState=not-found')) throw new Error(`Competing olympus-worker.service: ${competing.stdout.trim()}. Stop its custodian and back up and move its Olympus-owned data aside before a fresh install.`);
}
/** Copies bounded retained generations, then truncates the inode systemd already has open. */
export function rotateEngineLog(path: string, maxBytes = 10 * 1024 * 1024, retained = 3): void {
 assertLinuxManagedPath(path);
 if (!existsSync(path)) return;
 const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
 try {
  const info = fstatSync(fd); if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error(`${path} is not a private, singly-linked log.`);
  if (info.size < maxBytes) return;
  for (let i=retained;i>=1;i--) { const dest=`${path}.${i}`; assertLinuxManagedPath(dest); if(i===retained) rmSync(dest,{force:true}); else if(existsSync(dest)) renameSync(dest,`${path}.${i+1}`); }
  copyFileSync(path,`${path}.1`,constants.COPYFILE_EXCL); ftruncateSync(fd,0);
 } finally { closeSync(fd); }
}
/** Includes descendants via cgroup.events; a missing group requires a visible v2 user hierarchy. */
export function systemdCgroupEmpty(group: string, root = '/sys/fs/cgroup'): boolean | undefined {
 if (!group.startsWith('/user.slice/') || group.split('/').includes('..')) return undefined;
 try { return /^populated 0$/m.test(readFileSync(join(root,group,'cgroup.events'),'utf8')); }
 catch(e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  const uid = process.getuid?.();
  if (uid === undefined || !group.startsWith(`/user.slice/user-${uid}.slice/user@${uid}.service/`)) return undefined;
  try { readFileSync(join(root,'cgroup.controllers')); statSync(dirname(join(root,group))); } catch { return undefined; }
  try { statSync(join(root,group)); return undefined; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? true : undefined; }
 }
}
/** Wait briefly for systemd and the kernel to finish removing a stopped cgroup. */
function waitForEmptyCgroup(group: string, options: EngineServiceOptions): boolean {
 const inspect = options.cgroupEmpty ?? systemdCgroupEmpty;
 const sleep = options.sleepMs ?? ((ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); });
 for (let waited = 0; ; waited += 100) {
  const empty = inspect(group);
  if (empty === true) return true;
  if (empty === undefined || waited >= 2000) return false;
  sleep(100);
 }
}
function releasedCgroups(before: SystemdEngineFacts, after: SystemdEngineFacts, options: EngineServiceOptions): boolean {
 return [...new Set([before.control_group, after.control_group].filter((group): group is string => !!group))]
  .every(group => waitForEmptyCgroup(group, options));
}
export function systemdPidInCgroup(pid: number, group: string): boolean {
 try { return readFileSync(`/proc/${pid}/cgroup`,'utf8').split('\n').some(line => line === `0::${group}`); } catch { return false; }
}
export function systemdMust(exec: EngineExec, args: string[]): string {
 const r=exec('systemctl',['--user',...args]); if(r.status!==0) throw new Error(`systemctl --user ${args[0]} failed: ${(r.stderr || r.stdout || 'user manager unavailable').trim().slice(0,300)}`); return `${r.stdout}\n${r.stderr}`;
}

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { writePrivateFileAtomicSync, removeFileDurablySync, syncDirectorySync } from './atomic-file.ts';
import { createLinuxPrivateDirectory, legacyLinuxSettings, isLegacyLinuxSetting, LEGACY_LINUX_SETTINGS_DIRECTORIES, LEGACY_LINUX_POLICY_FILES, linuxEngineEnvironment, linuxEngineLayoutsEqual, preflightLinuxEngineLayout, publishLinuxEngineReceipt, readLinuxEngineReceipt, resolveLinuxEngineLayout } from './linux-engine-layout.ts';
import { resolveInstallationPrivacyState, engineBuildIdentity, engineServicePaths, reconcileEngineConfig, seedEngineSovereignty, resolveEngineProgram, waitForQuietEngine, waitForEngineHealthy,
 type EngineInstallOptions, type EngineInstallResult, type EngineServiceOptions, type EngineHealthDeps, type EngineHealthProof, type EngineLifecycleCheckpoint, type EngineRollbackResult } from './engine-service.ts';
import { reapRecordedEngineChildren, readEngineChildren, parseProcessTable } from './engine-children.ts';
import type { EngineChildReapDeps } from './engine-children.ts';
import { selectLinuxSecretBackend } from './linux-secret-backend.ts';
import { removeReleasedWorkerSocket as removeReleasedWorkerSocketPath, workerSocketListenerStopped } from './worker-transport.ts';

const runtimeRequire = createRequire(import.meta.url);
const heldLifecycleLocks = new Set<string>();
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const F_SETFD = 2;
const FD_CLOEXEC = 1;
function lifecycleCheckpoint(options:EngineServiceOptions,name:EngineLifecycleCheckpoint):void{options.lifecycleCheckpoint?.(name);}
export function linuxLayoutFor(options: EngineServiceOptions): LinuxEngineLayout {
 return resolveLinuxEngineLayout({ ...(options.env ?? process.env), HOME: options.homeDir ?? options.env?.HOME ?? process.env.HOME });
}

type FlockSymbols = {
  flock(fd: number, operation: number): number;
  fcntl(fd: number, command: number, value: number): number;
};
let flockSymbols: FlockSymbols | undefined;
function kernelFlock(): FlockSymbols {
 if (flockSymbols) return flockSymbols;
 const { dlopen, FFIType } = runtimeRequire('bun:ffi') as typeof import('bun:ffi');
 const libc = ['/usr/lib/libc.so.6', '/lib/x86_64-linux-gnu/libc.so.6', '/lib64/libc.so.6'].find(existsSync) ?? 'libc.so.6';
 const library = dlopen(libc, {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
 });
 flockSymbols = library.symbols as unknown as FlockSymbols;
 return flockSymbols;
}

function processParent(pid: number): number | undefined {
 try {
  const value = /^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
  return value ? Number(value) : undefined;
 } catch { return undefined; }
}

/**
 * The bootstrap owns the same kernel lock in a util-linux flock ancestor and
 * deliberately closes its descriptor in the child. Recognize only that real
 * process/argument chain; an environment marker is never lock custody.
 */
function inheritedUtilLinuxFlock(lockPath: string): boolean {
 let pid = process.ppid;
 for (let depth = 0; pid > 1 && depth < 16; depth += 1) {
  try {
   const executable = realpathSync(`/proc/${pid}/exe`);
   const executableStat = statSync(executable);
   const args = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
   if (basename(executable) === 'flock' && executableStat.uid === 0 && (executableStat.mode & 0o022) === 0
     && args.slice(1).some((arg) => arg.startsWith('/') && resolve(arg) === lockPath)) return true;
  } catch {
   // Keep walking: an intermediate shell may already have exited or be hidden.
  }
  const parent = processParent(pid);
  if (!parent || parent === pid) break;
  pid = parent;
 }
 return false;
}
function inheritedLockDescriptor(lockPath:string,exclude:number):number|undefined{
 const target=lstatSync(lockPath);
 try{for(const name of readdirSync('/proc/self/fd')){const fd=Number(name);if(!Number.isSafeInteger(fd)||fd<3||fd===exclude)continue;
  try{const info=fstatSync(fd);if(info.dev===target.dev&&info.ino===target.ino)return fd;}catch{}}
 }catch{return undefined;}return undefined;
}

function openLifecycleLock(layout: LinuxEngineLayout): { fd: number; inherited: boolean } {
 preflightLinuxEngineLayout(layout);
 createLinuxPrivateDirectory(layout.runtimeDir);
 assertLinuxManagedPath(layout.lifecycleLockPath);
 const fd = openSync(layout.lifecycleLockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
 try {
  const info = fstatSync(fd);
  if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1) {
   throw new Error('The Linux lifecycle lock must be a private, singly-linked owner file (0600).');
  }
  const kernel = kernelFlock();
  if (kernel.fcntl(fd, F_SETFD, FD_CLOEXEC) !== 0) throw new Error('The Linux lifecycle lock could not be marked close-on-exec.');
  if (kernel.flock(fd, LOCK_EX | LOCK_NB) === 0) return { fd, inherited: false };
  const inheritedFd=inheritedLockDescriptor(layout.lifecycleLockPath,fd);
  if(inheritedFd!==undefined&&kernel.flock(inheritedFd,LOCK_EX|LOCK_NB)===0){
   if(kernel.fcntl(inheritedFd,F_SETFD,FD_CLOEXEC)!==0)throw new Error('The inherited Linux lifecycle lock could not be marked close-on-exec.');
   closeSync(fd);return {fd:inheritedFd,inherited:true};
  }
  if (inheritedUtilLinuxFlock(layout.lifecycleLockPath)) throw new Error('The util-linux supervisor used --close, so its child cannot retain lifecycle custody. Rerun with an inherited lock descriptor.');
  throw new Error(`Another installer or engine lifecycle operation holds ${layout.lifecycleLockPath}. Retry after it finishes.`);
 } catch (error) {
  closeSync(fd);
  throw error;
 }
}

export function withLinuxEngineLifecycleLock<T>(layout: LinuxEngineLayout, run: () => T): T {
 if (heldLifecycleLocks.has(layout.lifecycleLockPath)) return run();
 const lock = openLifecycleLock(layout);
 heldLifecycleLocks.add(layout.lifecycleLockPath);
 try {
  preflightLinuxEngineLayout(layout);
  return run();
 } finally {
  heldLifecycleLocks.delete(layout.lifecycleLockPath);
  if (!lock.inherited){kernelFlock().flock(lock.fd, LOCK_UN);closeSync(lock.fd);}
 }
}

export async function withLinuxEngineLifecycleLockAsync<T>(layout: LinuxEngineLayout, run: () => Promise<T>): Promise<T> {
 if (heldLifecycleLocks.has(layout.lifecycleLockPath)) return run();
 const lock = openLifecycleLock(layout);
 heldLifecycleLocks.add(layout.lifecycleLockPath);
 try {
  preflightLinuxEngineLayout(layout);
  return await run();
 } finally {
  heldLifecycleLocks.delete(layout.lifecycleLockPath);
  if (!lock.inherited){kernelFlock().flock(lock.fd, LOCK_UN);closeSync(lock.fd);}
 }
}
/** PR4 publishes this capability only with the tested owner-only socket transport. */
function requireLinuxApprovalTransport(program: EngineProgram): void {
 const manifest=JSON.parse(readFileSync(join(program.workingDirectory,'package.json'),'utf8'));
 if(manifest.olympus?.linuxApprovalTransport !== 'owner-unix-socket-v1') throw new Error('This package does not provide Linux owner-only approval. Install a Linux-enabled Olympus release; the existing service was left running.');
 if(manifest.olympus?.linuxStateCompatibility!==1)throw new Error('This package does not declare Linux state compatibility 1. Installation or rollback was refused before service mutation.');
 if(manifest.olympus?.linuxSettingsLayout!=='receipt-v1')throw new Error('The selected engine cannot read receipt-owned settings. Installation or rollback was refused before service mutation.');
}

function hashFile(path: string): string {
 const info = lstatSync(path);
 if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${path} must be a singly-linked regular file.`);
 return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Stable identity used by the Bun-free uninstaller. A tree excludes its root
 * and walks descendants by relative POSIX path. Each record hashes
 * kind\0path\0mode-octal\0, then files hash decimal-length\0bytes and links
 * hash decimal-target-length\0literal-target. Special files and hardlinks
 * refuse. Standalone file/link artifacts hash their raw bytes/target bytes.
 */
export function linuxMachineArtifactDigest(path: string, kind: LinuxMachineArtifact['kind']): string {
 if (kind === 'file') return hashFile(path);
 if (kind === 'symlink') {
  const info = lstatSync(path);
  if (!info.isSymbolicLink()) throw new Error(`${path} is not a symbolic link.`);
  return createHash('sha256').update(readlinkSync(path)).digest('hex');
 }
 const root = resolve(path);
 const rootInfo = lstatSync(root);
 if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`${path} is not a real directory tree.`);
 const hash = createHash('sha256');
 const walk = (dir: string): void => {
  for (const name of readdirSync(dir).sort()) {
   const full = join(dir, name);
   const rel = relative(root, full).split(sep).join('/');
   const info = lstatSync(full);
   const entryKind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : undefined;
   if (!entryKind || (info.isFile() && info.nlink !== 1)) throw new Error(`${full} is a special file or hardlink; artifact identity refused.`);
   hash.update(entryKind); hash.update('\0'); hash.update(rel); hash.update('\0'); hash.update((info.mode & 0o7777).toString(8)); hash.update('\0');
   if (entryKind === 'file') {
    const bytes = readFileSync(full);
    hash.update(String(bytes.length)); hash.update('\0'); hash.update(bytes);
   } else if (entryKind === 'symlink') {
    const target = Buffer.from(readlinkSync(full));
    hash.update(String(target.length)); hash.update('\0'); hash.update(target);
   } else walk(full);
  }
 };
 walk(root);
 return hash.digest('hex');
}

function syncCopiedFile(path: string): void {
 const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
 try { fsyncSync(fd); } finally { closeSync(fd); }
}

function copyPrivateTree(source: string, destination: string): void {
 const sourceInfo = lstatSync(source);
 if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error(`${source} is not a real package directory.`);
 mkdirSync(destination, { mode: sourceInfo.mode & 0o7777 });
 for (const name of readdirSync(source).sort()) {
  const from = join(source, name), to = join(destination, name), info = lstatSync(from);
  if (info.isDirectory() && !info.isSymbolicLink()) copyPrivateTree(from, to);
  else if (info.isFile() && info.nlink === 1) { copyFileSync(from, to); chmodSync(to, info.mode & 0o7777); syncCopiedFile(to); }
  else throw new Error(`${from} is a symlink, special file or hardlink; durable installation refused.`);
 }
 syncDirectorySync(destination);
}

function durableProgram(layout: LinuxEngineLayout, source: EngineProgram, transaction: LinuxInstallTransaction, options:EngineServiceOptions): EngineProgram {
 createLinuxPrivateDirectory(layout.packageDir);
 const generations = join(layout.packageDir, 'generations');
 createLinuxPrivateDirectory(generations);
 const staging = transaction.stagingPath;
 rmSync(staging, { recursive: true, force: true });
 mkdirSync(staging, { mode: 0o700 });
 const stagingInfo=lstatSync(staging);transaction.stagingDevice=stagingInfo.dev;transaction.stagingInode=stagingInfo.ino;writeInstallTransaction(layout,transaction);
 lifecycleCheckpoint(options,'staging_identity_published');
 const app = join(staging, 'app'), runtimeDir = join(staging, 'runtime');
 copyPrivateTree(source.workingDirectory, app);
 mkdirSync(runtimeDir, { mode: 0o700 });
 const runtime = join(runtimeDir, 'bun');
 const runtimeInfo = lstatSync(source.runtimePath);
 if (!runtimeInfo.isFile() || runtimeInfo.isSymbolicLink() || runtimeInfo.nlink !== 1) throw new Error('The selected Bun runtime is not a singly-linked regular file.');
 copyFileSync(source.runtimePath, runtime); chmodSync(runtime, 0o700); syncCopiedFile(runtime); syncDirectorySync(runtimeDir); syncDirectorySync(staging);
 const custodyToken=createHash('sha256').update(`olympus.engine.generation.v1\0${linuxMachineArtifactDigest(app,'tree')}\0${hashFile(runtime)}`).digest('hex');
 writePrivateFileAtomicSync(join(staging,'.olympus-generation.json'),`${JSON.stringify({schema:'olympus.engine.generation.v1',token:custodyToken,build:source.build??null})}\n`);
 syncDirectorySync(staging);
 const digest = linuxMachineArtifactDigest(staging, 'tree');
 const generation = join(generations, digest);
 transaction.generationPath = generation;
 transaction.generationCreated = !existsSync(generation);
 transaction.generationArtifact=treeMachineArtifact(staging,generation);
 writeInstallTransaction(layout, transaction);
 lifecycleCheckpoint(options,'generation_identity_published');
 if (existsSync(generation)) {
  if (linuxMachineArtifactDigest(generation, 'tree') !== digest) throw new Error(`Existing engine generation ${generation} failed identity verification.`);
  rmSync(staging, { recursive: true });
 } else {
  renameSync(staging, generation);
  syncDirectorySync(generations);
  lifecycleCheckpoint(options,'generation_renamed');
 }
 transaction.generationArtifact=treeMachineArtifact(generation);writeInstallTransaction(layout,transaction);
 const installed: EngineProgram = {
  runtimePath: join(generation, 'runtime/bun'), entryPath: join(generation, 'app/dist/cli.js'), workingDirectory: join(generation, 'app'),
  source: 'package', ...(source.build ? { build: source.build } : {}), runtimeDigest: hashFile(join(generation, 'runtime/bun')),
 };
 if (engineBuildIdentity(installed.workingDirectory) !== source.build) throw new Error('The durable package generation does not match the verified source build.');
 requireLinuxApprovalTransport(installed);
 return installed;
}

interface LinuxInstallTransaction {
  schema: 'olympus.engine.install-transaction.v1';
 action:'install'|'rollback';
 phase: 'preparing' | 'activating' | 'rollback_required' | 'qualified' | 'recovered';
 stagingPath: string;
 stagingDevice?:number;
 stagingInode?:number;
 generationPath?: string;
 generationCreated?: boolean;
 generationArtifact?:LinuxMachineArtifact;
 desktopIconSha256?:string;
 legacySettings?: Record<string, LinuxFileSnapshot>;
 legacyRestoreSettings?: Record<string, LinuxFileSnapshot>;
 /** Write-ahead intent: only unit-search links absent before systemctl link. */
 newUnitLinks?:string[];
 priorUnitLinks?:Array<{path:string;target:string}>;
 backupDir:string;
 backupDevice:number;
 backupInode:number;
 before: {
  active: boolean;
  enabled: boolean;
  /** Absent in older journals, whose enabled state was always persistent. */
  enabledRuntime?: boolean;
  files: Record<string, LinuxFileSnapshot>;
  receipt: LinuxFileSnapshot;
  absentCreatedFiles:string[];
 };
}
interface LinuxFileSnapshot{present:boolean;backupPath?:string;sha256?:string;mode?:number;}

function unitLinkCandidates(layout: LinuxEngineLayout): string[] {
 return [join(layout.home, '.config/systemd/user', SYSTEMD_ENGINE_UNIT)].filter(path => path !== layout.unitPath);
}
function ownedUnitLink(layout: LinuxEngineLayout, path: string): boolean {
 const info = lstatSync(path, { throwIfNoEntry: false });
 if (!info) return false;
 assertLinuxManagedPath(dirname(path), process.getuid!(), 'directory');
 if (!info.isSymbolicLink() || info.uid !== process.getuid!()
   || resolve(dirname(path), readlinkSync(path)) !== layout.unitPath) {
  throw new Error(`The systemd unit link changed at ${path}; it was retained.`);
 }
 return true;
}
function restorePriorUnitLinks(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction): void {
 for (const {path,target} of transaction.priorUnitLinks ?? []) {
  if (ownedUnitLink(layout,path)) continue;
  assertLinuxManagedPath(dirname(path),process.getuid!(),'directory');
  symlinkSync(target,path);
  syncDirectorySync(dirname(path));
 }
}
function removeNewUnitLinks(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction): void {
 for (const path of transaction.newUnitLinks ?? []) {
  if (ownedUnitLink(layout, path)) removeFileDurablySync(path);
 }
}

function transactionPath(layout: LinuxEngineLayout): string { return join(layout.stateDir, 'install-transaction.json'); }
function transactionManagedFiles(layout: LinuxEngineLayout, desktop = true): string[] {
 return [layout.unitPath,layout.launcherPath,layout.configPath,join(layout.stateDir,'service-current.json'),join(layout.stateDir,'service-previous.json'),...(desktop?Object.values(linuxDesktopEntryPaths(layout)):[])];
}
function transactionCreatedFiles(layout:LinuxEngineLayout):string[]{const paths=engineServicePaths({platform:'linux',homeDir:layout.home,env:linuxEngineEnvironment(layout)});
 return [layout.configPath,layout.sovereigntyPath,layout.workerEnvPath,join(layout.configDir,'secret-backend.json'),paths.logPath,paths.errorLogPath];}
function optionalText(path: string): string | null {
 try { return readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function writeSnapshot(backupDir:string,index:number,text:string|Buffer|null,mode=0o600):LinuxFileSnapshot{
 if(text===null)return {present:false};
 const backupPath=join(backupDir,`file-${index}.backup`);writePrivateFileAtomicSync(backupPath,text);chmodSync(backupPath,0o600);syncCopiedFile(backupPath);
 return {present:true,backupPath,sha256:hashFile(backupPath),mode};
}
function createInstallTransaction(input:{layout:LinuxEngineLayout;action:'install'|'rollback';phase:LinuxInstallTransaction['phase'];active:boolean;enabled:boolean;enabledRuntime:boolean;receiptText:string|null}):LinuxInstallTransaction{
 const backupDir=join(input.layout.stateDir,`.install-backup-${randomUUID()}`);createLinuxPrivateDirectory(backupDir);const root=lstatSync(backupDir);
 const files:Record<string,LinuxFileSnapshot>={};let index=0;
 for(const path of transactionManagedFiles(input.layout)){const text=existsSync(path)?readFileSync(path):null;const mode=text===null?0o600:lstatSync(path).mode&0o777;files[path]=writeSnapshot(backupDir,index++,text,mode);}
 const receipt=writeSnapshot(backupDir,index,input.receiptText);
 const priorUnitLinks=unitLinkCandidates(input.layout).filter(path=>ownedUnitLink(input.layout,path)).map(path=>({path,target:readlinkSync(path)}));
 return {schema:'olympus.engine.install-transaction.v1',priorUnitLinks,action:input.action,phase:input.phase,stagingPath:join(input.layout.packageDir,`.prepare-${process.pid}-${randomUUID()}`),
  backupDir,backupDevice:root.dev,backupInode:root.ino,before:{active:input.active,enabled:input.enabled,enabledRuntime:input.enabledRuntime,files,receipt,
   absentCreatedFiles:transactionCreatedFiles(input.layout).filter(path=>!existsSync(path))}};
}
function writeInstallTransaction(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction): void {
 writePrivateFileAtomicSync(transactionPath(layout), `${JSON.stringify(transaction, null, 2)}\n`);
}
function readInstallTransaction(layout: LinuxEngineLayout): LinuxInstallTransaction | undefined {
 const path = transactionPath(layout);
 if (!existsSync(path)) return undefined;
 assertLinuxManagedPath(path);
 if ((lstatSync(path).mode & 0o777) !== 0o600) throw new Error('The Linux install recovery journal must be private (0600).');
 const value = JSON.parse(readFileSync(path, 'utf8')) as LinuxInstallTransaction;
  const hasDesktop=Object.hasOwn(value?.before?.files??{},linuxDesktopEntryPaths(layout).desktop);
  const allowedFiles=transactionManagedFiles(layout,hasDesktop),actualFiles=value?.before?.files&&typeof value.before.files==='object'?Object.keys(value.before.files):[];
 const backupDir=typeof value?.backupDir==='string'?resolve(value.backupDir):'';
 const snapshotValid=(snapshot:LinuxFileSnapshot|undefined):boolean=>Boolean(snapshot&&typeof snapshot.present==='boolean'&&(!snapshot.present
  ?snapshot.backupPath===undefined&&snapshot.sha256===undefined&&snapshot.mode===undefined
  :typeof snapshot.backupPath==='string'&&dirname(resolve(snapshot.backupPath))===backupDir&&/^file-[0-9]+[.]backup$/.test(basename(snapshot.backupPath))
   &&/^[0-9a-f]{64}$/.test(snapshot.sha256??'')&&Number.isInteger(snapshot.mode)&&snapshot.mode!>=0&&snapshot.mode!<=0o777));
 const legacy=value.legacySettings;
 if(legacy!==undefined && (!legacy || typeof legacy!=='object' || Array.isArray(legacy)
  || Object.entries(legacy).some(([name,snapshot],index)=>!isLegacyLinuxSetting(name)||!snapshotValid(snapshot)||(snapshot.present&&snapshot.backupPath!==join(backupDir,`file-${10000+index}.backup`))))) throw new Error('Invalid legacy settings recovery journal.');
 const restore=value.legacyRestoreSettings;
 if(restore!==undefined && (!legacy || !restore || typeof restore!=='object' || Array.isArray(restore)
  || Object.keys(restore).length!==Object.keys(legacy).length
  || Object.entries(restore).some(([name,snapshot],index)=>!Object.hasOwn(legacy,name)||!snapshotValid(snapshot)||(snapshot.present&&snapshot.backupPath!==join(backupDir,`file-${20000+index}.backup`))))) throw new Error('Invalid legacy settings restore journal.');
 const createdAllowed=new Set(transactionCreatedFiles(layout));const absent=value?.before?.absentCreatedFiles;
 if (value.schema !== 'olympus.engine.install-transaction.v1'||!['install','rollback'].includes(value.action)|| !['preparing','activating','rollback_required','qualified','recovered'].includes(value.phase)
  ||(value.priorUnitLinks!==undefined&&(!Array.isArray(value.priorUnitLinks)
    ||new Set(value.priorUnitLinks.map(entry=>entry?.path)).size!==value.priorUnitLinks.length
    ||value.priorUnitLinks.some(entry=>!entry||!unitLinkCandidates(layout).includes(entry.path)||typeof entry.target!=='string'
      ||/[\x00-\x1f\x7f]/.test(entry.target)||resolve(dirname(entry.path),entry.target)!==layout.unitPath)))
  ||(value.newUnitLinks!==undefined&&(!Array.isArray(value.newUnitLinks)||new Set(value.newUnitLinks).size!==value.newUnitLinks.length
    ||value.newUnitLinks.some(path=>!unitLinkCandidates(layout).includes(path))))
  ||(value.desktopIconSha256!==undefined&&(!hasDesktop||!/^[0-9a-f]{64}$/.test(value.desktopIconSha256)))
  || (value.before?.enabledRuntime!==undefined&&(typeof value.before.enabledRuntime!=='boolean'||(value.before.enabledRuntime&&!value.before.enabled)))
  || typeof value.before?.active!=='boolean'||typeof value.before?.enabled!=='boolean'||!snapshotValid(value.before?.receipt)
  || dirname(backupDir)!==layout.stateDir||!/^\.install-backup-[0-9a-f-]{36}$/.test(basename(backupDir))
  ||!Number.isSafeInteger(value.backupDevice)||value.backupDevice<0||!Number.isSafeInteger(value.backupInode)||value.backupInode<=0
  ||!Array.isArray(absent)||new Set(absent).size!==absent.length||absent.some(item=>typeof item!=='string'||!createdAllowed.has(item))
  || actualFiles.length!==allowedFiles.length||allowedFiles.some((file,index)=>!Object.hasOwn(value.before.files,file)||!snapshotValid(value.before.files[file])
    ||(value.before.files[file]!.present&&value.before.files[file]!.backupPath!==join(backupDir,`file-${index}.backup`)))
  ||!snapshotValid(value.before.receipt)||(value.before.receipt.present&&value.before.receipt.backupPath!==join(backupDir,`file-${allowedFiles.length}.backup`))
  || dirname(resolve(value.stagingPath))!==layout.packageDir||!/^[.]prepare-[0-9]+-[0-9a-f-]{36}$/.test(basename(value.stagingPath))
  || (value.generationPath!==undefined&&(dirname(resolve(value.generationPath))!==join(layout.packageDir,'generations')||!/^[0-9a-f]{64}$/.test(basename(value.generationPath))))
  || (value.generationCreated!==undefined&&typeof value.generationCreated!=='boolean')
  || ((value.stagingDevice!==undefined||value.stagingInode!==undefined)&&(!Number.isSafeInteger(value.stagingDevice)||value.stagingDevice!<0||!Number.isSafeInteger(value.stagingInode)||value.stagingInode!<=0))
  || (value.generationArtifact!==undefined&&(value.generationArtifact.kind!=='tree'||value.generationArtifact.path!==value.generationPath
    ||value.generationArtifact.sha256!==basename(value.generationArtifact.path)||!Number.isSafeInteger(value.generationArtifact.rootDevice)||value.generationArtifact.rootDevice!<0
    ||!Number.isSafeInteger(value.generationArtifact.rootInode)||value.generationArtifact.rootInode!<=0
    ||value.generationArtifact.markerPath!==join(value.generationArtifact.path,'.olympus-generation.json')||!/^[0-9a-f]{64}$/.test(value.generationArtifact.markerSha256??'')))) {
  throw new Error('The Linux install recovery journal is invalid; recovery refused.');
 }
 if(value.phase==='qualified'||value.phase==='recovered'){
  if(existsSync(backupDir)){const terminalBackup=lstatSync(backupDir);if(!terminalBackup.isDirectory()||terminalBackup.isSymbolicLink()||terminalBackup.uid!==process.getuid!()||(terminalBackup.mode&0o077)!==0||terminalBackup.dev!==value.backupDevice||terminalBackup.ino!==value.backupInode)throw new Error('The terminal Linux recovery backup root changed; cleanup refused.');}
  return value;
 }
 const backup=lstatSync(backupDir);if(!backup.isDirectory()||backup.isSymbolicLink()||backup.uid!==process.getuid!()||(backup.mode&0o077)!==0||backup.dev!==value.backupDevice||backup.ino!==value.backupInode)throw new Error('The Linux install recovery backup root changed; recovery refused.');
 const receiptText=snapshotText(value.before.receipt);if(receiptText!==null){try{const parsed=JSON.parse(receiptText);if(parsed.schema!=='olympus.engine.install.v1'||!['installed','recovery_pending'].includes(parsed.installationState)||parsed.uid!==process.getuid!()||!linuxEngineLayoutsEqual(parsed.layout,layout))throw new Error();}catch{throw new Error('The prior Linux receipt backup is invalid; recovery refused.');}}
 return value;
}
function snapshotBytes(snapshot:LinuxFileSnapshot):Buffer|null{
 if(!snapshot.present)return null;const path=snapshot.backupPath!;assertLinuxManagedPath(path);const info=lstatSync(path);
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid!()||(info.mode&0o777)!==0o600||hashFile(path)!==snapshot.sha256)throw new Error('A Linux recovery snapshot changed; recovery refused.');
 return readFileSync(path);
}
function snapshotText(snapshot:LinuxFileSnapshot):string|null{return snapshotBytes(snapshot)?.toString('utf8')??null;}
function restoreOptionalFile(path: string, snapshot:LinuxFileSnapshot): void {
 const text=snapshotBytes(snapshot);if(text===null)removeFileDurablySync(path);
 else { createLinuxPrivateDirectory(dirname(path)); writePrivateFileAtomicSync(path, text);chmodSync(path,snapshot.mode??0o600);syncCopiedFile(path);syncDirectorySync(dirname(path)); }
}
function removeOwnedDirectory(path:string,device:number|undefined,inode:number|undefined):void{
 if(!existsSync(path))return;if(device===undefined||inode===undefined)throw new Error(`Missing custody identity for ${path}; it was retained.`);
 assertLinuxManagedPath(path,process.getuid!(),'directory');const info=lstatSync(path);
 if(info.dev!==device||info.ino!==inode)throw new Error(`Directory custody changed for ${path}; it was retained.`);rmSync(path,{recursive:true});syncDirectorySync(dirname(path));
}
function cleanupTransactionTrees(transaction:LinuxInstallTransaction):void{
 removeOwnedDirectory(transaction.stagingPath,transaction.stagingDevice,transaction.stagingInode);
 if(transaction.generationCreated&&transaction.generationPath&&existsSync(transaction.generationPath)){if(!transaction.generationArtifact)throw new Error('Missing generation custody identity; it was retained.');assertTreeArtifactCustody(transaction.generationPath,transaction.generationArtifact);rmSync(transaction.generationPath,{recursive:true});syncDirectorySync(dirname(transaction.generationPath));}
}
function cleanupTransactionBackup(transaction:LinuxInstallTransaction):void{removeOwnedDirectory(transaction.backupDir,transaction.backupDevice,transaction.backupInode);}

function assertDesktopTransactionTargets(layout:LinuxEngineLayout,transaction:LinuxInstallTransaction):void{
 const paths=linuxDesktopEntryPaths(layout);
 // Legacy journals never mutated these paths and cannot acquire their ownership.
 if(!Object.hasOwn(transaction.before.files,paths.desktop))return;
 const old=transaction.before.files[paths.icon]?.sha256;
 assertLinuxDesktopEntryOwnership(layout,[old,transaction.desktopIconSha256].filter((hash):hash is string=>typeof hash==='string'));
}
function writeTransactionDesktop(layout:LinuxEngineLayout,program:EngineProgram,transaction:LinuxInstallTransaction,exec:EngineExec):void{
 transaction.desktopIconSha256=hashFile(join(program.workingDirectory,LINUX_APP_ICON));
 writeInstallTransaction(layout,transaction);
 writeLinuxDesktopEntry(layout,program.workingDirectory,exec);
}

function legacySettingTarget(layout: LinuxEngineLayout, name: string): string {
 return join(layout.configDir, name);
}
function legacyOAuthWriterRunning(layout: LinuxEngineLayout, name: string): boolean {
 if(!name.startsWith('pending-oauth/')||name.endsWith('.tmp'))return false;
 const request=name.match(/[.]request[.]([0-9]+)[.][0-9]+[.]json$/);
 let pid:number|undefined;
 if(request)pid=Number(request[1]);
 else {
  let state:{status?:string;pid?:number};
  try { state=JSON.parse(readFileSync(join(layout.home,'.olympus',name),'utf8')); }
  catch { throw new Error('A legacy Olympus sign-in state is unreadable. Back it up before retrying the upgrade. Nothing was changed.'); }
  if(!state || typeof state!=='object')throw new Error('A legacy Olympus sign-in state is invalid. Back it up before retrying the upgrade. Nothing was changed.');
  if(state.status!=='pending')return false;
  pid=state.pid;
 }
 if(!Number.isSafeInteger(pid)||pid!<=0)throw new Error('A pending legacy sign-in has no writer identity. Back up its state before retrying the upgrade. Nothing was changed.');
 try { process.kill(pid!,0);return true; } catch(error) { if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error; }
}
function priorEngineUsesLegacySettings(layout: LinuxEngineLayout, receiptState = readLinuxEngineReceipt(layout.receiptPath)?.installationState): boolean {
 const prior=currentProgram(layout);
 if(prior){const manifest=JSON.parse(readFileSync(join(prior.workingDirectory,'package.json'),'utf8'));return manifest.olympus?.linuxSettingsLayout!=='receipt-v1';}
 // An installed receipt with no generation marker cannot prove modern readers.
 return receiptState==='installed';
}
function isLegacyConsultSidecar(name: string): boolean { return isFileLeaseSidecarName('consult.json',name); }
const LEGACY_CONSULT_LEASE_FILES=['consult.json.lock','consult.json.lock.commit'];
/** An engine from before the kernel lock records its owner in these files; a live owner still means a writer is saving. */
function legacyConsultWriterIsLive(directory: string): boolean {
 for(const name of LEGACY_CONSULT_LEASE_FILES){
  try {
   const record=JSON.parse(readFileSync(join(directory,name),'utf8')) as {pid?:unknown;processInstance?:unknown};
   if(typeof record.pid==='number'&&recordedProcessOwnerIsAlive(record.pid,parseProcessInstanceIdentity(record.processInstance)))return true;
  } catch { /* absent, empty or unreadable: nothing names a live owner */ }
 }
 return false;
}
function withLegacyConsultLease<T>(layout: LinuxEngineLayout, run:()=>T): T {
 const files=legacyLinuxSettings(layout);
 if(!files.some(name=>name==='consult.json'||isLegacyConsultSidecar(name)))return run();
 const directory=join(layout.home,'.olympus');
 try {
  // Share the writer's kernel lock: held for the whole synchronous upgrade, and
  // released by the kernel if this process dies.
  return withFileLeaseSync(join(directory,'consult.json'),lease=>lease.commit(()=>{
   if(legacyConsultWriterIsLive(directory))throw new FileLeaseBusyError(join(directory,'consult.json'));
   const result=run();
   // The old engine has released custody, so its record-based lease files go.
   // The kernel lock file stays: unlinking it while held would let a late
   // writer lock a fresh inode and write the obsolete legacy settings.
   for(const name of LEGACY_CONSULT_LEASE_FILES)rmSync(join(directory,name),{force:true});
   return result;
  }),{acquireTimeoutMs:100,pollIntervalMs:10});
 } catch(error){
  if(error instanceof FileLeaseBusyError)throw new Error('Finish saving Olympus settings, then retry the upgrade. A settings writer is still running; nothing was migrated.');
  throw error;
 }
}
/** Refuse path overrides before stopping: never silently strand an owner's policy. */
function assertLegacySettingOverrides(layout: LinuxEngineLayout, env: Record<string,string|undefined>): void {
 const files=legacyLinuxSettings(layout);
 if(!files.length)return;
 const effective=environmentWithWorkerSetupEnv({env,workerEnvPath:layout.workerEnvPath});
 for(const [key,value] of Object.entries(effective)){
  if(!/^OLYMPUS_.*(?:_PATH|_DIR|_CONFIG)$/.test(key)||!value?.trim())continue;
  const selected=resolve(value.trim());
  const moved=files.find(name=>{const source=join(layout.home,'.olympus',name);return selected===source||source.startsWith(selected+sep);});
  if(!moved)continue;
  const destination=join(layout.configDir,relative(join(layout.home,'.olympus'),selected));
  throw new Error(`Set ${key} to ${destination} in ${layout.workerEnvPath} and in any launch environment that sets it, then retry the upgrade. Nothing was changed.`);
 }
}
function assertAbandonedLegacyManifestTemporary(name: string): void {
 const pid=legacyLinuxManifestTemporaryPid(name);
 if(pid===undefined)return;
 try { process.kill(pid,0); }
 catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw error;}
 throw new Error('The Olympus language-pack installer is still running. Finish it before upgrading; nothing was migrated.');
}
function assertLegacySettingDestinations(layout: LinuxEngineLayout): string[] {
 const files=legacyLinuxSettings(layout).filter(name=>!isLegacyConsultSidecar(name));
 if(priorEngineUsesLegacySettings(layout)){
  for(const name of LEGACY_LINUX_POLICY_FILES){const target=legacySettingTarget(layout,name);assertLinuxManagedPath(target);
   if(lstatSync(target,{throwIfNoEntry:false}))throw new Error(`Legacy-reader settings conflict at ${target}; nothing was migrated.`);}
 }
 for(const name of files){
  assertAbandonedLegacyManifestTemporary(name);
  if(legacyOAuthWriterRunning(layout,name))throw new Error('Finish or cancel the running Olympus sign-in before upgrading. Nothing was changed.');
  const target=legacySettingTarget(layout,name);assertLinuxManagedPath(target);
  if(lstatSync(target,{throwIfNoEntry:false}))throw new Error(`Legacy Olympus settings conflict at ${target}; nothing was migrated.`);}
 return files;
}
/** Called only after the old engine releases custody. Journal every byte before moving any. */
function migrateLegacySettings(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction, options: EngineServiceOptions): void {
 const files=assertLegacySettingDestinations(layout);
 const receiptText=snapshotText(transaction.before.receipt);
 const legacyReader=priorEngineUsesLegacySettings(layout,receiptText?JSON.parse(receiptText).installationState:undefined);
 if(!files.length&&!legacyReader)return;
 const snapshots:Record<string,LinuxFileSnapshot>={};
 const tracked=[...files,...LEGACY_LINUX_POLICY_FILES.filter(name=>!files.includes(name)&&!existsSync(legacySettingTarget(layout,name)))];
 for(const [index,name] of tracked.entries()){
  const source=join(layout.home,'.olympus',name),present=existsSync(source);
  snapshots[name]=writeSnapshot(transaction.backupDir,10000+index,present?readFileSync(source):null,present?lstatSync(source).mode&0o777:0o600);
 }
 transaction.legacySettings=snapshots;writeInstallTransaction(layout,transaction);
 for(const name of files){
  const source=join(layout.home,'.olympus',name),target=legacySettingTarget(layout,name);
  assertLinuxManagedPath(source);assertLinuxManagedPath(target);
  const sourceIdentity=lstatSync(source);
  if(hashFile(source)!==snapshots[name]!.sha256)throw new Error('Legacy Olympus settings changed during migration.');
  if(legacyLinuxManifestTemporaryPid(name)!==undefined){
   // Reclaim only the dead installer's recognized, private, singly-linked
   // temporary. Its journal snapshot still permits failed-install recovery.
   assertAbandonedLegacyManifestTemporary(name);
   assertLegacySettingUnchanged(source,sourceIdentity,snapshots[name]!);
   removeFileDurablySync(source);
   continue;
  }
  createLinuxPrivateDirectory(dirname(target));
  const temporary=legacyMigrationTemporary(layout,transaction,name);
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,snapshotBytes(snapshots[name]!)!);fsyncSync(fd); } finally { closeSync(fd); }
  // link is an atomic no-replace publication on this filesystem, unlike copyFile.
  linkSync(temporary,target);syncDirectorySync(dirname(target));lifecycleCheckpoint(options,'legacy_setting_published');removeFileDurablySync(temporary);
  assertLegacySettingUnchanged(source,sourceIdentity,snapshots[name]!);
  removeFileDurablySync(source);
 }
}
/** Check both content and pathname identity after publication, just before unlink. */
function assertLegacySettingUnchanged(source: string, before: Stats, snapshot: LinuxFileSnapshot): void {
 assertLinuxManagedPath(source);
 const digest=hashFile(source),after=lstatSync(source);
 if(digest!==snapshot.sha256 || (['dev','ino','size','mtimeMs','ctimeMs','mode','uid','nlink'] as const).some(key=>before[key]!==after[key]))
  throw new Error('Legacy Olympus settings changed during migration.');
}
function legacyMigrationTemporary(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction, name: string): string {
 return `${legacySettingTarget(layout,name)}.${basename(transaction.backupDir)}.migration`;
}
function recoverLegacyMigrationTemporary(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction, name: string, original: LinuxFileSnapshot): void {
 const temporary=legacyMigrationTemporary(layout,transaction,name),target=legacySettingTarget(layout,name);
 assertLinuxManagedPath(temporary);
 const temp=lstatSync(temporary,{throwIfNoEntry:false});
 if(!temp)return;
 assertLinuxManagedPath(target);
 const published=lstatSync(target,{throwIfNoEntry:false});
 if(published){
  if(!published.isFile()||temp.dev!==published.dev||temp.ino!==published.ino||temp.nlink!==2||published.nlink!==2)
   throw new Error(`Migration temporary identity changed at ${temporary}; retained for recovery.`);
  // Publication is durable, but the process may have died before unlinking
  // its temporary. Remove only that verified second link before hashFile.
  removeFileDurablySync(temporary);
  if(hashFile(target)!==original.sha256)throw new Error(`Migrated settings changed at ${target}; retained for recovery.`);
 } else {
  if(hashFile(temporary)!==original.sha256)throw new Error(`Migration temporary changed at ${temporary}; retained for recovery.`);
  removeFileDurablySync(temporary);
 }
}
function restoreLegacySettings(layout: LinuxEngineLayout, transaction: LinuxInstallTransaction): void {
 for(const [name,original] of Object.entries(transaction.legacySettings??{}))recoverLegacyMigrationTemporary(layout,transaction,name,original);
 // The engine has released custody. Preserve later owner edits in an immutable
 // second snapshot set before restoring any file. Replays use that same set.
 if(transaction.legacySettings && !transaction.legacyRestoreSettings){
  const snapshots:Record<string,LinuxFileSnapshot>={};
  for(const [index,[name,original]] of Object.entries(transaction.legacySettings).entries()){
   const source=join(layout.home,'.olympus',name),target=legacySettingTarget(layout,name);
   assertLinuxManagedPath(source);assertLinuxManagedPath(target);
   const sourceChanged=existsSync(source)&&hashFile(source)!==original.sha256;
   // A writer may have replaced the legacy source after publication. Preserve
   // that newer policy and remove our unchanged target when rolling back.
   if(sourceChanged&&existsSync(target)&&hashFile(target)!==original.sha256&&hashFile(source)!==hashFile(target))
    throw new Error(`Conflicting settings edits at ${source} and ${target}; retained for recovery.`);
   const bytes=sourceChanged?readFileSync(source):existsSync(target)?readFileSync(target):snapshotBytes(original);
   snapshots[name]=writeSnapshot(transaction.backupDir,20000+index,bytes,0o600);
  }
  transaction.legacyRestoreSettings=snapshots;writeInstallTransaction(layout,transaction);
 }
 for(const [name,snapshot] of Object.entries(transaction.legacyRestoreSettings??{})){
  snapshotBytes(snapshot);
  const source=join(layout.home,'.olympus',name),target=legacySettingTarget(layout,name);
  for(const path of [source,target]){
   assertLinuxManagedPath(path);
   if(existsSync(path)&&![snapshot.sha256,transaction.legacySettings![name]!.sha256].includes(hashFile(path)))throw new Error(`Migrated settings changed at ${path}; retained for recovery.`);
  }
 }
 for(const [name,snapshot] of Object.entries(transaction.legacyRestoreSettings??{})){
  restoreOptionalFile(join(layout.home,'.olympus',name),snapshot);
  removeFileDurablySync(legacySettingTarget(layout,name));
  const temporary=legacyMigrationTemporary(layout,transaction,name);
  assertLinuxManagedPath(temporary);removeFileDurablySync(temporary);
 }
}
function cleanupLegacySettingsDirectories(layout: LinuxEngineLayout): void {
 // rmdir only: never acquire recursive deletion authority over legacy data.
 for(const name of [...LEGACY_LINUX_SETTINGS_DIRECTORIES, ''].sort((a,b)=>b.length-a.length)){
  const path=join(layout.home,'.olympus',name);
  if(!lstatSync(path,{throwIfNoEntry:false}))continue;
  assertLinuxManagedPath(path,process.getuid!(),'directory');
  if(readdirSync(path).length===0){rmdirSync(path);syncDirectorySync(dirname(path));}
 }
}

function restoreInstallTransaction(layout: LinuxEngineLayout, exec: EngineExec, options: EngineServiceOptions): LinuxInstallTransaction | undefined {
 const transaction = readInstallTransaction(layout);
 if (!transaction) return undefined;
 assertDesktopTransactionTargets(layout,transaction);
 if (transaction.phase === 'qualified' || transaction.phase === 'recovered' || transaction.phase === 'rollback_required') return transaction;
 // disable may unlink registration links itself. Validate custody before it runs.
 for (const path of [...(transaction.newUnitLinks??[]),...(transaction.priorUnitLinks??[]).map(entry=>entry.path)]) ownedUnitLink(layout,path);
 const currentFacts = inspectSystemdEngine(layout, exec);
 assertKnown(currentFacts);
 if (currentFacts.state !== 'not_loaded'||currentFacts.enabled!==false) systemdMust(exec, ['disable', '--now', SYSTEMD_ENGINE_UNIT]);
 const stoppedFacts=inspectSystemdEngine(layout,exec);assertKnown(stoppedFacts);
 removeReleasedWorkerSocket(layout,currentFacts,stoppedFacts,options);
 removeNewUnitLinks(layout, transaction);
 restoreLegacySettings(layout,transaction);
 for (const [path, snapshot] of Object.entries(transaction.before.files)) restoreOptionalFile(path, snapshot);
 if(Object.hasOwn(transaction.before.files,linuxDesktopEntryPaths(layout).desktop))refreshLinuxDesktopCaches(layout);
 for(const path of transaction.before.absentCreatedFiles)removeFileDurablySync(path);
 if(transaction.before.files[layout.launcherPath]!.present){chmodSync(layout.launcherPath,0o700);syncCopiedFile(layout.launcherPath);syncDirectorySync(dirname(layout.launcherPath));}
 systemdMust(exec, ['daemon-reload']);
 if (transaction.before.enabled) systemdMust(exec, ['enable', ...(transaction.before.enabledRuntime ? ['--runtime'] : []), layout.unitPath]);
 restorePriorUnitLinks(layout,transaction);
 if(transaction.priorUnitLinks?.length)systemdMust(exec,['daemon-reload']);
 if (transaction.before.active) systemdMust(exec, ['restart', SYSTEMD_ENGINE_UNIT]);
 else if (transaction.before.files[layout.unitPath]!.present) systemdMust(exec, ['stop', SYSTEMD_ENGINE_UNIT]);
 transaction.phase='rollback_required';writeInstallTransaction(layout,transaction);
 return transaction;
}
function currentProgram(l: LinuxEngineLayout): EngineProgram | undefined {
 try { return JSON.parse(readFileSync(join(l.stateDir,'service-current.json'),'utf8')).program; } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw e; }
}
function treeMachineArtifact(path:string,recordedPath=path):LinuxMachineArtifact{
 const root=lstatSync(path),markerPath=join(path,'.olympus-generation.json'),marker=lstatSync(markerPath);
 if(!root.isDirectory()||root.isSymbolicLink()||root.uid!==process.getuid!()||(root.mode&0o077)!==0
  ||!marker.isFile()||marker.isSymbolicLink()||marker.uid!==process.getuid!()||(marker.mode&0o077)!==0)throw new Error(`Generation custody marker is unsafe: ${path}`);
 return {path:recordedPath,kind:'tree',sha256:linuxMachineArtifactDigest(path,'tree'),rootDevice:root.dev,rootInode:root.ino,markerPath:join(recordedPath,'.olympus-generation.json'),markerSha256:hashFile(markerPath)};
}
function refreshMachineArtifacts(layout: LinuxEngineLayout, _includeTransaction = true): void {
 const receipt = readLinuxEngineReceipt(layout.receiptPath);
 if (!receipt) return;
 const transaction=readInstallTransaction(layout);
 if(transaction)assertDesktopTransactionTargets(layout,transaction);else preflightLinuxDesktopEntry(layout);
 const candidates: Array<{ path: string; kind: LinuxMachineArtifact['kind'] }> = [
  { path: layout.unitPath, kind: 'file' },
  { path: layout.launcherPath, kind: 'file' },
  ...(transaction&&!Object.hasOwn(transaction.before.files,linuxDesktopEntryPaths(layout).desktop)?[]:Object.values(linuxDesktopEntryPaths(layout))).map(path=>({path,kind:'file' as const})),
  { path: layout.openHandlerPath, kind: 'file' },
  { path: join(layout.stateDir, 'service-current.json'), kind: 'file' },
  { path: join(layout.stateDir, 'service-previous.json'), kind: 'file' },
  ...receipt.ownedUnitLinks.map(path => ({ path, kind: 'symlink' as const })),
 ];
 const generations = join(layout.packageDir, 'generations');
 if (existsSync(generations)) {
  for (const name of readdirSync(generations).sort()) candidates.push({ path: join(generations, name), kind: 'tree' });
 }
 const machineArtifacts:LinuxMachineArtifact[]=candidates.filter(({ path }) => existsSync(path)).map(({path,kind})=>{
  if(kind==='tree')return treeMachineArtifact(path);
  return {path,kind,sha256:linuxMachineArtifactDigest(path,kind)};
 });
 publishLinuxEngineReceipt(layout, { machineArtifacts });
}
export function syncLinuxOpenHandlerReceipt(options: EngineServiceOptions, present: boolean): void {
 const layout=linuxLayoutFor(options);
 withLinuxEngineLifecycleLock(layout,()=>{
  const receipt=readLinuxEngineReceipt(layout.receiptPath);if(!receipt||receipt.installationState!=='installed')throw new Error('Linux handler ownership requires an installed engine receipt.');
  const others=receipt.machineArtifacts.filter(entry=>entry.path!==layout.openHandlerPath);
  if(present){
   assertLinuxManagedPath(layout.openHandlerPath);
   const info=lstatSync(layout.openHandlerPath);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid!())throw new Error('The Linux desktop handler is not an owned regular file.');
   publishLinuxEngineReceipt(layout,{machineArtifacts:[...others,{path:layout.openHandlerPath,kind:'file',sha256:linuxMachineArtifactDigest(layout.openHandlerPath,'file')}],
    mimeOwnership:{path:layout.mimeappsPath,scheme:'x-scheme-handler/olympus',desktopId:'ai.olympusplugin.open.desktop'},openHandlerPending:false});
  }else{const next={...receipt,machineArtifacts:others,openHandlerPending:false};delete next.mimeOwnership;writePrivateFileAtomicSync(layout.receiptPath,`${JSON.stringify(next,null,2)}\n`);}
 });
}
export function beginLinuxOpenHandlerMutation(options:EngineServiceOptions):void{
 const layout=linuxLayoutFor(options);withLinuxEngineLifecycleLock(layout,()=>publishLinuxEngineReceipt(layout,{openHandlerPending:true}));
}
function publishRecoveryPendingReceipt(layout:LinuxEngineLayout):void{
 const receipt=readLinuxEngineReceipt(layout.receiptPath);if(!receipt)throw new Error('Recovery ownership receipt disappeared.');
 const next={...receipt,installationState:'recovery_pending' as const,ownedUnitLinks:[],machineArtifacts:[],openHandlerPending:false};delete next.mimeOwnership;
 writePrivateFileAtomicSync(layout.receiptPath,`${JSON.stringify(next,null,2)}\n`);
}
function shellQuote(value: string): string {
 if (/\0|\r|\n/.test(value)) throw new Error('Launcher paths may not contain control characters.');
 return `'${value.replace(/'/g, `'\\''`)}'`;
}
function writeLinuxLauncher(layout: LinuxEngineLayout, program: EngineProgram): void {
 createLinuxPrivateDirectory(dirname(layout.launcherPath));
 const environment={...linuxEngineEnvironment(layout),OLYMPUS_STANDALONE:'1'};
 const exports=Object.entries(environment).map(([key,value])=>`export ${key}=${shellQuote(value)}`).join('\n');
 writePrivateFileAtomicSync(layout.launcherPath, `#!/bin/sh\n${exports}\ncd ${shellQuote(program.workingDirectory)} || exit 78\nexec ${shellQuote(program.runtimePath)} --no-env-file ${shellQuote(program.entryPath)} "$@"\n`);
 chmodSync(layout.launcherPath, 0o700);
 syncCopiedFile(layout.launcherPath);
 syncDirectorySync(dirname(layout.launcherPath));
}
function assertInstalled(l: LinuxEngineLayout): void {
 if(readLinuxEngineReceipt(l.receiptPath)?.installationState!=='installed' || !existsSync(l.unitPath)) throw new Error('The engine is not installed. Run olympus engine install.');
 preflightLinuxEngineLayout(l);
}
function assertNoInterruptedInstall(layout: LinuxEngineLayout): void {
 if (readInstallTransaction(layout)) throw new Error('An interrupted Linux engine install must be recovered first. Run olympus engine install again.');
}
function assertKnown(f: SystemdEngineFacts): void { if(f.state==='unknown') throw new Error(f.detail); }
function locked<T>(l: LinuxEngineLayout, f:()=>T):T {
 return withLinuxEngineLifecycleLock(l, f);
}

function processTable(options: EngineServiceOptions & { reap?: EngineChildReapDeps }) {
 if (options.reap?.listProcesses) return options.reap.listProcesses();
 const result = linuxEngineExec('ps', ['-axww', '-o', 'pid=,pgid=,lstart=,command=']);
 return result.status === 0 ? parseProcessTable(result.stdout) : undefined;
}

/** Remove a retained socket only after manager, cgroup, recorded-process and listener custody all agree. */
function removeReleasedWorkerSocket(layout: LinuxEngineLayout, before: SystemdEngineFacts, after: SystemdEngineFacts, options: EngineServiceOptions & { reap?: EngineChildReapDeps }): void {
 assertKnown(after);
 if (after.active) throw new Error('Engine process custody is still active; the worker socket was retained.');
 if (!releasedCgroups(before, after, options)) throw new Error('Engine cgroup custody is not empty or unknown; the worker socket was retained.');
 const childrenPath = engineServicePaths({ ...options, platform: 'linux' }).childrenPath;
 const recorded = readEngineChildren(childrenPath);
 const table = processTable(options);
 if (existsSync(childrenPath) && (!recorded || !table || recorded.children.some(child => table.some(process => process.pgid === child.pgid)))) {
  throw new Error('Recorded engine process custody is live or unknown; the worker socket was retained.');
 }
 if ((options.workerStopped ?? workerSocketListenerStopped)(layout.workerSocketPath) !== true) throw new Error('The worker socket is still listening or its status is unknown; the path was retained.');
 if (!existsSync(layout.workerSocketPath)) return;
 removeReleasedWorkerSocketPath({platform:'linux',env:linuxEngineEnvironment(layout)}, {previousWorkerReleased:true});
}
export function installLinuxEngine(options: EngineInstallOptions): EngineInstallResult {
 const l=linuxLayoutFor(options), paths=engineServicePaths({ ...options, platform:'linux' });
 const source=resolveEngineProgram(options);
 source.runtimeDigest=hashFile(source.runtimePath);
 const sourceUnit=renderEngineSystemdUnit(l,source), exec=options.exec ?? linuxEngineExec;
 const base={ok:true as const,label:SYSTEMD_ENGINE_UNIT,plist_path:l.unitPath,config_path:l.configPath,worker_env_path:l.workerEnvPath,
 log_path:paths.logPath,error_log_path:paths.errorLogPath,program:source,warnings:[] as string[],plist:sourceUnit};
 return locked(l,()=>withLegacyConsultLease(l,()=>{
  preflightSystemdEngine(l,exec,options.uid);
  preflightLinuxDesktopEntry(l);
  for (const path of unitLinkCandidates(l)) assertLinuxManagedPath(dirname(path),process.getuid!(),'directory');
  assertNoInterruptedInstall(l);
  assertLegacySettingDestinations(l);
  assertLegacySettingOverrides(l,options.env??process.env);
  const before=inspectSystemdEngine(l,exec); assertKnown(before);
  const privacyState = resolveInstallationPrivacyState({ homeDir: l.home, paths, env: options.env ?? process.env });
  if(options.dryRun) return {...base,wrote_plist:false,wrote_config:false,wrote_worker_env:false,sovereignty:{action:existsSync(l.sovereigntyPath)?'present':'would_seed',path:l.sovereigntyPath},action:'dry_run'};
  requireLinuxApprovalTransport(source);
  const existingReceipt=readLinuxEngineReceipt(l.receiptPath);
  const observedLinger=readEngineLinger(exec,options.uid);
  if(observedLinger===undefined)throw new Error('Olympus requires systemd-logind and a working user session. Linger could not be inspected; nothing was installed or upgraded.');
  if(!existingReceipt){publishLinuxEngineReceipt(l,{installationState:'recovery_pending',lingerPredated:observedLinger,ownedUnitLinks:[],machineArtifacts:[],openHandlerPending:false});lifecycleCheckpoint(options,'linger_receipt_published');}
  ensureEngineLinger(exec,options.uid,options.userName,options.notice);lifecycleCheckpoint(options,'linger_enabled');
  // Ownership is earned only by creation, never by finding a same-user directory.
  for (const parent of new Set([dirname(l.stateDir), dirname(l.cacheDir)])) {
   if (existsSync(parent)) continue;
   createLinuxPrivateDirectory(dirname(parent));
   mkdirSync(parent, { mode: 0o700 });
   syncDirectorySync(dirname(parent));
   const info = lstatSync(parent);
   const owned = readLinuxEngineReceipt(l.receiptPath)?.ownedEmptyParents ?? [];
   publishLinuxEngineReceipt(l, { ownedEmptyParents: [...owned.filter(entry => entry.path !== parent), { path: parent, device: info.dev, inode: info.ino }] });
  }
  const receiptBeforeInstall=readLinuxEngineReceipt(l.receiptPath)!;
  const originalReceipt=optionalText(l.receiptPath);
  const lingerPredated=receiptBeforeInstall.lingerPredated??observedLinger;
  publishLinuxEngineReceipt(l,{installationState:'installed',lingerPredated});
  lifecycleCheckpoint(options,'receipt_published');
  for(const dir of [l.stateDir,l.cacheDir,dirname(l.unitPath),l.runtimeDir]) createLinuxPrivateDirectory(dir);
  const transaction=createInstallTransaction({layout:l,action:'install',phase:'preparing',active:before.active===true,enabled:before.enabled===true,enabledRuntime:before.enabled_runtime===true,receiptText:originalReceipt});
  writeInstallTransaction(l,transaction);
  lifecycleCheckpoint(options,'journal_published');
  try {
   const program=durableProgram(l,source,transaction,options);
   writeLinuxLauncher(l,program);
   writeTransactionDesktop(l,program,transaction,exec);
   lifecycleCheckpoint(options,'launcher_published');
   const unit=renderEngineSystemdUnit(l,program);
   const candidateDir=join(l.cacheDir,`unit-check-${process.pid}`); createLinuxPrivateDirectory(candidateDir);
   const candidate=join(candidateDir,SYSTEMD_ENGINE_UNIT); writePrivateFileAtomicSync(candidate,unit);
   try { const check=exec('systemd-analyze',['--user','verify','--man=no',candidate]); if(check.status!==0 || /Unknown (?:key|lvalue)|Unknown section|Failed to parse/i.test(check.stderr)) throw new Error(`systemd cannot validate the engine unit: ${check.stderr.slice(0,300)}`); }
   finally { rmSync(candidateDir,{recursive:true,force:true}); }
   if(before.active || before.state==='loaded') waitForQuietEngine(options);
   if(before.state!=='not_loaded') systemdMust(exec,['stop',SYSTEMD_ENGINE_UNIT]);
   removeReleasedWorkerSocket(l,before,inspectSystemdEngine(l,exec),options);
   transaction.phase='activating'; writeInstallTransaction(l,transaction);
   lifecycleCheckpoint(options,'activating_published');
   migrateLegacySettings(l,transaction,options);
   selectLinuxSecretBackend({encryptedFilePath:l.secretsPath,keyFilePath:l.secretsKeyPath,backendFilePath:join(l.configDir,'secret-backend.json')},
    (options.env ?? process.env).OLYMPUS_SECRET_STORE_BACKEND?.trim() || 'auto');
   for(const path of [paths.logPath,paths.errorLogPath]) { assertLinuxManagedPath(path); if(!existsSync(path)) writePrivateFileAtomicSync(path,''); }
   const oldUnit=optionalText(l.unitPath),oldProgram=currentProgram(l);
   if(oldUnit && oldProgram && oldProgram.build!==program.build) writePrivateFileAtomicSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:oldProgram,unit:oldUnit,config:readFileSync(l.configPath,'utf8')}));
   const existingWithoutPolicy = !existsSync(l.sovereigntyPath) && (existingReceipt?.installationState === 'installed' || privacyState.state !== 'not_installed');
   const config=reconcileEngineConfig(l.configPath), seeded=existingWithoutPolicy ? undefined : seedEngineSovereignty(l.sovereigntyPath);
   let wroteEnv=false;
   if(!existsSync(l.workerEnvPath)) { writePrivateFileAtomicSync(l.workerEnvPath,`OLYMPUS_WORKER_AUTH_TOKEN='${randomBytes(32).toString('base64url')}'\nOLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true\n`); wroteEnv=true; }
   lifecycleCheckpoint(options,'config_published');
   const changed=oldUnit!==unit; if(changed) writePrivateFileAtomicSync(l.unitPath,unit);
   lifecycleCheckpoint(options,'unit_published');
   systemdMust(exec,['daemon-reload']);
   // systemctl diagnostics are localized and paths may contain whitespace.
   // Journal absence before invoking it, including a command that creates a link
   // and then fails or a crash before the receipt can be updated.
   transaction.newUnitLinks=unitLinkCandidates(l).filter(path=>!lstatSync(path,{throwIfNoEntry:false}));
   writeInstallTransaction(l,transaction);
   systemdMust(exec,['link',l.unitPath]);
   const links=transaction.newUnitLinks.filter(path=>ownedUnitLink(l,path));
   if(links.length) publishLinuxEngineReceipt(l,{ownedUnitLinks:[...new Set([...(readLinuxEngineReceipt(l.receiptPath)?.ownedUnitLinks ?? []),...links])]});
   systemdMust(exec,['daemon-reload']);
   const visible=inspectSystemdEngine(l,exec); assertKnown(visible);
   if(visible.fragment_path!==l.unitPath) throw new Error(`The user manager did not load ${l.unitPath}; installation is incomplete.`);
   systemdMust(exec,['enable',l.unitPath]);
   systemdMust(exec,['start',SYSTEMD_ENGINE_UNIT]);
   writePrivateFileAtomicSync(join(l.stateDir,'service-current.json'),JSON.stringify({program,unit}));
   lifecycleCheckpoint(options,'current_published');
   refreshMachineArtifacts(l);
   const warnings=[...base.warnings];
   warnings.push(`Installed in your user directories. Address this layout with ${Object.entries(linuxEngineEnvironment(l)).filter(([k])=>k.startsWith('XDG_')).map(([k,v])=>`${k}='${v.replace(/'/g,`'\\''`)}'`).join(' ')}.`);
   return {...base,program,plist:unit,warnings,wrote_plist:changed,wrote_config:config.wrote,wrote_worker_env:wroteEnv,sovereignty:{action:existingWithoutPolicy?'skipped' as const:seeded?'seeded' as const:'present' as const,path:l.sovereigntyPath,...(existingWithoutPolicy?{reason:'An existing engine installation has no policy file; its current policy is preserved.'}:{}),...(seeded?{preset:seeded}:{})},action:before.active?'restarted' as const:'bootstrapped' as const};
  } catch(error) {
   try { restoreInstallTransaction(l,exec,options); }
   catch(recoveryError) { throw new Error(`Linux install failed (${String(error)}), and recovery failed (${String(recoveryError)}). The durable journal was retained.`); }
   throw error;
  }
 }));
}

function previousProgram(layout: LinuxEngineLayout): EngineProgram | undefined {
 try { return (JSON.parse(readFileSync(join(layout.stateDir, 'service-previous.json'), 'utf8')) as { program?: EngineProgram }).program; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function assertTreeArtifactCustody(path:string,artifact:LinuxMachineArtifact):void{
 const root=lstatSync(path),markerPath=join(path,'.olympus-generation.json');
 if(artifact.kind!=='tree'||artifact.path!==path||root.isSymbolicLink()||!root.isDirectory()||root.uid!==process.getuid!()||(root.mode&0o077)!==0
  ||root.dev!==artifact.rootDevice||root.ino!==artifact.rootInode||artifact.markerPath!==markerPath||hashFile(markerPath)!==artifact.markerSha256){
  throw new Error(`Engine generation root or custody marker changed: ${path}`);
 }
}

function pruneOldGenerations(layout: LinuxEngineLayout): void {
 const keep = new Set([currentProgram(layout)?.workingDirectory, previousProgram(layout)?.workingDirectory]
  .filter((path): path is string => Boolean(path)).map(path => dirname(path)));
 const generations = join(layout.packageDir, 'generations');
 if (!existsSync(generations)) return;
 const receipt = readLinuxEngineReceipt(layout.receiptPath);
 for (const name of readdirSync(generations)) {
  const path = join(generations, name);
  if (keep.has(path)) continue;
  const artifact = receipt?.machineArtifacts.find(entry => entry.path === path && entry.kind === 'tree');
  if (!artifact) throw new Error(`Unrecognized engine generation ${path}; automatic cleanup refused.`);
  assertTreeArtifactCustody(path,artifact);
  rmSync(path, { recursive: true });
 }
 syncDirectorySync(generations);
}

export async function recoverInterruptedLinuxEngineInstall(
 options: EngineServiceOptions & { health?: EngineHealthDeps },
): Promise<{ recovered: boolean; restored?: { ok: boolean; build: string | null; reason?: string } }> {
 const layout=linuxLayoutFor(options),exec=options.exec??linuxEngineExec;
 return withLinuxEngineLifecycleLockAsync(layout,async()=>{
  let transaction=readInstallTransaction(layout);
  if(!transaction)return {recovered:false};
  assertDesktopTransactionTargets(layout,transaction);
  if(transaction.phase==='qualified'){
   cleanupLegacySettingsDirectories(layout);
   pruneOldGenerations(layout);refreshMachineArtifacts(layout,false);cleanupTransactionBackup(transaction);removeFileDurablySync(transactionPath(layout));return {recovered:true};
  }
  if(transaction.phase==='recovered'){
   cleanupTransactionBackup(transaction);removeFileDurablySync(transactionPath(layout));return {recovered:true};
  }
  transaction=restoreInstallTransaction(layout,exec,options)!;
  let previousBuild:string|null=null;
  const previousCurrent=snapshotText(transaction.before.files[join(layout.stateDir,'service-current.json')]!);
  if(previousCurrent){try{previousBuild=(JSON.parse(previousCurrent) as {program?:EngineProgram}).program?.build??null;}catch{previousBuild=null;}}
  let restored:{ok:boolean;build:string|null;reason?:string}={ok:true,build:previousBuild};
  if(transaction.before.active){
   if(!previousBuild)restored={ok:false,build:null,reason:'The previous active engine build identity is unreadable.'};
   else{const proof=await waitForEngineHealthy({paths:engineServicePaths({...options,platform:'linux'}),expectedBuild:previousBuild},{...options.health,exec:options.exec});
    restored={ok:proof.ok,build:previousBuild,...(proof.reason?{reason:proof.reason}:{})};}
  }
  if(!restored.ok)return {recovered:false,restored};
  cleanupTransactionTrees(transaction);
  refreshMachineArtifacts(layout,false);
  const priorReceipt=snapshotText(transaction.before.receipt);
  if(priorReceipt!==null)writePrivateFileAtomicSync(layout.receiptPath,priorReceipt);else publishRecoveryPendingReceipt(layout);
  transaction.phase='recovered';writeInstallTransaction(layout,transaction);
  cleanupTransactionBackup(transaction);removeFileDurablySync(transactionPath(layout));
  return {recovered:true,restored};
 });
}

export async function settleLinuxEngineInstall(
 options: EngineServiceOptions & { health?: EngineHealthDeps },
 health: EngineHealthProof,
): Promise<{ restored?: { ok: boolean; build: string | null; reason?: string } }> {
 const layout = linuxLayoutFor(options), exec = options.exec ?? linuxEngineExec;
 return withLinuxEngineLifecycleLockAsync(layout, async () => {
  const transaction = readInstallTransaction(layout);
  if (!transaction) throw new Error('The Linux install recovery journal disappeared before health settlement.');
  assertDesktopTransactionTargets(layout,transaction);
  if (health.ok) {
   transaction.phase='qualified';writeInstallTransaction(layout,transaction);
   lifecycleCheckpoint(options,'qualified_published');
   cleanupLegacySettingsDirectories(layout);
   pruneOldGenerations(layout);
   refreshMachineArtifacts(layout,false);
   lifecycleCheckpoint(options,'receipt_finalized');
   cleanupTransactionBackup(transaction);lifecycleCheckpoint(options,'backup_removed');removeFileDurablySync(transactionPath(layout));lifecycleCheckpoint(options,'journal_removed');
   return {};
  }
  restoreInstallTransaction(layout,exec,options);
  const recovery=await recoverInterruptedLinuxEngineInstall(options);
  return recovery.restored?{restored:recovery.restored}:{};
 });
}
export function linuxInstalledBuild(options: EngineServiceOptions): string | null { return currentProgram(linuxLayoutFor(options))?.build ?? null; }
export function startLinuxEngine(options: EngineServiceOptions) {
 const l=linuxLayoutFor(options), exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return locked(l,()=>{ assertNoInterruptedInstall(l); const before=inspectSystemdEngine(l,exec); assertKnown(before); if(before.active){systemdMust(exec,['enable',l.unitPath]);return {ok:true as const,action:'already_running' as const};}
  removeReleasedWorkerSocket(l,before,before,options);systemdMust(exec,['enable',l.unitPath]);systemdMust(exec,['start',SYSTEMD_ENGINE_UNIT]);return {ok:true as const,action:'started' as const}; });
}
export function restartLinuxEngine(options: EngineServiceOptions) {
 const l=linuxLayoutFor(options),exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return locked(l,()=>{assertNoInterruptedInstall(l);const before=inspectSystemdEngine(l,exec);assertKnown(before);waitForQuietEngine(options);if(before.state!=='not_loaded')systemdMust(exec,['stop',SYSTEMD_ENGINE_UNIT]);
  removeReleasedWorkerSocket(l,before,inspectSystemdEngine(l,exec),options);systemdMust(exec,['link',l.unitPath]);systemdMust(exec,['daemon-reload']);assertKnown(inspectSystemdEngine(l,exec));systemdMust(exec,['enable',l.unitPath]);systemdMust(exec,['start',SYSTEMD_ENGINE_UNIT]);return {ok:true as const,command:['systemctl','--user','start',SYSTEMD_ENGINE_UNIT]};});
}
export function stopLinuxEngine(options: EngineServiceOptions & { reap?: EngineChildReapDeps }) {
 const l=linuxLayoutFor(options), exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return locked(l,()=>{
  assertNoInterruptedInstall(l);
  const before=inspectSystemdEngine(l,exec); assertKnown(before); if(before.active && !before.control_group)throw new Error('Engine cgroup custody is unknown; stop refused.'); waitForQuietEngine(options);
  systemdMust(exec,['disable','--now',SYSTEMD_ENGINE_UNIT]);
  const after=inspectSystemdEngine(l,exec); assertKnown(after);
  if(after.active || after.enabled!==false || (!releasedCgroups(before, after, options))) throw new Error('Engine cgroup custody is not empty or enablement is unknown. Files and recovery evidence were retained.');
  const childrenPath=engineServicePaths({...options,platform:'linux'}).childrenPath;
  const recorded=readEngineChildren(childrenPath);
  const reaped=reapRecordedEngineChildren(childrenPath, options.reap);
  const remainingTable=processTable(options);
  if (recorded?.children.length && (!remainingTable || recorded.children.some(child=>remainingTable.some(p=>p.pgid===child.pgid)))) {
    writePrivateFileAtomicSync(childrenPath,JSON.stringify(recorded));
    throw new Error('Recorded engine child custody remains live or unknown after cleanup. Files and child identities were retained.');
  }
  if(reaped.skipped.some(s=>s.reason!=='gone' && s.reason!=='not_ours')) throw new Error('Recorded engine child custody is unverified. Stop its custodian before removal.');
  removeReleasedWorkerSocket(l,before,after,options);
  return {ok:true as const,stopped:before.active===true,stopped_leftover_processes:reaped.stopped.length,next:'Olympus stays stopped across logout and reboot until you run olympus engine start.'};
 });
}
export function uninstallLinuxEngine(options: EngineServiceOptions & { reap?: EngineChildReapDeps }) {
 const l=linuxLayoutFor(options),exec=options.exec ?? linuxEngineExec;
 return locked(l,()=>{const stopped=stopLinuxEngine(options);const f=inspectSystemdEngine(l,exec);assertKnown(f);if(f.active || f.enabled!==false)throw new Error('Engine custody changed; uninstall refused.');
 const receipt=readLinuxEngineReceipt(l.receiptPath);
 const deletedPaths=new Set<string>();
 for(const path of receipt?.ownedUnitLinks??[]){try{lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}const artifact=receipt?.machineArtifacts.find(entry=>entry.path===path&&entry.kind==='symlink');
  if(!artifact||linuxMachineArtifactDigest(path,'symlink')!==artifact.sha256)throw new Error(`The systemd link ${path} was replaced; it was retained.`);if(removeFileDurablySync(path))deletedPaths.add(path);}
 const desktopPaths=Object.values(linuxDesktopEntryPaths(l)).filter(path=>existsSync(path));
 removeLinuxDesktopEntry(l,exec);
 for(const path of desktopPaths)deletedPaths.add(path);
 const removed=removeFileDurablySync(l.unitPath);
 if(removed)deletedPaths.add(l.unitPath);
 systemdMust(exec,['daemon-reload']);
 // Retained artifacts keep their original ownership proof. Re-hashing here
 // would adopt user replacements and authorize their later full removal.
 if(receipt)publishLinuxEngineReceipt(l,{
  machineArtifacts:receipt.machineArtifacts.filter(entry=>!deletedPaths.has(entry.path)),
  ownedUnitLinks:receipt.ownedUnitLinks.filter(path=>!deletedPaths.has(path)),
 });
 return {ok:true as const,plist_path:l.unitPath,unloaded:stopped.stopped,removed_plist:removed,stopped_leftover_processes:stopped.stopped_leftover_processes,
 kept:[l.configDir,l.dataDir,l.stateDir,l.packageDir].map(path=>({path,what:'retained Olympus data or settings'})),next:'Settings, models, credentials, logs and package generations were retained. Account-wide linger was not changed.'}; });
}
export async function rollbackLinuxEngine(options: EngineServiceOptions & {health?:EngineHealthDeps}):Promise<EngineRollbackResult> {
 const l=linuxLayoutFor(options),exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return withLinuxEngineLifecycleLockAsync(l,async()=>{
  preflightLinuxEngineLayout(l);preflightSystemdEngine(l,exec,options.uid);preflightLinuxDesktopEntry(l);assertNoInterruptedInstall(l);assertKnown(inspectSystemdEngine(l,exec));ensureEngineLinger(exec,options.uid,options.userName,options.notice);
  const previous=JSON.parse(readFileSync(join(l.stateDir,'service-previous.json'),'utf8')) as {program:EngineProgram;unit:string;config:string};
  const previousManifest=JSON.parse(readFileSync(join(previous.program.workingDirectory,'package.json'),'utf8'));
  if(previousManifest.olympus?.linuxSettingsLayout!=='receipt-v1')throw new Error('The previous engine cannot read receipt-owned settings. Rollback was refused; the current engine and privacy settings were left unchanged.');
  const current=currentProgram(l); if(!current)throw new Error('The current service generation is unknown; rollback refused.');
  for(const p of [previous.program.runtimePath,previous.program.entryPath,current.runtimePath,current.entryPath])assertLinuxManagedPath(p);
  if(!previous.program.runtimeDigest || createHash('sha256').update(readFileSync(previous.program.runtimePath)).digest('hex')!==previous.program.runtimeDigest)throw new Error('The previous Bun runtime has changed; rollback refused.');
  if(engineBuildIdentity(previous.program.workingDirectory)!==previous.program.build)throw new Error('The previous package has changed; rollback refused.');
  const receipt=readLinuxEngineReceipt(l.receiptPath);
  for(const program of [previous.program,current]){const generation=dirname(program.workingDirectory);const artifact=receipt?.machineArtifacts.find(entry=>entry.path===generation&&entry.kind==='tree');
   if(!artifact)throw new Error(`Engine generation ${generation} is unrecorded; rollback refused.`);assertTreeArtifactCustody(generation,artifact);
   if(linuxMachineArtifactDigest(generation,'tree')!==artifact.sha256)throw new Error(`Engine generation ${generation} changed; rollback refused.`);}
  requireLinuxApprovalTransport(previous.program);
  waitForQuietEngine(options);
  const currentUnit=readFileSync(l.unitPath,'utf8'),currentConfig=readFileSync(l.configPath,'utf8');
  if(!current.build||!previous.program.build)throw new Error('Rollback requires both durable generation build identities.');
  const before=inspectSystemdEngine(l,exec);assertKnown(before);
  const transaction=createInstallTransaction({layout:l,action:'rollback',phase:'activating',active:before.active===true,enabled:before.enabled===true,enabledRuntime:before.enabled_runtime===true,receiptText:optionalText(l.receiptPath)});
  writeInstallTransaction(l,transaction);lifecycleCheckpoint(options,'journal_published');lifecycleCheckpoint(options,'activating_published');refreshMachineArtifacts(l);
  const apply=async(p:EngineProgram,unit:string,config:string)=>{
   const observed=inspectSystemdEngine(l,exec);assertKnown(observed);if(observed.state!=='not_loaded')systemdMust(exec,['stop',SYSTEMD_ENGINE_UNIT]);removeReleasedWorkerSocket(l,observed,inspectSystemdEngine(l,exec),options);
   const since=Date.now();writePrivateFileAtomicSync(l.unitPath,unit);lifecycleCheckpoint(options,'unit_published');writePrivateFileAtomicSync(l.configPath,config);lifecycleCheckpoint(options,'config_published');writeLinuxLauncher(l,p);writeTransactionDesktop(l,p,transaction,exec);lifecycleCheckpoint(options,'launcher_published');
   writePrivateFileAtomicSync(join(l.stateDir,'service-current.json'),JSON.stringify({program:p,unit}));
   lifecycleCheckpoint(options,'current_published');
   systemdMust(exec,['daemon-reload']);systemdMust(exec,['link',l.unitPath]);systemdMust(exec,['daemon-reload']);assertKnown(inspectSystemdEngine(l,exec));systemdMust(exec,['start',SYSTEMD_ENGINE_UNIT]);
   return waitForEngineHealthy({paths:engineServicePaths({...options,platform:'linux'}),expectedBuild:p.build??null,since},{...options.health, exec: options.exec});
  };
  let health;
  try {health=await apply(previous.program,previous.unit,previous.config);}catch(e){health={ok:false,expected_build:previous.program.build??null,running_build:null,pid:null,worker:'not_ready' as const,waited_ms:0,reason:String(e)};}
  let restored;
  if(!health.ok){try{restoreInstallTransaction(l,exec,options);const recovery=await recoverInterruptedLinuxEngineInstall(options);restored={ok:recovery.restored?.ok??true,build:current.build,...(recovery.restored?.reason?{reason:recovery.restored.reason}:{})};}catch(e){restored={ok:false,build:current.build,reason:String(e)};}}
  else {writePrivateFileAtomicSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:current,unit:currentUnit,config:currentConfig}));refreshMachineArtifacts(l,false);lifecycleCheckpoint(options,'receipt_finalized');transaction.phase='qualified';writeInstallTransaction(l,transaction);lifecycleCheckpoint(options,'qualified_published');cleanupTransactionBackup(transaction);lifecycleCheckpoint(options,'backup_removed');removeFileDurablySync(transactionPath(l));lifecycleCheckpoint(options,'journal_removed');}
  return {ok:health.ok,running_build:health.ok?previous.program.build!:current.build!,previous_build:health.ok?current.build!:previous.program.build!,app_dir:previous.program.workingDirectory,previous_app_dir:current.workingDirectory,action:'restarted',health,...(restored?{restored,reason:`Rollback did not prove healthy: ${health.reason}. Restoration ${restored.ok?'proved healthy':'failed'}.`}:{})};
 });
}

/** Deletion needs positive release proof, including failed stops with escaped recorded children. */
export function linuxEngineCustody(l: LinuxEngineLayout, facts: SystemdEngineFacts, options: EngineServiceOptions = {}): 'loaded' | 'unknown' | 'none' {
 if(facts.active || facts.enabled || facts.state==='loaded' || facts.state==='running') return 'loaded';
 if(facts.state==='unknown' || facts.enabled===null) return 'unknown';
 if(facts.control_group && !waitForEmptyCgroup(facts.control_group, options)) return 'unknown';
 const childrenPath=join(l.dataDir,'engine/children.json');
 const record=readEngineChildren(childrenPath);
 // Only stop owns reaping. A surviving record is deliberately conservative,
 // even if the PID may have died: retry stop to obtain a cleanup receipt.
 if(existsSync(childrenPath) && (!record || record.children.length>0))return 'unknown';
 if(!existsSync(l.receiptPath) && !existsSync(l.unitPath))return 'none';
 return (options.workerStopped ?? workerSocketListenerStopped)(l.workerSocketPath)===true?'none':'unknown';
}
