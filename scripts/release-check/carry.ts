/**
 * Keeping a tested run's results for the legs a change cannot reach (impact.ts). The new run provisions a fresh machine,
 * installs the exact candidate and runs every leg the change reaches; each check, agent and part absent from it comes
 * from the tested run, marked with that run, so a kept failure still fails and a kept pass says where it came from.
 */
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentReport, CarriedFrom, CheckResult, MachineReport, ReleaseReport } from './report.ts';

/** The tested report, refused unless it can stand as evidence for the legs it lends: one plain run, pinned to its own commit. */
export function loadCarryBase(path: string, candidateSha: string | undefined): ReleaseReport {
  if (!existsSync(path)) throw new Error(`--carry-from ${path} does not exist`);
  const base = JSON.parse(readFileSync(path, 'utf8')) as ReleaseReport;
  if (base.schema !== 'olympus.release-check.report.v1') throw new Error('--carry-from is not a release-check report');
  if (!candidateSha) throw new Error('--carry-from needs the candidate\'s --sha, so the change between the two commits is known');
  if (base.harness?.relation !== 'same-commit' || !base.candidate.sha) throw new Error('--carry-from needs a report whose harness was its candidate\'s own commit');
  if (base.candidate.sha === candidateSha) throw new Error('--carry-from names a run of this same commit; run it again in full instead');
  if (base.selfTest) throw new Error('--carry-from names a self-test, whose results are planted failures');
  if (base.machines.length !== 1 || base.machines[0]!.upgrade) throw new Error('--carry-from needs a plain run on one machine (not an upgrade run)');
  const machine = base.machines[0]!;
  if (![...machine.checks, ...machine.agents].some((item) => item.leg)) throw new Error('--carry-from names a report that does not say which leg made each result; run in full once');
  // A leg the run never reached is recorded only in `errors` (a spent time budget), so a base with errors could lend
  // results that do not exist and turn its fail into a pass (Codex on #635).
  if (base.errors.length > 0) throw new Error(`--carry-from names a run that did not finish cleanly (${base.errors[0]}); run in full instead`);
  return base;
}

const mark = (check: CheckResult, from: CarriedFrom): CheckResult => ({ ...check, carried: check.carried ?? from });
const markAgent = (agent: AgentReport, from: CarriedFrom): AgentReport => ({ ...agent, carried: agent.carried ?? from, checks: agent.checks.map((check) => mark(check, from)) });

/**
 * Adds the tested run's results for the legs this run skipped (`carried`) to `machine`, in place, by the leg that
 * made each one: a check the rerun leg no longer emits (a failure-only check it now passes) is not kept. Returns
 * the parts (besides checks and agents) that were kept.
 */
export function carryInto(machine: MachineReport, base: MachineReport, from: CarriedFrom, carried: readonly string[]): string[] {
  if (machine.os !== base.os) throw new Error(`--carry-from is a ${base.os} run; this run is on ${machine.os}`);
  const skipped = (leg: string | undefined): boolean => leg !== undefined && carried.includes(leg);
  const ran = new Set(machine.checks.map((check) => check.id));
  for (const check of base.checks) if (skipped(check.leg) && !ran.has(check.id)) machine.checks.push(mark(check, from));
  for (const agent of base.agents) {
    if (!skipped(agent.leg)) continue;
    const at = machine.agents.findIndex((a) => a.id === agent.id);
    if (at === -1) machine.agents.push(markAgent(agent, from));
    else if (!machine.agents[at]!.ran && machine.agents[at]!.skipReason === 'skipped by option') machine.agents[at] = markAgent(agent, from);
  }
  const parts: string[] = [];
  const traces = (base.traces ?? []).filter((trace) => skipped(trace.leg));
  if (traces.length > 0) { machine.traces = [...(machine.traces ?? []), ...traces]; parts.push('step traces'); }
  if (carried.includes('journeys') && !machine.visual && base.visual) { machine.visual = base.visual; parts.push('screen comparisons'); }
  if (carried.includes('explore') && !machine.explore && base.explore) { machine.explore = base.explore; parts.push('control exploration'); }
  // The Inbox leg adds its own pictures to the same list, so the tested run's are merged in by path (Codex on #635).
  if (carried.includes('screenshots')) {
    const have = new Set(machine.screenshots.map((shot) => shot.path));
    const kept = base.screenshots.filter((shot) => !have.has(shot.path));
    if (kept.length > 0) { machine.screenshots = [...machine.screenshots, ...kept]; parts.push('dashboard screenshots'); }
  }
  return parts;
}

/** The kept results link pictures in the tested run's folder: they are copied beside the new report, never over its own files. */
export function copyCarriedFiles(baseReportPath: string, outDir: string): void {
  const baseDir = dirname(baseReportPath);
  for (const entry of readdirSync(baseDir)) {
    if (entry === 'report.json' || entry === 'report.html' || entry === 'logs') continue;
    cpSync(join(baseDir, entry), join(outDir, entry), { recursive: true, force: false, errorOnExist: false });
  }
}
