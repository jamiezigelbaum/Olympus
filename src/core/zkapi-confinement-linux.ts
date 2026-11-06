/** Checked Linux confinement; no available launcher means no anonymous route. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat as fileStat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { managedToolExecutable, managedToolsRoot, MANAGED_TOOL_PINS, ZKAPI_CONFINE_SHA256 } from './managed-tools.ts';
import { linuxConfinementFetch } from './zkapi-confine-fetch.ts';
import { runLinuxConfinementSelfTest } from './zkapi-confine-selftest.ts';
import type { ZkapiConfinement, ZkapiConfinementPorts } from './consult-transport-zkapi.ts';

export interface LinuxBackend { kind: 'linux_netns'; landlockAbi: number; layers: string[]; stage0Layers: string[] }
export interface LinuxReady extends Omit<LinuxBackend, 'kind'> {
  event: 'ready'; stage0Pid: number; stage0Start: string; stage1Pid: number; stage1Start: string;
  daemonPid: number; daemonStart: string; apiToken: string; bridgesExpose: string[]; bridgesReach: string[];
}
export type LinuxEvent = LinuxReady | { event: 'refused'; code: string; detail?: string } | { event: 'launcher_exited' };
export interface LinuxProc { read(path: string): string; link(path: string): string; list(path: string): string[] }
const realProc: LinuxProc = { read: p => readFileSync(p,'utf8'), link: readlinkSync, list: p => readdirSync(p) };
export interface LinuxWatchdog { pid: number; startTime: string }
export interface ZkapiPreparedConfinement {
  wrap(argv: readonly string[]): string[];
  status(event: LinuxEvent, watchdog: LinuxWatchdog | undefined): void;
  statusClosed(): void;
  readonly ready: boolean;
  readonly refusal: string | undefined;
  readonly backend: LinuxBackend | undefined;
  readonly fetch: typeof fetch;
  verifyInstance(): boolean;
  inspect(): boolean;
  close(): void;
}
export type LinuxCheck = ({ ok: true } & LinuxBackend) | { ok: false; code: string; detail?: string };

function record(value: unknown): Record<string,unknown> | undefined { return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined; }
export function linuxConfinementCheck(value: unknown): LinuxCheck {
  const v=record(value);
  if (!v || v.ok!==true) return {ok:false,code: typeof v?.code==='string' ? v.code : 'no_status_event', ...(typeof v?.detail==='string'?{detail:v.detail.slice(0,512)}:{})};
  const abi=v.landlockAbi;
  if (!Number.isInteger(abi) || (abi as number)<4) return {ok:false,code:'landlock_unavailable'};
  const required=['netns','pidns','ipv6-off','caps','nnp','launcher-undumpable','launcher-seccomp','landlock-net','seccomp', ...((abi as number)>=6?['landlock-scope']:[]), ...((abi as number)>=8?['launcher-landlock']:[]), ...((abi as number)>=9?['landlock-unix']:[])];
  const stage0=['nnp','launcher-undumpable','launcher-seccomp',...((abi as number)>=8?['launcher-landlock']:[])];
  const has=(v:unknown, wants:string[]): v is string[] => Array.isArray(v) && v.every(x=>typeof x==='string') && wants.every(x=>v.includes(x));
  if(!has(v.layers,required)||!has(v.stage0Layers,stage0)) return {ok:false,code:'restriction_failed'};
  return {ok:true,kind:'linux_netns',landlockAbi:abi as number,layers:[...v.layers],stage0Layers:[...v.stage0Layers]};
}
export function parseLinuxStatus(line: string): LinuxEvent | undefined {
  if(!line.startsWith('zkapi-confine: ')) return undefined;
  try {
    const v=record(JSON.parse(line.slice(15))); if(!v) return undefined;
    if(v.event==='refused' && typeof v.code==='string') return {event:'refused',code:v.code};
    if(v.event==='launcher_exited') return {event:'launcher_exited'};
    if(v.event!=='ready' || !linuxConfinementCheck({...v,ok:true}).ok) return undefined;
    if(!['stage0Pid','stage1Pid','daemonPid'].every(k=>Number.isSafeInteger(v[k])&&(v[k] as number)>1)) return undefined;
    if(!['stage0Start','stage1Start','daemonStart'].every(k=>typeof v[k]==='string'&&/^\d+$/.test(v[k] as string))) return undefined;
    if(typeof v.apiToken!=='string'||!/^[a-f0-9]{64}$/.test(v.apiToken)) return undefined;
    if(!Array.isArray(v.bridgesExpose)||!Array.isArray(v.bridgesReach)) return undefined;
    return v as unknown as LinuxReady;
  }catch{return undefined;}
}
function stat(pid:number, proc:LinuxProc) {
  const s=proc.read(`/proc/${pid}/stat`); const f=s.slice(s.lastIndexOf(')')+1).trim().split(/\s+/);
  if(!/^\d+$/.test(f[19]??'')||f[0]==='Z'||f[0]==='X') throw new Error('dead instance');
  return {parent:Number(f[1]),start:f[19]!};
}
function depth(pid:number,proc:LinuxProc):number[] {
  const line=/^NSpid:\s*(.+)$/m.exec(proc.read(`/proc/${pid}/status`));
  if(!line) throw new Error('missing namespace depth');
  return line[1]!.trim().split(/\s+/).map(Number);
}
export function verifyLinuxInstance(e:LinuxReady, w:LinuxWatchdog, proc:LinuxProc=realProc):boolean {
  try {
    if(new Set([w.pid,e.stage0Pid,e.stage1Pid,e.daemonPid]).size!==4) return false;
    const wd=stat(w.pid,proc), s0=stat(e.stage0Pid,proc), s1=stat(e.stage1Pid,proc), d=stat(e.daemonPid,proc);
    if(wd.start!==w.startTime||s0.start!==e.stage0Start||s1.start!==e.stage1Start||d.start!==e.daemonStart) return false;
    if(s0.parent!==w.pid||s1.parent!==e.stage0Pid||d.parent!==e.stage1Pid) return false;
    const n0=depth(e.stage0Pid,proc), n1=depth(e.stage1Pid,proc), nd=depth(e.daemonPid,proc);
    if(n0.length!==1||n0[0]!==e.stage0Pid||n1.length!==2||n1[0]!==e.stage1Pid||n1[1]!==1||nd.length!==2||nd[0]!==e.daemonPid||nd[1]!<2) return false;
    return ['net','pid'].every(ns=>proc.link(`/proc/${e.daemonPid}/ns/${ns}`)!==proc.link(`/proc/self/ns/${ns}`));
  }catch{return false;}
}
export function inspectLinuxNamespace(e:LinuxReady,w:LinuxWatchdog,ports:ZkapiConfinementPorts,proc:LinuxProc=realProc):boolean {
  try {
    if(!verifyLinuxInstance(e,w,proc)) return false;
    const wanted=[ports.tor,ports.daemon,ports.companionProxy,ports.walletApi];
    const rows:Array<{port:number;inode:string}>=[];
    for(const table of ['tcp','tcp6']) {
      for(const line of proc.read(`/proc/${e.daemonPid}/net/${table}`).split('\n').slice(1)) {
        if(!line.trim()) continue;
        const f=line.trim().split(/\s+/); if(f[3]!=='0A') continue;
        if(table==='tcp6'||f.length<10||!/^\d+$/.test(f[9]!)||f[9]==='0') return false;
        const [address,port]=f[1]!.split(':');
        // Wildcard on an allowed port is a documented, namespace-local residual.
        if(!['0100007F','00000000'].includes(address!)) return false;
        rows.push({port:parseInt(port!,16),inode:f[9]!});
      }
    }
    if(rows.length!==4||new Set(rows.map(r=>r.port)).size!==4||wanted.some(p=>!rows.some(r=>r.port===p))) return false;
    const inodes=new Set(rows.filter(r=>r.port!==ports.tor).map(r=>r.inode));
    const seen=new Set<string>(); const netns=proc.link(`/proc/${e.daemonPid}/ns/net`);
    for(const name of proc.list('/proc')) {
      if(!/^\d+$/.test(name)) continue;
      const pid=Number(name);
      try {
        if(proc.link(`/proc/${pid}/ns/net`)!==netns) continue;
        // Only the daemon tree may hold the three API listeners. Setsid is fine.
        let parent=pid; const visited=new Set<number>();
        while(parent!==e.daemonPid&&!visited.has(parent)&&parent>1) {visited.add(parent);parent=stat(parent,proc).parent;}
        if(parent!==e.daemonPid) continue;
        for(const fd of proc.list(`/proc/${pid}/fd`)) {
          try{const m=/^socket:\[(\d+)\]$/.exec(proc.link(`/proc/${pid}/fd/${fd}`));if(m&&inodes.has(m[1]!)) seen.add(m[1]!);}catch{}
        }
      }catch{}
    }
    return seen.size===inodes.size && verifyLinuxInstance(e,w,proc);
  }catch{return false;}
}
const shellQuote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
export function linuxConfinementRemedy(code:string, sysctls:Record<string,string>, launcher:string):string {
  if(code==='landlock_unavailable') return 'Needs Linux 6.7 or newer with Landlock enabled.';
  if(['namespace_unavailable','loopback_unavailable'].includes(code)) {
    if(sysctls['/proc/sys/kernel/apparmor_restrict_unprivileged_userns']?.trim()==='1') return `One step needs an administrator. Ubuntu blocks the isolated network space used for private answers. These commands allow only an administrator-owned copy of the helper. Answers remain unavailable until the checks pass.\n\nsudo install -D -m 0755 -o root -g root ${shellQuote(launcher)} /usr/local/libexec/olympus/zkapi-confine\nsudo tee /etc/apparmor.d/olympus-zkapi-confine >/dev/null <<'EOF'\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile olympus-zkapi-confine /usr/local/libexec/olympus/zkapi-confine flags=(unconfined) {\n  userns,\n  include if exists <local/olympus-zkapi-confine>\n}\nEOF\nsudo apparmor_parser -r /etc/apparmor.d/olympus-zkapi-confine\n\nThen ask Olympus again. To undo: sudo apparmor_parser -R /etc/apparmor.d/olympus-zkapi-confine && sudo rm /etc/apparmor.d/olympus-zkapi-confine /usr/local/libexec/olympus/zkapi-confine`;
    for(const p of ['/proc/sys/user/max_user_namespaces','/proc/sys/kernel/unprivileged_userns_clone']) if(sysctls[p]?.trim()==='0') return `${p} is 0. Anonymous answers are unavailable on this computer.`;
    return 'This environment does not allow the required isolated network space. Anonymous answers are unavailable on this computer.';
  }
  return 'The private-answer helper could not establish its protections. Anonymous answers are unavailable on this computer.';
}

// The archive pin authenticates this digest; checked again at every session.

async function launcherPath(env:NodeJS.ProcessEnv):Promise<string|undefined> {
  const daemon=managedToolExecutable('zkapi-clientd',{env,platform:'linux',arch:'x64'});
  const managed=daemon?join(dirname(daemon),'zkapi-confine'):undefined;
  const system='/usr/local/libexec/olympus/zkapi-confine';
  for(const path of [system,managed]) {
    if(!path) continue;
    try {
      if(realpathSync(path)!==path) continue;
      let current=path;
      while(true) {
        const s=lstatSync(current); if(s.isSymbolicLink()||(s.mode&0o022)!==0||(path===system?s.uid!==0:s.uid!==0&&s.uid!==process.getuid?.())) throw new Error('untrusted path');
        if(current==='/')break;current=dirname(current);
      }
      if(!lstatSync(path).isFile() || createHash('sha256').update(await readFile(path)).digest('hex')!==ZKAPI_CONFINE_SHA256) continue;
      return path;
    }catch{}
  }
  return undefined;
}
export interface LinuxConfinementDependencies {
  platform?:NodeJS.Platform; arch?:string; env?:NodeJS.ProcessEnv;
  resolveLauncher?():string|undefined|Promise<string|undefined>;
  /** Test seams for synthetic launchers and the cache expiry clock. */
  launcherIdentity?(launcher:string):string|Promise<string>;
  now?():number;
  check?(launcher:string):unknown;
  selfTest?(launcher:string,dir:string,env:NodeJS.ProcessEnv,ports:ZkapiConfinementPorts):Promise<boolean>;
  proc?:LinuxProc;
}
const execFileAsync = promisify(execFile);
const CHECK_TTL_MS = 30_000;
type CheckEntry = { result: Promise<LinuxCheck>; expires: number };
const hostChecks = new Map<string, CheckEntry>();
// Injected executors have their own cache; production shares one process cache.
const injectedChecks = new WeakMap<NonNullable<LinuxConfinementDependencies['check']>, Map<string, CheckEntry>>();
async function launcherIdentity(path:string):Promise<string> {
  const info = await fileStat(path);
  if (!info.isFile()) throw new Error('not a launcher');
  const hash = createHash('sha256').update(await readFile(path)).digest('hex');
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode, hash].join(':');
}
/** Selection and each session require a trusted launcher and a passing host check. */
export function linuxZkapiConfinement(deps:LinuxConfinementDependencies={}):ZkapiConfinement {
  const env=deps.env??process.env; const proc=deps.proc??realProc;
  const now=deps.now??Date.now;
  const identity=deps.launcherIdentity??launcherIdentity;
  const resolve=deps.resolveLauncher??(()=>launcherPath(env));
  let cache=hostChecks;
  if(deps.check) {
    cache=injectedChecks.get(deps.check)??new Map();
    injectedChecks.set(deps.check,cache);
  }
  let check:LinuxCheck={ok:false,code:'confinement_unavailable'};
  let launcher:string|undefined;
  const refresh=async():Promise<LinuxCheck>=>{
    if((deps.platform??process.platform)!=='linux'||(deps.arch??process.arch)!=='x64') return check={ok:false,code:'unsupported_platform'};
    try {
      const selected=await resolve();
      if(!selected) return check={ok:false,code:'launcher_missing_or_untrusted'};
      const before=await identity(selected);
      const key=selected+'\0'+before;
      let entry=cache.get(key);
      if(!entry || now()>=entry.expires) {
        const created:CheckEntry={expires:Infinity,result:Promise.resolve({ok:false,code:'no_status_event'})};
        created.result=(async():Promise<LinuxCheck>=>{
          try {
            if(deps.check) return linuxConfinementCheck(await deps.check(selected));
            const args={env,encoding:'utf8' as const,timeout:5000,maxBuffer:64*1024};
            try {
              const version=await execFileAsync(selected,['--version'],args);
              if(version.stdout.trim()!==`zkapi-confine ${MANAGED_TOOL_PINS['zkapi-clientd'].version}`) return {ok:false,code:'launcher_missing_or_untrusted'};
            } catch {return {ok:false,code:'launcher_missing_or_untrusted'};}
            return linuxConfinementCheck(JSON.parse((await execFileAsync(selected,['check'],args)).stdout));
          } catch(e) {
            try {return linuxConfinementCheck(JSON.parse(String((e as {stdout?:unknown}).stdout)));}
            catch {return {ok:false,code:'no_status_event'};}
          } finally {created.expires=now()+CHECK_TTL_MS;}
        })();
        cache.set(key,created); entry=created;
        if(cache.size>64) cache.delete(cache.keys().next().value!);
      }
      const result=await entry.result;
      // Do not publish a cached or in-flight success after replacement/removal,
      // or after the selected path loses its ownership/permission trust.
      if(await resolve()!==selected || await identity(selected)!==before) {
        cache.delete(key);
        return check={ok:false,code:'launcher_missing_or_untrusted'};
      }
      launcher=selected;
      return check=result;
    } catch {return check={ok:false,code:'launcher_missing_or_untrusted'};}
  };
  return {
    get level() { return check.ok ? 'loopback_filtered' : 'none'; }, limit:'Linux network isolation is checked before each session.',
    wrap:()=>{throw new Error('Linux requires a prepared session');},
    check:async()=>{
      const result=await refresh(); const sysctls:Record<string,string>={};
      for(const p of ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns','/proc/sys/user/max_user_namespaces','/proc/sys/kernel/unprivileged_userns_clone'])try{sysctls[p]=proc.read(p);}catch{}
      const line=result.ok?`network confinement: ready (user, network and PID namespace, Landlock ABI ${result.landlockAbi}, seccomp)`:`network confinement: unavailable: ${result.code}; ${linuxConfinementRemedy(result.code,sysctls,launcher??join(managedToolsRoot({env,platform:'linux',arch:'x64'})??'/unavailable/olympus/tools','zkapi-clientd',MANAGED_TOOL_PINS['zkapi-clientd'].version,'bin','zkapi-confine'))}`;
      return {ok:result.ok,line, ...(!result.ok && result.code === 'launcher_missing_or_untrusted' ? {installRequired:true} : {})};
    },
    selfTest:async(dir,childEnv,ports)=> Boolean((await refresh()).ok && launcher && await (deps.selfTest??runLinuxConfinementSelfTest)(launcher,dir,childEnv,ports)),
    prepare:async(dir,ports)=>{
      if(!(await refresh()).ok||!launcher) throw new Error('confinement_unavailable');
      const selected=launcher;
      const nums=[ports.tor,ports.daemon,ports.companionProxy,ports.walletApi];
      if(nums.some(n=>!Number.isInteger(n)||n!<1||n!>65535)||new Set(nums).size!==4) throw new Error('invalid ports');
      let event:LinuxReady|undefined; let wd:LinuxWatchdog|undefined; let refusal:string|undefined; let closed=false;
      const verify=()=>!closed&&!refusal&&!!event&&!!wd&&verifyLinuxInstance(event,wd,proc);
      const session:ZkapiPreparedConfinement={
        wrap:argv=>[selected,'run','--dir',dir,'--status-fd','3','--expose',`api=${ports.daemon}`,'--reach',`${ports.tor}=${ports.tor}`,...nums.flatMap(p=>['--connect-port',String(p)]),...nums.slice(1).flatMap(p=>['--bind-port',String(p)]),'--',...argv],
        status:(e,w)=>{
          if(closed||refusal)return;
          if(e.event!=='ready'){refusal=e.event==='refused'?e.code:'launcher_exited';return;}
          if(event||!w||!linuxConfinementCheck({...e,ok:true}).ok||!verifyLinuxInstance(e,w,proc)||JSON.stringify(e.bridgesExpose)!=='["api"]'||JSON.stringify(e.bridgesReach)!==JSON.stringify([String(ports.tor)])){refusal='instance_binding_failed';return;}
          event=structuredClone(e);wd={...w};
        },
        statusClosed:()=>{refusal??=event?'launcher_exited':'no_status_event';},
        get ready(){return verify();},get refusal(){return refusal;},
        get backend(){return event?{kind:'linux_netns' as const,landlockAbi:event.landlockAbi,layers:[...event.layers],stage0Layers:[...event.stage0Layers]}:undefined;},
        fetch:(async(input,init)=>{
          if(!verify())throw new Error('confinement_unavailable');
          if(!session.inspect())throw new Error('daemon_identity_failed');
          const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
          if(url.origin!==`http://127.0.0.1:${ports.daemon}`)throw new Error('wrong daemon origin');
          return linuxConfinementFetch(join(dir,'api.sock'),event!.apiToken)(input,init);
        }) as typeof fetch,
        verifyInstance:verify,inspect:()=>verify()&&inspectLinuxNamespace(event!,wd!,ports,proc),
        close:()=>{closed=true;event=undefined;wd=undefined;},
      };
      return session;
    },
  };
}
