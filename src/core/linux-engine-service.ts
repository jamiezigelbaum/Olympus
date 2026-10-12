/** systemd user-manager mechanics. Shared config and health stay in engine-service. */
import { spawnSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { assertLinuxManagedPath, type LinuxEngineLayout } from './linux-engine-layout.ts';
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
export function renderEngineSystemdUnit(l: LinuxEngineLayout, p: EngineProgram): string {
 const env = { HOME: l.home, PATH: `${dirname(p.runtimePath)}:/usr/bin:/bin`, OLYMPUS_ENGINE_HOST: '1', OLYMPUS_ENGINE_BUILD: p.build ?? '',
 XDG_CONFIG_HOME: l.configHome, XDG_DATA_HOME: l.dataHome, XDG_STATE_HOME: l.stateHome, XDG_CACHE_HOME: l.cacheHome, XDG_RUNTIME_DIR: l.runtimeHome,
 OLYMPUS_SOVEREIGNTY_CONFIG: l.sovereigntyPath };
 return `[Unit]\nDescription=Olympus standalone engine\nStartLimitIntervalSec=0\n\n[Service]\nType=exec\nExecStart="${value(p.runtimePath,true)}" --no-env-file "${value(p.entryPath,true)}" __engine-run\nWorkingDirectory="${value(p.workingDirectory)}"\nEnvironment=${Object.entries(env).map(([k,v]) => `"${k}=${value(v)}"`).join(' ')}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nRestartSteps=5\nRestartMaxDelaySec=300\nRestartPreventExitStatus=78\nKillMode=mixed\nTimeoutStopSec=30\nSendSIGKILL=yes\nStandardOutput=append:${value(join(l.stateDir,'engine.log'))}\nStandardError=append:${value(join(l.stateDir,'engine.err'))}\n\n[Install]\nWantedBy=default.target\n`;
}
export interface SystemdEngineFacts {
 state: 'running' | 'loaded' | 'not_loaded' | 'unknown'; enabled: boolean | null; active: boolean | null; failed: boolean | null;
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
 enabled: ['enabled','enabled-runtime','linked','linked-runtime'].includes(f.UnitFileState) ? f.UnitFileState === 'enabled' : f.UnitFileState === 'disabled' ? false : null,
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
/** Includes descendants via cgroup.events; a missing group is empty, denied inspection is unknown. */
export function systemdCgroupEmpty(group: string): boolean | undefined {
 if (!group.startsWith('/user.slice/') || group.split('/').includes('..')) return undefined;
 try { return /^populated 0$/m.test(readFileSync(join('/sys/fs/cgroup',group,'cgroup.events'),'utf8')); }
 catch(e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? true : undefined; }
}
export function systemdPidInCgroup(pid: number, group: string): boolean {
 try { return readFileSync(`/proc/${pid}/cgroup`,'utf8').split('\n').some(line => line === `0::${group}`); } catch { return false; }
}
export function systemdMust(exec: EngineExec, args: string[]): string {
 const r=exec('systemctl',['--user',...args]); if(r.status!==0) throw new Error(`systemctl --user ${args[0]} failed: ${(r.stderr || r.stdout || 'user manager unavailable').trim().slice(0,300)}`); return `${r.stdout}\n${r.stderr}`;
}

import { randomBytes, createHash } from 'node:crypto';
import { writePrivateFileAtomicSync, removeFileDurablySync } from './atomic-file.ts';
import { createLinuxPrivateDirectory, linuxEngineEnvironment, preflightLinuxEngineLayout, publishLinuxEngineReceipt, readLinuxEngineReceipt, resolveLinuxEngineLayout } from './linux-engine-layout.ts';
import { withFileLease, withFileLeaseSync } from './file-lease.ts';
import { engineBuildIdentity, engineServicePaths, reconcileEngineConfig, seedEngineSovereignty, resolveEngineProgram, waitForQuietEngine, waitForEngineHealthy,
 type EngineInstallOptions, type EngineInstallResult, type EngineServiceOptions, type EngineHealthDeps, type EngineRollbackResult } from './engine-service.ts';
import { reapRecordedEngineChildren, readEngineChildren, parseProcessTable } from './engine-children.ts';
import type { EngineChildReapDeps } from './engine-children.ts';
const lockOptions = { acquireTimeoutMs: 100, staleAfterMs: Number.MAX_SAFE_INTEGER };
export function linuxLayoutFor(options: EngineServiceOptions): LinuxEngineLayout {
 return resolveLinuxEngineLayout({ ...(options.env ?? process.env), HOME: options.homeDir ?? options.env?.HOME ?? process.env.HOME });
}
/** PR4 publishes this capability only with the tested owner-only socket transport. */
function requireLinuxApprovalTransport(program: EngineProgram): void {
 const manifest=JSON.parse(readFileSync(join(program.workingDirectory,'package.json'),'utf8'));
 if(manifest.olympus?.linuxApprovalTransport !== 'owner-unix-socket-v1') throw new Error('This package does not provide Linux owner-only approval. Install a Linux-enabled Olympus release; the existing service was left running.');
}
function currentProgram(l: LinuxEngineLayout): EngineProgram | undefined {
 try { return JSON.parse(readFileSync(join(l.stateDir,'service-current.json'),'utf8')).program; } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw e; }
}
function assertInstalled(l: LinuxEngineLayout): void {
 if(!readLinuxEngineReceipt(l.receiptPath) || !existsSync(l.unitPath)) throw new Error('The engine is not installed. Run olympus engine install.');
 preflightLinuxEngineLayout(l);
}
function assertKnown(f: SystemdEngineFacts): void { if(f.state==='unknown') throw new Error(f.detail); }
function locked<T>(l: LinuxEngineLayout, f:()=>T):T {
 preflightLinuxEngineLayout(l); createLinuxPrivateDirectory(l.runtimeDir);
 return withFileLeaseSync(l.lifecycleLockPath, lease => lease.commit(() => { preflightLinuxEngineLayout(l); return f(); }), lockOptions);
}
export function installLinuxEngine(options: EngineInstallOptions): EngineInstallResult {
 const l=linuxLayoutFor(options), paths=engineServicePaths({ ...options, platform:'linux' });
 const program=resolveEngineProgram(options);
 program.runtimeDigest=createHash('sha256').update(readFileSync(program.runtimePath)).digest('hex');
 const unit=renderEngineSystemdUnit(l,program), exec=options.exec ?? linuxEngineExec;
 preflightLinuxEngineLayout(l); preflightSystemdEngine(l,exec,options.uid);
 const base={ok:true as const,label:SYSTEMD_ENGINE_UNIT,plist_path:l.unitPath,config_path:l.configPath,worker_env_path:l.workerEnvPath,
 log_path:paths.logPath,error_log_path:paths.errorLogPath,program,warnings:[] as string[],plist:unit};
 if(options.dryRun) return {...base,wrote_plist:false,wrote_config:false,wrote_worker_env:false,sovereignty:{action:existsSync(l.sovereigntyPath)?'present':'would_seed',path:l.sovereigntyPath},action:'dry_run'};
 requireLinuxApprovalTransport(program);
 // This account-wide change is announced and verified before any active package/unit mutation.
 const linger=ensureEngineLinger(exec,options.uid,options.userName,options.notice);
 return locked(l,()=>{
  const before=inspectSystemdEngine(l,exec); assertKnown(before);
  if(before.active || before.state==='loaded') waitForQuietEngine(options);
  publishLinuxEngineReceipt(l,{lingerPredated:readLinuxEngineReceipt(l.receiptPath)?.lingerPredated ?? linger.predated});
  for(const dir of [l.stateDir,l.cacheDir,dirname(l.unitPath),l.runtimeDir]) createLinuxPrivateDirectory(dir);
  for(const path of [paths.logPath,paths.errorLogPath]) { assertLinuxManagedPath(path); if(!existsSync(path)) writePrivateFileAtomicSync(path,''); }
  // Verify the actual directives with this host's manager tooling before replacing the live fragment.
  const candidateDir=join(l.cacheDir,`unit-check-${process.pid}`); createLinuxPrivateDirectory(candidateDir);
  const candidate=join(candidateDir,SYSTEMD_ENGINE_UNIT); writePrivateFileAtomicSync(candidate,unit);
  try { const check=exec('systemd-analyze',['--user','verify','--man=no',candidate]); if(check.status!==0 || /Unknown (?:key|lvalue)|Unknown section|Failed to parse/i.test(check.stderr)) throw new Error(`systemd cannot validate the engine unit: ${check.stderr.slice(0,300)}`); }
  finally { rmSync(candidateDir,{recursive:true,force:true}); }
  const oldUnit=existsSync(l.unitPath)?readFileSync(l.unitPath,'utf8'):undefined;
  const oldProgram=currentProgram(l);
  if(oldUnit && oldProgram && oldProgram.build!==program.build) writePrivateFileAtomicSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:oldProgram,unit:oldUnit,config:readFileSync(l.configPath,'utf8')}));
  const config=reconcileEngineConfig(l.configPath), seeded=seedEngineSovereignty(l.sovereigntyPath);
  let wroteEnv=false;
  if(!existsSync(l.workerEnvPath)) { writePrivateFileAtomicSync(l.workerEnvPath,`OLYMPUS_WORKER_AUTH_TOKEN='${randomBytes(32).toString('base64url')}'\nOLYMPUS_SOURCE_INDEX_ANSWER_ENABLED=true\n`); wroteEnv=true; }
  const changed=oldUnit!==unit; if(changed) writePrivateFileAtomicSync(l.unitPath,unit);
  systemdMust(exec,['daemon-reload']);
  const linkOutput=systemdMust(exec,['link',l.unitPath]);
  const links=[...linkOutput.matchAll(/Created symlink (\S+) →/g)].map(m=>m[1]!.replace(/\.$/,''));
  if(links.length) publishLinuxEngineReceipt(l,{ownedUnitLinks:[...new Set([...(readLinuxEngineReceipt(l.receiptPath)?.ownedUnitLinks ?? []),...links])]});
  systemdMust(exec,['daemon-reload']);
  const visible=inspectSystemdEngine(l,exec); assertKnown(visible);
  if(visible.fragment_path!==l.unitPath) throw new Error(`The user manager did not load ${l.unitPath}; installation is incomplete.`);
  systemdMust(exec,['enable',l.unitPath]);
  const restart=before.active && (changed || options.restart || oldProgram?.build!==program.build);
  systemdMust(exec,[restart?'restart':'start',SYSTEMD_ENGINE_UNIT]);
  writePrivateFileAtomicSync(join(l.stateDir,'service-current.json'),JSON.stringify({program,unit}));
  base.warnings.push(`Installed in your user directories. Address this layout with ${Object.entries(linuxEngineEnvironment(l)).filter(([k])=>k.startsWith('XDG_')).map(([k,v])=>`${k}='${v.replace(/'/g,`'\\''`)}'`).join(' ')}.`);
  return {...base,wrote_plist:changed,wrote_config:config.wrote,wrote_worker_env:wroteEnv,sovereignty:{action:seeded?'seeded' as const:'present' as const,path:l.sovereigntyPath,...(seeded?{preset:seeded}:{})},action:restart?'restarted' as const:before.active?'unchanged' as const:'bootstrapped' as const};
 });
}
export function linuxInstalledBuild(options: EngineServiceOptions): string | null { return currentProgram(linuxLayoutFor(options))?.build ?? null; }
export function startLinuxEngine(options: EngineServiceOptions) {
 const l=linuxLayoutFor(options), exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return locked(l,()=>{ const before=inspectSystemdEngine(l,exec); assertKnown(before); systemdMust(exec,['enable',l.unitPath]); systemdMust(exec,['start',SYSTEMD_ENGINE_UNIT]); return {ok:true as const,action:before.active?'already_running' as const:'started' as const}; });
}
export function restartLinuxEngine(options: EngineServiceOptions) {
 const l=linuxLayoutFor(options),exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return locked(l,()=>{assertKnown(inspectSystemdEngine(l,exec)); systemdMust(exec,['link',l.unitPath]); systemdMust(exec,['daemon-reload']); assertKnown(inspectSystemdEngine(l,exec)); waitForQuietEngine(options); systemdMust(exec,['restart',SYSTEMD_ENGINE_UNIT]); return {ok:true as const,command:['systemctl','--user','restart',SYSTEMD_ENGINE_UNIT]};});
}
export function stopLinuxEngine(options: EngineServiceOptions & { reap?: EngineChildReapDeps }) {
 const l=linuxLayoutFor(options), exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return locked(l,()=>{
  const before=inspectSystemdEngine(l,exec); assertKnown(before); if(before.active && !before.control_group)throw new Error('Engine cgroup custody is unknown; stop refused.'); waitForQuietEngine(options);
  systemdMust(exec,['disable','--now',SYSTEMD_ENGINE_UNIT]);
  const after=inspectSystemdEngine(l,exec); assertKnown(after);
  const empty=options.cgroupEmpty ?? systemdCgroupEmpty;
  if(after.active || after.enabled!==false || (before.control_group && empty(before.control_group)!==true)) throw new Error('Engine cgroup custody is not empty or enablement is unknown. Files and recovery evidence were retained.');
  if((options.workerStopped ?? linuxWorkerSocketStopped)(l.workerSocketPath)!==true) throw new Error('The worker socket is still listening or its status is unknown; files were retained.');
  const childrenPath=engineServicePaths({...options,platform:'linux'}).childrenPath;
  const recorded=readEngineChildren(childrenPath);
  const reaped=reapRecordedEngineChildren(childrenPath, options.reap);
  const remainingTable=options.reap?.listProcesses ? options.reap.listProcesses() : (()=>{const r=linuxEngineExec('ps',['-axww','-o','pid=,pgid=,lstart=,command=']);return r.status===0?parseProcessTable(r.stdout):undefined;})();
  if (recorded?.children.length && (!remainingTable || recorded.children.some(child=>remainingTable.some(p=>p.pgid===child.pgid)))) {
    writePrivateFileAtomicSync(childrenPath,JSON.stringify(recorded));
    throw new Error('Recorded engine child custody remains live or unknown after cleanup. Files and child identities were retained.');
  }
  if(reaped.skipped.some(s=>s.reason!=='gone' && s.reason!=='not_ours')) throw new Error('Recorded engine child custody is unverified. Stop its custodian before removal.');
  return {ok:true as const,stopped:before.active===true,stopped_leftover_processes:reaped.stopped.length,next:'Olympus stays stopped across logout and reboot until you run olympus engine start.'};
 });
}
function linuxWorkerSocketStopped(path: string): boolean | undefined {
 // A stale filesystem socket is not a listener. Probe without sending credentials.
 const r=spawnSync(process.execPath,['-e',`const s=Bun.connect({unix:process.argv[1],socket:{data(){},open(s){s.end();process.exit(1)},error(){process.exit(2)}}});s.catch(e=>process.exit(['ENOENT','ECONNREFUSED'].includes(e.code)?0:2));setTimeout(()=>process.exit(2),1500);`,path],{timeout:2000});
 return r.status===0?true:r.status===1?false:undefined;
}
export function uninstallLinuxEngine(options: EngineServiceOptions & { reap?: EngineChildReapDeps }) {
 const stopped=stopLinuxEngine(options), l=linuxLayoutFor(options),exec=options.exec ?? linuxEngineExec;
 return locked(l,()=>{ const f=inspectSystemdEngine(l,exec);assertKnown(f);if(f.active || f.enabled!==false)throw new Error('Engine custody changed; uninstall refused.');
 const removed=removeFileDurablySync(l.unitPath);systemdMust(exec,['daemon-reload']);
 return {ok:true as const,plist_path:l.unitPath,unloaded:stopped.stopped,removed_plist:removed,stopped_leftover_processes:stopped.stopped_leftover_processes,
 kept:[l.configDir,l.dataDir,l.stateDir,l.packageDir].map(path=>({path,what:'retained Olympus data or settings'})),next:'Settings, models, credentials, logs and package generations were retained. Account-wide linger was not changed.'}; });
}
export async function rollbackLinuxEngine(options: EngineServiceOptions & {health?:EngineHealthDeps}):Promise<EngineRollbackResult> {
 const l=linuxLayoutFor(options),exec=options.exec ?? linuxEngineExec; assertInstalled(l);
 return withFileLease(l.lifecycleLockPath,async()=>{
  preflightLinuxEngineLayout(l); preflightSystemdEngine(l,exec,options.uid); assertKnown(inspectSystemdEngine(l,exec)); ensureEngineLinger(exec,options.uid,options.userName,options.notice);
  const previous=JSON.parse(readFileSync(join(l.stateDir,'service-previous.json'),'utf8')) as {program:EngineProgram;unit:string;config:string};
  const current=currentProgram(l); if(!current)throw new Error('The current service generation is unknown; rollback refused.');
  for(const p of [previous.program.runtimePath,previous.program.entryPath,current.runtimePath,current.entryPath])assertLinuxManagedPath(p);
  if(!previous.program.runtimeDigest || createHash('sha256').update(readFileSync(previous.program.runtimePath)).digest('hex')!==previous.program.runtimeDigest)throw new Error('The previous Bun runtime has changed; rollback refused.');
  if(engineBuildIdentity(previous.program.workingDirectory)!==previous.program.build)throw new Error('The previous package has changed; rollback refused.');
  requireLinuxApprovalTransport(previous.program);
  waitForQuietEngine(options);
  const currentUnit=readFileSync(l.unitPath,'utf8'),currentConfig=readFileSync(l.configPath,'utf8');
  const apply=async(p:EngineProgram,unit:string,config:string)=>{
   systemdMust(exec,['link',l.unitPath]); systemdMust(exec,['daemon-reload']); assertKnown(inspectSystemdEngine(l,exec));
   const since=Date.now(); writePrivateFileAtomicSync(l.unitPath,unit);writePrivateFileAtomicSync(l.configPath,config);systemdMust(exec,['daemon-reload']);systemdMust(exec,['restart',SYSTEMD_ENGINE_UNIT]);
   return waitForEngineHealthy({paths:engineServicePaths({...options,platform:'linux'}),expectedBuild:p.build??null,since},{...options.health, exec: options.exec});
  };
  let health;
  try {health=await apply(previous.program,previous.unit,previous.config);}catch(e){health={ok:false,expected_build:previous.program.build??null,running_build:null,pid:null,worker:'not_ready' as const,waited_ms:0,reason:String(e)};}
  let restored;
  if(!health.ok){try{const back=await apply(current,currentUnit,currentConfig);restored={ok:back.ok,build:current.build!,...(back.reason ? {reason:back.reason} : {})};}catch(e){restored={ok:false,build:current.build!,reason:String(e)};}}
  else {writePrivateFileAtomicSync(join(l.stateDir,'service-current.json'),JSON.stringify({program:previous.program,unit:previous.unit}));writePrivateFileAtomicSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:current,unit:currentUnit,config:currentConfig}));}
  return {ok:health.ok,running_build:health.ok?previous.program.build!:current.build!,previous_build:health.ok?current.build!:previous.program.build!,app_dir:previous.program.workingDirectory,previous_app_dir:current.workingDirectory,action:'restarted',health,...(restored?{restored,reason:`Rollback did not prove healthy: ${health.reason}. Restoration ${restored.ok?'proved healthy':'failed'}.`}:{})};
 },lockOptions);
}

/** Deletion needs positive release proof, including failed stops with escaped recorded children. */
export function linuxEngineCustody(l: LinuxEngineLayout, facts: SystemdEngineFacts, options: EngineServiceOptions = {}): 'loaded' | 'unknown' | 'none' {
 if(facts.active || facts.enabled || facts.state==='loaded' || facts.state==='running') return 'loaded';
 if(facts.state==='unknown' || facts.enabled===null) return 'unknown';
 if(facts.control_group && (options.cgroupEmpty ?? systemdCgroupEmpty)(facts.control_group)!==true) return 'unknown';
 const childrenPath=join(l.dataDir,'engine/children.json');
 const record=readEngineChildren(childrenPath);
 // Only stop owns reaping. A surviving record is deliberately conservative,
 // even if the PID may have died: retry stop to obtain a cleanup receipt.
 if(existsSync(childrenPath) && (!record || record.children.length>0))return 'unknown';
 if(!existsSync(l.receiptPath) && !existsSync(l.unitPath))return 'none';
 return (options.workerStopped ?? linuxWorkerSocketStopped)(l.workerSocketPath)===true?'none':'unknown';
}
