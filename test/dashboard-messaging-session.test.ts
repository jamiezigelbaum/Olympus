import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mountDashboardController } from '../src/control-ui/browser-controller.ts';
import { renderMessagingCard } from '../src/workers/dashboard/messaging.ts';

test('the first Pair press renews an expired local session and starts pairing exactly once', async () => {
  const happy = new Window({ url: 'http://127.0.0.1:8010/dashboard?keys' });
  const names = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'ShadowRoot', 'Event', 'MouseEvent', 'FormData', 'CSS'];
  const old = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const abort = new AbortController();
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: name === 'window' ? happy : (happy as any)[name] });
    const root = happy.document.createElement('div');
    root.innerHTML = renderMessagingCard('whatsapp', true);
    happy.document.body.append(root);
    let renewed = false; let starts = 0; let renewals = 0;
    mountDashboardController({ root: root as any, transport: {
      control: async () => ({ status: 200, body: {} }),
      openLocalControls: async () => { renewed = true; renewals++; return true; },
      messaging: async operation => {
        if (operation === 'status') return { status: 200, body: { ok: true, state: 'idle' } };
        if (!renewed) return { status: 401, body: { error: { code: 'unauthorized' } } };
        starts++; return { status: 200, body: { ok: true, state: 'starting' } };
      },
    }, navigate: () => {}, refresh: async () => undefined, returnUrl: happy.location.href, canWrite: true, signal: abort.signal, pollIntervalMs: 0 });
    await Bun.sleep(0);
    root.querySelector('form[data-messaging-kind="start"]')!.dispatchEvent(new happy.Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await Bun.sleep(0);
    expect(renewals).toBe(1);
    expect(starts).toBe(1);
    expect(root.querySelector('[data-messaging-status]')!.textContent).toContain('QR');
  } finally {
    abort.abort(); happy.close();
    for (const name of names) { const descriptor = old.get(name); if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name]; }
  }
});
