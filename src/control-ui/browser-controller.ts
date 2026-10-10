import type {
  OlympusDashboardControlParams,
  OlympusDashboardControlResult,
} from '../control-ui-contract.ts';

/** One re-read of the page the controller runs on: its inert body and the facts the poll compares. */
export interface OlympusDashboardPageRead {
  status: number;
  title: string;
  /** The page root's inner markup, scripts never evaluated. */
  body: string;
  controller: 'dashboard';
  can_write: boolean;
  /** Stable digest of the rendered state, used to avoid needless DOM replacement. */
  signature: string;
  poll_interval_ms: number;
}

export interface OlympusDashboardTransport {
  control(params: OlympusDashboardControlParams): Promise<OlympusDashboardControlResult>;
  /** The control-session exchange: a pasted worker token for a session cookie. */
  unlock?(workerToken: string): Promise<{ ok: boolean; csrf_token?: string }>;
  lock?(): Promise<boolean>;
  renew?(): Promise<void>;
}

export interface OlympusDashboardRefresh {
  (): Promise<OlympusDashboardPageRead | undefined>;
}

export interface OlympusBrowserControllerOptions {
  root: HTMLElement | ShadowRoot;
  transport: OlympusDashboardTransport;
  navigate: (href: string) => void;
  refresh: OlympusDashboardRefresh;
  returnUrl: string;
  canWrite: boolean;
  signal: AbortSignal;
  presented?: boolean;
  signature?: string;
  pollIntervalMs?: number;
  csrfToken?: string;
  authority?: 'worker-session';
}

export interface OlympusBrowserController {
  refresh(): Promise<void>;
  update(input: { canWrite: boolean; presented?: boolean; signature?: string; pollIntervalMs?: number }): void;
  dispose(): void;
}

/**
 * The browser behavior of the computer's own server-rendered pages (Keys,
 * Agents, Build a connector: dashboard/pages/local.ts): their forms, sheets,
 * copy buttons, the control-session gate and the poll. It is deliberately
 * self-contained: the page serializes this trusted function into its own
 * HTML (components.ts standaloneDashboardControllerScript).
 */
/** How long the accent outline stays on the place an open link landed (theme.ts `.landed` fades it first). */
export const LANDED_HIGHLIGHT_MS = 4000;

export function mountDashboardController(options: OlympusBrowserControllerOptions): OlympusBrowserController {
  let canWrite = options.canWrite;
  let csrfToken = options.csrfToken || '';
  let signature = options.signature || '';
  let pollIntervalMs = options.pollIntervalMs || 15_000;
  let interval: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let disposed = false;
  let deferredSince = 0;
  let presented = options.presented !== false;
  /**
   * A start this controller performed is still waiting for the provider (or
   * the server) to report the connection. Only used to decide whether coming
   * back to the page deserves one authoritative read; every other guard on
   * `refreshNow` still applies to it.
   */
  let awaitingAuthorizationReturn = false;
  const root = options.root;
  const submittedFormValues = new WeakMap<HTMLFormElement, Record<string, string>>();
  const startedFromSheet = new WeakSet<HTMLFormElement>();
  const pendingForms = new WeakSet<HTMLFormElement>();
  let pendingFormCount = 0;

  function query<T extends Element = Element>(selector: string): T | null {
    return root.querySelector(selector) as T | null;
  }

  function queryAll<T extends Element = Element>(selector: string): T[] {
    return Array.from(root.querySelectorAll(selector)) as T[];
  }

  /** Show or hide one sheet and keep every toggle that names it in step. */
  function setSheetOpen(sheet: HTMLElement, open: boolean): void {
    sheet.classList.toggle('on', open);
    sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (!sheet.id) return;
    queryAll<HTMLElement>('[data-sheet-toggle]').forEach((toggle) => {
      if (toggle.dataset.sheetToggle === `#${sheet.id}`) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function say(form: ParentNode, message: string): void {
    const slot = form.querySelector('[data-action-message]');
    if (slot) slot.textContent = message;
  }

  function errorMessage(result: OlympusDashboardControlResult): string {
    const error = result.body.error;
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim() !== '') return message;
    }
    return 'Request failed.';
  }

  function applyWriteCapability(): void {
    root.querySelectorAll<HTMLFormElement>(
      'form[data-connect-kind],form[data-model-check],form[data-agent-kind]',
    ).forEach((form) => {
      // A form whose request is still outstanding keeps its submit controls
      // disabled, so a second click cannot issue a second transport call,
      // without taking the caret out of the fields the owner is still typing.
      const pending = pendingForms.has(form) || form.dataset.keyAccepted === 'true';
      form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input:not([type="hidden"])')
        .forEach((control) => {
          if (control.dataset.olympusOriginallyDisabled === undefined) {
            control.dataset.olympusOriginallyDisabled = control.disabled ? 'true' : 'false';
          }
          const oauthUnavailable = form.hasAttribute('data-native-oauth-unavailable');
          if ((pending && isSubmitControl(control)) || !canWrite || oauthUnavailable) {
            control.disabled = true;
            control.setAttribute('aria-disabled', 'true');
          } else {
            control.disabled = control.dataset.olympusOriginallyDisabled === 'true';
            if (!control.disabled) control.removeAttribute('aria-disabled');
          }
        });
    });
  }

  /**
   * Only the acts a form can submit are held for its own pending request —
   * never the fields beside them, which the owner may still be typing in.
   */
  function isSubmitControl(control: HTMLButtonElement | HTMLInputElement): boolean {
    const type = (control.getAttribute('type') || '').toLowerCase();
    if (control instanceof HTMLButtonElement) return type === '' || type === 'submit';
    return type === 'submit';
  }

  function setFormPending(form: HTMLFormElement, pending: boolean, message?: string): void {
    if (pending) {
      if (!pendingForms.has(form)) pendingFormCount++;
      pendingForms.add(form);
      form.setAttribute('aria-busy', 'true');
      if (message !== undefined) say(form, message);
    } else {
      if (pendingForms.has(form)) pendingFormCount--;
      pendingForms.delete(form);
      form.removeAttribute('aria-busy');
    }
    applyWriteCapability();
  }

  /**
   * What the owner watches while the request is outstanding, chosen per action
   * so the pending state names the actual work instead of a generic wait.
   */
  function pendingMessage(params: OlympusDashboardControlParams): string {
    switch (params.action) {
      case 'start_oauth': return 'Connecting…';
      case 'connect_api_key': return 'Validating the key…';
      default: return 'Working…';
    }
  }

  /**
   * Actionable replacement for the old "Done. Waiting for the next refresh."
   * It says what just happened and what the owner should expect next; it never
   * claims the connection is live, which only the server's card may report.
   */
  function successMessage(params: OlympusDashboardControlParams): string {
    switch (params.action) {
      case 'connect_api_key': return 'Key accepted. This card updates when Olympus confirms the connection.';
      case 'start_oauth': return 'Waiting for authorization. This card updates when the connection completes.';
      default: return 'Saved.';
    }
  }

  function unreleasedMessage(action: OlympusDashboardControlParams['action']): string {
    return action === 'connect_api_key'
      ? 'Key accepted. Your newer entry is still in the form — press Connect to submit it.'
      : 'Sent. Your newer entry is still in the form.';
  }

  function clearAuthorizationFallback(form: ParentNode): void {
    const slot = form.querySelector('[data-authorization-fallback]');
    if (slot) slot.textContent = '';
  }

  function showAuthorizationFallback(form: ParentNode, url: string): void {
    const slot = form.querySelector('[data-authorization-fallback]');
    if (!slot || !url.startsWith('https://')) return;
    slot.textContent = '';
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'hint';
    link.textContent = "If a new tab didn't open, open it here";
    slot.appendChild(link);
  }

  function nativeExternalLinkPoster(): ((message: unknown) => void) | undefined {
    // OpenClaw's native Control UI host installs this documented WebKit bridge.
    // Probe it here so the standalone browser keeps its normal popup behavior.
    try {
      const handler = (window as unknown as {
        webkit?: { messageHandlers?: { openclawLink?: { postMessage?: (message: unknown) => void } } };
      }).webkit?.messageHandlers?.openclawLink;
      if (!handler || typeof handler.postMessage !== 'function') return undefined;
      return handler.postMessage.bind(handler);
    } catch {
      return undefined;
    }
  }

  function openAuthorizationExternally(url: string): boolean {
    const postMessage = nativeExternalLinkPoster();
    if (!postMessage) return false;
    try {
      // Match OpenClaw's native handoff helper: parse before crossing the
      // bridge and pass the canonical URL to the host validator.
      postMessage({ type: 'open-link', url: new URL(url).href, target: 'external' });
      return true;
    } catch {
      return false;
    }
  }

  function openAuthorizationTab(): Window | null {
    // WKWebView intentionally blocks script-created windows in the native
    // host. Let its trusted bridge launch the provider in the default browser
    // once the Gateway returns the URL instead of reserving a dead tab.
    if (nativeExternalLinkPoster()) return null;
    let tab: Window | null = null;
    try { tab = window.open('', '_blank'); } catch { tab = null; }
    if (tab) {
      try { tab.opener = null; } catch { /* already isolated */ }
    }
    return tab;
  }

  function closeAuthorizationTab(tab: Window | null): void {
    if (!tab) return;
    try { tab.close(); } catch { /* already closed */ }
  }

  function formRecord(form: HTMLFormElement): Record<string, string> {
    return Object.fromEntries(
      Array.from(new FormData(form).entries())
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }

  function sameFormRecord(form: HTMLFormElement, expected: Record<string, string>): boolean {
    const actual = formRecord(form);
    const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    return [...keys].every((key) => actual[key] === expected[key]);
  }

  /**
   * Release the panel that carried a submit the transport has now answered.
   * Only the submitted form is touched, and only while it still holds exactly
   * what was submitted: anything typed since the request began is the owner's
   * newer work and is left alone for an explicit resubmit.
   */
  function releaseSubmittedForm(
    form: HTMLFormElement,
    submittedValues: Record<string, string> | undefined,
  ): boolean {
    const sheet = form.closest<HTMLElement>('.sheet');
    const unchanged = submittedValues !== undefined && sameFormRecord(form, submittedValues);
    if (!unchanged) return false;
    // The submitted values are now owned by the backend, so clearing this
    // form's secret (and the rest of the values it submitted) is not data
    // loss. Reset before the panel is released so a password/client secret
    // cannot become a reflected HTML value attribute on a later DOM
    // serialization. Other forms, and their unsaved input, are untouched.
    form.reset();
    const active = activeElement();
    if (sheet) {
      sheet.classList.remove('on');
      sheet.setAttribute('aria-hidden', 'true');
      if (sheet.id) {
        queryAll<HTMLElement>('[data-sheet-toggle]').forEach((toggle) => {
          if (toggle.dataset.sheetToggle === `#${sheet.id}`) {
            toggle.setAttribute('aria-expanded', 'false');
          }
        });
      }
    }
    if (active && (active === form || form.contains(active)) && active instanceof HTMLElement) {
      active.blur();
    }
    return true;
  }

  function controlParams(form: HTMLFormElement): OlympusDashboardControlParams | undefined {
    if (form.hasAttribute('data-model-check')) return { action: 'check_model_setup' };
    const body = formRecord(form);
    const connect = form.dataset.connectKind;
    if (connect === 'oauth') {
      return {
        action: 'start_oauth',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'start_oauth' }>['source'],
        ...(body.client_id ? { client_id: body.client_id } : {}),
        ...(body.client_secret ? { client_secret: body.client_secret } : {}),
      };
    }
    if (connect === 'api_key') {
      return {
        action: 'connect_api_key',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'connect_api_key' }>['source'],
        api_key: body.api_key || '',
      };
    }
    return undefined;
  }

  async function unlock(form: HTMLFormElement): Promise<void> {
    const field = form.querySelector<HTMLInputElement>('[data-dashboard-control-token]');
    const pasted = field?.value.trim() || '';
    if (!pasted) {
      say(form, 'Paste the worker bearer token.');
      field?.focus();
      return;
    }
    if (pasted.startsWith('dash_')) {
      say(form, 'That is the read-only view token; use the worker bearer token from setup.');
      field!.value = '';
      field?.focus();
      return;
    }
    if (!options.transport.unlock) return;
    say(form, 'Unlocking…');
    const result = await options.transport.unlock(pasted);
    field!.value = '';
    if (!result.ok || !result.csrf_token) {
      say(form, 'That token was not accepted.');
      return;
    }
    csrfToken = result.csrf_token;
    canWrite = true;
    applyWriteCapability();
    await refreshNow(true);
  }

  async function lock(form: HTMLFormElement): Promise<void> {
    if (!options.transport.lock) return;
    say(form, 'Locking…');
    if (!await options.transport.lock()) {
      say(form, 'Could not lock.');
      return;
    }
    csrfToken = '';
    canWrite = false;
    applyWriteCapability();
    await refreshNow(true);
  }

  async function submitControl(
    form: HTMLFormElement,
    authorizationTab: Window | null,
    submittedValues?: Record<string, string>,
  ): Promise<void> {
    if (!canWrite && !csrfToken) {
      closeAuthorizationTab(authorizationTab);
      say(form, 'Your OpenClaw connection has read-only access.');
      return;
    }
    const params = controlParams(form);
    if (!params) {
      closeAuthorizationTab(authorizationTab);
      return;
    }
    if (pendingForms.has(form) || form.dataset.keyAccepted === 'true') {
      // One request per form in flight: the duplicate click is not work.
      closeAuthorizationTab(authorizationTab);
      return;
    }
    if (params.action === 'start_oauth') clearAuthorizationFallback(form);
    // A form that words its own wait ("Checking Dropbox…") says that instead.
    setFormPending(form, true, form.dataset.pendingMessage || pendingMessage(params));
    let result: OlympusDashboardControlResult;
    try {
      result = await options.transport.control(params);
    } catch {
      closeAuthorizationTab(authorizationTab);
      say(form, 'Could not reach Olympus.');
      return;
    } finally {
      // Only the request was pending; answering it is the moment the form is
      // free again, and holding it disabled any longer is what kept the
      // released control looking focused to the refresh guards.
      setFormPending(form, false);
      if (params.action !== 'start_oauth') submittedFormValues.delete(form);
    }
    if (result.status === 401 || result.status === 403) {
      closeAuthorizationTab(authorizationTab);
      if (options.authority === 'worker-session') {
        csrfToken = '';
        say(form, 'The control session expired — open dashboard controls again, then try again.');
      } else {
        canWrite = false;
        applyWriteCapability();
        say(form, 'Your write access expired. Reconnect with operator.write access, then try again.');
      }
      return;
    }
    const authorizationUrl = result.body.authorization_url;
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      closeAuthorizationTab(authorizationTab);
      say(form, errorMessage(result));
      return;
    }
    if (typeof authorizationUrl === 'string' && authorizationUrl.startsWith('https://')) {
      // The provider has not answered yet. Only the server's card may ever
      // report a live connection, so the page states what it is waiting for
      // and reads again when the owner comes back.
      awaitingAuthorizationReturn = true;
      if (authorizationTab) {
        authorizationTab.location.href = authorizationUrl;
        say(form, 'Authorization opened in a new tab. Approve it there, then come back to Olympus — this card updates when the connection completes.');
        if (releaseSubmittedForm(form, submittedValues)) void refreshNow(false, true);
      } else if (openAuthorizationExternally(authorizationUrl)) {
        say(form, 'Authorization opened in your default browser. Approve it there, then come back to Olympus — this card updates when the connection completes.');
        if (releaseSubmittedForm(form, submittedValues)) void refreshNow(false, true);
      } else {
        say(form, 'Waiting for authorization. Open the page to continue — this card updates when the connection completes.');
        showAuthorizationFallback(form, authorizationUrl);
      }
      return;
    }
    closeAuthorizationTab(authorizationTab);
    const statusMessage = result.body.status_message;
    const released = releaseSubmittedForm(form, submittedValues);
    if (released && params.action === 'connect_api_key') {
      form.dataset.keyAccepted = 'true';
      form.querySelectorAll<HTMLInputElement>('input[name="api_key"]').forEach((input) => { input.value = ''; input.hidden = true; });
      form.querySelectorAll<HTMLButtonElement>('button[type="submit"],button:not([type])').forEach((button) => {
        button.textContent = params.source === 'readwise' ? 'Connected' : 'Key saved';
      });
      applyWriteCapability();
    }
    say(form, typeof statusMessage === 'string'
      ? statusMessage
      : released
        ? successMessage(params)
        : unreleasedMessage(params.action));
    // The submitted form released its focus and dirty state above, so this
    // read is not deferred by the owner's own finished form. Unrelated unsaved
    // input still defers it: `refreshNow` keeps those guards.
    await refreshNow(false, released);
  }

  /**
   * Agent connections: a pairing code or a key is shown ONCE, in a read-only
   * field whose value is set here and never reflected into markup. A field
   * whose value differs from its default holds the poll off, so the page is
   * not replaced under the owner until they press Done.
   */
  function agentParams(form: HTMLFormElement): OlympusDashboardControlParams | undefined {
    const kind = form.dataset.agentKind;
    if (kind === 'pair') return { action: 'mint_agent_pairing_code' };
    if (kind === 'key') return { action: 'create_agent_key', name: formRecord(form).name || '' };
    if (kind === 'revoke') return { action: 'revoke_agent_connection', connection_id: formRecord(form).connection_id || '' };
    if (kind === 'remote-on') return { action: 'set_remote_access', enabled: true };
    if (kind === 'remote-off') return { action: 'set_remote_access', enabled: false };
    if (kind === 'remote-accept') {
      // The agreement this panel showed, as the route named it: the owner's
      // acceptance is bound to that exact version.
      if (form.dataset.termsShown !== 'true') return undefined;
      return { action: 'set_remote_access', enabled: true, accept_terms: { url: form.dataset.termsUrl || null } };
    }
    return undefined;
  }

  /**
   * Remote access asked for Let's Encrypt's agreement: open the panel under
   * the row with the link pointed at the agreement the route named, and bind
   * the accept button to that same version.
   */
  function showRemoteTerms(from: HTMLFormElement, body: Record<string, unknown>, message: string): void {
    const panel = query<HTMLElement>('[data-remote-terms]');
    const accept = panel?.querySelector<HTMLFormElement>('form[data-agent-kind="remote-accept"]');
    const terms = body.terms && typeof body.terms === 'object' && !Array.isArray(body.terms)
      ? body.terms as Record<string, unknown>
      : undefined;
    if (!panel || !accept || !terms) {
      say(from, message);
      return;
    }
    const url = typeof terms.url === 'string' && /^https:\/\//.test(terms.url) ? terms.url : '';
    const readUrl = typeof terms.read_url === 'string' && /^https:\/\//.test(terms.read_url) ? terms.read_url : url;
    const link = panel.querySelector<HTMLAnchorElement>('[data-remote-terms-link]');
    if (link && readUrl) link.href = readUrl;
    accept.dataset.termsUrl = url;
    accept.dataset.termsShown = 'true';
    say(from, '');
    say(accept, from === accept ? message : '');
    panel.hidden = false;
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    panel.focus();
  }

  function hideRemoteTerms(): void {
    const panel = query<HTMLElement>('[data-remote-terms]');
    if (!panel) return;
    panel.hidden = true;
    const accept = panel.querySelector<HTMLFormElement>('form[data-agent-kind="remote-accept"]');
    if (accept) {
      delete accept.dataset.termsShown;
      delete accept.dataset.termsUrl;
      say(accept, '');
    }
  }

  function showAgentSecret(form: HTMLFormElement, value: string, note: string): void {
    const holder = form.closest('[data-agent-step]') || form.parentElement || form;
    const slot = holder.querySelector<HTMLElement>('[data-agent-secret-slot]');
    const field = slot?.querySelector<HTMLInputElement>('[data-agent-secret]');
    if (!slot || !field) return;
    field.value = value;
    const noteSlot = slot.querySelector('[data-agent-secret-note]');
    if (noteSlot) noteSlot.textContent = note;
    slot.hidden = false;
    field.focus();
    field.select();
  }

  function clearAgentSecret(slot: HTMLElement): void {
    slot.querySelectorAll<HTMLInputElement>('[data-agent-secret]').forEach((field) => { field.value = ''; });
    const noteSlot = slot.querySelector('[data-agent-secret-note]');
    if (noteSlot) noteSlot.textContent = '';
    slot.hidden = true;
  }

  /**
   * Re-reads the page and swaps in only the connected-agents list. A full
   * refresh is held off while the sheet has fields (and must not replace a
   * key on screen), so after Create key, Done or Revoke the list alone is
   * brought up to date.
   */
  async function refreshAgentList(): Promise<void> {
    const current = query<HTMLElement>('[data-agent-connections-list]');
    if (!current || disposed || options.signal.aborted) return;
    let result: OlympusDashboardPageRead | undefined;
    try {
      result = await options.refresh();
    } catch {
      return;
    }
    if (!result || disposed || options.signal.aborted) return;
    const next = document.createElement('template');
    next.innerHTML = result.body;
    const fresh = next.content.querySelector('[data-agent-connections-list]');
    if (!fresh) return;
    current.innerHTML = fresh.innerHTML;
    applyWriteCapability();
  }

  async function submitAgentControl(form: HTMLFormElement): Promise<void> {
    if (!canWrite && !csrfToken) {
      say(form, options.authority === 'worker-session'
        ? 'Unlock dashboard controls above first.'
        : 'Your OpenClaw connection has read-only access.');
      return;
    }
    const params = agentParams(form);
    if (!params || pendingForms.has(form)) return;
    if (params.action === 'revoke_agent_connection'
      && !window.confirm(form.dataset.confirmation || 'Revoke this connection?')) return;
    if (params.action === 'set_remote_access' && !params.enabled
      && !window.confirm(form.dataset.confirmation || 'Turn off remote access?')) return;
    setFormPending(form, true, params.action === 'revoke_agent_connection'
      ? 'Revoking…'
      : params.action === 'set_remote_access'
        ? (params.enabled ? 'Turning on…' : 'Turning off…')
        : 'Working…');
    let result: OlympusDashboardControlResult;
    try {
      result = await options.transport.control(params);
    } catch {
      say(form, 'Could not reach Olympus.');
      return;
    } finally {
      setFormPending(form, false);
    }
    if (result.status === 401 || result.status === 403) {
      if (options.authority === 'worker-session') {
        csrfToken = '';
        say(form, 'The control session expired — open dashboard controls again, then try again.');
      } else {
        canWrite = false;
        applyWriteCapability();
        say(form, 'Your write access expired. Reconnect with operator.write access, then try again.');
      }
      return;
    }
    if (params.action === 'set_remote_access' && result.status === 409) {
      const code = (result.body.error as Record<string, unknown> | undefined)?.code;
      if (code === 'terms_required' || code === 'terms_changed') {
        showRemoteTerms(form, result.body, errorMessage(result));
        return;
      }
    }
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      say(form, errorMessage(result));
      return;
    }
    if (params.action === 'set_remote_access') {
      hideRemoteTerms();
      const statusMessage = result.body.status_message;
      const row = form.closest('[data-remote-access]');
      say(row && row.contains(form) ? form : query('[data-remote-access] form') || form,
        typeof statusMessage === 'string' ? statusMessage : 'Saved.');
      return;
    }
    if (params.action === 'mint_agent_pairing_code' && typeof result.body.code === 'string') {
      say(form, '');
      showAgentSecret(form, result.body.code, 'Type this code on the Olympus approval page. It works once and expires in 10 minutes.');
      return;
    }
    if (params.action === 'create_agent_key' && typeof result.body.token === 'string') {
      say(form, '');
      showAgentSecret(form, result.body.token, 'Copy it now. Olympus keeps only a fingerprint of this key and cannot show it again.');
      await refreshAgentList();
      return;
    }
    const statusMessage = result.body.status_message;
    say(form, typeof statusMessage === 'string' ? statusMessage : 'Revoked.');
    form.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
    await refreshAgentList();
  }

  function copyText(node: Element): string {
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) return node.value;
    return (node as HTMLElement).innerText || node.textContent || '';
  }

  function announceCopy(button: Element, message: string): void {
    const status = button.parentElement?.querySelector('[data-copy-status]');
    if (status) status.textContent = message;
  }

  function focusKey(node: Element | null): string {
    if (!node || node === root) return '';
    if (node.id) return `#${node.id}`;
    const action = node.getAttribute('data-connect-kind');
    if (action) return `${node.tagName}:${action}`;
    return node.textContent?.trim().slice(0, 120) || '';
  }

  function findByFocusKey(key: string): HTMLElement | null {
    if (!key) return null;
    if (key.startsWith('#')) return query<HTMLElement>(`#${CSS.escape(key.slice(1))}`);
    return queryAll<HTMLElement>('a,button,summary,[tabindex]')
      .find((node) => focusKey(node) === key) || null;
  }

  function activeElement(): Element | null {
    const tree = root.getRootNode();
    if (tree instanceof ShadowRoot) return tree.activeElement;
    return root.ownerDocument.activeElement;
  }

  function hasDirtyInput(): boolean {
    return queryAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type="hidden"]),textarea,select',
    ).some((field) => field instanceof HTMLSelectElement
      ? Array.from(field.options).some((option) => option.selected !== option.defaultSelected)
      : field.value !== field.defaultValue);
  }

  function hasFocusedControl(): boolean {
    const active = activeElement();
    if (active === null || !root.contains(active)) return false;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return !active.disabled;
    return active instanceof HTMLElement && active.isContentEditable;
  }

  function replaceBody(result: OlympusDashboardPageRead, force: boolean): void {
    canWrite = result.can_write;
    if (!force && result.signature === signature) {
      const next = document.createElement('template');
      next.innerHTML = result.body;
      const meta = query('.top .meta');
      const nextMeta = next.content.querySelector('.top .meta');
      if (meta && nextMeta) meta.textContent = nextMeta.textContent;
      applyWriteCapability();
      return;
    }
    const openSheets = queryAll<HTMLElement>('.sheet.on').map((sheet) => sheet.id);
    const open = new Set(queryAll<HTMLDetailsElement>('details[open]').map((node) =>
      node.dataset.pollKey || node.querySelector('summary')?.textContent?.trim() || ''));
    const active = activeElement();
    const focused = focusKey(active);
    root.innerHTML = result.body;
    queryAll<HTMLDetailsElement>('details').forEach((node) => {
      const key = node.dataset.pollKey || node.querySelector('summary')?.textContent?.trim() || '';
      if (open.has(key)) node.open = true;
    });
    for (const id of openSheets) {
      const sheet = queryAll<HTMLElement>('.sheet').find((candidate) => candidate.id === id);
      sheet?.classList.add('on');
      queryAll<HTMLElement>('[data-sheet-toggle]').filter((toggle) => toggle.dataset.sheetToggle === `#${id}`).forEach((toggle) => toggle.setAttribute('aria-expanded', 'true'));
    }
    findByFocusKey(focused)?.focus();
    signature = result.signature;
    pollIntervalMs = result.poll_interval_ms;
    deferredSince = 0;
    applyWriteCapability();
  }

  async function refreshNow(force: boolean, requested = false): Promise<void> {
    if (disposed || inFlight || pendingFormCount > 0 || options.signal.aborted || (!force && !presented)) return;
    const ownerDocument = root.ownerDocument;
    if (!force && !requested && ownerDocument.visibilityState === 'hidden') return;
    if (!force && query('.sheet.on input:not([type="hidden"]),.sheet.on textarea,.sheet.on select')) return;
    // The owner is reading the agreement: a poll must not close it under them.
    if (!force && query('[data-remote-terms]:not([hidden])')) return;
    // A typed secret or folder query is the only copy of the user's work and
    // is never replaced by polling, however old the tab is.
    if (!force && hasDirtyInput()) return;
    if (!force && hasFocusedControl()) {
      if (deferredSince === 0) deferredSince = Date.now();
      if (Date.now() - deferredSince < 120_000) return;
    }
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted) return;
      if (!force && (hasDirtyInput() || hasFocusedControl())) {
        canWrite = result.can_write;
        applyWriteCapability();
        return;
      }
      replaceBody(result, force);
    } catch {
      // Polling is quiet. A directly submitted control reports its own failure.
    } finally {
      inFlight = false;
    }
  }

  function restartPoll(): void {
    if (interval) clearInterval(interval);
    interval = pollIntervalMs > 0
      ? setInterval(() => { void refreshNow(false); }, pollIntervalMs)
      : undefined;
  }

  function onSubmit(event: Event): void {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !root.contains(form)) return;
    if (form.hasAttribute('data-control-session-kind')) {
      event.preventDefault();
      if (form.dataset.controlSessionKind === 'lock') void lock(form);
      else void unlock(form);
      return;
    }
    if (form.hasAttribute('data-agent-kind')) {
      event.preventDefault();
      void submitAgentControl(form);
      return;
    }
    if (!form.matches(
      '[data-connect-kind],[data-model-check]',
    )) return;
    event.preventDefault();
    // Every control form records what it submitted: the answer may only
    // replace input that has not changed since, whatever the action.
    const submittedValues = formRecord(form);
    submittedFormValues.set(form, submittedValues);
    const tab = form.dataset.connectKind === 'oauth' ? openAuthorizationTab() : null;
    void submitControl(form, tab, submittedValues);
  }

  function onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    // A row's ⋯ menu closes when anything else is clicked, and after one of
    // its own items is chosen.
    const menu = target.closest('details.rowmenu');
    queryAll<HTMLDetailsElement>('details.rowmenu[open]').forEach((open) => {
      if (open !== menu || target.closest('[data-sheet-toggle],a[href]')) open.open = false;
    });
    const toggle = target.closest<HTMLElement>('[data-sheet-toggle]');
    if (toggle) {
      const selector = toggle.dataset.sheetToggle;
      const sheet = selector ? query<HTMLElement>(selector) : null;
      if (!sheet) return;
      const open = !sheet.classList.contains('on');
      // One sheet at a time (owner, 2026-09-24): opening a sheet closes any
      // other open one, so Connect/Set up never leaves several stacked open.
      // A sheet holding the toggle stays open, so a nested toggle keeps it.
      if (open) {
        queryAll<HTMLElement>('.sheet.on').forEach((other) => {
          if (other !== sheet && !other.contains(toggle)) setSheetOpen(other, false);
        });
      }
      setSheetOpen(sheet, open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        // Move focus into what just opened so keyboard and screen-reader
        // users land on it; the sheet is a programmatic focus target only.
        if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
        sheet.focus();
      }
      // A Connect gesture starts the fieldless publisher flow immediately.
      // Keep BYO forms and pending attempts for explicit input/review, and do
      // not create another attempt when this same panel is reopened.
      const form = sheet.querySelector<HTMLFormElement>('form[data-connect-kind="oauth"][data-oauth-autostart]');
      if (open && form && (canWrite || csrfToken) && !startedFromSheet.has(form)
        && !form.hasAttribute('data-native-oauth-unavailable')) {
        startedFromSheet.add(form);
        form.requestSubmit();
      }
      return;
    }
    if (target.closest('[data-remote-terms-cancel]')) {
      hideRemoteTerms();
      return;
    }
    const done = target.closest<HTMLElement>('[data-agent-secret-done]');
    if (done) {
      const slot = done.closest<HTMLElement>('[data-agent-secret-slot]');
      if (slot) clearAgentSecret(slot);
      void refreshAgentList();
      return;
    }
    const focusButton = target.closest<HTMLElement>('[data-focus-target]');
    if (focusButton) {
      // A blocker's button that leads to the field below it: scroll there and
      // put the cursor in it, on both surfaces (no fragment navigation, which
      // a shadow root cannot resolve).
      const selector = focusButton.dataset.focusTarget;
      const field = selector ? query(selector) : null;
      if (field) {
        field.scrollIntoView({ block: 'center' });
        (field as HTMLElement).focus();
      }
      return;
    }
    const copy = target.closest<HTMLElement>('[data-copy-target]');
    if (copy) {
      const selector = copy.dataset.copyTarget;
      const source = selector ? query(selector) : null;
      if (!source) return;
      const label = copy.textContent || '';
      if (!navigator.clipboard) {
        announceCopy(copy, 'Clipboard unavailable — select the text and copy it with your keyboard.');
        return;
      }
      void navigator.clipboard.writeText(copyText(source)).then(() => {
        copy.textContent = 'Copied';
        announceCopy(copy, 'Copied to the clipboard.');
        setTimeout(() => { if (!disposed) copy.textContent = label; }, 1600);
      }).catch(() => {
        announceCopy(copy, 'Clipboard unavailable — select the text and copy it with your keyboard.');
      });
      return;
    }
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) {
      const row = target.closest<HTMLElement>('[data-dashboard-href]');
      const modified = event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
      if (row && !modified && !target.closest('button,input,select,textarea,label,form,summary,details')) {
        event.preventDefault(); options.navigate(row.dataset.dashboardHref!);
      }
      return;
    }
    const fallback = target.closest<HTMLAnchorElement>('[data-authorization-fallback] a');
    if (fallback) {
      const form = fallback.closest<HTMLFormElement>('form[data-connect-kind="oauth"]');
      const submittedValues = form ? submittedFormValues.get(form) : undefined;
      if (form && submittedValues) {
        // Keep the fallback anchor available for the browser's default action;
        // release the panel only after that navigation has been dispatched.
        setTimeout(() => {
          if (disposed || !releaseSubmittedForm(form, submittedValues)) return;
          void refreshNow(false, true);
        }, 0);
      }
      return;
    }
    const href = anchor.dataset.olympusNav || anchor.getAttribute('href') || '';
    const modified = event instanceof MouseEvent
      && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    if (href.startsWith('/dashboard') && !modified) {
      event.preventDefault();
      options.navigate(href);
    }
  }

  /**
   * Where an open link asked Keys to open (core/open-targets.ts, by way of
   * the panel's Connect or Change models, or an `olympus://` link):
   * `#olympus-open=connect.x` opens that source's Connect panel, and
   * `fix.models` (or answers, search) goes to Models. Showing only: the panel
   * opens as if its toggle were pressed, but nothing in it is submitted, so
   * not even the one-click sign-in a publisher panel starts on a real click.
   * The fragment is read against literal names (this controller is serialized
   * into the page and imports nothing) and cleared at once.
   */
  function applyOpenTarget(): void {
    const view = root.ownerDocument.defaultView;
    if (!view || !view.location.hash.startsWith('#olympus-open=')) return;
    const wanted = view.location.hash.slice('#olympus-open='.length);
    try {
      view.history.replaceState(null, '', view.location.pathname + view.location.search);
    } catch {
      // An unchangeable history keeps the fragment; it is only a place to look.
    }
    const sources: Record<string, string> = {
      'connect.x': 'x.bookmarks',
      'connect.readwise': 'readwise.library',
      'connect.telegram': 'telegram.messages',
      'connect.whatsapp': 'whatsapp.personal.messages',
    };
    let focus: HTMLElement | null = null;
    const sourceId = Object.prototype.hasOwnProperty.call(sources, wanted) ? sources[wanted] : undefined;
    if (sourceId) {
      const row = queryAll<HTMLElement>('[data-source-id]').find((candidate) => candidate.dataset.sourceId === sourceId);
      if (row) {
        const toggle = row.querySelector<HTMLElement>('[data-sheet-toggle]');
        const selector = toggle ? toggle.dataset.sheetToggle || '' : '';
        const sheet = /^#[A-Za-z0-9_-]+$/.test(selector) ? query<HTMLElement>(selector) : null;
        if (sheet) {
          queryAll<HTMLElement>('.sheet.on').forEach((other) => { if (other !== sheet) setSheetOpen(other, false); });
          setSheetOpen(sheet, true);
          if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
          focus = sheet;
        } else {
          focus = row.querySelector<HTMLElement>('button:not([disabled]),a[href]') || row;
        }
      }
    } else if (wanted === 'fix.models' || wanted === 'fix.answers' || wanted === 'fix.search') {
      focus = query<HTMLElement>('section[aria-label="Models"]');
      if (focus && !focus.hasAttribute('tabindex')) focus.setAttribute('tabindex', '-1');
    }
    if (!focus) return;
    // Make the place obvious (Jamie, 2026-10-10: "didn't see what I'm
    // supposed to fix"): open anything folded around it, then a brief accent
    // outline that fades (theme.ts `.landed`).
    for (let fold = focus.closest('details'); fold; fold = fold.parentElement ? fold.parentElement.closest('details') : null) {
      (fold as HTMLDetailsElement).open = true;
    }
    const landed = focus;
    landed.classList.add('landed');
    view.setTimeout(() => landed.classList.remove('landed'), LANDED_HIGHLIGHT_MS);
    if (typeof focus.scrollIntoView === 'function') focus.scrollIntoView({ block: 'center' });
    focus.focus();
  }

  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  // Coming back from the approval browser or tab is the moment the exchange
  // may have just landed: one authoritative read, and only while this
  // controller still owes the owner an answer about a start it performed.
  const refreshOnReturn = (): void => {
    if (disposed || options.signal.aborted || !awaitingAuthorizationReturn) return;
    awaitingAuthorizationReturn = false;
    void refreshNow(false, true);
  };
  const onVisibilityReturn = (): void => {
    if (root.ownerDocument.visibilityState !== 'visible') return;
    refreshOnReturn();
  };
  const view = root.ownerDocument.defaultView || window;
  view.addEventListener('focus', refreshOnReturn);
  root.ownerDocument.addEventListener('visibilitychange', onVisibilityReturn);
  applyWriteCapability();
  applyOpenTarget();
  restartPoll();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (interval) clearInterval(interval);
    view.removeEventListener('focus', refreshOnReturn);
    root.ownerDocument.removeEventListener('visibilitychange', onVisibilityReturn);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('click', onClick);
  };
  options.signal.addEventListener('abort', dispose, { once: true });

  return {
    refresh: () => refreshNow(false, true),
    update(input) {
      canWrite = input.canWrite;
      if (input.presented !== undefined) presented = input.presented;
      if (input.signature !== undefined) signature = input.signature;
      if (input.pollIntervalMs !== undefined && input.pollIntervalMs !== pollIntervalMs) {
        pollIntervalMs = input.pollIntervalMs;
        restartPoll();
      }
      applyWriteCapability();
    },
    dispose,
  };
}
