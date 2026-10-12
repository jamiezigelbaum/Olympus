import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { inspectSystemdEngine, linuxEngineCustody, renderEngineSystemdUnit, ensureEngineLinger, rotateEngineLog, preflightSystemdEngine } from '../src/core/linux-engine-service.ts';
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

import { engineServicePaths, engineDataCustody, installEngine, waitForEngineHealthy, startEngine, stopEngine, restartEngine, uninstallEngine, rollbackEngine } from '../src/core/engine-service.ts';
import { publishLinuxEngineReceipt, linuxEngineEnvironment } from '../src/core/linux-engine-layout.ts';
function installed() {
 const l=layout(); publishLinuxEngineReceipt(l); mkdirSync(l.stateDir,{recursive:true,mode:0o700}); mkdirSync(join(l.configHome,'systemd/user'),{recursive:true,mode:0o700}); writeFileSync(l.unitPath,'unit',{mode:0o600});
 const calls:string[][]=[]; let active=true,enabled=true;
 const exec:EngineExec=(c,a)=>{ calls.push([c,...a]);
  if(a.includes('show'))return good(`LoadState=loaded\nActiveState=${active?'active':'inactive'}\nUnitFileState=${enabled?'enabled':'disabled'}\nMainPID=${active?42:0}\nControlGroup=/user.slice/engine\nResult=success\nExecMainStatus=0\nFragmentPath=${l.unitPath}\n`);
  if(a.includes('disable')){enabled=false;active=false;} if(a.includes('enable'))enabled=true;if(a.includes('start')||a.includes('restart'))active=true;
  return good(); };
 return {l,calls,exec,options:{platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),exec,consultInFlight:()=>undefined,cgroupEmpty:()=>true,workerStopped:()=>true}};
}
test('Linux lifecycle preserves persistent stop choice on restart, and stop removes custody before uninstall',()=>{
 const {l,calls,options}=installed();
 expect(stopEngine(options)).toMatchObject({ok:true,stopped:true});
 expect(calls).toContainEqual(['systemctl','--user','disable','--now','olympus-engine.service']);
 calls.length=0; restartEngine(options); expect(calls.some(a=>a.includes('enable'))).toBe(false);
 stopEngine(options); calls.length=0; startEngine(options); expect(calls).toContainEqual(['systemctl','--user','enable',l.unitPath]);
 expect(uninstallEngine(options).removed_plist).toBe(true);
 expect(()=>readFileSync(l.unitPath)).toThrow(); expect(readFileSync(l.receiptPath,'utf8')).toContain('olympus.engine.install.v1');
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
function packageAt(root:string,name:string,capable=true){const dir=join(root,name);mkdirSync(join(dir,'dist'),{recursive:true,mode:0o700});writeFileSync(join(dir,'package.json'),JSON.stringify({name:'olympus',version:name,olympus:capable?{linuxApprovalTransport:'owner-unix-socket-v1'}:{}}));writeFileSync(join(dir,'dist/cli.js'),`// ${name}`);return dir;}
test('install refuses an unintegrated approval package before enabling linger or writing config',()=>{
 const l=layout(),checkout=packageAt(l.home,'v1',false);const calls:string[][]=[];
 const exec:EngineExec=(c,a)=>{calls.push([c,...a]);return c==='systemctl'&&a.includes('--version')?good('systemd 256'):a.includes('--property=Version')?good('256'):good('LoadState=not-found');};
 expect(()=>installEngine({platform:'linux',homeDir:l.home,env:linuxEngineEnvironment(l),uid:1000,exec,fromCheckout:checkout,bunBin:process.execPath})).toThrow('owner-only approval');
 expect(existsSync(l.configPath)).toBe(false);expect(calls.some(c=>c[0]==='loginctl')).toBe(false);
});
test('rollback uses the recorded matching runtime and restores the old unit/config after failed health',async()=>{
 const {l,options,calls}=installed();const old=packageAt(l.home,'v1'),current=packageAt(l.home,'v2');
 const {engineBuildIdentity}=await import('../src/core/engine-service.ts');
 const runtime=join(l.home,'bun');writeFileSync(runtime,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const program=(path:string)=>({runtimePath:runtime,runtimeDigest:createHash('sha256').update(readFileSync(runtime)).digest('hex'),entryPath:join(path,'dist/cli.js'),workingDirectory:path,source:'package',build:engineBuildIdentity(path)});
 writeFileSync(l.configPath,'{"remote":{"enabled":false}}',{mode:0o600});
 writeFileSync(join(l.stateDir,'service-current.json'),JSON.stringify({program:program(current)}),{mode:0o600});
 writeFileSync(join(l.stateDir,'service-previous.json'),JSON.stringify({program:program(old),unit:renderEngineSystemdUnit(l,program(old) as any),config:'{}'}),{mode:0o600});
 const exec:EngineExec=(c,a)=>c==='loginctl'?good('yes'):a.includes('--version')?good('systemd 256'):a.includes('--property=Version')?good('256'):a.includes('olympus-worker.service')?good('LoadState=not-found'):options.exec(c,a);
 const result=await rollbackEngine({...options,uid:1000,exec,health:{timeoutMs:0}});
 expect(result.ok).toBe(false);expect(result.restored?.ok).toBe(false);expect(readFileSync(l.unitPath,'utf8')).toBe('unit');expect(readFileSync(l.configPath,'utf8')).toBe('{"remote":{"enabled":false}}');expect(calls.filter(c=>c.includes('restart'))).toHaveLength(2);
});
test('inactive disabled service with retained escaped-child evidence never releases data custody',()=>{
 const {l,options}=installed();stopEngine(options);const paths=engineServicePaths(options);mkdirSync(join(l.dataDir,'engine'),{recursive:true,mode:0o700});writeFileSync(paths.childrenPath,'unreadable retained record',{mode:0o600});
 const {inspectEngine}=require('../src/core/engine-service.ts');expect(engineDataCustody(inspectEngine(options))).toBe('unknown');
});

test('a disabled engine in automatic restart backoff retains data custody',()=>{
 const l=layout();const facts=inspectSystemdEngine(l,()=>good(`LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nUnitFileState=disabled\nMainPID=0\nControlGroup=\nResult=exit-code\nExecMainStatus=1\nFragmentPath=${l.unitPath}\n`));
 expect(linuxEngineCustody(l,facts,{workerStopped:()=>true})).toBe('loaded');
});
