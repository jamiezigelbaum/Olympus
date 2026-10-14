// OLYMPUS_TEST_LANE: deploy
// W4 4.5/4.7: independent procfs fixtures and the production watchdog boundary.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { verifyLinuxInstance, inspectLinuxNamespace, linuxConfinementCheck, linuxConfinementRemedy, type LinuxProc, type LinuxReady, linuxZkapiConfinement } from '../src/core/zkapi-confinement-linux.ts';
import { supervise, WATCHDOG_SCRIPT, defaultZkapiConfinement } from '../src/core/consult-transport-zkapi.ts';

const ports = { tor: 9001, daemon: 9002, companionProxy: 9003, walletApi: 9004 };
const ready: LinuxReady = { event: 'ready', stage0Pid: 20, stage0Start: '200', stage1Pid: 30, stage1Start: '300', daemonPid: 40, daemonStart: '400', apiToken: 'ab'.repeat(32), landlockAbi: 9, layers: ['netns','pidns','ipv6-off','caps','nnp','launcher-undumpable','launcher-landlock','launcher-seccomp','landlock-net','landlock-unix','landlock-scope','seccomp'], stage0Layers: ['nnp','launcher-undumpable','launcher-landlock','launcher-seccomp'], bridgesExpose: ['api'], bridgesReach: ['9001'] };
const watchdog = { pid: 10, startTime: '100' };
function fixture() {
  const files: Record<string,string> = {};
  const links: Record<string,string> = { '/proc/self/ns/net': 'net:host', '/proc/self/ns/pid': 'pid:host', '/proc/40/ns/net': 'net:child', '/proc/40/ns/pid': 'pid:child' };
  for (const [pid, ppid, start, nspid] of [[10,1,100,'10'],[20,10,200,'20'],[30,20,300,'30 1'],[40,30,400,'40 2'],[50,1,500,'50']] as const) {
    files[`/proc/${pid}/stat`] = `${pid} (process) S ${ppid} 10 0 ` + Array(15).fill('0').join(' ') + ` ${start} 0`;
    files[`/proc/${pid}/status`] = `NSpid:\t${nspid}\n`;
  }
  files['/proc/40/net/tcp'] = 'header\n' + Object.values(ports).map((p,i) => `0: 0100007F:${p.toString(16)} 00000000:0000 0A 0 0 0 0 0 ${100+i}`).join('\n');
  files['/proc/40/net/tcp6'] = 'header\n';
  for (let i=1;i<4;i++) links[`/proc/40/fd/${i}`] = `socket:[${100+i}]`;
  const proc: LinuxProc = { read: p => { if (!(p in files)) throw new Error('unreadable'); return files[p]!; }, link: p => { if (!(p in links)) throw new Error('unreadable'); return links[p]!; }, list: p => p==='/proc' ? ['10','20','30','40','50'] : p==='/proc/40/fd' ? ['1','2','3'] : [] };
  return {files,links,proc};
}

describe('4.5 chain binding', () => {
  test('four genuine distinct process instances bind', () => { expect(verifyLinuxInstance(ready, watchdog, fixture().proc)).toBe(true); });
  const forgeries: Record<string, [Partial<LinuxReady>, Partial<typeof watchdog>]> = {
    pidReuse: [{daemonStart:'401'},{}], unrelatedPid: [{daemonPid:50,daemonStart:'500'},{}],
    stage0Reuse: [{stage0Start:'201'},{}], stage1Reuse: [{stage1Start:'301'},{}],
    wrongWatchdog: [{},{pid:50,startTime:'500'}], watchdogReuse: [{},{startTime:'101'}],
    stage0IsTheWatchdog: [{stage0Pid:10,stage0Start:'100'},{}],
    stage1Reparented: [{stage1Pid:40,stage1Start:'400'},{}],
    stage1Unrelated: [{stage1Pid:50,stage1Start:'500'},{}],
  };
  for (const [name,[event,wd]] of Object.entries(forgeries)) test(name, () => { expect(verifyLinuxInstance({...ready,...event},{...watchdog,...wd},fixture().proc)).toBe(false); });
  test('unreadable namespace and zombie instance refuse', () => {
    const f=fixture(); delete f.links['/proc/40/ns/net']; expect(verifyLinuxInstance(ready,watchdog,f.proc)).toBe(false);
    const g=fixture(); g.files['/proc/40/stat']=g.files['/proc/40/stat']!.replace(' S ',' Z '); expect(verifyLinuxInstance(ready,watchdog,g.proc)).toBe(false);
  });
});
describe('4.5 strict listener set', () => {
  test('exact set and daemon-owned inodes pass, Tor accepted by construction', () => { expect(inspectLinuxNamespace(ready,watchdog,ports,fixture().proc)).toBe(true); });
  for (const mutation of ['extra','missing','ipv6','unowned','hostns','duplicate','unreadable']) test(mutation, () => {
    const f=fixture();
    if(mutation==='extra') f.files['/proc/40/net/tcp']+='\n0: 0100007F:ABCD 0:0 0A 0 0 0 0 0 105';
    if(mutation==='missing') f.files['/proc/40/net/tcp']=f.files['/proc/40/net/tcp']!.split('\n').slice(0,-1).join('\n');
    if(mutation==='ipv6') f.files['/proc/40/net/tcp6']+='0: 00000000000000000000000001000000:232A 0:0 0A 0 0 0 0 0 106';
    if(mutation==='unowned') delete f.links['/proc/40/fd/1'];
    if(mutation==='hostns') f.links['/proc/40/ns/net']='net:host';
    if(mutation==='duplicate') f.files['/proc/40/net/tcp']+='\n'+f.files['/proc/40/net/tcp']!.split('\n')[1];
    if(mutation==='unreadable') delete f.files['/proc/40/net/tcp6'];
    expect(inspectLinuxNamespace(ready,watchdog,ports,f.proc)).toBe(false);
  });
});
describe('4.7 check and remedies', () => {
  for(const code of ['namespace_unavailable','loopback_unavailable','landlock_unavailable','seccomp_unavailable','launcher_hardening_failed','descriptor_sanitize_failed','bridge_unavailable','capabilities_not_dropped','restriction_failed','launcher_exited','no_status_event','unsupported_platform']) test(code, () => {
    expect(linuxConfinementCheck({ok:false,code,detail:'fixed failure'}).ok).toBe(false);
    expect(linuxConfinementRemedy(code, {'/proc/sys/kernel/apparmor_restrict_unprivileged_userns':'1'}, '/managed/bin/zkapi-confine')).not.toBe('');
  });
  test('check requires ABI and every applicable layer', () => {
    expect(linuxConfinementCheck({...ready,ok:true}).ok).toBe(true);
    expect(linuxConfinementCheck({...ready,ok:true,landlockAbi:3}).ok).toBe(false);
    for(const layer of new Set(ready.layers)) expect(linuxConfinementCheck({...ready,ok:true,layers:ready.layers.filter(x=>x!==layer)}).ok).toBe(false);
    for(const layer of ready.stage0Layers) expect(linuxConfinementCheck({...ready,ok:true,stage0Layers:ready.stage0Layers.filter(x=>x!==layer)}).ok).toBe(false);
  });
  test('admin guidance prints root-owned copy and profile, never a sysctl disable', () => {
    const text=linuxConfinementRemedy('namespace_unavailable',{'/proc/sys/kernel/apparmor_restrict_unprivileged_userns':'1'},'/managed/bin/zkapi-confine');
    expect(text).toContain('sudo install'); expect(text).toContain('-o root'); expect(text).toContain('sudo apparmor_parser'); expect(text).not.toContain('userns=0');
  });
  test('Linux x64 selects confinement only when the pinned launcher check passes', async () => {
    let permitted = true; let time = 0;
    const selected = defaultZkapiConfinement({ platform: 'linux', arch: 'x64', now: () => time, launcherIdentity: () => 'fixture-v1', resolveLauncher: () => '/fixture/zkapi-confine', check: () => permitted ? { ...ready, ok: true } : { ok: false, code: 'namespace_unavailable' }, proc: fixture().proc });
    expect(selected.level).toBe('none');
    expect((await selected.check!()).line).toContain('network confinement: ready');
    permitted = false; time += 30_000;
    expect((await selected.check!()).ok).toBe(false);
    expect(selected.level).toBe('none');
    permitted = true; time += 30_000;
    expect((await selected.check!()).ok).toBe(true);
    expect(selected.level).toBe('loopback_filtered');
  });
  test('unsupported Linux and failed host checks never select a weaker route', () => {
    for (const mode of ['arm64', 'missing', 'refused'] as const) {
      const selected = defaultZkapiConfinement({ platform: 'linux', arch: mode === 'arm64' ? 'arm64' : 'x64', launcherIdentity: () => 'fixture-v1', resolveLauncher: () => mode === 'missing' ? undefined : '/fixture', check: () => ({ ok: false, code: 'namespace_unavailable' }) });
      expect(selected.level).toBe('none');
    }
  });
});
describe('4.4 actual watchdog status descriptor', () => {
  test.skipIf(process.platform !== 'linux')('collecting an exited status supervisor cannot close a later listener', async () => {
    const dir=mkdtempSync(join(tmpdir(),'zk-status-gc-'));
    const servers: Server[]=[];
    try {
      const wd=join(dir,'watchdog.cjs'); writeFileSync(wd,WATCHDOG_SCRIPT);
      const script=join(dir,'launcher.cjs');
      writeFileSync(script, `require('node:fs').writeSync(3, ${JSON.stringify('zkapi-confine: '+JSON.stringify(ready)+'\n')});`);
      // Return without retaining the ChildProcess, so its native subprocess can
      // be collected after the closed status descriptor has been reused.
      await (async () => {
        let closed!: () => void;
        const statusClosed=new Promise<void>(resolve=>{closed=resolve;});
        const h=supervise('daemon',wd,[process.execPath,script],process.env,()=>{},()=>{},()=>{},closed);
        const exited=new Promise<void>(resolve=>h.child.once('close',()=>resolve()));
        h.go(); await Promise.all([exited,statusClosed]);
      })();
      for(let i=0;i<32;i+=1){
        const server=createServer(); servers.push(server);
        await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      }
      for(let i=0;i<3;i+=1){Bun.gc(true);await Bun.sleep(10);}
      const listeners=readFileSync('/proc/net/tcp','utf8').split('\n').slice(1).map(line=>line.trim().split(/\s+/)).filter(row=>row[3]==='0A').map(row=>row[1]);
      for(const server of servers){
        const port=(server.address() as {port:number}).port;
        expect(listeners,`listener ${port} survived status-channel GC`).toContain('0100007F:'+port.toString(16).toUpperCase().padStart(4,'0'));
      }
    } finally {
      await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
      rmSync(dir,{recursive:true,force:true});
    }
  },10000);
  for(const mode of ['private','stdout','missing','malformed','refused','exit'] as const) test(mode, async () => {
    const dir=mkdtempSync(join(tmpdir(),'zk-watch-'));
    const wd=join(dir,'watchdog.cjs'); writeFileSync(wd,WATCHDOG_SCRIPT);
    const script=join(dir,'launcher.cjs');
    const event=mode==='refused'?{event:'refused',code:'namespace_unavailable'}:ready;
    writeFileSync(script, `const fs=require('node:fs'); const line=${JSON.stringify('zkapi-confine: '+JSON.stringify(event)+'\n')}; ${mode==='private'||mode==='refused' ? "fs.writeSync(3,line)" : mode==='stdout' ? 'console.log(line)' : mode==='malformed' ? "fs.writeSync(3,'garbage\\n')" : ''}; setTimeout(()=>process.exit(0),100);`);
    const events:unknown[]=[]; const lines:string[]=[];
    const h=supervise('daemon',wd,[process.execPath,script],process.env,l=>lines.push(l),()=>{},e=>events.push(e));
    try {
      const exited=new Promise<void>(r=>h.child.once('exit',()=>r())); h.go(); await exited;
      if(mode==='private'||mode==='refused') expect(events[0]).toMatchObject(event);
      else expect(events.some(e=>(e as {event?:string}).event==='ready')).toBe(false);
      if(mode==='stdout') expect(lines.join('')).toContain('zkapi-confine:');
    } finally { try{process.kill(-h.pgid,'SIGKILL');}catch{} rmSync(dir,{recursive:true,force:true}); }
  },10000);
});


describe('Linux prepared session refuses before dispatch', () => {
  async function prepared() {
    const f=fixture();
    const confinement=linuxZkapiConfinement({platform:'linux',arch:'x64',launcherIdentity: () => 'fixture-v1', resolveLauncher:()=>'/fixture/zkapi-confine',check:()=>({...ready,ok:true}),proc:f.proc,selfTest:async()=>true});
    expect((await confinement.check!()).ok).toBe(true);
    return {f,session:await confinement.prepare!('/fixture',ports)};
  }
  for(const code of ['namespace_unavailable','loopback_unavailable','landlock_unavailable','seccomp_unavailable','launcher_hardening_failed','descriptor_sanitize_failed','bridge_unavailable','capabilities_not_dropped','restriction_failed','launcher_exited']) test(`status refusal ${code}`,async()=>{
    const {session}=await prepared(); session.status({event:'refused',code},watchdog);
    expect(session.ready).toBe(false);expect(session.refusal).toBe(code);
    await expect(session.fetch('http://127.0.0.1:9002/admin/status')).rejects.toThrow('confinement_unavailable');
  });
  test('missing status, duplicate ready, wrong bridge and close refuse',async()=>{
    const a=await prepared();a.session.statusClosed();expect(a.session.refusal).toBe('no_status_event');
    const b=await prepared();b.session.status(ready,watchdog);b.session.status(ready,watchdog);expect(b.session.ready).toBe(false);
    const c=await prepared();c.session.status({...ready,bridgesReach:['9999']},watchdog);expect(c.session.ready).toBe(false);
    const d=await prepared();d.session.status(ready,watchdog);d.session.close();expect(d.session.ready).toBe(false);
  });
  test('key-bearing adapter rechecks strict listener set',async()=>{
    const {f,session}=await prepared();session.status(ready,watchdog);expect(session.ready).toBe(true);
    f.files['/proc/40/net/tcp']+='\n0: 0100007F:ABCD 0:0 0A 0 0 0 0 0 105';
    await expect(session.fetch('http://127.0.0.1:9002/admin/status',{headers:{Authorization:'Bearer fixed-canary'}})).rejects.toThrow('daemon_identity_failed');
  });
  for(const kind of ['missing','arch','check failed'] as const) test(`preflight ${kind}`,async()=>{
    const confinement=linuxZkapiConfinement({platform:'linux',arch:kind==='arch'?'arm64':'x64',launcherIdentity: () => 'fixture-v1', resolveLauncher:()=>kind==='missing'?undefined:'/fixture',check:()=>({ok:false,code:'namespace_unavailable'}),proc:fixture().proc});
    expect((await confinement.check!()).ok).toBe(false);
    await expect(confinement.prepare!('/fixture',ports)).rejects.toThrow('confinement_unavailable');
  });
});
