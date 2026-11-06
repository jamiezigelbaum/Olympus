import { bindWorkerSocket, prepareWorkerSocket, workerSocketListenerStopped } from '../src/core/worker-transport.ts';
import { withFileLeaseSync } from '../src/core/file-lease.ts';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { closeSync, copyFileSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { inspectSystemdEngine, systemdCgroupEmpty, linuxEngineCustody, linuxMachineArtifactDigest, recoverInterruptedLinuxEngineInstall, renderEngineSystemdUnit, ensureEngineLinger, rotateEngineLog, preflightSystemdEngine, settleLinuxEngineInstall, withLinuxEngineLifecycleLock } from '../src/core/linux-engine-service.ts';
import type { EngineExec } from '../src/core/engine-service.ts';
const roots: string[] = [];
function layout() { const home = mkdtempSync(join(tmpdir(), 'svc-systemd-')); roots.push(home); const run = join(home, 'run'); mkdirSync(run, { mode: 0o700 }); return resolveLinuxEngineLayout({ HOME: home, XDG_RUNTIME_DIR: run }); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const good = (stdout = '') => ({ status: 0, stdout, stderr: '' });
test('unit has bounded backoff, config-exit suppression, cgroup custody, private append logs and escaped literals', () => {
 const l = layout(); const unit = renderEngineSystemdUnit(l, { runtimePath: '/a %x/$BUN/bun', entryPath: '/a %x/$HOME/cli.js', workingDirectory: '/a %x/$HOME', source: 'package', build: 'v1+123' });
 for (const line of ['Type=exec', 'StartLimitIntervalSec=0', 'RestartSteps=5', 'RestartMaxDelaySec=300', 'RestartPreventExitStatus=78', 'KillMode=mixed', 'UMask=0077', 'TimeoutStopSec=30', 'SendSIGKILL=yes', 'Restart=on-failure']) expect(unit).toContain(line);
 expect(unit).toContain('"/a %%x/$$BUN/bun" --no-env-file "/a %%x/$$HOME/cli.js" __engine-run');
 expect(unit).toContain(`StandardOutput=append:${l.stateDir}/engine.log`);
 // systemd rejects a quoted WorkingDirectory= ("path is not absolute"): found by the real Omarchy install.
 expect(unit).toContain('\nWorkingDirectory=/a %%x/$HOME\n');
 expect(unit).not.toMatch(/^(WorkingDirectory|StandardOutput|StandardError)=.*"/m);
 expect(() => renderEngineSystemdUnit(l, { runtimePath: '/bin/bun', entryPath: '/cli', workingDirectory: '/a "b"', source: 'package' })).toThrow('quotes');
 expect(() => renderEngineSystemdUnit(l, { runtimePath: '/bin/bun', entryPath: '/cli', workingDirectory: 'relative', source: 'package' })).toThrow('absolute');
 expect(unit).toContain(`XDG_CONFIG_HOME=${l.configHome}`);
 expect(unit).not.toContain('olympus-worker.service');
 expect(() => renderEngineSystemdUnit(l, { runtimePath: '/bin/bun\nExecStart=bad', entryPath: '/cli', workingDirectory: '/', source: 'package' })).toThrow('control');
});
test('unreachable user bus stays unknown; failed config is independent from enabled state', () => {
 const l = layout();
 expect(inspectSystemdEngine(l, () => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus' }))).toMatchObject({ state: 'unknown', enabled: null, active: null });
 const exec: EngineExec = () => good(`LoadState=loaded\nActiveState=failed\nUnitFileState=enabled\nMainPID=0\nControlGroup=\nResult=exit-code\nExecMainStatus=78\nFragmentPath=${l.unitPath}\n`);
 expect(inspectSystemdEngine(l, exec)).toMatchObject({ state: 'loaded', enabled: true, active: false, failed: true, last_exit_code: 78 });
 expect(inspectSystemdEngine(l, exec).detail).toContain('reset-failed olympus-engine.service');
});
for (const [unitState, enabled, custody] of [
 ['enabled-runtime', true, 'loaded'], ['enabled', true, 'loaded'],
 ['linked', false, 'none'], ['linked-runtime', false, 'none'], ['disabled', false, 'none'],
] as const) {
 test(`inactive ${unitState} engine reports enablement and custody`, () => {
  const l = layout();
  const facts = inspectSystemdEngine(l, () => good(`LoadState=loaded\nActiveState=inactive\nUnitFileState=${unitState}\nMainPID=0\nControlGroup=\nFragmentPath=${l.unitPath}\n`));
  expect(facts.enabled).toBe(enabled);
  expect(linuxEngineCustody(l, facts, {workerStopped: () => true})).toBe(custody);
 });
}
test('linger refusal is exact, uses no password prompt, and distinguishes unavailable logind', () => {
 const calls: string[][] = []; let reads = 0;
 const exec: EngineExec = (cmd, args) => { calls.push([cmd, ...args]); return args[0] === 'show-user' ? good(++reads > 0 ? 'no\n' : '') : { status: 1, stdout: '', stderr: 'Access denied' }; };
 expect(() => ensureEngineLinger(exec, 1000, 'alice', () => {})).toThrow("Olympus needs permission to keep running after you log out and to start before you log in. This account cannot enable that permission without an administrator. Ask an administrator to run: `sudo loginctl enable-linger 'alice'`. Then run the installer again. Olympus was not installed or upgraded; an existing installation was left running.");
 expect(calls).toContainEqual(['loginctl', '--no-ask-password', 'enable-linger', 'alice']);
 expect(() => ensureEngineLinger(() => ({ status: 1, stdout: '', stderr: 'bus unavailable' }), 1000, 'alice', () => {})).toThrow('systemd-logind');
});
test('preflight refuses root and unsupported systemd before service mutation', () => {
 const l = layout(); const calls: string[][] = [];
 const exec: EngineExec = (c,a) => { calls.push([c,...a]); return good('systemd 253\n'); };
 expect(() => preflightSystemdEngine(l, exec, 0)).toThrow('root');
 expect(() => preflightSystemdEngine(l, exec, 1000)).toThrow('254');
 expect(calls.some(c => c.includes('start') || c.includes('enable'))).toBe(false);
});
test('copytruncate retains inode and bounded private backups; open append descriptor continues writing', () => {
 const l = layout(); mkdirSync(l.stateDir, { recursive: true, mode: 0o700 }); const log = join(l.stateDir, 'engine.log');
 writeFileSync(log, '0123456789', { mode: 0o600 }); const inode = statSync(log).ino; const fd = openSync(log, 'a');
 try { rotateEngineLog(log, 8, 2); writeFileSync(fd, 'after'); } finally { closeSync(fd); }
 expect(statSync(log).ino).toBe(inode); expect(readFileSync(log,'utf8')).toBe('after'); expect(readFileSync(log+'.1','utf8')).toBe('0123456789'); expect(statSync(log+'.1').mode & 0o777).toBe(0o600);
});

import { engineServicePaths, engineDataCustody, verifyEngine, installEngine, waitForEngineHealthy, startEngine, stopEngine, restartEngine, uninstallEngine, rollbackEngine } from '../src/core/engine-service.ts';
import { publishLinuxEngineReceipt, linuxEngineEnvironment } from '../src/core/linux-engine-layout.ts';
function installed(initialEnablement: 'enabled' | 'enabled-runtime' = 'enabled') {
 const l=layout(); publishLinuxEngineReceipt(l); mkdirSync(l.stateDir,{recursive:true,mode:0o700}); mkdirSync(join(l.configHome,'systemd/user'),{recursive:true,mode:0o700}); writeFileSync(l.unitPath,'unit',{mode:0o600});
 const calls:string[][]=[]; let active=true,enabled: string | false=initialEnablement;
 const exec:EngineExec=(c,a)=>{ calls.push([c,...a]);
  if(a.includes('show'))return good(`LoadState=loaded\nActiveState=${active?'active':'inactive'}\nUnitFileState=${enabled || 'disabled'}\nMainPID=${active?42:0}\nControlGroup=/user.slice/engine\nResult=success\nExecMainStatus=0\nFragmentPath=${l.unitPath}\n`);
  if(a.includes('disable')){enabled=false;active=false;} if(a.includes('enable'))enabled=a.includes('--runtime')?'enabled-runtime':'enabled';if(a.includes('start')||a.includes('restart'))active=true;if(a.includes('stop'))active=false;
  return good(); };
 return {l,calls,exec,options:{platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),exec,consultInFlight:()=>undefined,cgroupEmpty:()=>true,workerStopped:()=>true}};
}
test('Linux lifecycle re-enables boot start on restart, and stop removes custody before uninstall',()=>{
 const {l,calls,options}=installed();
 expect(stopEngine(options)).toMatchObject({ok:true,stopped:true});
 expect(calls).toContainEqual(['systemctl','--user','disable','--now','olympus-engine.service']);
 calls.length=0; restartEngine(options); expect(calls).toContainEqual(['systemctl','--user','enable',l.unitPath]);
 stopEngine(options); calls.length=0; startEngine(options); expect(calls).toContainEqual(['systemctl','--user','enable',l.unitPath]);
 expect(uninstallEngine(options).removed_plist).toBe(true);
 expect(()=>readFileSync(l.unitPath)).toThrow(); expect(readFileSync(l.receiptPath,'utf8')).toContain('olympus.engine.install.v1');
});
test('missing cgroup requires a visible user-manager hierarchy and parent',()=>{
 const l=layout(); const root=join(l.home,'cgroup'); mkdirSync(root);
 const group=`/user.slice/user-${process.getuid!()}.slice/user@${process.getuid!()}.service/app.slice/engine.service`;
 expect(systemdCgroupEmpty(group,root)).toBeUndefined();
 writeFileSync(join(root,'cgroup.controllers'),'cpu');
 expect(systemdCgroupEmpty(group,root)).toBeUndefined();
 mkdirSync(dirname(join(root,group)),{recursive:true});
 expect(systemdCgroupEmpty(group,root)).toBe(true);
 mkdirSync(join(root,group));
 expect(systemdCgroupEmpty(group,root)).toBeUndefined();
 writeFileSync(join(root,group,'cgroup.events'),'populated 1\n'); expect(systemdCgroupEmpty(group,root)).toBe(false);
 writeFileSync(join(root,group,'cgroup.events'),'populated 0\n'); expect(systemdCgroupEmpty(group,root)).toBe(true);
});
test('restart checks a cgroup that appears between inspection and stop',()=>{
 const {options,exec}=installed(); let shows=0;
 const raceExec:EngineExec=(cmd,args)=>{const result=exec(cmd,args); if(args.includes('show') && ++shows===1) return {...result,stdout:result.stdout.replace('ControlGroup=/user.slice/engine','ControlGroup=')}; return result;};
 expect(()=>restartEngine({...options,exec:raceExec,cgroupEmpty:()=>false,sleepMs:()=>{}})).toThrow('custody');
});
test('restart waits for asynchronous cgroup teardown but refuses a persistent process',()=>{
 const {l,options}=installed(); const group=join(l.home,'fake-cgroup'); mkdirSync(group);
 writeFileSync(join(group,'cgroup.events'),'populated 1\n'); writeFileSync(join(group,'cgroup.procs'),'');
 let polls=0;
 const cgroupEmpty=()=>/^populated 0$/m.test(readFileSync(join(group,'cgroup.events'),'utf8'));
 const sleepMs=()=>{ if(++polls===3) writeFileSync(join(group,'cgroup.events'),'populated 0\n'); };
 expect(restartEngine({...options,cgroupEmpty,sleepMs})).toMatchObject({ok:true});
 expect(polls).toBe(3);
 writeFileSync(join(group,'cgroup.events'),'populated 1\n'); writeFileSync(join(group,'cgroup.procs'),'1234\n');
 polls=0;
 expect(()=>restartEngine({...options,cgroupEmpty,sleepMs:()=>{polls++;}})).toThrow('custody');
 expect(polls).toBe(20);
});
test('stop and inactive custody wait for release, and unknown inspection fails closed',()=>{
 const {l,options}=installed(); let reads=0, sleeps=0;
 expect(stopEngine({...options,cgroupEmpty:()=>++reads>3,sleepMs:()=>{sleeps++;}})).toMatchObject({ok:true});
 expect(sleeps).toBe(3);
 const facts=inspectSystemdEngine(l,options.exec); reads=0; sleeps=0;
 expect(linuxEngineCustody(l,facts,{...options,cgroupEmpty:()=>++reads>2,sleepMs:()=>{sleeps++;}})).toBe('none');
 expect(sleeps).toBe(2);
 reads=0; sleeps=0;
 expect(linuxEngineCustody(l,facts,{...options,cgroupEmpty:()=>++reads===1?false:undefined,sleepMs:()=>{sleeps++;}})).toBe('unknown');
 expect(sleeps).toBe(1);
});
test('unknown cgroup/listener custody retains unit and receipt; enabled/unknown managers block data deletion',()=>{
 const {l,options}=installed();
 expect(()=>stopEngine({...options,cgroupEmpty:()=>undefined})).toThrow('custody');
 expect(readFileSync(l.unitPath,'utf8')).toBe('unit');
 expect(()=>stopEngine({...options,workerStopped:()=>false})).toThrow('socket');
 expect(engineDataCustody({manager:'systemd',state:'not_loaded',installed:true,enabled:true})).toBe('loaded');
 expect(engineDataCustody({manager:'systemd',state:'unknown',installed:false,enabled:null})).toBe('unknown');
});
test('Linux health refuses mismatched manager PID, stale identity/build and HTTP failure; uses only Unix socket',async()=>{
 const {l,exec,options}=installed(); const paths=engineServicePaths(options);mkdirSync(join(l.dataDir,'engine'),{recursive:true,mode:0o700});
 const identity={platform:'linux' as const,mechanism:'linux_procfs_start_ticks' as const,startTime:'123'};
 const status={schema:'olympus.engine.status.v1',state:'running',build:'v1',pid:42,process_identity:identity,services:{'olympus-worker':{state:'ok'}}};
 const write=()=>writeFileSync(paths.statusPath,JSON.stringify(status));write();
 const requests: unknown[]=[];
 const deps={timeoutMs:0,exec,pidAlive:()=>true,pidInCgroup:()=>true,processIdentity:()=>identity,fetchImpl:(async(_url:unknown,init:unknown)=>{requests.push(init);return new Response('ok');}) as typeof fetch};
 expect((await waitForEngineHealthy({paths,expectedBuild:'v1'},deps)).ok).toBe(true); expect(requests[0]).toMatchObject({unix:l.workerSocketPath});
 status.pid=43;write();expect((await waitForEngineHealthy({paths,expectedBuild:'v1'},deps)).ok).toBe(false);
 status.pid=42;status.process_identity={...identity,startTime:'old'};write();expect((await waitForEngineHealthy({paths,expectedBuild:'v1'},deps)).ok).toBe(false);
 status.process_identity=identity;write();expect((await waitForEngineHealthy({paths,expectedBuild:'v2'},deps)).ok).toBe(false);
 expect((await waitForEngineHealthy({paths,expectedBuild:'v1'},{...deps,fetchImpl:(async()=>new Response('',{status:503})) as unknown as typeof fetch})).ok).toBe(false);
});
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
test('real CLI data deletion checks Linux engine custody even when legacy worker is absent',()=>{
 const {l}=installed();const bin=join(l.home,'bin');mkdirSync(bin);const ctl=join(bin,'systemctl');
 writeFileSync(ctl,`#!/bin/sh\ncase "$*" in\n *olympus-engine.service*) cat <<'PROPS'\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=42\nControlGroup=/user.slice/engine\nResult=success\nExecMainStatus=0\nFragmentPath=${l.unitPath}\nPROPS\n ;;\n *) echo LoadState=not-found;;\nesac\n`);chmodSync(ctl,0o700);
 mkdirSync(l.dataDir,{recursive:true,mode:0o700});writeFileSync(join(l.dataDir,'keep'),'evidence');
 const result=spawnSync(process.execPath,['src/cli.ts','data','delete','--all','--yes-i-am-sure'],{cwd:join(import.meta.dir,'..'),env:{...process.env,...linuxEngineEnvironment(l),PATH:`${bin}:${process.env.PATH}`},encoding:'utf8',timeout:20000});
 expect(result.status).not.toBe(0);expect(result.stdout+result.stderr).toContain('engine stop');expect(readFileSync(join(l.dataDir,'keep'),'utf8')).toBe('evidence');
},25000);
test.skipIf(process.platform!=='linux')('kernel lifecycle lock reuses only an inherited supervisor descriptor and rejects --close',()=>{
 const l=layout();mkdirSync(l.runtimeDir,{mode:0o700});writeFileSync(l.lifecycleLockPath,'',{mode:0o600});
 const modulePath=join(import.meta.dir,'../src/core/linux-engine-service.ts');
 const code=`import {resolveLinuxEngineLayout} from './src/core/linux-engine-layout.ts';import {withLinuxEngineLifecycleLock} from ${JSON.stringify(modulePath)};const l=resolveLinuxEngineLayout(process.env);withLinuxEngineLifecycleLock(l,()=>process.stdout.write('held'));`;
 const env={...process.env,...linuxEngineEnvironment(l)};
 const inherited=spawnSync('flock',['--nonblock',l.lifecycleLockPath,process.execPath,'-e',code],{cwd:join(import.meta.dir,'..'),env,encoding:'utf8'});
 expect({status:inherited.status,stdout:inherited.stdout,stderr:inherited.stderr}).toMatchObject({status:0,stdout:'held'});
 const closed=spawnSync('flock',['--nonblock','--close',l.lifecycleLockPath,process.execPath,'-e',code],{cwd:join(import.meta.dir,'..'),env,encoding:'utf8'});
 expect(closed.status).not.toBe(0);expect(closed.stdout).not.toContain('held');
 expect(withLinuxEngineLifecycleLock(l,()=>statSync(l.lifecycleLockPath).mode&0o777)).toBe(0o600);
});
function packageAt(root:string,name:string,capable=true){const dir=join(root,name);mkdirSync(join(dir,'dist'),{recursive:true,mode:0o700});writeFileSync(join(dir,'package.json'),JSON.stringify({name:'olympus',version:name,olympus:capable?{linuxApprovalTransport:'owner-unix-socket-v1',linuxStateCompatibility:1,linuxSettingsLayout:'receipt-v1'}:{}}));writeFileSync(join(dir,'dist/cli.js'),`// ${name}`);mkdirSync(join(dir,'assets'));copyFileSync(join(import.meta.dir,'../assets/app-icon.png'),join(dir,'assets/app-icon.png'));return dir;}
function runtimeAt(root:string){const dir=join(root,`fixture-runtime-${Math.random().toString(16).slice(2)}`),runtime=join(dir,'bun');mkdirSync(dir,{mode:0o700});copyFileSync(realpathSync(process.execPath),runtime);chmodSync(runtime,0o700);return runtime;}
test('install refuses an unintegrated approval package before enabling linger or writing config',()=>{
 const l=layout(),checkout=packageAt(l.home,'v1',false);const calls:string[][]=[];
 const exec:EngineExec=(c,a)=>{calls.push([c,...a]);return c==='systemctl'&&a.includes('--version')?good('systemd 256'):a.includes('--property=Version')?good('256'):good('LoadState=not-found');};
 expect(()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:1000,exec,fromCheckout:checkout,bunBin:runtimeAt(l.home)})).toThrow('owner-only approval');
 expect(existsSync(l.configPath)).toBe(false);expect(calls.some(c=>c[0]==='loginctl')).toBe(false);
});
test('install refuses a package without the Linux state compatibility declaration before linger',()=>{
 const l=layout(),checkout=packageAt(l.home,'v1');const manifest=JSON.parse(readFileSync(join(checkout,'package.json'),'utf8'));delete manifest.olympus.linuxStateCompatibility;writeFileSync(join(checkout,'package.json'),JSON.stringify(manifest));const calls:string[][]=[];
 const exec:EngineExec=(c,a)=>{calls.push([c,...a]);return c==='systemctl'&&a.includes('--version')?good('systemd 256'):a.includes('--property=Version')?good('256'):good('LoadState=not-found');};
 expect(()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:checkout,bunBin:runtimeAt(l.home)})).toThrow('state compatibility 1');
 expect(calls.some(call=>call[0]==='loginctl')).toBe(false);
});
test('install copies scratch inputs into a durable generation, receipts the launcher, and commits only after health',async()=>{
 const l=layout(),checkout=packageAt(l.home,'v1');let linked=false,active=false,enabled=false;
 // Exercise the installed shell launcher with the real shared data resolver.
 writeFileSync(join(checkout,'dist/cli.js'), `import { resolveRemoteConnectionsDbPathForCli } from ${JSON.stringify(join(import.meta.dir,'../src/core/remote-connections.ts'))}; console.log(resolveRemoteConnectionsDbPathForCli());`);
 const exec:EngineExec=(command,args)=>{
  if(command==='systemctl'&&args[0]==='--version')return good('systemd 256');
  if(command==='loginctl')return good('yes');
  if(command==='systemd-analyze')return good();
  if(args.includes('olympus-worker.service'))return good('LoadState=not-found');
  if(args.includes('--property=Version'))return good('256');
  if(args.includes('show'))return linked?good(`LoadState=loaded\nActiveState=${active?'active':'inactive'}\nUnitFileState=${enabled?'enabled':'disabled'}\nMainPID=${active?42:0}\nControlGroup=${active?'/user.slice/engine':''}\nResult=success\nExecMainStatus=0\nFragmentPath=${l.unitPath}\n`):good('LoadState=not-found');
  if(args.includes('link'))linked=true;if(args.includes('enable'))enabled=true;if(args.includes('disable')){enabled=false;active=false;}if(args.includes('start'))active=true;if(args.includes('stop'))active=false;
  return good();
 };
 const runtime=runtimeAt(l.home);
 const options={platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:checkout,bunBin:runtime,consultInFlight:()=>undefined,cgroupEmpty:()=>true,workerStopped:()=>true};
 const installedResult=installEngine(options);
 const desktop=join(l.dataHome,'applications/ai.olympusplugin.Olympus.desktop'),icon=join(l.dataHome,'icons/hicolor/512x512/apps/ai.olympusplugin.Olympus.png');
 expect(readFileSync(desktop,'utf8')).toContain(`Exec="${l.launcherPath}" dashboard`);expect(readFileSync(icon)).toEqual(readFileSync(join(checkout,'assets/app-icon.png')));
 expect(installedResult.program.workingDirectory).toStartWith(join(l.packageDir,'generations/'));expect(installedResult.program.workingDirectory).not.toBe(checkout);
 expect(readFileSync(l.launcherPath,'utf8')).toContain(`export XDG_CONFIG_HOME='${l.configHome}'`);
 const parentReceipt=JSON.parse(readFileSync(l.receiptPath,'utf8'));
 for(const path of [dirname(l.stateDir),dirname(l.cacheDir)])expect(parentReceipt.ownedEmptyParents).toContainEqual({path,device:statSync(path).dev,inode:statSync(path).ino});
 const journalPath=join(l.stateDir,'install-transaction.json'),journal=readFileSync(journalPath,'utf8'),transaction=JSON.parse(journal);expect(journal).not.toContain('OLYMPUS_WORKER_AUTH_TOKEN');expect(transaction.backupDir).toContain('.install-backup-');expect(Object.values(transaction.before.files).every((snapshot:any)=>snapshot.present===false&&!('backupPath' in snapshot))).toBe(true);
 await settleLinuxEngineInstall(options,{ok:true,expected_build:installedResult.program.build??null,running_build:installedResult.program.build??null,pid:42,worker:'ok',waited_ms:0});
 mkdirSync(join(l.home,'.openclaw'),{mode:0o700});
 const openclawConfig=join(l.home,'.openclaw/openclaw.json');
 for(const config of ['enabled','unreadable','malformed']){
  if(config==='unreadable')mkdirSync(openclawConfig);
  else writeFileSync(openclawConfig,config==='malformed'?'{broken':JSON.stringify({plugins:{entries:{olympus:{enabled:true}}}}));
  const launched=Bun.spawnSync([l.launcherPath],{env:{PATH:process.env.PATH,HOME:l.home},stdout:'pipe',stderr:'pipe'});
  expect(launched.exitCode).toBe(0);
  expect(launched.stdout.toString().trim()).toBe(join(l.dataHome,'olympus/remote-connections.sqlite'));
  rmSync(openclawConfig,{recursive:true});
 }
 expect(existsSync(join(l.stateDir,'install-transaction.json'))).toBe(false);
 expect((await verifyEngine({...options,expectedBuild:'other'})).desktop_entry).toEqual({present:true,path:desktop});
 const receipt=JSON.parse(readFileSync(l.receiptPath,'utf8'));const generation=receipt.machineArtifacts.find((entry:any)=>entry.kind==='tree');
 expect(generation).toMatchObject({path:dirname(installedResult.program.workingDirectory),markerPath:join(dirname(installedResult.program.workingDirectory),'.olympus-generation.json')});
 expect(Number.isSafeInteger(generation.rootInode)).toBe(true);expect(receipt.machineArtifacts.some((entry:any)=>entry.path===l.launcherPath)).toBe(true);
 // Crash after the terminal receipt commit and during backup GC: remaining
 // snapshot files are no longer recovery inputs, and cleanup is idempotent.
 mkdirSync(transaction.backupDir,{mode:0o700});writeFileSync(join(transaction.backupDir,'partial'),'',{mode:0o600});const backup=statSync(transaction.backupDir);
 writeFileSync(journalPath,JSON.stringify({...transaction,phase:'qualified',backupDevice:backup.dev,backupInode:backup.ino}),{mode:0o600});
 expect((await recoverInterruptedLinuxEngineInstall(options)).recovered).toBe(true);expect((await recoverInterruptedLinuxEngineInstall(options)).recovered).toBe(false);
 const upgraded=installEngine({...options,fromCheckout:packageAt(l.home,'v2')}),interrupted=JSON.parse(readFileSync(journalPath,'utf8'));expect(interrupted.generationCreated).toBe(true);
 rmSync(interrupted.generationPath,{recursive:true});writeFileSync(journalPath,JSON.stringify({...interrupted,phase:'rollback_required',before:{...interrupted.before,active:false}}),{mode:0o600});
 expect((await recoverInterruptedLinuxEngineInstall(options)).recovered).toBe(true);expect(upgraded.program.build).not.toBe(installedResult.program.build);
 expect(JSON.parse(readFileSync(l.receiptPath,'utf8')).ownedEmptyParents).toEqual(parentReceipt.ownedEmptyParents);
 expect(readFileSync(desktop,'utf8')).toContain(`Exec="${l.launcherPath}" dashboard`);expect(readFileSync(icon)).toEqual(readFileSync(join(checkout,'assets/app-icon.png')));
},20_000); // Copies and hashes the real Bun binary twice, including on emulated runners.
for (const enablement of ['enabled', 'enabled-runtime'] as const) {
test(`rollback restores the old unit/config and ${enablement} after failed health`,async()=>{
 const {l,options,calls}=installed(enablement);
 const {engineBuildIdentity}=await import('../src/core/engine-service.ts');
 const artifacts:any[]=[];const generation=(version:string)=>{const stage=join(l.home,`stage-${version}`),sourceApp=packageAt(stage,version),app=join(stage,'app');renameSync(sourceApp,app);const runtimeDir=join(stage,'runtime');mkdirSync(runtimeDir);const runtime=join(runtimeDir,'bun');writeFileSync(runtime,'#!/bin/sh\nexit 0\n',{mode:0o700});writeFileSync(join(stage,'.olympus-generation.json'),JSON.stringify({schema:'olympus.engine.generation.v1',token:version,build:version}),{mode:0o600});
  const digest=linuxMachineArtifactDigest(stage,'tree'),root=join(l.packageDir,'generations',digest);mkdirSync(dirname(root),{recursive:true,mode:0o700});renameSync(stage,root);const info=statSync(root),marker=join(root,'.olympus-generation.json');artifacts.push({path:root,kind:'tree',sha256:digest,rootDevice:info.dev,rootInode:info.ino,markerPath:marker,markerSha256:createHash('sha256').update(readFileSync(marker)).digest('hex')});
  return {runtimePath:join(root,'runtime/bun'),runtimeDigest:createHash('sha256').update(readFileSync(join(root,'runtime/bun'))).digest('hex'),entryPath:join(root,'app/dist/cli.js'),workingDirectory:join(root,'app'),source:'package' as const,build:engineBuildIdentity(join(root,'app'))};};
 const old=generation('v1'),current=generation('v2');publishLinuxEngineReceipt(l,{machineArtifacts:artifacts});
 writeFileSync(l.configPath,'{"remote":{"enabled":false}}',{mode:0o600});
 writeFileSync(join(l.stateDir,'service-current.json'),JSON.stringify({program:current}),{mode:0o600});
 writeFileSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:old,unit:renderEngineSystemdUnit(l,old),config:'{}'}),{mode:0o600});
 const exec:EngineExec=(c,a)=>c==='loginctl'?good('yes'):a.includes('--version')?good('systemd 256'):a.includes('--property=Version')?good('256'):a.includes('olympus-worker.service')?good('LoadState=not-found'):options.exec(c,a);
 const result=await rollbackEngine({...options,uid:1000,exec,health:{timeoutMs:0}});
 expect(result.ok).toBe(false);expect(result.restored?.ok).toBe(false);expect(readFileSync(l.unitPath,'utf8')).toBe('unit');expect(readFileSync(l.configPath,'utf8')).toBe('{"remote":{"enabled":false}}');expect(calls.filter(c=>c.includes('restart'))).toHaveLength(1);
 expect(calls.filter(c=>c.includes('enable')).at(-1)).toEqual(['systemctl','--user','enable',...(enablement === 'enabled-runtime' ? ['--runtime'] : []),l.unitPath]);
});
}
test('inactive disabled service with retained escaped-child evidence never releases data custody',()=>{
 const {l,options}=installed();stopEngine(options);const paths=engineServicePaths(options);mkdirSync(join(l.dataDir,'engine'),{recursive:true,mode:0o700});writeFileSync(paths.childrenPath,'unreadable retained record',{mode:0o600});
 const {inspectEngine}=require('../src/core/engine-service.ts');expect(engineDataCustody(inspectEngine(options))).toBe('unknown');
});

test('a disabled engine in automatic restart backoff retains data custody',()=>{
 const l=layout();const facts=inspectSystemdEngine(l,()=>good(`LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nUnitFileState=disabled\nMainPID=0\nControlGroup=\nResult=exit-code\nExecMainStatus=1\nFragmentPath=${l.unitPath}\n`));
 expect(linuxEngineCustody(l,facts,{workerStopped:()=>true})).toBe('loaded');
});

test('start re-enables an already running but disabled engine', () => {
 const {l,calls,options}=installed(); stopEngine(options);
 options.exec('systemctl',['--user','start','olympus-engine.service']); calls.length=0;
 expect(startEngine(options)).toMatchObject({ok:true,action:'already_running'});
 expect(calls).toContainEqual(['systemctl','--user','enable',l.unitPath]);
});

import { engineConflictWarnings } from '../src/core/engine-service.ts';
import { workerServicePaths } from '../src/core/worker-service.ts';
test('conflict warnings include the legacy Linux user worker', () => {
 const l=layout(), unit=workerServicePaths('linux',l.home,linuxEngineEnvironment(l)).unitPath;
 mkdirSync(dirname(unit),{recursive:true});writeFileSync(unit,'legacy');
 expect(engineConflictWarnings(l.home,'linux',linuxEngineEnvironment(l)).join(' ')).toContain(unit);
 expect(engineConflictWarnings(l.home,'linux',linuxEngineEnvironment(l)).join(' ')).toContain('olympus worker uninstall');
});

for (const failure of ['none', 'link', 'start', 'health', 'parent', 'replacement'] as const) {
 test(`custom XDG unit link with spaced HOME: ${failure}`, async () => {
  const home=mkdtempSync(join(tmpdir(),'svc home '));roots.push(home);
  const run=join(home,'run');mkdirSync(run,{mode:0o700});
  const l=resolveLinuxEngineLayout({HOME:home,XDG_CONFIG_HOME:join(home,'custom config'),XDG_RUNTIME_DIR:run});
  const link=join(home,'.config/systemd/user/olympus-engine.service');
  let active=false,enabled=false,linkCalls=0;
  const exec:EngineExec=(command,args)=>{
   if(command==='loginctl')return good('yes');
   if(command==='systemd-analyze')return good();
   if(args.includes('--version'))return good('systemd 256');
   if(args.includes('--property=Version'))return good('256');
   if(args.includes('olympus-worker.service'))return good('LoadState=not-found');
   if(args.includes('show'))return existsSync(l.unitPath)?good(`LoadState=loaded\nActiveState=${active?'active':'inactive'}\nUnitFileState=${enabled?'enabled':'disabled'}\nMainPID=${active?42:0}\nControlGroup=\nResult=success\nExecMainStatus=0\nFragmentPath=${l.unitPath}\n`):good('LoadState=not-found');
   if(args.includes('link')){
    linkCalls++;mkdirSync(dirname(link),{recursive:true,mode:0o700});if(!lstatSync(link,{throwIfNoEntry:false}))symlinkSync(l.unitPath,link);
    return {status:failure==='link'?1:0,stdout:'',stderr:`Created symlink ${link} → ${l.unitPath}.\n`};
   }
   if(args.includes('enable'))enabled=true;
   if(args.includes('disable')){if(!existsSync(link))return {status:1,stdout:'',stderr:'Unit file does not exist'};enabled=false;active=false;rmSync(link);} // systemd disable removes registration links too.
   if(args.includes('stop'))active=false;
   if(args.includes('start')){if(failure==='replacement'){rmSync(link);symlinkSync(join(home,'user-unit'),link);return {status:1,stdout:'',stderr:'changed target'};}if(failure==='start')return {status:1,stdout:'',stderr:'start fixture failed'};active=true;}
   return good();
  };
  if(failure==='parent'){const outside=join(home,'outside');mkdirSync(outside,{mode:0o700});symlinkSync(outside,join(home,'.config'));}
  const options={platform:'linux',homeDir:home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(home,'v1'),bunBin:runtimeAt(home),consultInFlight:()=>undefined,cgroupEmpty:()=>true,workerStopped:()=>true};
  if(failure==='parent'){expect(()=>installEngine(options)).toThrow();expect(linkCalls).toBe(0);return;}
  if(failure==='replacement'){expect(()=>installEngine(options)).toThrow('recovery failed');expect(readlinkSync(link)).toBe(join(home,'user-unit'));return;}
  if(failure==='link'||failure==='start'){
   expect(()=>installEngine(options)).toThrow();
   expect(()=>lstatSync(link)).toThrow();
   expect((await recoverInterruptedLinuxEngineInstall(options)).recovered).toBe(true);
   for(const path of [dirname(l.stateDir),dirname(l.cacheDir)])expect(JSON.parse(readFileSync(l.receiptPath,'utf8')).ownedEmptyParents).toContainEqual({path,device:statSync(path).dev,inode:statSync(path).ino});
  }else{
   const result=installEngine(options);
   expect(readlinkSync(link)).toBe(l.unitPath);
   expect(JSON.parse(readFileSync(l.receiptPath,'utf8')).ownedUnitLinks).toEqual([link]);
   await settleLinuxEngineInstall(options,{ok:failure!=='health',expected_build:result.program.build??null,running_build:result.program.build??null,pid:42,worker:'ok',waited_ms:0});
   if(failure==='health')expect(()=>lstatSync(link)).toThrow();
   else {
    expect(readlinkSync(link)).toBe(l.unitPath);
    active=false;enabled=false; // Existing linked-but-disabled installation.
    expect(()=>installEngine({...options,lifecycleCheckpoint:(name)=>{if(name==='current_published')throw new Error('repair fixture failed');}})).toThrow('repair fixture failed');
    expect(readlinkSync(link)).toBe(l.unitPath);
   }
  }
 },20_000);
}

for (const failure of [false, true, 'edited', 'new-rule', 'first-rule'] as const) test(`legacy privacy migration ${failure === 'first-rule' ? 'preserves the first rule from a previously unused old engine' : failure === 'new-rule' ? 'preserves newly created tier rules on recovery' : failure === 'edited' ? 'preserves later owner edits on recovery' : failure ? 'rolls back after failed health' : 'survives a successful upgrade'}`, async () => {
 const l=layout();publishLinuxEngineReceipt(l);
 const legacy=join(l.home,'.olympus');mkdirSync(legacy,{mode:0o700});
 let original=JSON.stringify({schemaVersion:1,description:'Synthetic health preference',rules:[],updatedAt:'2026-10-14T00:00:00Z'});
 if(failure!=='first-rule')writeFileSync(join(legacy,'privacy.json'),original,{mode:0o600});
 let linked=false,active=false,enabled=false;
 const exec:EngineExec=(command,args)=>{
  if(command==='systemctl'&&args[0]==='--version')return good('systemd 256');
  if(command==='loginctl')return good('yes');if(command==='systemd-analyze')return good();
  if(args.includes('olympus-worker.service'))return good('LoadState=not-found');if(args.includes('--property=Version'))return good('256');
  if(args.includes('show'))return linked?good(`LoadState=loaded\nActiveState=${active?'active':'inactive'}\nUnitFileState=${enabled?'enabled':'disabled'}\nMainPID=${active?42:0}\nControlGroup=\nFragmentPath=${l.unitPath}\n`):good('LoadState=not-found');
  if(args.includes('link'))linked=true;if(args.includes('enable'))enabled=true;if(args.includes('disable')){enabled=false;active=false;}if(args.includes('start'))active=true;if(args.includes('stop'))active=false;
  return good();
 };
 const options={platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home),consultInFlight:()=>undefined,cgroupEmpty:()=>true,workerStopped:()=>true};
 const result=installEngine(options);
 const target=join(l.configDir,'privacy.json');
 if(failure!=='first-rule'){expect(readFileSync(target,'utf8')).toBe(original);expect(statSync(target).mode&0o777).toBe(0o600);}
 expect(existsSync(join(legacy,'privacy.json'))).toBe(false);
 const read=Bun.spawnSync([process.execPath,'-e',`const { readPrivacyProfile } = await import('./src/workers/classification/privacy-profile.ts');console.log(JSON.stringify(readPrivacyProfile()));`],{env:linuxEngineEnvironment(l),stdout:'pipe',stderr:'pipe'});
 if(failure!=='first-rule'){expect(read.exitCode).toBe(0);expect(JSON.parse(read.stdout.toString()).description).toBe('Synthetic health preference');}
 if(failure==='new-rule'||failure==='first-rule'){const {writePrivacyProfile}=await import('../src/workers/classification/privacy-profile.ts');writePrivacyProfile({description:'New rule',rules:[{kind:'sender',source_id:'gmail.email',value:'@example.test'}]},{env:linuxEngineEnvironment(l)});original=readFileSync(target,'utf8');}
 if(failure==='edited'){original=JSON.stringify({schemaVersion:1,description:'Updated synthetic preference',rules:[]});writeFileSync(target,original,{mode:0o600});}
 await settleLinuxEngineInstall(options,{ok:!failure,expected_build:result.program.build??null,running_build:result.program.build??null,pid:42,worker:'ok',waited_ms:0});
 if(failure==='new-rule'||failure==='first-rule'){expect(existsSync(join(legacy,'tier-rules.json'))).toBe(true);expect(existsSync(join(l.configDir,'tier-rules.json'))).toBe(false);}
 if(failure){expect(readFileSync(join(legacy,'privacy.json'),'utf8')).toBe(original);expect(existsSync(target)).toBe(false);}
 else{expect(readFileSync(target,'utf8')).toBe(original);expect(existsSync(legacy)).toBe(false);}
},30_000);

test('legacy privacy migration refuses a destination conflict without changing either file', () => {
 const l=layout();publishLinuxEngineReceipt(l);const legacy=join(l.home,'.olympus');mkdirSync(legacy,{mode:0o700});
 writeFileSync(join(legacy,'privacy.json'),'old',{mode:0o600});writeFileSync(join(l.configDir,'privacy.json'),'new',{mode:0o600});
 const exec:EngineExec=(command,args)=>command==='loginctl'?good('yes'):args.includes('--version')?good('systemd 256'):args.includes('--property=Version')?good('256'):good('LoadState=not-found');
 expect(()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home)})).toThrow();
 expect(readFileSync(join(legacy,'privacy.json'),'utf8')).toBe('old');expect(readFileSync(join(l.configDir,'privacy.json'),'utf8')).toBe('new');
 expect(existsSync(join(l.stateDir,'install-transaction.json'))).toBe(false);
},15_000);

test('rollback refuses a previous generation that cannot read receipt-owned privacy settings before stopping the engine', async () => {
 const {l,options,calls}=installed();
 const old=packageAt(l.home,'old-layout');const manifest=JSON.parse(readFileSync(join(old,'package.json'),'utf8'));delete manifest.olympus.linuxSettingsLayout;writeFileSync(join(old,'package.json'),JSON.stringify(manifest));
 writeFileSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:{workingDirectory:old}}),{mode:0o600});
 const exec:EngineExec=(command,args)=>command==='loginctl'?good('yes'):args.includes('--version')?good('systemd 256'):args.includes('--property=Version')?good('256'):args.includes('olympus-worker.service')?good('LoadState=not-found'):options.exec(command,args);
 await expect(rollbackEngine({...options,exec,uid:process.getuid!()})).rejects.toThrow('cannot read receipt-owned settings');
 expect(calls.some(args=>args.includes('stop')||args.includes('disable'))).toBe(false);
 expect(readFileSync(l.unitPath,'utf8')).toBe('unit');
 expect(()=>installEngine({...options,exec,uid:process.getuid!(),fromCheckout:old,bunBin:runtimeAt(l.home)})).toThrow('cannot read receipt-owned settings');
});

for (const [key,name] of [['OLYMPUS_TIER_RULES_PATH','tier-rules.json'],['OLYMPUS_PRIVACY_PROFILE_PATH','privacy.json'],['OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH','sources/ingestion-exclusions.json'],['OLYMPUS_CONSULT_VOCABULARY_DIR','consult/vocabulary']] as const) test(`migration refuses an effective ${key} before stopping`,()=>{
 const l=layout();publishLinuxEngineReceipt(l);const legacy=join(l.home,'.olympus');
 const file=name==='consult/vocabulary'?join(name,'manifest.json'):name;
 mkdirSync(dirname(join(legacy,file)),{recursive:true,mode:0o700});writeFileSync(join(legacy,file),'{}',{mode:0o600});
 writeFileSync(l.workerEnvPath,`${key}='${join(legacy,name)}'\n`,{mode:0o600});
 const calls:string[][]=[];const exec:EngineExec=(command,args)=>{calls.push(args);return command==='loginctl'?good('yes'):args.includes('--version')?good('systemd 256'):args.includes('--property=Version')?good('256'):good('LoadState=not-found');};
 expect(()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home)})).toThrow(`Set ${key} to ${join(l.configDir,name)}`);
 expect(calls.some(args=>args.includes('stop')||args.includes('disable'))).toBe(false);
 expect(existsSync(join(legacy,file))).toBe(true);
 expect(existsSync(join(l.stateDir,'install-transaction.json'))).toBe(false);
},15_000);

for(const live of [false,true])test(`legacy consult lease ${live?'refuses a live writer':'reclaims abandoned sidecars'}`,()=>{
 const l=layout();publishLinuxEngineReceipt(l);const legacy=join(l.home,'.olympus');mkdirSync(legacy,{mode:0o700});
 writeFileSync(join(legacy,'consult.json'),'{}',{mode:0o600});
 const record={version:1,token:'synthetic',pid:live?process.pid:2147483647,acquiredAt:new Date().toISOString()};
 for(const suffix of ['.lock','.lock.commit'])writeFileSync(join(legacy,'consult.json'+suffix),JSON.stringify(record),{mode:0o600});
 let linked=false;const calls:string[][]=[];const exec:EngineExec=(command,args)=>{calls.push(args);if(command==='loginctl')return good('yes');if(args.includes('--version'))return good('systemd 256');if(args.includes('--property=Version'))return good('256');if(args.includes('olympus-worker.service'))return good('LoadState=not-found');if(args.includes('show'))return good(linked?`LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0\nFragmentPath=${l.unitPath}`:'LoadState=not-found');if(args.includes('link'))linked=true;return good();};
 const run=()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home)});
 if(live){expect(run).toThrow('Finish saving Olympus settings');expect(calls.some(args=>args.includes('stop'))).toBe(false);}
 else{expect(run).not.toThrow();expect(readFileSync(join(l.configDir,'consult.json'),'utf8')).toBe('{}');for(const suffix of ['.lock','.lock.commit'])expect(existsSync(join(legacy,'consult.json'+suffix))).toBe(false);expect(existsSync(join(legacy,'consult.json.lock.db'))).toBe(true);}
},15_000);

test('legacy consult lease refuses a writer that holds the kernel lock',()=>{
 const l=layout();publishLinuxEngineReceipt(l);const legacy=join(l.home,'.olympus');mkdirSync(legacy,{mode:0o700});
 writeFileSync(join(legacy,'consult.json'),'{}',{mode:0o600});
 const calls:string[][]=[];const exec:EngineExec=(command,args)=>{calls.push(args);return good();};
 const run=()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home)});
 withFileLeaseSync(join(legacy,'consult.json'),()=>{expect(run).toThrow('Finish saving Olympus settings');});
 expect(calls.some(args=>args.includes('stop'))).toBe(false);
 expect(existsSync(join(legacy,'consult.json'))).toBe(true);
},15_000);

for (const replacement of ['new-content', 'same-content', 'in-place'] as const) test(`legacy migration rolls back a concurrent ${replacement} writer before unlink`, () => {
 const {l,options,calls}=installed();
 const source=join(l.home,'.olympus/privacy.json');mkdirSync(dirname(source),{mode:0o700});writeFileSync(source,'original synthetic policy',{mode:0o600});
 const next=replacement==='same-content'?'original synthetic policy':'newer synthetic policy'; let replaced=false;
 const exec:EngineExec=(command,args)=>command==='loginctl'?good('yes'):args.includes('--version')?good('systemd 256'):args.includes('--property=Version')?good('256'):args.includes('olympus-worker.service')?good('LoadState=not-found'):options.exec(command,args);
 expect(()=>installEngine({...options,exec,uid:process.getuid!(),fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home),lifecycleCheckpoint:(name)=>{
  if(name==='legacy_setting_published'&&!replaced){replaced=true;if(replacement==='in-place')writeFileSync(source,next);else{writeFileSync(source+'.replacement',next,{mode:0o600});renameSync(source+'.replacement',source);}}
 }})).toThrow('Legacy Olympus settings changed during migration');
 expect(replaced).toBe(true);expect(readFileSync(source,'utf8')).toBe(next);
 expect(existsSync(join(l.configDir,'privacy.json'))).toBe(false);
 expect(readFileSync(l.unitPath,'utf8')).toBe('unit');
 expect(JSON.parse(readFileSync(join(l.stateDir,'install-transaction.json'),'utf8')).phase).toBe('rollback_required');
 expect(calls.filter(args=>args.includes('restart'))).toHaveLength(1);
},15_000);

for(const live of [false,true])test(`language-pack manifest PID temporary ${live?'refuses a live writer':'is reclaimed after its writer dies'}`,()=>{
 const l=layout();publishLinuxEngineReceipt(l);const dir=join(l.home,'.olympus/consult/vocabulary');mkdirSync(dir,{recursive:true,mode:0o700});
 const name=`manifest.json.${live?process.pid:2147483647}.tmp`;writeFileSync(join(dir,name),'incomplete synthetic manifest',{mode:0o600});writeFileSync(join(dir,'manifest.json'),'{"schema":1,"packs":{}}',{mode:0o600});
 let linked=false;const calls:string[][]=[];const exec:EngineExec=(command,args)=>{calls.push(args);if(command==='loginctl')return good('yes');if(args.includes('--version'))return good('systemd 256');if(args.includes('--property=Version'))return good('256');if(args.includes('olympus-worker.service'))return good('LoadState=not-found');if(args.includes('show'))return good(linked?`LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0\nFragmentPath=${l.unitPath}`:'LoadState=not-found');if(args.includes('link'))linked=true;return good();};
 const run=()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:process.getuid!(),exec,fromCheckout:packageAt(l.home,'v1'),bunBin:runtimeAt(l.home)});
 if(live){expect(run).toThrow('language-pack installer is still running');expect(calls.some(args=>args.includes('stop')||args.includes('disable'))).toBe(false);expect(existsSync(join(dir,name))).toBe(true);}
 else{expect(run).not.toThrow();expect(readFileSync(join(l.configDir,'consult/vocabulary/manifest.json'),'utf8')).toBe('{"schema":1,"packs":{}}');expect(existsSync(join(dir,name))).toBe(false);expect(existsSync(join(l.configDir,'consult/vocabulary',name))).toBe(false);}
},15_000);


for (const stale of [true, false]) test.skipIf(process.platform !== 'linux')(`engine restart ${stale ? 'clears a legacy retained socket without an engine child receipt' : 'preserves a live legacy listener'}`, async () => {
 const {l,options}=installed();
 const env=linuxEngineEnvironment(l), path=prepareWorkerSocket({platform:'linux',env})!;
 let listener: ReturnType<typeof Bun.serve> | undefined;
 if(stale){const made=spawnSync('python3',['-c','import socket,sys,os;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o600);s.close()',path]);expect(made.status).toBe(0);}
 else listener=bindWorkerSocket(path,()=>Bun.serve({unix:path,fetch:()=>new Response('legacy')}));
 const inode=lstatSync(path).ino;
 try{
  const actual={...options,workerStopped:workerSocketListenerStopped};
  if(stale){expect(restartEngine(actual)).toMatchObject({ok:true});expect(lstatSync(path,{throwIfNoEntry:false})).toBeUndefined();}
  else{expect(()=>restartEngine(actual)).toThrow('still listening');expect(lstatSync(path).ino).toBe(inode);}
 }finally{await listener?.stop(true);}
},10000);


test('dry-run preserves an installed engine without a default policy', () => {
 const l=layout(), checkout=packageAt(l.home,'v1');
 publishLinuxEngineReceipt(l);
 mkdirSync(dirname(l.configPath),{recursive:true,mode:0o700});
 writeFileSync(l.configPath,JSON.stringify({}));
 const exec:EngineExec=(c,a)=>c==='systemctl'&&a.includes('--version')?good('systemd 256'):a.includes('--property=Version')?good('256'):good('LoadState=not-found');
 const result=installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:1000,exec,fromCheckout:checkout,bunBin:runtimeAt(l.home),dryRun:true});
 expect(result.sovereignty.action).toBe('skipped');
});
