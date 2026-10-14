import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineServicePaths, installEngine, rollbackEngine, type EngineExec, type EngineLifecycleCheckpoint } from '../../src/core/engine-service.ts';
import { linuxEngineEnvironment, resolveLinuxEngineLayout } from '../../src/core/linux-engine-layout.ts';
import { recoverInterruptedLinuxEngineInstall, settleLinuxEngineInstall } from '../../src/core/linux-engine-service.ts';

const root=process.env.CRASH_ROOT!;
const action=process.env.CRASH_ACTION!;
const target=process.env.CRASH_CHECKPOINT as EngineLifecycleCheckpoint|undefined;
const home=join(root,'home'),runtimeHome=join(root,'run');
mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(runtimeHome,{recursive:true,mode:0o700});
const env={HOME:home,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),XDG_RUNTIME_DIR:runtimeHome};
const layout=resolveLinuxEngineLayout(env);
const version=process.env.CRASH_VERSION??'1.0.0',source=join(root,`source-${version}`),runtime=join(root,'runtime','bun');
if(!existsSync(source)){mkdirSync(join(source,'dist'),{recursive:true,mode:0o700});writeFileSync(join(source,'package.json'),JSON.stringify({name:'olympus',version,olympus:{linuxApprovalTransport:'owner-unix-socket-v1',linuxStateCompatibility:1,linuxSettingsLayout:'receipt-v1'}}));writeFileSync(join(source,'dist/cli.js'),`// crash fixture ${version}\n`);mkdirSync(join(source,'assets'));writeFileSync(join(source,'assets/app-icon.png'),Buffer.concat([readFileSync(join(import.meta.dir,'../../assets/app-icon.png')),Buffer.from(version)]));}
if(!existsSync(runtime)){mkdirSync(join(root,'runtime'),{recursive:true,mode:0o700});writeFileSync(runtime,'#!/bin/sh\nexit 0\n',{mode:0o700});chmodSync(runtime,0o700);}
const managerPath=join(root,'manager.json');
type Manager={linked:boolean;active:boolean;enabled:boolean;linger:boolean};
const readManager=():Manager=>{try{return JSON.parse(readFileSync(managerPath,'utf8'));}catch{return {linked:false,active:false,enabled:false,linger:false};}};
const writeManager=(state:Manager)=>writeFileSync(managerPath,JSON.stringify(state));
const good=(stdout='')=>({status:0,stdout,stderr:''});
const identity={platform:'linux' as const,mechanism:'linux_procfs_start_ticks' as const,startTime:'123'};
const writeHealth=()=>{try{const current=JSON.parse(readFileSync(join(layout.stateDir,'service-current.json'),'utf8')),now=new Date().toISOString();const paths=engineServicePaths({platform:'linux',homeDir:home,env:linuxEngineEnvironment(layout)});mkdirSync(join(paths.statusPath,'..'),{recursive:true,mode:0o700});writeFileSync(paths.statusPath,JSON.stringify({schema:'olympus.engine.status.v1',state:'running',build:current.program.build,pid:42,process_identity:identity,started_at:now,updated_at:now,services:{'olympus-worker':{state:'ok'}}}));}catch{}};
const exec:EngineExec=(command,args)=>{
 const state=readManager();
 if(command==='systemctl'&&args[0]==='--version')return good('systemd 256\n');
 if(command==='loginctl'){
  if(args[0]==='show-user')return good(state.linger?'yes\n':'no\n');
  if(args.includes('enable-linger')){state.linger=true;writeManager(state);return good();}
 }
 if(command==='systemd-analyze')return good();
 if(args.includes('olympus-worker.service'))return good('LoadState=not-found\n');
 if(args.includes('--property=Version'))return good('256\n');
 if(args.includes('show'))return state.linked?good(`LoadState=loaded\nActiveState=${state.active?'active':'inactive'}\nUnitFileState=${state.enabled?'enabled':'disabled'}\nMainPID=${state.active?42:0}\nControlGroup=${state.active?'/user.slice/engine':''}\nResult=success\nExecMainStatus=0\nFragmentPath=${layout.unitPath}\n`):good('LoadState=not-found\n');
 if(args.includes('daemon-reload'))state.linked=existsSync(layout.unitPath);
 if(args.includes('link'))state.linked=true;
 if(args.includes('enable'))state.enabled=true;
 if(args.includes('disable')){state.enabled=false;state.active=false;}
 if(args.includes('stop'))state.active=false;
 if(args.includes('start')||args.includes('restart')){state.active=true;writeHealth();}
 writeManager(state);return good();
};
const checkpoint=(name:EngineLifecycleCheckpoint)=>{if(name==='current_published')writeHealth();if(name===target)process.kill(process.pid,'SIGKILL');};
const options={platform:'linux',homeDir:home,env:linuxEngineEnvironment(layout),uid:process.getuid!(),exec,fromCheckout:source,bunBin:runtime,
 consultInFlight:()=>undefined,cgroupEmpty:()=>true,workerStopped:()=>true,lifecycleCheckpoint:checkpoint,notice:()=>{},
 health:{timeoutMs:0,pidAlive:()=>true,pidInCgroup:()=>true,processIdentity:()=>identity,fetchImpl:(async()=>new Response('ok')) as unknown as typeof fetch}};

if(action==='recover'){await recoverInterruptedLinuxEngineInstall(options);process.exit(0);}
if(action==='repair')await recoverInterruptedLinuxEngineInstall(options);
if(action==='rollback'){const result=await rollbackEngine(options);process.exit(result.ok?0:1);}
const result=installEngine(options);
await settleLinuxEngineInstall(options,{ok:true,expected_build:result.program.build??null,running_build:result.program.build??null,pid:42,worker:'ok',waited_ms:0});
