import type {
  OlympusDashboardControlParams,
  OlympusDashboardControlResult,
  OlympusDashboardReadResult,
  OlympusDashboardReadParams,
  OlympusFolderScopeBrowseResult,
  OlympusFolderScopeNode,
  OlympusFolderScopeSourceId,
  OlympusMailScopeDraft,
  OlympusSourceDispositionState,
  OlympusPrivacyRule,
} from '../control-ui-contract.ts';
import type { PrivacyLogic, PrivacyLogicConfig } from '../workers/dashboard/shared-privacy-logic.ts';
import type { DASHBOARD_PICKER_COPY } from '../workers/dashboard/vocabulary.ts';

export interface OlympusDashboardTransport {
  /** Explicit private folder browse; never called by background refresh. */
  read?(params: OlympusDashboardReadParams): Promise<OlympusDashboardReadResult>;
  control(params: OlympusDashboardControlParams): Promise<OlympusDashboardControlResult>;
  /** Standalone-only control-session exchange. Native pages never receive a worker token. */
  unlock?(workerToken: string): Promise<{ ok: boolean; csrf_token?: string }>;
  lock?(): Promise<boolean>;
  renew?(): Promise<void>;
}

export interface OlympusDashboardRefresh {
  (): Promise<OlympusDashboardReadResult | undefined>;
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
  authority?: 'gateway' | 'worker-session';
  /** Native boundary hook; standalone markup is produced in-process. */
  replaceHtml?: (root: HTMLElement | ShadowRoot, html: string) => void;
  /**
   * The privacy rules shared with ChatGPT's privacy panel
   * (shared-privacy-logic.ts privacyLogic), for the Privacy editor. Passed in,
   * not imported: this controller is serialized into the standalone page.
   */
  privacyLogic?: (config: PrivacyLogicConfig) => PrivacyLogic;
}

export interface OlympusBrowserController {
  refresh(): Promise<void>;
  update(input: { canWrite: boolean; presented?: boolean; signature?: string; pollIntervalMs?: number }): void;
  dispose(): void;
}

/**
 * Browser behavior shared byte-for-byte by the native Control UI page and the
 * standalone worker dashboard. It is deliberately self-contained: the
 * standalone renderer serializes this trusted function into its own HTML,
 * while the native bundle imports and calls it directly.
 */
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
      'form[data-connect-kind],form[data-sync-kind],form[data-embedding-kind],form[data-model-retry],'
        + 'form[data-disconnect-kind],form[data-unpair-kind],form[data-model-check],form[data-agent-kind],form[data-privacy-form]',
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
  function pendingMessage(action: OlympusDashboardControlParams['action']): string {
    switch (action) {
      case 'start_oauth': return 'Connecting…';
      case 'connect_api_key': return 'Validating the key…';
      case 'cancel_oauth': return 'Cancelling…';
      case 'sync_now': return 'Starting sync…';
      case 'set_embedding_priority': return 'Saving…';
      case 'retry_model': return 'Starting the download again…';
      default: return 'Working…';
    }
  }

  /**
   * Actionable replacement for the old "Done. Waiting for the next refresh."
   * It says what just happened and what the owner should expect next; it never
   * claims the connection is live, which only the server's card may report.
   */
  function successMessage(action: OlympusDashboardControlParams['action']): string {
    switch (action) {
      case 'connect_api_key': return 'Key accepted. This card updates when Olympus confirms the connection.';
      case 'start_oauth': return 'Waiting for authorization. This card updates when the connection completes.';
      case 'cancel_oauth': return 'Connection attempt cancelled. Press Connect when you are ready to start a new one.';
      case 'sync_now': return 'Sync started. This card updates when it finishes.';
      case 'set_embedding_priority': return 'Saved.';
      case 'disconnect': return 'Disconnected. This card updates when Olympus confirms it.';
      case 'unpair': return 'Unpaired on this computer.';
      case 'retry_model': return 'Downloading again. This row updates as it goes.';
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
    if (connect === 'oauth_cancel') {
      return {
        action: 'cancel_oauth',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'cancel_oauth' }>['source'],
      };
    }
    if (connect === 'api_key') {
      return {
        action: 'connect_api_key',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'connect_api_key' }>['source'],
        api_key: body.api_key || '',
      };
    }
    if (form.hasAttribute('data-sync-kind')) {
      return {
        action: 'sync_now',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'sync_now' }>['source'],
      };
    }
    if (form.hasAttribute('data-embedding-kind')) {
      return { action: 'set_embedding_priority', on: body.on === 'true' };
    }
    if (form.hasAttribute('data-model-retry')) {
      const model = form.dataset.modelRetry;
      return model === 'embedding' || model === 'answers' ? { action: 'retry_model', model } : undefined;
    }
    if (form.hasAttribute('data-disconnect-kind')) {
      return {
        action: 'disconnect',
        source_id: body.source_id as Extract<OlympusDashboardControlParams, { action: 'disconnect' }>['source_id'],
        acknowledge: true,
      };
    }
    if (form.hasAttribute('data-unpair-kind')) {
      return {
        action: 'unpair',
        source_id: body.source_id as Extract<OlympusDashboardControlParams, { action: 'unpair' }>['source_id'],
        acknowledge: true,
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
    if (params.action === 'disconnect' || params.action === 'unpair') {
      const fallback = params.action === 'unpair' ? 'Unpair this source?' : 'Disconnect this source?';
      if (!window.confirm(form.dataset.confirmation || fallback)) {
        closeAuthorizationTab(authorizationTab);
        return;
      }
    }
    if (params.action === 'start_oauth') clearAuthorizationFallback(form);
    setFormPending(form, true, pendingMessage(params.action));
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
        say(form, 'The control session expired — unlock controls in Setup, then try again.');
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
    if (params.action === 'cancel_oauth') awaitingAuthorizationReturn = false;
    say(form, typeof statusMessage === 'string'
      ? statusMessage
      : released
        ? successMessage(params.action)
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
    let result: OlympusDashboardReadResult | undefined;
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
        say(form, 'The control session expired — unlock controls in Setup, then try again.');
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
    const action = node.getAttribute('data-connect-kind')
      || node.getAttribute('data-sync-kind')
      || node.getAttribute('data-embedding-kind')
      || node.getAttribute('data-model-retry')
      || node.getAttribute('data-disconnect-kind')
      || node.getAttribute('data-unpair-kind');
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

  function replaceBody(result: OlympusDashboardReadResult, force: boolean): void {
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
    if (options.replaceHtml) options.replaceHtml(root, result.body);
    else root.innerHTML = result.body;
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
    // An edited privacy list, or a list the owner is picking from, is theirs
    // until they save or leave.
    if (!force && query('form[data-privacy-form][data-dirty="true"],[data-privacy-panel]:not([hidden]),[data-privacy-confirm],[data-privacy-conflict]')) return;
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

  // ---- The Privacy editor (pages/privacy.ts) ------------------------------
  // The page renders the saved description and rules; this edits the list in
  // place and saves the whole of it through `save_privacy` (the same engine
  // operation as ChatGPT's olympus_privacy_set). Names are only ever set as
  // text, never as markup. An edited list holds the poll off until it is
  // saved or discarded, like a typed field does.
  type PrivacyRule = { kind: string; source_id: string; key?: string; value?: string; display?: string };
  type PrivacyViewRule = ReturnType<PrivacyLogic['viewRule']>;

  function privacyCopy(form: HTMLFormElement): Record<string, string> {
    try { return JSON.parse(form.dataset.copy || '{}') as Record<string, string>; } catch { return {}; }
  }

  function privacyFill(template: string, values: Record<string, string>): string {
    let out = template || '';
    for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(values[key]!);
    return out;
  }

  function privacyJson<T>(value: string | undefined, fallback: T): T {
    try {
      const parsed = JSON.parse(value || '') as T;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  function privacyFolderSources(form: HTMLFormElement): Array<{ id: string; label: string }> {
    const list = privacyJson<Array<{ id: string; label: string }>>(form.dataset.folderSources, []);
    return Array.isArray(list) ? list.filter((entry) => entry && typeof entry.id === 'string') : [];
  }

  /** Every folder source's name, connected or not: a saved rule may name either. */
  function privacySourceNames(form: HTMLFormElement): Record<string, string> {
    const names = privacyJson<Record<string, string>>(form.dataset.sourceNames, {});
    return names && typeof names === 'object' ? names : {};
  }

  /**
   * The rules this editor shares with ChatGPT's privacy panel
   * (shared-privacy-logic.ts), handed in by the page: this controller is
   * serialized into the standalone page and cannot import it.
   */
  function privacyLogicFor(form: HTMLFormElement): PrivacyLogic | undefined {
    const topicWords = privacyJson<PrivacyLogicConfig['topicWords'] | null>(form.dataset.questions, null);
    return options.privacyLogic
      ? options.privacyLogic({
        mailSourceId: 'gmail.email',
        folderSources: privacySourceNames(form),
        ...(topicWords && typeof topicWords === 'object' ? { topicWords } : {}),
      })
      : undefined;
  }

  /**
   * The follow-up questions under the description (pages/privacy.ts
   * privacyQuestions builds the same markup): asked again when the areas the
   * description names change, and when a choice rewrites it. `focus` is the
   * choice to put the caret back on.
   */
  function renderPrivacyQuestions(form: HTMLFormElement, focus?: { topic: string; option: string; side: string }, message = ''): void {
    const holder = form.querySelector<HTMLElement>('[data-privacy-questions]');
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
    const logic = privacyLogicFor(form);
    if (!holder || !field || !logic) return;
    const words = privacyJson<Record<string, string> | null>(form.dataset.questions, null) || {};
    const asked = logic.questions(field.value);
    shownPrivacyQuestions.set(holder, logic.questionsKey(field.value));
    holder.setAttribute('data-privacy-questions', asked.map((topic) => topic.id).join(','));
    holder.hidden = asked.length === 0;
    const children: HTMLElement[] = [];
    if (asked.length > 0) {
      const title = document.createElement('h3');
      title.className = 'sect';
      title.textContent = words.title || '';
      const intro = document.createElement('p');
      intro.className = 'pnote';
      intro.textContent = words.intro || '';
      children.push(title, intro);
    }
    const locked = !canWrite && !csrfToken;
    for (const topic of asked) {
      const group = document.createElement('div');
      group.className = 'pqtopic';
      const heading = document.createElement('h4');
      heading.className = 'pqtitle';
      heading.id = `privacy-q-${topic.id}`;
      heading.textContent = topic.question;
      group.append(heading);
      for (const option of topic.options) {
        const id = `privacy-q-${topic.id}-${option.id}`;
        const row = document.createElement('div');
        row.className = 'pqopt';
        row.setAttribute('role', 'radiogroup');
        row.setAttribute('aria-labelledby', `${heading.id} ${id}`);
        const name = document.createElement('span');
        name.className = 'pqlabel';
        name.id = id;
        name.textContent = option.label;
        const choices = document.createElement('span');
        choices.className = 'pqchoices';
        for (const side of ['private', 'share']) {
          const label = document.createElement('label');
          label.className = 'pqchoice';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = id;
          input.value = side;
          input.setAttribute('data-privacy-topic', topic.id);
          input.setAttribute('data-privacy-option', option.id);
          input.checked = option.side === side;
          input.defaultChecked = input.checked;
          if (locked) {
            input.disabled = true;
            input.setAttribute('aria-disabled', 'true');
          }
          const text = document.createElement('span');
          text.textContent = side === 'private' ? words.private || '' : words.share || '';
          label.append(input, text);
          choices.append(label);
        }
        row.append(name, choices);
        group.append(row);
      }
      children.push(group);
    }
    if (message) {
      const note = document.createElement('p');
      note.className = 'pnote pqmessage';
      note.setAttribute('data-privacy-questions-message', '');
      note.setAttribute('role', 'alert');
      note.textContent = message;
      children.push(note);
    }
    holder.replaceChildren(...children);
    if (focus) {
      holder.querySelectorAll<HTMLInputElement>('input[data-privacy-topic]').forEach((input) => {
        if (input.dataset.privacyTopic === focus.topic && input.dataset.privacyOption === focus.option && input.value === focus.side) input.focus();
      });
    }
  }

  /** What each questions block shows, as `questionsKey`, once this controller has drawn it. */
  const shownPrivacyQuestions = new WeakMap<HTMLElement, string>();

  /** Typing in the description: the questions follow the areas it names. */
  function onPrivacyInput(event: Event): void {
    const field = event.target instanceof HTMLTextAreaElement ? event.target : null;
    const form = field?.closest<HTMLFormElement>('form[data-privacy-form]');
    if (!field || !form || field.name !== 'description') return;
    const holder = form.querySelector<HTMLElement>('[data-privacy-questions]');
    const logic = privacyLogicFor(form);
    if (!holder || !logic) return;
    // What the questions show now: the server drew them from the saved description.
    const shown = shownPrivacyQuestions.get(holder) ?? logic.questionsKey(field.defaultValue);
    // Redrawn when an area or an answer changes (a sentence edited by hand), or a too-long note clears.
    if (logic.questionsKey(field.value) !== shown || holder.querySelector('[data-privacy-questions-message]')) renderPrivacyQuestions(form);
  }

  /** A choice: that area's sentence in the description is written again, and the draft is changed. */
  function onPrivacyChange(event: Event): void {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const form = input?.closest<HTMLFormElement>('form[data-privacy-form]');
    if (!input || !form || !input.checked || input.dataset.privacyTopic === undefined) return;
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
    const logic = privacyLogicFor(form);
    const side = input.value === 'share' ? 'share' : 'private';
    if (!field || !logic) return;
    const topic = input.dataset.privacyTopic || '';
    const option = input.dataset.privacyOption || '';
    const next = logic.answerTopic(field.value, topic, option, side);
    if (!next.fits) {
      // Too long to add: nothing changes, the radio is drawn as it was, and the owner is told why.
      const words = privacyJson<Record<string, string> | null>(form.dataset.questions, null) || {};
      renderPrivacyQuestions(form, { topic, option, side: side === 'share' ? 'private' : 'share' }, words.tooLong || '');
      return;
    }
    field.value = next.description;
    setPrivacyDirty(form);
    renderPrivacyQuestions(form, { topic, option, side });
  }

  function privacyDisplay(form: HTMLFormElement, logic: PrivacyLogic, rule: PrivacyRule): string {
    const names = privacySourceNames(form);
    return logic.displayOf(rule, privacyFill(privacyCopy(form).folderUnnamed || '', { source: names[rule.source_id] || rule.source_id }));
  }

  function privacyKindText(form: HTMLFormElement, rule: PrivacyRule): string {
    const copy = privacyCopy(form);
    if (rule.kind === 'sender') return copy.kindSender || '';
    if (rule.kind === 'label') return copy.kindLabel || '';
    const names = privacySourceNames(form);
    return privacyFill(copy.kindFolder || '', { source: names[rule.source_id] || rule.source_id });
  }

  /** The editor's rules as view rules, read off the rows: saved, removed, and exactly what the engine sent. */
  function privacyViewRules(form: HTMLFormElement): PrivacyViewRule[] {
    return Array.from(form.querySelectorAll<HTMLElement>('[data-privacy-rule]')).flatMap((row) => {
      const rule = privacyJson<PrivacyRule | null>(row.getAttribute('data-privacy-rule') || undefined, null);
      if (!rule || typeof rule.kind !== 'string' || typeof rule.source_id !== 'string') return [];
      const saved = row.hasAttribute('data-privacy-saved');
      const view: PrivacyViewRule = {
        kind: rule.kind,
        source_id: rule.source_id,
        display: row.querySelector('.sline.strong')?.textContent || '',
        removed: row.hasAttribute('data-removed'),
        saved,
        ...(typeof rule.key === 'string' ? { key: rule.key } : {}),
        ...(typeof rule.value === 'string' ? { value: rule.value } : {}),
        ...(saved ? { raw: rule as Record<string, unknown> } : {}),
      };
      return [view];
    });
  }

  function privacyKept(form: HTMLFormElement): PrivacyViewRule[] {
    return privacyViewRules(form).filter((rule) => !rule.removed);
  }

  /** The whole rule list a save sends: every kept rule, and every saved rule the page cannot show. */
  function privacyRulesOut(form: HTMLFormElement, logic: PrivacyLogic): Array<Record<string, unknown>> {
    const hidden = privacyJson<Array<Record<string, unknown>>>(form.dataset.hidden, []);
    return privacyKept(form).map((rule) => logic.ruleOut(rule)).concat(Array.isArray(hidden) ? hidden : []);
  }

  function setPrivacyDirty(form: HTMLFormElement): void {
    form.dataset.dirty = 'true';
    // Any change closes an open confirmation step: what it named may no longer be true.
    form.querySelectorAll('[data-privacy-confirm]').forEach((node) => node.remove());
    const empty = form.querySelector<HTMLElement>('[data-privacy-empty]');
    if (empty) empty.hidden = privacyKept(form).length > 0;
  }

  /** One rule as a row, the shape the page renders: a saved one keeps exactly what the engine sent. */
  function privacyRow(form: HTMLFormElement, logic: PrivacyLogic, rule: PrivacyViewRule | PrivacyRule): HTMLElement {
    const view = rule as PrivacyViewRule;
    const display = typeof view.display === 'string' && view.display ? view.display : privacyDisplay(form, logic, rule);
    const copy = privacyCopy(form);
    const row = document.createElement('div');
    row.className = 'srow nodot prule';
    row.setAttribute('data-privacy-rule', JSON.stringify(view.saved && view.raw ? view.raw : logic.ruleOut({ ...rule, display })));
    if (view.saved) row.setAttribute('data-privacy-saved', '');
    const main = document.createElement('div');
    main.className = 'smain';
    const name = document.createElement('p');
    name.className = 'sline strong';
    name.textContent = display;
    const kind = document.createElement('p');
    kind.className = 'sline';
    kind.textContent = privacyKindText(form, rule);
    main.append(name, kind);
    const actions = document.createElement('div');
    actions.className = 'sact';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.setAttribute('data-privacy-remove', '');
    remove.setAttribute('aria-label', privacyFill(copy.removeFor || '', { name: display }));
    remove.textContent = copy.remove || 'Remove';
    actions.append(remove);
    row.append(main, actions);
    if (view.removed) markPrivacyRemoved(form, row, true);
    return row;
  }

  /** Adds a rule, or brings back the same rule if it was removed; false when it is already kept. */
  function addPrivacyRule(form: HTMLFormElement, rule: PrivacyRule): boolean {
    const logic = privacyLogicFor(form);
    if (!logic) return false;
    const identity = logic.identity(rule);
    const existing = Array.from(form.querySelectorAll<HTMLElement>('[data-privacy-rule]')).find((row) => {
      const current = privacyJson<PrivacyRule | null>(row.getAttribute('data-privacy-rule') || undefined, null);
      return current !== null && logic.identity(current) === identity;
    });
    if (existing) {
      if (!existing.hasAttribute('data-removed')) return false;
      togglePrivacyRemoved(form, existing);
      return true;
    }
    form.querySelector('[data-privacy-rules]')?.append(privacyRow(form, logic, rule));
    setPrivacyDirty(form);
    return true;
  }

  function markPrivacyRemoved(form: HTMLFormElement, row: HTMLElement, removed: boolean): void {
    const copy = privacyCopy(form);
    const name = row.querySelector('.sline.strong')?.textContent || '';
    const button = row.querySelector<HTMLButtonElement>('[data-privacy-remove]');
    row.toggleAttribute('data-removed', removed);
    row.classList.toggle('removed', removed);
    if (button) {
      button.textContent = removed ? copy.undo || 'Undo' : copy.remove || 'Remove';
      button.setAttribute('aria-label', removed ? privacyFill(copy.undoFor || '', { name }) : privacyFill(copy.removeFor || '', { name }));
    }
  }

  function togglePrivacyRemoved(form: HTMLFormElement, row: HTMLElement): void {
    const copy = privacyCopy(form);
    const name = row.querySelector('.sline.strong')?.textContent || '';
    const removed = !row.hasAttribute('data-removed');
    markPrivacyRemoved(form, row, removed);
    setPrivacyDirty(form);
    say(form, removed ? privacyFill(copy.removed || '', { name }) : '');
  }

  function privacyPanel(form: HTMLFormElement, kind: string): HTMLElement | null {
    return form.querySelector<HTMLElement>(`[data-privacy-panel="${kind}"]`);
  }

  function panelSay(panel: HTMLElement, message: string): void {
    const slot = panel.querySelector('[data-privacy-panel-message]');
    if (slot) slot.textContent = message;
  }

  function openPrivacyPanel(form: HTMLFormElement, kind: string): void {
    form.querySelectorAll<HTMLElement>('[data-privacy-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.privacyPanel !== kind;
    });
    const panel = privacyPanel(form, kind);
    if (!panel) return;
    if (kind === 'sender') {
      panel.querySelector<HTMLInputElement>('[data-privacy-sender]')?.focus();
      return;
    }
    if (kind === 'label' && panel.dataset.loaded !== 'true') void loadPrivacyLabels(form, panel);
    if (kind === 'folder') {
      const sources = privacyFolderSources(form);
      const holder = panel.querySelector<HTMLElement>('[data-privacy-folder-sources]');
      if (holder && holder.childElementCount === 0 && sources.length > 1) {
        for (const source of sources) {
          const choose = document.createElement('button');
          choose.type = 'button';
          choose.className = 'btn';
          choose.setAttribute('data-privacy-folder-source', source.id);
          choose.textContent = source.label;
          holder.append(choose);
        }
      }
      if (!panel.dataset.source && sources[0]) void loadPrivacyFolders(form, panel, sources[0].id, []);
    }
    if (!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
    panel.focus();
  }

  function closePrivacyPanel(panel: HTMLElement): void {
    panel.hidden = true;
    panelSay(panel, '');
    const form = panel.closest<HTMLFormElement>('form[data-privacy-form]');
    const opener = form?.querySelector<HTMLElement>(`[data-privacy-add="${panel.dataset.privacyPanel}"]`);
    opener?.focus();
  }

  /** One line in a picking list: the name, and Make private (or Already private). */
  function privacyPickRow(form: HTMLFormElement, label: string, rule: PrivacyRule, open?: { key: string; name: string }): HTMLElement {
    const copy = privacyCopy(form);
    const row = document.createElement('div');
    row.className = 'srow nodot';
    const main = document.createElement('div');
    main.className = 'smain';
    const name = document.createElement('p');
    name.className = 'sline strong';
    name.textContent = label;
    main.append(name);
    const actions = document.createElement('div');
    actions.className = 'sact';
    if (open) {
      const inside = document.createElement('button');
      inside.type = 'button';
      inside.className = 'btn';
      inside.setAttribute('data-privacy-folder-open', JSON.stringify(open));
      inside.textContent = copy.folderOpen || 'Open';
      actions.append(inside);
    }
    const logic = privacyLogicFor(form);
    const already = !!logic && privacyKept(form).some((current) => logic.identity(current) === logic.identity(rule));
    const make = document.createElement('button');
    make.type = 'button';
    make.className = 'btn';
    make.setAttribute('data-privacy-make-private', JSON.stringify(rule));
    make.textContent = already ? copy.alreadyPrivate || 'Already private' : copy.makePrivate || 'Make private';
    make.disabled = already;
    actions.append(make);
    row.append(main, actions);
    return row;
  }

  async function loadPrivacyLabels(form: HTMLFormElement, panel: HTMLElement): Promise<void> {
    const copy = privacyCopy(form);
    const list = panel.querySelector<HTMLElement>('[data-privacy-list]');
    if (!list || panel.dataset.loading === 'true') return;
    panel.dataset.loading = 'true';
    panelSay(panel, copy.loading || '');
    let draft: unknown;
    try { draft = JSON.parse(form.dataset.mailDraft || 'null'); } catch { draft = null; }
    try {
      const result = await options.transport.control({
        action: 'browse_mail_scope', source_id: 'gmail.email', draft: draft as OlympusMailScopeDraft,
      });
      if (disposed || !root.contains(form)) return;
      const summary = result.body.summary && typeof result.body.summary === 'object'
        ? result.body.summary as Record<string, unknown>
        : undefined;
      const labels = summary && Array.isArray(summary.labels) ? summary.labels as Array<Record<string, unknown>> : undefined;
      if (result.status < 200 || result.status >= 300 || !labels) {
        panelSay(panel, copy.loadFailed || '');
        return;
      }
      list.replaceChildren();
      const own = labels.filter((label) => typeof label.id === 'string' && typeof label.name === 'string' && label.system !== true);
      for (const label of own) {
        list.append(privacyPickRow(form, String(label.name), {
          kind: 'label', source_id: 'gmail.email', key: String(label.id), value: String(label.name),
        }));
      }
      panel.dataset.loaded = 'true';
      panelSay(panel, own.length === 0 ? copy.noLabels || '' : '');
    } catch {
      if (!disposed) panelSay(panel, copy.loadFailed || '');
    } finally {
      delete panel.dataset.loading;
    }
  }

  async function loadPrivacyFolders(
    form: HTMLFormElement,
    panel: HTMLElement,
    sourceId: string,
    path: Array<{ key: string; name: string }>,
    cursor?: string,
  ): Promise<void> {
    const copy = privacyCopy(form);
    const list = panel.querySelector<HTMLElement>('[data-privacy-list]');
    if (!list || panel.dataset.loading === 'true') return;
    panel.dataset.loading = 'true';
    panelSay(panel, copy.loading || '');
    const parent = path.length > 0 ? path[path.length - 1]!.key : undefined;
    try {
      const result = await options.transport.control({
        action: 'browse_folder_scope',
        source_id: sourceId as OlympusFolderScopeSourceId,
        ...(parent ? { parent_key: parent } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (disposed || !root.contains(form)) return;
      const page = result.body.scope_browser as OlympusFolderScopeBrowseResult | undefined;
      if (result.status < 200 || result.status >= 300 || !page || !Array.isArray(page.nodes)) {
        panelSay(panel, copy.loadFailed || '');
        return;
      }
      panel.dataset.source = sourceId;
      panel.dataset.path = JSON.stringify(path);
      panel.querySelectorAll<HTMLElement>('[data-privacy-folder-source]').forEach((choice) => {
        choice.setAttribute('aria-pressed', choice.dataset.privacyFolderSource === sourceId ? 'true' : 'false');
      });
      if (!cursor) list.replaceChildren();
      list.querySelector('[data-privacy-folder-more]')?.remove();
      const where = panel.querySelector<HTMLElement>('[data-privacy-folder-path]');
      if (where) {
        where.replaceChildren();
        if (path.length > 0) {
          const up = document.createElement('button');
          up.type = 'button';
          up.className = 'btn';
          up.setAttribute('data-privacy-folder-up', '');
          up.textContent = copy.folderUp || 'Back';
          const name = document.createElement('span');
          name.textContent = ` ${path.map((step) => step.name).join(' / ')}`;
          where.append(up, name);
        }
      }
      for (const node of page.nodes) {
        if (typeof node.key !== 'string' || typeof node.name !== 'string' || node.selectable === false) continue;
        list.append(privacyPickRow(
          form,
          node.name,
          { kind: 'folder', source_id: sourceId, key: node.key, display: node.name },
          node.has_children ? { key: node.key, name: node.name } : undefined,
        ));
      }
      if (page.next_cursor) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn';
        more.setAttribute('data-privacy-folder-more', page.next_cursor);
        more.textContent = copy.folderMore || 'Load more folders';
        list.append(more);
      }
      panelSay(panel, list.querySelector('[data-privacy-make-private]') ? '' : copy.folderEmpty || '');
    } catch {
      if (!disposed) panelSay(panel, copy.loadFailed || '');
    } finally {
      delete panel.dataset.loading;
    }
  }

  function privacyPath(panel: HTMLElement): Array<{ key: string; name: string }> {
    try {
      const path = JSON.parse(panel.dataset.path || '[]') as Array<{ key: string; name: string }>;
      return Array.isArray(path) ? path : [];
    } catch {
      return [];
    }
  }

  function addPrivacySender(form: HTMLFormElement): void {
    const copy = privacyCopy(form);
    const panel = privacyPanel(form, 'sender');
    const field = panel?.querySelector<HTMLInputElement>('[data-privacy-sender]');
    if (!panel || !field) return;
    const value = privacyLogicFor(form)?.senderValue(field.value) || '';
    if (!value) {
      panelSay(panel, copy.senderInvalid || '');
      field.focus();
      return;
    }
    if (!addPrivacyRule(form, { kind: 'sender', source_id: 'gmail.email', value })) {
      panelSay(panel, copy.senderDuplicate || '');
      return;
    }
    field.value = '';
    panelSay(panel, '');
    field.focus();
  }

  /** The description as saved when the page was read (or at the last conflict). */
  function privacySavedDescription(form: HTMLFormElement): string {
    return form.dataset.savedDescription || '';
  }

  /** What a save of the draft would lower, decided again each time it is asked. */
  function privacyLowering(form: HTMLFormElement, logic: PrivacyLogic): { removed: string[]; description: boolean } {
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
    const change = logic.lowering(privacyViewRules(form), field ? field.value : privacySavedDescription(form), privacySavedDescription(form));
    return { removed: change.removed.map((rule: PrivacyViewRule) => rule.display), description: change.described };
  }

  function clearPrivacyPrompts(form: HTMLFormElement): void {
    form.querySelectorAll('[data-privacy-confirm],[data-privacy-conflict]').forEach((node) => node.remove());
  }

  /** A sentence (or a short list) and two buttons, in the save footer, in place of a dialog. */
  function privacyPrompt(form: HTMLFormElement, kind: 'confirm' | 'conflict', lines: string[], items: string[], buttons: Array<[string, string]>): void {
    clearPrivacyPrompts(form);
    const box = document.createElement('div');
    box.className = 'pprompt';
    box.setAttribute(`data-privacy-${kind}`, '');
    box.setAttribute('role', 'alert');
    for (const line of lines) {
      const text = document.createElement('p');
      text.textContent = line;
      box.append(text);
    }
    if (items.length > 0) {
      const list = document.createElement('ul');
      for (const item of items) {
        const entry = document.createElement('li');
        entry.textContent = item;
        list.append(entry);
      }
      box.append(list);
    }
    const row = document.createElement('div');
    row.className = 'pbuttons';
    for (const [attribute, label] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.setAttribute(attribute, '');
      button.textContent = label;
      row.append(button);
    }
    box.append(row);
    const footer = form.querySelector('.pfooter');
    (footer || form).prepend(box);
    row.querySelector<HTMLButtonElement>('button')?.focus();
  }

  function showPrivacyConfirm(form: HTMLFormElement, lowering: { removed: string[]; description: boolean }): void {
    const copy = privacyCopy(form);
    const lines: string[] = [];
    if (lowering.removed.length > 0) lines.push(privacyFill(copy.confirmRemoves || '', { list: lowering.removed.join(', ') }));
    if (lowering.description) lines.push(copy.confirmDescription || '');
    privacyPrompt(form, 'confirm', lines, [], [
      ['data-privacy-confirm-yes', copy.confirm || 'Confirm'],
      ['data-privacy-confirm-no', copy.cancel || 'Cancel'],
    ]);
  }

  /** Settings changed somewhere else: the draft stays; what is saved now is shown beside it. */
  function showPrivacyConflict(form: HTMLFormElement, logic: PrivacyLogic, current: { description?: unknown; rules?: unknown }): void {
    const copy = privacyCopy(form);
    const description = typeof current.description === 'string' ? current.description.trim() : '';
    const rules = Array.isArray(current.rules) ? (current.rules as PrivacyRule[]).filter((rule) => logic.validRule(rule)) : [];
    const items = [description ? privacyFill(copy.conflictDescription || '', { text: description }) : copy.conflictNoDescription || ''];
    if (rules.length === 0) items.push(copy.rulesEmpty || '');
    for (const rule of rules) items.push(`${privacyDisplay(form, logic, rule)} · ${privacyKindText(form, rule)}`);
    privacyPrompt(form, 'conflict', [copy.conflict || '', copy.conflictNow || ''], items, [
      ['data-privacy-apply-again', copy.applyAgain || 'Apply my changes again'],
      ['data-privacy-discard-mine', copy.discardMine || 'Discard my changes'],
    ]);
  }

  /**
   * The person's changes, replayed onto the settings saved elsewhere
   * (shared-privacy-logic.ts replay), then saved: asking first if they lower
   * protection against what is saved now.
   */
  function privacyApplyAgain(form: HTMLFormElement): void {
    const logic = privacyLogicFor(form);
    const current = privacyJson<{ description?: unknown; rules?: unknown; revision?: unknown } | null>(form.dataset.server, null);
    if (!logic || !current) return;
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
    const draft = {
      rules: privacyViewRules(form),
      description: field ? field.value : privacySavedDescription(form),
      savedDescription: privacySavedDescription(form),
    };
    const saved = Array.isArray(current.rules) ? current.rules as PrivacyRule[] : [];
    const fresh = saved.filter((rule) => logic.validRule(rule)).map((rule) => logic.viewRule(rule, privacyDisplay(form, logic, rule)));
    const replayed = logic.replay(draft, fresh);
    const description = typeof current.description === 'string' ? current.description : '';
    form.dataset.revision = typeof current.revision === 'string' ? current.revision : '';
    form.dataset.savedDescription = description;
    form.dataset.hidden = JSON.stringify(saved.filter((rule) => !logic.validRule(rule)));
    delete form.dataset.server;
    const list = form.querySelector('[data-privacy-rules]');
    if (list) list.replaceChildren(...replayed.rules.map((rule: PrivacyViewRule) => privacyRow(form, logic, rule)));
    if (field) {
      field.defaultValue = description;
      field.value = replayed.description !== null ? replayed.description : description;
    }
    renderPrivacyQuestions(form);
    setPrivacyDirty(form);
    clearPrivacyPrompts(form);
    void savePrivacy(form);
  }

  /**
   * Save the whole list, as ChatGPT's privacy panel does: a save that lowers
   * protection first asks, in place, and only then carries the owner's
   * confirmation (decided again from the draft at that moment); every save
   * carries the revision it was edited against; a conflict keeps the draft.
   */
  async function savePrivacy(form: HTMLFormElement, confirmed = false): Promise<void> {
    const copy = privacyCopy(form);
    const logic = privacyLogicFor(form);
    if (!logic) return;
    if (!canWrite && !csrfToken) {
      say(form, 'Your OpenClaw connection has read-only access.');
      return;
    }
    if (pendingForms.has(form) || form.dataset.server) return;
    const lowering = privacyLowering(form, logic);
    const lowers = lowering.removed.length > 0 || lowering.description;
    if (lowers && !confirmed) {
      showPrivacyConfirm(form, lowering);
      return;
    }
    clearPrivacyPrompts(form);
    const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
    const description = field ? field.value.trim() : undefined;
    const revision = form.dataset.revision || '';
    setFormPending(form, true, copy.saving || 'Saving…');
    let result: OlympusDashboardControlResult;
    try {
      result = await options.transport.control({
        action: 'save_privacy',
        ...(description !== undefined ? { description } : {}),
        rules: privacyRulesOut(form, logic) as unknown as OlympusPrivacyRule[],
        // Always the revision the view was built from: a save over changed settings is refused.
        revision,
        // Only a save that lowers protection carries the confirmation.
        ...(lowers ? { confirm: true } : {}),
      });
    } catch {
      say(form, copy.saveFailed || 'Could not reach Olympus.');
      return;
    } finally {
      setFormPending(form, false);
    }
    if (result.status === 401 || result.status === 403) {
      if (options.authority === 'worker-session') {
        csrfToken = '';
        say(form, 'The control session expired — unlock controls in Setup, then try again.');
      } else {
        canWrite = false;
        applyWriteCapability();
        say(form, 'Your write access expired. Reconnect with operator.write access, then try again.');
      }
      return;
    }
    const error = result.body.error && typeof result.body.error === 'object' ? result.body.error as Record<string, unknown> : {};
    if (result.status === 409 && error.code === 'conflict') {
      const current = result.body.settings && typeof result.body.settings === 'object'
        ? result.body.settings as { description?: unknown; rules?: unknown; revision?: unknown }
        : {};
      form.dataset.server = JSON.stringify(current);
      form.dataset.dirty = 'true';
      say(form, '');
      showPrivacyConflict(form, logic, current);
      return;
    }
    if (result.status === 409 && error.code === 'privacy_owner_only') {
      showPrivacyConfirm(form, privacyLowering(form, logic));
      return;
    }
    if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
      say(form, result.status === 400 ? errorMessage(result) : copy.saveFailed || errorMessage(result));
      return;
    }
    // Saved: the page is read again from what the engine now holds.
    delete form.dataset.dirty;
    if (field) field.defaultValue = field.value;
    say(form, copy.saved || 'Saved.');
    await refreshNow(true);
    const next = query<HTMLFormElement>('form[data-privacy-form]');
    if (next) say(next, copy.saved || 'Saved.');
  }

  /** The editor's clicks; true when the click was the editor's. */
  function onPrivacyClick(target: Element, event: Event): boolean {
    const form = target.closest<HTMLFormElement>('form[data-privacy-form]');
    if (!form) return false;
    const remove = target.closest<HTMLElement>('[data-privacy-remove]');
    if (remove) {
      const row = remove.closest<HTMLElement>('[data-privacy-rule]');
      if (row) togglePrivacyRemoved(form, row);
      return true;
    }
    const add = target.closest<HTMLElement>('[data-privacy-add]');
    if (add) {
      openPrivacyPanel(form, add.dataset.privacyAdd || '');
      return true;
    }
    const close = target.closest<HTMLElement>('[data-privacy-panel-close]');
    if (close) {
      const panel = close.closest<HTMLElement>('[data-privacy-panel]');
      if (panel) closePrivacyPanel(panel);
      return true;
    }
    if (target.closest('[data-privacy-sender-add]')) {
      addPrivacySender(form);
      return true;
    }
    if (target.closest('[data-privacy-confirm-yes]')) {
      void savePrivacy(form, true);
      return true;
    }
    if (target.closest('[data-privacy-confirm-no]')) {
      clearPrivacyPrompts(form);
      form.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
      return true;
    }
    if (target.closest('[data-privacy-apply-again]')) {
      privacyApplyAgain(form);
      return true;
    }
    if (target.closest('[data-privacy-discard-mine]')) {
      delete form.dataset.dirty;
      delete form.dataset.server;
      clearPrivacyPrompts(form);
      const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
      if (field) field.value = field.defaultValue;
      void refreshNow(true);
      return true;
    }
    const make = target.closest<HTMLButtonElement>('[data-privacy-make-private]');
    if (make) {
      try {
        const rule = JSON.parse(make.dataset.privacyMakePrivate || '') as PrivacyRule;
        if (addPrivacyRule(form, rule)) {
          make.textContent = privacyCopy(form).alreadyPrivate || 'Already private';
          make.disabled = true;
        }
      } catch {
        // A malformed button adds nothing.
      }
      return true;
    }
    const panel = target.closest<HTMLElement>('[data-privacy-panel="folder"]');
    if (panel) {
      const source = target.closest<HTMLElement>('[data-privacy-folder-source]');
      if (source) {
        void loadPrivacyFolders(form, panel, source.dataset.privacyFolderSource || '', []);
        return true;
      }
      const open = target.closest<HTMLElement>('[data-privacy-folder-open]');
      if (open && panel.dataset.source) {
        try {
          const step = JSON.parse(open.dataset.privacyFolderOpen || '') as { key: string; name: string };
          void loadPrivacyFolders(form, panel, panel.dataset.source, [...privacyPath(panel), step]);
        } catch {
          // A malformed button opens nothing.
        }
        return true;
      }
      if (target.closest('[data-privacy-folder-up]') && panel.dataset.source) {
        void loadPrivacyFolders(form, panel, panel.dataset.source, privacyPath(panel).slice(0, -1));
        return true;
      }
      const more = target.closest<HTMLElement>('[data-privacy-folder-more]');
      if (more && panel.dataset.source) {
        void loadPrivacyFolders(form, panel, panel.dataset.source, privacyPath(panel), more.dataset.privacyFolderMore || undefined);
        return true;
      }
    }
    const cancel = target.closest<HTMLAnchorElement>('[data-privacy-cancel]');
    if (cancel) {
      const field = form.querySelector<HTMLTextAreaElement>('textarea[name="description"]');
      const edited = form.dataset.dirty === 'true' || (field !== null && field.value !== field.defaultValue);
      if (edited && !window.confirm(privacyCopy(form).discard || 'Discard your changes?')) {
        event.preventDefault();
        return true;
      }
      delete form.dataset.dirty;
      if (field) field.value = field.defaultValue;
      return false;
    }
    return false;
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
    if (form.hasAttribute('data-privacy-form')) {
      event.preventDefault();
      void savePrivacy(form);
      return;
    }
    if (!form.matches(
      '[data-connect-kind],[data-sync-kind],[data-embedding-kind],[data-model-retry],[data-disconnect-kind],[data-unpair-kind],[data-model-check]',
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
    if (onPrivacyClick(target, event)) return;
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
    const controlLink = target.closest<HTMLElement>('[data-control-link]');
    if (controlLink) {
      event.preventDefault();
      if (!canWrite && !csrfToken) {
        say(controlLink.closest('.rowlink') || controlLink, 'Your OpenClaw connection has read-only access.');
        return;
      }
      const href = controlLink.dataset.controlLink;
      if (href) options.navigate(href);
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

  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  root.addEventListener('input', onPrivacyInput);
  root.addEventListener('change', onPrivacyChange);
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
  restartPoll();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (interval) clearInterval(interval);
    view.removeEventListener('focus', refreshOnReturn);
    root.ownerDocument.removeEventListener('visibilitychange', onVisibilityReturn);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onPrivacyInput);
    root.removeEventListener('change', onPrivacyChange);
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

/** The folder picker shares the same transport and lifetime, with local edit state. */
export function mountDispositionsController(options: OlympusBrowserControllerOptions): OlympusBrowserController {
  let canWrite = options.canWrite;
  let signature = options.signature || '';
  let disposed = false;
  let dirty = false;
  let inFlight = false;
  let presented = options.presented !== false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let renewalInterval: ReturnType<typeof setInterval> | undefined;
  let lastActivityMs = 0;
  let lastRenewalMs = Date.now();
  let appliedCanWrite: boolean | undefined;
  const root = options.root;
  const labels: Record<string, string> = {
    ingest: 'Fully indexed',
    metadata_only: 'Names only',
    exclude: 'Skipped',
  };

  // The folder picker (Dropbox, Google Drive): one level per screen, the same
  // layout as the approved ChatGPT picker. The root shows the whole-account
  // row, the exceptions and the top-level folders; a folder shows its own
  // choice ("This folder") and then its folders. Every row carries one
  // three-segment control (Full, Names only, Skip): a tap sets that folder's
  // own choice and a tap on the pressed segment clears it. Only explicit
  // choices are held; inherited choices and Mixed are derived on each render.
  // Words come from the form's data-scope-copy (DASHBOARD_PICKER_COPY): this
  // function is serialized into the standalone page and cannot import them.
  type ScopeCopy = typeof DASHBOARD_PICKER_COPY;
  type ScopeState = OlympusSourceDispositionState;
  type ScopeDraft = {
    generation: string;
    revision: string;
    selections: Map<string, ScopeState>;
    ancestors: Map<string, string[]>;
    nodes: OlympusFolderScopeNode[];
    catalog: Map<string, OlympusFolderScopeNode>;
    branches: Map<string, OlympusFolderScopeNode[]>;
    branchCursors: Map<string, string>;
    nextCursor?: string | undefined;
    /** The open folder's trail, root first; empty on the root screen. */
    path: string[];
    loaded: boolean;
    loadAttempted: boolean;
    loading: boolean;
    busy: boolean;
    saving: boolean;
    invalid: boolean;
    edited: boolean;
    whole: boolean;
    wholeConfirmed: boolean;
    retry?: (() => void) | undefined;
    /** The control to focus after the next render (a data-scope-focus value). */
    focus?: string | undefined;
  };
  const SCOPE_STATES: ScopeState[] = ['ingest', 'metadata_only', 'exclude'];
  /** The control.approve route accepts at most this many explicit choices. */
  const MAX_SCOPE_RULES = 100;
  const ACCOUNT_KEY = '@account';
  const scopeDrafts = new Map<HTMLFormElement, ScopeDraft>();
  const scopeCopies = new WeakMap<HTMLFormElement, ScopeCopy>();

  function scopeMessage(form: HTMLFormElement, text: string): void {
    const slot = form.querySelector('[data-scope-message]');
    if (slot) slot.textContent = text;
  }

  function scopeCopy(form: HTMLFormElement): ScopeCopy {
    let copy = scopeCopies.get(form);
    if (!copy) {
      try { copy = JSON.parse(form.dataset.scopeCopy || '{}') as ScopeCopy; } catch { copy = {} as ScopeCopy; }
      scopeCopies.set(form, copy);
    }
    return copy;
  }

  function fillText(template: string | undefined, values: Record<string, string | number>): string {
    let out = template || '';
    for (const key of Object.keys(values)) out = out.split(`{${key}}`).join(String(values[key]));
    return out;
  }

  function scopeDraft(form: HTMLFormElement): ScopeDraft {
    let draft = scopeDrafts.get(form);
    if (!draft) {
      draft = {
        generation: form.dataset.accountGeneration || '', revision: form.dataset.scopeRevision || '',
        selections: new Map(), ancestors: new Map(), nodes: [], catalog: new Map(), branches: new Map(), branchCursors: new Map(),
        path: [], loaded: false, loadAttempted: false, loading: false, busy: false, saving: false,
        invalid: false, edited: false, whole: false, wholeConfirmed: false,
      };
      scopeDrafts.set(form, draft);
    }
    return draft;
  }

  function scopeAllowed(form: HTMLFormElement, draft: ScopeDraft): boolean {
    return canWrite && form.dataset.connected === 'true' && !draft.busy && !draft.invalid;
  }

  /** What a folder gets from above it: the strictest choice wins, as the engine evaluates it. */
  function scopeInherited(draft: ScopeDraft, key: string): { state: ScopeState | ''; from: string } {
    let state: ScopeState | '' = draft.whole ? 'ingest' : '';
    let from = draft.whole ? ACCOUNT_KEY : '';
    for (const ancestor of draft.ancestors.get(key) || []) {
      const choice = draft.selections.get(ancestor);
      if (choice === 'exclude') { state = 'exclude'; from = ancestor; }
      else if (choice === 'metadata_only' && state !== 'exclude') { state = 'metadata_only'; from = ancestor; }
      else if (choice === 'ingest' && (state === '' || state === 'ingest')) { state = 'ingest'; from = ancestor; }
    }
    return { state, from };
  }

  /** The state a save records for a chosen folder; a folder nothing reaches stays out. */
  function effectiveScopeState(draft: ScopeDraft, key: string): ScopeState {
    const inherited = scopeInherited(draft, key).state;
    const own = draft.selections.get(key);
    if (inherited === 'exclude' || own === 'exclude') return 'exclude';
    if (inherited === 'metadata_only') return 'metadata_only';
    return own || inherited || 'exclude';
  }

  /** What the page shows for a folder: '' when nothing chooses it (Not included). */
  function shownScopeState(draft: ScopeDraft, key: string): ScopeState | '' {
    return draft.selections.has(key) || scopeInherited(draft, key).state ? effectiveScopeState(draft, key) : '';
  }

  /** A child can never be more open than its parent. */
  function scopeChoiceAllowed(draft: ScopeDraft, key: string, state: ScopeState): boolean {
    const inherited = scopeInherited(draft, key).state;
    if (inherited === 'exclude') return state === 'exclude';
    if (inherited === 'metadata_only') return state !== 'ingest';
    return true;
  }

  /** Mixed: the first shown choice below a folder that differs from its own, or ''. */
  function scopeMixed(draft: ScopeDraft, key: string): ScopeState | '' {
    // Effective access, not the drawn state: a folder nothing reaches and a
    // skipped folder inside it both let Olympus read nothing, so that is not Mixed.
    const own = effectiveScopeState(draft, key);
    for (const other of draft.selections.keys()) {
      if (other === key || !(draft.ancestors.get(other) || []).includes(key)) continue;
      const theirs = effectiveScopeState(draft, other);
      if (theirs !== own) return theirs;
    }
    return '';
  }

  /** Exceptions: folders whose own choice differs from what they would inherit. */
  function scopeExceptions(draft: ScopeDraft): string[] {
    return Array.from(draft.selections.keys()).filter((key) => draft.selections.get(key) !== scopeInherited(draft, key).state);
  }

  function scopeAnyChosen(draft: ScopeDraft): boolean {
    return Array.from(draft.selections.keys()).some((key) => effectiveScopeState(draft, key) !== 'exclude');
  }

  function scopeNameOf(form: HTMLFormElement, draft: ScopeDraft, key: string): string {
    const Q = scopeCopy(form);
    if (key === ACCOUNT_KEY) return fillText(Q.accountRow, { source: form.dataset.scopeLabel || '' });
    const node = draft.catalog.get(key);
    if (node?.name) return node.name;
    const above = (draft.ancestors.get(key) || []).filter((ancestor) => draft.catalog.get(ancestor)?.name);
    return above.length ? fillText(Q.insideFolder, { name: draft.catalog.get(above[above.length - 1]!)!.name }) : Q.unknownFolder;
  }

  /** An exception's label: its name under its parent's ("Clients / Archive 2019") when both are listed. */
  function scopeShortPath(form: HTMLFormElement, draft: ScopeDraft, key: string): string {
    const node = draft.catalog.get(key);
    if (!node?.name) return scopeNameOf(form, draft, key);
    const ancestors = draft.ancestors.get(key) || [];
    const parent = ancestors.length ? draft.catalog.get(ancestors[ancestors.length - 1]!) : undefined;
    return parent?.name ? `${parent.name} / ${node.name}` : node.name;
  }

  function scopeTrail(draft: ScopeDraft, key: string): string[] {
    return [...(draft.ancestors.get(key) || []), key];
  }

  function scopeEl(tag: string, className = '', text?: string): HTMLElement {
    const node = root.ownerDocument.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function scopeButton(className: string, text: string, focusKey: string, enabled: boolean): HTMLButtonElement {
    const button = scopeEl('button', className, text) as HTMLButtonElement;
    button.type = 'button';
    button.dataset.scopeFocus = focusKey;
    button.disabled = !enabled;
    return button;
  }

  /**
   * One pill of three segments: toggle buttons (aria-pressed) in a labelled
   * group, since a pressed segment can be cleared. One tab stop; arrow keys,
   * Home and End move focus between segments without choosing (scopeKeydown).
   * The explicit choice is filled; a choice that applies without being made
   * here is drawn weaker (outlined).
   */
  function scopeSegments(form: HTMLFormElement, draft: ScopeDraft, key: string, name: string, enabled: boolean): HTMLElement {
    const Q = scopeCopy(form);
    const account = key === ACCOUNT_KEY;
    const own = account ? (draft.whole ? 'ingest' : '') : draft.selections.get(key) || '';
    const from = account ? { state: '' as const, from: '' } : scopeInherited(draft, key);
    const now = account ? own : shownScopeState(draft, key);
    const node = draft.catalog.get(key);
    const capped = !account && !own && draft.selections.size >= MAX_SCOPE_RULES;
    const group = scopeEl('div', 'seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', fillText(Q.choiceGroup, { name }));
    const buttons: HTMLButtonElement[] = [];
    for (const state of SCOPE_STATES) {
      const [long, short] = Q.segments[state];
      const pressed = own === state;
      // An own choice a stricter parent overrides shows the winning choice beside it.
      const inherited = !pressed && (own ? now !== own && now === state : from.state === state);
      const button = scopeButton(`seg-opt${pressed ? ' on' : inherited ? ' inherited' : ''}`, '', `seg:${key}:${state}`, enabled);
      button.dataset.scopeKey = key;
      button.dataset.scopeState = state;
      button.setAttribute('aria-label', long);
      button.setAttribute('aria-pressed', String(pressed));
      button.append(scopeEl('span', 'seg-long', long), scopeEl('span', 'seg-short', short));
      const fromName = from.from ? scopeNameOf(form, draft, from.from) : '';
      const blocked = pressed ? '' : account
        ? (state === 'ingest' ? '' : Q.wholeOnlyFull)
        : node && !node.selectable ? Q.cannotChoose
          : from.state && !scopeChoiceAllowed(draft, key, state) ? fillText(Q.notPossible, { parent: fromName, state: Q.statesLower[from.state] })
            : capped ? fillText(Q.capReached, { max: MAX_SCOPE_RULES }) : '';
      const note = blocked
        || (own === state && now && now !== own ? fillText(Q.overridden, { own: Q.states[own], parent: fromName, state: Q.states[now] }) : '')
        || (!own && from.from && from.state === state ? fillText(Q.inheritedFrom, { parent: fromName }) : '');
      if (note) { button.setAttribute('aria-description', note); button.title = note; }
      if (blocked) button.disabled = true;
      buttons.push(button);
      group.appendChild(button);
    }
    const live = buttons.filter((button) => !button.disabled);
    const home = live.find((button) => button.dataset.scopeFocus === draft.focus)
      || live.find((button) => button.classList.contains('on'))
      || live.find((button) => button.classList.contains('inherited')) || live[0] || buttons[0];
    for (const button of buttons) button.tabIndex = button === home ? 0 : -1;
    return group;
  }

  /** The folder's drill-in button (chevron and name are one target), or a leaf's name with the same gap. */
  function scopeNameCell(form: HTMLFormElement, draft: ScopeDraft, node: OlympusFolderScopeNode, enabled: boolean): HTMLElement {
    const Q = scopeCopy(form);
    let label: HTMLElement;
    if (node.has_children) {
      const open = scopeButton('fname', '', `open:${node.key}`, enabled && !draft.loading);
      open.dataset.scopeOpen = node.key;
      open.setAttribute('aria-label', fillText(Q.openFolder, { name: node.name }));
      const chevron = scopeEl('span', 'fopen', '›'); chevron.setAttribute('aria-hidden', 'true');
      open.appendChild(chevron);
      label = open;
    } else {
      label = scopeEl('p', 'fname leaf');
      const gap = scopeEl('span', 'fopen-gap'); gap.setAttribute('aria-hidden', 'true');
      label.appendChild(gap);
    }
    label.title = node.name;
    const main = scopeEl('span', 'fname-main');
    main.appendChild(scopeEl('span', 'fname-text', node.name));
    const differs = scopeMixed(draft, node.key);
    if (differs) {
      const tag = scopeEl('span', 'ftag', Q.mixed);
      tag.title = fillText(Q.mixedSome, { state: Q.statesLower[differs] });
      main.appendChild(tag);
    }
    label.appendChild(main);
    return label;
  }

  function scopeLevelList(form: HTMLFormElement, draft: ScopeDraft, parent: string, nodes: OlympusFolderScopeNode[], more: boolean, enabled: boolean): HTMLElement {
    const Q = scopeCopy(form);
    const list = scopeEl('ul', 'flist');
    list.dataset.scopeNodes = parent;
    list.setAttribute('aria-busy', String(draft.loading));
    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.key)) continue;
      seen.add(node.key);
      const row = scopeEl('li', 'frow seg-row');
      row.dataset.scopeRow = node.key;
      row.append(scopeNameCell(form, draft, node, enabled), scopeSegments(form, draft, node.key, node.name, enabled && !draft.saving));
      list.appendChild(row);
    }
    if (!nodes.length && draft.loaded && !draft.loading) list.appendChild(scopeEl('li', 'fempty', Q.noFolders));
    if (more) {
      const item = scopeEl('li', 'fmore');
      const button = scopeButton('secondary', draft.loading ? Q.loadingFolders : Q.loadMore, `more:${parent}`, enabled && !draft.loading);
      button.dataset.scopeMore = parent;
      item.appendChild(button);
      list.appendChild(item);
    }
    return list;
  }

  function scopeTopRow(text: string, control: HTMLElement, className = ''): HTMLElement {
    const row = scopeEl('div', `this-row${className ? ` ${className}` : ''}`);
    row.append(scopeEl('p', 'this-label', text), control);
    return row;
  }

  function scopeRootScreen(form: HTMLFormElement, draft: ScopeDraft, view: HTMLElement, enabled: boolean): void {
    const Q = scopeCopy(form);
    const source = form.dataset.scopeLabel || '';
    const accountName = fillText(Q.accountRow, { source });
    view.appendChild(scopeTopRow(accountName, scopeSegments(form, draft, ACCOUNT_KEY, accountName, enabled && draft.loaded && !draft.saving), 'account-row'));
    if (draft.whole && !draft.wholeConfirmed) {
      const box = scopeEl('div', 'confirm-box');
      box.dataset.scopeConfirm = '';
      const actions = scopeEl('div', 'actions');
      const yes = scopeButton('danger', Q.wholeConfirm, 'whole-yes', enabled && !draft.saving); yes.dataset.scopeWholeConfirm = '';
      const no = scopeButton('secondary', Q.wholeCancel, 'whole-no', enabled && !draft.saving); no.dataset.scopeWholeCancel = '';
      actions.append(yes, no);
      box.append(scopeEl('p', 'strong', fillText(Q.wholePrompt, { source })), actions);
      view.appendChild(box);
    }
    const exceptions = draft.loaded ? scopeExceptions(draft) : [];
    if (exceptions.length) {
      const section = scopeEl('section', 'fsection exceptions');
      section.appendChild(scopeEl('h2', '', fillText(Q.exceptions, { n: exceptions.length })));
      const list = scopeEl('ul', 'flist');
      for (const key of exceptions) {
        const state = draft.selections.get(key)!;
        const jump = scopeButton('jump-btn', '', `jump:${key}`, enabled && !draft.loading);
        jump.dataset.scopeJump = key;
        jump.title = scopeShortPath(form, draft, key);
        const chevron = scopeEl('span', 'chev', '›'); chevron.setAttribute('aria-hidden', 'true');
        jump.append(scopeEl('span', 'fname-text', scopeShortPath(form, draft, key)), scopeEl('span', `jtag jtag-${state}`, Q.segments[state][0]), chevron);
        const item = scopeEl('li', 'frow jump'); item.appendChild(jump);
        list.appendChild(item);
      }
      section.appendChild(list);
      view.appendChild(section);
    }
    const folders = scopeEl('section', 'fsection');
    folders.appendChild(scopeEl('h2', '', Q.foldersHeading));
    folders.appendChild(scopeLevelList(form, draft, '', draft.nodes, !!draft.nextCursor, enabled));
    view.appendChild(folders);
  }

  function scopeFolderScreen(form: HTMLFormElement, draft: ScopeDraft, view: HTMLElement, enabled: boolean): void {
    const Q = scopeCopy(form);
    const key = draft.path[draft.path.length - 1]!;
    const up = scopeButton('secondary back', Q.up, 'up', !draft.saving);
    up.dataset.scopeUp = '';
    view.appendChild(up);
    const names = [form.dataset.scopeLabel || '', ...draft.path.map((entry) => scopeNameOf(form, draft, entry))];
    const shown = names.length > 3 ? [Q.pathMore, ...names.slice(-2)] : names;
    const head = scopeEl('h2', 'fpath');
    shown.forEach((name, index) => {
      head.appendChild(index === shown.length - 1 ? scopeEl('span', 'fpath-here', name) : scopeEl('span', 'fpath-up', `${name} / `));
    });
    view.appendChild(head);
    view.appendChild(scopeTopRow(Q.thisFolder, scopeSegments(form, draft, key, scopeNameOf(form, draft, key), enabled && !draft.saving)));
    view.appendChild(scopeLevelList(form, draft, key, draft.branches.get(key) || [], draft.branchCursors.has(key), enabled));
  }

  /** The footer: what happens when you save, then one primary Save and Discard changes. */
  function scopeFooter(form: HTMLFormElement, draft: ScopeDraft): void {
    const Q = scopeCopy(form);
    const allowed = scopeAllowed(form, draft);
    const totals: Record<ScopeState, number> = { ingest: 0, metadata_only: 0, exclude: 0 };
    for (const key of draft.selections.keys()) totals[effectiveScopeState(draft, key)] += 1;
    const parts: string[] = [];
    for (const [state, template] of [['ingest', Q.summaryIngest], ['metadata_only', Q.summaryMetadata], ['exclude', Q.summaryExclude]] as Array<[ScopeState, string]>) {
      const n = totals[state];
      if (!n) continue;
      parts.push(fillText(template, { n: parts.length ? String(n) : `${n} ${n === 1 ? Q.summaryFolder.one : Q.summaryFolder.many}` }));
    }
    const lines: string[] = [];
    if (draft.whole) lines.push(fillText(Q.summaryWhole, { source: form.dataset.scopeLabel || '' }));
    if (parts.length) lines.push(parts.join(', '));
    else if (!draft.whole) lines.push(Q.summaryNone);
    if (draft.selections.size >= MAX_SCOPE_RULES) lines.push(fillText(Q.capReached, { max: MAX_SCOPE_RULES }));
    const summary = form.querySelector('[data-scope-summary]');
    if (summary) summary.replaceChildren(...lines.map((line) => scopeEl('p', '', line)));
    const chosen = scopeAnyChosen(draft);
    const ready = allowed && draft.loaded && !!draft.generation && !!draft.revision && draft.selections.size <= MAX_SCOPE_RULES;
    const blocker = draft.whole && !draft.wholeConfirmed ? Q.needConfirm : !draft.whole && !chosen && !draft.edited ? Q.needChoice : '';
    const submit = form.querySelector<HTMLButtonElement>('[data-scope-start]');
    if (submit) {
      submit.disabled = !ready || blocker !== '';
      submit.textContent = draft.saving ? Q.saving : draft.whole || chosen ? Q.saveFolders : Q.saveNoStart;
      submit.setAttribute('aria-busy', String(draft.saving));
    }
    const reason = form.querySelector('[data-scope-reason]');
    if (reason) reason.textContent = draft.saving || form.dataset.connected !== 'true' ? '' : blocker;
    const cancel = form.querySelector<HTMLButtonElement>('[data-scope-cancel]');
    if (cancel) cancel.disabled = !canWrite || draft.busy || (!draft.edited && !draft.invalid);
  }

  /** Re-render the open level and the footer from the draft, keeping focus on the same control. */
  function renderScope(form: HTMLFormElement, draft: ScopeDraft): void {
    const Q = scopeCopy(form);
    const allowed = scopeAllowed(form, draft);
    const loading = form.querySelector<HTMLElement>('[data-scope-loading]');
    if (loading) loading.hidden = !draft.loading;
    const back = form.closest('[data-scope-panel]')?.querySelector<HTMLElement>('.scope-back');
    if (back) back.hidden = draft.path.length > 0;
    const view = form.querySelector<HTMLElement>('[data-scope-view]');
    // A disconnected account has nothing to choose yet: only its Connect line shows.
    const connected = form.dataset.connected === 'true';
    if (view) view.hidden = !connected;
    const footer = form.querySelector<HTMLElement>('.picker-footer');
    if (footer) footer.hidden = !connected;
    if (view && connected) {
      const tree = root.getRootNode();
      const active = tree instanceof ShadowRoot ? tree.activeElement : root.ownerDocument.activeElement;
      const keep = draft.focus || (active instanceof HTMLElement && view.contains(active) ? active.dataset.scopeFocus : undefined);
      view.replaceChildren();
      if (draft.retry && !draft.loading) {
        const banner = scopeEl('div', 'scope-error');
        banner.setAttribute('role', 'alert');
        const retry = scopeButton('secondary', Q.tryAgain, 'retry', canWrite && !draft.invalid);
        retry.dataset.scopeBrowseRoot = '';
        banner.append(scopeEl('p', '', Q.loadFailed), retry);
        view.appendChild(banner);
      }
      if (draft.path.length) scopeFolderScreen(form, draft, view, allowed);
      else scopeRootScreen(form, draft, view, allowed);
      if (!allowed) view.querySelectorAll<HTMLButtonElement>('button:not([data-scope-up])').forEach((button) => { button.disabled = true; });
      draft.focus = undefined;
      if (keep) {
        const controls = Array.from(view.querySelectorAll<HTMLButtonElement>('button[data-scope-focus]'));
        let target = controls.find((node) => node.dataset.scopeFocus === keep && !node.disabled);
        // The control that had focus is gone or disabled (a cleared choice whose
        // segment a stricter parent now blocks): stay on the same folder's
        // control, on the choice it inherits, else on any control still enabled.
        if (!target && !draft.busy) {
          const key = keep.startsWith('seg:') ? keep.slice(4, keep.lastIndexOf(':')) : '';
          const same = controls.filter((node) => !node.disabled && key !== '' && node.dataset.scopeKey === key);
          target = same.find((node) => node.classList.contains('inherited')) || same.find((node) => node.classList.contains('on'))
            || same[0] || controls.find((node) => !node.disabled);
        }
        target?.focus();
      }
    }
    scopeFooter(form, draft);
  }

  /** List one level (the root, or a folder by its trail). Resolves true once it is listed. */
  async function browseScope(form: HTMLFormElement, trail: string[], append = false): Promise<boolean> {
    const draft = scopeDraft(form);
    const Q = scopeCopy(form);
    if (!scopeAllowed(form, draft) || !options.transport.read) return false;
    const parent = trail.at(-1);
    const cursor = append ? (parent ? draft.branchCursors.get(parent) : draft.nextCursor) : undefined;
    draft.loadAttempted = true; draft.loading = true; draft.busy = true; draft.retry = undefined;
    scopeMessage(form, ''); renderScope(form, draft);
    let listed = false;
    // Try again repeats what was asked: a folder that would not open is opened again.
    const again = parent && !append ? () => { void drillScope(form, draft, parent); } : () => { void browseScope(form, trail, append); };
    try {
      const result = await options.transport.read({
        view: 'dispositions', action: 'browse_folder_scope',
        source_id: form.dataset.folderScopeSource as OlympusFolderScopeSourceId,
        ...(parent ? { parent_key: parent } : {}), ...(cursor ? { cursor } : {}),
      });
      if (disposed || options.signal.aborted || !root.contains(form)) return false;
      if (result.status === 401 || result.status === 403 || !result.can_write) {
        canWrite = false; scopeMessage(form, Q.readOnly); return false;
      }
      const page: OlympusFolderScopeBrowseResult | undefined = result.scope_browser;
      if (result.status < 200 || result.status >= 300 || !page
        || page.source_id !== form.dataset.folderScopeSource || !page.account_generation || !page.scope_revision
        || !Array.isArray(page.nodes) || page.nodes.some((node) => typeof node.key !== 'string'
          || typeof node.name !== 'string' || node.kind !== 'folder' || typeof node.selectable !== 'boolean')) {
        draft.retry = again; return false;
      }
      if (draft.loaded && (draft.generation !== page.account_generation || draft.revision !== page.scope_revision)) {
        draft.invalid = true; scopeMessage(form, Q.conflict); return false;
      }
      if (page.nodes.some((node) => trail.includes(node.key))) {
        draft.invalid = true; scopeMessage(form, Q.cycle); return false;
      }
      if (!draft.loaded) {
        draft.generation = page.account_generation; draft.revision = page.scope_revision;
        draft.selections = new Map(page.selections.map((selection) => [selection.key, selection.state]));
        page.selections.forEach((selection) => draft.ancestors.set(selection.key, selection.ancestor_keys || []));
        draft.whole = page.whole_account_selected;
        draft.wholeConfirmed = false;
      }
      draft.loaded = true;
      const previous = append ? (parent ? draft.branches.get(parent) || [] : draft.nodes) : [];
      const fresh = page.nodes.filter((node) => !previous.some((old) => old.key === node.key));
      // Alphabetical, numbers in numeric order ("2 Areas" before "10 Notes"),
      // whatever order the provider lists them in.
      const nodes = [...previous, ...fresh].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        || a.key.localeCompare(b.key));
      if (parent) {
        draft.branches.set(parent, nodes);
        if (page.next_cursor) draft.branchCursors.set(parent, page.next_cursor); else draft.branchCursors.delete(parent);
      } else {
        draft.nodes = nodes; draft.nextCursor = page.next_cursor;
        if (!append) { draft.branches.clear(); draft.branchCursors.clear(); draft.path = []; }
      }
      page.nodes.forEach((node) => {
        draft.catalog.set(node.key, node);
        draft.ancestors.set(node.key, trail.slice());
      });
      listed = true;
      return true;
    } catch {
      if (!disposed && root.contains(form)) {
        draft.retry = again;
        scopeMessage(form, Q.browseFailed);
      }
      return false;
    } finally {
      draft.loading = false; draft.busy = false;
      // A folder that opened is shown by its caller (drill or jump), with Back focused.
      if (!disposed && root.contains(form) && (!listed || !parent || append)) {
        if (listed && append) draft.focus = `more:${parent || ''}`;
        renderScope(form, draft);
      }
    }
  }

  /** Open a folder: list it once, then show it with Back focused. */
  async function drillScope(form: HTMLFormElement, draft: ScopeDraft, key: string): Promise<void> {
    const trail = scopeTrail(draft, key);
    if (!draft.branches.has(key) && !await browseScope(form, trail)) return;
    if (disposed || !root.contains(form)) return;
    draft.path = trail; draft.focus = 'up'; renderScope(form, draft);
  }

  /** Open a folder anywhere, listing each level above it once with the ancestor keys already held. */
  async function jumpScope(form: HTMLFormElement, draft: ScopeDraft, key: string): Promise<void> {
    const trail = scopeTrail(draft, key);
    for (let index = 0; index < trail.length; index += 1) {
      if (draft.branches.has(trail[index]!)) continue;
      if (!await browseScope(form, trail.slice(0, index + 1))) return;
      if (disposed || !root.contains(form)) return;
    }
    draft.path = trail; draft.focus = 'up'; renderScope(form, draft);
  }

  /** Set (or with '' clear) one folder's own choice, or the whole account's. */
  function chooseScope(form: HTMLFormElement, draft: ScopeDraft, key: string, state: ScopeState | ''): void {
    if (draft.saving) return;
    if (key === ACCOUNT_KEY) {
      const whole = state === 'ingest';
      if (whole === draft.whole) return;
      draft.whole = whole; draft.wholeConfirmed = false; draft.edited = true;
      draft.focus = whole ? 'whole-yes' : `seg:${ACCOUNT_KEY}:ingest`;
    } else {
      if (state && (!scopeChoiceAllowed(draft, key, state) || draft.catalog.get(key)?.selectable === false)) return;
      if (state && !draft.selections.has(key) && draft.selections.size >= MAX_SCOPE_RULES) return;
      if (state) draft.selections.set(key, state); else draft.selections.delete(key);
      draft.edited = true;
      draft.focus = `seg:${key}:${state || scopeInherited(draft, key).state || 'ingest'}`;
    }
    renderScope(form, draft);
  }

  async function approveScope(form: HTMLFormElement): Promise<void> {
    const draft = scopeDraft(form);
    const Q = scopeCopy(form);
    if (!scopeAllowed(form, draft) || !draft.loaded || !draft.generation || !draft.revision
      || draft.selections.size > MAX_SCOPE_RULES
      || (!draft.whole && !draft.edited && !scopeAnyChosen(draft))
      || (draft.whole && !draft.wholeConfirmed)) {
      scopeMessage(form, draft.whole && !draft.wholeConfirmed ? Q.needConfirm : Q.needChoice); return;
    }
    draft.busy = true; draft.saving = true; scopeMessage(form, ''); renderScope(form, draft);
    try {
      const result = await options.transport.control({
        action: 'approve_source_scope_and_start', source_id: form.dataset.folderScopeSource as OlympusFolderScopeSourceId,
        account_generation: draft.generation, expected_scope_revision: draft.revision,
        selections: Array.from(draft.selections.keys(), (key) => ({ key, state: effectiveScopeState(draft, key), ancestor_keys: draft.ancestors.get(key) || [] })),
        whole_account: draft.whole, explicit_whole_account_confirmation: draft.whole && draft.wholeConfirmed,
      });
      if (disposed || options.signal.aborted || !root.contains(form)) return;
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        if (result.status === 401 || result.status === 403) canWrite = false;
        if (result.status === 409) draft.invalid = true;
        const error = result.body.error;
        const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
        scopeMessage(form, typeof message === 'string' ? message : Q.saveFailed); return;
      }
      draft.edited = false;
      scopeMessage(form, Q.saved);
      if (!dirty && !Array.from(scopeDrafts.values()).some((other) => other.edited)) {
        options.navigate(`/dashboard?source=${encodeURIComponent(form.dataset.folderScopeSource || '')}`);
      }
    } catch {
      if (!disposed && root.contains(form)) scopeMessage(form, Q.unconfirmed);
    } finally {
      draft.busy = false; draft.saving = false;
      if (!disposed && root.contains(form)) renderScope(form, draft);
    }
  }

  function scopeClick(target: Element): boolean {
    const form = target.closest<HTMLFormElement>('form[data-folder-scope-source]');
    if (!form || !root.contains(form)) return false;
    const draft = scopeDraft(form);
    const Q = scopeCopy(form);
    const control = target.closest<HTMLButtonElement>('button');
    if (control?.disabled) return true;
    if (target.closest('[data-scope-cancel]')) {
      if (draft.busy) return true;
      scopeDrafts.delete(form);
      const fresh = scopeDraft(form); renderScope(form, fresh); scopeMessage(form, Q.discarded); void browseScope(form, []); return true;
    }
    if (target.closest('[data-scope-up]')) {
      if (draft.saving) return true;
      const left = draft.path.pop();
      draft.focus = left ? `open:${left}` : undefined; renderScope(form, draft); return true;
    }
    if (!scopeAllowed(form, draft)) return true;
    if (target.closest('[data-scope-browse-root]')) {
      if (draft.retry) draft.retry(); else void browseScope(form, []);
      return true;
    }
    const more = target.closest<HTMLElement>('[data-scope-more]');
    if (more) {
      const key = more.dataset.scopeMore || '';
      if (key && draft.branchCursors.has(key)) void browseScope(form, scopeTrail(draft, key), true);
      else if (!key && draft.nextCursor) void browseScope(form, [], true);
      return true;
    }
    const open = target.closest<HTMLElement>('[data-scope-open]');
    if (open?.dataset.scopeOpen) { void drillScope(form, draft, open.dataset.scopeOpen); return true; }
    const jump = target.closest<HTMLElement>('[data-scope-jump]');
    if (jump?.dataset.scopeJump) { void jumpScope(form, draft, jump.dataset.scopeJump); return true; }
    if (target.closest('[data-scope-whole-confirm]')) {
      draft.wholeConfirmed = true; draft.focus = `seg:${ACCOUNT_KEY}:ingest`; renderScope(form, draft); return true;
    }
    if (target.closest('[data-scope-whole-cancel]')) { chooseScope(form, draft, ACCOUNT_KEY, ''); return true; }
    const segment = target.closest<HTMLElement>('[data-scope-key][data-scope-state]');
    const key = segment?.dataset.scopeKey;
    const state = segment?.dataset.scopeState as ScopeState | undefined;
    if (key && state && SCOPE_STATES.includes(state)) {
      const own = key === ACCOUNT_KEY ? (draft.whole ? 'ingest' : '') : draft.selections.get(key) || '';
      chooseScope(form, draft, key, own === state ? '' : state);
    }
    return true;
  }

  /** Arrow keys, Home and End move between a control's enabled segments; Escape goes up a level. */
  function scopeKeydown(event: KeyboardEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const form = target?.closest<HTMLFormElement>('form[data-folder-scope-source]');
    if (!target || !form || !root.contains(form)) return;
    const draft = scopeDraft(form);
    if (event.key === 'Escape' && draft.path.length && !draft.saving) {
      event.preventDefault();
      const left = draft.path.pop();
      draft.focus = left ? `open:${left}` : undefined; renderScope(form, draft); return;
    }
    const group = target.closest('.seg');
    if (!group || !target.matches('.seg-opt')) return;
    const live = Array.from(group.querySelectorAll<HTMLButtonElement>('.seg-opt')).filter((button) => !button.disabled);
    const at = live.indexOf(target as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = live[(at + 1) % live.length];
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = live[(at - 1 + live.length) % live.length];
    else if (event.key === 'Home') next = live[0];
    else if (event.key === 'End') next = live[live.length - 1];
    if (!next) return;
    event.preventDefault();
    group.querySelectorAll<HTMLButtonElement>('.seg-opt').forEach((button) => { button.tabIndex = button === next ? 0 : -1; });
    next.focus();
  }

  // Mail scope (Gmail). Same contract as the folder picker above: nothing
  // loads from the provider except on an explicit browse, nothing starts
  // before the owner presses Save, and a changed account or revision makes
  // the draft invalid rather than silently saving over someone else's scope.
  type MailDraftState = {
    generation: string;
    revision: string;
    loaded: boolean;
    loadAttempted: boolean;
    loading: boolean;
    busy: boolean;
    invalid: boolean;
    edited: boolean;
  };
  const mailDrafts = new Map<HTMLFormElement, MailDraftState>();

  function mailState(form: HTMLFormElement): MailDraftState {
    let state = mailDrafts.get(form);
    if (!state) {
      state = {
        generation: form.dataset.accountGeneration || '', revision: form.dataset.scopeRevision || '',
        loaded: false, loadAttempted: false, loading: false, busy: false, invalid: false, edited: false,
      };
      mailDrafts.set(form, state);
    }
    return state;
  }

  function mailAllowed(form: HTMLFormElement, state: MailDraftState): boolean {
    return canWrite && form.dataset.connected === 'true' && !state.busy && !state.invalid;
  }

  function mailLines(form: HTMLFormElement, selector: string): string[] {
    const value = form.querySelector<HTMLTextAreaElement>(selector)?.value || '';
    return value.split(/[\n,]+/).map((line) => line.trim()).filter((line) => line !== '');
  }

  function mailSavedSkippedLabels(form: HTMLFormElement): Array<{ id: string; name: string }> {
    try {
      const parsed = JSON.parse(form.dataset.mailSkippedLabels || '[]') as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is { id: string; name: string } => !!entry && typeof entry === 'object'
          && typeof (entry as { id?: unknown }).id === 'string' && typeof (entry as { name?: unknown }).name === 'string')
        : [];
    } catch { return []; }
  }

  function readMailDraft(form: HTMLFormElement): OlympusMailScopeDraft {
    const windowInput = form.querySelector<HTMLInputElement>('[data-mail-window]:checked');
    const windowValue = windowInput?.value;
    const labelInputs = Array.from(form.querySelectorAll<HTMLInputElement>('[data-mail-label]'));
    // Before labels load, the saved skips stand; afterwards the checkboxes do.
    const skippedLabels = labelInputs.length > 0
      ? labelInputs.filter((input) => !input.checked).map((input) => ({ id: input.value, name: input.dataset.mailLabelName || input.value }))
      : mailSavedSkippedLabels(form);
    return {
      window: windowValue === '6m' || windowValue === '1y' || windowValue === '5y' || windowValue === 'all' ? windowValue : '2y',
      skipped_categories: Array.from(form.querySelectorAll<HTMLInputElement>('[data-mail-category]'))
        .filter((input) => !input.checked)
        .map((input) => input.value)
        .filter((value): value is OlympusMailScopeDraft['skipped_categories'][number] =>
          value === 'primary' || value === 'social' || value === 'promotions' || value === 'updates' || value === 'forums'),
      skipped_labels: skippedLabels,
      always_private_senders: mailLines(form, '[data-mail-private-senders]'),
      skip_senders: mailLines(form, '[data-mail-skip-senders]'),
    };
  }

  function mailSummaryText(draft: OlympusMailScopeDraft): string {
    const windows: Record<string, string> = { '6m': 'last 6 months', '1y': 'last year', '2y': 'last 2 years', '5y': 'last 5 years', all: 'everything' };
    const skipped = draft.skipped_categories.length + draft.skipped_labels.length;
    return `Full content: ${windows[draft.window] || draft.window}. ${skipped} ${skipped === 1 ? 'category or label' : 'categories and labels'} skipped.`
      + ` ${draft.always_private_senders.length} always Private, ${draft.skip_senders.length} skipped ${draft.skip_senders.length === 1 ? 'sender' : 'senders'}.`;
  }

  function mailControls(form: HTMLFormElement, state: MailDraftState): void {
    const allowed = mailAllowed(form, state);
    form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input,textarea,button').forEach((control) => {
      control.disabled = !allowed;
    });
    const start = form.querySelector<HTMLButtonElement>('[data-mail-start]');
    if (start) start.disabled = !allowed || !state.loaded || state.loading || !state.generation || !state.revision;
    const summary = form.querySelector('[data-mail-summary]');
    if (summary) summary.textContent = mailSummaryText(readMailDraft(form));
  }

  function mailCount(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '—';
  }

  function renderMailSummary(form: HTMLFormElement, summary: Record<string, unknown>): void {
    const skipped = new Set(readMailDraft(form).skipped_labels.map((label) => label.id));
    const labelsSlot = form.querySelector<HTMLElement>('[data-mail-labels]');
    const labels = Array.isArray(summary.labels) ? summary.labels as Array<Record<string, unknown>> : [];
    if (labelsSlot) {
      labelsSlot.replaceChildren();
      if (labels.length === 0) {
        const empty = labelsSlot.ownerDocument.createElement('p');
        empty.className = 'mail-scope-help'; empty.textContent = 'This mailbox has no labels of its own.';
        labelsSlot.append(empty);
      }
      for (const label of labels) {
        if (typeof label.id !== 'string' || typeof label.name !== 'string') continue;
        const row = labelsSlot.ownerDocument.createElement('label');
        row.className = 'mail-scope-option'; row.setAttribute('role', 'listitem');
        const input = labelsSlot.ownerDocument.createElement('input');
        input.type = 'checkbox'; input.value = label.id; input.dataset.mailLabel = '';
        input.dataset.mailLabelName = label.name; input.checked = !skipped.has(label.id);
        const text = labelsSlot.ownerDocument.createElement('span');
        text.textContent = label.id === 'SENT' ? 'Sent' : label.name;
        row.append(input, text); labelsSlot.append(row);
      }
    }
    const categories = Array.isArray(summary.categories) ? summary.categories as Array<Record<string, unknown>> : [];
    for (const category of categories) {
      const slot = form.querySelector(`[data-mail-category-count="${String(category.category)}"]`);
      if (slot) slot.textContent = typeof category.messages_total === 'number' ? ` · ${mailCount(category.messages_total)} in mailbox` : '';
    }
    const suggestions = Array.isArray(summary.sender_suggestions) ? summary.sender_suggestions as Array<Record<string, unknown>> : [];
    const box = form.querySelector<HTMLElement>('[data-mail-suggestions]');
    const list = form.querySelector<HTMLElement>('[data-mail-suggestion-list]');
    if (box && list) {
      list.replaceChildren();
      for (const suggestion of suggestions) {
        if (typeof suggestion.sender !== 'string') continue;
        const item = list.ownerDocument.createElement('li');
        const sender = list.ownerDocument.createElement('span'); sender.className = 'sender'; sender.textContent = suggestion.sender;
        const count = list.ownerDocument.createElement('span'); count.className = 'count';
        count.textContent = `${mailCount(suggestion.sample_messages)} of ${mailCount(summary.sample_size)}`;
        const makePrivate = list.ownerDocument.createElement('button');
        makePrivate.type = 'button'; makePrivate.textContent = 'Always Private';
        makePrivate.dataset.mailSuggest = 'private'; makePrivate.dataset.sender = suggestion.sender;
        const skip = list.ownerDocument.createElement('button');
        skip.type = 'button'; skip.textContent = 'Skip';
        skip.dataset.mailSuggest = 'skip'; skip.dataset.sender = suggestion.sender;
        item.append(sender, count, makePrivate, skip); list.append(item);
      }
      box.hidden = list.childElementCount === 0;
    }
    const estimate = summary.estimate && typeof summary.estimate === 'object' ? summary.estimate as Record<string, unknown> : {};
    const put = (key: string, text: string): void => {
      const slot = form.querySelector(`[data-mail-estimate="${key}"]`); if (slot) slot.textContent = text;
    };
    put('content_messages', `~${mailCount(estimate.content_messages)}`);
    put('metadata_messages', `~${mailCount(estimate.metadata_messages)}`);
    put('embedding_cost_usd', typeof estimate.embedding_cost_usd === 'number'
      ? `≤ $${estimate.embedding_cost_usd.toFixed(2)}` : '—');
  }

  async function browseMail(form: HTMLFormElement): Promise<void> {
    const state = mailState(form);
    if (!mailAllowed(form, state) || state.loading) return;
    state.loading = true; state.loadAttempted = true; mailControls(form, state);
    scopeMessage(form, 'Reading labels, counts and a sample of senders from Gmail…');
    try {
      const result = await options.transport.control({
        action: 'browse_mail_scope', source_id: 'gmail.email', draft: readMailDraft(form),
      });
      if (disposed || options.signal.aborted || !root.contains(form)) return;
      if (result.status === 401 || result.status === 403) {
        canWrite = false; scopeMessage(form, 'Write access expired. Reconnect before reading your mailbox.'); return;
      }
      const body = result.body;
      const summary = body.summary && typeof body.summary === 'object' ? body.summary as Record<string, unknown> : undefined;
      if (result.status < 200 || result.status >= 300 || body.ok !== true || !summary
        || typeof body.account_generation !== 'string' || typeof body.scope_revision !== 'string') {
        const error = body.error;
        const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
        scopeMessage(form, typeof message === 'string' ? message : 'Could not read the mailbox. Check the connection and reopen this picker.');
        return;
      }
      if (state.loaded && (state.generation !== body.account_generation || state.revision !== body.scope_revision)) {
        state.invalid = true;
        scopeMessage(form, 'The mailbox or saved scope changed. Reopen this picker before saving.'); return;
      }
      state.generation = body.account_generation; state.revision = body.scope_revision; state.loaded = true;
      renderMailSummary(form, summary);
      scopeMessage(form, 'Nothing has been read yet. Review the estimate, then save and start.');
    } catch {
      if (!disposed && root.contains(form)) scopeMessage(form, 'Reading the mailbox failed. Your choices are still here; retry when the connection is ready.');
    } finally {
      state.loading = false;
      if (!disposed && root.contains(form)) mailControls(form, state);
    }
  }

  async function approveMail(form: HTMLFormElement): Promise<void> {
    const state = mailState(form);
    if (!mailAllowed(form, state) || !state.loaded || !state.generation || !state.revision) {
      scopeMessage(form, 'Wait for the estimate to load before saving.'); return;
    }
    state.busy = true; mailControls(form, state); scopeMessage(form, 'Saving your approved mail scope…');
    try {
      const result = await options.transport.control({
        action: 'approve_mail_scope_and_start', source_id: 'gmail.email',
        account_generation: state.generation, expected_scope_revision: state.revision, scope: readMailDraft(form),
      });
      if (disposed || options.signal.aborted || !root.contains(form)) return;
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        if (result.status === 401 || result.status === 403) canWrite = false;
        if (result.status === 409) state.invalid = true;
        const error = result.body.error;
        const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
        scopeMessage(form, typeof message === 'string' ? message : 'Scope was not activated. Your choices are still here.'); return;
      }
      state.edited = false;
      scopeMessage(form, 'Scope saved. Opening Gmail…');
      options.navigate('/dashboard?source=gmail.email');
    } catch {
      if (!disposed && root.contains(form)) scopeMessage(form, 'Could not confirm the result. Reopen the picker to check the saved scope before retrying.');
    } finally {
      state.busy = false;
      if (!disposed && root.contains(form)) mailControls(form, state);
    }
  }

  function mailClick(target: Element): boolean {
    const form = target.closest<HTMLFormElement>('form[data-mail-scope-source]');
    if (!form || !root.contains(form)) return false;
    const state = mailState(form);
    if (!mailAllowed(form, state)) return true;
    if (target.closest('[data-mail-refresh]')) { void browseMail(form); return true; }
    if (target.closest('[data-mail-cancel]')) {
      form.reset(); state.edited = false;
      // Labels re-render from the saved skips on the next browse.
      form.querySelector('[data-mail-labels]')?.querySelectorAll<HTMLInputElement>('[data-mail-label]').forEach((input) => {
        input.checked = !mailSavedSkippedLabels(form).some((label) => label.id === input.value);
      });
      mailControls(form, state); scopeMessage(form, 'Changes cancelled.'); return true;
    }
    const suggest = target.closest<HTMLElement>('[data-mail-suggest]');
    if (suggest?.dataset.sender) {
      const area = form.querySelector<HTMLTextAreaElement>(suggest.dataset.mailSuggest === 'skip' ? '[data-mail-skip-senders]' : '[data-mail-private-senders]');
      if (area && !mailLines(form, suggest.dataset.mailSuggest === 'skip' ? '[data-mail-skip-senders]' : '[data-mail-private-senders]').includes(suggest.dataset.sender)) {
        area.value = `${area.value.trim()}${area.value.trim() ? '\n' : ''}${suggest.dataset.sender}`;
        state.edited = true; mailControls(form, state);
      }
      return true;
    }
    return false;
  }

  function query<T extends Element = Element>(selector: string): T | null {
    return root.querySelector(selector) as T | null;
  }

  function selectFolder(row: HTMLElement): void {
    const form = row.closest<HTMLFormElement>('form[data-dispositions-source]');
    if (!form) return;
    form.querySelectorAll('.folder-row.selected').forEach((item) => item.classList.remove('selected'));
    row.classList.add('selected');
    form.dataset.selectedPath = row.dataset.path || '';
    const inspector = form.querySelector<HTMLElement>('.finder-inspector');
    if (!inspector) return;
    const empty = inspector.querySelector<HTMLElement>('[data-inspector-empty]');
    const content = inspector.querySelector<HTMLElement>('[data-inspector-content]');
    if (empty) empty.hidden = true;
    if (content) content.hidden = false;
    const name = inspector.querySelector('[data-inspector-name]');
    const path = inspector.querySelector('[data-inspector-path]');
    const count = inspector.querySelector('[data-inspector-count]');
    const note = inspector.querySelector('[data-inspector-note]');
    if (name) name.textContent = row.dataset.name || '';
    if (path) path.textContent = row.dataset.path || '';
    if (count) count.textContent = row.dataset.counts || '';
    if (note) {
      note.textContent = row.dataset.locked || form.dataset.locked
        || (row.dataset.origin === 'default'
          ? 'Fully indexed by default until you choose otherwise.'
          : row.dataset.origin === 'inherited'
            ? 'Inherited from the nearest folder choice above.'
            : 'This folder has its own choice.');
    }
    const selectable = new Set((row.dataset.selectable || '').split(',').filter(Boolean));
    inspector.querySelectorAll<HTMLButtonElement>('button[data-picker-state]').forEach((button) => {
      const state = button.dataset.pickerState || '';
      button.disabled = !canWrite || !selectable.has(state);
      button.classList.toggle('on', row.dataset.state === state);
    });
  }

  function message(text: string): void {
    const slot = query('#save-message');
    if (slot) slot.textContent = text;
  }

  function applyWriteCapability(): void {
    root.querySelectorAll<HTMLFormElement>('form[data-folder-scope-source]').forEach((form) => {
      const draft = scopeDraft(form);
      renderScope(form, draft);
      if (presented && !form.closest<HTMLElement>('[data-scope-panel]')?.hidden
        && !draft.loadAttempted && scopeAllowed(form, draft)) void browseScope(form, []);
    });
    root.querySelectorAll<HTMLFormElement>('form[data-mail-scope-source]').forEach((form) => {
      const state = mailState(form);
      mailControls(form, state);
      if (presented && !form.closest<HTMLElement>('[data-scope-panel]')?.hidden
        && !state.loadAttempted && mailAllowed(form, state)) void browseMail(form);
    });
    if (appliedCanWrite === canWrite) return;
    appliedCanWrite = canWrite;
    root.querySelectorAll<HTMLButtonElement>('form[data-dispositions-source] button[type="submit"]')
      .forEach((button) => {
        if (button.dataset.olympusOriginallyDisabled === undefined) {
          button.dataset.olympusOriginallyDisabled = button.disabled ? 'true' : 'false';
        }
        button.disabled = !canWrite || button.dataset.olympusOriginallyDisabled === 'true';
      });
    const selected = query<HTMLElement>('.folder-row.selected');
    if (selected) selectFolder(selected);
  }

  async function save(form: HTMLFormElement): Promise<void> {
    if (!canWrite) {
      message('Your OpenClaw connection has read-only access. Your folder choices are still here.');
      return;
    }
    const edits: Array<{ path: string; state: 'ingest' | 'metadata_only' | 'exclude' }> = [];
    form.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked').forEach((input) => {
      if (input.value === input.dataset.initial) return;
      if (input.value !== 'ingest' && input.value !== 'metadata_only' && input.value !== 'exclude') return;
      edits.push({ path: input.dataset.path || '', state: input.value });
    });
    if (edits.length === 0) {
      message('Nothing changed.');
      return;
    }
    message(`Saving ${edits.length} change(s)…`);
    try {
      const result = await options.transport.control({
        action: 'save_dispositions',
        source: form.dataset.dispositionsSource || '',
        edits,
      });
      if (result.status === 401 || result.status === 403) {
        if (options.authority === 'worker-session') {
          message('The control session expired. Your folder choices are still here — unlock controls on the dashboard, then reopen this picker to save them.');
        } else {
          canWrite = false;
          applyWriteCapability();
          message('Your write access expired. Your folder choices are still here — reconnect with operator.write access to save them.');
        }
        return;
      }
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        const error = result.body.error;
        const reason = error && typeof error === 'object' && !Array.isArray(error)
          ? (error as Record<string, unknown>).message
          : undefined;
        message(typeof reason === 'string' ? reason : 'Save failed.');
        return;
      }
      const resultBody = result.body.result;
      const refused = resultBody && typeof resultBody === 'object' && !Array.isArray(resultBody)
        ? (resultBody as Record<string, unknown>).refused
        : undefined;
      if (Array.isArray(refused) && refused.length > 0) {
        message(refused.map((entry) => {
          const record = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? entry as Record<string, unknown>
            : {};
          return `${String(record.path || '')}: ${String(record.message || 'refused')}`;
        }).join(' '));
        return;
      }
      dirty = false;
      message('Saved. Reloading…');
      await refreshNow(true);
    } catch (error) {
      message(error instanceof Error ? error.message : 'Save failed.');
    }
  }

  let activeScopeSource = root.querySelector<HTMLElement>('[data-scope-panel]:not([hidden])')?.dataset.scopePanel;
  function showScopePanel(sourceId: string): void {
    const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-scope-panel]'));
    if (!panels.some((panel) => panel.dataset.scopePanel === sourceId)) return;
    activeScopeSource = sourceId;
    panels.forEach((panel) => { panel.hidden = panel.dataset.scopePanel !== sourceId; });
    applyWriteCapability();
  }

  function onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    const modified = event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
    if (anchor && !modified) {
      if (anchor.dataset.scopeSwitch) {
        event.preventDefault(); showScopePanel(anchor.dataset.scopeSwitch); return;
      }
      const href = anchor.dataset.olympusNav || anchor.getAttribute('href') || '';
      if (href.startsWith('/dashboard') && !href.startsWith('//')) {
        event.preventDefault(); options.navigate(href); return;
      }
    }
    if (scopeClick(target)) return;
    if (mailClick(target)) return;
    const row = target.closest<HTMLElement>('.folder-row');
    if (row) {
      selectFolder(row);
      return;
    }
    const choice = target.closest<HTMLButtonElement>('button[data-picker-state]');
    if (choice) {
      const form = choice.closest<HTMLFormElement>('form[data-dispositions-source]');
      const path = form?.dataset.selectedPath;
      const state = choice.dataset.pickerState;
      if (!form || !path || !state || choice.disabled || !canWrite) return;
      const rowForPath = Array.from(form.querySelectorAll<HTMLElement>('.folder-row'))
        .find((item) => item.dataset.path === path);
      const radio = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .find((input) => input.dataset.path === path && input.value === state);
      if (!rowForPath || !radio) return;
      radio.checked = true;
      rowForPath.dataset.state = state;
      const status = rowForPath.querySelector('[data-folder-status]');
      if (status) status.textContent = labels[state] || state;
      dirty = true;
      selectFolder(rowForPath);
      return;
    }
    if (target.closest('[data-cancel-picker]')) {
      void refreshNow(true);
      return;
    }
    const copy = target.closest<HTMLElement>('[data-copy-target]');
    if (!copy) return;
    const selector = copy.dataset.copyTarget;
    const source = selector ? query<HTMLInputElement>(selector) : null;
    if (!source || !navigator.clipboard) return;
    void navigator.clipboard.writeText(source.value);
  }

  function onKeydown(event: Event): void {
    if (event.target instanceof Element && event.target.closest('form[data-folder-scope-source]')) {
      if (event instanceof KeyboardEvent) scopeKeydown(event);
      return;
    }
    if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) return;
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.folder-row') : null;
    if (!row || !root.contains(row)) return;
    event.preventDefault();
    selectFolder(row);
  }

  function onInput(event: Event): void {
    const mailForm = event.target instanceof Element ? event.target.closest<HTMLFormElement>('form[data-mail-scope-source]') : null;
    if (mailForm && root.contains(mailForm)) {
      const state = mailState(mailForm);
      state.edited = true; mailControls(mailForm, state); return;
    }
    const input = event.target instanceof HTMLInputElement && event.target.matches('[data-folder-search]')
      ? event.target
      : null;
    if (!input || !root.contains(input)) return;
    const needle = input.value.trim().toLowerCase();
    const form = input.closest('form[data-dispositions-source]');
    form?.querySelectorAll<HTMLElement>('.folder-row').forEach((row) => {
      row.hidden = needle !== '' && !(row.dataset.search || '').includes(needle);
    });
  }

  function onSubmit(event: Event): void {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !root.contains(form)) return;
    if (form.hasAttribute('data-folder-scope-source')) { event.preventDefault(); void approveScope(form); return; }
    if (form.hasAttribute('data-mail-scope-source')) { event.preventDefault(); void approveMail(form); return; }
    if (!form.hasAttribute('data-dispositions-source')) return;
    event.preventDefault();
    void save(form);
  }

  function onActivity(): void {
    lastActivityMs = Date.now();
  }

  async function renew(): Promise<void> {
    if (!options.transport.renew || lastActivityMs <= lastRenewalMs) return;
    lastRenewalMs = Date.now();
    try { await options.transport.renew(); } catch { /* save reports an expired session */ }
  }

  async function refreshNow(force: boolean): Promise<void> {
    // A loaded picker holds the owner's unsaved choices and a spent provider
    // read; the background poll never replaces it.
    const pickerOpen = (): boolean => Array.from(scopeDrafts.values()).some((draft) => draft.loaded || draft.busy)
      || Array.from(mailDrafts.values()).some((state) => state.loaded || state.loading || state.busy || state.edited);
    if (disposed || inFlight || options.signal.aborted || (!force && (!presented || dirty || pickerOpen()))) return;
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted) return;
      canWrite = result.can_write;
      if (!force && (dirty || pickerOpen())) {
        applyWriteCapability();
        return;
      }
      if (!force && result.signature === signature) {
        applyWriteCapability();
        return;
      }
      const searches = new Map<string, string>();
      root.querySelectorAll<HTMLInputElement>('[data-folder-search]').forEach((input) => {
        const source = input.closest<HTMLFormElement>('form[data-dispositions-source]')?.dataset.dispositionsSource;
        if (source) searches.set(source, input.value);
      });
      const selected = new Map<string, string>();
      root.querySelectorAll<HTMLFormElement>('form[data-dispositions-source]').forEach((form) => {
        if (form.dataset.dispositionsSource && form.dataset.selectedPath) {
          selected.set(form.dataset.dispositionsSource, form.dataset.selectedPath);
        }
      });
      const open = new Set(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[open]')).map((node) =>
        node.querySelector<HTMLElement>('.folder-row')?.dataset.path || ''));
      const tree = root.getRootNode();
      const active = tree instanceof ShadowRoot ? tree.activeElement : root.ownerDocument.activeElement;
      const activeForm = active instanceof Element
        ? active.closest<HTMLFormElement>('form[data-dispositions-source]')
        : null;
      const focus = activeForm?.dataset.dispositionsSource
        ? {
          source: activeForm.dataset.dispositionsSource,
          path: active instanceof HTMLElement && active.classList.contains('folder-row')
            ? active.dataset.path
            : activeForm.dataset.selectedPath,
          pickerState: active instanceof HTMLElement ? active.dataset.pickerState : undefined,
          search: active instanceof HTMLInputElement && active.matches('[data-folder-search]'),
        }
        : undefined;
      if (options.replaceHtml) options.replaceHtml(root, result.body);
      else root.innerHTML = result.body;
      dirty = false;
      scopeDrafts.clear();
      mailDrafts.clear();
      if (activeScopeSource) showScopePanel(activeScopeSource);
      signature = result.signature;
      appliedCanWrite = undefined;
      root.querySelectorAll<HTMLDetailsElement>('details').forEach((node) => {
        const path = node.querySelector<HTMLElement>('.folder-row')?.dataset.path || '';
        if (open.has(path)) node.open = true;
      });
      root.querySelectorAll<HTMLFormElement>('form[data-dispositions-source]').forEach((form) => {
        const source = form.dataset.dispositionsSource || '';
        const search = form.querySelector<HTMLInputElement>('[data-folder-search]');
        const needle = searches.get(source) || '';
        if (search) search.value = needle;
        form.querySelectorAll<HTMLElement>('.folder-row').forEach((row) => {
          row.hidden = needle.trim() !== '' && !(row.dataset.search || '').includes(needle.trim().toLowerCase());
        });
        const path = selected.get(source);
        const row = path
          ? Array.from(form.querySelectorAll<HTMLElement>('.folder-row')).find((entry) => entry.dataset.path === path)
          : undefined;
        if (row) selectFolder(row);
        if (focus?.source === source) {
          const restore = focus.search
            ? search
            : focus.pickerState
              ? form.querySelector<HTMLElement>(`[data-picker-state="${focus.pickerState}"]`)
              : focus.path
                ? Array.from(form.querySelectorAll<HTMLElement>('.folder-row'))
                  .find((entry) => entry.dataset.path === focus.path)
                : undefined;
          restore?.focus();
        }
      });
      applyWriteCapability();
    } catch {
      // The save path owns visible errors; background refresh stays quiet.
    } finally {
      inFlight = false;
    }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('input', onInput);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('pointerdown', onActivity, { passive: true });
  root.addEventListener('keydown', onActivity, { passive: true });
  applyWriteCapability();
  const pollMs = options.pollIntervalMs === undefined ? 15_000 : options.pollIntervalMs;
  if (pollMs > 0) interval = setInterval(() => { void refreshNow(false); }, pollMs);
  if (options.authority === 'worker-session' && options.transport.renew) {
    renewalInterval = setInterval(() => { void renew(); }, 4 * 60 * 1000);
  }

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (interval) clearInterval(interval);
    if (renewalInterval) clearInterval(renewalInterval);
    root.removeEventListener('click', onClick);
    root.removeEventListener('keydown', onKeydown);
    root.removeEventListener('input', onInput);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('pointerdown', onActivity);
    root.removeEventListener('keydown', onActivity);
  };
  options.signal.addEventListener('abort', dispose, { once: true });

  return {
    refresh: () => refreshNow(false),
    update(input) {
      canWrite = input.canWrite;
      if (input.presented !== undefined) presented = input.presented;
      if (input.signature !== undefined) signature = input.signature;
      applyWriteCapability();
    },
    dispose,
  };
}
