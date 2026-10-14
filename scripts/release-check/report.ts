/**
 * The release check's report: a JSON document and one static HTML page, built
 * from the same data. Pass/fail per check, per machine, per agent, with
 * timings, screenshots and log links. Only synthetic fixture text and counts go
 * in; the leak scan runs over the finished report text before it is written.
 */
import { findLeaks, type LeakFinding, type LeakMarker } from './leak.ts';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail?: string;
  ms?: number;
}

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
  usage?: AgentUsage;
  /** `skipped` when the agent could not run at all (for example, its API key is missing). */
  ran: boolean;
  skipReason?: string;
  checks: CheckResult[];
}

export interface ReportFile {
  label: string;
  /** Path relative to the report page, so the report folder can move as a unit. */
  path: string;
  width?: number;
  theme?: 'light' | 'dark';
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
}

export interface ReleaseReport extends ReleaseReportInput {
  schema: 'olympus.release-check.report.v1';
  verdict: 'pass' | 'fail';
  counts: Record<CheckStatus, number>;
}

function allChecks(machine: MachineReport): CheckResult[] {
  return [...machine.checks, ...machine.agents.flatMap((agent) => agent.checks)];
}

/** Totals and the verdict. A skip never fails a run; a failed check, a warning-free error list is required. */
export function buildReport(input: ReleaseReportInput): ReleaseReport {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const machine of input.machines) {
    for (const check of allChecks(machine)) counts[check.status] += 1;
  }
  const failed = counts.fail > 0 || input.errors.length > 0 || input.machines.length === 0;
  return { schema: 'olympus.release-check.report.v1', ...input, verdict: failed ? 'fail' : 'pass', counts };
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

function checkRow(check: CheckResult): string {
  return `<tr class="${check.status}"><td><span class="badge ${check.status}">${STATUS_LABEL[check.status]}</span></td>`
    + `<td>${escapeHtml(check.title)}</td><td>${escapeHtml(check.detail ?? '')}</td><td class="num">${seconds(check.ms)}</td></tr>`;
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
  const header = `<h4>${escapeHtml(agent.label)} <span class="badge ${status}">${agent.ran ? STATUS_LABEL[status] : 'SKIPPED'}</span></h4>`;
  if (!agent.ran) return `<section class="agent">${header}<p class="muted">${escapeHtml(agent.skipReason ?? 'Did not run.')}</p></section>`;
  const usage = agent.usage
    ? `<p class="muted">${agent.usage.invocations} invocation(s), ${agent.usage.modelCalls} model call(s), ${agent.usage.toolCalls} tool call(s), `
      + `${agent.usage.inputTokens} input and ${agent.usage.outputTokens} output tokens · ${escapeHtml(agent.usage.billing)}</p>`
    : '';
  return `<section class="agent">${header}${usage}${checkTable(agent.checks)}</section>`;
}

function machineSection(machine: MachineReport): string {
  const timings = Object.entries(machine.timings).map(([phase, ms]) => `${escapeHtml(phase)} ${seconds(ms)}`).join(' · ');
  return `<section class="machine"><h2>${escapeHtml(machine.label)}</h2>`
    + `<p class="muted">${escapeHtml(machine.os)} · driver ${escapeHtml(machine.driver)}${machine.build ? ` · build ${escapeHtml(machine.build)}` : ''}</p>`
    + `<p class="muted">${timings || 'No timings recorded.'}</p>`
    + `<h3>Machine checks</h3>${checkTable(machine.checks)}`
    + `<h3>Agents</h3>${machine.agents.map(agentSection).join('') || '<p class="muted">No agents.</p>'}`
    + `<h3>Dashboard screenshots</h3>${screenshotGrid(machine.screenshots)}`
    + `<h3>Logs</h3>${fileLinks(machine.logs)}</section>`;
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
.errors{border:1px solid var(--fail);padding:8px 14px;border-radius:6px}
`;

/** One static page; no scripts, no external requests. */
export function renderHtml(report: ReleaseReport): string {
  const totals = (['pass', 'fail', 'warn', 'skip'] as const).map((s) => `${report.counts[s]} ${s}`).join(' · ');
  const errors = report.errors.length === 0 ? '' : `<div class="errors"><strong>Run problems</strong><ul>${report.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>Olympus release check ${escapeHtml(report.candidate.label)}</title><style>${STYLE}</style></head><body><main>`
    + `<h1>Olympus release check</h1>`
    + `<p><span class="verdict ${report.verdict}">${report.verdict.toUpperCase()}</span> ${escapeHtml(totals)}</p>`
    + `<p class="muted">Candidate ${escapeHtml(report.candidate.label)}${report.candidate.sha ? ` (${escapeHtml(report.candidate.sha)})` : ''} · run ${escapeHtml(report.runId)} · ${escapeHtml(report.startedAt)} to ${escapeHtml(report.finishedAt)}</p>`
    + (report.selfTest ? `<p class="muted">Self-test: ${escapeHtml(report.selfTest)}</p>` : '')
    + errors
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
