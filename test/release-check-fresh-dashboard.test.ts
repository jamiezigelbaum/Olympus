import { expect, test } from 'bun:test';
import { Window, type HTMLInputElement } from 'happy-dom';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { createPendingPrivacyPolicy, isPendingPrivacyPolicy, privateAnswerMode, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';
import { loadSovereigntyPreset, type SovereigntyPresetName } from '../src/core/sovereignty.ts';
import { renderModelSetup } from '../src/workers/dashboard/model-setup.ts';
import { openFreshDashboard } from '../scripts/release-check/fresh-dashboard.ts';
import type { Machine } from '../scripts/release-check/machine.ts';

for (const losesSave of [false, true]) test(`first-run dashboard ${losesSave ? 'rejects a choice lost on reload' : 'saves the Recommended choice through its normal form before sources'}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-dashboard-'));
  const path = join(dir, 'sovereignty.json');
  writeFileSync(path, JSON.stringify(createPendingPrivacyPolicy()));
  const policy = () => JSON.parse(readFileSync(path, 'utf8'));
  const calls: string[] = [];
  const events: string[] = [];
  let window: Window | undefined;
  let controller: { dispose(): void } | undefined;
  const evaluate = (expression: string): any => {
    const names = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS', 'getComputedStyle'] as const;
    return new Function(...names, `return ${expression}`)(...names.map(name => name === 'window' ? window : name === 'getComputedStyle' ? window!.getComputedStyle.bind(window) : window![name]));
  };
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
    const html = renderModelSetup(new ModelSetupService({ config, credentialState: () => 'ready', autoCheck: false }).getStatus());
    window.document.body.innerHTML = `<div data-answer-mode="${privateAnswerMode(config)}"></div>${html}`;
    // Start on a different option so the driver must select Recommended explicitly.
    const other = window.document.querySelector<HTMLInputElement>('input[value="no-sensitive"]');
    if (other) other.checked = true;
    for (const el of window.document.querySelectorAll('*')) el.getBoundingClientRect = () => new window!.DOMRect(0, 0, 100, 20);
    const mount = evaluate(`(${mountDashboardController.toString()})`);
    controller = mount({ root: window.document.body, canWrite: true, signal: new window.AbortController().signal, pollIntervalMs: -1,
      navigate() {}, returnUrl: url, refresh: async () => undefined,
      transport: { control: async (params: { action: string; choice: string }) => {
        calls.push(params.action);
        if (params.action !== 'save_first_run_privacy') throw new Error('unexpected control');
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
        if (method === 'Runtime.enable') event('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true } } });
        if (method === 'Page.navigate') {
          events.push('navigate');
          if (calls.length === 1 && keysVisits === 1 && navigationFailures === 0) {
            // The privacy save restarts the real worker; its first navigation may hit that gap.
            navigationFailures++;
            result = { errorText: 'net::ERR_CONNECTION_REFUSED' };
          } else {
            documentAt(params.url);
            event('Runtime.executionContextsCleared', {});
            event('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true } } });
            event('Page.frameNavigated', { frame: { url: params.url, loaderId: String(++loader) } });
            result = { loaderId: String(loader) };
          }
        }
        if (method === 'Runtime.evaluate') result = { result: { value: await evaluate(params.expression) } };
        ws.send(JSON.stringify({ id, result }));
      } catch (error) { ws.send(JSON.stringify({ id, error: { message: String(error) } })); }
    } },
  });
  const machine: Machine = {
    handle: 'headless', label: 'headless', driver: 'test', os: 'linux',
    put: async () => {}, get: async () => {}, upgrade: async () => {},
    tunnel: async port => { expect(port).toBe(9333); return { port: server.port!, close: () => { events.push('tunnel.close'); } }; },
    exec: async script => {
      const bridge = script.includes('owner-bridge --port');
      events.push(bridge ? 'bridge.start' : script.startsWith('kill ') ? 'bridge.stop' : 'mint');
      if (bridge) expect(script).toContain('/home/olyfresh/.olympus-canary/owner-bridge.pid');
      return { code: 0, stdout: bridge ? '123\n/home/olyfresh/rc/web-bridge.test\n' : 'http://127.0.0.1:8010/dashboard', stderr: '', timedOut: false, ms: 0 };
    },
  };
  let dashboard: Awaited<ReturnType<typeof openFreshDashboard>> | undefined;
  try {
    dashboard = await openFreshDashboard(machine, '127.0.0.1:9333', { timeoutMs: 300, pollMs: 1 });
    expect(events.indexOf('bridge.start')).toBeLessThan(events.indexOf('navigate'));
    if (losesSave) await expect(dashboard.privacyChoice()).rejects.toThrow('did not persist after reload');
    else {
      expect(await dashboard.privacyChoice()).toBe('Local models with Venice fallback (local-first, Recommended) saved and verified after reload');
      expect(policy()).toEqual(loadSovereigntyPreset('local-first'));
      expect(isPendingPrivacyPolicy(policy())).toBe(false);
    }
    expect(calls).toEqual(['save_first_run_privacy']);
    expect(keysVisits).toBeGreaterThanOrEqual(2);
    expect(navigationFailures).toBe(1);
    expect(events).not.toContain('bridge.stop');
    await dashboard.close(); dashboard = undefined;
    expect(events.slice(-3)).toEqual(['tab.close', 'tunnel.close', 'bridge.stop']);
  } finally { await dashboard?.close(); controller?.dispose(); window?.close(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
