import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCanaryAccounts } from '../scripts/release-check/canary.ts';
import {
  askQuestion, checkClaudeDashboard, checkClaudePrivacy, clientAdapter, dashboardFrameFound,
  evaluateClaudeHidden, evaluateClaudePanelHidden, evaluateClaudeTools, evaluateTurn, EXPAND_PANEL_SCRIPT, openTab, clickIn, runWebClients,
  CLAUDE_HIDDEN_PROMPT, CLAUDE_DASHBOARD_PROMPT, CLAUDE_TOOLS_PROMPT, type AppFrame, type AskTimings, type BrowserSession, type ClientQuestion,
  type PageState, type Tab, type TurnObservation,
} from '../scripts/release-check/web-clients.ts';
import { chatgptPrivacyProgram, CHATGPT_PRIVACY_TOOLS, CHATGPT_PRIVACY_META_KEY, CHATGPT_PRIVACY_FOLDER_SOURCES } from '../src/workers/dashboard/chatgpt/privacy.ts';
import { privacyLogic } from '../src/workers/dashboard/shared-privacy-logic.ts';
import { privacyToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { DASHBOARD_CHATGPT_PRIVACY_COPY as W } from '../src/workers/dashboard/vocabulary.ts';
import { REMOTE_SECRET_NOTE } from '../src/core/remote-result.ts';
import type { PrivacyRuleView } from '../src/workers/chatgpt/dashboard-contract.ts';
import type { CheckResult } from '../scripts/release-check/report.ts';
import type { Machine } from '../scripts/release-check/machine.ts';
import { createTestClock } from './helpers/test-clock.ts';

const privateQ: ClientQuestion = { id: 'private', prompt: 'Use Olympus to find my appointment.', kind: 'private', forbid: ['doctor-id-713'], panel_expect: ['Tuesday clinic'] };
const secretQ: ClientQuestion = { id: 'secret', prompt: 'Use Olympus to find my password.', kind: 'secret', forbid: ['secret-891'] };
const used = { used: true, detail: 'a connection was used' } as const;
const observation = (turn = 'Olympus answered privately on your computer.', frames = ''): TurnObservation => ({ turn, frames, ms: 1, olympus: used });
const instant: AskTimings = { pollMs: 0, loadMs: 0, answerMs: 0, settleMs: 0, panelMs: 0, macAnswerMs: 0, sleep: async () => {} };
const statuses = (checks: CheckResult[]) => Object.fromEntries(checks.map((check) => [check.id, check.status]));
const windows: Window[] = [];
afterEach(async () => { for (const win of windows.splice(0)) await win.happyDOM.close(); });

function chatTab(text: string, frameTexts: string[] = []): Tab & { visits: string[]; typed: string[]; expanded: () => boolean } {
  let expanded = false;
  const visits: string[] = [], typed: string[] = [];
  const state: PageState = { url: 'https://claude.ai/chat/fixture', title: 'Claude', composer: true, composerText: '', signedOut: false, challenge: false, busy: false, text };
  return {
    visits, typed, expanded: () => expanded,
    evaluate: async <T>(expression: string) => {
      if (expression === EXPAND_PANEL_SCRIPT) { expanded = true; return 1 as T; }
      return state as T;
    },
    framesText: async () => expanded ? frameTexts.at(-1) ?? '' : frameTexts[0] ?? '',
    goto: async (url) => { visits.push(url); }, type: async (prompt) => { typed.push(prompt); },
    enter: async () => {}, screenshot: async () => {}, close: async () => {},
  };
}

/** Mount the actual source privacy program, with an in-memory settings tool and real DOM events. */
function privacyFrame(options: { missingConfirmation?: boolean; failAddition?: boolean } = {}) {
  const clock = createTestClock();
  const timings: AskTimings = { ...instant, now: clock.now, sleep: (ms) => clock.advance(ms), pollMs: 50, panelMs: 1_000 };
  const win = new Window({ url: 'https://app.claudemcpcontent.com/' }); windows.push(win);
  const doc = win.document;
  const original: PrivacyRuleView[] = [{ kind: 'sender', source_id: 'gmail.email', value: 'keep@existing.invalid' }];
  let saved = structuredClone(original), revision = 1;
  const calls: Array<{ args: any; before: PrivacyRuleView[] }> = [];
  const root = doc.createElement('div'); doc.body.append(root);
  let privacy: ReturnType<typeof chatgptPrivacyProgram>;
  const button = (label: string, key: string, onClick: (() => void) | null) => {
    const el = doc.createElement('button'); el.textContent = label; el.setAttribute('data-key', key);
    // happy-dom has no layout. Keep the canary's visibility check active on fixture controls.
    el.getClientRects = () => [new win.DOMRect(0, 0, 100, 20)] as any;
    el.disabled = !onClick; if (onClick) el.addEventListener('click', onClick); return el as unknown as HTMLButtonElement;
  };
  const render = () => {
    root.replaceChildren(privacy.view() as any);
    if (options.missingConfirmation) root.querySelector('[data-key="privacy:confirm:yes"]')?.closest('[role="alert"]')?.querySelector('p')?.remove();
  };
  const dashboard = () => { root.replaceChildren(button('Edit', 'privacy:edit', () => privacy.start('privacy:edit')) as any); };
  const program: typeof chatgptPrivacyProgram = new Function('setTimeout', 'clearTimeout', `return (${chatgptPrivacyProgram.toString()})`)(clock.setTimeout, clock.clearTimeout);
  privacy = program({
    config: { tools: CHATGPT_PRIVACY_TOOLS, metaKey: CHATGPT_PRIVACY_META_KEY, scopeList: 'olympus_scope_list', scopeMetaKey: 'scope', mailSourceId: 'gmail.email', folderSources: CHATGPT_PRIVACY_FOLDER_SOURCES, copy: W },
    el: (tag, cls, text) => { const el = doc.createElement(tag); el.className = cls ?? ''; el.textContent = text ?? ''; return el as any; },
    add: (parent, ...children) => { for (const child of children) if (child) parent.append(child); return parent; },
    button, fill: (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key])), count: String,
    call: async (name, args) => {
      if (name === CHATGPT_PRIVACY_TOOLS.questions) return { _meta: { [CHATGPT_PRIVACY_META_KEY]: { fallback: true, questions: [] } } };
      if (name === CHATGPT_PRIVACY_TOOLS.set) {
        calls.push({ args: structuredClone(args), before: structuredClone(saved) });
        if (options.failAddition && args.rules.length > saved.length) return { isError: true };
        saved = structuredClone(args.rules); revision++;
      }
      return privacyToolResult({ configured: true, description: '', rules: saved, pendingCount: 0, revision: String(revision) }, name === CHATGPT_PRIVACY_TOOLS.set ? 'saved' : 'current', 'test-confirmation');
    },
    render, compact: () => false, fullscreen: () => {}, data: () => ({ sources: [] }), picker: null, remember: () => {}, close: dashboard,
  }, privacyLogic);
  dashboard();
  const frame: AppFrame = { evaluate: async <T>(expression: string) => new Function('document', 'Event', `return ${expression}`)(doc, win.Event) as T };
  return { frame, timings, saved: () => saved, original, calls, options };
}

describe('Claude MCP App canary', () => {
  test('accounts validate an optional boolean without changing existing accounts', () => {
    const raw = { clients: ['claude'], questions: 'questions.json' };
    const parse = (extra: object) => parseCanaryAccounts({ ...raw, ...extra }, () => [privateQ]);
    // The switch is on by default (#1266), so a file that leaves it out expects the dashboard checks.
    expect(parse({}).claude_app).toBe(true);
    expect(parse({ claude_app: true }).claude_app).toBe(true);
    expect(parse({ claude_app: false }).claude_app).toBe(false);
    for (const value of ['on', 'false', 1, null, {}]) expect(() => parse({ claude_app: value })).toThrow('claude_app must be true or false');
  });

  test('the CLI rejects malformed overrides and requires accounts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-canary-cli-'));
    try {
      const config = join(dir, 'config.json'); writeFileSync(config, JSON.stringify({ driver: ['false'] }));
      const accounts = join(dir, 'accounts.json'); writeFileSync(accounts, JSON.stringify({ clients: ['claude'], questions: 'q.json' }));
      writeFileSync(join(dir, 'q.json'), JSON.stringify([privateQ]));
      for (const args of [['--claude-app', 'yes', '--accounts', accounts], ['--claude-app', 'on'], ['--accounts', accounts, '--claude-app']]) {
        const proc = Bun.spawn([process.execPath, 'scripts/release-check/canary.ts', '--config', config, '--machine', 'fixture', '--os', 'linux', '--out', dir, ...args], { stdout: 'pipe', stderr: 'pipe' });
        const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        expect(code).toBe(2); expect(err).toContain('--claude-app requires --accounts and on or off');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);

  test.each([true, false])('switch on: a Private panel present=%s is checked, including panel_expect', async (present) => {
    const tab = chatTab(`${privateQ.prompt}\nOlympus answered privately on your computer.`, present ? ['', 'Not sent to Claude\nTuesday clinic'] : []);
    const obs = await askQuestion(tab, 'claude', privateQ, instant, undefined, { claudeApp: true });
    const checks = statuses(evaluateTurn('claude', privateQ, obs, [], true));
    expect(checks['web.claude.private.private-panel']).toBe(present ? 'pass' : 'fail');
    if (present) expect(checks['web.claude.private.private-panel-facts']).toBe('pass');
    expect(tab.expanded()).toBe(true);
    expect(clientAdapter('claude').privatePanel).toBeUndefined();
    expect(evaluateTurn('claude', privateQ, obs).some((check) => check.id.endsWith('private-panel'))).toBe(false);
  });

  test('a heading alone is not panel facts; missing facts fail and late facts are waited for', async () => {
    const clock = createTestClock();
    let reads = 0;
    const tab = chatTab(`${privateQ.prompt}\nAnswer privately on your computer.`);
    tab.framesText = async () => ++reads >= 3 ? 'Private answer from your Mac\nTuesday clinic' : 'Private answer from your Mac\nPreparing…';
    const pending = askQuestion(tab, 'claude', privateQ, { ...instant, now: clock.now, sleep: clock.sleep, pollMs: 1, panelMs: 10 }, undefined, { claudeApp: true });
    await clock.advance(30);
    const obs = await pending;
    expect(reads).toBe(3);
    expect(statuses(evaluateTurn('claude', privateQ, obs, [], true))['web.claude.private.private-panel-facts']).toBe('pass');
    expect(statuses(evaluateTurn('claude', privateQ, observation(undefined, 'Not sent to Claude\nPreparing…'), [], true))['web.claude.private.private-panel-facts']).toBe('fail');
  });

  test('Secret panel waits use the adapter and the fixed Secret pointer', async () => {
    const tab = chatTab(`${secretQ.prompt}\n${REMOTE_SECRET_NOTE}`, ['', `Not sent to Claude\n${REMOTE_SECRET_NOTE}`]);
    const obs = await askQuestion(tab, 'claude', secretQ, instant, undefined, { claudeApp: true });
    expect(tab.expanded()).toBe(true);
    expect('frames' in obs && obs.frames).toContain(REMOTE_SECRET_NOTE);
  });

  test('the hidden-values follow-up stays in the same chat and captures only that turn', async () => {
    const tab = chatTab(`${privateQ.prompt}\nEarlier reply.\n${CLAUDE_HIDDEN_PROMPT}\nI received no hidden values.`);
    const obs = await askQuestion(tab, 'claude', { ...privateQ, kind: 'personal', prompt: CLAUDE_HIDDEN_PROMPT }, instant, undefined, { claudeApp: true, continueChat: true });
    expect(tab.visits).toEqual([]); expect(tab.typed).toEqual([CLAUDE_HIDDEN_PROMPT]);
    expect('turn' in obs && obs.turn.trim()).toBe('I received no hidden values.');
  });

  test('hidden-values ignores everyday panel words and partial matches in a clean reply (#1319)', () => {
    const panelQ: ClientQuestion = { ...privateQ, forbid: ['doctor-id-713', 'Ana Reyes'], panel_expect: ['20', '14', 'Ana', 'Dropbox'] };
    const clean = 'I received no hidden values. Your Dropbox note from 2014-11-20 says the pickup moved [E14]. Anaïs and Banana agreed.';
    expect(evaluateClaudeHidden(panelQ, observation(clean), [panelQ, secretQ]).status).toBe('pass');
    // A real hidden value still fails, as a whole phrase in any case or spacing.
    expect(evaluateClaudeHidden(panelQ, observation('The panel said: ana  REYES.'), [panelQ, secretQ]).status).toBe('fail');
    expect(evaluateClaudeHidden(panelQ, observation('(doctor-id-713)'), [panelQ, secretQ]).status).toBe('fail');
  });

  test.each(['doctor-id-713', 'secret-891'])('hidden-values leakage fails without repeating the leaked value (%s)', (value) => {
    const result = evaluateClaudeHidden(privateQ, observation(`Here is ${value}`), [privateQ, secretQ]);
    expect(result.status).toBe('fail'); expect(JSON.stringify(result)).not.toContain(value);
    expect(evaluateClaudeHidden(privateQ, observation('I received no hidden values.'), [privateQ, secretQ]).status).toBe('pass');
  });

  test('the hidden-values probe holds every question\'s forbidden strings, not just its own (Codex review on #1310)', () => {
    const otherPrivate: ClientQuestion = { id: 'other', prompt: 'Use Olympus to find my diagnosis.', kind: 'private', forbid: ['diagnosis-552'] };
    expect(evaluateClaudeHidden(privateQ, observation('Here is diagnosis-552'), [privateQ, otherPrivate, secretQ]).status).toBe('fail');
    // A string this question may say, because an item it reads says it too, still passes.
    const sharing: ClientQuestion = { ...privateQ, may_say: ['diagnosis-552'] };
    expect(evaluateClaudeHidden(sharing, observation('Here is diagnosis-552'), [sharing, otherPrivate, secretQ]).status).toBe('pass');
  });

  test.each(['olympus_dashboard', 'open_private_question'])('switch off fails if %s is named, even without verified use', (name) => {
    expect(evaluateClaudeTools(observation(`source_answer\n${name}`)).status).toBe('fail');
    expect(evaluateClaudeTools({ ...observation(name), olympus: { used: false, detail: 'unchanged' } }).status).toBe('fail');
  });

  test('switch off requires an exact answer-tool name and verified Olympus use', () => {
    expect(evaluateClaudeTools(observation('source_answer\nsource_answer_result')).status).toBe('pass');
    expect(evaluateClaudeTools(observation('source_answering')).status).toBe('fail');
    expect(evaluateClaudeTools({ ...observation('source_answer'), olympus: { used: false, detail: 'unchanged' } }).status).toBe('skip');
    expect(evaluateClaudeTools({ ...observation('source_answer'), olympus: { unreadable: 'offline' } }).status).toBe('skip');
  });

  test('dashboard proof needs the App\'s title and Sources section in one frame', async () => {
    expect(dashboardFrameFound(['Olympus\nSources\nNo sources connected yet.'])).toBe(true);
    expect(dashboardFrameFound(['Olympus', 'Sources'])).toBe(false);
    expect(dashboardFrameFound(['Olympus\nModels'])).toBe(false);
    for (const present of [true, false]) {
      const checks: CheckResult[] = [];
      const tab = chatTab('Olympus\nSources'); // Host text cannot substitute for a frame.
      tab.appFrames = async () => present ? [{ evaluate: async <T>(expression: string) => (expression.includes('innerText') ? 'Olympus\nSources' : false) as T }] : [];
      await checkClaudeDashboard(tab, observation(), instant, async (check) => { checks.push(check); });
      expect(statuses(checks)['web.claude.dashboard']).toBe(present ? 'pass' : 'fail');
    }
  });

  test('app-only values the panel saw fail the dashboard hidden-values check only as whole words', () => {
    const sender = 'olympus-canary-1b2c3d4e-0000-4000-8000-000000000000@example.invalid';
    expect(evaluateClaudePanelHidden(observation('I only saw the dashboard summary: Olympus is ready.'), [sender]).status).toBe('pass');
    expect(evaluateClaudePanelHidden(observation(`The panel listed a rule for ${sender}.`), [sender]).status).toBe('fail');
    expect(evaluateClaudePanelHidden(observation('Keep my legal folder private, a description.'), ['Keep my legal folder private']).status).toBe('fail');
    expect(evaluateClaudePanelHidden({ inconclusive: 'Claude is signed out' }, [sender]).status).toBe('skip');
  });

  test('renewal, sign-out and bot checks remain inconclusive for the new probes', async () => {
    for (const obs of [{ inconclusive: 'Claude showed a bot check' }, { inconclusive: 'Claude is signed out' }, observation('Please reconnect Olympus.')]) {
      expect(evaluateClaudeTools(obs).status).toBe('skip');
      expect(evaluateClaudeHidden(privateQ, obs, [secretQ]).status).toBe('skip');
      const checks: CheckResult[] = [];
      await checkClaudeDashboard(chatTab(''), obs, instant, async (check) => { checks.push(check); });
      expect(checks.map((check) => check.status)).toEqual(['skip']);
    }
    expect(evaluateClaudeHidden(privateQ, observation('Reconnect Olympus. doctor-id-713'), [secretQ]).status).toBe('fail');
  });

  test('privacy raising applies without confirmation, lowering asks, cancel retains it, and cleanup restores existing rules', async () => {
    const host = privacyFrame(); const checks: CheckResult[] = [];
    const panelOnly = await checkClaudePrivacy(host.frame, host.timings, async (check) => { checks.push(check); });
    // The run's own temporary sender is always a panel-only value for the hidden-values probe.
    expect(panelOnly.some((value) => /^olympus-canary-[0-9a-f-]{36}@example\.invalid$/.test(value))).toBe(true);
    expect(statuses(checks)).toEqual({ 'web.claude.privacy.raising': 'pass', 'web.claude.privacy.lowering': 'pass', 'web.claude.privacy.cancel': 'pass', 'web.claude.privacy.undo': 'pass' });
    expect(host.saved()).toEqual(host.original);
    expect(host.calls).toHaveLength(2); // Addition and final undo. Cancel never writes.
    expect(host.calls[0]!.args.confirmation).toBeUndefined();
    expect(host.calls[1]!.args.confirmation).toBe('test-confirmation');
    expect(host.calls[1]!.args.rules).toEqual(host.original);
  });

  test('a lowering control without its fixed confirmation fails; cleanup still restores the rules', async () => {
    const host = privacyFrame({ missingConfirmation: true }); const checks: CheckResult[] = [];
    await checkClaudePrivacy(host.frame, host.timings, async (check) => {
      checks.push(check);
      if (check.id === 'web.claude.privacy.lowering') host.options.missingConfirmation = false;
    });
    expect(statuses(checks)['web.claude.privacy.lowering']).toBe('fail');
    expect(statuses(checks)['web.claude.privacy.undo']).toBe('pass');
    expect(host.saved()).toEqual(host.original);
  });

  test('an optimistic rule that did not save never passes the raising check', async () => {
    const host = privacyFrame({ failAddition: true }); const checks: CheckResult[] = [];
    await checkClaudePrivacy(host.frame, host.timings, async (check) => { checks.push(check); });
    expect(statuses(checks)['web.claude.privacy.raising']).toBe('fail');
    expect(statuses(checks)['web.claude.privacy.undo']).toBe('pass');
    expect(host.saved()).toEqual(host.original);
  });

  test('DevTools reads and clicks in frame execution contexts, excludes the host, and drops detached frames', async () => {
    const handlers = new Map<string, (params: any, session?: string) => void>();
    const evaluations: Array<{ session: string | undefined; context: unknown }> = [];
    const emit = (name: string, params: any, session?: string) => handlers.get(name)?.(params, session);
    const browser: BrowserSession = {
      on: (name, handler) => { handlers.set(name, handler); }, close: () => {},
      send: async (method, params = {}, session) => {
        if (method === 'Target.createTarget') return { targetId: 'tab' };
        if (method === 'Target.attachToTarget') return { sessionId: 'host' };
        if (method === 'Runtime.enable') {
          emit('Runtime.executionContextCreated', { context: { id: session === 'host' ? 1 : 3, auxData: { isDefault: true } } }, session);
          // A same-process frame shares the host's session, with its own default context.
          if (session === 'host') emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: true } } }, session);
        }
        if (method === 'Runtime.evaluate') {
          evaluations.push({ session, context: params.contextId });
          if (params.expression === 'window !== window.top') return { result: { value: params.contextId !== 1 } };
          return { result: { value: params.expression === 'document.body?.innerText || ""' ? 'Olympus\nSources' : true } };
        }
        return {};
      },
    };
    const tab = await openTab(browser);
    emit('Target.attachedToTarget', { sessionId: 'cross-origin' }, 'host');
    const frames = await tab.appFrames!();
    expect(frames).toHaveLength(2);
    evaluations.length = 0;
    expect(await clickIn(frames[0]!, '[data-key="privacy:edit"]')).toBe(true);
    expect(await clickIn(frames[1]!, '[data-key="privacy:edit"]')).toBe(true);
    expect(evaluations).toEqual([{ session: 'host', context: 2 }, { session: 'cross-origin', context: 3 }]);
    emit('Target.detachedFromTarget', { sessionId: 'cross-origin' });
    expect(await tab.appFrames!()).toHaveLength(1);
    emit('Runtime.executionContextsCleared', {}, 'host');
    expect(await tab.appFrames!()).toHaveLength(0);
    await tab.close();
  });


  test('the runner honors omitted/on/off, keeps the hidden probe in its chat, and pictures every extra check', async () => {
    for (const mode of [undefined, true, false]) {
      const host = privacyFrame();
      let text = '', prompt = '', phase = '', attach = false, uses = 0;
      const visits: string[] = [], prompts: string[] = [];
      const server = Bun.serve({
        port: 0,
        fetch(request, server) {
          if (new URL(request.url).pathname === '/ws') { server.upgrade(request); return undefined; }
          return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/ws` });
        },
        websocket: {
          async message(ws, raw) {
            const message = JSON.parse(String(raw));
            const { method, params = {}, sessionId } = message;
            const event = (method: string, params: unknown, sessionId: string) => ws.send(JSON.stringify({ method, params, sessionId }));
            let result: any = {};
            if (method === 'Target.createTarget') result = { targetId: 'tab' };
            if (method === 'Target.attachToTarget') result = { sessionId: 'host' };
            if (method === 'Runtime.enable') event('Runtime.executionContextCreated', { context: { id: sessionId === 'host' ? 1 : 2, auxData: { isDefault: true } } }, sessionId);
            if (method === 'Target.setAutoAttach' && sessionId === 'host' && !attach) { attach = true; event('Target.attachedToTarget', { sessionId: 'app' }, 'host'); }
            if (method === 'Page.navigate') { visits.push(params.url); text = ''; phase = ''; }
            if (method === 'Input.insertText') prompt = params.text;
            if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown') {
              prompts.push(prompt);
              phase = prompt === CLAUDE_DASHBOARD_PROMPT ? 'dashboard' : prompt === CLAUDE_HIDDEN_PROMPT ? 'hidden' : 'answer';
              text += `\n${prompt}\n${prompt === CLAUDE_TOOLS_PROMPT ? 'source_answer' : phase === 'hidden' ? 'I received no hidden values.' : phase === 'dashboard' ? 'Olympus dashboard opened.' : 'Olympus answered privately on your computer.'}`;
            }
            if (method === 'Page.captureScreenshot') result = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=' };
            if (method === 'Runtime.evaluate') {
              const expression: string = params.expression;
              let value: unknown;
              if (expression === 'window !== window.top') value = sessionId !== 'host';
              else if (sessionId === 'app') {
                if (phase === 'dashboard') value = expression === 'document.body?.innerText || ""'
                  ? `Olympus\nSources\n${await host.frame.evaluate(expression)}` : await host.frame.evaluate(expression);
                else value = mode && phase === 'answer' ? 'Not sent to Claude\nTuesday clinic' : '';
              } else if (expression.includes('challenge:')) value = { url: 'https://claude.ai/chat/fixture', title: 'Claude', challenge: false, signedOut: false, composer: true, composerText: '', busy: false, text };
              else if (expression.includes("querySelectorAll('iframe')")) value = mode && phase === 'answer' ? 'Not sent to Claude\nTuesday clinic' : '';
              else value = true;
              result = { result: { value } };
            }
            ws.send(JSON.stringify({ id: message.id, result }));
          },
        },
      });
      const screensDir = mkdtempSync(join(tmpdir(), 'claude-canary-screens-'));
      const machine: Machine = {
        handle: 'fixture', label: 'fixture', os: 'linux', driver: 'fixture',
        put: async () => {}, get: async () => {}, upgrade: async () => {},
        tunnel: async () => ({ port: server.port!, close: () => {} }),
        exec: async (script) => ({ code: 0, stderr: '', timedOut: false, ms: 0, stdout: script.includes('connections list')
          ? JSON.stringify({ connections: [{ id: 'claude', name: 'Claude', status: 'active', last_used_at: String(++uses) }] }) : '{}' }),
      };
      try {
        const result = await runWebClients(machine, { clients: ['claude'], questions: [privateQ], os: 'linux', screensDir,
          timings: host.timings, useGapMs: 0, ...(mode !== undefined ? { claudeApp: mode } : {}) });
        expect(result.checks.filter((check) => check.status !== 'pass')).toEqual([]);
        expect(result.checks.some((check) => check.id === 'web.claude.answer-tools')).toBe(mode === false);
        expect(result.checks.some((check) => check.id === 'web.claude.dashboard')).toBe(mode === true);
        if (mode) {
          // The dashboard's hidden-values probe stays in the dashboard's chat (no third visit).
          expect(prompts).toEqual([privateQ.prompt, CLAUDE_HIDDEN_PROMPT, CLAUDE_DASHBOARD_PROMPT, CLAUDE_HIDDEN_PROMPT]);
          expect(visits).toHaveLength(2);
          expect(statuses(result.checks)['web.claude.dashboard.hidden-values']).toBe('pass');
          const extras = result.checks.filter((check) => check.id === 'web.claude.dashboard' || check.id.endsWith('hidden-values') || check.id.startsWith('web.claude.privacy.'));
          expect(extras).toHaveLength(7);
          for (const check of extras) expect(result.screens.some((screen) => screen.label === check.title && existsSync(screen.path))).toBe(true);
          expect(host.saved()).toEqual(host.original);
        } else expect(prompts).toEqual(mode === false ? [CLAUDE_TOOLS_PROMPT, privateQ.prompt] : [privateQ.prompt]);
      } finally { server.stop(true); rmSync(screensDir, { recursive: true, force: true }); }
    }
  }, 20_000);

});
