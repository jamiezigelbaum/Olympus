import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EngineMaintenanceInProgressError,
  withEngineConsultAdmission,
  withEngineMaintenanceFence,
  withEngineMaintenanceFenceSync,
  withEngineWorkerAdmission,
} from '../src/core/engine-maintenance.ts';
import { FileLeaseBusyError } from '../src/core/file-lease.ts';
import {
  recoverZkapiSession,
  zkapiUnresolvedSession,
} from '../src/core/consult-transport-zkapi.ts';
import {
  SLOW,
  completions,
  ledger,
  portFree,
  startConsultInChildProcess,
  statePath,
  transport,
  useZkapiHarness,
  writePlan,
} from './helpers/zkapi-transport-harness.ts';

const MODULE = join(import.meta.dir, '..', 'src', 'core', 'engine-maintenance.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function lineFrom(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}: ${output}`)), 5_000);
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (!output.includes(`${expected}\n`)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`child exited ${code} before ${expected}: ${output}`));
    });
  });
}

async function childExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

describe('engine maintenance admission fence', () => {
  test('the lifecycle fence is held before its in-flight check and rejects a new cross-process admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-maintenance-'));
    roots.push(root);
    const state = join(root, 'zkapi-state.json');
    const release = join(root, 'release');
    const admitted = spawn(process.execPath, ['-e', `
      const { withEngineConsultAdmission } = await import(${JSON.stringify(MODULE)});
      const fs = await import('node:fs');
      await withEngineConsultAdmission(${JSON.stringify(state)}, async () => {
        console.log('admitted');
        while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      });
    `], { stdio: ['ignore', 'pipe', 'inherit'] });
    await lineFrom(admitted, 'admitted');

    withEngineMaintenanceFenceSync(state, (fence) => {
      expect(fence.consultInFlight()).toBe(true);
      const refuse = () => Bun.spawnSync([process.execPath, '-e', `
        const { EngineMaintenanceInProgressError, withEngineConsultAdmission } = await import(${JSON.stringify(MODULE)});
        try {
          await withEngineConsultAdmission(${JSON.stringify(state)}, async () => {}, { acquireTimeoutMs: 50 });
          console.log('admitted');
        } catch (error) {
          console.log(error instanceof EngineMaintenanceInProgressError ? error.code : 'wrong_error');
        }
      `]);
      // The already admitted consult still owns the one-session lease. Either
      // lock independently rejects another session; nothing crosses the fence.
      expect(refuse().stdout.toString().trim()).not.toBe('admitted');
      writeFileSync(release, 'release\n');
      for (let attempt = 0; attempt < 5_000 && fence.consultInFlight(); attempt += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      expect(fence.consultInFlight()).toBe(false);
      const refusedByMaintenance = refuse();
      expect(refusedByMaintenance.exitCode).toBe(0);
      expect(refusedByMaintenance.stdout.toString().trim()).toBe('engine_maintenance_in_progress');
    });
    expect(await childExit(admitted)).toBe(0);

    await expect(withEngineConsultAdmission(state, async () => 'admitted')).resolves.toBe('admitted');
  }, 15_000);

  test('an aborted maintenance callback releases the fence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-maintenance-release-'));
    roots.push(root);
    const state = join(root, 'zkapi-state.json');
    expect(() => withEngineMaintenanceFenceSync(state, () => {
      throw new Error('drain timed out');
    })).toThrow('drain timed out');
    await expect(withEngineConsultAdmission(state, async () => true)).resolves.toBe(true);
  });

  test('the async lifecycle fence rejects consult admission and releases after awaited work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-maintenance-async-'));
    roots.push(root);
    const state = join(root, 'zkapi-state.json');
    await withEngineMaintenanceFence(state, async (fence) => {
      expect(fence.consultInFlight()).toBe(false);
      await expect(withEngineConsultAdmission(state, async () => true, { acquireTimeoutMs: 50 }))
        .rejects.toBeInstanceOf(EngineMaintenanceInProgressError);
      await Bun.sleep(1);
    });
    await expect(withEngineConsultAdmission(state, async () => true)).resolves.toBe(true);
  });

  test('worker preparation is drained by maintenance and may nest the consult admission normally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-maintenance-worker-'));
    roots.push(root);
    const state = join(root, 'zkapi-state.json');
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const preparing = withEngineWorkerAdmission(state, async () => {
      started();
      await releasePromise;
    });
    await startedPromise;

    await withEngineMaintenanceFence(state, async (fence) => {
      expect(fence.consultInFlight()).toBe(true);
      await expect(withEngineWorkerAdmission(state, async () => true, { acquireTimeoutMs: 50 }))
        .rejects.toBeInstanceOf(FileLeaseBusyError);
      release();
      await preparing;
      expect(fence.consultInFlight()).toBe(false);
      await expect(withEngineWorkerAdmission(state, async () => true, { acquireTimeoutMs: 50 }))
        .rejects.toBeInstanceOf(EngineMaintenanceInProgressError);
    });

    await expect(withEngineWorkerAdmission(state, () => (
      withEngineConsultAdmission(state, async () => 'nested')
    ))).resolves.toBe('nested');
  });
});

useZkapiHarness();

describe('engine maintenance settlement recovery', () => {
  test('forced death during settlement keeps the pending fence and recovery is repeat-safe', async () => {
    writePlan({ noSettlement: true });
    const child = startConsultInChildProcess(transport());
    for (let attempt = 0; attempt < 500 && completions().length === 0; attempt += 1) await Bun.sleep(20);
    expect(completions()).toHaveLength(1);
    child.kill('SIGKILL');
    expect(await childExit(child)).toBeNull();
    expect(child.signalCode).toBe('SIGKILL');
    for (let attempt = 0; attempt < 250 && (!await portFree(transport().settings.torSocksPort)); attempt += 1) await Bun.sleep(20);

    expect(zkapiUnresolvedSession(statePath)).toBe(true);
    expect(ledger()).toMatchObject({ count: 1, reservedMicroUsd: 1_000_000 });
    writePlan({ noSettlement: false });
    expect(await recoverZkapiSession(transport())).toMatchObject({
      ok: true,
      receipt: { recovery: true, settlement: 'confirmed', fence: 'clear' },
    });
    expect(zkapiUnresolvedSession(statePath)).toBe(false);
    const afterRecovery = ledger();
    expect(afterRecovery).toMatchObject({ count: 2, reservedMicroUsd: 2_000_000 });

    expect(await recoverZkapiSession(transport())).toMatchObject({
      ok: false,
      error: { code: 'no_unresolved_session', outcome: 'not_sent' },
    });
    expect(ledger()).toMatchObject({
      count: afterRecovery.count,
      reservedMicroUsd: afterRecovery.reservedMicroUsd,
      lastSession: afterRecovery.lastSession,
    });
    expect(completions()).toHaveLength(2);
  }, SLOW);
});

import { stopEngine } from '../src/core/engine-service.ts';
test('lifecycle holds admission before drain; timeout releases it and never sends stop',async()=>{
 const root=mkdtempSync(join(tmpdir(),'svc-drain-'));roots.push(root);const state=join(root,'.olympus/zkapi-consult-state.json');
 const commands:string[][]=[];
 expect(()=>stopEngine({platform:'darwin',homeDir:root,exec:(cmd,args)=>{commands.push([cmd,...args]);return {status:0,stdout:'state = running',stderr:''};},quietWaitMs:0,consultInFlight:()=>({since:'fixture'})})).toThrow('strand its payment');
 expect(commands).toEqual([]);
 await expect(withEngineConsultAdmission(state,async()=>true)).resolves.toBe(true);
 const stopCommands:string[][]=[];
 stopEngine({platform:'darwin',homeDir:root,now:true,exec:(cmd,args)=>{stopCommands.push([cmd,...args]);const refusal=Bun.spawnSync([process.execPath,'-e',`const {withEngineConsultAdmission}=await import(${JSON.stringify(MODULE)});try{await withEngineConsultAdmission(${JSON.stringify(state)},async()=>{});process.exit(2);}catch(e){process.exit(e.code==='engine_maintenance_in_progress'?0:3);}`]);expect(refusal.exitCode).toBe(0);return {status:0,stdout:'state = running',stderr:''};}});
 expect(stopCommands.some(c=>c.includes('bootout'))).toBe(true);
}, 30_000);
