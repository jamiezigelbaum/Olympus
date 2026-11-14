import { expect, test } from 'bun:test';
import { Window, type HTMLFormElement, type HTMLInputElement } from 'happy-dom';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { createPendingPrivacyPolicy, isPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { loadSovereigntyPreset, type SovereigntyPresetName } from '../src/core/sovereignty.ts';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';
import { openFreshDashboard } from '../scripts/release-check/fresh-dashboard.ts';
import type { Machine } from '../scripts/release-check/machine.ts';

const REFUSAL = 'Choose this on the computer in an unlocked dashboard.';
for (const mode of ['saves', 'loses', 'refused', 'unlock', 'saved-judge', 'judge-refused', 'judge-unreachable', 'judge-restarting', 'judge-starting'] as const) test(`first-run dashboard ${mode === 'loses' ? 'rejects a choice lost on reload' : mode === 'refused' ? 'reports the dashboard\'s own refusal' : mode === 'unlock' ? 'unlocks on this computer when asked, then saves' : 'saves the Recommended choice through its normal form before sources'}`, async () => {
  const losesSave = mode === 'loses';
  const dir = mkdtempSync(join(tmpdir(), 'fresh-dashboard-'));
  const path = join(dir, 'sovereignty.json');
  writeFileSync(path, JSON.stringify(createPendingPrivacyPolicy()));
  const policy = () => JSON.parse(readFileSync(path, 'utf8'));
  const calls: string[] = [];
  const events: string[] = [];
  let window: Window | undefined;
  let controller: { dispose(): void } | undefined;
  const evaluate = (expression: string): any => {
    const names = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS', 'getComputedStyle', 'location'] as const;
    return new Function(...names, `return ${expression}`)(...names.map(name => name === 'window' ? window : name === 'getComputedStyle' ? window!.getComputedStyle.bind(window) : name === 'location' ? window!.location : window![name]));
  };
  const host = new Window({ url: 'http://127.0.0.1:8010/' });
  const hostEvaluate = (expression: string): unknown => new Function('window', 'document', `return ${expression}`)(host, host.document);
  let unlocked = false, unlocks = 0;
  let judgeChosen = mode === 'saved-judge';
  const judgeChoices: string[] = [];
  // The engine's /dashboard.json as the page fetches it.
  let dashboardJson: { status: number; body: unknown } = { status: 200, body: { sources: [] } };
  let keysVisits = 0;
  let navigationFailures = 0;
  let loader = 0;
  const documentAt = (url: string) => {
    controller?.dispose(); window?.close();
    window = new Window({ url });
    if (!new URL(url).searchParams.has('keys')) {
      window.document.body.innerHTML = '<span class="source-name">Gmail</span>';
      return;
    }
    keysVisits++;
    if (losesSave && keysVisits === 2) writeFileSync(path, JSON.stringify(createPendingPrivacyPolicy()));
    const config = policy();
    const html = renderModelSetup(new ModelSetupService({ config, credentialState: () => 'ready', autoCheck: false }).getStatus(), { judgeSetup: { chosen: judgeChosen, cloudModel: 'deepseek-v4-flash-0731' }, judgeRuntime: { gpu: true } });
    // The Keys page as shipped: only the engine's setup status, no separate answer-mode row.
    window.document.body.innerHTML = html;
    // happy-dom marks even whole-dollar values invalid for step=.01.
    const judgeForm = window.document.querySelector<HTMLFormElement>('form[data-first-run-judge]');
    if (judgeForm) judgeForm.noValidate = true;
    // Start on a different option so the driver must select Recommended explicitly.
    const other = window.document.querySelector<HTMLInputElement>('input[value="no-sensitive"]');
    if (other) other.checked = true;
    // Every element lays out, including ones the controller adds later (the unlock button).
    window.HTMLElement.prototype.getBoundingClientRect = function () { return new window!.DOMRect(0, 0, 100, 20); };
    const mount = evaluate(`(${mountDashboardController.toString()})`);
    controller = mount({ root: window.document.body, canWrite: true, signal: new window.AbortController().signal, pollIntervalMs: -1, restartRetryMs: 1,
      navigate() {}, returnUrl: url, refresh: async () => undefined,
      transport: { ...(mode === 'unlock' ? { openLocalControls: async () => { unlocks++; unlocked = true; return true; } } : {}), control: async (params: { action: string; choice: string; cap_dollars?: number }) => {
        calls.push(params.action);
        if (params.action === 'save_judge') {
          expect(params).toEqual({ action: 'save_judge', choice: judgeChoices.length === 0 || ['judge-unreachable', 'judge-restarting', 'judge-starting'].includes(mode) ? 'venice' : 'local', cap_dollars: 1 });
          judgeChoices.push(String(params.choice));
          // The engine is restarting for the answer choice: the request never reaches it.
          if (mode === 'judge-unreachable' && judgeChoices.length === 1) throw new Error('connection refused');
          // The front's gate after the answer choice, and the worker socket's own answer while no front serves (fresh run 43554460947).
          if (mode === 'judge-restarting' && judgeChoices.length === 1) return { status: 503, body: { error: { code: 'worker_restarting', message: 'Olympus is restarting; try again in a moment.' } } };
          if (mode === 'judge-starting' && judgeChoices.length === 1) return { status: 503, body: { reachable: false, status: 'starting', step: 'starting' } };
          if (mode === 'judge-refused' && params.choice === 'venice') return { status: 400, body: { ok: false, error: { message: 'Add your own Venice API key in Keys first.' } } };
          judgeChosen = true;
          return { status: 200, body: { ok: true } };
        }
        if (params.action !== 'save_first_run_privacy') throw new Error('unexpected control');
        if (mode === 'refused' || (mode === 'unlock' && !unlocked)) return { status: 403, body: { ok: false, error: { code: 'mac_dashboard_only', message: REFUSAL } } };
        const saved = saveFirstRunPrivacyChoice(path, params.choice as SovereigntyPresetName);
        expect(saved.ok && saved.changed).toBe(true);
        return { status: 200, body: { ok: true } };
      } },
    });
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools` });
    },
    websocket: { async message(ws, raw) {
      const { id, method, params, sessionId = 's' } = JSON.parse(String(raw));
      const event = (method: string, params: unknown) => ws.send(JSON.stringify({ method, params, sessionId }));
      let result: unknown = {};
      try {
        if (method === 'Target.createTarget') result = { targetId: 'dash' };
        if (method === 'Target.attachToTarget') result = { sessionId: 's' };
        if (method === 'Target.closeTarget') events.push('tab.close');
        // Context 2 stands for the host page (listed first), which never holds the panel's forms.
        if (method === 'Runtime.enable') for (const id of [2, 1]) event('Runtime.executionContextCreated', { context: { id, auxData: { isDefault: true } } });
        if (method === 'Page.navigate') {
          events.push('navigate');
          if (calls.length >= 1 && keysVisits === 1 && navigationFailures === 0) {
            // The privacy save restarts the real worker; its first navigation may hit that gap.
            navigationFailures++;
            result = { errorText: 'net::ERR_CONNECTION_REFUSED' };
          } else {
            documentAt(params.url);
            event('Runtime.executionContextsCleared', {});
            for (const id of [2, 1]) event('Runtime.executionContextCreated', { context: { id, auxData: { isDefault: true } } });
            event('Page.frameNavigated', { frame: { url: params.url, loaderId: String(++loader) } });
            result = { loaderId: String(loader) };
          }
        }
        if (method === 'Runtime.evaluate') result = { result: { value: params.contextId === 2 ? hostEvaluate(params.expression) : await evaluate(params.expression) } };
        ws.send(JSON.stringify({ id, result }));
      } catch (error) { ws.send(JSON.stringify({ id, error: { message: String(error) } })); }
    } },
  });
  const machine: Machine = {
    handle: 'headless', label: 'headless', driver: 'test', os: 'linux',
    put: async () => {}, get: async () => {}, upgrade: async () => {},
    tunnel: async port => { expect(port).toBe(9333); return { port: server.port!, close: () => { events.push('tunnel.close'); } }; },
    exec: async script => {
      if (script.includes('/dashboard.json')) {
        expect(script).toContain('Authorization: Bearer $("$HOME/.local/bin/olympus" dashboard token)');
        return { code: 0, stdout: `${JSON.stringify(dashboardJson.body)}\n${dashboardJson.status}`, stderr: '', timedOut: false, ms: 0 };
      }
      const bridge = script.includes('owner-bridge --port');
      events.push(bridge ? 'bridge.start' : script.startsWith('kill ') ? 'bridge.stop' : 'mint');
      if (bridge) expect(script).toContain('/home/olyfresh/.olympus-canary/owner-bridge.pid');
      return { code: 0, stdout: bridge ? '123\n/home/olyfresh/rc/web-bridge.test\n' : 'http://127.0.0.1:8010/dashboard', stderr: '', timedOut: false, ms: 0 };
    },
  };
  let dashboard: Awaited<ReturnType<typeof openFreshDashboard>> | undefined;
  try {
    // Each wait ends as soon as its condition holds; 300 ms was too short for the unlock round trip on a busy CI runner (#1373).
    dashboard = await openFreshDashboard(machine, '127.0.0.1:9333', { timeoutMs: 2_000, pollMs: 1 });
    expect(events.indexOf('bridge.start')).toBeLessThan(events.indexOf('navigate'));
    if (mode === 'refused') {
      await expect(dashboard.privacyChoice()).rejects.toThrow(/^first-run privacy choice was not saved: the dashboard said "[^"]+"$/);
      expect(isPendingPrivacyPolicy(policy())).toBe(true);
      expect(calls).toEqual(['save_first_run_privacy']);
      await dashboard.close(); dashboard = undefined;
      return;
    }
    if (mode === 'judge-refused') {
      // Without a Venice key the leg saves this computer instead and says why.
      expect(await dashboard.privacyChoice()).toBe('Local models with Venice fallback (local-first, Recommended) saved and verified after reload; privacy check: This computer (local) saved after Venice was refused: the dashboard said "Add your own Venice API key in Keys first."');
      expect(judgeChoices).toEqual(['venice', 'local']);
      return;
    }
    if (mode === 'judge-unreachable' || mode === 'judge-restarting' || mode === 'judge-starting') {
      // A judge save sent while Olympus restarts for the answer choice waits for it and saves Venice (the page's own retry).
      expect(await dashboard.privacyChoice()).toBe('Local models with Venice fallback (local-first, Recommended) saved and verified after reload; privacy check: Venice (venice) saved');
      expect(judgeChoices).toEqual(['venice', 'venice']);
      return;
    }
    if (losesSave) await expect(dashboard.privacyChoice()).rejects.toThrow('did not persist after reload');
    else {
      expect(await dashboard.privacyChoice()).toBe(`Local models with Venice fallback (local-first, Recommended) saved and verified after reload${mode === 'saved-judge' ? '; privacy check: not shown' : '; privacy check: Venice (venice) saved'}`);
      expect(judgeChosen).toBe(true);
      expect(policy()).toEqual(loadSovereigntyPreset('local-first'));
      expect(isPendingPrivacyPolicy(policy())).toBe(false);
      // A connect that cannot start says which precondition failed, from the dashboard's JSON.
      const gmail = { id: 'gmail', label: 'Gmail' } as never;
      dashboardJson = { status: 401, body: {} };
      await expect(dashboard.connect(gmail)).rejects.toThrow('fresh source card unreadable: /dashboard.json answered 401');
      dashboardJson = { status: 200, body: { sources: [{ provider: 'dropbox', connection: { state: 'not_connected' } }] } };
      await expect(dashboard.connect(gmail)).rejects.toThrow('no gmail source card; the dashboard lists: dropbox');
      dashboardJson = { status: 200, body: { sources: [{ provider: 'gmail', connection: { state: 'synced' } }] } };
      await expect(dashboard.connect(gmail)).rejects.toThrow('gmail is already connected (synced) on a fresh install');
      // A control that never appears is named, with what the page had instead (olympus-ops#222).
      await expect(dashboard.scope({ id: 'gmail', label: 'Gmail', fresh: { scope: 'Canary' } } as never))
        .rejects.toThrow('Gmail control /Choose (mail|folders)|Scope|Edit scope/ did not appear');
    }
    expect(calls).toEqual([...(mode === 'unlock' ? ['save_first_run_privacy'] : []), 'save_first_run_privacy', ...(mode === 'saved-judge' ? [] : ['save_judge'])]);
    expect(unlocks).toBe(mode === 'unlock' ? 1 : 0);
    expect(keysVisits).toBeGreaterThanOrEqual(2);
    expect(navigationFailures).toBe(1);
    expect(events).not.toContain('bridge.stop');
    await dashboard.close(); dashboard = undefined;
    expect(events.slice(-3)).toEqual(['tab.close', 'tunnel.close', 'bridge.stop']);
  } finally { await dashboard?.close(); controller?.dispose(); window?.close(); host.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
