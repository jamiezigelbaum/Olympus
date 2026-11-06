/**
 * The release check's report: a JSON document and one static HTML page, built
 * from the same data. Pass/fail per check, per machine, per agent, with
 * timings, screenshots and log links. Only synthetic fixture text and counts go
 * in; the leak scan runs over the finished report text before it is written.
 */
import { findLeaks, type LeakFinding, type LeakMarker } from './leak.ts';
import type { Difference } from './upgrade.ts';
import type { JourneyTrace } from './journey.ts';
import type { VisualResult } from './visual.ts';
import type { ExploreResult } from './explore.ts';
import type { PagesResult } from './explore-pages.ts';
import type { ReviewResult } from './reviewer.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  ms?: number;
  /** Set on a result kept from an earlier run of a commit this candidate's change cannot reach (impact.ts, `--carry-from`). */
  carried?: CarriedFrom;
  /** The leg that produced it (run.ts inLeg); absent for the install and setup checks every run makes. */
  leg?: string;
}

/** The tested run a result was kept from. */
export interface CarriedFrom { runId: string; sha: string }

/** What an agent's run cost in calls, so shared subscription limits and per-call bills stay visible. */
export interface AgentUsage {
  /** Command-line or API invocations made for the suite. */
  invocations: number;
  /** Model requests behind them (turns for Claude Code, API requests for xAI, tool calls plus one per question for Codex). */
  modelCalls: number;
  /** Tool calls the engine's MCP endpoint answered for this agent. */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Billing basis, for example "ChatGPT subscription" or "per-call API". */
  billing: string;
}

export interface AgentReport {
  id: string;
  label: string;
  kind: 'protocol' | 'model';
  /**
   * The harness's own scripted agent (no model, nothing billed): it asks the product one question so a surface can be checked, but
   * it does not count as an agent that asked the suite, so it cannot keep a run with every real agent skipped from failing.
   */
  scripted?: boolean;
  usage?: AgentUsage;
  /** `skipped` when the agent could not run at all (for example, its API key is missing). */
  ran: boolean;
  skipReason?: string;
  checks: CheckResult[];
  carried?: CarriedFrom;
  leg?: string;
}

export interface ReportFile {
  label: string;
  /** Path relative to the report page, so the report folder can move as a unit. */
  path: string;
  width?: number;
  theme?: 'light' | 'dark';
}

/** One stage of an upgrade run on the same machine: what was checked while the earlier release was installed. */
export interface PhaseReport {
  id: string;
  label: string;
  /** Version and build the installed engine reported during this phase, when known. */
  version?: string;
  build?: string;
  timings: Record<string, number>;
  checks: CheckResult[];
  agents: AgentReport[];
  screenshots: ReportFile[];
  logs: ReportFile[];
}

/**
 * Present only when the run installed an earlier release and updated it the way a user does. The machine's own
 * `checks`, `agents`, `screenshots` and `logs` are then the stage AFTER the update; this holds the stage before it
 * and the update itself.
 */
export interface UpgradeReport {
  /** The stage before the update: the earlier release installed fresh, set up, loaded with the test life, asked the suite. */
  from: PhaseReport;
  /** The update and its comparisons (version, privacy migration, data and settings kept). */
  step: { label: string; checks: CheckResult[]; differences: Difference[] };
  /** Label of the stage after the update, which the machine's own fields hold. */
  afterLabel: string;
  afterVersion?: string;
}

export interface MachineReport {
  id: string;
  label: string;
  os: string;
  driver: string;
  /** Build string the installed engine reported, when known. */
  build?: string;
  /** Wall-clock milliseconds per phase (provision, install, ingest, suite, screenshots, teardown). */
  timings: Record<string, number>;
  /** Checks about the machine itself: install, tiers, ingest settle, dashboard, leak scans. */
  checks: CheckResult[];
  agents: AgentReport[];
  screenshots: ReportFile[];
  logs: ReportFile[];
  /** The legs that ran in full (no option left them out or cut them down); a kept leg counts once its tested run had it. */
  legs?: string[];
  /** Step-by-step traces of the browser-driven parts (journeys and the Inbox leg), with a picture after each step. */
  traces?: JourneyTrace[];
  /** The screens compared with the approved pictures. */
  visual?: VisualResult[];
  /** Bounded exploration of the Sources section: coverage against the source-derived list. */
  explore?: ExploreResult;
  upgrade?: UpgradeReport;
  /** The AI reviewer's findings (reviewer.ts), added after the run; advisory, so they never change the verdict. */
  review?: ReviewResult;
}

export interface ReleaseReportInput {
  runId: string;
  candidate: { label: string; sha?: string };
  startedAt: string;
  finishedAt: string;
  machines: MachineReport[];
  /** Run-level problems that are not a check (a teardown that failed, a driver error). */
  errors: string[];
  /** Set when the run was a deliberate self-test; the verdict then carries the expectation. */
  selfTest?: string;
  /** The commit this harness and the installer bundle were exported from. Absent for an unpinned development run. */
  harnessCommit?: string;
  /**
   * An incremental run: the legs the change between `fromSha` and this candidate can reach ran again, and the rest kept the
   * tested run's results. `files` is the proof: every changed file with the legs it reaches (impact.ts).
   */
  carry?: CarryRecord;
}

export interface CarryRecord {
  fromRunId: string;
  fromSha: string;
  ran: string[];
  carried: string[];
  files: Array<{ file: string; legs: string[] | 'all'; why: string }>;
  /** What else came from the tested run: the step traces, the screen comparisons, the control exploration. */
  parts: string[];
}

/** How the commit of the harness relates to the commit of the candidate that was tested. */
export type HarnessRelation = 'same-commit' | 'different-commit' | 'candidate-commit-not-recorded' | 'unpinned';

export interface HarnessRecord {
  commit?: string;
  candidateCommit?: string;
  relation: HarnessRelation;
}

export interface ReleaseReport extends ReleaseReportInput {
  schema: 'olympus.release-check.report.v1';
  verdict: 'pass' | 'fail';
  /** Per stage, for an upgrade run: before, the update, after. Empty for a plain run's single stage is still listed. */
  phases: PhaseVerdict[];
  counts: Record<CheckStatus, number>;
  harness: HarnessRecord;
}

export function harnessRecord(harnessCommit: string | undefined, candidateCommit: string | undefined): HarnessRecord {
  if (!harnessCommit) return { relation: 'unpinned', ...(candidateCommit ? { candidateCommit } : {}) };
  if (!candidateCommit) return { commit: harnessCommit, relation: 'candidate-commit-not-recorded' };
  return { commit: harnessCommit, candidateCommit, relation: harnessCommit === candidateCommit ? 'same-commit' : 'different-commit' };
}

function allChecks(machine: MachineReport): CheckResult[] {
  return [
    ...(machine.upgrade ? [...machine.upgrade.from.checks, ...machine.upgrade.from.agents.flatMap((agent) => agent.checks), ...machine.upgrade.step.checks] : []),
    ...machine.checks,
    ...machine.agents.flatMap((agent) => agent.checks),
  ];
}

export interface PhaseVerdict { id: string; label: string; verdict: 'pass' | 'fail' }

/** A stage that recorded nothing but the report's own scan never ran, and a stage that never ran cannot pass. */
const verdictOf = (checks: readonly CheckResult[]): 'pass' | 'fail' => (!checks.some((check) => check.id !== 'scan.report') || checks.some((check) => check.status === 'fail') ? 'fail' : 'pass');

/** A verdict per stage of an upgrade run (before, the update, after); a plain run has one stage. */
export function phaseVerdicts(machine: MachineReport): PhaseVerdict[] {
  const after = { id: machine.upgrade ? 'after' : 'install', label: machine.upgrade?.afterLabel ?? machine.label, verdict: verdictOf([...machine.checks, ...machine.agents.flatMap((agent) => agent.checks)]) };
  if (!machine.upgrade) return [after];
  const { from, step } = machine.upgrade;
  return [
    { id: from.id, label: from.label, verdict: verdictOf([...from.checks, ...from.agents.flatMap((agent) => agent.checks)]) },
    { id: 'upgrade', label: step.label, verdict: verdictOf(step.checks) },
    after,
  ];
}

/** An agent counts as having asked a question only if it ran, was not the harness's own scripted one, and produced checks. */
function askedAQuestion(agent: AgentReport): boolean {
  return agent.ran && agent.scripted !== true && agent.checks.length > 0;
}

/**
 * Totals and the verdict. A skip never fails a run, but a run in which every agent was skipped asked the product nothing,
 * so it cannot pass. A failed check or any run problem fails it.
 */
export function buildReport(input: ReleaseReportInput): ReleaseReport {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const machine of input.machines) {
    for (const check of allChecks(machine)) counts[check.status] += 1;
  }
  const errors = [...input.errors];
  for (const machine of input.machines) {
    if (machine.upgrade && !machine.upgrade.from.agents.some(askedAQuestion)) {
      const problem = `${machine.label}: no agent asked a question before the upgrade (${machine.upgrade.from.agents.length === 0 ? 'none was configured' : 'every agent was skipped'}), so the baseline proves nothing about answers`;
      if (!errors.includes(problem)) errors.push(problem);
    }
    if (!machine.agents.some(askedAQuestion)) {
      const problem = `${machine.label}: no agent asked a question (${machine.agents.length === 0 ? 'none was configured' : 'every agent was skipped'}), so the run proves nothing about answers`;
      // A report is rebuilt from an earlier report; the same problem is recorded once.
      if (!errors.includes(problem)) errors.push(problem);
    }
  }
  const harness = harnessRecord(input.harnessCommit, input.candidate.sha);
  if (harness.relation === 'different-commit') {
    // A harness from another commit than the candidate says nothing reliable about the candidate.
    const problem = `the harness was exported from ${harness.commit}, not the candidate's commit ${harness.candidateCommit}, so this run does not qualify that candidate`;
    if (!errors.includes(problem)) errors.push(problem);
  }
  const failed = counts.fail > 0 || errors.length > 0 || input.machines.length === 0;
  const phases = input.machines.flatMap((machine) => phaseVerdicts(machine));
  return { schema: 'olympus.release-check.report.v1', ...input, errors, verdict: failed ? 'fail' : 'pass', phases, counts, harness };
}

const STATUS_LABEL: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`;
}

const carriedNote = (carried: CarriedFrom | undefined): string => (carried ? ` <span class="muted">(kept from ${escapeHtml(carried.sha.slice(0, 8))})</span>` : '');

function checkRow(check: CheckResult): string {
  return `<tr class="${check.status}"><td><span class="badge ${check.status}">${STATUS_LABEL[check.status]}</span></td>`
    + `<td>${escapeHtml(check.title)}${carriedNote(check.carried)}</td><td>${escapeHtml(check.detail ?? '')}</td><td class="num">${seconds(check.ms)}</td></tr>`;
}

function carrySection(carry: CarryRecord | undefined): string {
  if (!carry) return '';
  const files = carry.files.map((f) => `<li><code>${escapeHtml(f.file)}</code>: ${escapeHtml(f.legs === 'all' ? 'every leg' : f.legs.length === 0 ? 'no leg' : f.legs.join(', '))} (${escapeHtml(f.why)})</li>`).join('');
  return `<section><h2>Incremental run</h2><p>Ran again: ${escapeHtml(carry.ran.join(', ') || 'only the install and setup checks')}. `
    + `Kept from run ${escapeHtml(carry.fromRunId)} of ${escapeHtml(carry.fromSha)}: ${escapeHtml([...carry.carried, ...carry.parts].join(', ') || 'nothing')}.</p>`
    + `<details><summary>${carry.files.length} changed file(s) since the tested commit, and the legs each can reach</summary><ul>${files}</ul></details></section>`;
}

function checkTable(checks: readonly CheckResult[]): string {
  if (checks.length === 0) return '<p class="muted">No checks.</p>';
  return `<table><thead><tr><th>Result</th><th>Check</th><th>Detail</th><th>Time</th></tr></thead><tbody>${checks.map(checkRow).join('')}</tbody></table>`;
}

function safeRelative(path: string): string {
  // Report files are siblings or children of the page; never an absolute or parent path.
  return path.replace(/^\/+/, '').split('/').filter((part) => part !== '..').map(encodeURIComponent).join('/');
}

function fileLinks(files: readonly ReportFile[]): string {
  if (files.length === 0) return '<p class="muted">None.</p>';
  return `<ul>${files.map((file) => `<li><a href="${safeRelative(file.path)}">${escapeHtml(file.label)}</a></li>`).join('')}</ul>`;
}

function screenshotGrid(files: readonly ReportFile[]): string {
  if (files.length === 0) return '<p class="muted">No screenshots.</p>';
  return `<div class="shots">${files.map((file) => (
    `<figure><a href="${safeRelative(file.path)}"><img loading="lazy" src="${safeRelative(file.path)}" alt="${escapeHtml(file.label)}"></a>`
    + `<figcaption>${escapeHtml(file.label)}</figcaption></figure>`
  )).join('')}</div>`;
}

function agentSection(agent: AgentReport): string {
  const status = !agent.ran ? 'skip' : agent.checks.some((c) => c.status === 'fail') ? 'fail' : 'pass';
  const header = `<h4>${escapeHtml(agent.label)} <span class="badge ${status}">${agent.ran ? STATUS_LABEL[status] : 'SKIPPED'}</span>${carriedNote(agent.carried)}</h4>`;
  if (!agent.ran) return `<section class="agent">${header}<p class="muted">${escapeHtml(agent.skipReason ?? 'Did not run.')}</p></section>`;
  const usage = agent.usage
    ? `<p class="muted">${agent.usage.invocations} invocation(s), ${agent.usage.modelCalls} model call(s), ${agent.usage.toolCalls} tool call(s), `
      + `${agent.usage.inputTokens} input and ${agent.usage.outputTokens} output tokens · ${escapeHtml(agent.usage.billing)}</p>`
    : '';
  return `<section class="agent">${header}${usage}${checkTable(agent.checks)}</section>`;
}

function badge(verdict: 'pass' | 'fail'): string {
  return `<span class="badge ${verdict}">${STATUS_LABEL[verdict]}</span>`;
}

function timingsLine(timings: Record<string, number>): string {
  const text = Object.entries(timings).map(([phase, ms]) => `${escapeHtml(phase)} ${seconds(ms)}`).join(' · ');
  return `<p class="muted">${text || 'No timings recorded.'}</p>`;
}

function differencesTable(rows: readonly Difference[]): string {
  if (rows.length === 0) return '<p class="muted">Nothing differs between the two stages.</p>';
  return `<table><thead><tr><th>What</th><th>Before the upgrade</th><th>After the upgrade</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.what)}</td><td>${escapeHtml(row.before)}</td><td>${escapeHtml(row.after)}</td></tr>`).join('')}</tbody></table>`;
}

/** Calls and tokens per agent across both stages of an upgrade run, so the cost of the leg is one line each. */
function usageTotals(machine: MachineReport): string {
  const totals = new Map<string, { label: string; invocations: number; modelCalls: number; toolCalls: number; input: number; output: number }>();
  for (const agent of [...(machine.upgrade?.from.agents ?? []), ...machine.agents]) {
    if (!agent.usage) continue;
    const row = totals.get(agent.id) ?? { label: agent.label, invocations: 0, modelCalls: 0, toolCalls: 0, input: 0, output: 0 };
    row.invocations += agent.usage.invocations;
    row.modelCalls += agent.usage.modelCalls;
    row.toolCalls += agent.usage.toolCalls;
    row.input += agent.usage.inputTokens;
    row.output += agent.usage.outputTokens;
    totals.set(agent.id, row);
  }
  if (totals.size === 0) return '';
  return `<p class="muted">Agent usage, both stages together: ${[...totals.values()].map((row) => `${escapeHtml(row.label)}: ${row.invocations} invocation(s), ${row.modelCalls} model call(s), ${row.toolCalls} tool call(s), ${row.input} in / ${row.output} out tokens`).join(' · ')}</p>`;
}

/** The traces, one block per journey: each step with what was done, what was expected, what happened, and the picture after it. */
export function traceSections(traces: readonly JourneyTrace[] | undefined): string {
  if (!traces || traces.length === 0) return '';
  const step = (journey: JourneyTrace, trace: JourneyTrace['steps'][number]): string => {
    const problems = [
      ...trace.consoleErrors.map((line) => `console error: ${line}`),
      ...trace.failedRequests.map((line) => `failed request: ${line}`),
      ...trace.findings,
    ];
    const picture = trace.screenshot ? `<a href="traces/${safeRelative(trace.screenshot)}"><img loading="lazy" src="traces/${safeRelative(trace.screenshot)}" alt="${escapeHtml(`${journey.id} step ${trace.n}`)}"></a>` : '<span class="muted">no picture</span>';
    return `<li class="step ${trace.ok ? 'pass' : 'fail'}"><div class="stepbody"><strong>${trace.n}. ${escapeHtml(trace.name)}</strong> <span class="badge ${trace.ok ? 'pass' : 'fail'}">${trace.ok ? 'PASS' : 'FAIL'}</span> <span class="muted">${seconds(trace.ms)}${trace.at ? ` · ${escapeHtml(trace.at)}` : ''}</span>`
      + `<dl><dt>Did</dt><dd>${escapeHtml(trace.action)}</dd><dt>Expected</dt><dd>${escapeHtml(trace.expected)}</dd><dt>Got</dt><dd>${escapeHtml(trace.actual)}</dd>`
      + (problems.length > 0 ? `<dt>Problems</dt><dd>${problems.map(escapeHtml).join('<br>')}</dd>` : '')
      + (trace.inventory ? `<dt>On the page</dt><dd class="muted">${escapeHtml(trace.inventory.text)}<br>${escapeHtml(trace.inventory.controls.join(' | '))}</dd>` : '')
      + `</dl></div><div class="stepshot">${picture}</div></li>`;
  };
  return `<h3>Step-by-step traces</h3>${traces.map((journey) => (
    `<details class="journey"${journey.ok ? '' : ' open'}><summary><span class="badge ${journey.ok ? 'pass' : 'fail'}">${journey.ok ? 'PASS' : 'FAIL'}</span> ${escapeHtml(journey.title)} <span class="muted">(${escapeHtml(journey.source)} · ${journey.steps.length} step(s) · ${seconds(journey.ms)})</span></summary>`
    + (journey.error ? `<p class="muted">${escapeHtml(journey.error)}</p>` : '')
    + `<ol class="steps">${journey.steps.map((trace) => step(journey, trace)).join('')}</ol></details>`
  )).join('')}`;
}

/** Coverage of the bounded exploration: what the source says the page can offer, what was found and pressed, and why each miss. */
/** The other dashboard pages: per page what was found, pressed and validated, then the coverage against the templates. */
export function pagesSection(pages: PagesResult | undefined): string {
  if (!pages) return '';
  const c = pages.coverage;
  const list = pages.pages.map((page) => `<li>${escapeHtml(page.title)} <span class="muted">(${escapeHtml(page.path)})</span>: ${page.found} found, ${page.pressed} pressed, ${page.validated} link(s) to other sites validated, ${page.skipped} named and not pressed, ${page.failed} broke a rule or an outcome${page.error ? ` <strong>${escapeHtml(page.error)}</strong>` : ''}</li>`).join('');
  const rows = c.entries.map((entry) => `<tr><td><span class="badge ${entry.status === 'pressed' ? 'pass' : 'warn'}">${entry.status.toUpperCase()}</span></td><td>${escapeHtml(entry.file.split('/').pop() ?? entry.file)}</td><td>${escapeHtml(entry.label)}</td><td class="muted">${escapeHtml(entry.detail)}</td></tr>`).join('');
  return `<h3>Control exploration: the other dashboard pages</h3><p><strong>${c.listed}</strong> controls listed from the page templates (${c.unmatchable} more carry no fixed name); <strong>${c.found}</strong> found, <strong>${c.pressed}</strong> pressed, <strong>${c.missed}</strong> missed (${pages.presses} presses in all). Coverage is advisory; the rules are blocking.</p><ul>${list}</ul><table class="checks"><thead><tr><th></th><th>Template</th><th>Control</th><th>Pressed, or why not</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export function exploreSection(explore: ExploreResult | undefined): string {
  if (!explore) return '';
  const s = explore.summary;
  const rows = explore.coverage.map((entry) => `<tr><td><span class="badge ${entry.status === 'pressed' ? 'pass' : 'warn'}">${entry.status === 'pressed' ? 'PRESSED' : 'MISSED'}</span></td><td>${escapeHtml(entry.sourceLabel)}</td><td>${escapeHtml(entry.label)}${entry.destructive ? ' <span class="muted">(destructive)</span>' : ''}</td><td>${escapeHtml(entry.kind)}</td><td class="muted">${escapeHtml(entry.detail)}</td></tr>`).join('');
  const seeds = explore.seeds.map((seed) => `<li>${escapeHtml(seed.title)}: ${seed.produced ? `${seed.pressed} pressed, ${seed.failed} broke a rule or an outcome <span class="muted">(${escapeHtml(seed.detail)})</span>` : `<strong>not produced</strong>: ${escapeHtml(seed.detail)}`}</li>`).join('');
  const unlisted = explore.unlisted.length > 0 ? `<p>Found on the page but not named by the source-derived list (${explore.unlisted.length}):</p><ul>${explore.unlisted.map((entry) => `<li>${escapeHtml(entry.rowName)}: ${escapeHtml(entry.label || entry.key)} <span class="muted">[${escapeHtml(entry.key)}]${entry.pressed ? '' : ' not pressed'}</span></li>`).join('')}</ul>` : '';
  const sections = explore.sections && explore.sections.length > 0 ? `<p>The panel's other sections, pressed once from the first state (${explore.sections.filter((entry) => entry.pressed).length} of ${explore.sections.length} pressed):</p><ul>${explore.sections.map((entry) => `<li>${escapeHtml(entry.section)}: ${escapeHtml(entry.label || entry.key)} <span class="muted">[${escapeHtml(entry.key)}]${entry.pressed ? '' : ` ${escapeHtml(entry.note ?? 'not pressed')}`}</span></li>`).join('')}</ul>` : '';
  return `<h3>Control exploration: the Sources section</h3><p><strong>${s.listed}</strong> controls listed from the product's source; <strong>${s.found}</strong> found on the page, <strong>${s.pressed}</strong> pressed, <strong>${s.missed}</strong> missed (${s.presses} presses in all). Coverage is advisory; the rules are blocking.</p><ul>${seeds}</ul><table class="checks"><thead><tr><th></th><th>Source</th><th>Control</th><th>Kind</th><th>Pressed, or why not</th></tr></thead><tbody>${rows}</tbody></table>${unlisted}${sections}${accessibilitySection(explore.accessibility)}${pagesSection(explore.pages)}`;
}

/** The accessibility audit: each violation, where it was, and the elements it names. */
export function accessibilitySection(accessibility: ExploreResult['accessibility']): string {
  if (accessibility.status === 'skipped') return `<p class="muted">Accessibility audit: ${escapeHtml(accessibility.reason)}</p>`;
  const rows = accessibility.states.flatMap((entry) => (entry.error
    ? [`<tr><td><span class="badge fail">NOT AUDITED</span></td><td>${escapeHtml(entry.state)} / ${escapeHtml(entry.frame)}</td><td colspan="3">${escapeHtml(entry.error)}</td></tr>`]
    : entry.violations.map((violation) => `<tr><td><span class="badge ${violation.impact === 'serious' || violation.impact === 'critical' ? 'fail' : 'warn'}">${escapeHtml(violation.impact.toUpperCase())}</span></td><td>${escapeHtml(entry.state)} / ${escapeHtml(entry.frame)}</td><td><a href="${escapeHtml(violation.helpUrl)}">${escapeHtml(violation.rule)}</a>: ${escapeHtml(violation.help)}</td><td>${violation.nodeCount}</td><td class="muted">${violation.nodes.map((node) => `<code>${escapeHtml(node.target)}</code> ${escapeHtml(node.html)}${node.summary ? ` — ${escapeHtml(node.summary)}` : ''}`).join('<br>')}</td></tr>`)));
  return `<h4>Accessibility audit (axe-core ${escapeHtml(accessibility.version)})</h4><p class="muted">${accessibility.states.length} page state(s) audited; serious and critical violations block, the rest are reported.</p>`
    + (rows.length > 0 ? `<table class="checks"><thead><tr><th>Impact</th><th>Page state / frame</th><th>Rule</th><th>Elements</th><th>First elements</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p>No violations.</p>');
}

/** The screens against their approved pictures: the approved one, this run's, and what differs. */
export function visualSection(results: readonly VisualResult[] | undefined): string {
  if (!results || results.length === 0) return '';
  const cell = (path: string | undefined, label: string): string => (path
    ? `<figure><a href="${safeRelative(path)}"><img loading="lazy" src="${safeRelative(path)}" alt="${escapeHtml(label)}"></a><figcaption>${escapeHtml(label)}</figcaption></figure>`
    : `<figure><p class="muted">${escapeHtml(label)}: none</p></figure>`);
  const rows = results.map((result) => {
    const c = result.comparison;
    const state = result.approvedRefresh ? 'approved change, refreshed' : result.updated ? 'candidate written' : c.status === 'match' ? 'matches' : c.status === 'missing' ? 'no approved picture' : c.status === 'size' ? 'size changed' : c.status === 'unreadable' ? 'unreadable' : 'differs';
    const bad = !result.updated && !result.approvedRefresh && c.status !== 'match';
    const open = bad ? ' open' : '';
    const change = result.change;
    const body = (bad || result.updated || result.approvedRefresh) && change
      ? `<p><strong>${escapeHtml(change.caption)}</strong></p><div class="trio">${cell(change.cropBaseline, 'Approved, zoomed on the change')}${cell(change.cropActual, 'This run, zoomed on the change')}</div>`
        + `<div class="trio">${cell(change.baselineBoxed, 'Approved (change outlined)')}${cell(change.actualBoxed, 'This run (change outlined)')}${cell(result.diff, 'Difference')}</div>`
      : bad || result.updated || result.approvedRefresh
      ? `<div class="trio">${cell(result.baseline, 'Approved')}${cell(result.actual, 'This run')}${cell(result.diff, 'Difference')}</div>`
      : `<div class="trio">${cell(result.actual, 'This run')}</div>`;
    return `<details${open}><summary><span class="badge ${bad ? 'fail' : result.updated || result.approvedRefresh ? 'warn' : 'pass'}">${escapeHtml(state.toUpperCase())}</span> ${escapeHtml(result.title)} · ${result.width} px · ${escapeHtml(result.theme)} <span class="muted">${(c.diffRatio * 100).toFixed(3)}% of pixels differ</span></summary>${body}</details>`;
  });
  return `<h3>Visual baselines</h3>${rows.join('')}`;
}

/** The AI reviewer's findings, each with its picture and the steps that reach it. Advisory: listed, never counted in the verdict. */
export function reviewSection(review: ReviewResult | undefined): string {
  if (!review) return '';
  const order = { high: 0, medium: 1, low: 2 } as const;
  const rows = [...review.findings].sort((a, b) => order[a.confidence] - order[b.confidence] || a.unit.localeCompare(b.unit)).map((finding) => `<details><summary><span class="badge warn">${escapeHtml(finding.kind.toUpperCase())}</span> ${escapeHtml(finding.what)} <span class="muted">${escapeHtml(finding.unitTitle)} · ${escapeHtml(finding.confidence)}</span></summary>`
    + `<div class="trio"><figure><a href="${safeRelative(finding.picture)}"><img loading="lazy" src="${safeRelative(finding.picture)}" alt="${escapeHtml(finding.unitTitle)}"></a><figcaption>${escapeHtml(finding.where || 'where: not said')}</figcaption></figure></div>`
    + `<p>To see it:</p><ol>${finding.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol></details>`);
  const unanswered = review.inconclusive.length > 0 ? `<p>Not answered (${review.inconclusive.length}):</p><ul>${review.inconclusive.map((entry) => `<li>${escapeHtml(entry.unit)}: ${escapeHtml(entry.reason)}</li>`).join('')}</ul>` : '';
  return `<h3>AI reviewer <span class="badge warn">${review.status === 'qualified' ? 'QUALIFIED' : 'ADVISORY'}</span></h3>`
    + `<p class="muted">${escapeHtml(review.model)} looked at ${review.pictures} picture(s) in ${review.units} request(s) and reported ${review.findings.length} problem(s)${review.dropped > 0 ? `; ${review.dropped} more named no picture, no listed kind of problem, or were unsure, and were dropped` : ''}. ${review.status === 'qualified' ? '' : 'Until it qualifies against planted bugs, its findings do not change the verdict.'}</p>`
    + (rows.length > 0 ? rows.join('') : '<p>No problems reported.</p>') + unanswered;
}

function machineSection(machine: MachineReport): string {
  const head = `<section class="machine"><h2>${escapeHtml(machine.label)}</h2>`
    + `<p class="muted">${escapeHtml(machine.os)} · driver ${escapeHtml(machine.driver)}${machine.build ? ` · build ${escapeHtml(machine.build)}` : ''}</p>`;
  const verdicts = phaseVerdicts(machine);
  if (!machine.upgrade) {
    return head
      + timingsLine(machine.timings)
      + `<h3>Machine checks</h3>${checkTable(machine.checks)}`
      + `<h3>Agents</h3>${machine.agents.map(agentSection).join('') || '<p class="muted">No agents.</p>'}`
      + `<h3>Dashboard screenshots</h3>${screenshotGrid(machine.screenshots)}`
      + traceSections(machine.traces) + exploreSection(machine.explore) + visualSection(machine.visual) + reviewSection(machine.review)
      + `<h3>Logs</h3>${fileLinks(machine.logs)}</section>`;
  }
  const { from, step } = machine.upgrade;
  return head
    + `<p>${verdicts.map((phase, index) => `${index + 1}. ${escapeHtml(phase.id === 'upgrade' ? 'The upgrade' : phase.id === 'after' ? 'After the upgrade' : 'Before the upgrade')} ${badge(phase.verdict)}`).join(' &nbsp; ')}</p>`
    + usageTotals(machine)
    + `<h2>1. Before the upgrade: ${escapeHtml(from.label)} ${badge(verdicts[0]!.verdict)}</h2>`
    + `<p class="muted">${from.version ? `version ${escapeHtml(from.version)}` : ''}${from.build ? ` · build ${escapeHtml(from.build)}` : ''}</p>`
    + timingsLine(from.timings)
    + `<h3>Machine checks</h3>${checkTable(from.checks)}`
    + `<h3>Agents</h3>${from.agents.map(agentSection).join('') || '<p class="muted">No agents.</p>'}`
    + `<h2>2. The upgrade: ${escapeHtml(step.label)} ${badge(verdicts[1]!.verdict)}</h2>`
    + checkTable(step.checks)
    + `<h3>What differs across the upgrade</h3>${differencesTable(step.differences)}`
    + `<h2>3. After the upgrade: ${escapeHtml(machine.upgrade.afterLabel)} ${badge(verdicts[2]!.verdict)}</h2>`
    + `<p class="muted">${machine.upgrade.afterVersion ? `version ${escapeHtml(machine.upgrade.afterVersion)}` : ''}${machine.build ? ` · build ${escapeHtml(machine.build)}` : ''}</p>`
    + timingsLine(machine.timings)
    + `<h3>Machine checks</h3>${checkTable(machine.checks)}`
    + `<h3>Agents</h3>${machine.agents.map(agentSection).join('') || '<p class="muted">No agents.</p>'}`
    + `<h3>Dashboard screenshots</h3>${screenshotGrid(machine.screenshots)}`
    + traceSections(machine.traces) + exploreSection(machine.explore) + visualSection(machine.visual) + reviewSection(machine.review)
    + `<h3>Logs</h3>${fileLinks(from.logs)}${fileLinks(machine.logs)}</section>`;
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1c1d1f;--muted:#666a70;--line:#d9dbde;--pass:#1a7f37;--fail:#c62828;--warn:#9a6700;--skip:#6b6f76;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141516;--fg:#ececec;--muted:#9da1a8;--line:#34373b;--pass:#3fb950;--fail:#ff6b6b;--warn:#d4a72c;--skip:#9da1a8;--card:#1b1c1e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:1.5rem}h2{margin-top:2.2rem;font-size:1.25rem}h3{margin-top:1.4rem;font-size:1rem}h4{margin:1rem 0 .4rem}
.muted{color:var(--muted);margin:.2rem 0}
.verdict{display:inline-block;padding:2px 12px;border-radius:999px;font-weight:700;color:#fff}
.verdict.pass{background:var(--pass)}.verdict.fail{background:var(--fail)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td.num{white-space:nowrap;text-align:right}
.badge{font-size:.75rem;font-weight:700;padding:1px 7px;border-radius:4px;color:#fff;white-space:nowrap}
.badge.pass{background:var(--pass)}.badge.fail{background:var(--fail)}.badge.warn{background:var(--warn)}.badge.skip{background:var(--skip)}
tr.fail td{background:color-mix(in srgb,var(--fail) 10%,transparent)}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
figure{margin:0}figure img{width:100%;border:1px solid var(--line);border-radius:6px;background:var(--card)}
figcaption{font-size:.8rem;color:var(--muted)}
.step{list-style:none;display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--line)}.steps{padding:0}
.stepbody{flex:1;min-width:0}.stepshot{width:240px;flex:none}.stepshot img{width:100%;border:1px solid var(--line);border-radius:6px}
dl{margin:.3rem 0;display:grid;grid-template-columns:max-content 1fr;gap:2px 10px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
details.journey,details{margin:.4rem 0}summary{cursor:pointer}
.trio{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
@media (max-width:640px){.step{flex-direction:column}.stepshot{width:100%}}
.errors{border:1px solid var(--fail);padding:8px 14px;border-radius:6px}
`;

const HARNESS_TEXT: Record<HarnessRelation, string> = {
  'same-commit': 'the same commit as the candidate',
  'different-commit': 'NOT the candidate\'s commit',
  'candidate-commit-not-recorded': 'the candidate\'s own commit is not recorded (a local artifact), so the two are not confirmed to match',
  unpinned: 'unpinned: this run used whatever source was on disk (a development run, not release evidence)',
};

function harnessLine(harness: HarnessRecord): string {
  return `Harness ${harness.commit ? `commit ${escapeHtml(harness.commit)} · ` : ''}${escapeHtml(HARNESS_TEXT[harness.relation])}`;
}

/** One static page; no scripts, no external requests. */
export function renderHtml(report: ReleaseReport): string {
  const totals = (['pass', 'fail', 'warn', 'skip'] as const).map((s) => `${report.counts[s]} ${s}`).join(' · ');
  const errors = report.errors.length === 0 ? '' : `<div class="errors"><strong>Run problems</strong><ul>${report.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Olympus release check ${escapeHtml(report.candidate.label)}</title><style>${STYLE}</style></head><body><main>`
    + `<h1>Olympus release check</h1>`
    + `<p><span class="verdict ${report.verdict}">${report.verdict.toUpperCase()}</span> ${escapeHtml(totals)}</p>`
    + `<p class="muted">Candidate ${escapeHtml(report.candidate.label)}${report.candidate.sha ? ` (${escapeHtml(report.candidate.sha)})` : ''} · run ${escapeHtml(report.runId)} · ${escapeHtml(report.startedAt)} to ${escapeHtml(report.finishedAt)}</p>`
    + `<p class="muted">${harnessLine(report.harness)}</p>`
    + (report.selfTest ? `<p class="muted">Self-test: ${escapeHtml(report.selfTest)}</p>` : '')
    + errors
    + carrySection(report.carry)
    + report.machines.map(machineSection).join('')
    + `</main></body></html>`;
}

/** The finished report text (JSON and HTML) against the markers; a hit means the report itself leaked. */
export function scanReport(report: ReleaseReport, markers: readonly LeakMarker[]): LeakFinding[] {
  return findLeaks([
    { label: 'report.json', text: JSON.stringify(report) },
    { label: 'report.html', text: renderHtml(report) },
  ], markers);
}
