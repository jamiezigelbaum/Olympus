import { REMOTE_SECRET_NOTE } from '../src/core/remote-result.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretLocationAnswer } from '../src/core/secret-location-note.ts';
import { findBrowser } from '../scripts/release-check/browser.ts';
import type { ExecResult, Machine } from '../scripts/release-check/machine.ts';
import {
  askQuestion, blockedReason, connectionUses, evaluateTurn, forbiddenFor, olympusUse, parseClientQuestions, redactForbidden, runWebClients, SECRET_ANSWER_LEAD, startBrowserScript, turnText,
  type ClientQuestion, type PageState,
} from '../scripts/release-check/web-clients.ts';

const statusOf = (checks: Array<{ id: string; status: string }>) => Object.fromEntries(checks.map((check) => [check.id, check.status]));

const pickup: ClientQuestion = { id: 'pickup', prompt: 'Ask Olympus what the plan is for picking up the kids on Friday.', kind: 'personal', expect: ['12:30', 'Nina'], forbid: ['162'], cite: ['Conferences'] };
const doctor: ClientQuestion = { id: 'doctor', prompt: 'Ask Olympus what my doctor said about my cholesterol results.', kind: 'private', panel_expect: ['162'], forbid: ['162', 'LDL'] };
const vault: ClientQuestion = { id: 'vault', prompt: 'Ask Olympus for the code to the garage door keypad.', kind: 'secret', forbid: ['4471'] };
// A connection used while the question was asked: the evidence that Olympus was called.
const used = { used: true, detail: 'the connection "ChatGPT" was used while it was asked' } as const;

describe('web clients: what a turn is held to', () => {
  test('a cited answer with every fact passes; the turn starts after the question', () => {
    const page = `New chat\n${pickup.prompt}\nUsed Olympus\nMaya picks them up at 12:30 and Nina brings Leo home. [Conferences: early dismissal]`;
    const turn = turnText(page, pickup.prompt);
    expect(turn.startsWith('\nUsed Olympus')).toBe(true);
    expect(statusOf(evaluateTurn('chatgpt', pickup, { turn, frames: '', ms: 9_000, olympus: used }))).toEqual({
      'web.chatgpt.pickup.answered': 'pass', 'web.chatgpt.pickup.used-olympus': 'pass', 'web.chatgpt.pickup.no-leak': 'pass',
      'web.chatgpt.pickup.facts': 'pass', 'web.chatgpt.pickup.cited': 'pass',
    });
  });

  test('a missing fact, no Olympus and a leak fail, and the report never repeats the leaked string', () => {
    const checks = evaluateTurn('claude', pickup, { turn: 'Pick-up is at 12:30. Your LDL of 162 is fine.', frames: '', ms: 1, olympus: { used: false, detail: 'none of the machine\'s 1 app connection(s) was used while it was asked' } });
    expect(statusOf(checks)).toMatchObject({ 'web.claude.pickup.used-olympus': 'fail', 'web.claude.pickup.no-leak': 'fail', 'web.claude.pickup.facts': 'fail', 'web.claude.pickup.cited': 'fail' });
    expect(JSON.stringify(checks)).not.toContain('162');
    // A reply that repeats the question is read whole, so a leak before the repeat still counts.
    const repeated = turnText(`${pickup.prompt}\nYour LDL is 162. You asked: ${pickup.prompt}\nOlympus cannot share that.`, pickup.prompt);
    expect(statusOf(evaluateTurn('claude', pickup, { turn: repeated, frames: '', ms: 1 }))['web.claude.pickup.no-leak']).toBe('fail');
    // A reply still coming at the deadline is not a finished answer, however right it looks so far.
    expect(statusOf(evaluateTurn('claude', pickup, { turn: 'Olympus says pick-up is at', frames: '', ms: 300_000, unfinished: true }))['web.claude.pickup.answered']).toBe('fail');
    expect(redactForbidden('LDL 162 mg', ['162'])).toBe('LDL [forbidden 1] mg');
  });

  test('a Private question needs the note, and in ChatGPT the panel with its facts; the panel itself may hold them', () => {
    const turn = 'Olympus is answering this privately on your computer, in the panel below.';
    const ok = evaluateTurn('chatgpt', doctor, { turn, frames: 'Private answer from your computer\nTotal cholesterol 162. Not sent to ChatGPT', ms: 1, olympus: used });
    expect(ok.every((check) => check.status === 'pass')).toBe(true);
    expect(JSON.stringify(ok)).not.toContain('162');
    const noPanel = evaluateTurn('chatgpt', doctor, { turn, frames: '', ms: 1 });
    expect(statusOf(noPanel)['web.chatgpt.doctor.private-panel']).toBe('fail');
    // Grok and Claude.ai have no panel: the note is the whole check.
    expect(statusOf(evaluateTurn('grok', doctor, { turn, frames: '', ms: 1, olympus: used }))).toEqual({
      'web.grok.doctor.answered': 'pass', 'web.grok.doctor.used-olympus': 'pass', 'web.grok.doctor.no-leak': 'pass', 'web.grok.doctor.private-note': 'pass',
    });
  });

  test('Olympus was used only when a connection was used: the word on the page is not enough, and an unread record is inconclusive', () => {
    // The question names Olympus and so does a reply that never called it; the old check passed this turn.
    const turn = 'I don\'t have Olympus results for this, but pick-up is usually at 12:30 with Nina. [Conferences]';
    const unused = olympusUse(new Map([['a1', { name: 'ChatGPT', at: '2026-10-28T10:00:00.000Z' }]]), new Map([['a1', { name: 'ChatGPT', at: '2026-10-28T10:00:00.000Z' }]]));
    expect(unused).toEqual({ used: false, detail: 'none of the machine\'s 1 app connection(s) was used while it was asked' });
    expect(statusOf(evaluateTurn('chatgpt', pickup, { turn, frames: '', ms: 1, olympus: unused }))['web.chatgpt.pickup.used-olympus']).toBe('fail');
    expect(olympusUse(new Map([['a1', { name: 'ChatGPT', at: '2026-10-28T10:00:00.000Z' }]]), new Map([['a1', { name: 'ChatGPT', at: '2026-10-28T10:01:30.000Z' }]]))).toEqual({ used: true, detail: 'the connection "ChatGPT" was used while it was asked' });
    // A connection made during the question (the app connected again) and used counts; one never used does not.
    expect(olympusUse(new Map(), new Map([['b2', { name: 'Claude', at: '2026-10-28T10:01:30.000Z' }]]))).toMatchObject({ used: true });
    expect(olympusUse(new Map(), new Map([['b2', { name: 'Claude', at: '' }]]))).toMatchObject({ used: false });
    const unread = evaluateTurn('chatgpt', pickup, { turn, frames: '', ms: 1, olympus: olympusUse('olympus connections list failed: exit 127', new Map()) });
    expect(unread.find((check) => check.id === 'web.chatgpt.pickup.used-olympus')).toMatchObject({ status: 'skip', detail: 'Inconclusive: olympus connections list failed: exit 127' });
    expect(evaluateTurn('chatgpt', pickup, { turn, frames: '', ms: 1 }).find((check) => check.id === 'web.chatgpt.pickup.used-olympus')?.status).toBe('skip');
    // The canary's own connection and revoked ones are not the app's.
    expect([...connectionUses({ kind: 'remote_connections', connections: [
      { id: 'a1', name: 'ChatGPT', status: 'active', last_used_at: '2026-10-28T10:00:00.000Z' },
      { id: 'c3', name: 'release-canary', status: 'active', last_used_at: '2026-10-28T10:00:30.000Z' },
      { id: 'd4', name: 'Grok', status: 'revoked', last_used_at: '2026-10-28T10:00:30.000Z' },
    ] })!.keys()]).toEqual(['a1']);
    expect(connectionUses({})).toBeUndefined();
  });

  test('a personal question must name items to cite, and the question\'s own words never count as a citation', () => {
    const { cite: _cite, ...uncited } = pickup;
    const turn = 'Olympus: Maya picks them up at 12:30 and Nina brings Leo home. [Conferences: early dismissal]';
    expect(evaluateTurn('chatgpt', uncited, { turn, frames: '', ms: 1, olympus: used }).find((check) => check.id === 'web.chatgpt.pickup.cited')).toMatchObject({ status: 'fail', detail: 'the question names no items to cite (cite in the questions file)' });
    // The cited item named in the question itself: only the reply after it is searched.
    const asks: ClientQuestion = { ...pickup, prompt: 'Ask Olympus what the Conferences email says about picking up the kids on Friday.' };
    const page = `${asks.prompt}\nMaya picks them up at 12:30 and Nina brings Leo home.`;
    expect(turnText(page, asks.prompt)).not.toContain('Conferences');
    expect(statusOf(evaluateTurn('chatgpt', asks, { turn: turnText(page, asks.prompt), frames: '', ms: 1, olympus: used }))['web.chatgpt.pickup.cited']).toBe('fail');
    // A long prompt is cut after its first 60 characters and the rest is removed too.
    expect(turnText(`${asks.prompt}\nreply`, asks.prompt)).toBe('\nreply');
  });

  test('every reply is held to every question\'s forbidden strings, except the ones it expects', () => {
    // The pickup answer leaks the Secret question's keypad code: the old check only looked for pickup's own strings.
    const turn = 'Olympus: Maya picks them up at 12:30 with Nina [Conferences]. The garage code is 4471.';
    const shared = [...(doctor.forbid ?? []), ...(vault.forbid ?? [])];
    const checks = evaluateTurn('claude', pickup, { turn, frames: '', ms: 1, olympus: used }, shared);
    expect(statusOf(checks)['web.claude.pickup.no-leak']).toBe('fail');
    expect(JSON.stringify(checks)).not.toContain('4471');
    expect(forbiddenFor({ ...pickup, expect: ['12:30', 'LDL'] }, shared)).toEqual(['162', '4471']);
  });

  test('another question\'s forbidden string is not a leak when this question may say it, or its own prompt says it', () => {
    // Live canary 2026-10-29: "18:00" was the lawyer list's Private time and leo-weekend's Personal pickup; "parenting plan" was the lawyer question's own words.
    const lawyer = { id: 'lawyer', prompt: 'Use Olympus: what did the lawyer say about the parenting plan?', kind: 'private' as const, forbid: ['18:00', 'parenting plan', 'clause 7'] };
    const weekend = { id: 'weekend', prompt: 'Use Olympus: when do I pick Leo up this weekend?', kind: 'personal' as const, may_say: ['18:00', 'clause 7'], forbid: ['clause 7'] };
    const shared = [...lawyer.forbid, ...weekend.forbid];
    expect(forbiddenFor(weekend, shared)).toEqual(['clause 7', 'parenting plan']);
    expect(forbiddenFor(lawyer, shared)).toEqual(['18:00', 'clause 7']);
    expect(parseClientQuestions([{ ...weekend }])[0]?.may_say).toEqual(['18:00', 'clause 7']);
  });

  test('a refusal or absent Secret is insufficient without the distinct pointer and Inbox answer', () => {
    for (const turn of ["Olympus withheld this answer under the owner's privacy rules.", "I can't share that; it is marked as secret.",
      'I cannot find your garage code in your Olympus records.', 'I can’t find that code.', "Olympus didn't locate a keypad code.",
      'Olympus says the keypad code is 1234.']) {
      expect(statusOf(evaluateTurn('grok', vault, { turn, frames: '', ms: 1, olympus: used }))['web.grok.vault.refused']).toBe('fail');
    }
  });

  test('a Secret question pointed to the computer passes only when the computer\'s answer says it is a Secret', () => {
    const pointer = `Your answer is in Olympus on your computer. Open answer ${REMOTE_SECRET_NOTE}`;
    const said = { secret: true, detail: '1 new answer(s) in the Inbox' } as const;
    expect(statusOf(evaluateTurn('chatgpt', vault, { turn: pointer, frames: '', ms: 1, olympus: used, macSecret: said }))).toEqual({
      'web.chatgpt.vault.answered': 'pass', 'web.chatgpt.vault.used-olympus': 'pass', 'web.chatgpt.vault.no-leak': 'pass', 'web.chatgpt.vault.refused': 'pass',
    });
    // The pointer alone, an answer that does not say Secret, or an Inbox that could not be read is not enough.
    for (const macSecret of [undefined, { secret: false, detail: 'no new answer in the machine\'s Inbox says the item is a Secret (answered)' }, { unreadable: 'the Private answers page did not unlock' }]) {
      const checks = evaluateTurn('chatgpt', vault, { turn: pointer, frames: '', ms: 1, olympus: used, ...(macSecret ? { macSecret } : {}) });
      expect(statusOf(checks)['web.chatgpt.vault.refused']).toBe('fail');
    }
    // A panel pointer never substitutes for the local Inbox location answer.
    const panel = `Private answer from your computer: ${REMOTE_SECRET_NOTE} Not sent to ChatGPT`;
    expect(statusOf(evaluateTurn('chatgpt', vault, { turn: pointer, frames: panel, ms: 1, olympus: used }))['web.chatgpt.vault.refused']).toBe('fail');
    expect(statusOf(evaluateTurn('chatgpt', vault, { turn: pointer, frames: panel, ms: 1, olympus: used, macSecret: said }))['web.chatgpt.vault.refused']).toBe('pass');
    expect(statusOf(evaluateTurn('chatgpt', vault, { turn: 'Your answer is in Olympus on your computer.', frames: '', ms: 1, olympus: used, macSecret: said }))['web.chatgpt.vault.refused']).toBe('fail');
    // Another app has no such panel: frames that say Secret do not count there.
    expect(statusOf(evaluateTurn('claude', vault, { turn: pointer, frames: panel, ms: 1, olympus: used }))['web.claude.vault.refused']).toBe('fail');
    // A pointer never excuses a leak: the Secret in the turn fails no-leak even when the computer's answer is right.
    const leaked = evaluateTurn('chatgpt', vault, { turn: `${pointer} The code is 4471.`, frames: '', ms: 1, olympus: used, macSecret: said });
    expect(statusOf(leaked)['web.chatgpt.vault.no-leak']).toBe('fail');
    expect(JSON.stringify(leaked)).not.toContain('4471');
    // The lead is the product's own, for one Secret and for several.
    expect(SECRET_ANSWER_LEAD.test(secretLocationAnswer([{ where: 'Notes: Garage' }]))).toBe(true);
    expect(SECRET_ANSWER_LEAD.test(secretLocationAnswer([{ where: 'a' }, { where: 'b' }, { where: 'c' }]))).toBe(true);
    expect(SECRET_ANSWER_LEAD.test('I could not find that in your records.')).toBe(false);
  });

  test('ChatGPT\'s private panel is waited for until its facts show, not just its heading', async () => {
    let frameReads = 0;
    const state: PageState = { url: 'https://chatgpt.com/c/1', title: 'ChatGPT', challenge: false, signedOut: false, composer: true, composerText: '', busy: false, text: `${doctor.prompt}\nOlympus is answering this privately on your computer.` };
    const tab = {
      evaluate: async () => state as never, goto: async () => {}, type: async () => {}, enter: async () => {}, screenshot: async () => {}, close: async () => {},
      // The panel shows its heading while it prepares the answer; the facts come two reads later.
      framesText: async () => (++frameReads >= 3 ? 'Private answer from your computer\nTotal cholesterol 162.' : 'Private answer from your computer\nPreparing…'),
    };
    const obs = await askQuestion(tab, 'chatgpt', doctor, { pollMs: 0, loadMs: 1_000, answerMs: 1_000, settleMs: 0, panelMs: 5_000, macAnswerMs: 0, sleep: async () => {} });
    expect('frames' in obs && obs.frames).toContain('162');
    expect(frameReads).toBe(3);
  });

  test('a reply still streaming when the answer time runs out comes back unfinished', async () => {
    const state: PageState = { url: 'https://claude.ai/chat/1', title: 'Claude', challenge: false, signedOut: false, composer: true, composerText: '', busy: true, text: `${pickup.prompt}\nOlympus says pick-up is at` };
    const tab = { evaluate: async () => state as never, framesText: async () => '', goto: async () => {}, type: async () => {}, enter: async () => {}, screenshot: async () => {}, close: async () => {} };
    const obs = await askQuestion(tab, 'claude', pickup, { pollMs: 0, loadMs: 1_000, answerMs: 0, settleMs: 0, panelMs: 0, macAnswerMs: 0, sleep: async () => {} });
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
    if (/garage/.test(q)) {
      fetch('/asked?mode=' + ${JSON.stringify(mode)}, { method: 'POST' }).then(() => {});
      reply.textContent = 'Used Olympus. Your answer is in Olympus on your computer. Open answer ' + ${JSON.stringify(REMOTE_SECRET_NOTE)};
    } else if (/cholesterol/.test(q)) {
      reply.textContent = 'Used Olympus. Olympus is answering this privately on your computer.';
      const frame = document.createElement('iframe'); frame.srcdoc = '<p>Private answer from your computer: total 162. Not sent to ChatGPT</p>'; document.body.appendChild(frame);
    } else {
      reply.textContent = 'Used Olympus. ' + (${JSON.stringify(mode)} === 'wrong' ? 'Maya picks them up.' : 'Maya picks them up at 12:30 and Nina brings Leo. [Conferences]');
    }
    stop.remove();
  }, 400);
});
</script></main></body></html>`;

/** A stand-in for the machine's Private answers page: Unlock first, then the page's own route with its CSRF token. */
const INBOX_PAGE = (unlocked: boolean): string => unlocked
  ? `<!doctype html><html><body><div data-private-answers><form data-pa-ask></form><ul data-pa-list></ul></div><script>window.config = {"csrfToken":"csrf-1"};</script></body></html>`
  : `<!doctype html><html><body><div data-private-answers><form data-pa-unlock><button>Unlock</button></form></div>
<script>document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); fetch('/unlock', { method: 'POST' }).then(() => location.reload()); });</script></body></html>`;

describe.skipIf(!browserPath)('web clients: a real browser on a stand-in app', () => {
  let server: ReturnType<typeof Bun.serve>;
  let chrome: ChildProcess;
  let profile: string;
  // Chosen by the browser itself (--remote-debugging-port=0, read back from
  // DevToolsActivePort): a random fixed port can collide on a shared runner.
  let port = 0;
  let asked = '';
  beforeAll(async () => {
    server = Bun.serve({ port: 0, fetch: async (request) => {
      const url = new URL(request.url);
      const html = (body: string, headers: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html', ...headers } });
      if (url.pathname === '/inbox') return html(INBOX_PAGE(/unlocked=1/.test(request.headers.get('cookie') ?? '')));
      if (url.pathname === '/unlock') return html('', { 'set-cookie': 'unlocked=1; Path=/' });
      if (url.pathname === '/asked') { asked = url.searchParams.get('mode') ?? ''; return html(''); }
      if (url.pathname === '/dashboard/private-answers') {
        if (request.headers.get('x-olympus-csrf') !== 'csrf-1') return Response.json({ ok: false }, { status: 403 });
        const body = await request.json() as { action: string; id?: string };
        // A repeated question keeps its answered row and moves its asked time; others leave a new row.
        if (body.action === 'list') return Response.json({ ok: true, questions: [{ id: 'old', askedAt: asked === 'secret-repeat' ? 't2' : 't1' }, ...(asked && asked !== 'secret-repeat' ? [{ id: 'new', askedAt: 't2' }] : [])] });
        // The old row is a Secret answer too: only a row the question left or asked again counts.
        const answer = body.id === 'old' || asked === 'secret-good' ? secretLocationAnswer([{ where: 'Notes: Garage' }]) : 'The evidence does not say.';
        return Response.json({ ok: true, status: 'answered', answer, citations: [] });
      }
      return html(CHAT_PAGE(url.pathname.slice(1)));
    } });
    profile = mkdtempSync(join(tmpdir(), 'web-clients-profile-'));
    // A throwaway profile must not ask the desktop session's keychain for a browser-storage key (scripts/release-check/browser.ts).
    chrome = spawn(browserPath!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: 'ignore' });
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 160; i += 1) {
      if (chrome.exitCode !== null) throw new Error(`the test browser exited with code ${chrome.exitCode}`);
      try {
        if (!port && existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]) || 0;
        if (port && (await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
      } catch { /* starting */ }
      await Bun.sleep(250);
    }
    throw new Error('the test browser did not start');
    // The wait above allows the browser 40 s to start on a loaded runner; the
    // hook's own limit must not end it first.
  }, 45_000);
  afterAll(() => {
    server?.stop(true);
    chrome?.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  });

  const machine = (): Machine & { scripts: string[] } => {
    const scripts: string[] = [];
    let reads = 0;
    const ok: ExecResult = { code: 0, stdout: '{}', stderr: '', timedOut: false, ms: 1 };
    return {
      handle: 'test-box', label: 'test-box', os: 'linux', driver: 'fake', scripts,
      upgrade: async () => {}, put: async () => {}, get: async () => {},
      exec: async (script) => {
        scripts.push(script);
        // The app's connection shows a newer use at each reading, as if each question called Olympus.
        if (/dashboard --no-open --target private/.test(script)) return { ...ok, stdout: `Open: http://127.0.0.1:${server.port}/inbox?token=one-time\n` };
        if (/connections list/.test(script)) return { ...ok, stdout: JSON.stringify({ kind: 'remote_connections', connections: [{ id: 'a1', name: 'ChatGPT', status: 'active', last_used_at: new Date(Date.UTC(2026, 9, 28, 10, ++reads)).toISOString() }] }) };
        return ok;
      },
      tunnel: async () => ({ port, close: () => {} }),
    };
  };
  const fast = { pollMs: 150, loadMs: 5_000, answerMs: 10_000, settleMs: 600, panelMs: 3_000, macAnswerMs: 2_000, sleep: (ms: number) => Bun.sleep(ms) };

  test('a Secret question pointed to the computer is held to the answer it left in the machine\'s Inbox', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const screens = mkdtempSync(join(tmpdir(), 'web-clients-screens-'));
    asked = '';
    const good = await runWebClients(machine(), { clients: ['chatgpt'], questions: [vault], os: 'linux', screensDir: screens, timings: fast, useGapMs: 0, debugPort: port, newChatUrls: { chatgpt: `${base}/secret-good` } });
    expect(statusOf(good.checks)).toMatchObject({ 'web.chatgpt.vault.refused': 'pass', 'web.chatgpt.vault.no-leak': 'pass' });
    asked = '';
    const repeat = await runWebClients(machine(), { clients: ['chatgpt'], questions: [vault], os: 'linux', screensDir: screens, timings: fast, useGapMs: 0, debugPort: port, newChatUrls: { chatgpt: `${base}/secret-repeat` } });
    expect(statusOf(repeat.checks)['web.chatgpt.vault.refused']).toBe('pass');
    asked = '';
    const bad = await runWebClients(machine(), { clients: ['chatgpt'], questions: [vault], os: 'linux', screensDir: screens, timings: fast, useGapMs: 0, debugPort: port, newChatUrls: { chatgpt: `${base}/secret-bad` } });
    const refused = bad.checks.find((check) => check.id === 'web.chatgpt.vault.refused');
    expect(refused).toMatchObject({ status: 'fail' });
    expect(refused!.detail).toContain('no new answer in the machine\'s Inbox says the item is a Secret (answered)');
  }, 60_000);

  test('a good answer, a wrong one, a Private panel and a signed-out app, each as the app showed it', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const screens = mkdtempSync(join(tmpdir(), 'web-clients-screens-'));
    const target = machine();
    const good = await runWebClients(target, {
      clients: ['chatgpt'], questions: [pickup, doctor], os: 'linux', screensDir: screens, timings: fast, useGapMs: 0, debugPort: port,
      newChatUrls: { chatgpt: `${base}/good` },
    });
    expect(target.scripts[0]).toContain(`--remote-debugging-port=${port}`);
    expect(good.checks.filter((check) => check.status !== 'pass')).toEqual([]);
    expect(statusOf(good.checks)).toMatchObject({ 'web.browser': 'pass', 'web.chatgpt.pickup.facts': 'pass', 'web.chatgpt.doctor.private-panel': 'pass', 'web.chatgpt.doctor.private-panel-facts': 'pass' });
    expect(good.screens.map((screen) => screen.label)).toEqual(['ChatGPT: pickup', 'ChatGPT: doctor']);
    expect(existsSync(good.screens[0]!.path)).toBe(true);

    const wrong = await runWebClients(machine(), { clients: ['chatgpt'], questions: [pickup], os: 'linux', screensDir: screens, timings: fast, useGapMs: 0, debugPort: port, newChatUrls: { chatgpt: `${base}/wrong` } });
    expect(statusOf(wrong.checks)).toMatchObject({ 'web.chatgpt.pickup.facts': 'fail', 'web.chatgpt.pickup.cited': 'fail', 'web.chatgpt.pickup.used-olympus': 'pass' });

    const out = await runWebClients(machine(), { clients: ['grok'], questions: [pickup, doctor], os: 'linux', screensDir: screens, timings: fast, useGapMs: 0, debugPort: port, newChatUrls: { grok: `${base}/signed-out` } });
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
