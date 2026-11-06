// OLYMPUS_TEST_LANE: deploy
// The release check's Ask page and Inbox leg end to end, against a scripted stand-in for a machine: the scripted agent's Private
// question, the in-machine check's result, the checks and screenshots that come out, and the self-tests that must fail the run.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { SCREENS, SCREEN_THEMES, SCREEN_WIDTHS, screenName } from '../scripts/release-check/visual.ts';
import { FIXTURE_ITEMS, PRIVATE_FACTS, PRIVATE_MARKER } from '../scripts/release-check/fixture.ts';
import { REMOTE_PRIVATE_NOTE } from '../src/core/remote-result.ts';
import { SOURCE_ANSWER_HANDOFF_MAX_MS } from '../src/core/source-answer-jobs.ts';
import { ANSWER_TOOL_CALL_TIMEOUT_MS, INBOX_SELFTEST_FAILS, INBOX_SELFTESTS, newRunId, parseCli, runReleaseCheck, type RunConfigFile } from '../scripts/release-check/run.ts';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';

/**
 * A machine that is just enough of one: it answers the in-machine agent's subcommands. `mcp-call` returns a Private note whose link
 * the test chooses; `inbox-check` builds the observation a clean visit gives, from the id the harness passed it, and the test can
 * make one part of it go wrong.
 */
const SCRIPTED_DRIVER = String.raw`#!/usr/bin/env bun
import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [verb, ...rest] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const log = (line) => appendFileSync(state + '/driver.log', line + '\n');
log([verb, ...rest].join(' '));
const arg = (name) => rest[rest.indexOf(name) + 1];
const say = (value) => console.log(JSON.stringify(value));
if (verb === 'provision') {
  console.log('{"machine":"fake-' + arg('--run-id') + '","label":"Scripted machine","os":"linux","driver":"fake"}');
} else if (verb === 'get') {
  if (/journeys\.tgz$/.test(arg('--from'))) copyFileSync(state + '/journeys.tgz', arg('--to'));
  else if (/explore\.tgz$/.test(arg('--from'))) copyFileSync(state + '/explore.tgz', arg('--to'));
  else writeFileSync(arg('--to'), 'png');
} else if (verb === 'exec') {
  const script = await new Response(Bun.stdin.stream()).text();
  // The anonymous-answer confinement check: a host without the AppArmor restriction, ready with no administrator step.
  if (script.includes('apparmor_restrict_unprivileged_userns')) { console.log('absent'); process.exit(0); }
  if (script.includes('zkapi install-tools')) process.exit(0);
  if (script.includes('zkapi check-confinement')) { console.log('network confinement: ready (scripted)'); process.exit(0); }
  const sub = /agent\.js (\S+)/.exec(script)?.[1];
  appendFileSync(state + '/agent.log', (/agent\.js (.*)/.exec(script)?.[1] ?? '') + '\n');
  appendFileSync(state + '/timeouts.log', (/agent\.js (.*)/.exec(script)?.[1] ?? '') + '|' + arg('--timeout-s') + '\n');
  const life = JSON.parse(readFileSync(state + '/life.json', 'utf8'));
  const counts = { seen: life.seen, indexed: life.stored, contentReady: life.stored, embedded: life.stored, secretsLocated: life.secrets, pending: 0, queueWaiting: 0, queueActive: 0, personal: life.personal, privateItems: life.privateItems };
  const mode = process.env.FAKE_INBOX_MODE ?? '';
  if (sub === 'engine-build') say({ ok: true, build: '1.1.0+abc', version: '1.1.0', remoteMode: 'relay', relay: {} });
  else if (sub === 'prepare-source') say({ ok: true, rules: 2, engineReadyMs: 1000 });
  else if (sub === 'connect-source') say({ ok: true, message: 'Connected' });
  else if (sub === 'settle') say({ ok: true, settled: true, polls: 2, waitedMs: 1000, snapshot: counts });
  else if (sub === 'mcp-token') say({ ok: true, connection: 'conn-1' });
  else if (sub === 'mcp-tools' && mode === 'tools-fail') say({ ok: false, tools: [] });
  else if (sub === 'mcp-tools' && mode === 'tools-malformed') say({ ok: true, tools: 'olympus_search' });
  else if (sub === 'mcp-tools' && mode === 'tools-empty') say({ ok: true, tools: [] });
  else if (sub === 'mcp-tools' && mode === 'tools-crash') { console.error('agent crashed'); process.exit(1); }
  else if (sub === 'mcp-tools' && mode === 'tools-none') say({ ok: true, tools: [{ name: 'source_answer_result', annotations: { readOnlyHint: true } }, { name: 'source_index_status', annotations: { readOnlyHint: true } }] });
  else if (sub === 'mcp-tools') say({ ok: true, tools: [...(process.env.FAKE_NO_SEARCH === '1' ? [] : [{ name: 'olympus_search', annotations: { readOnlyHint: true } }]), { name: 'source_answer_result', annotations: { readOnlyHint: true } }, ...(process.env.FAKE_ANSWER_TOOL === '1' ? [{ name: 'source_answer', annotations: { readOnlyHint: true } }] : [])] });
  else if (sub === 'mcp-call') {
    const tool = /mcp-call '([^']*)'/.exec(script)?.[1] ?? '';
    const note = process.env.FAKE_NOTE ?? '';
    const counter = state + '/calls';
    const calls = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(calls + 1));
    if (tool === 'olympus_search') {
      // As a standard install returns it: the evidence result, and beside it the fixed note with its Open link when a Private item matched.
      const structured = { status: 'none', evidence: [], coverage: { searchedSources: 1, unreadableItems: 0, namesOnlyItems: 0, partiallyReadItems: 0, unclassifiedItems: 0, instruction: 'x' }, notes: [], ...(note ? { private_note: note } : {}) };
      const text = 'Olympus found no Public or Personal evidence for this question in 1 searched source.' + (note ? '\n\nPass this on to the user as written:\n' + note : '');
      say({ ok: true, status: 200, isError: false, text, structured, noteKind: note ? 'remote' : null });
    } else if (process.env.FAKE_WORKING === '1' && calls === 0) {
      say({ ok: true, status: 200, isError: false, text: JSON.stringify({ status: 'working', job_id: 'job.install.abc', next_tool: 'source_answer_result' }), structured: null, noteKind: null });
    } else {
      const output = { kind: 'source_answer', status: 'answered', answer: 'Nothing public answers this.', citations: [], ...(note ? { private_note: note } : {}) };
      say({ ok: true, status: 200, isError: false, text: JSON.stringify(output, null, 2), structured: null, noteKind: note ? 'remote' : null });
    }
  }
  else if (sub === 'inbox-check') {
    const primary = /--primary '([^']*)'/.exec(script)?.[1] ?? '';
    const ids = (/--ids '([^']*)'/.exec(script)?.[1] ?? '').split(',').filter(Boolean);
    const known = process.env.FAKE_LINK_ID;
    const entry = (id, over = {}) => ({ id, listed: id === known, path: id === known ? 'private' : null, fromShown: id === known, questionMatches: id === known ? true : null, status: id === known ? 'answered' : null, factsStated: id === known ? [true, true] : [], citations: id === known ? 1 : 0, citesExpected: id === known, waitedS: 4, ...over });
    const faulted = script.includes('--fault-entry-id');
    const ASK_ID = 'NnNnNnNnNnNnNnNnNnNnNn';
    const link = (href, text) => ({ tag: 'a', text, href, action: null, submit: false, disabled: false });
    const file = (name) => ({ file: '/home/test/rc/inbox-shots/' + name, label: name, width: name.includes('390') ? 390 : 1280, theme: 'light', bytes: 12000 });
    const observation = {
      ok: true,
      ownerPath: { bearerStatus: 403, unlockOffered: true, unlocked: true },
      destinations: {
        computer: { state: 'ready', status: 'Ready', reason: '', control: { tag: 'button', text: 'Ask the local model', href: null, action: 'ask', submit: true, disabled: false } },
        venice: { state: 'not_set_up', status: 'Not connected', reason: 'Not connected. Connect Venice to use its models.', control: link('/dashboard?keys#venice-setup', 'Connect Venice') },
        anonymous: { state: 'not_set_up', status: 'Not connected', reason: 'Not connected. Connect zkAPI and add money to use it.', control: link('/dashboard?keys#anonymous', 'Connect zkAPI') },
      },
      entries: [...(primary ? [entry(primary)] : []), ...ids.filter((id) => id !== primary).map((id) => entry(id, { status: 'answering', factsStated: [], citations: 0, citesExpected: false }))],
      pages: primary
        ? [{ id: primary, landedOnInbox: true, rowFound: primary === known, opened: primary === known, factsStated: primary === known ? [true, true] : [], citations: primary === known ? 1 : 0, citesExpected: primary === known }]
        : [{ id: ASK_ID, landedOnInbox: true, rowFound: !faulted, opened: !faulted, factsStated: faulted ? [] : [true, true], citations: faulted ? 0 : 1, citesExpected: !faulted }],
      ask: { pressed: true, answered: true, message: '', factsStated: [true, true], citations: 1, citesExpected: true, ms: 20000, entry: entry('NnNnNnNnNnNnNnNnNnNnNn', { listed: true, path: 'private', fromShown: true, questionMatches: true, status: 'answered', factsStated: [true, true], citations: 1, citesExpected: true }) },
      fixes: { venice: { clicked: true, landedAt: '/dashboard?keys#venice-setup', anchorShown: true }, anonymous: { clicked: true, landedAt: '/dashboard?keys#anonymous', anchorShown: true } },
      refusals: { venice: 403 },
      egress: { samples: 500, intervalMs: 150, baseline: 2, fresh: mode === 'egress' ? ['203.0.113.7:443 (bun)'] : [], pageRequests: 30, pageOutside: [] },
      trace: [{ n: 1, name: 'Open the Ask page', action: 'open the owner link, press Unlock', expected: 'the controls unlock', actual: 'unlocked', ok: true, ms: 1200, at: '/dashboard?private-answers', screenshot: 'trace-01.jpg', consoleErrors: [], failedRequests: [], findings: [] }],
      shots: ['ask-page-1280.png', 'ask-page-390.png', ...(faulted ? [] : ['inbox-entry-1280.png', 'inbox-entry-390.png']), 'ask-answered-1280.png'].map(file),
    };
    if (mode === 'not-ok') say({ ok: false, detail: 'the Private answers page did not open its controls (Unlock was not offered)' });
    else if (mode === 'no-shots') say({ ...observation, shots: observation.shots.slice(0, 2) });
    else say(observation);
  }
  else if (sub === 'journeys') say(JSON.parse(readFileSync(state + '/journeys.json', 'utf8')));
  else if (sub === 'explore') say(JSON.parse(readFileSync(state + '/explore.json', 'utf8')));
  else if (sub === 'dashboard-json') say({ ok: true, status: 200, body: '{}' });
  else if (sub === 'collect-logs') say({ ok: true, files: [] });
  else say({ ok: false, detail: 'scripted machine: unknown ' + sub });
} else if (verb === 'destroy') {
  writeFileSync(state + '/destroyed', '');
}
`;

let dir: string;
let driverPath: string;
let candidateDir: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['FAKE_STATE', 'FAKE_NOTE', 'FAKE_LINK_ID', 'FAKE_INBOX_MODE', 'FAKE_ANSWER_TOOL', 'FAKE_NO_SEARCH', 'FAKE_WORKING', 'RELEASE_CHECK_ANSWER_POLL_MS'];
const noteWith = (id: string): string => `${REMOTE_PRIVATE_NOTE} [Open answer](olympus://open/private/${id})`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-inbox-flow-'));
  driverPath = join(dir, 'driver.ts');
  writeFileSync(driverPath, SCRIPTED_DRIVER);
  chmodSync(driverPath, 0o755);
  candidateDir = join(dir, 'candidate');
  mkdirSync(candidateDir);
  writeFileSync(join(candidateDir, 'olympus-1.1.0.tgz'), 'x');
  const countTier = (tier: string): number => FIXTURE_ITEMS.filter((item) => item.tier === tier).length;
  writeFileSync(join(dir, 'life.json'), JSON.stringify({ seen: FIXTURE_ITEMS.length, stored: FIXTURE_ITEMS.length - countTier('secrets'), secrets: countTier('secrets'), personal: countTier('personal'), privateItems: countTier('private') }));
  writeFileSync(join(dir, 'agent.log'), '');
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.FAKE_STATE = dir;
  process.env.FAKE_LINK_ID = ID;
  process.env.FAKE_NOTE = noteWith(ID);
  // A standard install: olympus_search, no source_answer.
  delete process.env.FAKE_ANSWER_TOOL;
  delete process.env.FAKE_NO_SEARCH;
  process.env.RELEASE_CHECK_ANSWER_POLL_MS = '10';
  delete process.env.FAKE_INBOX_MODE;
  delete process.env.FAKE_WORKING;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

const driverLog = (): string[] => readFileSync(join(dir, 'driver.log'), 'utf8').split('\n').filter(Boolean);
const agentLog = (): string[] => readFileSync(join(dir, 'agent.log'), 'utf8').split('\n').filter(Boolean);

function options(extra: Record<string, unknown> = {}) {
  const runId = newRunId();
  const config: RunConfigFile = { driver: [driverPath], agents: [], settleTimeoutS: 5 };
  return { runId, candidateDir, candidateLabel: 'inbox test', outDir: join(dir, 'out', runId), config, skipRelay: true, skipScreenshots: true, skipJourneys: true, skipExplore: true, skipArchive: true, ...extra };
}
type Report = Awaited<ReturnType<typeof runReleaseCheck>>;
const allChecks = (report: Report) => [...report.machines[0]!.checks, ...report.machines[0]!.agents.flatMap((agent) => agent.checks)];
const failedIds = (report: Report): string[] => allChecks(report).filter((c) => c.status === 'fail').map((c) => c.id);
const checkOf = (report: Report, id: string) => allChecks(report).find((c) => c.id === id);

describe('the Ask page and Inbox leg against a scripted machine', () => {
  test('a clean visit: the scripted agent is asked, the machine is handed the link\'s id, every check passes, the screenshots are in the report', async () => {
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(failedIds(report)).toEqual([]);
    // The one standing problem is that no model agent ran: the scripted agent does not count as one.
    expect(report.errors.every((e) => e.includes('no agent asked a question'))).toBe(true);
    expect(report.errors).toHaveLength(1);
    const scripted = report.machines[0]!.agents.find((agent) => agent.id === 'scripted')!;
    expect(scripted.scripted).toBe(true);
    expect(scripted.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['private-medical.no-leak', 'private-medical.private-note', 'private-medical.link', 'private-medical.link-carries-nothing', 'private-medical.link-relayed']));
    // A standard install: the scripted agent asked with olympus_search, the link path is exercised and not skipped.
    expect(agentLog().some((line) => line.startsWith("mcp-call 'olympus_search'"))).toBe(true);
    expect(agentLog().some((line) => line.startsWith("mcp-call 'source_answer'"))).toBe(false);
    expect(checkOf(report, 'inbox.agent.link-path')).toBeUndefined();
    expect(checkOf(report, 'inbox.agent.entry')?.status).toBe('pass');
    expect(checkOf(report, 'inbox.agent.page')?.status).toBe('pass');
    expect(checkOf(report, 'inbox.agent.answered')?.status).toBe('pass');
    expect(checkOf(report, 'inbox.screenshots')?.status).toBe('pass');
    // The in-machine check was told the id the link named, and nothing else about the question.
    const call = agentLog().find((line) => line.startsWith('inbox-check'))!;
    expect(call).toContain(`--primary '${ID}'`);
    expect(call).toContain("--ids ''");
    expect(driverLog().at(-1)).toContain('destroy');
    const shots = report.machines[0]!.screenshots.map((shot) => shot.path);
    expect(shots).toEqual(['screenshots/ask-page-1280.png', 'screenshots/ask-page-390.png', 'screenshots/inbox-entry-1280.png', 'screenshots/inbox-entry-390.png', 'screenshots/ask-answered-1280.png']);
    for (const path of shots) expect(existsSync(join(opts.outDir, path))).toBe(true);
    const html = readFileSync(join(opts.outDir, 'report.html'), 'utf8');
    expect(html).toContain('Scripted agent over MCP');
    expect(html).toContain('The answer lands in the Inbox, with its sources');
  }, 120_000);

  test('a note with no link fails the link check and leaves nothing for the Inbox to find, but the machine is still checked and destroyed', async () => {
    process.env.FAKE_NOTE = REMOTE_PRIVATE_NOTE;
    const report = await runReleaseCheck(options());
    const failed = failedIds(report);
    expect(failed).toContain('private-medical.link');
    expect(failed).toContain('inbox.agent.entry');
    expect(report.verdict).toBe('fail');
    expect(driverLog().at(-1)).toContain('destroy');
  }, 120_000);

  test('no note at all fails the note and the link', async () => {
    process.env.FAKE_NOTE = '';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual(expect.arrayContaining(['private-medical.private-note', 'private-medical.link']));
  }, 120_000);

  test('an id that carries a word of the question fails "carries nothing"', async () => {
    const id = 'cardiology'.padEnd(22, 'X');
    process.env.FAKE_NOTE = noteWith(id);
    process.env.FAKE_LINK_ID = id;
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual(['private-medical.link-carries-nothing']);
  }, 120_000);

  test('a visit that did not finish is a failed run with the reason, not a pass', async () => {
    process.env.FAKE_INBOX_MODE = 'not-ok';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toContain('inbox.ran');
    expect(checkOf(report, 'inbox.ran')?.detail).toContain('Unlock was not offered');
    expect(report.verdict).toBe('fail');
  }, 120_000);

  test('a connection the product opened to another machine fails the run on inbox.stays-here', async () => {
    process.env.FAKE_INBOX_MODE = 'egress';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual(['inbox.stays-here']);
    expect(checkOf(report, 'inbox.stays-here')?.detail).toContain('203.0.113.7:443');
  }, 120_000);

  test('screenshots that did not come back fail the run', async () => {
    process.env.FAKE_INBOX_MODE = 'no-shots';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual(['inbox.screenshots']);
  }, 120_000);

  test('--skip-inbox leaves the leg out: no scripted agent, no in-machine call', async () => {
    const report = await runReleaseCheck(options({ skipInbox: true }));
    expect(report.machines[0]!.agents.map((agent) => agent.id)).not.toContain('scripted');
    expect(agentLog().some((line) => line.startsWith('inbox-check'))).toBe(false);
    expect(failedIds(report)).toEqual([]);
  }, 120_000);

  for (const mode of INBOX_SELFTESTS) {
    test(`the ${mode} self-test makes the run fail on ${INBOX_SELFTEST_FAILS[mode]}, says so in the report, and destroys the machine`, async () => {
      const opts = options({ inboxSelftest: mode });
      const report = await runReleaseCheck(opts);
      expect(report.verdict).toBe('fail');
      expect(failedIds(report)).toContain(INBOX_SELFTEST_FAILS[mode]);
      expect(report.selfTest).toContain(mode);
      expect(report.selfTest).toContain(INBOX_SELFTEST_FAILS[mode]);
      expect(driverLog().at(-1)).toContain('destroy');
      // The planted string is redacted everywhere the run wrote.
      for (const file of ['report.json', 'report.html', join('logs', 'run.log')]) {
        const text = readFileSync(join(opts.outDir, file), 'utf8');
        expect(text, file).not.toContain(PRIVATE_FACTS[0]);
        expect(text, file).not.toContain(PRIVATE_MARKER);
      }
    }, 120_000);
  }

  test('the wrong-link-id self-test hands the machine an id the link did not name, and only the entry checks fail', async () => {
    const report = await runReleaseCheck(options({ inboxSelftest: 'wrong-link-id' }));
    const call = agentLog().find((line) => line.startsWith('inbox-check'))!;
    expect(call).not.toContain(`--primary '${ID}'`);
    expect(call).toContain(`--primary '${ID.slice(0, 21)}`);
    expect(failedIds(report).sort()).toEqual(['inbox.agent.answered', 'inbox.agent.entry', 'inbox.agent.page']);
  }, 120_000);

  test('the plant-private-reply self-test fails the scripted agent\'s leak check and nothing about the Inbox', async () => {
    const report = await runReleaseCheck(options({ inboxSelftest: 'plant-private-reply' }));
    expect(failedIds(report)).toEqual(['private-medical.no-leak']);
  }, 120_000);
});

describe('an install that offers neither olympus_search nor source_answer', () => {
  beforeEach(() => {
    process.env.FAKE_INBOX_MODE = 'tools-none';
    process.env.FAKE_NOTE = '';
    delete process.env.FAKE_LINK_ID;
  });

  test('nothing is asked, the link path is a visible skip, and the Ask page\'s own entry is opened by address instead', async () => {
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(failedIds(report)).toEqual([]);
    const call = agentLog().find((line) => line.startsWith('inbox-check'))!;
    expect(call).toContain("--primary ''");
    expect(agentLog().some((line) => line.startsWith('mcp-call'))).toBe(false);
    const skipped = checkOf(report, 'inbox.agent.link-path')!;
    expect(skipped.status).toBe('skip');
    expect(skipped.detail).toContain('source_answer_result, source_index_status');
    expect(skipped.detail).toContain('neither olympus_search nor source_answer');
    expect(checkOf(report, 'inbox.link.opens-entry')?.status).toBe('pass');
    const scripted = report.machines[0]!.agents.find((agent) => agent.id === 'scripted')!;
    expect(scripted.ran).toBe(false);
    expect(scripted.checks).toEqual([]);
    expect(checkOf(report, 'inbox.screenshots')?.status).toBe('pass');
  }, 120_000);

  test('the wrong-link-id self-test has no link to corrupt, so it corrupts the entry address and fails inbox.link.opens-entry', async () => {
    const report = await runReleaseCheck(options({ inboxSelftest: 'wrong-link-id' }));
    expect(report.verdict).toBe('fail');
    expect(agentLog().find((line) => line.startsWith('inbox-check'))).toContain('--fault-entry-id');
    expect(failedIds(report)).toContain('inbox.link.opens-entry');
    expect(report.selfTest).toContain('inbox.link.opens-entry');
  }, 120_000);
});

describe('an install that offers source_answer', () => {
  test('beside the search it is not used: the scripted agent asks as a standard install does, with olympus_search', async () => {
    process.env.FAKE_ANSWER_TOOL = '1';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual([]);
    const calls = agentLog().filter((line) => line.startsWith('mcp-call'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("'olympus_search'");
    expect(checkOf(report, 'private-medical.link')?.status).toBe('pass');
  }, 120_000);

  test('without the search, a working reply is collected with source_answer_result, as the tool tells an agent, and the link in the final answer is judged', async () => {
    process.env.FAKE_ANSWER_TOOL = '1';
    process.env.FAKE_NO_SEARCH = '1';
    process.env.FAKE_WORKING = '1';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual([]);
    const calls = agentLog().filter((line) => line.startsWith('mcp-call'));
    expect(calls[0]).toContain("'source_answer'");
    expect(calls[1]).toContain("'source_answer_result'");
    expect(checkOf(report, 'private-medical.link')?.status).toBe('pass');
  }, 120_000);
});

describe('the tool listing and the answer tool\'s time', () => {
  test('a call to source_answer is given longer than the engine\'s longest hand-off, so a slow answer\'s "working" reply is seen and collected', async () => {
    expect(ANSWER_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(SOURCE_ANSWER_HANDOFF_MAX_MS + 60_000);
    process.env.FAKE_ANSWER_TOOL = '1';
    process.env.FAKE_NO_SEARCH = '1';
    process.env.FAKE_WORKING = '1';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual([]);
    const timeouts = readFileSync(join(dir, 'timeouts.log'), 'utf8').split('\n').filter(Boolean);
    const timeoutOf = (tool: string): number => Number(timeouts.find((line) => line.startsWith(`mcp-call '${tool}'`))!.split('|')[1]) * 1000;
    expect(timeoutOf('source_answer')).toBeGreaterThan(SOURCE_ANSWER_HANDOFF_MAX_MS);
    expect(timeoutOf('source_answer_result')).toBeGreaterThan(SOURCE_ANSWER_HANDOFF_MAX_MS);
  }, 120_000);

  for (const mode of ['tools-fail', 'tools-malformed', 'tools-empty', 'tools-crash']) {
    test(`a tool listing that is ${mode.slice(6)} fails the run on mcp.tool-list and is never taken for a standard install`, async () => {
      process.env.FAKE_INBOX_MODE = mode;
      const report = await runReleaseCheck(options());
      expect(report.verdict).toBe('fail');
      expect(failedIds(report)).toEqual(['mcp.tool-list']);
      expect(checkOf(report, 'inbox.agent.link-path')).toBeUndefined();
      // The leg did not guess: nothing was asked and the browser was not driven.
      expect(agentLog().some((line) => line.startsWith('mcp-call'))).toBe(false);
      expect(agentLog().some((line) => line.startsWith('inbox-check'))).toBe(false);
      expect(driverLog().at(-1)).toContain('destroy');
    }, 120_000);
  }
});

describe('the Inbox self-test arguments', () => {
  const base = (): string[] => {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ driver: [driverPath] }));
    return ['--config', config, '--candidate', candidateDir, '--out', join(dir, 'out')];
  };

  test('a known mode is taken; an unknown one, a clash with another self-test, or --skip-inbox is refused up front', () => {
    expect(parseCli([...base(), '--inbox-selftest', 'wrong-link-id']).inboxSelftest).toBe('wrong-link-id');
    expect(parseCli(base()).skipInbox).toBe(false);
    expect(parseCli([...base(), '--skip-inbox']).skipInbox).toBe(true);
    expect(() => parseCli([...base(), '--inbox-selftest', 'nope'])).toThrow('--inbox-selftest is one of');
    expect(() => parseCli([...base(), '--inbox-selftest', 'wrong-link-id', '--mistier', 'private'])).toThrow('separate self-test');
    expect(() => parseCli([...base(), '--inbox-selftest', 'wrong-link-id', '--skip-inbox'])).toThrow('needs the Inbox leg');
  });
});


describe('the journeys and the visual baselines against a scripted machine', () => {
  const names = SCREENS.flatMap((screen) => SCREEN_THEMES.flatMap((theme) => SCREEN_WIDTHS.map((width) => ({ screen: screen.id, width, theme, name: screenName(screen.id, width, theme) }))));

  /** What the machine hands back: an archive with a picture per screen and a picture per step, and the traces that go with it. */
  function prepareMachine(opts: { failing?: boolean; shade?: number } = {}): void {
    const stage = join(dir, 'journeys-stage');
    mkdirSync(join(stage, 'screens'), { recursive: true });
    mkdirSync(join(stage, 'traces', 'sources-healthy'), { recursive: true });
    const image = new PNG({ width: 40, height: 40 });
    image.data.fill(opts.shade ?? 240);
    const bytes = PNG.sync.write(image);
    for (const item of names) writeFileSync(join(stage, 'screens', `${item.name}.png`), bytes);
    writeFileSync(join(stage, 'traces', 'sources-healthy', '01-open-the-dashboard.jpg'), 'jpg');
    const trace = { id: 'sources-healthy', title: 'Sources shows the connected source as healthy', source: 'test', ok: !opts.failing, ms: 900, steps: [
      { n: 1, name: 'Open the dashboard', action: 'open the dashboard', expected: 'the page says "Sources"', actual: opts.failing ? 'it does not' : 'it does', ok: !opts.failing, ms: 800, at: '/dashboard', screenshot: 'sources-healthy/01-open-the-dashboard.jpg', consoleErrors: [], failedRequests: [], findings: [] },
    ] };
    spawnSync('tar', ['-czf', join(dir, 'journeys.tgz'), '-C', stage, '.']);
    writeFileSync(join(dir, 'journeys.json'), JSON.stringify({ ok: true, traces: [trace], screens: names.map((item) => ({ ...item, bytes: bytes.length, height: 40 })), archive: '/home/test/rc/journeys.tgz' }));
  }

  test('without --baselines the journeys run and the screens are not compared; the traces and the Inbox leg steps are in the report with their pictures', async () => {
    prepareMachine();
    const opts = options({ skipJourneys: false });
    const report = await runReleaseCheck(opts);
    expect(failedIds(report)).toEqual([]);
    expect(checkOf(report, 'journey.sources-healthy')?.status).toBe('pass');
    expect(checkOf(report, 'visual.baselines')?.status).toBe('skip');
    const traces = report.machines[0]!.traces!;
    expect(traces.map((trace) => trace.id)).toEqual(['inbox-check', 'sources-healthy']);
    expect(existsSync(join(opts.outDir, 'traces', 'sources-healthy', '01-open-the-dashboard.jpg'))).toBe(true);
    expect(existsSync(join(opts.outDir, 'traces', 'inbox-check', 'trace-01.jpg'))).toBe(true);
    const html = readFileSync(join(opts.outDir, 'report.html'), 'utf8');
    expect(html).toContain('traces/sources-healthy/01-open-the-dashboard.jpg');
    expect(html).toContain('traces/inbox-check/trace-01.jpg');
    expect(agentLog().find((line) => line.startsWith('journeys'))).toContain('--out ~/rc/journeys');
  }, 120_000);

  /** What the machine hands back from the exploration: a result with one pressed control and one missed, and a picture per step. */
  function prepareExplore(opts: { failing?: boolean } = {}): void {
    const stage = join(dir, 'explore-stage');
    mkdirSync(join(stage, 'traces', 'explore-populated'), { recursive: true });
    writeFileSync(join(stage, 'traces', 'explore-populated', '02.jpg'), 'jpg');
    const step = { n: 2, name: 'Readwise: Sync now', action: 'press button "Sync now"', expected: 'something happens, and the generic rules hold', actual: opts.failing ? 'nothing changed' : 'the page changed', ok: !opts.failing, ms: 900, at: '/dashboard', screenshot: 'explore-populated/02.jpg', consoleErrors: [], failedRequests: [], findings: opts.failing ? ['pressing "Sync now" did nothing: nothing on the page changed'] : [] };
    const result = {
      seeds: [{ id: 'populated', title: 'populated', produced: true, detail: 'connected', pressed: 1, failed: opts.failing ? 1 : 0 }],
      traces: [{ id: 'explore-populated', title: 'Pressing every control in the Sources section, from the populated state', source: 'bounded exploration', ok: !opts.failing, steps: [step], ms: 900 }],
      coverage: [
        { id: 'readwise.library:sync', sourceLabel: 'Readwise', kind: 'sync', label: 'Sync now', destructive: false, status: 'pressed', detail: 'pressed from: populated', seeds: ['populated'] },
        { id: 'gmail.email:sync', sourceLabel: 'Gmail', kind: 'sync', label: 'Sync now', destructive: false, status: 'missed', detail: 'unreachable on a throwaway machine: needs a real sign-in', seeds: ['populated'] },
      ],
      unlisted: [], summary: { listed: 2, found: 1, pressed: 1, missed: 1, unlisted: 0, presses: 1 },
      accessibility: { status: 'skipped', reason: 'no accessibility checker is installed' },
    };
    spawnSync('tar', ['-czf', join(dir, 'explore.tgz'), '-C', stage, '.']);
    writeFileSync(join(dir, 'explore.json'), JSON.stringify({ ok: true, result, archive: '/home/test/rc/explore.tgz' }));
  }

  test('the exploration: its inventory goes to the machine, a failing press fails the seed\'s check, the coverage is advisory and in the report with each miss\'s reason', async () => {
    prepareMachine();
    prepareExplore();
    const opts = options({ skipJourneys: false, skipExplore: false });
    const report = await runReleaseCheck(opts);
    expect(failedIds(report)).toEqual([]);
    expect(checkOf(report, 'explore.populated')?.status).toBe('pass');
    expect(checkOf(report, 'explore.coverage')?.status).toBe('warn');
    expect(checkOf(report, 'explore.accessibility')?.status).toBe('skip');
    expect(agentLog().find((line) => line.startsWith('explore'))).toContain('--inventory ~/rc/explore-inventory.json');
    expect(driverLog().some((line) => line.startsWith('put') && line.includes('inventory.json'))).toBe(true);
    const html = readFileSync(join(opts.outDir, 'report.html'), 'utf8');
    expect(html).toContain('Control exploration');
    expect(html).toContain('unreachable on a throwaway machine');
    expect(html).toContain('traces/explore-populated/02.jpg');
    expect(existsSync(join(opts.outDir, 'traces', 'explore-populated', '02.jpg'))).toBe(true);

    prepareExplore({ failing: true });
    const broken = await runReleaseCheck(options({ skipJourneys: false, skipExplore: false }));
    expect(broken.verdict).toBe('fail');
    expect(failedIds(broken)).toContain('explore.populated');
    expect(checkOf(broken, 'explore.populated')?.detail).toContain('did nothing');
  }, 240_000);

  test('a journey that did not reach its outcome fails the run on journey.<id>', async () => {
    prepareMachine({ failing: true });
    const report = await runReleaseCheck(options({ skipJourneys: false }));
    expect(report.verdict).toBe('fail');
    expect(failedIds(report)).toContain('journey.sources-healthy');
    expect(failedIds(report)).not.toContain('journey.inbox-check');
  }, 120_000);

  test('--only-journeys is handed to the machine', async () => {
    prepareMachine();
    await runReleaseCheck(options({ skipJourneys: false, onlyJourneys: ['sources-healthy', 'no-public-tier'] }));
    expect(agentLog().find((line) => line.startsWith('journeys'))).toContain("--only 'sources-healthy,no-public-tier'");
  }, 120_000);

  test('baselines: no approved picture fails every screen; --update-baselines writes candidates (warn); then a plain run passes; a changed screen fails', async () => {
    prepareMachine();
    const baselinesDir = join(dir, 'baselines');
    const missing = await runReleaseCheck(options({ skipJourneys: false, baselinesDir }));
    const visualIds = (report: Report, status: string) => allChecks(report).filter((c) => c.id.startsWith('visual.') && c.status === status).map((c) => c.id);
    expect(visualIds(missing, 'fail')).toHaveLength(names.length);

    const updated = await runReleaseCheck(options({ skipJourneys: false, baselinesDir, updateBaselines: true }));
    expect(visualIds(updated, 'warn')).toHaveLength(names.length);
    expect(failedIds(updated)).toEqual([]);
    expect(readdirSync(baselinesDir).filter((file) => file !== 'approval.json').sort()).toEqual(names.map((item) => `${item.name}.png`).sort());
    expect(existsSync(join(baselinesDir, 'approval.json'))).toBe(true);

    const approvedBefore = readFileSync(join(baselinesDir, `${names[0]!.name}.png`));
    const again = await runReleaseCheck(options({ skipJourneys: false, baselinesDir }));
    expect(visualIds(again, 'pass')).toHaveLength(names.length);
    expect(failedIds(again)).toEqual([]);

    prepareMachine({ shade: 20 });
    const changed = options({ skipJourneys: false, baselinesDir });
    const different = await runReleaseCheck(changed);
    expect(visualIds(different, 'fail')).toHaveLength(names.length);
    expect(existsSync(join(changed.outDir, 'visual', `${names[0]!.name}.diff.png`))).toBe(true);
    expect(readFileSync(join(changed.outDir, 'report.html'), 'utf8')).toContain('Visual baselines');
    // A plain run never changes an approved picture.
    expect(readFileSync(join(baselinesDir, `${names[0]!.name}.png`)).equals(approvedBefore)).toBe(true);
  }, 240_000);
});
