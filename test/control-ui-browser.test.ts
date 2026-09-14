import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import plugin, { setInertBody } from '../src/control-ui.ts';
import type {
  OlympusDashboardControlResult,
  OlympusDashboardReadResult,
} from '../src/control-ui-contract.ts';
import {
  mountDashboardController,
  mountDispositionsController,
} from '../src/control-ui/browser-controller.ts';
import { buildDispositionsPreviewView } from '../scripts/control-ui-preview.ts';
import { renderSourceDispositionsControlUi } from '../src/workers/source-dispositions.ts';
import { connectSetupSheet } from '../src/workers/dashboard/components.ts';

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

function result(body: string, signature: string, canWrite = true): OlympusDashboardReadResult {
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

  test('refreshes connected state after handoff and releases the submitted sheet and focus', async () => {
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
    expect(root.querySelector('.sheet.on')).toBeNull();
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
    let resolveRefresh!: (value: OlympusDashboardReadResult) => void;
    const pendingRefresh = new Promise<OlympusDashboardReadResult>((resolve) => { resolveRefresh = resolve; });
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

  test('poll replacement is sanitized, navigation respects modifiers, and disposal retires listeners', async () => {
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
        return result('<img src="x" onerror="globalThis.pwned=1"><script>globalThis.pwned=2</script><p id="safe">safe</p>', 'next');
      },
      replaceHtml: setInertBody,
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
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(root.querySelector('#safe')?.textContent).toBe('safe');

    abort.abort();
    const readCount = reads;
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await controller.refresh();
    expect(reads).toBe(readCount);
  });
});

describe('folder picker DOM lifetime', () => {
  test('unchanged and changed polls preserve selected folder, search, open state and focus', async () => {
    const initial = renderSourceDispositionsControlUi(buildDispositionsPreviewView(), true);
    const root = document.createElement('div');
    root.innerHTML = initial.body;
    document.body.append(root);
    const queue = [initial, { ...initial, signature: 'changed' }];
    const controller = mountDispositionsController({
      root,
      transport: { control: noControl },
      navigate() {},
      async refresh() { return queue.shift(); },
      returnUrl: 'https://gateway.test/?view=dispositions',
      canWrite: true,
      signal: new AbortController().signal,
      signature: initial.signature,
      pollIntervalMs: 0,
    });
    const finance = Array.from(root.querySelectorAll<HTMLElement>('.folder-row'))
      .find((row) => row.dataset.path === '/2 Areas/Finances')!;
    finance.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const search = root.querySelector<HTMLInputElement>('[data-folder-search]')!;
    search.value = 'fin';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const choice = root.querySelector<HTMLButtonElement>('[data-picker-state="metadata_only"]')!;
    choice.focus();

    await controller.refresh();
    expect(root.querySelector('[data-picker-state="metadata_only"]')).toBe(choice);
    expect(document.activeElement).toBe(choice);
    expect(root.querySelector<HTMLFormElement>('form')?.dataset.selectedPath).toBe('/2 Areas/Finances');

    await controller.refresh();
    expect(root.querySelector<HTMLInputElement>('[data-folder-search]')?.value).toBe('fin');
    expect(root.querySelector<HTMLFormElement>('form')?.dataset.selectedPath).toBe('/2 Areas/Finances');
    expect(root.querySelector<HTMLDetailsElement>('details')?.open).toBe(true);
    expect(root.querySelector('[data-picker-state="metadata_only"]')).not.toBe(choice);
    expect((document.activeElement as HTMLElement | null)?.dataset.pickerState).toBe('metadata_only');
    controller.dispose();
  });

  test('a failed save and ordinary poll retain dirty folder choices', async () => {
    const initial = renderSourceDispositionsControlUi(buildDispositionsPreviewView(), true);
    const root = document.createElement('div');
    root.innerHTML = initial.body;
    document.body.append(root);
    let reads = 0;
    const controller = mountDispositionsController({
      root,
      transport: { control: async () => ({ status: 500, body: { error: { message: 'Save failed safely.' } } }) },
      navigate() {},
      async refresh() { reads += 1; return { ...initial, signature: 'changed' }; },
      returnUrl: 'https://gateway.test/?view=dispositions',
      canWrite: true,
      signal: new AbortController().signal,
      signature: initial.signature,
      pollIntervalMs: 0,
    });
    const finance = Array.from(root.querySelectorAll<HTMLElement>('.folder-row'))
      .find((row) => row.dataset.path === '/2 Areas/Finances')!;
    finance.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-picker-state="exclude"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const form = root.querySelector<HTMLFormElement>('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(root.querySelector('#save-message')?.textContent).toBe('Save failed safely.');
    expect(form.querySelector<HTMLInputElement>('input[value="exclude"][data-path="/2 Areas/Finances"]')?.checked).toBe(true);

    await controller.refresh();
    expect(reads).toBe(0);
    expect(root.contains(form)).toBe(true);
    expect(form.querySelector<HTMLInputElement>('input[value="exclude"][data-path="/2 Areas/Finances"]')?.checked).toBe(true);
    controller.dispose();
  });

  test('a folder edit made while refresh is pending is not replaced by the response', async () => {
    const initial = renderSourceDispositionsControlUi(buildDispositionsPreviewView(), true);
    const root = document.createElement('div');
    root.innerHTML = initial.body;
    document.body.append(root);
    let resolveRefresh!: (value: OlympusDashboardReadResult) => void;
    const pendingRefresh = new Promise<OlympusDashboardReadResult>((resolve) => { resolveRefresh = resolve; });
    const controller = mountDispositionsController({
      root,
      transport: { control: noControl },
      navigate() {},
      refresh: () => pendingRefresh,
      returnUrl: 'https://gateway.test/?view=dispositions',
      canWrite: true,
      signal: new AbortController().signal,
      signature: initial.signature,
      pollIntervalMs: 0,
    });

    const refreshing = controller.refresh();
    const finance = Array.from(root.querySelectorAll<HTMLElement>('.folder-row'))
      .find((row) => row.dataset.path === '/2 Areas/Finances')!;
    finance.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-picker-state="exclude"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    resolveRefresh({ ...initial, signature: 'next' });
    await refreshing;

    const form = root.querySelector<HTMLFormElement>('form[data-dispositions-source]')!;
    expect(form.dataset.selectedPath).toBe('/2 Areas/Finances');
    expect(form.querySelector<HTMLInputElement>('input[value="exclude"][data-path="/2 Areas/Finances"]')?.checked)
      .toBe(true);
    controller.dispose();
  });
});

describe('native host subscription', () => {
  test('an unrelated host snapshot does not reload the mounted page', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    let page: { mount(container: HTMLElement, context: never): { dispose(): void } } | undefined;
    let subscriber: (() => void) | undefined;
    let reads = 0;
    const connection = { connected: true, canRead: true, canWrite: true };
    const host = {
      connection,
      request: async () => {
        reads += 1;
        return result('<p>stable</p>', 'stable');
      },
      subscribe(listener: () => void) { subscriber = listener; return () => { subscriber = undefined; }; },
      navigation: { openPage() {}, pageHref: () => 'https://gateway.test/?view=home' },
      ui: {
        registerPage(value: typeof page) { page = value; return () => {}; },
        registerNavigation() { return () => {}; },
      },
    };
    const disposePlugin = plugin.activate(host as never) as () => void;
    const mounted = page!.mount(container, {
      host,
      signal: new AbortController().signal,
      props: { view: 'home' },
      presented: true,
    } as never);
    await happyWindow.happyDOM.waitUntilComplete();
    expect(reads).toBe(1);
    subscriber?.();
    await happyWindow.happyDOM.waitUntilComplete();
    expect(reads).toBe(1);
    mounted.dispose();
    disposePlugin();
  });
});

test('Setup card background navigates while embedded controls remain independent', () => {
  const root = document.createElement('div'); root.innerHTML = '<div data-dashboard-href="/dashboard?source=dropbox.files"><span class="card-copy">Dropbox status</span><button type="button">Connect</button></div>'; document.body.append(root);
  const navigation: string[] = [];
  const controller = mountDashboardController({ root, transport: { async control() { return { status: 200, body: { ok: true } }; } }, navigate: (href) => navigation.push(href), refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true, signal: new AbortController().signal, pollIntervalMs: 0 });
  root.querySelector('.card-copy')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  root.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  expect(navigation).toEqual(['/dashboard?source=dropbox.files']); controller.dispose();
});

describe('folder scope before ingestion', () => {
  function scopeRoot(canWrite = true) {
    const view = buildDispositionsPreviewView();
    view.sources = [];
    view.folder_scopes = [{
      source_id: 'google_drive.docs', disposition_source_id: 'google_drive.personal', label: 'Google Drive',
      connected: true, status: 'scope_pending', account_generation: 'account-one', scope_revision: 'revision-one',
    }];
    const rendered = renderSourceDispositionsControlUi(view, canWrite);
    const root = document.createElement('div'); root.innerHTML = rendered.body; document.body.append(root);
    return { root, form: root.querySelector<HTMLFormElement>('form[data-folder-scope-source]')! };
  }

  function page(key = 'opaque-folder-A', revision = 'revision-one'): OlympusDashboardReadResult {
    return {
      ...result('', 'browse'), controller: 'dispositions', scope_browser: {
        source_id: 'google_drive.docs', account_generation: 'account-one', scope_revision: revision,
        status: 'scope_pending', nodes: [{ key, name: key === 'opaque-folder-A' ? 'Work <img src=x>' : 'Child', kind: 'folder', has_children: true, selectable: true }],
        selections: [], whole_account_selected: false,
      },
    };
  }

  function click(root: ParentNode, selector: string) {
    const target = root.querySelector<HTMLElement>(selector);
    expect(target).not.toBeNull();
    target!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  test('opens Dropbox directly, switches providers without ingestion, and routes native exit links', async () => {
    const view = buildDispositionsPreviewView(); view.sources = [];
    view.folder_scopes = [
      { source_id: 'google_drive.docs', disposition_source_id: 'google_drive.personal', label: 'Google Drive', connected: true, status: 'scope_pending' },
      { source_id: 'dropbox.files', disposition_source_id: 'dropbox.personal', label: 'Dropbox', connected: true, status: 'scope_pending', account_generation: 'account-one', scope_revision: 'revision-one' },
    ];
    const root = document.createElement('div'); root.innerHTML = renderSourceDispositionsControlUi(view, true, 'dropbox.files').body; document.body.append(root);
    const reads: unknown[] = []; const writes: unknown[] = []; const navigation: string[] = [];
    const controller = mountDispositionsController({ root,
      transport: { async read(params) { reads.push(params); const response = page(); response.scope_browser!.source_id = params.source_id as 'dropbox.files'; return response; }, async control(params) { writes.push(params); return { status: 200, body: { ok: true } }; } },
      navigate: (href) => navigation.push(href), refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    const drive = root.querySelector<HTMLElement>('[data-scope-panel="google_drive.docs"]')!;
    const dropbox = root.querySelector<HTMLElement>('[data-scope-panel="dropbox.files"]')!;
    expect(dropbox.hidden).toBe(false); expect(drive.hidden).toBe(true);
    expect(Array.from(dropbox.querySelectorAll('.location'), (node) => node.textContent)).toEqual(['◆Google Drive', '◆Dropbox']);
    expect(reads).toHaveLength(1);
    await happyWindow.happyDOM.waitUntilComplete();
    click(dropbox, '[data-scope-select]'); click(dropbox, '[data-scope-state="metadata_only"]');
    click(dropbox, '[data-scope-switch="google_drive.docs"]');
    await happyWindow.happyDOM.waitUntilComplete();
    expect(drive.hidden).toBe(false); expect(dropbox.hidden).toBe(true);
    const connect = drive.querySelector<HTMLAnchorElement>('.scope-back a')!;
    connect.dataset.olympusNav = connect.getAttribute('href')!; connect.href = 'https://gateway.test/native-page';
    connect.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(navigation).toEqual(['/dashboard?source=google_drive.docs']);
    click(root, '.dnav a[href="/dashboard"]');
    click(drive, '.scope-back a');
    expect(navigation.slice(1)).toEqual(['/dashboard', '/dashboard?source=google_drive.docs']);
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    connect.dispatchEvent(modified); expect(modified.defaultPrevented).toBe(false);
    click(drive, '[data-scope-switch="dropbox.files"]');
    expect(dropbox.hidden).toBe(false);
    expect(dropbox.querySelector('.scope-folder-status')?.textContent).toBe('Metadata only');
    expect(reads).toHaveLength(2); expect(writes).toHaveLength(0);
    controller.dispose();
  });

  test('Locations lists connected providers only while a direct disconnected page still offers Connect', () => {
    const view = buildDispositionsPreviewView(); view.sources = [];
    view.folder_scopes = [
      { source_id: 'google_drive.docs', disposition_source_id: 'google_drive.personal', label: 'Google Drive', connected: false, status: 'scope_pending' },
      { source_id: 'dropbox.files', disposition_source_id: 'dropbox.personal', label: 'Dropbox', connected: true, status: 'scope_pending' },
    ];
    const root = document.createElement('div');
    root.innerHTML = renderSourceDispositionsControlUi(view, true, 'dropbox.files').body;
    const dropbox = root.querySelector('[data-scope-panel="dropbox.files"]')!;
    expect(Array.from(dropbox.querySelectorAll('.location'), node => node.textContent)).toEqual(['◆Dropbox']);
    expect(root.querySelector('[data-scope-switch="google_drive.docs"]')).toBeNull();
    root.innerHTML = renderSourceDispositionsControlUi(view, true, 'google_drive.docs').body;
    const drive = root.querySelector<HTMLElement>('[data-scope-panel="google_drive.docs"]')!;
    expect(drive.hidden).toBe(false);
    expect(drive.textContent).toContain('Connect Google Drive');
  });

  test('folder siblings sort alphabetically with natural numbers at every depth', async () => {
    const { root } = scopeRoot();
    const controller = mountDispositionsController({
      root, transport: { async read(params) {
        const response = page();
        const parent = 'parent_key' in params ? params.parent_key : undefined;
        response.scope_browser!.nodes = (parent ? ['Child 10', 'child 2', 'Apple'] : ['Zebra', 'alpha 10', 'Alpha 2', 'alpha'])
          .map(name => ({ key: `${parent || 'root'}/${name}`, name, kind: 'folder' as const, selectable: true, has_children: !parent }));
        return response;
      }, async control() { throw new Error('Browsing must not change scope'); } },
      navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    expect(Array.from(root.querySelectorAll('[data-scope-select]'), n => n.textContent)).toEqual(['alpha', 'Alpha 2', 'alpha 10', 'Zebra']);
    click(root, '[data-scope-open]'); await happyWindow.happyDOM.waitUntilComplete();
    expect(Array.from(root.querySelectorAll('[data-scope-select]'), n => n.textContent)).toEqual(['alpha', 'Apple', 'child 2', 'Child 10', 'Alpha 2', 'alpha 10', 'Zebra']);
    controller.dispose();
  });

  test('loads folder names when opened while ingestion still requires explicit approval', async () => {
    const { root, form } = scopeRoot();
    const reads: unknown[] = []; const writes: unknown[] = []; const navigation: string[] = [];
    const controller = mountDispositionsController({
      root, transport: { async read(params) { reads.push(params); return page(); }, async control(params) { writes.push(params); return { status: 200, body: { ok: true } }; } },
      navigate: (href) => navigation.push(href), refresh: async () => undefined,
      returnUrl: 'https://gateway.test/?view=dispositions', canWrite: true, signal: new AbortController().signal, pollIntervalMs: 0,
    });
    expect(root.querySelector('.finder-window .finder-sidebar')).not.toBeNull();
    expect(root.querySelector('.finder-window .finder-main')).not.toBeNull();
    expect(root.querySelector('.finder-window .finder-inspector')).not.toBeNull();
    expect(reads).toHaveLength(1); expect(writes).toHaveLength(0);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(writes).toHaveLength(0);
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    expect(reads).toEqual([{ view: 'dispositions', action: 'browse_folder_scope', source_id: 'google_drive.docs' }]);
    expect(root.querySelector('[data-scope-nodes] img')).toBeNull();
    expect(root.querySelector('[data-scope-select]')?.textContent).toBe('Work <img src=x>');
    const folder = root.querySelector<HTMLButtonElement>('[data-scope-select]')!; folder.focus();
    click(root, '[data-scope-select]');
    expect(document.activeElement).toBe(folder);
    click(root, '[data-scope-state="metadata_only"]');
    expect(writes).toHaveLength(0);
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(writes).toEqual([{
      action: 'approve_source_scope_and_start', source_id: 'google_drive.docs', account_generation: 'account-one',
      expected_scope_revision: 'revision-one', selections: [{ key: 'opaque-folder-A', state: 'metadata_only', ancestor_keys: [] }],
      whole_account: false, explicit_whole_account_confirmation: false,
    }]);
    expect(navigation).toEqual(['/dashboard?source=google_drive.docs']);
    controller.dispose();
  });

  test('shows loading, avoids duplicate automatic requests, and Update preserves draft choices', async () => {
    const { root, form } = scopeRoot();
    let complete!: (value: ReturnType<typeof page>) => void;
    const pending = new Promise<ReturnType<typeof page>>(resolve => { complete = resolve; });
    let reads = 0; let writes = 0;
    const controller = mountDispositionsController({ root,
      transport: { read: async () => { reads += 1; return pending; }, async control() { writes += 1; return { status: 200, body: { ok: true } }; } },
      navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    expect(reads).toBe(1);
    expect(root.querySelector<HTMLElement>('[data-scope-loading]')?.hidden).toBe(false);
    expect(root.querySelector('[data-scope-nodes]')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('[data-scope-browse-root]')?.textContent).toBe('Update');
    controller.update({ canWrite: true });
    expect(reads).toBe(1);
    expect(writes).toBe(0);
    complete(page()); await happyWindow.happyDOM.waitUntilComplete();
    expect(root.querySelector<HTMLElement>('[data-scope-loading]')?.hidden).toBe(true);
    click(root, '[data-scope-select]'); click(root, '[data-scope-state="metadata_only"]');
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    expect(reads).toBe(2);
    expect(root.querySelector('.scope-folder-status')?.textContent).toBe('Metadata only');
    expect(writes).toBe(0);
    expect(form.querySelector('[data-scope-nodes]')?.getAttribute('aria-busy')).toBe('false');
    controller.dispose();
  });

  test('never automatically loads folders for a read-only or hidden page', async () => {
    for (const input of [{ canWrite: false, presented: true }, { canWrite: true, presented: false }]) {
      const { root } = scopeRoot(); let reads = 0;
      const controller = mountDispositionsController({ root,
        transport: { async read() { reads += 1; return page(); }, async control() { throw new Error('unexpected mutation'); } },
        navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', ...input,
        signal: new AbortController().signal, pollIntervalMs: 0,
      });
      await happyWindow.happyDOM.waitUntilComplete();
      expect(reads).toBe(0); controller.dispose();
    }
  });

  test('whole-account use needs a separate explicit confirmation and read-only callers cannot activate', async () => {
    const { root, form } = scopeRoot(); let writes = 0;
    const controller = mountDispositionsController({ root,
      transport: { read: async () => page(), async control() { writes += 1; return { status: 200, body: { ok: true } }; } },
      navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    const whole = root.querySelector<HTMLInputElement>('[data-scope-whole-account]')!;
    whole.checked = true; whole.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(writes).toBe(0);
    const confirmation = root.querySelector<HTMLInputElement>('[data-scope-whole-confirm]')!;
    confirmation.checked = true; confirmation.dispatchEvent(new Event('input', { bubbles: true }));
    controller.update({ canWrite: false });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(writes).toBe(0);
    controller.update({ canWrite: true });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await happyWindow.happyDOM.waitUntilComplete();
    expect(writes).toBe(1); controller.dispose();
  });

  test('keeps choices across lazy navigation and enforces inherited metadata-only controls', async () => {
    const { root, form } = scopeRoot(); const reads: unknown[] = []; const writes: unknown[] = [];
    const controller = mountDispositionsController({ root,
      transport: { async read(params) { reads.push(params); return page('parent_key' in params && params.parent_key ? 'opaque-folder-B' : 'opaque-folder-A'); }, async control(params) { writes.push(params); return { status: 200, body: { ok: true } }; } },
      navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    click(root, '[data-scope-select]'); click(root, '[data-scope-state="metadata_only"]');
    click(root, '[data-scope-open]'); await happyWindow.happyDOM.waitUntilComplete();
    expect(reads.at(-1)).toEqual({ view: 'dispositions', action: 'browse_folder_scope', source_id: 'google_drive.docs', parent_key: 'opaque-folder-A' });
    click(root, '[data-scope-select="opaque-folder-B"]');
    expect(root.querySelector<HTMLButtonElement>('[data-scope-state="ingest"]')!.disabled).toBe(true);
    click(root, '[data-scope-state="exclude"]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await happyWindow.happyDOM.waitUntilComplete();
    expect((writes[0] as { selections: unknown[] }).selections).toEqual([
      { key: 'opaque-folder-A', state: 'metadata_only', ancestor_keys: [] },
      { key: 'opaque-folder-B', state: 'exclude', ancestor_keys: ['opaque-folder-A'] },
    ]);
    controller.dispose();
  });

  test.each([true, false])('narrowing a parent saves inherited restrictions for saved children, expanded=%s', async (expandChild) => {
    const { root, form } = scopeRoot(); const writes: unknown[] = [];
    const controller = mountDispositionsController({ root,
      transport: { async read(params) {
        const response = page('parent_key' in params && params.parent_key ? 'opaque-folder-B' : 'opaque-folder-A');
        response.scope_browser!.selections = [{ key: 'opaque-folder-A', state: 'ingest', ancestor_keys: [] }, { key: 'opaque-folder-B', state: 'ingest', ancestor_keys: ['opaque-folder-A'] }];
        return response;
      }, async control(params) { writes.push(params); return { status: 200, body: { ok: true } }; } },
      navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    if (expandChild) { click(root, '[data-scope-open]'); await happyWindow.happyDOM.waitUntilComplete(); }
    click(root, '[data-scope-select="opaque-folder-A"]'); click(root, '[data-scope-state="metadata_only"]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await happyWindow.happyDOM.waitUntilComplete();
    expect((writes[0] as { selections: unknown[] }).selections).toEqual([
      { key: 'opaque-folder-A', state: 'metadata_only', ancestor_keys: [] },
      { key: 'opaque-folder-B', state: 'metadata_only', ancestor_keys: ['opaque-folder-A'] },
    ]);
    controller.dispose();
  });

  test('refuses stale account/scope responses and never activates merely by cancelling', async () => {
    const { root, form } = scopeRoot(); let count = 0; let writes = 0;
    const controller = mountDispositionsController({ root,
      transport: { async read() { count += 1; return page('opaque-folder-A', count === 1 ? 'revision-one' : 'revision-two'); }, async control() { writes += 1; return { status: 200, body: { ok: true } }; } },
      navigate() {}, refresh: async () => undefined, returnUrl: 'https://gateway.test/', canWrite: true,
      signal: new AbortController().signal, pollIntervalMs: 0,
    });
    click(root, '[data-scope-browse-root]'); await happyWindow.happyDOM.waitUntilComplete();
    click(root, '[data-scope-select]'); click(root, '[data-scope-state="ingest"]');
    click(root, '[data-scope-open]'); await happyWindow.happyDOM.waitUntilComplete();
    expect(root.querySelector('[data-scope-message]')?.textContent).toContain('changed');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); expect(writes).toBe(0);
    click(root, '[data-scope-cancel]'); expect(writes).toBe(0); controller.dispose();
  });
});
