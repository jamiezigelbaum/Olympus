// OLYMPUS_TEST_LANE: deploy
// Omarchy (ordinary user, from this worktree):
// OLYMPUS_ZKAPI_CONFINE_BIN=/absolute/path/to/zkapi-confine bun test test/zkapi-linux-integration.test.ts
// No real provider, wallet or Tor network: stand-in daemon + Tor, REAL launcher,
// production watchdog/status/HTTP/ownership checks and per-session self-test.
// A missing layer must fail either the real self-test or the layer receipt
// assertion: the prototype's ablations are inverted into required properties.
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { linuxZkapiConfinement, sendZkapiConsult } from '../src/core/consult-transport-zkapi.ts';
import { linuxConfinementCheck } from '../src/core/zkapi-confinement-linux.ts';
import { runLinuxConfinementSelfTest } from '../src/core/zkapi-confine-selftest.ts';
import { useZkapiHarness, transport, settings, writePlan, QUESTION, completions, expectProcessesGone, freePorts, root } from './helpers/zkapi-transport-harness.ts';

const launcher=process.env.OLYMPUS_ZKAPI_CONFINE_BIN;
let skipReason: string|undefined;
if(process.platform!=='linux') skipReason='real confinement requires Linux';
else if(!launcher) skipReason='set OLYMPUS_ZKAPI_CONFINE_BIN to the released launcher';
else {
  try {execFileSync(launcher,['check'],{encoding:'utf8',timeout:6000});}
  catch(e) {
    let code=''; try{code=JSON.parse(String((e as {stdout?:unknown}).stdout)).code;}catch{}
    if(['namespace_unavailable','loopback_unavailable'].includes(code)) skipReason=`unprivileged user namespaces unavailable (${code})`;
    // Missing binary, Landlock, seccomp or a malformed check is a failure when opted in.
  }
}
if(skipReason) console.info(`SKIP real launcher integration: ${skipReason}`);
describe('real launcher integrated boundary',()=>{
  useZkapiHarness();
  test.skipIf(Boolean(skipReason))('five real self-tests then an integrated consult pass in one long-lived process',async()=>{
    const probeDir=join(root,'probe');
    mkdirSync(probeDir,{mode:0o700});
    for(let run=1;run<=5;run+=1){
      const [tor,daemon,companionProxy,walletApi]=freePorts(4) as [number,number,number,number];
      const passed=await runLinuxConfinementSelfTest(launcher!,probeDir,process.env,{tor,daemon,companionProxy,walletApi});
      expect(passed,`real self-test ${run} of 5`).toBe(true);
    }
    writePlan({companion:true});
    const confinement=linuxZkapiConfinement({resolveLauncher:()=>launcher!});
    const result=await sendZkapiConsult(QUESTION,transport({confinement,settings:settings({daemonReadyTimeoutMs:15000,timeoutMs:30000})}));
    expect(result.ok).toBe(true);
    if(!result.ok) throw new Error(result.error.code);
    expect(result.receipt.confinementSelfTest).toBe('passed');
    expect(result.receipt.confinement).toBe('loopback_filtered');
    expect(linuxConfinementCheck({...result.receipt.confinementBackend,ok:true}).ok).toBe(true);
    expect(completions()).toHaveLength(1);
    await expectProcessesGone();
  },300000);
});
