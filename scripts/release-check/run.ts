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
 * Exit status: 0 the report passed, 1 the report failed, 2 the run could not
 * start (arguments, config, bundle).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FIXTURE_ITEMS, SUITE_QUESTIONS, fixtureDocuments, forbiddenMarkers, leakyFixture, tierRules,
  type SuiteQuestion,
} from './fixture.ts';
import { FAKE_READWISE_PORT, FAKE_READWISE_TOKEN } from './readwise-fake.ts';
import { redactDeep, redactMarkers, type LeakMarker } from './leak.ts';
import { CommandDriver, type Machine } from './machine.ts';
import {
  buildReport, renderHtml, scanReport,
  type AgentReport, type AgentUsage, type CheckResult, type MachineReport, type ReleaseReport, type ReportFile,
} from './report.ts';
import { evaluateArtifactScan, evaluateObservation, evaluateSmokeVerdict, type QuestionObservation } from './suite.ts';
import { AgentApiError, readAgentKey, runXaiAgent, type AgentSpec, type ToolBridge, type ToolDefinition } from './agents.ts';
import { codexLoginAvailable, looksLikeClaudeSetupToken, runClaudeCode, runCodex } from './cli-agents.ts';
import { cachingRelay, startMcpProxy, type McpExchange, type Relay } from './mcp-proxy.ts';
import { privateNoteKindIn } from './private-note.ts';
import { commandJudge, judgeCheck, type Judge } from './judge.ts';
import type { AgentConfig } from './machine-agent.ts';

export interface RunConfigFile {
  driver: string[];
  agents?: AgentSpec[];
  judge?: string[];
  relay?: string;
  settleTimeoutS?: number;
}

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
const BUN_LOCATE = 'BUN=$(command -v bun 2>/dev/null || ls -d ~/.local/share/olympus-engine/generations/*/runtime/bun 2>/dev/null | tail -1); [ -n "$BUN" ] || { echo "no bun runtime on the machine" >&2; exit 90; }';

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

class Run {
  readonly markers: LeakMarker[] = forbiddenMarkers();
  readonly logLines: string[] = [];
  readonly errors: string[] = [];
  readonly timings: Record<string, number> = {};
  readonly checks: CheckResult[] = [];
  readonly agents: AgentReport[] = [];
  readonly screenshots: ReportFile[] = [];
  readonly logs: ReportFile[] = [];
  machine?: Machine;
  build?: string;

  constructor(readonly options: RunOptions, readonly driver: CommandDriver) {}

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

  async agent(sub: string, args = '', timeoutMs = 120_000): Promise<{ result: Record<string, any> | undefined; stdout: string; stderr: string; code: number; ms: number }> {
    const exec = await this.machine!.exec(`${BUN_LOCATE}\n"$BUN" --no-env-file ~/rc/agent.js ${sub} ${args}\n`, { timeoutMs });
    return { result: parseAgentLine(exec.stdout), stdout: exec.stdout, stderr: exec.stderr, code: exec.code, ms: exec.ms };
  }
}

/** Calls the engine's MCP tools on the machine, one `exec` per call. */
function machineToolBridge(run: Run): ToolBridge & { tools(): Promise<ToolDefinition[]> } {
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
        { timeoutMs: 180_000 },
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
    relay: options.config.relay ?? '',
    privateFacts,
    enginePort: ENGINE_PORT,
  };
}

function expectedTierCounts(): { personal: number; private: number; secrets: number } {
  const count = (tier: string): number => FIXTURE_ITEMS.filter((item) => item.tier === tier).length;
  return { personal: count('personal'), private: count('private'), secrets: count('secrets') };
}

async function setupMachine(run: Run, workDir: string, bundlePath: string): Promise<boolean> {
  const machine = run.machine!;
  const configPath = join(workDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(agentConfig(run.options)));
  await machine.exec('mkdir -p ~/rc && chmod 700 ~/rc\n', { timeoutMs: 30_000 });
  await machine.put(bundlePath, '~/rc/agent.js');
  await machine.put(configPath, '~/rc/config.json');

  const build = await run.agent('engine-build', '', 60_000);
  if (typeof build.result?.build === 'string') run.build = build.result.build;
  run.add({
    id: 'install.engine',
    title: 'The candidate installed and the engine is running',
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
  return settled.result?.settled === true;
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

function exchangesObservation(question: SuiteQuestion, agentId: string, finalText: string, exchanges: McpExchange[], ms: number, error: string | undefined): QuestionObservation {
  const toolCalls = exchanges.filter((e) => e.method === 'tools/call');
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
        agent.checks.push(...evaluateObservation(observation, run.markers));
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

export async function runReleaseCheck(options: RunOptions): Promise<ReleaseReport> {
  mkdirSync(join(options.outDir, 'logs'), { recursive: true });
  const workDir = join(tmpdir(), `release-check-${options.runId}`);
  mkdirSync(workDir, { recursive: true });
  const startedAt = nowIso();
  let run!: Run;
  const driver = new CommandDriver({ argv: options.config.driver, onLog: (line) => run?.log(`driver: ${line}`) });
  run = new Run(options, driver);
  const judge: Judge | undefined = options.config.judge ? commandJudge(options.config.judge) : undefined;
  const deadline = Date.now() + (options.budgetMs ?? 90 * 60_000);
  let machineInfo = { label: 'machine', os: 'linux', driver: 'driver' };
  try {
    const bundlePath = await bundleAgent(workDir);
    run.machine = await run.phase('provision', () => driver.provision({ runId: options.runId, candidateDir: options.candidateDir, workdir: workDir, timeoutMs: 25 * 60_000 }));
    machineInfo = { label: run.machine.label, os: run.machine.os, driver: run.machine.driver };
    run.add({ id: 'provision', title: 'A fresh machine was created and the candidate installed', status: 'pass', detail: `${run.machine.label}` });
    if (options.failAfterProvision) throw new Error('simulated failure after provision (teardown test)');
    const ready = await setupMachine(run, workDir, bundlePath);
    if (ready && Date.now() < deadline) {
      const bridge = machineToolBridge(run);
      const token = await run.agent('mcp-token', '', 60_000);
      run.add({ id: 'mcp.connection', title: 'A connection token was created for the agent suite', status: token.result?.ok === true ? 'pass' : 'fail', detail: token.result?.ok === true ? 'created' : String(token.result?.detail ?? '') });
      if (token.result?.ok === true) await runModelAgents(run, bridge, judge);
      await runProtocolAgent(run, workDir);
    } else if (ready) {
      run.errors.push('the run exceeded its time budget before the agent suite');
    }
    if (ready) {
      await captureScreenshots(run, options.outDir);
    }
    await collectEvidence(run, options.outDir);
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

  const machine: MachineReport = {
    id: options.runId,
    label: machineInfo.label,
    os: machineInfo.os,
    driver: machineInfo.driver,
    ...(run.build ? { build: run.build } : {}),
    timings: run.timings,
    checks: run.checks,
    agents: run.agents,
    screenshots: run.screenshots,
    logs: run.logs,
  };
  let report = buildReport({
    runId: options.runId,
    candidate: { label: options.candidateLabel, ...(options.candidateSha ? { sha: options.candidateSha } : {}) },
    startedAt,
    finishedAt: nowIso(),
    machines: [machine],
    errors: run.errors,
    ...(options.harnessCommit ? { harnessCommit: options.harnessCommit } : {}),
    ...(options.mistier ? { selfTest: `the ${options.mistier} marker was deliberately stored in an ordinary Personal item; this run is expected to FAIL on the leak checks` } : {}),
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
    throw new Error('usage: bun scripts/release-check/run.ts --config <file> --candidate <dir> --out <dir> [--label <name>] [--sha <sha>] [--harness-commit <sha>] [--run-id <id>] [--agents <id,id>] [--mistier private|secrets] [--fail-after-provision] [--keep-machine] [--skip-relay] [--skip-screenshots]');
  }
  const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as RunConfigFile;
  if (!Array.isArray(config.driver) || config.driver.length === 0) throw new Error('the config needs a "driver" argv array');
  const only = get('--agents');
  const mistier = get('--mistier');
  if (mistier !== undefined && mistier !== 'private' && mistier !== 'secrets') throw new Error('--mistier is private or secrets');
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

