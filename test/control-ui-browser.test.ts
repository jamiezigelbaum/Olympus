import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { OlympusDashboardControlResult } from '../src/control-ui-contract.ts';
import { DASHBOARD_REDRAW_EVENT, mountDashboardController, type OlympusDashboardPageRead } from '../src/control-ui/browser-controller.ts';
import { connectSetupSheet, setupStepsSheet } from '../src/workers/dashboard/components.ts';
import { buildDashboardPreviewView, setupPreviewScript } from '../scripts/dashboard-preview.ts';
import { dashboardHtmlRoutePage, renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';
import { renderMessagingCard } from '../src/workers/dashboard/messaging.ts';

const GLOBALS = [
  'window', 'document', 'navigator', 'Element', 'HTMLElement', 'HTMLFormElement', 'HTMLInputElement',
  'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'ShadowRoot', 'Event', 'MouseEvent', 'KeyboardEvent', 'FormData', 'CSS',
] as const;

const previous = new Map<string, PropertyDescriptor | undefined>();
let happyWindow: Window;

beforeEach(() => {
  happyWindow = new Window({ url: 'https://gateway.test/' });
  const values: Record<(typeof GLOBALS)[number], unknown> = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLFormElement: happyWindow.HTMLFormElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
    HTMLSelectElement: happyWindow.HTMLSelectElement,
    HTMLButtonElement: happyWindow.HTMLButtonElement,
    ShadowRoot: happyWindow.ShadowRoot,
    Event: happyWindow.Event,
    MouseEvent: happyWindow.MouseEvent,
    KeyboardEvent: happyWindow.KeyboardEvent,
    FormData: happyWindow.FormData,
    CSS: happyWindow.CSS,
  };
  for (const name of GLOBALS) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
  }
});

afterEach(() => {
  for (const name of GLOBALS) {
    const descriptor = previous.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  previous.clear();
  happyWindow.close();
});

function result(body: string, signature: string, canWrite = true): OlympusDashboardPageRead {
  return {
    status: 200,
    title: 'Olympus',
    body,
    controller: 'dashboard',
    can_write: canWrite,
    signature,
    poll_interval_ms: 0,
  };
}

const noControl = async (): Promise<OlympusDashboardControlResult> => ({ status: 200, body: { ok: true } });

function oauthFormRoot(): { root: HTMLDivElement; form: HTMLFormElement } {
  const root = document.createElement('div');
  root.innerHTML = '<form data-connect-kind="oauth">'
    + '<input name="source" type="hidden" value="gmail">'
    + '<button type="submit">Connect</button>'
    + '<span data-action-message></span><span data-authorization-fallback></span></form>';
  document.body.append(root);
  return { root, form: root.querySelector('form')! };
}

function oauthResult(url: string): OlympusDashboardControlResult {
  return { status: 200, body: { ok: true, authorization_url: url } };
}

describe('OAuth browser handoff', () => {
  test('Dropbox publisher Connect starts its one-click flow even with own-app steps', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button data-sheet-toggle="#dropbox-connect">Connect</button>' + connectSetupSheet({
      id: 'dropbox-connect', heading: 'Connect Dropbox', intro: 'Use your app', promptText: 'Help', source: 'dropbox', fields: [],
      steps: [{ text: 'Create' }, { text: 'Key' }], provider: 'Dropbox', publisher: { intro: 'Connect Dropbox', byoSummary: 'Use my own app' },
    });
    document.body.append(root);
    const calls: unknown[] = [];
    const controller = mountDashboardController({ root, transport: { control: async (params) => { calls.push(params); return { status: 200, body: { ok: true } }; } },
      navigate() {}, async refresh() { return undefined; }, returnUrl: 'https://gateway.test/', canWrite: true, signal: new AbortController().signal, pollIntervalMs: 0 });
    root.querySelector<HTMLButtonElement>('[data-sheet-toggle]')!.click();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'start_oauth', source: 'dropbox' });
    controller.dispose();
  });
  test('setup opens the provider synchronously and keeps a safe fallback link', () => {
    const root = document.createElement('div');
    root.innerHTML = setupStepsSheet({ id: 'venice', provider: 'Venice', finalForm: () => '', steps: [
      { text: 'Account', link: { label: 'Venice', url: 'https://venice.ai/settings/api' } },
    ] });
    document.body.append(root);
    const calls: unknown[][] = [];
    Object.defineProperty(window, 'open', { configurable: true, value: (...args: unknown[]) => { calls.push(args); return null; } });
    const controller = mountDashboardController({ root, transport: { control: noControl }, navigate() {}, async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/', canWrite: true, signal: new AbortController().signal, pollIntervalMs: 0 });
    root.querySelector<HTMLButtonElement>('[data-setup-open]')!.click();
    expect(calls).toEqual([['https://venice.ai/settings/api', '_blank', 'noopener,noreferrer']]);
    const fallback = root.querySelector<HTMLAnchorElement>('a.ext')!;
    expect(fallback.href).toBe('https://venice.ai/settings/api');
    expect(fallback.target).toBe('_blank');
    expect(fallback.rel).toContain('noopener');
    controller.dispose();
  });
  for (const [message, index] of [
    ['Venice reports no credit. Redo the Set up your account step and add credit. No credentials were stored.', 0],
    ['Venice could not accept this key. Redo the Create an API key step and check its restrictions. No credentials were stored.', 1],
  ] as const) {
    test(`Venice failure returns to step ${index + 1}`, async () => {
      const root = document.createElement('div');
      root.innerHTML = setupStepsSheet({ id: 'venice', provider: 'Venice', steps: [{ text: 'Account' }, { text: 'Key' }, { text: 'Paste' }],
        finalForm: (id) => `<form id="${id}" data-connect-kind="api_key"><input name="source" value="venice"><input name="api_key" value="fixture"><span data-action-message></span></form>` });
      document.body.append(root);
      const controller = mountDashboardController({ root, transport: { control: async () => ({ status: 400, body: { ok: false, error: { message } } }) },
        navigate() {}, async refresh() { return undefined; }, returnUrl: 'https://gateway.test/', canWrite: true,
        signal: new AbortController().signal, pollIntervalMs: 0 });
      const next = root.querySelector<HTMLButtonElement>('[data-setup-next]')!;
      next.click(); next.click();
      root.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await happyWindow.happyDOM.waitUntilComplete();
      expect(root.querySelector('[data-setup-error]')?.textContent).toContain(message);
      expect(Array.from(root.querySelectorAll<HTMLElement>('[data-setup-panel]')).every(panel => panel.hidden)).toBe(true);
      expect(root.querySelector<HTMLElement>('[data-setup-actions]')!.hidden).toBe(true);
      root.querySelector<HTMLButtonElement>('[data-setup-retry]')!.click();
      expect(Array.from(root.querySelectorAll<HTMLElement>('[data-setup-panel]')).findIndex(p => !p.hidden)).toBe(index);
      expect(root.querySelector('[data-setup-error]')).toBeNull();
      expect(root.querySelector('[data-action-message]')?.textContent).toBe('');
      controller.dispose();
    });
  }
  test('Dropbox permissions recovery opens the walkthrough at its permissions step', () => {
    happyWindow.location.hash = '#olympus-open=dropbox.permissions';
    const root = document.createElement('div');
    root.innerHTML = '<div data-source-id="dropbox.files"><button data-sheet-toggle="#dropbox-sheet">Connect</button>'
      + '<div class="sheet" id="dropbox-sheet"><details>' + setupStepsSheet({ id: 'd', provider: 'Dropbox', finalForm: (id) => `<form id="${id}"></form>`,
        steps: [{ text: 'Create' }, { text: 'Access' }, { text: 'Permissions' }, { text: 'Redirect' }, { text: 'Key' }] }) + '</details></div></div>';
    document.body.append(root);
    const controller = mountDashboardController({ root, transport: { control: noControl }, navigate() {}, async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/', canWrite: true, signal: new AbortController().signal, pollIntervalMs: 0 });
    expect(root.querySelector('.sheet')?.classList.contains('on')).toBe(true);
    expect(root.querySelector('details')?.open).toBe(true);
    expect(Array.from(root.querySelectorAll<HTMLElement>('[data-setup-panel]')).findIndex(p => !p.hidden)).toBe(2);
    expect(root.querySelector('[data-setup-counter]')?.textContent).toBe('Step 3 of 5');
    controller.dispose();
  });
  for (const mode of ['publisher', 'byo', 'pending', 'read-only'] as const) {
    test(`Setup Connect opens ${mode} sheet and starts only ready publisher OAuth`, async () => {
      const root = document.createElement('div');
      root.innerHTML = '<button data-sheet-toggle="#gmail-connect">Connect</button>' + connectSetupSheet({
        id: 'gmail-connect', heading: 'Connect Gmail', intro: 'Connect your app', promptText: 'Help connect Gmail',
        source: 'gmail', fields: [{ name: 'client_id', label: 'Client ID', required: true, secret: false }],
        ...(mode !== 'byo' ? { publisher: { intro: 'Connect Gmail', byoSummary: 'Use my own app instead' } } : {}),
        cancellable: mode === 'pending',
      });
      document.body.append(root);
      const calls: unknown[] = [];
      const handoffs: unknown[] = [];
      let finish!: (value: OlympusDashboardControlResult) => void;
      const pending = new Promise<OlympusDashboardControlResult>((resolve) => { finish = resolve; });
      Object.defineProperty(window, 'webkit', { configurable: true, value: {
        messageHandlers: { openclawLink: { postMessage: (message: unknown) => handoffs.push(message) } },
      } });
      const controller = mountDashboardController({
        root, transport: { control: async (params) => { calls.push(params); return pending; } },
        navigate() {}, async refresh() { return undefined; },
        returnUrl: 'https://gateway.test/?view=setup', canWrite: mode !== 'read-only',
        signal: new AbortController().signal, pollIntervalMs: 0,
      });
      const toggle = root.querySelector<HTMLButtonElement>('[data-sheet-toggle]')!;
      toggle.click();
      expect(root.querySelector('.sheet')?.classList.contains('on')).toBe(true);
      expect(calls.length).toBe(mode === 'publisher' ? 1 : 0);
      toggle.click();
      toggle.click();
      expect(calls.length).toBe(mode === 'publisher' ? 1 : 0);
      if (mode === 'publisher') {
        expect(calls[0]).toMatchObject({ action: 'start_oauth', source: 'gmail' });
        const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=one-click';
        finish(oauthResult(authorizationUrl));
        await happyWindow.happyDOM.waitUntilComplete();
        expect(handoffs).toEqual([{ type: 'open-link', url: authorizationUrl, target: 'external' }]);
      }
      controller.dispose();
    });
  }

  test('opening one setup sheet closes the others and moves focus into it', () => {
    const root = document.createElement('div');
    const sheet = (id: string, inner = '') => `<div class="sheet" id="${id}" aria-hidden="true"><h4>${id}</h4>${inner}</div>`;
    root.innerHTML = ['gmail', 'drive', 'dropbox'].map((id) =>
      `<button type="button" data-sheet-toggle="#${id}" aria-controls="${id}" aria-expanded="false">Connect</button>`).join('')
      + sheet('gmail') + sheet('drive', '<button type="button" id="nested" data-sheet-toggle="#dropbox" aria-expanded="false">More</button>')
      + sheet('dropbox');
    document.body.append(root);
    const controller = mountDashboardController({
      root, transport: { control: noControl }, navigate() {}, async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/?view=setup', canWrite: false,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`button[data-sheet-toggle="#${id}"]`)!;
    const state = () => ['gmail', 'drive', 'dropbox'].map((id) => [
      id, root.querySelector(`#${id}`)!.classList.contains('on'), root.querySelector(`#${id}`)!.getAttribute('aria-hidden'),
      toggle(id).getAttribute('aria-expanded'),
    ]);

    toggle('gmail').click();
    expect(state()).toEqual([['gmail', true, 'false', 'true'], ['drive', false, 'true', 'false'], ['dropbox', false, 'true', 'false']]);
    expect(document.activeElement).toBe(root.querySelector('#gmail'));
    expect(root.querySelector('#gmail')!.getAttribute('tabindex')).toBe('-1');

    toggle('drive').click();
    expect(state()).toEqual([['gmail', false, 'true', 'false'], ['drive', true, 'false', 'true'], ['dropbox', false, 'true', 'false']]);
    expect(document.activeElement).toBe(root.querySelector('#drive'));

    // A toggle inside an open sheet keeps its own sheet open.
    root.querySelector<HTMLButtonElement>('#nested')!.click();
    expect(root.querySelector('#drive')!.classList.contains('on')).toBe(true);
    expect(root.querySelector('#dropbox')!.classList.contains('on')).toBe(true);
    expect(root.querySelector('#nested')!.getAttribute('aria-expanded')).toBe('true');

    // Closing one sheet leaves every other sheet as it was.
    toggle('dropbox').click();
    expect(root.querySelector('#dropbox')!.classList.contains('on')).toBe(false);
    expect(root.querySelector('#nested')!.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('#drive')!.classList.contains('on')).toBe(true);
    controller.dispose();
  });

  test('uses OpenClaw native handoff without opening a WebKit popup', async () => {
    const { root, form } = oauthFormRoot();
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state&code=auth-code';
    const messages: unknown[] = [];
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { openclawLink: { postMessage: (message: unknown) => messages.push(message) } } },
    });
    let popupAttempts = 0;
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: () => { popupAttempts += 1; return null; },
    });
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult(authorizationUrl) },
      navigate() {},
      async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(popupAttempts).toBe(0);
    expect(messages).toEqual([{ type: 'open-link', url: authorizationUrl, target: 'external' }]);
    expect(root.querySelector('[data-action-message]')?.textContent)
      .toBe('Authorization opened in your default browser. Approve it there, then come back to Olympus — this card updates when the connection completes.');
    expect(root.textContent).not.toContain(authorizationUrl);
    expect(root.querySelector('[data-authorization-fallback] a')).toBeNull();
    controller.dispose();
  });

  test('keeps the browser popup isolated and carries the authorization URL only to it', async () => {
    const { root, form } = oauthFormRoot();
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state';
    const popup = { opener: {}, location: { href: '' }, close() {} } as unknown as Window;
    let openArgs: unknown[] | undefined;
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: (...args: unknown[]) => { openArgs = args; return popup; },
    });
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult(authorizationUrl) },
      navigate() {},
      async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(openArgs).toEqual(['', '_blank']);
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe(authorizationUrl);
    expect(root.textContent).not.toContain(authorizationUrl);
    controller.dispose();
  });

  test('retains the checked fallback link when neither handoff is available', async () => {
    const { root, form } = oauthFormRoot();
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state';
    Object.defineProperty(window, 'open', { configurable: true, value: () => null });
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult(authorizationUrl) },
      navigate() {},
      async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    const fallback = root.querySelector<HTMLAnchorElement>('[data-authorization-fallback] a');
    expect(fallback?.href).toBe(authorizationUrl);
    expect(fallback?.target).toBe('_blank');
    expect(fallback?.rel).toBe('noopener noreferrer');
    expect(root.textContent).not.toContain(authorizationUrl);
    controller.dispose();
  });

  test('refreshes connected state after handoff and releases the submitted form and focus', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<button type="button" data-sheet-toggle="#connect-gmail" aria-expanded="true">Reauthenticate</button>'
      + '<div class="sheet on" id="connect-gmail" aria-hidden="false">'
      + '<form data-connect-kind="oauth"><input name="source" type="hidden" value="gmail">'
      + '<button type="submit">Connect</button><span data-action-message></span></form></div>'
      + '<details data-poll-key="advanced" open><summary>Advanced</summary><p>Keep open</p></details>';
    document.body.append(root);
    const form = root.querySelector<HTMLFormElement>('form[data-connect-kind="oauth"]')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.focus();
    const popup = { opener: {}, location: { href: '' }, close() {} } as unknown as Window;
    Object.defineProperty(window, 'open', { configurable: true, value: () => popup });
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state';
    let refreshes = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult(authorizationUrl) },
      navigate() {},
      async refresh() {
        refreshes += 1;
        return result('<p id="connected">Gmail · Connected</p>'
          + '<details data-poll-key="advanced"><summary>Advanced</summary><p>Keep open</p></details>', 'connected');
      },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(refreshes).toBe(1);
    expect(root.querySelector('#connected')?.textContent).toBe('Gmail · Connected');
    expect(root.querySelector('.sheet.on')).toBeNull();
    expect(root.querySelector('[data-sheet-toggle]')).toBeNull();
    expect(document.activeElement).not.toBe(submit);
    expect(root.querySelector('details')?.open).toBe(true);
    controller.dispose();
  });

  test('a started sign-in keeps its sheet open on the wait line through the redraw, until the owner comes back', async () => {
    const sheetPage = (state: string) => '<button type="button" data-sheet-toggle="#connect-drive" aria-expanded="true">Connect</button>'
      + '<div class="sheet on" id="connect-drive" aria-hidden="false">'
      + '<form data-connect-kind="oauth"><input name="source" type="hidden" value="google-drive">'
      + `<button type="submit">Connect</button><span data-action-message></span></form><p id="state">${state}</p></div>`;
    const root = document.createElement('div');
    root.innerHTML = sheetPage('ready');
    document.body.append(root);
    const popup = { opener: {}, location: { href: '' }, close() {} } as unknown as Window;
    Object.defineProperty(window, 'open', { configurable: true, value: () => popup });
    let page = 'connecting';
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult('https://accounts.google.com/o/oauth2/auth?state=oauth-state') },
      navigate() {},
      async refresh() { return result(sheetPage(page), page); },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'ready',
      pollIntervalMs: 0,
    });

    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    // The page was read again (its form replaced), and the sheet still says what happened.
    expect(root.querySelector('#state')?.textContent).toBe('connecting');
    expect(root.querySelector('#connect-drive')?.classList.contains('on')).toBe(true);
    expect(root.querySelector('[data-action-message]')?.textContent).toStartWith('Authorization opened in a new tab.');

    // Coming back reads the server's own answer; the wait line is not said again.
    page = 'connected';
    window.dispatchEvent(new Event('focus'));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(root.querySelector('#state')?.textContent).toBe('connected');
    expect(root.querySelector('[data-action-message]')?.textContent).toBe('');
    controller.dispose();
  });

  test('resets an accepted password before releasing it without reflecting the secret into HTML', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<button type="button" data-sheet-toggle="#connect-gmail" aria-expanded="true">Reauthenticate</button>'
      + '<div class="sheet on" id="connect-gmail" aria-hidden="false">'
      + '<form data-connect-kind="oauth"><input name="source" type="hidden" value="gmail">'
      + '<input name="client_secret" type="password"><button type="submit">Connect</button>'
      + '<span data-action-message></span></form></div>';
    document.body.append(root);
    const form = root.querySelector<HTMLFormElement>('form[data-connect-kind="oauth"]')!;
    const secret = form.querySelector<HTMLInputElement>('input[name="client_secret"]')!;
    secret.value = 'oauth-secret-entered-by-owner';
    const popup = { opener: {}, location: { href: '' }, close() {} } as unknown as Window;
    Object.defineProperty(window, 'open', { configurable: true, value: () => popup });
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult('https://accounts.google.com/o/oauth2/auth?state=oauth-state') },
      navigate() {},
      async refresh() { return undefined; },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(secret.value).toBe('');
    expect(root.innerHTML).not.toContain('oauth-secret-entered-by-owner');
    // The sheet stays open on the wait line, its secret already cleared.
    expect(root.querySelector('[data-action-message]')?.textContent).toStartWith('Authorization opened in a new tab.');
    controller.dispose();
  });

  test('releases the sheet after the owner activates the fallback link', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<button type="button" data-sheet-toggle="#connect-gmail" aria-expanded="true">Reauthenticate</button>'
      + '<div class="sheet on" id="connect-gmail" aria-hidden="false">'
      + '<form data-connect-kind="oauth"><input name="source" type="hidden" value="gmail">'
      + '<button type="submit">Connect</button><span data-action-message></span>'
      + '<span data-authorization-fallback></span></form></div>';
    document.body.append(root);
    const form = root.querySelector<HTMLFormElement>('form[data-connect-kind="oauth"]')!;
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state';
    Object.defineProperty(window, 'open', { configurable: true, value: () => null });
    let refreshes = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult(authorizationUrl) },
      navigate() {},
      async refresh() {
        refreshes += 1;
        return result('<p id="connected">Gmail · Connected</p>', 'connected');
      },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    const fallback = root.querySelector<HTMLAnchorElement>('[data-authorization-fallback] a')!;
    expect(fallback.target).toBe('_blank');
    expect(fallback.rel).toBe('noopener noreferrer');
    expect(refreshes).toBe(0);

    fallback.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    // The link remains available for the browser's default navigation before
    // the deferred release runs.
    expect(root.contains(fallback)).toBe(true);
    await happyWindow.happyDOM.waitUntilComplete();

    expect(refreshes).toBe(1);
    expect(root.querySelector('#connected')?.textContent).toBe('Gmail · Connected');
    expect(root.querySelector('[data-authorization-fallback] a')).toBeNull();
    controller.dispose();
  });

  test('keeps the submitted sheet open and preserves edits made while the RPC is pending', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<button type="button" data-sheet-toggle="#connect-gmail" aria-expanded="true">Reauthenticate</button>'
      + '<div class="sheet on" id="connect-gmail" aria-hidden="false">'
      + '<form data-connect-kind="oauth"><input name="source" type="hidden" value="gmail">'
      + '<input name="client_id" value="initial-client">'
      + '<button type="submit">Connect</button><span data-action-message></span></form></div>'
      + '<form data-connect-kind="api_key"><input name="source" type="hidden" value="readwise">'
      + '<input name="api_key" type="password"><button type="submit">Save draft</button></form>';
    document.body.append(root);
    const oauth = root.querySelector<HTMLFormElement>('form[data-connect-kind="oauth"]')!;
    const draft = root.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    const popup = { opener: {}, location: { href: '' }, close() {} } as unknown as Window;
    Object.defineProperty(window, 'open', { configurable: true, value: () => popup });
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state';
    let resolveControl!: (value: OlympusDashboardControlResult) => void;
    const control = new Promise<OlympusDashboardControlResult>((resolve) => { resolveControl = resolve; });
    let refreshes = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: () => control },
      navigate() {},
      async refresh() {
        refreshes += 1;
        return result('<p id="connected">Gmail · Connected</p>', 'connected');
      },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    draft.value = 'draft-secret';
    draft.focus();
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    oauth.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const oauthClientId = oauth.querySelector<HTMLInputElement>('input[name="client_id"]')!;
    oauthClientId.value = 'edited-while-pending';
    oauthClientId.focus();
    oauthClientId.dispatchEvent(new Event('input', { bubbles: true }));
    resolveControl(oauthResult(authorizationUrl));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(refreshes).toBe(0);
    expect(root.querySelector('#connected')).toBeNull();
    expect(root.querySelector('.sheet.on')).not.toBeNull();
    expect(oauthClientId.value).toBe('edited-while-pending');
    expect(draft.value).toBe('draft-secret');
    expect(document.activeElement).toBe(oauthClientId);
    controller.dispose();
  });
});

describe('control submit state', () => {
  function keyFormRoot(): {
    root: HTMLDivElement;
    form: HTMLFormElement;
    key: HTMLInputElement;
    submit: HTMLButtonElement;
  } {
    const root = document.createElement('div');
    root.innerHTML = '<button type="button" data-sheet-toggle="#connect-readwise" aria-expanded="true">Reauthenticate</button>'
      + '<div class="sheet on" id="connect-readwise" aria-hidden="false">'
      + '<form data-connect-kind="api_key"><input name="source" type="hidden" value="readwise">'
      + '<input name="api_key" type="password"><button type="submit">Connect</button>'
      + '<span data-action-message></span></form></div>';
    document.body.append(root);
    return {
      root,
      form: root.querySelector<HTMLFormElement>('form[data-connect-kind="api_key"]')!,
      key: root.querySelector<HTMLInputElement>('input[name="api_key"]')!,
      submit: root.querySelector<HTMLButtonElement>('button[type="submit"]')!,
    };
  }

  test('a focused Connect button still lands the accepted key and reads the authoritative card', async () => {
    const { root, form, key, submit } = keyFormRoot();
    key.value = 'sk-readwise-secret';
    submit.focus();
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async () => ({ status: 200, body: { ok: true } }) },
      navigate() {},
      async refresh() {
        reads += 1;
        return result('<p id="connected">Readwise · Connected</p>', 'connected');
      },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    expect(document.activeElement).toBe(submit);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    // The form the request was made from is gone — and with it the secret —
    // rather than a reset Connect row sitting under a "Done" sentence.
    expect(reads).toBe(1);
    expect(root.querySelector('#connected')?.textContent).toBe('Readwise · Connected');
    expect(root.querySelector('.sheet.on')).toBeNull();
    expect(root.querySelector('[data-sheet-toggle]')).toBeNull();
    expect(root.querySelector('form[data-connect-kind="api_key"]')).toBeNull();
    expect(document.activeElement).not.toBe(submit);
    expect(root.innerHTML).not.toContain('sk-readwise-secret');
    controller.dispose();
  });

  test('a successful key submit leaves an unrelated form’s unsaved typing alone', async () => {
    const { root, form, key, submit } = keyFormRoot();
    const other = document.createElement('form');
    other.setAttribute('data-connect-kind', 'api_key');
    other.innerHTML = '<input name="source" type="hidden" value="x"><input name="api_key" value="unsaved-client">'
      + '<button type="submit">Connect</button>';
    root.append(other);
    const draft = other.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    key.value = 'sk-readwise-secret';
    draft.value = 'typed-but-not-submitted';
    draft.focus();
    submit.focus();
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async () => ({ status: 200, body: { ok: true } }) },
      navigate() {},
      async refresh() { reads += 1; return result('<p id="connected">Readwise · Connected</p>', 'connected'); },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    // The submitted secret is cleared, the unreleased card is honest, and the
    // unsaved input in the other form is neither replaced nor reset.
    expect(key.value).toBe('');
    expect(root.querySelector('[data-action-message]')?.textContent)
      .toBe('Key accepted. This card updates when Olympus confirms the connection.');
    expect(reads).toBe(0);
    expect(root.querySelector('#connected')).toBeNull();
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Connected');
    expect(key.hidden).toBe(true);
    expect(draft.value).toBe('typed-but-not-submitted');
    expect(root.contains(draft)).toBe(true);
    controller.dispose();
  });

  test('a pending submit holds one transport call and states the work in progress', async () => {
    const { root, form, key, submit } = keyFormRoot();
    const calls: unknown[] = [];
    let finish!: (value: OlympusDashboardControlResult) => void;
    const pending = new Promise<OlympusDashboardControlResult>((resolve) => { finish = resolve; });
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async (params) => { calls.push(params); return pending; } },
      navigate() {},
      async refresh() { reads += 1; return result('<p id="connected">Readwise · Connected</p>', 'connected'); },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    key.value = 'sk-readwise-secret';
    submit.focus();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(calls.length).toBe(1);
    expect(submit.disabled).toBe(true);
    expect(root.querySelector('[data-action-message]')?.textContent).toBe('Validating the key…');

    // A repeated click while the request is outstanding is not a second act.
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    submit.click();
    expect(calls.length).toBe(1);

    finish({ status: 200, body: { ok: true } });
    await happyWindow.happyDOM.waitUntilComplete();
    expect(calls.length).toBe(1);
    expect(reads).toBe(1);
    controller.dispose();
  });

  test('a refused key reports the refusal, keeps the entry, and stays retryable', async () => {
    const { root, form, key, submit } = keyFormRoot();
    let attempts = 0;
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: {
        control: async () => {
          attempts += 1;
          return attempts === 1
            ? { status: 400, body: { ok: false, error: { message: 'That API key was refused.' } } }
            : { status: 200, body: { ok: true } };
        },
      },
      navigate() {},
      async refresh() { reads += 1; return result('<p id="connected">Readwise · Connected</p>', 'connected'); },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    key.value = 'sk-refused';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(root.querySelector('[data-action-message]')?.textContent).toBe('That API key was refused.');
    expect(submit.disabled).toBe(false);
    expect(key.value).toBe('sk-refused');
    expect(reads).toBe(0);
    expect(root.textContent).not.toContain('Connected');

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(attempts).toBe(2);
    expect(reads).toBe(1);
    controller.dispose();
  });

  test('OAuth start waits for the provider and re-reads when the owner comes back', async () => {
    const { root, form } = oauthFormRoot();
    const popup = { opener: {}, location: { href: '' }, close() {} } as unknown as Window;
    Object.defineProperty(window, 'open', { configurable: true, value: () => popup });
    const authorizationUrl = 'https://accounts.google.com/o/oauth2/auth?state=oauth-state';
    const bodies = [
      result('<p id="pending">Gmail · Awaiting approval</p>', 'pending'),
      result('<p id="connected">Gmail · Connected</p>', 'connected'),
    ];
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async () => oauthResult(authorizationUrl) },
      navigate() {},
      async refresh() { return bodies[Math.min(reads++, bodies.length - 1)]; },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    // Starting the flow is not a connection: the card still says it is waiting.
    expect(reads).toBe(1);
    expect(root.querySelector('#pending')?.textContent).toBe('Gmail · Awaiting approval');
    expect(root.textContent).not.toContain('Connected');

    window.dispatchEvent(new Event('focus'));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(reads).toBe(2);
    expect(root.querySelector('#connected')?.textContent).toBe('Gmail · Connected');
    controller.dispose();
  });

  test('the same submit state holds when the native page mounts inside a shadow root', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<form data-connect-kind="api_key"><input name="source" type="hidden" value="readwise">'
      + '<input name="api_key" type="password"><button type="submit">Connect</button>'
      + '<span data-action-message></span></form>';
    const form = root.querySelector<HTMLFormElement>('form')!;
    const key = root.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    const submit = root.querySelector<HTMLButtonElement>('button')!;
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: async () => ({ status: 200, body: { ok: true } }) },
      navigate() {},
      async refresh() {
        reads += 1;
        return result('<p id="connected">Readwise · Connected</p>', 'connected');
      },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'old',
      pollIntervalMs: 0,
    });

    key.value = 'sk-shadow-secret';
    submit.focus();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();

    expect(reads).toBe(1);
    expect(root.querySelector('#connected')?.textContent).toBe('Readwise · Connected');
    expect(root.innerHTML).not.toContain('sk-shadow-secret');
    controller.dispose();
  });
});

describe('dashboard controller DOM lifetime', () => {
  test('a focused copy button in a read-only agent sheet does not freeze connection updates', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<p id="source-state">Not connected</p><div id="pair-sheet" class="sheet on"><p>Run the pairing command</p><button id="copy-pair">Copy prompt</button></div>';
    document.body.append(root);
    root.querySelector<HTMLButtonElement>('#copy-pair')!.focus();
    const controller = mountDashboardController({ root, canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0, signature: 'before',
      transport: { control: async () => ({ status: 200, body: { ok: true } }) }, navigate() {},
      returnUrl: 'https://gateway.test/?view=setup',
      refresh: async () => result('<p id="source-state">Connected</p><div id="pair-sheet" class="sheet"><p>Run the pairing command</p><button id="copy-pair">Copy prompt</button></div>', 'after'),
    });
    await controller.refresh();
    expect(root.querySelector('#source-state')?.textContent).toBe('Connected');
    expect(root.querySelector('#pair-sheet')?.classList.contains('on')).toBe(true);
    controller.dispose();
  });

  test('a dirty draft survives refresh after any focus age and permission revoke/regrant', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<form data-connect-kind="api_key"><input name="source" type="hidden" value="readwise">'
      + '<input name="api_key" type="password"><button type="submit">Connect</button><span data-action-message></span></form>';
    document.body.append(root);
    let reads = 0;
    const controller = mountDashboardController({
      root,
      transport: { control: noControl },
      navigate() {},
      async refresh() { reads += 1; return result('<p>replacement</p>', 'next'); },
      returnUrl: 'https://gateway.test/?view=setup',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'initial',
      pollIntervalMs: 0,
    });
    const input = root.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    const button = root.querySelector<HTMLButtonElement>('button')!;
    input.value = 'unsaved-secret';
    input.focus();

    await controller.refresh();
    expect(reads).toBe(0);
    expect(root.contains(input)).toBe(true);
    expect(input.value).toBe('unsaved-secret');

    controller.update({ canWrite: false });
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(input.value).toBe('unsaved-secret');
    controller.update({ canWrite: true });
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(input.value).toBe('unsaved-secret');
    controller.dispose();
  });

  test('an edit made while refresh is pending is not replaced by the response', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<form data-connect-kind="api_key"><input name="source" type="hidden" value="readwise">'
      + '<input name="api_key" type="password"><button type="submit">Connect</button></form>';
    document.body.append(root);
    let resolveRefresh!: (value: OlympusDashboardPageRead) => void;
    const pendingRefresh = new Promise<OlympusDashboardPageRead>((resolve) => { resolveRefresh = resolve; });
    const controller = mountDashboardController({
      root,
      transport: { control: noControl },
      navigate() {},
      refresh: () => pendingRefresh,
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: new AbortController().signal,
      signature: 'initial',
      pollIntervalMs: 0,
    });

    const refreshing = controller.refresh();
    const input = root.querySelector<HTMLInputElement>('input[name="api_key"]')!;
    input.focus();
    input.value = 'typed while refresh is waiting';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    resolveRefresh(result('<p>replacement</p>', 'next'));
    await refreshing;

    expect(root.contains(input)).toBe(true);
    expect(input.value).toBe('typed while refresh is waiting');
    controller.dispose();
  });

  test('poll replacement lands, navigation respects modifiers, and disposal retires listeners', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="/dashboard?setup">Setup</a>';
    document.body.append(root);
    let reads = 0;
    const navigations: string[] = [];
    const abort = new AbortController();
    const controller = mountDashboardController({
      root,
      transport: { control: noControl },
      navigate(href) { navigations.push(href); },
      async refresh() {
        reads += 1;
        return result('<p id="safe">safe</p>', 'next');
      },
      returnUrl: 'https://gateway.test/',
      canWrite: true,
      signal: abort.signal,
      signature: 'initial',
      pollIntervalMs: 0,
    });
    const link = root.querySelector('a')!;
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true }));
    expect(navigations).toEqual([]);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    expect(navigations).toEqual(['/dashboard?setup']);

    await controller.refresh();
    expect(root.querySelector('#safe')?.textContent).toBe('safe');

    abort.abort();
    const readCount = reads;
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await controller.refresh();
    expect(reads).toBe(readCount);
  });
});

test('changed model settings are swapped in place: no reload, the open sheet stays open, the card\'s own scripts run again', async () => {
  const page = (card: string) => `<section data-outside-help>${card}</section><script data-dashboard-rerun>window.cardRuns = (window.cardRuns || 0) + 1;</script><script>window.otherRuns = 1;</script>`
    + '<button data-sheet-toggle="#connect-dropbox-files" aria-expanded="false">Connect</button><div class="sheet" id="connect-dropbox-files" aria-hidden="true">sheet</div>';
  const root = document.createElement('div');
  root.innerHTML = page('card');
  document.body.append(root);
  const created: HTMLScriptElement[] = [];
  const make = document.createElement.bind(document);
  document.createElement = ((tag: string) => {
    const node = make(tag);
    if (tag === 'script') created.push(node as HTMLScriptElement);
    return node;
  }) as typeof document.createElement;
  const navigations: string[] = [];
  const controller = mountDashboardController({
    root, transport: { control: noControl },
    navigate: (href) => navigations.push(href), returnUrl: '/dashboard?keys#anonymous', canWrite: true,
    signal: new AbortController().signal, signature: 'old', pollIntervalMs: -1,
    refresh: async () => ({ status: 200, title: 'Keys', body: page('card changed'), controller: 'dashboard', can_write: true, signature: 'new', poll_interval_ms: -1 }),
  });
  root.querySelector<HTMLElement>('[data-sheet-toggle]')!.click();
  await controller.refresh(); controller.dispose();
  expect(navigations).toEqual([]);
  expect(root.querySelector('[data-outside-help]')!.textContent).toBe('card changed');
  expect(root.querySelector('#connect-dropbox-files')!.classList.contains('on')).toBe(true);
  expect(root.querySelector('[data-sheet-toggle]')!.getAttribute('aria-expanded')).toBe('true');
  // Only the marked script is made again (a fresh element runs; inserted markup does not), with its text and marker.
  expect(created).toHaveLength(1);
  expect(created[0]!.isConnected && root.contains(created[0]!)).toBe(true);
  expect(created[0]!.hasAttribute('data-dashboard-rerun')).toBe(true);
  expect(created[0]!.text).toBe('window.cardRuns = (window.cardRuns || 0) + 1;');
});

test('a part of the page that asks for a redraw is answered in place: claimed, and read now even with an unchanged signature', async () => {
  const root = document.createElement('div');
  root.innerHTML = '<section data-outside-help><form data-outside-form="level"><input name="x" value="saved"></form></section>';
  document.body.append(root);
  root.querySelector<HTMLInputElement>('input')!.value = 'typed and saved';
  let reads = 0;
  const controller = mountDashboardController({
    root, transport: { control: noControl }, navigate() {}, returnUrl: '/dashboard?keys', canWrite: true,
    signal: new AbortController().signal, signature: 'same', pollIntervalMs: -1,
    refresh: async () => { reads += 1; return { status: 200, title: 'Keys', body: '<section data-outside-help>Redrawn</section>', controller: 'dashboard', can_write: true, signature: 'same', poll_interval_ms: -1 }; },
  });
  const request = new happyWindow.CustomEvent(DASHBOARD_REDRAW_EVENT, { bubbles: true, cancelable: true }) as unknown as Event;
  // The saved field is still "typed": a poll would leave the card alone; the redraw does not.
  expect(root.querySelector('[data-outside-help]')!.dispatchEvent(request)).toBe(false);
  await Bun.sleep(0);
  expect(reads).toBe(1);
  expect(root.querySelector('[data-outside-help]')!.textContent).toBe('Redrawn');
  controller.dispose();
  // Disposed: nobody claims it, and the part reloads on its own.
  expect(root.querySelector('[data-outside-help]')!.dispatchEvent(new happyWindow.CustomEvent(DASHBOARD_REDRAW_EVENT, { bubbles: true, cancelable: true }) as unknown as Event)).toBe(true);
});

test('a redraw asked for while a Connect is pending runs once that Connect has answered', async () => {
  const root = document.createElement('div');
  root.innerHTML = '<form data-connect-kind="api_key"><input type="hidden" name="source" value="readwise"><input name="api_key" value="k"><button type="submit">Connect</button><span data-action-message></span></form>'
    + '<section data-outside-help><form data-outside-form="level"><input name="x" value="saved"></form></section>';
  document.body.append(root);
  root.querySelector<HTMLInputElement>('section input')!.value = 'typed and saved';
  let answer: (value: OlympusDashboardControlResult) => void = () => undefined;
  let reads = 0;
  const controller = mountDashboardController({
    root, transport: { control: () => new Promise((done) => { answer = done; }) }, navigate() {}, returnUrl: '/dashboard?keys', canWrite: true,
    signal: new AbortController().signal, signature: 'same', pollIntervalMs: -1,
    refresh: async () => { reads += 1; return { status: 200, title: 'Keys', body: '<section data-outside-help>Redrawn</section>', controller: 'dashboard', can_write: true, signature: 'same', poll_interval_ms: -1 }; },
  });
  root.querySelector<HTMLFormElement>('form[data-connect-kind]')!.requestSubmit();
  await Bun.sleep(0);
  expect(root.querySelector('section')!.dispatchEvent(new happyWindow.CustomEvent(DASHBOARD_REDRAW_EVENT, { bubbles: true, cancelable: true }) as unknown as Event)).toBe(false);
  await Bun.sleep(0);
  expect(reads).toBe(0);
  answer({ status: 400, body: { ok: false, error: { message: 'Bad key.' } } });
  // The owed redraw is scheduled after the control settles; wait for it, not for a fixed time.
  for (let waited = 0; reads === 0 && waited < 2000; waited += 10) await Bun.sleep(10);
  for (let waited = 0; root.querySelector('[data-outside-help]')!.textContent !== 'Redrawn' && waited < 2000; waited += 10) await Bun.sleep(10);
  expect(reads).toBeGreaterThan(0);
  expect(root.querySelector('[data-outside-help]')!.textContent).toBe('Redrawn');
  controller.dispose();
});

test('the serialized controller listens for the exported redraw event name', () => {
  expect(mountDashboardController.toString()).toMatch(new RegExp(`['"]${DASHBOARD_REDRAW_EVENT}['"]`));
});


for (const [state, provider, step] of [
  ['connect-dropbox', 'dropbox', '1'], ['connect-dropbox', 'dropbox', '5'],
  ['connect-dropbox-refused', 'dropbox', '1'], ['connect-venice', 'venice', '3'],
] as const) {
  test(`preview deep link reaches ${state} step ${step} without starting a connection`, () => {
    const root = document.createElement('div');
    const url = new URL(`http://localhost/dashboard?keys&controls&state=${state}&sheet=${provider}&step=${step}`);
    expect(dashboardHtmlRoutePage(url)).toBe('keys');
    root.innerHTML = renderDashboardLocalPage('keys', {
      url, view: buildDashboardPreviewView(state),
      options: { controlSessionCsrfToken: 'fixture' },
    });
    document.body.append(root);
    let calls = 0;
    const controller = mountDashboardController({ root, transport: { control: async () => { calls++; return { status: 200, body: { ok: true } }; } },
      navigate() {}, async refresh() { return undefined; }, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0 });
    const script = setupPreviewScript(provider, step).replace(/^<script>|<\/script>$/g, '');
    new Function(script)();
    happyWindow.dispatchEvent(new happyWindow.Event('DOMContentLoaded'));
    const sheet = provider === 'dropbox' ? root.querySelector<HTMLElement>('#connect-dropbox-files')!
      : root.querySelector<HTMLElement>('[data-model-card="venice"]')!;
    if (state.endsWith('refused')) {
      expect(sheet.querySelector<HTMLElement>('[data-connect-content]')!.hidden).toBe(true);
      expect(sheet.querySelector<HTMLElement>('[data-connect-error]')!.hidden).toBe(false);
      sheet.querySelector<HTMLButtonElement>('[data-connect-retry]')!.click();
      expect(sheet.querySelector<HTMLElement>('[data-connect-content]')!.hidden).toBe(false);
      expect(sheet.querySelector<HTMLElement>('[data-connect-error]')!.hidden).toBe(true);
    }
    expect(sheet.querySelector('[data-setup-counter]')!.textContent).toContain(`Step ${step} of`);
    const back = sheet.querySelector<HTMLButtonElement>('[data-setup-back]')!;
    const submit = sheet.querySelector<HTMLButtonElement>('[data-setup-submit]')!;
    expect(back.disabled).toBe(step === '1');
    expect(submit.hidden).toBe(step === '1');
    expect(back.parentElement).toBe(submit.parentElement);
    expect(calls).toBe(0);
    controller.dispose();
  });
}

test('shared footer submit respects write access, pending state and accepted keys', async () => {
  const root = document.createElement('div');
  root.innerHTML = setupStepsSheet({ id: 'key', provider: 'Venice', steps: [{ text: 'Paste key' }],
    finalForm: id => `<form id="${id}" data-connect-kind="api_key"><input type="hidden" name="source" value="venice"><input name="api_key" value="fixture"><span data-action-message></span></form>` });
  document.body.append(root);
  let complete!: (result: OlympusDashboardControlResult) => void;
  let calls = 0;
  const controller = mountDashboardController({ root, transport: { control: () => { calls++; return new Promise(resolve => { complete = resolve; }); } },
    navigate() {}, async refresh() { return undefined; }, returnUrl: 'https://gateway.test/', canWrite: false,
    signal: new AbortController().signal, pollIntervalMs: 0 });
  const submit = root.querySelector<HTMLButtonElement>('[data-setup-submit]')!;
  expect(submit.disabled).toBe(true);
  controller.update({ canWrite: true });
  expect(submit.disabled).toBe(false);
  submit.click();
  expect(calls).toBe(1);
  expect(submit.disabled).toBe(true);
  submit.click();
  expect(calls).toBe(1);
  complete({ status: 200, body: { ok: true } });
  await happyWindow.happyDOM.waitUntilComplete();
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toBe('Key saved');
  controller.dispose();
});

describe('local messaging pairing', () => {
  function messagingRoot() {
    const root = document.createElement('div');
    root.innerHTML = '<section data-source="telegram.messages" data-messaging-source="telegram"><form method="dialog" data-messaging-kind="respond" data-field="code"><input name="value" value="12345"><button type="submit">Continue</button></form><p data-messaging-status></p><div data-messaging-input></div><img data-messaging-qr hidden><div data-messaging-chats></div></section>';
    document.body.append(root);
    return root;
  }

  test('clears a login code before transport and never sends it through native control', async () => {
    const root = messagingRoot();
    let controlCalls = 0;
    let observed = '';
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', transport: {
      control: async () => { controlCalls++; return { status: 200, body: {} }; },
      messaging: async (operation, params) => {
        if (operation === 'status') return { status: 200, body: { state: 'idle' } };
        expect(operation).toBe('respond');
        expect(root.querySelector<HTMLInputElement>('input')!.value).toBe('');
        observed = params.value!;
        return { status: 200, body: { ok: true, state: 'paired' } };
      },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observed).toBe('12345');
    expect(controlCalls).toBe(0);
    controller.dispose();
  });

  test('a native transport without the local pairing method receives no secret', async () => {
    const root = messagingRoot();
    let controlCalls = 0;
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', transport: { control: async () => { controlCalls++; return { status: 200, body: {} }; } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controlCalls).toBe(0);
    expect(root.querySelector<HTMLInputElement>('input')!.value).toBe('');
    controller.dispose();
  });

  test('opens local controls through its dedicated transport and reloads the dashboard', async () => {
    const root = messagingRoot();
    const form = root.querySelector('form')!;
    delete form.dataset.messagingKind;
    form.setAttribute('data-messaging-open-controls', '');
    form.innerHTML = '<button type="submit">Open controls on this computer</button><span data-action-message></span>';
    let opened = 0;
    let controlCalls = 0;
    let navigated = '';
    const controller = mountDashboardController({ root, canWrite: false, signal: new AbortController().signal, navigate(href) { navigated = href; }, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', transport: {
      control: async () => { controlCalls++; return { status: 200, body: {} }; },
      openLocalControls: async () => { opened++; return true; },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened).toBe(1);
    expect(controlCalls).toBe(0);
    expect(navigated).toBe('http://localhost/dashboard?keys');
    controller.dispose();
  });

  test('pairing status chat previews do not replace the saved-scope picker', async () => {
    const root = messagingRoot();
    const form = root.querySelector('form')!;
    form.dataset.messagingKind = 'start';
    root.querySelector('[data-messaging-chats]')!.textContent = 'saved selection';
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', transport: {
      control: noControl,
      messaging: async () => ({ status: 200, body: { ok: true, state: 'paired', chats: [{ chatScope: 'telegram.personal:chat:1', title: 'Preview' }] } }),
    } });
    await new Promise(resolve => setTimeout(resolve, 0));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('[data-messaging-chats]')!.textContent).toBe('saved selection');
    controller.dispose();
  });

  test('whole-account selection clears previously checked chat scopes in the saved grant', async () => {
    const root = messagingRoot();
    const form = root.querySelector('form')!;
    form.dataset.messagingKind = 'scope';
    form.innerHTML = '<input type="checkbox" name="wholeAccount" checked><input type="checkbox" name="chatScope" value="telegram.personal:chat:123" checked>';
    let selection: unknown;
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', transport: {
      control: noControl,
      messaging: async (operation, params) => { if (operation === 'status') return { status: 200, body: { state: 'idle' } }; expect(operation).toBe('scope'); selection = structuredClone(params); return { status: 200, body: { ok: true } }; },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(selection).toEqual({ source: 'telegram', wholeAccount: true, chatScopes: [] });
    controller.dispose();
  });

  test('disposal cancels pairing status polling and erases the QR', async () => {
    const root = messagingRoot();
    const form = root.querySelector('form')!;
    form.dataset.messagingKind = 'start';
    let calls = 0;
    const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', transport: {
      control: noControl,
      messaging: async () => { calls++; return { status: 200, body: { ok: true, state: 'pairing', qr: 'data:image/png;base64,YQ==' } }; },
    } });
    await new Promise(resolve => setTimeout(resolve, 0));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector('img')!.hasAttribute('src')).toBe(true);
    controller.dispose();
    expect(root.querySelector('img')!.hasAttribute('src')).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1250));
    expect(calls).toBe(2);
  });
});

test('messaging cards remain visible when another source sheet opens', () => {
  const root = document.createElement('div');
  root.innerHTML = renderMessagingCard('telegram', true) + renderMessagingCard('whatsapp', true) + '<button data-sheet-toggle="#other">Connect</button><section id="other" class="sheet"></section>';
  document.body.append(root);
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, transport: { control: noControl }, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys' });
  root.querySelector<HTMLButtonElement>('[data-sheet-toggle]')!.click();
  for (const card of root.querySelectorAll('[data-messaging-source]')) {
    expect(card.getAttribute('aria-hidden')).not.toBe('true');
    expect(card.classList.contains('sheet')).toBe(false);
  }
  controller.dispose();
});

test.each(['telegram', 'whatsapp'])('mount restores %s pairing and continues polling without restarting it', async source => {
  const root = document.createElement('div'); root.innerHTML = renderMessagingCard(source as 'telegram' | 'whatsapp', true); document.body.append(root);
  const operations: string[] = [];
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, transport: { control: noControl,
    messaging: async operation => { operations.push(operation); return { status: 200, body: source === 'telegram' ? { state: 'waiting', field: 'code' } : { state: 'waiting', qr: 'data:image/png;base64,YQ==' } }; },
  }, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys' });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(operations).toEqual(['status']);
    if (source === 'telegram') expect(root.querySelector('[data-messaging-input] input')).not.toBeNull();
    else expect(root.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,YQ==');
    await new Promise(resolve => setTimeout(resolve, 1250));
    expect(operations).toEqual(['status', 'status']);
  } finally { controller.dispose(); }
});

test.each([false, true])('post-pair choice sends only explicit consent (wholeAccount=%s)', async wholeAccount => {
  const root = document.createElement('div'); root.innerHTML = renderMessagingCard('telegram', true); document.body.append(root);
  const choices: unknown[] = [];
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, transport: { control: noControl,
    messaging: async (operation, params) => {
      if (operation === 'scope') { choices.push(structuredClone(params)); return { status: 200, body: { state: 'paired' } }; }
      return { status: 200, body: { state: 'scope_selection_required', chats: [{ chatScope: 'telegram.personal:chat:101', title: 'One', kind: 'dm' }], wholeAccount: false, chatScopes: [] } };
    },
  }, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys' });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(choices).toEqual([]);
    expect(root.textContent).toContain('Nothing is being captured');
    expect(root.textContent).toContain('Pick chats (recommended)');
    expect(root.textContent).toContain('Everything in this account');
    const slot = root.querySelector('[data-messaging-chats]')!;
    const check = slot.querySelector<HTMLInputElement>('[name="chatScope"]')!;
    expect(check.checked).toBe(false);
    check.checked = true;
    const form = wholeAccount ? slot.querySelector<HTMLInputElement>('[name="wholeAccount"]')!.closest('form')! : check.closest('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(choices).toEqual([{ source: 'telegram', wholeAccount, chatScopes: wholeAccount ? [] : ['telegram.personal:chat:101'] }]);
    expect(slot.textContent).toBe('');
  } finally { controller.dispose(); }
});

test('Google JSON stays out of visible text and is checked before any provider URL opens', async () => {
  const root = document.createElement('div');
  root.innerHTML = renderDashboardLocalPage('keys', { url: new URL('http://localhost/dashboard?keys'), view: buildDashboardPreviewView('connect-google-loopback'), options: { controlSessionCsrfToken: 'fixture' } });
  document.body.append(root);
  let submitted: Record<string, unknown> | undefined;
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', pollIntervalMs: 0,
    transport: { control: async params => { submitted = params; return { status: 400, body: { ok: false, error: { message: 'Google did not accept this app key.' } } }; } },
  });
  try {
    const sheet = root.querySelector<HTMLElement>('#connect-gmail-email')!;
    const picker = sheet.querySelector<HTMLInputElement>('[data-client-file]')!;
    const file = new happyWindow.File([JSON.stringify({ installed: { client_id: '123-example.apps.googleusercontent.com', client_secret: 'fixture-upload-secret' } })], 'client_secret_fixture.json');
    const transfer = new happyWindow.DataTransfer(); transfer.items.add(file);
    picker.files = transfer.files as unknown as FileList;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(sheet.querySelector('[data-client-file-status]')!.textContent).toContain('Desktop app file ready');
    expect(sheet.outerHTML).not.toContain('fixture-upload-secret');
    const form = picker.form!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(submitted?.google_desktop).toBe(true);
    expect(submitted?.google_client_json).toContain('fixture-upload-secret');
    expect(sheet.querySelector('[data-setup-error]')!.textContent).toContain('Google did not accept');
    expect(sheet.querySelector('[data-setup-error] details')!.hasAttribute('open')).toBe(false);
    expect([...sheet.querySelectorAll<HTMLElement>('[data-setup-panel]')].every(panel => panel.hidden)).toBe(true);
    expect(sheet.outerHTML).not.toContain('fixture-upload-secret');
  } finally { controller.dispose(); }
});

test('Telegram setup hands over to private prompts, shows Cancel only during pairing, and offers error recovery', async () => {
  const root = document.createElement('div'); root.innerHTML = renderMessagingCard('telegram', true); document.body.append(root);
  let state: Record<string, unknown> = { state: 'idle' };
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', pollIntervalMs: 0,
    transport: { control: async () => ({ status: 200, body: {} }), messaging: async op => { if (op === 'start') state = { state: 'waiting', field: 'api_id' }; if (op === 'respond') state = { state: 'failed' }; return { status: 200, body: { ok: true, ...state } }; } },
  });
  try {
    await happyWindow.happyDOM.waitUntilComplete();
    const cancel = root.querySelector<HTMLElement>('[data-messaging-kind="cancel"]')!;
    expect(cancel.hidden).toBe(true);
    root.querySelector('[data-messaging-kind="start"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // Don't drain timers while pairing polls; wait only for the transport microtask.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(root.querySelector<HTMLElement>('[data-messaging-setup-intro]')!.hidden).toBe(true);
    expect(cancel.hidden).toBe(false);
    const input = root.querySelector<HTMLInputElement>('[data-messaging-input] input')!; input.value = '12345';
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancel.hidden).toBe(true);
    expect(root.querySelector('[data-pairing-error] details')!.hasAttribute('open')).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-messaging-retry]')!.click();
    expect(root.querySelector<HTMLElement>('[data-messaging-setup-intro]')!.hidden).toBe(false);
  } finally { controller.dispose(); }
});


test('Google paste inputs remain editable after refusal and clear after success', async () => {
  const root = document.createElement('div');
  root.innerHTML = renderDashboardLocalPage('keys', { url: new URL('http://localhost/dashboard?keys'), view: buildDashboardPreviewView('connect-google-loopback'), options: { controlSessionCsrfToken: 'fixture' } }); document.body.append(root);
  let success = false;
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', pollIntervalMs: 0,
    transport: { control: async () => success ? { status: 200, body: { ok: true, authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth' } } : { status: 400, body: { ok: false, error: { message: 'Check the app key.' } } } },
  });
  try {
    const sheet = root.querySelector<HTMLElement>('#connect-gmail-email')!;
    sheet.querySelector<HTMLElement>('[data-client-paste] summary')!.click();
    const id = sheet.querySelector<HTMLInputElement>('[name="client_id"]')!; id.value = 'fixture.apps.googleusercontent.com';
    const key = sheet.querySelector<HTMLInputElement>('[name="client_secret"]')!; key.value = 'fixture-manual-secret';
    id.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(key.disabled).toBe(false);
    sheet.querySelector<HTMLButtonElement>('[data-setup-retry]')!.click();
    success = true;
    id.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(key.value).not.toBe('fixture-manual-secret');
    expect(sheet.outerHTML).not.toContain('fixture-manual-secret');
  } finally { controller.dispose(); }
});

test('completed Telegram pairing still offers setup to pair again', async () => {
  const root = document.createElement('div'); root.innerHTML = renderMessagingCard('telegram', true); document.body.append(root);
  const controller = mountDashboardController({ root, canWrite: true, signal: new AbortController().signal, navigate() {}, refresh: async () => undefined, returnUrl: 'http://localhost/dashboard?keys', pollIntervalMs: 0,
    transport: { control: async () => ({ status: 200, body: {} }), messaging: async () => ({ status: 200, body: { ok: true, state: 'paired' } }) },
  });
  try { await happyWindow.happyDOM.waitUntilComplete(); expect(root.querySelector<HTMLElement>('[data-messaging-setup-intro]')!.hidden).toBe(false); }
  finally { controller.dispose(); }
});
