/** Fresh-user timing stage; lifecycle restoration remains owned by fresh-install. */
import { FreshInconclusive } from './fresh-install.ts';
import type { Machine } from './machine.ts';
import type { EngineMcp } from './live-accounts.ts';
import type { FreshDashboard } from './fresh-dashboard.ts';
import { openTimingDiagnostics } from './on-demand-machine.ts';
import { openBrowserTimingSeeds } from './on-demand-browser.ts';
import { browserSeedPlan, realTimingSeeds, type TimingAccounts, type TimingSeeds } from './on-demand-seeds.ts';
import { runOnDemandTiming, type OnDemandNotRun, type OnDemandTimingResult, type TimingClock, type TimingDashboard, type TimingDiagnostics } from './on-demand-timing.ts';

export interface FreshTimingOptions {
  accounts?: TimingAccounts;
  clock?: TimingClock;
  /** Machine-free seams; production uses the signed-in browser and read-only probe. */
  seeds?: (machine: Machine, endpoint: string) => Promise<TimingSeeds & { close?(): Promise<void> }>;
  diagnostics?: (machine: Machine) => Promise<TimingDiagnostics>;
}
export async function runFreshOnDemand(machine: Machine, endpoint: string, engine: EngineMcp, dashboard: FreshDashboard,
  options: FreshTimingOptions, sleep: (ms: number) => Promise<void>, browserMachine: Machine = machine): Promise<OnDemandTimingResult> {
  const clock = options.clock ?? { now: Date.now, sleep };
  let result: OnDemandTimingResult = { rows: [], checks: [] };
  let notRun: OnDemandNotRun[] = [];
  let diagnostics: TimingDiagnostics | undefined;
  let seeds: (TimingSeeds & { close?(): Promise<void> }) | undefined;
  try {
    diagnostics = await (options.diagnostics ? options.diagnostics(machine) : openTimingDiagnostics(machine, browserMachine));
    if (!diagnostics.enableSplit) throw new Error('fresh timing diagnostics cannot enable worker.engineSplit');
    await diagnostics.enableSplit();
    const deadline = clock.now() + 300_000;
    let preflight: string;
    for (;;) {
      try { preflight = await diagnostics.preflight(); break; }
      catch (error) { if (clock.now() >= deadline) throw error; await clock.sleep(1000); }
    }
    result.preflight = preflight;
    const drive = { id: 'google_drive', label: 'Google Drive' };
    const connection = await dashboard.connection?.(drive) ?? 'web';
    if (connection === 'web') {
      await dashboard.connect(drive);
      await dashboard.consent(drive);
      await dashboard.callback(drive);
    }
    notRun = connection === 'unavailable' ? browserSeedPlan('google_drive').map(file => ({
      id: file.id, file: file.name, source: file.source, reason: 'product has no web connect for Drive',
    })) : [];
    seeds = options.seeds ? await options.seeds(browserMachine, endpoint) : options.accounts ? await realTimingSeeds(options.accounts) : await openBrowserTimingSeeds(browserMachine, endpoint, connection === 'unavailable' ? ['dropbox'] : ['dropbox', 'google_drive']);
    const folders = (await seeds.folders()).filter(folder => connection !== 'unavailable' || folder.source !== 'google_drive');
    const selected: TimingSeeds = { folders: async () => folders, upload: folder => seeds!.upload(folder) };
    // The real dashboard implements both interfaces. Injected dashboards must supply the same controls.
    const timingDashboard = dashboard as FreshDashboard & TimingDashboard;
    result = await runOnDemandTiming(engine, selected, timingDashboard, diagnostics, clock, true);
  } catch (error) {
    result.checks.push({ id: 'ondemand.setup', title: 'Read-on-demand timing setup', status: error instanceof FreshInconclusive ? 'skip' : 'fail', detail: error instanceof FreshInconclusive ? `Inconclusive: ${error.message}` : String(error) });
  } finally {
    for (const resource of [seeds, diagnostics]) {
      try { await resource?.close?.(); }
      catch (error) { result.checks.push({ id: 'ondemand.cleanup', title: 'Timing resources closed', status: 'fail', detail: String(error) }); }
    }
  }
  if (notRun.length) {
    result.notRun = notRun;
    result.checks.push(...notRun.map(file => ({ id: `ondemand.${file.id}.not-run`, title: `${file.file}: not run`, status: 'skip' as const, detail: `Inconclusive: ${file.reason}` })));
  }
  return result;
}
