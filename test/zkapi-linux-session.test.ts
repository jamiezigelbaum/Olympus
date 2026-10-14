// OLYMPUS_TEST_LANE: deploy
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linuxZkapiConfinement, sendZkapiConsult, zkapiConsultReadiness } from '../src/core/consult-transport-zkapi.ts';
import { useZkapiHarness, root, transport, settings, QUESTION, torRuns, completions, expectNothingReserved, filteredConfinement } from './helpers/zkapi-transport-harness.ts';
useZkapiHarness();
const check={ok:true,landlockAbi:4,layers:['netns','pidns','ipv6-off','caps','nnp','launcher-undumpable','launcher-seccomp','landlock-net','seccomp'],stage0Layers:['nnp','launcher-undumpable','launcher-seccomp']};
for(const code of ['namespace_unavailable','loopback_unavailable','landlock_unavailable','seccomp_unavailable','launcher_hardening_failed','descriptor_sanitize_failed','bridge_unavailable','capabilities_not_dropped','restriction_failed','launcher_exited','no_status_event']) test(`4.7 real supervisor refuses ${code} without moving a key`,async()=>{
  const launcher=join(root,'fake-launcher');
  const report = code === 'no_status_event' ? '' : `printf '%s\\n' 'zkapi-confine: ${JSON.stringify({event:'refused',code})}' >&3\n`;
  writeFileSync(launcher, `#!/bin/sh\n${report}exec sleep 30\n`, {mode:0o700});
  const confinement=linuxZkapiConfinement({platform:'linux',arch:'x64',resolveLauncher:()=>launcher,check:()=>check,selfTest:async()=>true});
  const result=await sendZkapiConsult(QUESTION,transport({confinement,settings:settings({daemonReadyTimeoutMs:2000})}));
  expect(result).toMatchObject({ok:false,error:{code:'confinement_unavailable',outcome:'not_sent',receipt:{confinementFailure:code}}});
  expect(completions()).toHaveLength(0);expectNothingReserved();
},15000);
test('check refusal and self-test failure happen before Tor starts',async()=>{
  const confinement=linuxZkapiConfinement({platform:'linux',arch:'x64',launcherIdentity:()=> 'fixture-v1',resolveLauncher:()=>'/unused',check:()=>({ok:false,code:'landlock_unavailable'})});
  const options=transport({confinement});
  const ready=await zkapiConsultReadiness(options);
  expect(ready.confinement.checkLine).toContain('Linux 6.7');
  expect((await sendZkapiConsult(QUESTION,options))).toMatchObject({ok:false,error:{code:'confinement_unavailable'}});
  expect(torRuns()).toHaveLength(0);
  const failed=linuxZkapiConfinement({platform:'linux',arch:'x64',launcherIdentity:()=> 'fixture-v1',resolveLauncher:()=>'/unused',check:()=>check,selfTest:async()=>false});
  expect(await sendZkapiConsult(QUESTION,transport({confinement:failed}))).toMatchObject({ok:false,error:{code:'confinement_self_test_failed'}});
  expect(torRuns()).toHaveLength(0);
});
test('prepared fetch owns health, authenticated checks and final dispatch; closes after teardown',async()=>{
  const paths:string[]=[];let closed=false;
  const confinement={...filteredConfinement,prepare:async()=>({
    wrap:(argv:readonly string[])=>[...argv],status:()=>{},statusClosed:()=>{},ready:true,refusal:undefined,backend:undefined,
    fetch:(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{paths.push(new URL(String(input)).pathname);return fetch(input,init);}) as typeof fetch,
    verifyInstance:()=>true,inspect:()=>true,close:()=>{closed=true;},
  })};
  const result=await sendZkapiConsult(QUESTION,transport({confinement,fetchImpl:(async()=>{throw new Error('ambient fetch must not run');}) as unknown as typeof fetch}));
  expect(result.ok).toBe(true);expect(paths).toContain('/admin/status');expect(paths).toContain('/v1/chat/completions');expect(closed).toBe(true);
});
