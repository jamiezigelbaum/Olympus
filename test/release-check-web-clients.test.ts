import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBrowser } from '../scripts/release-check/browser.ts';
import type { ExecResult, Machine } from '../scripts/release-check/machine.ts';
import {
  askQuestion, blockedReason, evaluateTurn, parseClientQuestions, redactForbidden, runWebClients, startBrowserScript, turnText,
  type ClientQuestion, type PageState,
} from '../scripts/release-check/web-clients.ts';

const statusOf = (checks: Array<{ id: string; status: string }>) => Object.fromEntries(checks.map((check) => [check.id, check.status]));

const pickup: ClientQuestion = { id: 'pickup', prompt: 'Ask Olympus what the plan is for picking up the kids on Friday.', kind: 'personal', expect: ['12:30', 'Nina'], forbid: ['162'], cite: ['Conferences'] };
const doctor: ClientQuestion = { id: 'doctor', prompt: 'Ask Olympus what my doctor said about my cholesterol results.', kind: 'private', panel_expect: ['162'], forbid: ['162', 'LDL'] };

describe('web clients: what a turn is held to', () => {
  test('a cited answer with every fact passes; the turn starts after the question', () => {
    const page = `New chat\n${pickup.prompt}\nUsed Olympus\nMaya picks them up at 12:30 and Nina brings Leo home. [Conferences: early dismissal]`;
    const turn = turnText(page, pickup.prompt);
    expect(turn.startsWith('\nUsed Olympus')).toBe(true);
    expect(statusOf(evaluateTurn('chatgpt', pickup, { turn, frames: '', ms: 9_000 }))).toEqual({
      'web.chatgpt.pickup.answered': 'pass', 'web.chatgpt.pickup.used-olympus': 'pass', 'web.chatgpt.pickup.no-leak': 'pass',
      'web.chatgpt.pickup.facts': 'pass', 'web.chatgpt.pickup.cited': 'pass',
    });
  });

  test('a missing fact, no Olympus and a leak fail, and the report never repeats the leaked string', () => {
    const checks = evaluateTurn('claude', pickup, { turn: 'Pick-up is at 12:30. Your LDL of 162 is fine.', frames: '', ms: 1 });
    expect(statusOf(checks)).toMatchObject({ 'web.claude.pickup.used-olympus': 'fail', 'web.claude.pickup.no-leak': 'fail', 'web.claude.pickup.facts': 'fail', 'web.claude.pickup.cited': 'fail' });
    expect(JSON.stringify(checks)).not.toContain('162');
    // A reply still coming at the deadline is not a finished answer, however right it looks so far.
    expect(statusOf(evaluateTurn('claude', pickup, { turn: 'Olympus says pick-up is at', frames: '', ms: 300_000, unfinished: true }))['web.claude.pickup.answered']).toBe('fail');
    expect(redactForbidden('LDL 162 mg', ['162'])).toBe('LDL [forbidden 1] mg');
  });

  test('a Private question needs the note, and in ChatGPT the panel with its facts; the panel itself may hold them', () => {
    const turn = 'Olympus is answering this privately on your computer, in the panel below.';
    const ok = evaluateTurn('chatgpt', doctor, { turn, frames: 'Private answer from your computer\nTotal cholesterol 162. Not sent to ChatGPT', ms: 1 });
    expect(ok.every((check) => check.status === 'pass')).toBe(true);
    expect(JSON.stringify(ok)).not.toContain('162');
    const noPanel = evaluateTurn('chatgpt', doctor, { turn, frames: '', ms: 1 });
    expect(statusOf(noPanel)['web.chatgpt.doctor.private-panel']).toBe('fail');
    // Grok and Claude.ai have no panel: the note is the whole check.
    expect(statusOf(evaluateTurn('grok', doctor, { turn, frames: '', ms: 1 }))).toEqual({
      'web.grok.doctor.answered': 'pass', 'web.grok.doctor.used-olympus': 'pass', 'web.grok.doctor.no-leak': 'pass', 'web.grok.doctor.private-note': 'pass',
    });
  });

  test('ChatGPT\'s private panel is waited for until its facts show, not just its heading', async () => {
    let frameReads = 0;
    const state: PageState = { url: 'https://chatgpt.com/c/1', title: 'ChatGPT', challenge: false, signedOut: false, composer: true, composerText: '', busy: false, text: `${doctor.prompt}\nOlympus is answering this privately on your computer.` };
    const tab = {
      evaluate: async () => state as never, goto: async () => {}, type: async () => {}, enter: async () => {}, screenshot: async () => {}, close: async () => {},
      // The panel shows its heading while it prepares the answer; the facts come two reads later.
      framesText: async () => (++frameReads >= 3 ? 'Private answer from your computer\nTotal cholesterol 162.' : 'Private answer from your computer\nPreparing…'),
    };
    const obs = await askQuestion(tab, 'chatgpt', doctor, { pollMs: 0, loadMs: 1_000, answerMs: 1_000, settleMs: 0, panelMs: 5_000, sleep: async () => {} });
    expect('frames' in obs && obs.frames).toContain('162');
    expect(frameReads).toBe(3);
  });

  test('a reply still streaming when the answer time runs out comes back unfinished', async () => {
    const state: PageState = { url: 'https://claude.ai/chat/1', title: 'Claude', challenge: false, signedOut: false, composer: true, composerText: '', busy: true, text: `${pickup.prompt}\nOlympus says pick-up is at` };
    const tab = { evaluate: async () => state as never, framesText: async () => '', goto: async () => {}, type: async () => {}, enter: async () => {}, screenshot: async () => {}, close: async () => {} };
    const obs = await askQuestion(tab, 'claude', pickup, { pollMs: 0, loadMs: 1_000, answerMs: 0, settleMs: 0, panelMs: 0, sleep: async () => {} });
    expect(obs).toMatchObject({ unfinished: true });
  });

  test('an app that cannot reach Olympus, a signed-out app and a bot check are inconclusive, with what to renew', () => {
    const [notConnected] = evaluateTurn('claude', pickup, { turn: 'I need you to connect Olympus before I can look that up.', frames: '', ms: 1 });
    expect(notConnected).toMatchObject({ status: 'skip' });
    expect(notConnected!.detail).toContain('connect Olympus again');
    // Saying Olympus is connected is not a connection problem: the turn is judged as usual.
    expect(statusOf(evaluateTurn('grok', doctor, { turn: 'Olympus is connected. Your answer is in Olympus on your computer.', frames: '', ms: 1 }))['web.grok.doctor.private-note']).toBe('pass');
    const base: PageState = { url: 'https://chatgpt.com/', title: 'ChatGPT', challenge: false, signedOut: false, composer: true, composerText: '', busy: false, text: '' };
    expect(blockedReason('chatgpt', base)).toBeUndefined();
    expect(blockedReason('chatgpt', { ...base, signedOut: true })).toContain('signed out');
    expect(blockedReason('claude', { ...base, title: 'Just a moment...', challenge: true })).toContain('bot check');
    expect(blockedReason('grok', { ...base, composer: false })).toContain('no message box');
    expect(evaluateTurn('grok', pickup, { inconclusive: 'Grok is signed out' })[0]).toMatchObject({ id: 'web.grok.pickup', status: 'skip', detail: 'Inconclusive: Grok is signed out' });
  });

  test('the demo kit\'s questions file reads as it is written, and a bad entry names itself', () => {
    const questions = parseClientQuestions({ persona: 'x', questions: [
      { id: 'pickup-friday', prompt: 'Ask Olympus …', kind: 'personal', expect: ['12:30'], forbid: [], sources: ['gmail'] },
      { id: 'doctor-cholesterol', prompt: 'Ask Olympus …', kind: 'private', expect: [], panel_expect: ['162'], forbid: ['162'], tier_note: 'n' },
    ] });
    expect(questions.map((q) => q.id)).toEqual(['pickup-friday', 'doctor-cholesterol']);
    expect(questions[1]!.panel_expect).toEqual(['162']);
    expect(() => parseClientQuestions([{ id: 'x', prompt: 'p', kind: 'gossip' }])).toThrow('question x: kind');
    expect(() => parseClientQuestions([{ id: 'x', prompt: 'p', kind: 'personal', clients: ['bard'] }])).toThrow('clients are');
  });

  test('the browser on the machine keeps its own profile and only listens on the loopback address', () => {
    const mac = startBrowserScript('macos', 9333);
    expect(mac).toContain(`open -na 'Google Chrome' --args --user-data-dir="$HOME/.olympus-canary/web-clients" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1`);
    const linux = startBrowserScript('linux', 9333, ['https://chatgpt.com/']);
    expect(linux).toContain('setsid "$b"');
    expect(linux).toContain(`curl -fsS --max-time 5 -X PUT 'http://127.0.0.1:9333/json/new?https://chatgpt.com/'`);
  });
});

/**
 * A stand-in chat app served here and a real headless Chrome, driven through the same path a canary run takes (machine,
 * tunnel, DevTools): what the app shows decides each check.
 */
const browserPath = process.env.OLYMPUS_TEST_CHROME ?? findBrowser() ?? ['/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'].find((path) => existsSync(path));

const CHAT_PAGE = (mode: string): string => `<!doctype html><html><head><title>Stand-in chat</title></head><body><main>
<div id="log"></div>${mode === 'signed-out' ? '<button>Log in</button>' : ''}
<div id="prompt-textarea" contenteditable="true" style="min-height:20px;border:1px solid #000"></div>
<script>
const log = document.getElementById('log'), box = document.getElementById('prompt-textarea');
box.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const q = box.innerText.trim(); box.innerText = '';
  const user = document.createElement('div'); user.textContent = q; log.appendChild(user);
  const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop streaming'); stop.textContent = 'Stop'; document.body.appendChild(stop);
  setTimeout(() => {
    const reply = document.createElement('div'); log.appendChild(reply);
    if (/cholesterol/.test(q)) {
      reply.textContent = 'Used Olympus. Olympus is answering this privately on your computer.';
      const frame = document.createElement('iframe'); frame.srcdoc = '<p>Private answer from your computer: total 162. Not sent to ChatGPT</p>'; document.body.appendChild(frame);
    } else {
      reply.textContent = 'Used Olympus. ' + (${JSON.stringify(mode)} === 'wrong' ? 'Maya picks them up.' : 'Maya picks them up at 12:30 and Nina brings Leo. [Conferences]');
    }
    stop.remove();
  }, 400);
});
</script></main></body></html>`;

describe.skipIf(!browserPath)('web clients: a real browser on a stand-in app', () => {
  let server: ReturnType<typeof Bun.serve>;
  let chrome: ChildProcess;
  let profile: string;
  const port = 19_000 + Math.floor(Math.random() * 1_000);
  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch: (request) => new Response(CHAT_PAGE(new URL(request.url).pathname.slice(1)), { headers: { 'content-type': 'text/html' } }) });
    profile = mkdtempSync(join(tmpdir(), 'web-clients-profile-'));
    chrome = spawn(browserPath!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch { /* starting */ }
      await Bun.sleep(250);
    }
    throw new Error('the test browser did not start');
  });
  afterAll(() => {
    server?.stop(true);
    chrome?.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  });

  const machine = (): Machine & { scripts: string[] } => {
    const scripts: string[] = [];
    const ok: ExecResult = { code: 0, stdout: '{}', stderr: '', timedOut: false, ms: 1 };
    return {
      handle: 'test-box', label: 'test-box', os: 'linux', driver: 'fake', scripts,
      upgrade: async () => {}, put: async () => {}, get: async () => {},
      exec: async (script) => { scripts.push(script); return ok; },
      tunnel: async () => ({ port, close: () => {} }),
    };
  };
  const fast = { pollMs: 150, loadMs: 5_000, answerMs: 10_000, settleMs: 600, panelMs: 3_000, sleep: (ms: number) => Bun.sleep(ms) };

  test('a good answer, a wrong one, a Private panel and a signed-out app, each as the app showed it', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const screens = mkdtempSync(join(tmpdir(), 'web-clients-screens-'));
    const target = machine();
    const good = await runWebClients(target, {
      clients: ['chatgpt'], questions: [pickup, doctor], os: 'linux', screensDir: screens, timings: fast, debugPort: port,
      newChatUrls: { chatgpt: `${base}/good` },
    });
    expect(target.scripts[0]).toContain(`--remote-debugging-port=${port}`);
    expect(good.checks.filter((check) => check.status !== 'pass')).toEqual([]);
    expect(statusOf(good.checks)).toMatchObject({ 'web.browser': 'pass', 'web.chatgpt.pickup.facts': 'pass', 'web.chatgpt.doctor.private-panel': 'pass', 'web.chatgpt.doctor.private-panel-facts': 'pass' });
    expect(good.screens.map((screen) => screen.label)).toEqual(['ChatGPT: pickup', 'ChatGPT: doctor']);
    expect(existsSync(good.screens[0]!.path)).toBe(true);

    const wrong = await runWebClients(machine(), { clients: ['chatgpt'], questions: [pickup], os: 'linux', screensDir: screens, timings: fast, debugPort: port, newChatUrls: { chatgpt: `${base}/wrong` } });
    expect(statusOf(wrong.checks)).toMatchObject({ 'web.chatgpt.pickup.facts': 'fail', 'web.chatgpt.pickup.cited': 'fail', 'web.chatgpt.pickup.used-olympus': 'pass' });

    const out = await runWebClients(machine(), { clients: ['grok'], questions: [pickup, doctor], os: 'linux', screensDir: screens, timings: fast, debugPort: port, newChatUrls: { grok: `${base}/signed-out` } });
    // A signed-out app stops after its first question: every later one would say the same.
    expect(out.checks.map((check) => [check.id, check.status])).toEqual([['web.browser', 'pass'], ['web.grok.pickup', 'skip']]);
    expect(out.checks[1]!.detail).toBe('Inconclusive: Grok is signed out; sign the test account in again in the canary browser');
  }, 60_000);

  test('a driver with no tunnel makes the clients inconclusive, not failed', async () => {
    const { tunnel: _tunnel, ...rest } = machine();
    const result = await runWebClients(rest, { clients: ['chatgpt'], questions: [pickup], os: 'linux', screensDir: tmpdir() });
    expect(result.checks).toEqual([{ id: 'web.browser', title: 'The canary browser on the machine', status: 'skip', detail: 'Inconclusive: the driver has no tunnel verb, so the browser on the machine cannot be reached', ms: expect.any(Number) }]);
  });
});
