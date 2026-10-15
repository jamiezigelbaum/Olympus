// OLYMPUS_TEST_LANE: deploy
// The release check's Ask page and Inbox leg end to end, against a scripted stand-in for a machine: the scripted agent's Private
// question, the in-machine check's result, the checks and screenshots that come out, and the self-tests that must fail the run.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURE_ITEMS, PRIVATE_FACTS, PRIVATE_MARKER } from '../scripts/release-check/fixture.ts';
import { REMOTE_PRIVATE_NOTE } from '../src/core/remote-result.ts';
import { PRIVATE_MATCH_NOTE } from '../src/workers/chatgpt/response-builder.ts';
import { INBOX_SELFTEST_FAILS, INBOX_SELFTESTS, newRunId, parseCli, runReleaseCheck, type RunConfigFile } from '../scripts/release-check/run.ts';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';

/**
 * A machine that is just enough of one: it answers the in-machine agent's subcommands. `mcp-call` returns a Private note whose link
 * the test chooses; `inbox-check` builds the observation a clean visit gives, from the id the harness passed it, and the test can
 * make one part of it go wrong.
 */
const SCRIPTED_DRIVER = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [verb, ...rest] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
const log = (line) => appendFileSync(state + '/driver.log', line + '\n');
log([verb, ...rest].join(' '));
const arg = (name) => rest[rest.indexOf(name) + 1];
const say = (value) => console.log(JSON.stringify(value));
if (verb === 'provision') {
  console.log('{"machine":"fake-' + arg('--run-id') + '","label":"Scripted machine","os":"linux","driver":"fake"}');
} else if (verb === 'get') {
  writeFileSync(arg('--to'), 'png');
} else if (verb === 'exec') {
  const script = await new Response(Bun.stdin.stream()).text();
  const sub = /agent\.js (\S+)/.exec(script)?.[1];
  appendFileSync(state + '/agent.log', (/agent\.js (.*)/.exec(script)?.[1] ?? '') + '\n');
  const life = JSON.parse(readFileSync(state + '/life.json', 'utf8'));
  const counts = { seen: life.seen, indexed: life.stored, contentReady: life.stored, embedded: life.stored, secretsLocated: life.secrets, pending: 0, queueWaiting: 0, queueActive: 0, personal: life.personal, privateItems: life.privateItems };
  const mode = process.env.FAKE_INBOX_MODE ?? '';
  if (sub === 'engine-build') say({ ok: true, build: '1.1.0+abc', version: '1.1.0', remoteMode: 'relay', relay: {} });
  else if (sub === 'prepare-source') say({ ok: true, rules: 2, engineReadyMs: 1000 });
  else if (sub === 'connect-source') say({ ok: true, message: 'Connected' });
  else if (sub === 'sync') say({ ok: true, status: 200 });
  else if (sub === 'settle') say({ ok: true, settled: true, polls: 2, waitedMs: 1000, snapshot: counts });
  else if (sub === 'mcp-token') say({ ok: true, connection: 'conn-1' });
  else if (sub === 'mcp-tools') say({ ok: true, tools: [{ name: 'olympus_search', annotations: { readOnlyHint: true } }, { name: 'source_answer_result', annotations: { readOnlyHint: true } }, ...(process.env.FAKE_ANSWER_TOOL === '1' ? [{ name: 'source_answer', annotations: { readOnlyHint: true } }] : [])] });
  else if (sub === 'mcp-call') {
    const note = process.env.FAKE_NOTE ?? '';
    const counter = state + '/calls';
    const calls = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(calls + 1));
    if (process.env.FAKE_WORKING === '1' && calls === 0) {
      say({ ok: true, status: 200, isError: false, text: JSON.stringify({ status: 'working', job_id: 'job.install.abc', next_tool: 'source_answer_result' }), structured: null, noteKind: null });
    } else if (process.env.FAKE_ANSWER_TOOL === '1') {
      const output = { kind: 'source_answer', status: 'answered', answer: 'Nothing public answers this.', citations: [], ...(note ? { private_note: note } : {}) };
      say({ ok: true, status: 200, isError: false, text: JSON.stringify(output, null, 2), structured: null, noteKind: note ? 'remote' : null });
    } else {
      // A standard install: the search says some Private items match, in the product's own words, and carries no link.
      const output = { evidence: [], note: process.env.FAKE_MATCH_NOTE };
      say({ ok: true, status: 200, isError: false, text: JSON.stringify(output, null, 2), structured: null, noteKind: 'no_panel' });
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
      shots: ['ask-page-1280.png', 'ask-page-390.png', ...(faulted ? [] : ['inbox-entry-1280.png', 'inbox-entry-390.png']), 'ask-answered-1280.png'].map(file),
    };
    if (mode === 'not-ok') say({ ok: false, detail: 'the Private answers page did not open its controls (Unlock was not offered)' });
    else if (mode === 'no-shots') say({ ...observation, shots: observation.shots.slice(0, 2) });
    else say(observation);
  }
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
const ENV_KEYS = ['FAKE_STATE', 'FAKE_NOTE', 'FAKE_LINK_ID', 'FAKE_INBOX_MODE', 'FAKE_ANSWER_TOOL', 'FAKE_WORKING', 'FAKE_MATCH_NOTE', 'RELEASE_CHECK_ANSWER_POLL_MS'];
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
  process.env.FAKE_ANSWER_TOOL = '1';
  process.env.FAKE_MATCH_NOTE = PRIVATE_MATCH_NOTE;
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
  return { runId, candidateDir, candidateLabel: 'inbox test', outDir: join(dir, 'out', runId), config, skipRelay: true, skipScreenshots: true, ...extra };
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

describe('an install that offers agents no answer tool (a standard install)', () => {
  beforeEach(() => {
    process.env.FAKE_ANSWER_TOOL = '0';
    process.env.FAKE_NOTE = '';
    delete process.env.FAKE_LINK_ID;
  });

  test('the scripted agent uses the search, no link is judged, the link path is a visible skip, and the Ask page\'s own entry is opened by address instead', async () => {
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(failedIds(report)).toEqual([]);
    const call = agentLog().find((line) => line.startsWith('inbox-check'))!;
    expect(call).toContain("--primary ''");
    expect(agentLog().some((line) => line.startsWith("mcp-call 'olympus_search'"))).toBe(true);
    expect(agentLog().some((line) => line.startsWith("mcp-call 'source_answer'"))).toBe(false);
    const skipped = checkOf(report, 'inbox.agent.link-path')!;
    expect(skipped.status).toBe('skip');
    expect(skipped.detail).toContain('olympus_search, source_answer_result');
    expect(checkOf(report, 'inbox.link.opens-entry')?.status).toBe('pass');
    const scripted = report.machines[0]!.agents.find((agent) => agent.id === 'scripted')!;
    expect(scripted.checks.map((c) => c.id)).toEqual(['private-medical.no-leak', 'private-medical.private-note']);
    expect(checkOf(report, 'inbox.screenshots')?.status).toBe('pass');
  }, 120_000);

  test('the wrong-link-id self-test has no link to corrupt, so it corrupts the entry address and fails inbox.link.opens-entry', async () => {
    const report = await runReleaseCheck(options({ inboxSelftest: 'wrong-link-id' }));
    expect(report.verdict).toBe('fail');
    expect(agentLog().find((line) => line.startsWith('inbox-check'))).toContain('--fault-entry-id');
    expect(failedIds(report)).toContain('inbox.link.opens-entry');
    expect(report.selfTest).toContain('inbox.link.opens-entry');
  }, 120_000);

  test('the plant-private-reply self-test still fails the agent\'s leak check', async () => {
    const report = await runReleaseCheck(options({ inboxSelftest: 'plant-private-reply' }));
    expect(failedIds(report)).toEqual(['private-medical.no-leak']);
  }, 120_000);
});

describe('an install that offers source_answer', () => {
  test('a working reply is collected with source_answer_result, as the tool tells an agent, and the link in the final answer is judged', async () => {
    process.env.FAKE_WORKING = '1';
    const report = await runReleaseCheck(options());
    expect(failedIds(report)).toEqual([]);
    const calls = agentLog().filter((line) => line.startsWith('mcp-call'));
    expect(calls[0]).toContain("'source_answer'");
    expect(calls[1]).toContain("'source_answer_result'");
    expect(checkOf(report, 'private-medical.link')?.status).toBe('pass');
  }, 120_000);
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
