import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { OlympusDashboardControlResult } from '../src/control-ui-contract.ts';
import { mountDashboardController, type OlympusDashboardPageRead } from '../src/control-ui/browser-controller.ts';
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

describe('Download now for the transcription model', () => {
  test('sends the transcription model, says Starting… while it waits, then the server\'s words or a model-aware fallback', async () => {
    for (const body of [{ ok: true, status_message: 'Already downloaded.' }, { ok: true }] as const) {
      const root = document.createElement('div');
      root.innerHTML = '<form data-model-retry="transcription"><button type="submit">Download now</button>'
        + '<span data-action-message></span></form>';
      document.body.append(root);
      const sent: unknown[] = [];
      let pending = '';
      const controller = mountDashboardController({
        root,
        transport: {
          control: async (params) => {
            sent.push(params);
            pending = root.querySelector('[data-action-message]')?.textContent ?? '';
            return { status: 200, body };
          },
        },
        navigate() {},
        async refresh() { return undefined; },
        returnUrl: 'https://gateway.test/?view=setup',
        canWrite: true,
        signal: new AbortController().signal,
        pollIntervalMs: 0,
      });
      root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await happyWindow.happyDOM.waitUntilComplete();
      expect(sent).toEqual([{ action: 'retry_model', model: 'transcription' }]);
      expect(pending).toBe('Starting…');
      expect(root.querySelector('[data-action-message]')?.textContent)
        .toBe(body.status_message ?? 'Started. This row updates as it goes.');
      controller.dispose();
      root.remove();
    }
  });
});

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
