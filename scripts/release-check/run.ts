/**
 * Olympus release check: one candidate build, one throwaway machine per
 * platform, the same synthetic test life, the same agent question suite, one
 * pass/fail report.
 *
 *   bun scripts/release-check/run.ts --config <file> --candidate <dir> --out <dir> [options]
 *
 * The harness is generic. A private driver (any executable that speaks the
 * verbs in machine.ts) creates the machine and installs the candidate; the
 * harness then drives the installed product through the in-machine agent
 * (machine-agent.ts), asks each configured agent the suite, scans every
 * surface for Private and Secret content, captures dashboard screenshots, and
 * always deletes the machine before it returns.
 *
 * Config file (JSON, owned by the private deployment, never committed here):
 *   { "driver": ["<executable>", "<fixed args>"...],
 *     "agents": [{ "id", "label", "kind": "xai-api|claude-code|codex", "model": "<id or empty>",
 *                  "keyCommand": ["<cmd printing the credential>", ...], "enabled": true }],
 *     "judge": ["<verify-style command>", ...],      optional
 *     "relay": "https://<relay host>",               optional; the ChatGPT-protocol pass uses it
 *     "settleTimeoutS": 900 }                        optional
 *
 * Upgrade leg (`--upgrade-from <bundle dir>`): the machine is provisioned with the
 * EARLIER release's bundle, set up and asked the suite, then the driver's `upgrade`
 * verb runs the candidate's public installer over it, the way a user updates.
 * The report then shows both stages and what the update kept and migrated
 * (upgrade.ts). Nothing else reaches the install between the two stages.
 *
 * Ask page and Inbox leg (1.1.0, on by default; `--skip-inbox` leaves it out for an earlier candidate): after the suite and the screenshots,
 * a scripted agent asks the Private question over the engine's MCP endpoint, then the in-machine agent drives the dashboard in a
 * headless browser the way its owner does (the opening link signs in, Unlock opens the controls) and checks that the link's id is an
 * Inbox entry the local model answers, that the Ask page's local model answers a typed question with sources, that Venice and zkAPI
 * (not set up) show the way to fix that and send nothing, and that nothing left the machine (inbox.ts, egress.ts).
 *
 * Archive-import leg (on by default; `--skip-archive` leaves it out for a candidate with no archive import): synthetic archives, written to
 * a folder on the machine and never real data (archive-fixtures.ts), are imported the way their owner and her agents meet it. An agent's
 * request is approved with a real press in the dashboard; the picker is walked once; the settled row and the agent's own status are held
 * to what the fixture holds; a search is cited as the format's citation label (every format in ARCHIVE_FORMATS is imported this way, one
 * after the other). With the private model switched off through the engine's
 * settings, an import stays held Private, shows it, leaves its content out of the Personal and Public stores and out of a search, and
 * sends nothing off the machine; switched back on, what was held drains to zero within the leg's own bound. Remove deletes only that
 * archive, and a file changed during an import stops it visibly (archive-leg.ts, archive-stages.ts). Each later format adds one entry to
 * ARCHIVE_FORMATS in archive-fixtures.ts and nothing here.
 *
 * Exit status: 0 the report passed, 1 the report failed, 2 the run could not
 * start (arguments, config, bundle).
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FIXTURE_ITEMS, INBOX_ASK, PRIVATE_FACTS, SUITE_QUESTIONS, fixtureDocuments, forbiddenMarkers, leakyFixture, tierRules,
  type SuiteQuestion,
} from './fixture.ts';
import { FAKE_READWISE_PORT, FAKE_READWISE_TOKEN } from './readwise-fake.ts';
import { redactDeep, redactMarkers, type LeakMarker } from './leak.ts';
import { CommandDriver, type Machine } from './machine.ts';
import {
  buildReport, renderHtml, scanReport,
  type AgentReport, type AgentUsage, type CheckResult, type MachineReport, type PhaseReport, type ReleaseReport, type ReportFile,
} from './report.ts';
import {
  describeDifferences, evaluateCounts, evaluateUpgrade, versionFromTarballName,
  type DashboardCounts, type Difference, type StateSnapshot,
} from './upgrade.ts';
import { evaluateArtifactScan, evaluateObservation, evaluateSmokeVerdict, type QuestionObservation } from './suite.ts';
import { AgentApiError, readAgentKey, runXaiAgent, type AgentSpec, type ToolBridge, type ToolDefinition } from './agents.ts';
import { codexLoginAvailable, looksLikeClaudeSetupToken, runClaudeCode, runCodex } from './cli-agents.ts';
import { cachingRelay, startMcpProxy, type McpExchange, type Relay } from './mcp-proxy.ts';
import { privateNoteKindIn } from './private-note.ts';
import { SOURCE_ANSWER_HANDOFF_MAX_MS, SOURCE_ANSWER_RESULT_WAIT_MAX_MS } from '../../src/core/source-answer-jobs.ts';
import { evaluateInbox, privateLinkIdsIn, privateNoteIn, type InboxObservation } from './inbox.ts';
import { commandJudge, judgeCheck, type Judge } from './judge.ts';
import type { AgentConfig } from './machine-agent.ts';
import { journeyChecks, type JourneyTrace } from './journey.ts';
import { layoutChecks, layoutFindings, layoutQualificationCheck, scoreLayoutRules } from './layout-rules.ts';
import type { PlantedPicture } from './reviewer-plants.ts';
import { buildInventory } from './explore-inventory.ts';
import { buildPageInventory } from './explore-pages-inventory.ts';
import { exploreChecks, type ExploreResult } from './explore.ts';
import { SCREENS, compareScreens, currentApprovalDigest, visualChecks, type VisualResult } from './visual.ts';
import { SCREEN_THEMES, SCREEN_WIDTHS, screenName } from './visual-capture.ts';
import { EXTRA_FORMATS, STRESS_FORMAT, legFixture, type FixtureRole } from './archive-fixtures.ts';
import {
  ARCHIVE_BOUNDS, BULK_SIZES, changedChecks, drainBoundS, drainChecks, heldOffChecks, importChecks, modelChecks, removeChecks, searchChecks,
  type ChangedObservation, type ImportObservation, type ModelObservation, type RemoveObservation,
} from './archive-leg.ts';

export interface RunConfigFile {
  driver: string[];
  agents?: AgentSpec[];
  judge?: string[];
  relay?: string;
  settleTimeoutS?: number;
}

export type UpgradeSelftest = 'lose-tier-rules' | 'revert-policy';
export const UPGRADE_SELFTESTS: readonly UpgradeSelftest[] = ['lose-tier-rules', 'revert-policy'];
/** The check each self-test must fail on. */
export const UPGRADE_SELFTEST_FAILS: Record<UpgradeSelftest, string> = { 'lose-tier-rules': 'upgrade.tier-rules-kept', 'revert-policy': 'upgrade.privacy-migration' };

/** Inbox self-tests: a planted Private string in what an agent said, and a link whose id names no entry. Each must fail the run on the check named. */
export type InboxSelftest = 'plant-private-reply' | 'wrong-link-id';
export const INBOX_SELFTESTS: readonly InboxSelftest[] = ['plant-private-reply', 'wrong-link-id'];
export const INBOX_SELFTEST_FAILS: Record<InboxSelftest, string> = { 'plant-private-reply': 'private-medical.no-leak', 'wrong-link-id': 'inbox.agent.entry' };

export interface RunOptions {
  runId: string;
  candidateDir: string;
  candidateLabel: string;
  candidateSha?: string;
  /** The commit the harness and installer bundle were exported from; the report records it and compares it with the candidate's. */
  harnessCommit?: string;
  outDir: string;
  config: RunConfigFile;
  /** The leak self-test: this tier's marker is also stored in an ordinary Personal item, so it reaches agents; the run must fail. */
  mistier?: 'private' | 'secrets';
  /**
   * The earlier release's installer bundle (same shape as `candidateDir`). Set, the machine gets this release first and
   * the candidate is installed over it as an update; unset, the candidate is installed fresh.
   */
  upgradeFromDir?: string;
  /** Upgrade self-tests: make a fault happen so the run must fail. `lose-tier-rules` is data lost across the update; `revert-policy` is a privacy migration that did not apply. */
  upgradeSelftest?: UpgradeSelftest;
  /** Inbox self-test: a fault is made in what the Inbox leg sees, so the run must fail on the check that guards it. */
  inboxSelftest?: InboxSelftest;
  /** Leave out the Ask page and Inbox leg (1.1.0). For a candidate earlier than 1.1.0, which has none. */
  skipInbox?: boolean;
  /** Leave out the journeys and the screens for the visual baselines. */
  skipJourneys?: boolean;
  /** Leave out the bounded exploration of the Sources section. */
  skipExplore?: boolean;
  /** Leave out the agent suite (the questions put to each agent), for a run that is after another leg; a partial run, like the other skips. */
  skipSuite?: boolean;
  /** Leave out the archive-import leg. For a candidate that has no archive import. */
  skipArchive?: boolean;
  /** Run only these journeys (by id); omitted runs them all. */
  onlyJourneys?: string[];
  /** Where the approved pictures are (one folder per platform, `<screen>-<width>-<theme>.png`). Omitted, the screens are not compared. */
  baselinesDir?: string;
  /** Write this run's screens into `baselinesDir` as candidate pictures. They are never approved by the run; the owner approves by merging. */
  updateBaselines?: boolean;
  /** A qualification run for the AI reviewer: also take the screens with planted bugs (reviewer-plants.ts). Never release evidence. */
  reviewerPlants?: boolean;
  /** Throw after the machine exists, to prove teardown on failure. */
  failAfterProvision?: boolean;
  /** Debugging only: leave the machine running. The run is reported as failed so it can never pass for release evidence. */
  keepMachine?: boolean;
  skipRelay?: boolean;
  skipScreenshots?: boolean;
  /** Run only these configured agents (by id); omitted runs every enabled one. */
  onlyAgents?: string[];
  budgetMs?: number;
}

const ENGINE_PORT = 8010;
// The runtime the installer put on the machine: its own location on macOS, the engine's generation folder on Linux.
const BUN_LOCATE = 'BUN=$(command -v bun 2>/dev/null || ls -d ~/.local/share/olympus-engine/generations/*/runtime/bun "$HOME/Library/Application Support/Olympus/runtime/bun" 2>/dev/null | tail -1); [ -n "$BUN" ] || { echo "no bun runtime on the machine" >&2; exit 90; }';

const nowIso = (): string => new Date().toISOString();

export function newRunId(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  return `${stamp}-${randomBytes(2).toString('hex')}`.toLowerCase();
}

/** The last stdout line that parses as a JSON object: the in-machine agent's one-line result. */
export function parseAgentLine(stdout: string): Record<string, any> | undefined {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { return JSON.parse(trimmed) as Record<string, any>; } catch { /* keep looking */ }
  }
  return undefined;
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One stage of a run: a plain run has one; an upgrade run has three (before, the update itself, after). */
interface Stage {
  id: string;
  label: string;
  version?: string;
  build?: string;
  timings: Record<string, number>;
  checks: CheckResult[];
  agents: AgentReport[];
  screenshots: ReportFile[];
  logs: ReportFile[];
  /** Step-by-step traces of the browser-driven parts: the journeys and the Ask page and Inbox leg. */
  traces?: JourneyTrace[];
  /** The screens compared with the approved pictures. */
  visual?: VisualResult[];
  explore?: ExploreResult;
}

const newStage = (id: string, label: string): Stage => ({ id, label, timings: {}, checks: [], agents: [], screenshots: [], logs: [] });

class Run {
  readonly markers: LeakMarker[] = forbiddenMarkers();
  readonly logLines: string[] = [];
  readonly errors: string[] = [];
  readonly stages = new Map<string, Stage>();
  /** What the update changed, for the report. */
  differences: Difference[] = [];
  /** The Open-link ids the model agents were given for the Private question: the Inbox leg checks each resolves. */
  readonly agentLinks: Array<{ agent: string; id: string }> = [];
  /** The tools the engine's MCP endpoint offers (all of them, not only the read-only ones), read once per stage. */
  readonly offeredTools = new Map<string, string[]>();
  /** The check the wrong-link-id self-test failed on, which depends on whether this install issues agents a link. */
  inboxSelftestFailsOn?: string;
  stage: Stage;
  machine?: Machine;

  constructor(readonly options: RunOptions, readonly driver: CommandDriver) {
    this.stage = this.addStage('install', 'Olympus installed fresh');
  }

  addStage(id: string, label: string): Stage {
    const stage = newStage(id, label);
    this.stages.set(id, stage);
    return stage;
  }

  /** Later checks, timings and files belong to this stage. */
  use(id: string): void {
    this.stage = this.stages.get(id)!;
  }

  /** The Open-link checks are judged on the candidate: not on the earlier release of an upgrade run (its "before" stage). */
  get linksJudged(): boolean { return this.stage.id !== 'before'; }
  get timings(): Record<string, number> { return this.stage.timings; }
  get checks(): CheckResult[] { return this.stage.checks; }
  get agents(): AgentReport[] { return this.stage.agents; }
  get screenshots(): ReportFile[] { return this.stage.screenshots; }
  get logs(): ReportFile[] { return this.stage.logs; }
  get build(): string | undefined { return this.stage.build; }
  set build(value: string | undefined) { if (value !== undefined) this.stage.build = value; else delete this.stage.build; }

  log(line: string): void {
    const stamped = `${nowIso()} ${redactMarkers(line, this.markers)}`;
    this.logLines.push(stamped);
    console.error(stamped);
  }

  async phase<T>(name: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    this.log(`phase ${name}: start`);
    try {
      return await work();
    } finally {
      this.timings[name] = (this.timings[name] ?? 0) + (Date.now() - started);
      this.log(`phase ${name}: ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
  }

  add(check: CheckResult): void {
    this.checks.push(check);
    this.log(`check ${check.status.toUpperCase()} ${check.id}${check.detail ? ` - ${check.detail}` : ''}`);
  }

  /** A check that belongs to another stage than the one running (the update's comparisons are made once the new install has settled). */
  addTo(id: string, check: CheckResult): void {
    const keep = this.stage;
    this.use(id);
    try { this.add(check); } finally { this.stage = keep; }
  }

  async agent(sub: string, args = '', timeoutMs = 120_000): Promise<{ result: Record<string, any> | undefined; stdout: string; stderr: string; code: number; ms: number }> {
    const exec = await this.machine!.exec(`${BUN_LOCATE}\n"$BUN" --no-env-file ~/rc/agent.js ${sub} ${args}\n`, { timeoutMs });
    return { result: parseAgentLine(exec.stdout), stdout: exec.stdout, stderr: exec.stderr, code: exec.code, ms: exec.ms };
  }
}

/**
 * How long one call to source_answer or source_answer_result may take on the machine. The engine holds a source_answer open for its
 * hand-off (at most SOURCE_ANSWER_HANDOFF_MAX_MS) before it answers "working", and a result call waits up to
 * SOURCE_ANSWER_RESULT_WAIT_MAX_MS; the margin covers the machine's exec and the agent's start. Shorter, and a slow answer's "working"
 * reply would never be seen, so a valid install would fail for a note it was about to give.
 */
export const ANSWER_TOOL_CALL_TIMEOUT_MS = Math.max(SOURCE_ANSWER_HANDOFF_MAX_MS, SOURCE_ANSWER_RESULT_WAIT_MAX_MS) + 120_000;

/** Calls the engine's MCP tools on the machine, one `exec` per call. */
function machineToolBridge(run: Run, callTimeoutMs = 180_000): ToolBridge & { tools(): Promise<ToolDefinition[]> } {
  return {
    async tools() {
      const out = await run.agent('mcp-tools');
      const tools = (out.result?.tools ?? []) as Array<ToolDefinition & { annotations?: { readOnlyHint?: boolean } }>;
      // Read-only tools only: the suite must not spend money or send anything on the owner's behalf.
      return tools.filter((tool) => tool.annotations?.readOnlyHint === true).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    async call(name, args) {
      const delimiter = `RC_${randomBytes(6).toString('hex')}`;
      const exec = await run.machine!.exec(
        `${BUN_LOCATE}\n"$BUN" --no-env-file ~/rc/agent.js mcp-call ${sh(name)} "$(cat <<'${delimiter}'\n${JSON.stringify(args)}\n${delimiter}\n)"\n`,
        { timeoutMs: callTimeoutMs },
      );
      const parsed = parseAgentLine(exec.stdout);
      return {
        text: String(parsed?.text ?? ''),
        isError: parsed?.ok !== true || parsed?.isError === true,
        structured: parsed?.structured ?? null,
        noteKind: (parsed?.noteKind as string | null | undefined) ?? null,
      };
    },
  };
}

/** The evidence items a search returned, with the ids a reply cites them by. Items without a title carry no name to check and are left out. */
function evidenceOf(structured: unknown): Array<{ id: string; title: string }> {
  const evidence = (structured as { evidence?: Array<{ id?: string; title?: string }> } | null)?.evidence ?? [];
  return evidence.filter((item) => item.title).map((item) => ({ id: item.id ?? '', title: item.title ?? '' }));
}

async function bundleAgent(workDir: string): Promise<string> {
  const outdir = join(workDir, 'bundle');
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, 'machine-agent.ts')],
      outdir,
      target: 'bun',
      naming: 'agent.js',
      minify: false,
    });
    if (!built.success) throw new Error(built.logs.map(String).join('; '));
  } catch (error) {
    const detail = (error as { errors?: unknown[] }).errors?.map((e) => String((e as Error).message ?? e)).join('; ') ?? (error as Error).message;
    throw new Error(`could not bundle the in-machine agent (run bun install in the Olympus checkout): ${detail.slice(0, 400)}`);
  }
  return join(outdir, 'agent.js');
}

function agentConfig(options: RunOptions): AgentConfig {
  const privateFacts: Record<string, string[]> = {};
  for (const question of SUITE_QUESTIONS) privateFacts[question.id] = [...question.privateFacts];
  const secrets = FIXTURE_ITEMS.filter((item) => item.tier === 'secrets').length;
  return {
    documents: fixtureDocuments(options.mistier ? leakyFixture(options.mistier) : FIXTURE_ITEMS),
    tierRules: tierRules(),
    fakePort: FAKE_READWISE_PORT,
    fakeToken: FAKE_READWISE_TOKEN,
    expectedItems: FIXTURE_ITEMS.length,
    expectedSecrets: secrets,
    expectedPrivate: FIXTURE_ITEMS.filter((item) => item.tier === 'private').length,
    relay: options.config.relay ?? '',
    privateFacts,
    enginePort: ENGINE_PORT,
    inbox: {
      agent: { text: privateQuestion().text, facts: [...privateQuestion().privateFacts], citedTitle: INBOX_ASK.citedTitle },
      ask: { text: INBOX_ASK.text, facts: [...INBOX_ASK.facts], citedTitle: INBOX_ASK.citedTitle },
    },
  };
}

function privateQuestion(): SuiteQuestion {
  return SUITE_QUESTIONS.find((question) => question.kind === 'private')!;
}

function expectedTierCounts(): { personal: number; private: number; secrets: number } {
  const count = (tier: string): number => FIXTURE_ITEMS.filter((item) => item.tier === tier).length;
  return { personal: count('personal'), private: count('private'), secrets: count('secrets') };
}

/** Waits for ingest to settle on the machine and checks that every item landed in its intended tier. */
async function settleIngest(run: Run): Promise<{ settled: boolean; snap?: Record<string, number | string> }> {
  const timeoutS = run.options.config.settleTimeoutS ?? 900;
  const settled = await run.phase('ingest', () => run.agent('settle', `--timeout-s ${timeoutS}`, (timeoutS + 60) * 1000));
  const snap = settled.result?.snapshot as Record<string, number | string> | null | undefined;
  run.add({
    id: 'ingest.settled',
    title: 'Ingest settled: indexed, classified and embedded',
    status: settled.result?.settled === true ? 'pass' : 'fail',
    detail: snap ? `seen ${snap.seen}, indexed ${snap.indexed}, embedded ${snap.embedded}, waited ${Math.round(Number(settled.result?.waitedMs) / 1000)} s` : 'no dashboard snapshot',
    ms: Number(settled.result?.waitedMs ?? settled.ms),
  });
  if (snap) {
    const expected = expectedTierCounts();
    const ok = Number(snap.personal) === expected.personal && Number(snap.privateItems) === expected.private && Number(snap.secretsLocated) === expected.secrets;
    run.add({
      id: 'ingest.tiers',
      title: 'Each item landed in its intended tier',
      status: ok ? 'pass' : 'fail',
      detail: `Personal ${snap.personal}/${expected.personal}, Private ${snap.privateItems}/${expected.private}, Secrets refused ${snap.secretsLocated}/${expected.secrets}`,
    });
  }
  return { settled: settled.result?.settled === true, ...(snap ? { snap } : {}) };
}

async function setupMachine(run: Run, workDir: string, bundlePath: string, installTitle = 'The candidate installed and the engine is running'): Promise<boolean> {
  const machine = run.machine!;
  const configPath = join(workDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(agentConfig(run.options)));
  await machine.exec('mkdir -p ~/rc && chmod 700 ~/rc\n', { timeoutMs: 30_000 });
  await machine.put(bundlePath, '~/rc/agent.js');
  await machine.put(configPath, '~/rc/config.json');

  const build = await run.agent('engine-build', '', 60_000);
  if (typeof build.result?.build === 'string') run.build = build.result.build;
  if (typeof build.result?.version === 'string') run.stage.version = build.result.version;
  run.add({
    id: 'install.engine',
    title: installTitle,
    status: build.result?.ok === true && run.build ? 'pass' : 'fail',
    detail: run.build ? `build ${run.build}` : 'the engine did not report a build',
  });
  if (build.result?.ok !== true) return false;

  const prepare = await run.phase('prepare', () => run.agent('prepare-source', '', 420_000));
  run.add({
    id: 'source.prepare',
    title: 'The test life is wired in (stand-in source, tier rules, engine restart)',
    status: prepare.result?.ok === true ? 'pass' : 'fail',
    detail: prepare.result?.ok === true ? `${prepare.result.rules} tier rule(s) pinned, engine ready after ${Math.round(Number(prepare.result.engineReadyMs) / 1000)} s` : String(prepare.result?.detail ?? prepare.result?.step ?? prepare.stderr.slice(-200)),
    ms: prepare.ms,
  });
  if (prepare.result?.ok !== true) return false;

  const connect = await run.agent('connect-source', '', 120_000);
  run.add({
    id: 'source.connect',
    title: 'The source connects through the dashboard\'s own route',
    status: connect.result?.ok === true ? 'pass' : 'fail',
    detail: String(connect.result?.message ?? connect.result?.detail ?? connect.stderr.slice(-200)),
    ms: connect.ms,
  });
  if (connect.result?.ok !== true) return false;
  await run.agent('sync', '', 60_000);

  return (await settleIngest(run)).settled;
}

/** Carries one raw MCP message to the engine on the machine, through the driver's exec channel. */
function machineRelay(run: Run): Relay {
  return async ({ sid, body }) => {
    const delimiter = `RC_${randomBytes(6).toString('hex')}`;
    let message: unknown;
    try { message = JSON.parse(body); } catch { return { status: 400, contentType: 'text/plain', text: 'not JSON' }; }
    const payload = JSON.stringify({ ...(sid ? { sid } : {}), body: message });
    const exec = await run.machine!.exec(
      `${BUN_LOCATE}\nf=$(mktemp)\ncat > "$f" <<'${delimiter}'\n${payload}\n${delimiter}\n"$BUN" --no-env-file ~/rc/agent.js mcp-rpc --input "$f"\nrc=$?\nrm -f "$f"\nexit $rc\n`,
      { timeoutMs: 180_000 },
    );
    const parsed = parseAgentLine(exec.stdout);
    if (!parsed || parsed.ok !== true) return { status: 502, contentType: 'text/plain', text: 'the machine did not answer' };
    return { status: Number(parsed.status), sid: (parsed.sid as string | null) ?? null, contentType: String(parsed.contentType ?? 'application/json'), text: String(parsed.text ?? '') };
  };
}

function skipped(run: Run, spec: AgentSpec, reason: string): void {
  run.agents.push({ id: spec.id, label: spec.label, kind: 'model', ran: false, skipReason: reason, checks: [] });
  run.log(`agent ${spec.id}: ${reason}`);
}

/**
 * The tools the engine's MCP endpoint lists, read once per stage. Undefined when the listing could not be read (a failed or timed-out
 * call, a refusal, an empty or malformed list): never an empty list, which would read as an install that offers nothing and make every
 * agent look correctly tool-less. A standard install lists olympus_search and not source_answer.
 */
async function offeredToolNames(run: Run): Promise<string[] | undefined> {
  const known = run.offeredTools.get(run.stage.id);
  if (known) return known;
  let listed: Awaited<ReturnType<Run['agent']>>;
  try { listed = await run.agent('mcp-tools', '', 60_000); } catch { return undefined; }
  const tools: unknown = listed.result?.tools;
  if (listed.result?.ok !== true || !Array.isArray(tools) || tools.length === 0) return undefined;
  const names = tools.map((tool) => (tool as { name?: unknown } | null)?.name);
  if (names.some((name) => typeof name !== 'string' || name === '')) return undefined;
  run.offeredTools.set(run.stage.id, names as string[]);
  return names as string[];
}

/** The tool list, or a failing check (once per stage) when it cannot be read: what agents and the link path are judged against is then unknown. */
async function listedTools(run: Run): Promise<string[] | undefined> {
  const names = await offeredToolNames(run);
  if (names === undefined && !run.stage.checks.some((check) => check.id === 'mcp.tool-list')) {
    run.add({
      id: 'mcp.tool-list',
      title: 'The engine\'s MCP endpoint listed its tools',
      status: 'fail',
      detail: 'the listing failed, timed out or came back empty or malformed, so which tools agents are offered, and whether the Private-answer link path exists, cannot be judged',
    });
  }
  return names;
}

/**
 * What one agent saw for one question. The Open link is judged for an agent that called a tool that issues it: olympus_search (what every
 * model agent is told to use, and the only answer tool a standard install offers), source_answer, or source_answer_result, which collects
 * its answer. An agent that called one of them on the Private question and got no note, or a note with no link, fails; the reply carrying
 * the link on to the person is a warning only, since a model decides what to pass on.
 */
export function exchangesObservation(question: SuiteQuestion, agentId: string, finalText: string, exchanges: McpExchange[], ms: number, error: string | undefined): QuestionObservation {
  const toolCalls = exchanges.filter((e) => e.method === 'tools/call');
  const linkIssued = toolCalls.some((call) => call.tool === 'olympus_search' || call.tool === 'source_answer' || call.tool === 'source_answer_result');
  return {
    question,
    visible: [
      { label: `${agentId} reply to ${question.id}`, text: finalText },
      ...toolCalls.flatMap((call) => [
        { label: `${agentId} tool arguments (${question.id})`, text: JSON.stringify(call.args ?? {}) },
        { label: `${agentId} tool output (${question.id})`, text: call.outputText },
      ]),
    ],
    answerText: finalText,
    evidenceTitles: toolCalls.flatMap((c) => evidenceOf(c.structured).map((item) => item.title)),
    evidenceIds: toolCalls.flatMap((c) => evidenceOf(c.structured).map((item) => item.id)),
    privateNote: toolCalls.some((c) => privateNoteKindIn(c.outputText, c.structured) !== null),
    // The note as the tool gave it, link included (a Private question only; any other question has none to judge).
    ...(question.kind === 'private' && linkIssued ? { privateNoteText: toolCalls.map((c) => privateNoteIn(c.outputText, c.structured)).find((note) => note !== null) ?? null } : {}),
    ms,
    ...(error ? { error } : toolCalls.length === 0 ? { error: 'the agent never called the search tool' } : {}),
  };
}

async function judgeAnswer(judge: Judge | undefined, question: SuiteQuestion, text: string): Promise<CheckResult | undefined> {
  if (!judge || (question.kind !== 'personal' && question.kind !== 'file') || !text) return undefined;
  return judgeCheck(`${question.id}.quality`, `${question.id}: the answer matches what a correct answer says`, await judge.judge({ criteria: question.expectation, evidence: text }));
}

async function runModelAgents(run: Run, bridge: ReturnType<typeof machineToolBridge>, judge: Judge | undefined): Promise<void> {
  const specs = (run.options.config.agents ?? []).filter((spec) => spec.enabled !== false && (run.options.onlyAgents === undefined || run.options.onlyAgents.includes(spec.id)));
  // The command-line agents reach the engine through one tunnel whose startup messages are fetched once (see cachingRelay).
  const tunnel = cachingRelay(machineRelay(run));
  let primed: Promise<boolean> | undefined;
  const cliRelay = async (): Promise<Relay> => {
    primed ??= tunnel.prime();
    await primed;
    return tunnel.relay;
  };
  for (const spec of specs) {
    const usage: AgentUsage = { invocations: 0, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, billing: '' };
    const agent: AgentReport = { id: spec.id, label: spec.label, kind: 'model', ran: true, usage, checks: [] };
    let ask: ((question: SuiteQuestion) => Promise<{ observation: QuestionObservation; answer: string }>) | undefined;

    if (spec.kind === 'xai-api') {
      const key = await readAgentKey(spec);
      if (!key) { skipped(run, spec, 'key missing: the xAI API key is not available to this run; skipped'); continue; }
      const tools = await bridge.tools();
      run.add({
        id: 'mcp.tools',
        title: 'The engine\'s MCP endpoint lists its read-only tools',
        status: tools.some((tool) => tool.name === 'olympus_search') ? 'pass' : 'fail',
        detail: `${tools.length} read-only tool(s): ${tools.map((t) => t.name).join(', ')}`,
      });
      usage.billing = 'xAI API, billed per call';
      ask = async (question) => {
        const started = Date.now();
        try {
          const transcript = await runXaiAgent(spec, key, question.text, tools, bridge);
          usage.invocations += 1;
          usage.modelCalls += transcript.usage.calls;
          usage.inputTokens += transcript.usage.inputTokens;
          usage.outputTokens += transcript.usage.outputTokens;
          usage.toolCalls += transcript.calls.length;
          const exchanges: McpExchange[] = transcript.calls.map((c) => ({ method: 'tools/call', tool: c.name, args: c.args, status: 200, outputText: c.output.text, structured: c.output.structured, isError: c.output.isError }));
          return { observation: exchangesObservation(question, spec.id, transcript.finalText, exchanges, Date.now() - started, undefined), answer: transcript.finalText };
        } catch (error) {
          usage.invocations += 1;
          if (error instanceof AgentApiError) {
            usage.modelCalls += error.usage.calls;
            usage.inputTokens += error.usage.inputTokens;
            usage.outputTokens += error.usage.outputTokens;
            usage.toolCalls += error.calls.length;
          }
          return { observation: exchangesObservation(question, spec.id, '', [], Date.now() - started, error instanceof Error ? error.message : String(error)), answer: '' };
        }
      };
    } else if (spec.kind === 'claude-code') {
      const token = await readAgentKey(spec);
      if (!token) { skipped(run, spec, 'key missing: no Claude Code setup token is available to this run; skipped'); continue; }
      if (!looksLikeClaudeSetupToken(token)) { skipped(run, spec, 'the configured credential is not a Claude Code setup token; skipped'); continue; }
      usage.billing = 'Claude subscription (setup token)';
      ask = async (question) => {
        const started = Date.now();
        const proxy = startMcpProxy(await cliRelay());
        try {
          const result = await runClaudeCode({ token, question: question.text, mcpUrl: proxy.url, ...(spec.model ? { model: spec.model } : {}) });
          usage.invocations += result.usage.invocations;
          usage.modelCalls += result.usage.modelCalls;
          usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens;
          usage.toolCalls += proxy.exchanges.filter((e) => e.method === 'tools/call').length;
          return { observation: exchangesObservation(question, spec.id, result.finalText, proxy.exchanges, Date.now() - started, result.error), answer: result.finalText };
        } finally {
          proxy.stop();
        }
      };
    } else {
      if (!codexLoginAvailable()) { skipped(run, spec, 'no ChatGPT login for Codex on this host: run `codex login` once on the machine that runs the suite; skipped'); continue; }
      usage.billing = 'ChatGPT subscription (Codex login)';
      ask = async (question) => {
        const started = Date.now();
        const proxy = startMcpProxy(await cliRelay());
        try {
          const result = await runCodex({ question: question.text, mcpUrl: proxy.url, ...(spec.model ? { model: spec.model } : {}) });
          usage.invocations += result.usage.invocations;
          usage.modelCalls += result.usage.modelCalls;
          usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens;
          usage.toolCalls += proxy.exchanges.filter((e) => e.method === 'tools/call').length;
          return { observation: exchangesObservation(question, spec.id, result.finalText, proxy.exchanges, Date.now() - started, result.error), answer: result.finalText };
        } finally {
          proxy.stop();
        }
      };
    }

    await run.phase(`agent-${spec.id}`, async () => {
      for (const question of SUITE_QUESTIONS) {
        const { observation, answer } = await ask!(question);
        agent.checks.push(...evaluateObservation(observation, run.markers, { judgeLinks: run.linksJudged }));
        // Only the candidate's links reach the Inbox leg: an earlier release's ids name entries the update may not carry.
        if (run.linksJudged) for (const id of privateLinkIdsIn(observation.privateNoteText ?? '')) run.agentLinks.push({ agent: spec.id, id });
        // The judge sees an answer only when nothing leaked into it.
        const leaked = agent.checks.some((c) => c.id === `${question.id}.no-leak` && c.status === 'fail');
        const judged = leaked ? undefined : await judgeAnswer(judge, question, answer);
        if (judged) agent.checks.push(judged);
      }
    });
    for (const check of agent.checks) run.log(`agent ${spec.id} ${check.status.toUpperCase()} ${check.id}${check.detail ? ` - ${check.detail}` : ''}`);
    run.log(`agent ${spec.id} usage: ${usage.invocations} invocation(s), ${usage.modelCalls} model call(s), ${usage.toolCalls} tool call(s), ${usage.inputTokens} in / ${usage.outputTokens} out tokens (${usage.billing})`);
    run.agents.push(agent);
  }
}

/** A short, plaintext-free reason for a missing private answer: the panel state and, if a job ran, its status. */
function panelWhy(row: Record<string, any>): string {
  const state = row.panelState ?? 'no panel';
  const panel = row.panel as { ok?: boolean; status?: string; detail?: string; polls?: number } | null;
  const tries = (row.attempts as Array<{ panelState: string | null; noteKind: string | null; atS: number }> | undefined) ?? [];
  const history = tries.length > 0 ? `; ${tries.length} attempt(s): ${tries.map((a) => `${a.panelState ?? 'no panel'}/${a.noteKind ?? 'no note'}@${a.atS}s`).join(', ')}` : '';
  return (panel && panel.ok === false ? `panel ${state}, job ${panel.status ?? 'unknown'}: ${panel.detail ?? ''}`.trim() : `panel state ${state}`) + history;
}

async function runProtocolAgent(run: Run, workDir: string): Promise<void> {
  const relay = run.options.config.relay;
  if (run.options.skipRelay || !relay) {
    run.agents.push({
      id: 'chatgpt-protocol', label: 'ChatGPT protocol (production relay)', kind: 'protocol', ran: false,
      skipReason: run.options.skipRelay ? 'skipped by option' : 'no relay configured for this run', checks: [],
    });
    return;
  }
  const questionsPath = join(workDir, 'questions.json');
  writeFileSync(questionsPath, JSON.stringify(SUITE_QUESTIONS.map((q) => ({ id: q.id, text: q.text, kind: q.kind }))));
  await run.machine!.put(questionsPath, '~/rc/questions.json');
  const agent: AgentReport = { id: 'chatgpt-protocol', label: 'ChatGPT protocol (production relay)', kind: 'protocol', ran: true, checks: [] };
  await run.phase('agent-chatgpt-protocol', async () => {
    const out = await run.agent('smoke', '--questions ~/rc/questions.json', 900_000);
    const results = (out.result?.results ?? []) as Array<Record<string, any>>;
    if (out.result?.ok !== true || results.length === 0) {
      agent.checks.push({ id: 'protocol.ran', title: 'The ChatGPT-protocol pass ran', status: 'fail', detail: `no results (exit ${out.code}; smoke exit ${out.result?.exit ?? 'n/a'}): ${(out.result?.detail ?? out.stderr.slice(-200))}` });
      return;
    }
    run.add({ id: 'relay.reachable', title: 'The machine is reachable through the production relay', status: 'pass', detail: `ChatGPT-protocol grant minted; ${(out.result.tools as string[]).length} tool(s) listed` });
    // The smoke's own verdict stands: its private-content and panel checks are stronger than anything re-derived here.
    agent.checks.push(evaluateSmokeVerdict(out.result.exit, (out.result.smokeChecks ?? []) as string[], run.markers));
    for (const question of SUITE_QUESTIONS) {
      const row = results.find((r) => r.id === question.id);
      if (!row) {
        agent.checks.push({ id: `${question.id}.ran`, title: `${question.id}: the agent answered`, status: 'fail', detail: 'no result for this question' });
        continue;
      }
      const observation: QuestionObservation = {
        question,
        visible: [{ label: `chatgpt-protocol tool result (${question.id})`, text: String(row.text ?? '') }],
        answerText: String(row.text ?? ''),
        evidenceTitles: (row.evidence as Array<{ title: string }>).map((e) => e.title),
        privateNote: row.noteKind !== null && row.noteKind !== undefined,
        ms: Number(row.searchMs ?? 0),
        ...(row.isError ? { error: 'the tool returned an error' } : {}),
        ...(question.kind === 'private'
          ? { localPrivate: { present: row.privateAnswer !== null, factsStated: (row.privateAnswer?.factsStated ?? []) as boolean[], ms: row.panel?.totalMs, why: panelWhy(row), note: Array.isArray(row.attempts) && row.attempts.length > 1 ? `answer model started on attempt ${row.attempts.length} (${row.attempts[row.attempts.length - 1].atS} s after the first)` : '' } }
          : {}),
      };
      agent.checks.push(...evaluateObservation(observation, run.markers));
    }
  });
  for (const check of agent.checks) run.log(`agent chatgpt-protocol ${check.status.toUpperCase()} ${check.id}${check.detail ? ` - ${check.detail}` : ''}`);
  run.agents.push(agent);
}

const TEXT_EXT = /\.(log|json|txt|md|err)$/;

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path)); else out.push(path);
  }
  return out;
}

async function collectEvidence(run: Run, outDir: string): Promise<void> {
  const machine = run.machine!;
  const dash = await run.agent('dashboard-json', '', 60_000);
  if (dash.result?.ok === true) {
    const body = String(dash.result.body ?? '');
    run.add(evaluateArtifactScan('the dashboard payload', [{ label: 'dashboard.json', text: body }], run.markers));
    const dashPath = join(outDir, 'logs', 'dashboard.json');
    writeFileSync(dashPath, redactMarkers(body, run.markers));
    run.logs.push({ label: 'dashboard.json (redacted)', path: 'logs/dashboard.json' });
  } else {
    run.add({ id: 'scan.the dashboard payload', title: 'No Private or Secret content in the dashboard payload', status: 'fail', detail: 'the dashboard payload could not be read' });
  }

  const remoteLogs = '~/rc/logs';
  const collected = await run.agent('collect-logs', `--out ${remoteLogs}`, 120_000);
  if (collected.result?.ok === true) {
    const local = join(outDir, 'logs', 'machine');
    mkdirSync(local, { recursive: true });
    for (const file of collected.result.files as string[]) {
      try { await machine.get(`${remoteLogs}/${file}`, join(local, file)); } catch { run.log(`could not fetch ${file}`); }
    }
    const texts = listFiles(local).filter((path) => TEXT_EXT.test(path)).map((path) => ({ label: path.slice(local.length + 1), text: readFileSync(path, 'utf8') }));
    run.add(evaluateArtifactScan('the engine logs and status output', texts, run.markers));
    for (const path of listFiles(local)) {
      if (TEXT_EXT.test(path)) writeFileSync(path, redactMarkers(readFileSync(path, 'utf8'), run.markers));
      run.logs.push({ label: path.slice(local.length + 1), path: `logs/machine/${path.slice(local.length + 1)}` });
    }
  } else {
    run.add({ id: 'scan.the engine logs and status output', title: 'No Private or Secret content in the engine logs and status output', status: 'fail', detail: 'the machine logs could not be collected' });
  }
}

async function captureScreenshots(run: Run, outDir: string): Promise<void> {
  if (run.options.skipScreenshots) return;
  const remoteDir = '~/rc/shots';
  const shot = await run.phase('screenshots', () => run.agent('screenshots', `--out ${remoteDir}`, 240_000));
  if (shot.result?.ok !== true) {
    run.add({ id: 'dashboard.screenshots', title: 'Dashboard screenshots at 390 and 1280 wide, light and dark', status: 'fail', detail: String(shot.result?.detail ?? shot.stderr.slice(-200)) });
    return;
  }
  const localDir = join(outDir, 'screenshots');
  mkdirSync(localDir, { recursive: true });
  const shots = shot.result.shots as Array<{ file: string; width: number; theme: 'light' | 'dark'; bytes: number }>;
  for (const item of shots) {
    const name = item.file.split('/').pop()!;
    try {
      await run.machine!.get(`${remoteDir}/${name}`, join(localDir, name));
      run.screenshots.push({ label: `${item.width} px wide, ${item.theme}`, path: `screenshots/${name}`, width: item.width, theme: item.theme });
    } catch { run.log(`could not fetch screenshot ${name}`); }
  }
  const overflow = Number(shot.result.overflowPx390);
  // The owner's one-time opening link must have signed the browser in; a refusal page would still screenshot fine.
  let landed: { path?: string; text?: string } = {};
  try { landed = JSON.parse(String(shot.result.landed ?? '{}')) as { path?: string; text?: string }; } catch { /* reported below */ }
  const refused = /no longer valid|missing its opening ticket|Opening failed/i.test(landed.text ?? '');
  const onDashboard = (landed.path ?? '').startsWith('/dashboard') && !(landed.path ?? '').startsWith('/dashboard/launch');
  run.add({
    id: 'dashboard.opens',
    title: 'The owner\'s opening link signs in and the dashboard renders',
    status: onDashboard && !refused && String(shot.result.pageTitle ?? '') === 'Olympus' ? 'pass' : 'fail',
    detail: refused ? 'the opening link was refused' : onDashboard ? `landed on ${landed.path}` : `landed on ${landed.path ?? 'no page'}`,
  });
  run.add({
    id: 'dashboard.screenshots',
    title: 'Dashboard screenshots at 390 and 1280 wide, light and dark',
    status: run.screenshots.length === 4 && shots.every((s) => s.bytes > 4_000) ? 'pass' : 'fail',
    detail: `${run.screenshots.length} of 4 captured`,
    ms: shot.ms,
  });
  run.add({
    id: 'dashboard.no-overflow',
    title: 'The dashboard does not scroll sideways at 390 px',
    status: Number.isFinite(overflow) && overflow <= 0 ? 'pass' : 'fail',
    detail: Number.isFinite(overflow) ? `${overflow} px of horizontal overflow` : 'overflow not measured',
  });
}

/**
 * Asks source_answer and, while it says the answer is still being prepared, collects it with source_answer_result as the tool tells an
 * agent to (never asking again). Returns the last result: the answer, or the working reply when the wait ran out.
 */
async function askAndCollect(bridge: ReturnType<typeof machineToolBridge>, args: { question: string }): Promise<Awaited<ReturnType<ReturnType<typeof machineToolBridge>['call']>>> {
  let call = await bridge.call('source_answer', args);
  const until = Date.now() + 600_000;
  for (;;) {
    let reply: { status?: unknown; job_id?: unknown } | null = null;
    try { reply = JSON.parse(call.text) as { status?: unknown; job_id?: unknown } | null; } catch { reply = null; }
    if (reply?.status !== 'working' || typeof reply.job_id !== 'string' || Date.now() >= until) return call;
    await new Promise((done) => setTimeout(done, Number(process.env.RELEASE_CHECK_ANSWER_POLL_MS ?? '10000')));
    call = await bridge.call('source_answer_result', { job_id: reply.job_id });
  }
}

/** Dashboard screenshots the Inbox leg must bring back, by file name. */
const INBOX_SHOTS = ['ask-page-1280.png', 'ask-page-390.png', 'inbox-entry-1280.png', 'inbox-entry-390.png', 'ask-answered-1280.png'];

/**
 * The 1.1.0 surfaces, in the owner's browser on the machine: an agent's Private question reaches the Inbox by the link it was given
 * and the local model answers it; the Ask page's "Ask the local model" answers a typed question and keeps it in the Inbox; Venice and
 * zkAPI, not set up, show the way to fix that and send nothing. A scripted agent (no model, nothing billed) asks the Private question
 * so the Inbox entry exists whichever model agents ran; the model agents' own links are checked to resolve too.
 */
async function runInboxLeg(run: Run, outDir: string): Promise<void> {
  if (run.options.skipInbox) return;
  // Judged against what this install offers: a listing that cannot be read fails the run, and the leg does not guess.
  const offered = await listedTools(run);
  if (offered === undefined) return;
  const bridge = machineToolBridge(run, ANSWER_TOOL_CALL_TIMEOUT_MS);
  const question = privateQuestion();
  const selftest = run.options.inboxSelftest;

  const scripted: AgentReport = { id: 'scripted', label: 'Scripted agent over MCP (no model, nothing billed)', kind: 'model', scripted: true, ran: true, checks: [] };
  // The scripted agent asks as an agent on a standard install does, with olympus_search: on a Private match it records the question for
  // the Inbox and carries the note with the Open link. source_answer (collected with source_answer_result) is asked only where the
  // search is not offered. An install that offers neither has no link path to exercise, and the report says so.
  const tool = offered.includes('olympus_search') ? 'olympus_search' : offered.includes('source_answer') ? 'source_answer' : undefined;
  const linkMode: 'issued' | 'not_offered' = tool ? 'issued' : 'not_offered';
  let scriptedId: string | undefined;
  if (tool === undefined) {
    scripted.ran = false;
    scripted.skipReason = 'this install offers neither olympus_search nor source_answer, so there is no tool to ask the Private question with';
    run.log(`agent scripted: ${scripted.skipReason}`);
  } else {
    await run.phase('agent-scripted', async () => {
      const started = Date.now();
      const args = { question: question.text };
      let call: Awaited<ReturnType<typeof bridge.call>> | undefined;
      let error: string | undefined;
      try { call = tool === 'source_answer' ? await askAndCollect(bridge, args) : await bridge.call(tool, args); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      const note = call ? privateNoteIn(call.text, call.structured) : null;
      // The reply is the note passed on as written, which is what the tool tells an agent to do. The self-test adds a Private fact to it.
      const reply = `${note ?? ''}${selftest === 'plant-private-reply' ? ` Reference: ${PRIVATE_FACTS[0]}.` : ''}`;
      const exchanges: McpExchange[] = call ? [{ method: 'tools/call', tool, args, status: 200, outputText: call.text, structured: call.structured, isError: call.isError }] : [];
      const observation = exchangesObservation(question, 'scripted', reply, exchanges, Date.now() - started, error ?? (call?.isError ? 'the tool returned an error' : undefined));
      scripted.checks.push(...evaluateObservation(observation, run.markers));
      scriptedId = privateLinkIdsIn(observation.privateNoteText ?? '')[0];
    });
  }
  for (const check of scripted.checks) run.log(`agent scripted ${check.status.toUpperCase()} ${check.id}${check.detail ? ` - ${check.detail}` : ''}`);
  run.agents.push(scripted);

  // The wrong-link self-test: the id handed to the browser is not the one the link named, so no entry can be found under it.
  const primary = selftest === 'wrong-link-id' && scriptedId ? `${scriptedId.slice(0, 21)}${scriptedId[21] === 'A' ? 'B' : 'A'}` : scriptedId;
  // Without a link there is nothing to corrupt: the fault goes to the id of the Ask page's own entry, which the in-machine check opens by address.
  const corruptAskEntry = selftest === 'wrong-link-id' && linkMode === 'not_offered';
  run.inboxSelftestFailsOn = linkMode === 'issued' ? 'inbox.agent.entry' : 'inbox.link.opens-entry';
  const others = [...new Set(run.agentLinks.map((link) => link.id))];
  const remoteDir = '~/rc/inbox-shots';
  const done = await run.phase('inbox', () => run.agent('inbox-check', `--primary ${sh(primary ?? '')} --ids ${sh(others.join(','))} --wait-s 600${corruptAskEntry ? ' --fault-entry-id' : ''} --out ${remoteDir}`, 2_700_000));
  const observation = done.result as InboxObservation | undefined;
  if (!observation || typeof observation.ok !== 'boolean') {
    run.add({ id: 'inbox.ran', title: 'The Ask page and the Inbox were driven in the owner\'s browser', status: 'fail', detail: `no result from the machine (exit ${done.code}): ${done.stderr.slice(-200)}` });
    return;
  }
  for (const check of evaluateInbox(observation, { scriptedId: primary, agentLinks: run.agentLinks, agentLink: linkMode, agentTools: offered })) run.add(check);

  const localDir = join(outDir, 'screenshots');
  mkdirSync(localDir, { recursive: true });
  const fetched: string[] = [];
  for (const shot of observation.shots ?? []) {
    const name = shot.file.split('/').pop()!;
    try {
      await run.machine!.get(`${remoteDir}/${name}`, join(localDir, name));
      run.screenshots.push({ label: shot.label, path: `screenshots/${name}`, width: shot.width, theme: shot.theme });
      if (shot.bytes > 4_000) fetched.push(name);
    } catch { run.log(`could not fetch screenshot ${name}`); }
  }
  if (observation.trace && observation.trace.length > 0) {
    const steps = [];
    for (const traced of observation.trace) {
      let screenshot: string | undefined;
      if (traced.screenshot) {
        try {
          mkdirSync(join(outDir, 'traces', 'inbox-check'), { recursive: true });
          await run.machine!.get(`${remoteDir}/${traced.screenshot}`, join(outDir, 'traces', 'inbox-check', traced.screenshot));
          screenshot = `inbox-check/${traced.screenshot}`;
        } catch { run.log(`could not fetch trace picture ${traced.screenshot}`); }
      }
      const { screenshot: _remote, ...rest } = traced;
      steps.push({ ...rest, ...(screenshot ? { screenshot } : {}) });
    }
    (run.stage.traces ??= []).push({ id: 'inbox-check', title: 'The Ask page and the Inbox, in the owner\'s browser', source: 'the Inbox leg', ok: steps.every((step) => step.ok) && observation.ok, steps, ms: steps.reduce((sum, step) => sum + step.ms, 0), ...(observation.ok ? {} : { error: observation.detail ?? 'the leg did not finish' }) });
  }
  const stepFindings = (observation.trace ?? []).flatMap((traced) => (traced.findings ?? []).map((finding) => `${traced.name}: ${finding}`));
  if (observation.trace && observation.trace.length > 0) {
    run.add({ id: 'inbox.browser-errors', title: 'The Ask page and Inbox steps ran without console errors or failed requests', status: stepFindings.length === 0 ? 'pass' : 'fail', detail: stepFindings.length === 0 ? `${observation.trace.length} steps, no browser errors` : stepFindings.slice(0, 5).join('; ') });
  }
  const missing = INBOX_SHOTS.filter((name) => !fetched.includes(name));
  run.add({
    id: 'inbox.screenshots',
    title: 'The Ask page and an opened Inbox entry were captured for the report',
    status: observation.ok && missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0 ? `${fetched.length} screenshots (they show the synthetic test life's Private answer, as the owner's own browser does)` : `missing: ${missing.join(', ')}`,
  });
}

/**
 * Bounded exploration of every control in the dashboard's Sources section (explore.ts): the controls are listed from the product's
 * source here, on the host; the machine seeds the install in each state, presses each control by itself and judges it. The rules
 * block; the coverage is advisory. Destructive controls are pressed here only because this is the throwaway machine.
 */
async function runExploreLeg(run: Run, outDir: string): Promise<void> {
  if (run.options.skipExplore) return;
  const inventory = buildInventory(undefined, run.machine!.os);
  const scratch = join(outDir, '_explore');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const inventoryPath = join(scratch, 'inventory.json');
  writeFileSync(inventoryPath, JSON.stringify(inventory));
  await run.machine!.put(inventoryPath, '~/rc/explore-inventory.json');
  const pagesInventoryPath = join(scratch, 'pages-inventory.json');
  writeFileSync(pagesInventoryPath, JSON.stringify(buildPageInventory()));
  await run.machine!.put(pagesInventoryPath, '~/rc/explore-pages-inventory.json');
  // The accessibility checker (axe-core, a dev dependency): its script goes to the machine beside the inventory. Missing (no bun install), the audit is skipped and says so.
  const axePath = join(import.meta.dir, '..', '..', 'node_modules', 'axe-core', 'axe.min.js');
  if (existsSync(axePath)) await run.machine!.put(axePath, '~/rc/axe.min.js');
  const done = await run.phase('explore', () => run.agent('explore', '--out ~/rc/explore --inventory ~/rc/explore-inventory.json --pages-inventory ~/rc/explore-pages-inventory.json', 5_100_000));
  const result = done.result;
  if (!result || result.result === undefined) {
    run.add({ id: 'explore.ran', title: 'Every control of the Sources section was pressed', status: 'fail', detail: `no result from the machine (exit ${done.code}): ${done.stderr.slice(-200)}` });
    rmSync(scratch, { recursive: true, force: true });
    return;
  }
  if (result.ok !== true || result.result === null) run.add({ id: 'explore.ran', title: 'Every control of the Sources section was pressed', status: 'fail', detail: String(result.detail ?? 'the machine reported a problem') });
  try {
    await run.machine!.get(String(result.archive), join(scratch, 'explore.tgz'));
    const unpacked = spawnSync('tar', ['-xzf', join(scratch, 'explore.tgz'), '-C', scratch], { encoding: 'utf8' });
    if (unpacked.status !== 0) throw new Error(`tar: ${unpacked.stderr.slice(0, 120)}`);
    if (existsSync(join(scratch, 'traces'))) cpSync(join(scratch, 'traces'), join(outDir, 'traces'), { recursive: true });
  } catch (error) {
    run.add({ id: 'explore.fetch', title: 'The exploration traces were brought back', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
  rmSync(scratch, { recursive: true, force: true });
  if (result.result === null) return;
  const explored = result.result as ExploreResult;
  run.stage.explore = explored;
  (run.stage.traces ??= []).push(...explored.traces, ...(explored.pages?.traces ?? []));
  for (const check of exploreChecks(explored)) run.add(check);
}

/**
 * The journeys and the screens, in the owner's browser on the machine (journeys.ts, visual.ts). The machine takes the screens and walks
 * the journeys; one archive comes back with a trace (and a picture after each step) per journey and the screens. The screens are
 * compared with the approved pictures where `--baselines` names them; `--update-baselines` writes them as candidates instead.
 */
async function runJourneyLeg(run: Run, outDir: string): Promise<void> {
  const options = run.options;
  if (options.skipJourneys) return;
  const only = options.onlyJourneys?.length ? ` --only ${sh(options.onlyJourneys.join(','))}` : '';
  const plants = options.reviewerPlants ? ' --plants' : '';
  const done = await run.phase('journeys', () => run.agent('journeys', `--out ~/rc/journeys${only}${plants}`, 2_400_000));
  const result = done.result;
  if (!result || !Array.isArray(result.traces)) {
    run.add({ id: 'journeys.ran', title: 'The journeys were walked in the owner\'s browser', status: 'fail', detail: `no result from the machine (exit ${done.code}): ${done.stderr.slice(-200)}` });
    return;
  }
  if (result.ok !== true) run.add({ id: 'journeys.ran', title: 'The journeys were walked in the owner\'s browser', status: 'fail', detail: String(result.detail ?? 'the machine reported a problem') });
  const scratch = join(outDir, '_journeys');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    await run.machine!.get(String(result.archive), join(scratch, 'journeys.tgz'));
    const unpacked = spawnSync('tar', ['-xzf', join(scratch, 'journeys.tgz'), '-C', scratch], { encoding: 'utf8' });
    if (unpacked.status !== 0) throw new Error(`tar: ${unpacked.stderr.slice(0, 120)}`);
  } catch (error) {
    run.add({ id: 'journeys.fetch', title: 'The journey traces and screens were brought back', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    rmSync(scratch, { recursive: true, force: true });
    return;
  }
  if (existsSync(join(scratch, 'traces'))) cpSync(join(scratch, 'traces'), join(outDir, 'traces'), { recursive: true });
  // The screens as a person saw them, before the mask, for the AI reviewer (reviewer.ts).
  if (existsSync(join(scratch, 'review'))) cpSync(join(scratch, 'review'), join(outDir, 'review'), { recursive: true });
  if (options.reviewerPlants) {
    // The planted pictures and what was planted in each, for reviewer-qualify.ts. Such a run never counts for a release.
    const planted = Array.isArray(result.planted) ? result.planted : [];
    if (existsSync(join(scratch, 'plants'))) cpSync(join(scratch, 'plants'), join(outDir, 'plants'), { recursive: true });
    mkdirSync(join(outDir, 'plants'), { recursive: true });
    writeFileSync(join(outDir, 'plants', 'index.json'), `${JSON.stringify(planted, null, 2)}\n`);
    // The layout rules are scored here (they need no model): every bug planted for a rule found, nothing on the clean pictures.
    const layoutScore = scoreLayoutRules(planted as PlantedPicture[]);
    writeFileSync(join(outDir, 'plants', 'layout.json'), `${JSON.stringify(layoutScore, null, 2)}\n`);
    run.add(layoutQualificationCheck(layoutScore));
    run.add({ id: 'reviewer.plants', title: 'The pictures with planted bugs were taken for the reviewer\'s qualification', status: planted.some((item: { plant?: unknown }) => item.plant) ? 'pass' : 'fail', detail: `${planted.length} picture(s), ${planted.filter((item: { plant?: unknown }) => item.plant).length} with a planted bug` });
  }
  const traces = result.traces as JourneyTrace[];
  (run.stage.traces ??= []).push(...traces);
  for (const check of journeyChecks(traces)) run.add(check);

  const screens = (Array.isArray(result.screens) ? result.screens : []) as Array<{ name: string; screen: string; width: number; theme: string; layout?: unknown[] }>;
  for (const check of layoutChecks(screens.map((item) => ({ name: item.name, ...(Array.isArray(item.layout) ? { layout: layoutFindings([item.layout]) } : {}) })))) run.add(check);
  if (options.baselinesDir) {
    const names = screens.flatMap((item) => { const screen = SCREENS.find((candidate) => candidate.id === item.screen); return screen ? [{ name: item.name, screen, width: item.width, theme: item.theme }] : []; });
    const compared = compareScreens({ actualDir: join(scratch, 'screens'), baselinesDir: options.baselinesDir, outDir, update: options.updateBaselines === true, approvalDigest: currentApprovalDigest(), names, expected: SCREENS.flatMap((screen) => SCREEN_WIDTHS.flatMap((width) => SCREEN_THEMES.map((theme) => screenName(screen.id, width, theme)))) });
    run.stage.visual = compared.results;
    for (const check of visualChecks(compared)) run.add(check);
    const expected = SCREENS.length * 4;
    if (compared.results.length < expected) run.add({ id: 'visual.complete', title: 'Every screen was captured for the comparison', status: 'fail', detail: `${compared.results.length} of ${expected} pictures came back` });
  } else {
    run.add({ id: 'visual.baselines', title: 'The screens were compared with the approved pictures', status: 'skip', detail: 'no --baselines folder was given' });
  }
  rmSync(scratch, { recursive: true, force: true });
}

/**
 * The archive-import leg (archive-leg.ts, archive-stages.ts), on the machine. The order matters: the picker runs first because "Import an
 * archive" is a top-level button only while no archive is listed; the agent path follows and waits for the private model to judge what it
 * imported, so the search is cited; then the private model is switched off, an archive is imported with it off, and it is switched back
 * on (always, in the end, whatever failed) so the held messages drain; Remove takes the archives away; the changed-file stage uses
 * its own large archive. Each format besides the stress one (mail) is imported by the agent path right after the mail archive, judged
 * and searched the same way, and removed with the others. Whatever happened, the machine's archives and fixtures are cleaned up last.
 */
async function runArchiveLeg(run: Run, outDir: string, deadline: number): Promise<void> {
  if (run.options.skipArchive) return;
  const os = run.machine!.os;
  const seed = randomBytes(6).toString('hex');
  const fixture = (role: FixtureRole) => legFixture(role, seed, STRESS_FORMAT);
  const [agentFx, pickerFx, heldFx] = [fixture('agent'), fixture('picker'), fixture('held')];
  // Each other format's small archive: the same role as the mail one, told apart by its format.
  const extraFxs = EXTRA_FORMATS.map((format) => legFixture('agent', seed, format));
  const drainS = drainBoundS(os);
  const traces: JourneyTrace[] = [];
  const stepS = ARCHIVE_BOUNDS.startS + ARCHIVE_BOUNDS.settleS + 600;
  const outOfTime = (what: string): boolean => {
    if (Date.now() < deadline) return false;
    run.errors.push(`the run exceeded its time budget before ${what}`);
    return true;
  };
  /** One in-machine verb; its result, or undefined (the checks then say there was none) with the machine's last words in the log. */
  const call = async <T extends object>(sub: string, args: string, timeoutS: number): Promise<T | undefined> => {
    const done = await run.phase(sub, () => run.agent(sub, args, timeoutS * 1_000));
    if (!done.result) run.log(`${sub}: no result from the machine (exit ${done.code}): ${done.stderr.slice(-300)}`);
    const result = done.result as T | undefined;
    const own = (result as { traces?: JourneyTrace[] } | undefined)?.traces;
    if (Array.isArray(own)) traces.push(...own);
    return result;
  };
  const addAll = (checks: CheckResult[]): void => { for (const check of checks) run.add(check); };
  const flags = (fx: { role: string; format: string }): string => `--role ${fx.role} --format ${fx.format} --seed ${sh(seed)}`;

  let modelTouched = false;
  let modelOn: ModelObservation | undefined;
  try {
    // 1. The owner chooses a file in the picker (nothing is listed yet).
    const picker = await call<ImportObservation>('archive-import', `${flags(pickerFx)} --via picker --reset-folder --clean`, stepS);
    addAll(importChecks(picker, pickerFx, os));

    // 2. An agent asks; the owner approves in the dashboard; the private model judges; a search is cited.
    if (!outOfTime('the agent-path archive import')) {
      const agent = await call<ImportObservation>('archive-import', `${flags(agentFx)} --via request --drain-s ${drainS} --search`, stepS + drainS);
      addAll(importChecks(agent, agentFx, os));
    }

    // 2b. The same for each other format: a request, the owner's approval, the judge, a search cited with the format's own label.
    for (const extraFx of extraFxs) {
      if (outOfTime(`the ${extraFx.format} archive import`)) break;
      const extra = await call<ImportObservation>('archive-import', `${flags(extraFx)} --via request --drain-s ${drainS} --search`, stepS + drainS);
      addAll(importChecks(extra, extraFx, os));
    }

    // 3. The private model off: the archive stays held Private and nothing leaves the machine.
    if (!outOfTime('the private-model-off archive import')) {
      modelTouched = true;
      const off = await call<ModelObservation>('archive-model', '--mode off', ARCHIVE_BOUNDS.engineS + 240);
      addAll(modelChecks(off, 'off'));
      if (off?.ok === true) {
        const held = await call<ImportObservation>('archive-import', `${flags(heldFx)} --via request --search --watch-egress`, stepS);
        addAll(heldOffChecks(held, heldFx));
      } else {
        run.add({ id: `archive.${heldFx.role}.${heldFx.format}.ran`, title: 'The archive was imported with the private model off', status: 'fail', detail: 'not run: the private model could not be turned off' });
      }
    }
  } finally {
    // 4. The private model back on, whatever happened above.
    if (modelTouched) {
      modelOn = await call<ModelObservation>('archive-model', '--mode on', ARCHIVE_BOUNDS.engineS + 240);
      addAll(modelChecks(modelOn, 'on'));
    }
  }

  try {
    // 5. What was held drains to zero within the leg's own bound, and becomes searchable.
    if (modelTouched && modelOn?.ok === true && !outOfTime('the held archive drain')) {
      const drained = await call<ImportObservation>('archive-drain', `${flags(heldFx)} --search --bound-s ${drainS}`, drainS + 300);
      const prefix = `archive.${heldFx.role}.${heldFx.format}.restored`;
      addAll(drainChecks(`${prefix}.drain`, drained?.drain, heldFx, os, 'restored'));
      addAll(searchChecks(prefix, drained?.search, heldFx, 'cited'));
    } else if (modelTouched) {
      run.add({ id: `archive.${heldFx.role}.${heldFx.format}.restored.drain`, title: 'With the private model back on, the messages that were held are judged: held reaches zero', status: 'fail', detail: 'not run: the private model was not switched back on' });
    }

    // 6. Remove takes each archive away, and only that archive.
    if (!outOfTime('removing the archives')) {
      const targets = [agentFx, ...extraFxs, pickerFx, heldFx];
      const removed = await call<RemoveObservation>('archive-remove', `--targets ${sh(targets.map((fx) => `${fx.role}:${fx.format}`).join(','))} --seed ${sh(seed)}`, targets.length * (ARCHIVE_BOUNDS.removeS + 180) + 120);
      traces.push(...(removed?.removals ?? []).flatMap((removal) => removal.traces));
      addAll(removeChecks(removed, targets));
    }

    // 7. A file that changes while it is imported stops the import, visibly.
    if (!outOfTime('the changed-file check')) {
      const changed = await call<ChangedObservation>('archive-changed', `--seed ${sh(seed)} --sizes ${BULK_SIZES.join(',')}`, BULK_SIZES.length * (ARCHIVE_BOUNDS.startS + ARCHIVE_BOUNDS.removeS + 120) + ARCHIVE_BOUNDS.stopS + ARCHIVE_BOUNDS.removeS + 300);
      addAll(changedChecks(changed));
    }
  } finally {
    // 8. Nothing is left on the machine: every archive off the Archives line, the fixtures folder gone.
    const cleaned = await call<{ ok?: boolean; removed?: string[]; detail?: string }>('archive-cleanup', '', ARCHIVE_BOUNDS.removeS + 300);
    run.add({
      id: 'archive.cleanup',
      title: 'The test archives were removed from the machine at the end of the leg',
      status: cleaned?.ok === true ? 'pass' : 'fail',
      detail: cleaned?.ok === true ? `${cleaned.removed?.length ? `${cleaned.removed.length} left over archive(s) removed; ` : ''}fixtures folder deleted` : String(cleaned?.detail ?? 'no result from the machine'),
    });
  }

  // The pictures and traces of every step.
  (run.stage.traces ??= []).push(...traces);
  const packed = await run.agent('archive-collect', '', 120_000);
  if (packed.result?.ok !== true) {
    run.add({ id: 'archive.fetch', title: 'The archive leg\'s traces were brought back', status: 'fail', detail: String(packed.result?.detail ?? `no result from the machine (exit ${packed.code})`) });
    return;
  }
  const scratch = join(outDir, '_archive');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  try {
    await run.machine!.get(String(packed.result.archive), join(scratch, 'archive.tgz'));
    const unpacked = spawnSync('tar', ['-xzf', join(scratch, 'archive.tgz'), '-C', scratch], { encoding: 'utf8' });
    if (unpacked.status !== 0) throw new Error(`tar: ${unpacked.stderr.slice(0, 120)}`);
    if (existsSync(join(scratch, 'traces'))) cpSync(join(scratch, 'traces'), join(outDir, 'traces'), { recursive: true });
  } catch (error) {
    run.add({ id: 'archive.fetch', title: 'The archive leg\'s traces were brought back', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
  }
  rmSync(scratch, { recursive: true, force: true });
}

/** The agent suite against the engine: the connection, every model agent, then the ChatGPT-protocol pass. */
async function runSuite(run: Run, workDir: string, judge: Judge | undefined, { mintToken }: { mintToken: boolean }): Promise<void> {
  const bridge = machineToolBridge(run);
  if (mintToken) {
    const token = await run.agent('mcp-token', '', 60_000);
    run.add({ id: 'mcp.connection', title: 'A connection token was created for the agent suite', status: token.result?.ok === true ? 'pass' : 'fail', detail: token.result?.ok === true ? 'created' : String(token.result?.detail ?? '') });
    if (token.result?.ok !== true) return;
  } else {
    // The upgrade leg: the token an agent was given before the update, with no new approval.
    const tools = await run.agent('mcp-tools', '', 60_000);
    const names = ((tools.result?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);
    const ok = tools.result?.ok === true && names.includes('olympus_search');
    run.add({
      id: 'mcp.connection',
      title: 'The connection token made before the update still lets an agent in',
      status: ok ? 'pass' : 'fail',
      detail: ok ? `${names.length} tool(s) listed with the earlier token` : String(tools.result?.detail ?? 'the earlier token was refused or the tools were not listed'),
    });
    if (!ok) return;
  }
  await runModelAgents(run, bridge, judge);
  await runProtocolAgent(run, workDir);
}

const tarballVersion = (dir: string): string | undefined => {
  const name = existsSync(dir) ? readdirSync(dir).find((entry) => /^olympus-.*\.tgz$/.test(entry)) : undefined;
  return name ? versionFromTarballName(name) : undefined;
};

/** The snapshot of the install's state, or undefined (with the run's error recorded) when it cannot be read. */
async function takeSnapshot(run: Run, what: string): Promise<StateSnapshot | undefined> {
  const out = await run.agent('snapshot-state', '', 90_000);
  if (out.result?.ok !== true || !out.result.state) {
    run.errors.push(`the install's state could not be read ${what}: ${String(out.result?.detail ?? out.stderr.slice(-200))}`);
    return undefined;
  }
  return out.result.state as StateSnapshot;
}

const countsOf = (snap: Record<string, number | string> | undefined): DashboardCounts | null => (snap
  ? { seen: Number(snap.seen), indexed: Number(snap.indexed), contentReady: Number(snap.contentReady), embedded: Number(snap.embedded), secretsLocated: Number(snap.secretsLocated), personal: Number(snap.personal), privateItems: Number(snap.privateItems) }
  : null);

/**
 * The upgrade leg, on one machine: the earlier release is installed, set up and asked the suite; the owner changes a
 * setting; the candidate's installer runs over it; then what the update kept and migrated is checked, the install
 * settles WITHOUT another sync, and the suite, the dashboard and the leak scans run again.
 */
async function runUpgradeLeg(run: Run, workDir: string, bundlePath: string, judge: Judge | undefined, deadline: number, expected: { from?: string | undefined; to?: string | undefined }): Promise<void> {
  const options = run.options;
  const machine = run.machine!;

  run.use('before');
  const ready = await setupMachine(run, workDir, bundlePath, `The earlier release${expected.from ? ` (${expected.from})` : ''} installed fresh and the engine is running`);
  if (!ready) { run.errors.push('the earlier release did not reach a settled install, so the update was not attempted'); return; }
  if (Date.now() >= deadline) { run.errors.push('the run exceeded its time budget before the earlier release\'s suite'); return; }
  await runSuite(run, workDir, judge, { mintToken: true });

  // One setting the owner changed, so "your other settings are kept" has something to keep.
  const setting = await run.agent('set-policy-setting', '', 60_000);
  run.add({
    id: 'baseline.setting',
    title: 'The owner changed one privacy setting before updating',
    status: setting.result?.ok === true ? 'pass' : 'fail',
    detail: setting.result?.ok === true ? `${String(setting.result.changed)} set to ${String(setting.result.value)}` : String(setting.result?.detail ?? setting.stderr.slice(-200)),
  });
  const before = await takeSnapshot(run, 'before the update');
  if (!before) return;
  if (before.version) run.stage.version = before.version;
  if (options.upgradeSelftest === 'lose-tier-rules') {
    const fault = await run.agent('upgrade-selftest', '--mode lose-tier-rules', 60_000);
    if (fault.result?.ok !== true) { run.errors.push('the self-test fault could not be made (lose-tier-rules)'); return; }
  }

  run.use('upgrade');
  run.stage.label = `${expected.from ?? 'the earlier release'} -> ${expected.to ?? 'the candidate'}, with the candidate's public Linux installer over the existing install`;
  try {
    await run.phase('upgrade', () => machine.upgrade(options.candidateDir));
    run.add({ id: 'upgrade.installer', title: 'The candidate\'s installer ran over the existing install and reported a usable install', status: 'pass', detail: 'the same installer the update instructions give, with the candidate\'s tarball' });
  } catch (error) {
    run.add({ id: 'upgrade.installer', title: 'The candidate\'s installer ran over the existing install and reported a usable install', status: 'fail', detail: error instanceof Error ? error.message : String(error) });
    return;
  }
  const back = await run.phase('engine-restart', () => run.agent('await-engine', '--timeout-s 300', 330_000));
  run.add({ id: 'upgrade.engine-ready', title: 'The engine came back ready (models included) after the update', status: back.result?.ok === true ? 'pass' : 'fail', detail: back.result?.ok === true ? `ready after ${Math.round(Number(back.result.readyMs) / 1000)} s` : String(back.result?.detail ?? back.stderr.slice(-200)), ms: back.ms });
  if (back.result?.ok !== true) return;
  if (options.upgradeSelftest === 'revert-policy') {
    const fault = await run.agent('upgrade-selftest', '--mode revert-policy', 60_000);
    if (fault.result?.ok !== true) { run.errors.push('the self-test fault could not be made (revert-policy)'); return; }
  }
  const after = await takeSnapshot(run, 'after the update');
  if (!after) return;
  for (const check of evaluateUpgrade(before, after, { ...(expected.from ? { fromVersion: expected.from } : {}), ...(expected.to ? { toVersion: expected.to } : {}) })) run.add(check);
  run.differences = describeDifferences(before, after);

  run.use('after');
  if (after.version) run.stage.version = after.version;
  if (after.build) run.build = after.build;
  // No sync here: the update must not need the data brought in again.
  const settled = await settleIngest(run);
  for (const check of evaluateCounts(before.dashboard, countsOf(settled.snap))) run.addTo('upgrade', check);
  if (!settled.settled) return;
  if (Date.now() >= deadline) { run.errors.push('the run exceeded its time budget before the suite after the update'); return; }
  await runSuite(run, workDir, judge, { mintToken: false });
  await captureScreenshots(run, options.outDir);
  if (Date.now() < deadline) await runInboxLeg(run, options.outDir); else run.errors.push('the run exceeded its time budget before the Ask page and Inbox leg');
  if (Date.now() < deadline) await runJourneyLeg(run, options.outDir); else run.errors.push('the run exceeded its time budget before the journeys');
  if (Date.now() < deadline) await runArchiveLeg(run, options.outDir, deadline); else run.errors.push('the run exceeded its time budget before the archive-import leg');
  if (Date.now() < deadline) await runExploreLeg(run, options.outDir); else run.errors.push('the run exceeded its time budget before the control exploration');
  await collectEvidence(run, options.outDir);
}

export async function runReleaseCheck(options: RunOptions): Promise<ReleaseReport> {
  mkdirSync(join(options.outDir, 'logs'), { recursive: true });
  const workDir = join(tmpdir(), `release-check-${options.runId}`);
  mkdirSync(workDir, { recursive: true });
  const startedAt = nowIso();
  let run!: Run;
  const driver = new CommandDriver({ argv: options.config.driver, onLog: (line) => run?.log(`driver: ${line}`) });
  run = new Run(options, driver);
  const judge: Judge | undefined = options.config.judge ? commandJudge(options.config.judge) : undefined;
  const upgrading = options.upgradeFromDir !== undefined;
  const deadline = Date.now() + (options.budgetMs ?? (upgrading ? 195 : 135) * 60_000);
  const versions = { from: upgrading ? tarballVersion(options.upgradeFromDir!) : undefined, to: upgrading ? tarballVersion(options.candidateDir) : undefined };
  if (upgrading) {
    run.stages.clear();
    run.addStage('before', `${versions.from ? `Olympus ${versions.from}` : 'The earlier release'} installed fresh`);
    run.addStage('upgrade', 'the update');
    run.addStage('after', `${versions.to ? `Olympus ${versions.to}` : 'The candidate'} after the update`);
    run.use('before');
  }
  let machineInfo = { label: 'machine', os: 'linux', driver: 'driver' };
  try {
    const bundlePath = await bundleAgent(workDir);
    run.machine = await run.phase('provision', () => driver.provision({ runId: options.runId, candidateDir: upgrading ? options.upgradeFromDir! : options.candidateDir, workdir: workDir, timeoutMs: 25 * 60_000 }));
    machineInfo = { label: run.machine.label, os: run.machine.os, driver: run.machine.driver };
    run.add({ id: 'provision', title: upgrading ? 'A fresh machine was created and the earlier release installed' : 'A fresh machine was created and the candidate installed', status: 'pass', detail: `${run.machine.label}` });
    if (options.failAfterProvision) throw new Error('simulated failure after provision (teardown test)');
    if (upgrading) {
      await runUpgradeLeg(run, workDir, bundlePath, judge, deadline, versions);
    } else {
      const ready = await setupMachine(run, workDir, bundlePath);
      if (ready && !options.skipSuite && Date.now() < deadline) {
        await runSuite(run, workDir, judge, { mintToken: true });
      } else if (ready && !options.skipSuite) {
        run.errors.push('the run exceeded its time budget before the agent suite');
      }
      if (ready) {
        await captureScreenshots(run, options.outDir);
        if (Date.now() < deadline) await runInboxLeg(run, options.outDir); else run.errors.push('the run exceeded its time budget before the Ask page and Inbox leg');
        if (Date.now() < deadline) await runJourneyLeg(run, options.outDir); else run.errors.push('the run exceeded its time budget before the journeys');
        if (Date.now() < deadline) await runArchiveLeg(run, options.outDir, deadline); else run.errors.push('the run exceeded its time budget before the archive-import leg');
        if (Date.now() < deadline) await runExploreLeg(run, options.outDir); else run.errors.push('the run exceeded its time budget before the control exploration');
      }
      await collectEvidence(run, options.outDir);
    }
  } catch (error) {
    run.errors.push(error instanceof Error ? error.message : String(error));
    run.log(`run error: ${run.errors[run.errors.length - 1]}`);
    if (run.machine) {
      try { await collectEvidence(run, options.outDir); } catch { /* evidence is best effort after a failure */ }
    }
  } finally {
    // Teardown always runs, and by run id when provision never returned a handle.
    const started = Date.now();
    try {
      if (options.keepMachine) {
        const named = run.machine ? `machine ${run.machine.handle}` : `whatever run ${options.runId} created`;
        run.errors.push(`${named} was kept for debugging (--keep-machine); destroy it with the driver's destroy verb`);
        run.log(`machine kept: ${run.machine?.handle ?? `run ${options.runId}`}`);
      } else {
        await (run.machine ? driver.destroy({ handle: run.machine.handle }) : driver.destroy({ runId: options.runId }));
        run.log('machine destroyed');
      }
    } catch (error) {
      run.errors.push(`teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    run.timings.teardown = Date.now() - started;
  }

  const last = run.stages.get(upgrading ? 'after' : 'install')!;
  const toPhase = (stage: Stage): PhaseReport => ({
    id: stage.id, label: stage.label,
    ...(stage.version ? { version: stage.version } : {}), ...(stage.build ? { build: stage.build } : {}),
    timings: stage.timings, checks: stage.checks, agents: stage.agents, screenshots: stage.screenshots, logs: stage.logs,
  });
  const machine: MachineReport = {
    id: options.runId,
    label: machineInfo.label,
    os: machineInfo.os,
    driver: machineInfo.driver,
    ...(last.build ? { build: last.build } : {}),
    timings: last.timings,
    checks: last.checks,
    agents: last.agents,
    screenshots: last.screenshots,
    logs: last.logs,
    ...(last.traces ? { traces: last.traces } : {}),
    ...(last.visual ? { visual: last.visual } : {}),
    ...(last.explore ? { explore: last.explore } : {}),
    ...(upgrading ? {
      upgrade: {
        from: toPhase(run.stages.get('before')!),
        step: { label: run.stages.get('upgrade')!.label, checks: run.stages.get('upgrade')!.checks, differences: run.differences },
        afterLabel: last.label,
        ...(last.version ? { afterVersion: last.version } : {}),
      },
    } : {}),
  };
  // Planted bugs are in its pictures, so such a run can never count for a release, whatever else passed.
  if (options.reviewerPlants) run.errors.push('a qualification run for the AI reviewer (--reviewer-plants): its pictures carry planted bugs, so it does not qualify a release');
  const selfTest = options.mistier
    ? `the ${options.mistier} marker was deliberately stored in an ordinary Personal item; this run is expected to FAIL on the leak checks`
    : options.upgradeSelftest
      ? `a fault was deliberately made during the upgrade (${options.upgradeSelftest}); this run is expected to FAIL on ${UPGRADE_SELFTEST_FAILS[options.upgradeSelftest]}`
      : options.inboxSelftest
        ? `a fault was deliberately made in the Inbox leg (${options.inboxSelftest}); this run is expected to FAIL on ${run.inboxSelftestFailsOn && options.inboxSelftest === 'wrong-link-id' ? run.inboxSelftestFailsOn : INBOX_SELFTEST_FAILS[options.inboxSelftest]}`
        : undefined;
  let report = buildReport({
    runId: options.runId,
    candidate: { label: options.candidateLabel, ...(options.candidateSha ? { sha: options.candidateSha } : {}) },
    startedAt,
    finishedAt: nowIso(),
    machines: [machine],
    errors: run.errors,
    ...(options.harnessCommit ? { harnessCommit: options.harnessCommit } : {}),
    ...(selfTest ? { selfTest } : {}),
  });
  // The report must itself be clean; a hit fails the run without copying the marker.
  const reportLeaks = scanReport(report, run.markers);
  if (reportLeaks.length > 0) {
    machine.checks.push({ id: 'scan.report', title: 'No Private or Secret content in the report', status: 'fail', detail: reportLeaks.map((l) => `${l.markerId} in ${l.label}`).join('; ') });
  } else {
    machine.checks.push({ id: 'scan.report', title: 'No Private or Secret content in the report', status: 'pass', detail: 'report.json and report.html scanned' });
  }
  report = buildReport({ ...report, machines: [machine] });
  writeFileSync(join(options.outDir, 'logs', 'run.log'), `${run.logLines.join('\n')}\n`);
  machine.logs.push({ label: 'run.log', path: 'logs/run.log' });
  report = buildReport({ ...report, machines: [machine] });
  // A hit above has already failed the run. What is written never holds the raw text, whichever path
  // (a driver's stderr in an error, a check detail) carried it into the report.
  const written = redactDeep(report, run.markers);
  writeFileSync(join(options.outDir, 'report.json'), `${JSON.stringify(written, null, 2)}\n`);
  writeFileSync(join(options.outDir, 'report.html'), renderHtml(written));
  rmSync(workDir, { recursive: true, force: true });
  return written;
}

// ---------------------------------------------------------------------------
// CLI

export function parseCli(argv: readonly string[]): RunOptions {
  const get = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const has = (name: string): boolean => argv.includes(name);
  const configPath = get('--config');
  const candidate = get('--candidate');
  const out = get('--out');
  if (!configPath || !candidate || !out) {
    throw new Error('usage: bun scripts/release-check/run.ts --config <file> --candidate <dir> --out <dir> [--label <name>] [--sha <sha>] [--harness-commit <sha>] [--run-id <id>] [--agents <id,id>] [--mistier private|secrets] [--upgrade-from <earlier bundle dir> [--upgrade-selftest lose-tier-rules|revert-policy]] [--inbox-selftest plant-private-reply|wrong-link-id] [--fail-after-provision] [--keep-machine] [--skip-relay] [--skip-screenshots] [--skip-inbox] [--skip-journeys] [--skip-explore] [--skip-suite] [--skip-archive] [--only-journeys <id,id>] [--baselines <dir> [--update-baselines]] [--reviewer-plants]');
  }
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as RunConfigFile;
  if (!Array.isArray(config.driver) || config.driver.length === 0) throw new Error('the config needs a "driver" argv array');
  const only = get('--agents');
  const mistier = get('--mistier');
  if (mistier !== undefined && mistier !== 'private' && mistier !== 'secrets') throw new Error('--mistier is private or secrets');
  const upgradeFrom = get('--upgrade-from');
  const upgradeSelftest = get('--upgrade-selftest');
  if (upgradeFrom !== undefined && (upgradeFrom.startsWith('--') || !existsSync(resolve(upgradeFrom)))) throw new Error('--upgrade-from is the earlier release\'s installer bundle directory, which must exist');
  if (upgradeSelftest !== undefined) {
    if (upgradeFrom === undefined) throw new Error('--upgrade-selftest only goes with --upgrade-from');
    if (!(UPGRADE_SELFTESTS as readonly string[]).includes(upgradeSelftest)) throw new Error(`--upgrade-selftest is one of ${UPGRADE_SELFTESTS.join(', ')}`);
  }
  if (upgradeFrom !== undefined && mistier !== undefined) throw new Error('--mistier and --upgrade-from are separate self-tests; use one');
  const inboxSelftest = get('--inbox-selftest');
  if (inboxSelftest !== undefined) {
    if (!(INBOX_SELFTESTS as readonly string[]).includes(inboxSelftest)) throw new Error(`--inbox-selftest is one of ${INBOX_SELFTESTS.join(', ')}`);
    if (mistier !== undefined || upgradeSelftest !== undefined) throw new Error('--inbox-selftest is a separate self-test from --mistier and --upgrade-selftest; use one');
    if (has('--skip-inbox')) throw new Error('--inbox-selftest needs the Inbox leg; drop --skip-inbox');
  }
  const baselines = get('--baselines');
  if (baselines !== undefined && baselines.startsWith('--')) throw new Error('--baselines is the folder of approved pictures');
  if (has('--update-baselines') && baselines === undefined) throw new Error('--update-baselines needs --baselines <dir> to write into');
  if (has('--update-baselines') && has('--skip-journeys')) throw new Error('--update-baselines needs the screens; drop --skip-journeys');
  if (has('--reviewer-plants') && has('--skip-journeys')) throw new Error('--reviewer-plants takes its pictures with the screens; drop --skip-journeys');
  if (has('--reviewer-plants') && has('--update-baselines')) throw new Error('--reviewer-plants is a qualification run; it never writes baselines');
  const onlyJourneys = get('--only-journeys');
  const runId = get('--run-id') ?? newRunId();
  const harnessCommit = get('--harness-commit');
  if (harnessCommit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(harnessCommit)) throw new Error('--harness-commit is a full 40-character commit');
    // Refused before anything starts: a harness from another commit cannot qualify the candidate.
    if (get('--sha') !== undefined && get('--sha') !== harnessCommit) throw new Error(`--harness-commit ${harnessCommit} is not the candidate's --sha ${get('--sha')}`);
  }
  return {
    runId,
    candidateDir: resolve(candidate),
    candidateLabel: get('--label') ?? 'candidate',
    ...(get('--sha') ? { candidateSha: get('--sha')! } : {}),
    ...(harnessCommit ? { harnessCommit } : {}),
    outDir: resolve(out, runId),
    config,
    ...(mistier ? { mistier } : {}),
    ...(upgradeFrom !== undefined ? { upgradeFromDir: resolve(upgradeFrom) } : {}),
    ...(upgradeSelftest ? { upgradeSelftest: upgradeSelftest as UpgradeSelftest } : {}),
    ...(inboxSelftest ? { inboxSelftest: inboxSelftest as InboxSelftest } : {}),
    skipInbox: has('--skip-inbox'),
    skipJourneys: has('--skip-journeys'),
    skipExplore: has('--skip-explore'),
    skipArchive: has('--skip-archive'),
    skipSuite: has('--skip-suite'),
    ...(onlyJourneys ? { onlyJourneys: onlyJourneys.split(',').map((id) => id.trim()).filter(Boolean) } : {}),
    ...(baselines !== undefined ? { baselinesDir: resolve(baselines) } : {}),
    updateBaselines: has('--update-baselines'),
    reviewerPlants: has('--reviewer-plants'),
    ...(only ? { onlyAgents: only.split(',').map((id) => id.trim()).filter(Boolean) } : {}),
    failAfterProvision: has('--fail-after-provision'),
    keepMachine: has('--keep-machine'),
    skipRelay: has('--skip-relay'),
    skipScreenshots: has('--skip-screenshots'),
  };
}

if (import.meta.main) {
  let options: RunOptions;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const report = await runReleaseCheck(options);
  console.log(JSON.stringify({ verdict: report.verdict, counts: report.counts, report: join(options.outDir, 'report.html') }));
  process.exit(report.verdict === 'pass' ? 0 : 1);
}

