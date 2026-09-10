import type {
  OlympusDashboardControlParams,
  OlympusDashboardControlResult,
  OlympusDashboardReadResult,
  OlympusDashboardReadParams,
  OlympusFolderScopeBrowseResult,
  OlympusFolderScopeNode,
  OlympusFolderScopeSourceId,
  OlympusSourceDispositionState,
} from '../control-ui-contract.ts';

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
  const root = options.root;
  const oauthSubmittedValues = new WeakMap<HTMLFormElement, Record<string, string>>();

  function query<T extends Element = Element>(selector: string): T | null {
    return root.querySelector(selector) as T | null;
  }

  function queryAll<T extends Element = Element>(selector: string): T[] {
    return Array.from(root.querySelectorAll(selector)) as T[];
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
    root.querySelectorAll<HTMLElement>(
      'form[data-connect-kind],form[data-sync-kind],form[data-embedding-kind],'
        + 'form[data-disconnect-kind],form[data-unpair-kind]',
    ).forEach((form) => {
      form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input:not([type="hidden"])')
        .forEach((control) => {
          if (control.dataset.olympusOriginallyDisabled === undefined) {
            control.dataset.olympusOriginallyDisabled = control.disabled ? 'true' : 'false';
          }
          const oauthUnavailable = form.hasAttribute('data-native-oauth-unavailable');
          if (!canWrite || oauthUnavailable) {
            control.disabled = true;
            control.setAttribute('aria-disabled', 'true');
          } else {
            control.disabled = control.dataset.olympusOriginallyDisabled === 'true';
            if (!control.disabled) control.removeAttribute('aria-disabled');
          }
        });
    });
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

  function releaseSubmittedOAuthPanel(
    form: HTMLFormElement,
    submittedValues: Record<string, string> | undefined,
  ): boolean {
    const sheet = form.closest<HTMLElement>('.sheet');
    const unchanged = submittedValues !== undefined && sameFormRecord(form, submittedValues);
    if (!unchanged) return false;
    // The submitted values are now owned by the backend. Reset before the
    // panel is released so a password/client secret cannot become a reflected
    // HTML value attribute on a later DOM serialization.
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
    if (params.action === 'disconnect' || params.action === 'unpair') {
      const fallback = params.action === 'unpair' ? 'Unpair this source?' : 'Disconnect this source?';
      if (!window.confirm(form.dataset.confirmation || fallback)) {
        closeAuthorizationTab(authorizationTab);
        return;
      }
    }
    if (params.action === 'start_oauth') clearAuthorizationFallback(form);
    say(form, 'Starting…');
    try {
      const result = await options.transport.control(params);
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
        if (authorizationTab) {
          authorizationTab.location.href = authorizationUrl;
          say(form, 'Authorization opened in a new tab. Approve it there, then come back to Olympus.');
          if (releaseSubmittedOAuthPanel(form, submittedValues)) void refreshNow(false, true);
        } else if (openAuthorizationExternally(authorizationUrl)) {
          say(form, 'Authorization opened in your default browser. Approve it there, then come back to Olympus.');
          if (releaseSubmittedOAuthPanel(form, submittedValues)) void refreshNow(false, true);
        } else {
          say(form, 'Open the authorization page to continue.');
          showAuthorizationFallback(form, authorizationUrl);
        }
        return;
      }
      closeAuthorizationTab(authorizationTab);
      form.reset();
      const statusMessage = result.body.status_message;
      say(form, typeof statusMessage === 'string' ? statusMessage : 'Done. Waiting for the next refresh.');
      await refreshNow(false);
    } catch {
      closeAuthorizationTab(authorizationTab);
      say(form, 'Could not reach Olympus.');
    }
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
    return active !== null && root.contains(active);
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
    findByFocusKey(focused)?.focus();
    signature = result.signature;
    pollIntervalMs = result.poll_interval_ms;
    deferredSince = 0;
    applyWriteCapability();
  }

  async function refreshNow(force: boolean, requested = false): Promise<void> {
    if (disposed || inFlight || options.signal.aborted || (!force && !presented)) return;
    const ownerDocument = root.ownerDocument;
    if (!force && !requested && ownerDocument.visibilityState === 'hidden') return;
    if (!force && query('.sheet.on')) return;
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
    if (!form.matches(
      '[data-connect-kind],[data-sync-kind],[data-embedding-kind],[data-disconnect-kind],[data-unpair-kind]',
    )) return;
    event.preventDefault();
    const submittedValues = form.dataset.connectKind === 'oauth' ? formRecord(form) : undefined;
    if (submittedValues) oauthSubmittedValues.set(form, submittedValues);
    const tab = form.dataset.connectKind === 'oauth' ? openAuthorizationTab() : null;
    void submitControl(form, tab, submittedValues);
  }

  function onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    const toggle = target.closest<HTMLElement>('[data-sheet-toggle]');
    if (toggle) {
      const selector = toggle.dataset.sheetToggle;
      const sheet = selector ? query<HTMLElement>(selector) : null;
      if (!sheet) return;
      const open = sheet.classList.toggle('on');
      sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
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
    if (!anchor) return;
    const fallback = target.closest<HTMLAnchorElement>('[data-authorization-fallback] a');
    if (fallback) {
      const form = fallback.closest<HTMLFormElement>('form[data-connect-kind="oauth"]');
      const submittedValues = form ? oauthSubmittedValues.get(form) : undefined;
      if (form && submittedValues) {
        // Keep the fallback anchor available for the browser's default action;
        // release the panel only after that navigation has been dispatched.
        setTimeout(() => {
          if (disposed || !releaseSubmittedOAuthPanel(form, submittedValues)) return;
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
  applyWriteCapability();
  restartPoll();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (interval) clearInterval(interval);
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
    ingest: 'Full ingestion',
    metadata_only: 'Metadata only',
    exclude: 'No ingestion',
  };

  type ScopeTrail = Array<{ key: string; name: string }>;
  type ScopeDraft = {
    generation: string;
    revision: string;
    selections: Map<string, OlympusSourceDispositionState>;
    names: Map<string, string>;
    ancestors: Map<string, string[]>;
    nodes: OlympusFolderScopeNode[];
    catalog: Map<string, OlympusFolderScopeNode>;
    branches: Map<string, OlympusFolderScopeNode[]>;
    branchCursors: Map<string, string>;
    expanded: Set<string>;
    nextCursor?: string | undefined;
    selected?: OlympusFolderScopeNode | undefined;
    loaded: boolean;
    busy: boolean;
    invalid: boolean;
    edited: boolean;
    whole: boolean;
  };
  const scopeDrafts = new Map<HTMLFormElement, ScopeDraft>();

  function scopeMessage(form: HTMLFormElement, text: string): void {
    const slot = form.querySelector('[data-scope-message]');
    if (slot) slot.textContent = text;
  }

  function scopeDraft(form: HTMLFormElement): ScopeDraft {
    let draft = scopeDrafts.get(form);
    if (!draft) {
      draft = {
        generation: form.dataset.accountGeneration || '', revision: form.dataset.scopeRevision || '',
        selections: new Map(), names: new Map(), ancestors: new Map(), nodes: [], catalog: new Map(), branches: new Map(), branchCursors: new Map(), expanded: new Set(), loaded: false,
        busy: false, invalid: false, edited: false,
        whole: form.querySelector<HTMLInputElement>('[data-scope-whole-account]')?.checked === true,
      };
      scopeDrafts.set(form, draft);
    }
    return draft;
  }

  function scopeAllowed(form: HTMLFormElement, draft: ScopeDraft): boolean {
    return canWrite && form.dataset.connected === 'true' && !draft.busy && !draft.invalid;
  }

  function inheritedScopeState(draft: ScopeDraft, key: string): OlympusSourceDispositionState | undefined {
    let state: OlympusSourceDispositionState | undefined = draft.whole ? 'ingest' : undefined;
    for (const ancestor of draft.ancestors.get(key) || []) {
      const choice = draft.selections.get(ancestor);
      if (choice === 'exclude') return 'exclude';
      if (choice === 'metadata_only') state = 'metadata_only';
      else if (choice === 'ingest' && state === undefined) state = 'ingest';
    }
    return state;
  }

  function effectiveScopeState(draft: ScopeDraft, key: string): OlympusSourceDispositionState {
    const inherited = inheritedScopeState(draft, key);
    const own = draft.selections.get(key);
    if (inherited === 'exclude' || own === 'exclude') return 'exclude';
    if (inherited === 'metadata_only') return 'metadata_only';
    return own || inherited || 'exclude';
  }

  function scopeChoiceAllowed(draft: ScopeDraft, state: string): boolean {
    if (!draft.selected?.selectable) return false;
    const inherited = inheritedScopeState(draft, draft.selected.key);
    if (inherited === 'exclude') return state === 'exclude';
    if (inherited === 'metadata_only') return state === 'metadata_only' || state === 'exclude';
    return state === 'ingest' || state === 'metadata_only' || state === 'exclude';
  }

  function scopeControls(form: HTMLFormElement, draft: ScopeDraft): void {
    const allowed = scopeAllowed(form, draft);
    form.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = !allowed; });
    form.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.disabled = !allowed || !draft.loaded; });
    form.querySelectorAll<HTMLButtonElement>('[data-scope-state]').forEach((button) => {
      button.disabled = !allowed || !scopeChoiceAllowed(draft, button.dataset.scopeState || '');
      button.classList.toggle('on', draft.selected !== undefined && effectiveScopeState(draft, draft.selected.key) === button.dataset.scopeState);
    });
    const hasSelection = Array.from(draft.selections.keys()).some((key) => effectiveScopeState(draft, key) !== 'exclude');
    const confirmation = form.querySelector<HTMLInputElement>('[data-scope-whole-confirm]');
    const submit = form.querySelector<HTMLButtonElement>('[data-scope-start]');
    if (submit) submit.disabled = !allowed || !draft.loaded || !draft.generation || !draft.revision
      || (!draft.whole && !hasSelection && !draft.edited) || (draft.whole && confirmation?.checked !== true);
    if (submit) submit.textContent = draft.whole || hasSelection ? 'Save scope and start' : 'Save scope (no ingestion)';
    const cancel = form.querySelector<HTMLButtonElement>('[data-scope-cancel]'); if (cancel) cancel.disabled = draft.busy;
    const confirmationLabel = form.querySelector<HTMLElement>('.scope-whole-confirm');
    if (confirmationLabel) confirmationLabel.hidden = !draft.whole;
  }

  function renderScopeReview(form: HTMLFormElement, draft: ScopeDraft): void {
    const summary = form.querySelector('[data-scope-summary]');
    if (summary) summary.textContent = draft.whole
      ? 'Entire account, including future folders, except the choices below.'
      : `${Array.from(draft.selections.keys()).filter((key) => effectiveScopeState(draft, key) !== 'exclude').length} folder(s) selected. All other folders stay out.`;
    const list = form.querySelector('[data-scope-selections]');
    if (list) {
      list.replaceChildren();
      for (const [key, state] of draft.selections) {
        const item = root.ownerDocument.createElement('li');
        item.textContent = `${labels[effectiveScopeState(draft, key)]} — ${draft.names.get(key) || key}`;
        list.appendChild(item);
      }
    }
    scopeControls(form, draft);
  }

  function updateScopeRows(form: HTMLFormElement, draft: ScopeDraft): void {
    form.querySelectorAll<HTMLElement>('.scope-folder').forEach((row) => {
      const key = row.querySelector<HTMLElement>('[data-scope-select]')?.dataset.scopeSelect;
      if (!key) return;
      row.classList.toggle('selected', draft.selected?.key === key);
      const status = row.querySelector('.scope-folder-status');
      const inherited = inheritedScopeState(draft, key);
      if (status) status.textContent = draft.selections.has(key) || inherited
        ? `${labels[effectiveScopeState(draft, key)]}${inherited ? ' · inherited' : ''}` : 'Not selected';
    });
    renderScopeReview(form, draft);
  }

  function scopeTrail(draft: ScopeDraft, key: string): ScopeTrail {
    return [...(draft.ancestors.get(key) || []), key].map((ancestor) => ({ key: ancestor, name: draft.catalog.get(ancestor)?.name || ancestor }));
  }

  function renderScopeNodes(form: HTMLFormElement, draft: ScopeDraft): void {
    const list = form.querySelector('[data-scope-nodes]');
    if (!list) return;
    list.replaceChildren();
    const appendNodes = (host: Element, nodes: OlympusFolderScopeNode[], seen = new Set<string>()): void => {
      for (const node of nodes) {
        if (seen.has(node.key)) continue;
        const wrapper = root.ownerDocument.createElement('div'); wrapper.className = 'node';
        const row = root.ownerDocument.createElement('div');
        row.className = 'folder-row scope-folder'; row.setAttribute('role', 'listitem');
        row.classList.toggle('selected', draft.selected?.key === node.key);
        const disclosure = root.ownerDocument.createElement(node.has_children ? 'button' : 'span');
        disclosure.className = 'disclosure';
        if (disclosure instanceof HTMLButtonElement) {
          disclosure.type = 'button'; disclosure.dataset.scopeOpen = node.key;
          disclosure.textContent = draft.expanded.has(node.key) ? '▾' : '▸';
          disclosure.setAttribute('aria-label', `${draft.expanded.has(node.key) ? 'Collapse' : 'Expand'} ${node.name}`);
          disclosure.setAttribute('aria-expanded', String(draft.expanded.has(node.key)));
        }
        const select = root.ownerDocument.createElement('button');
        select.type = 'button'; select.dataset.scopeSelect = node.key; select.textContent = node.name;
        const status = root.ownerDocument.createElement('span'); status.className = 'scope-folder-status';
        const inherited = inheritedScopeState(draft, node.key);
        status.textContent = draft.selections.has(node.key) || inherited ? `${labels[effectiveScopeState(draft, node.key)]}${inherited ? ' · inherited' : ''}` : 'Not selected';
        const icon = root.ownerDocument.createElement('span'); icon.className = 'folder-icon'; icon.textContent = '▰';
        row.append(disclosure, icon, select, status); wrapper.appendChild(row);
        if (draft.expanded.has(node.key)) {
          const children = root.ownerDocument.createElement('div'); children.className = 'children';
          children.setAttribute('role', 'group'); children.setAttribute('aria-label', node.name);
          appendNodes(children, draft.branches.get(node.key) || [], new Set([...seen, node.key]));
          if (draft.branchCursors.has(node.key)) {
            const more = root.ownerDocument.createElement('button'); more.type = 'button'; more.dataset.scopeMore = node.key; more.textContent = 'Show more folders'; children.appendChild(more);
          }
          wrapper.appendChild(children);
        }
        host.appendChild(wrapper);
      }
    };
    appendNodes(list, draft.nodes);
    if (draft.nodes.length === 0) {
      const empty = root.ownerDocument.createElement('p'); empty.textContent = 'No folders returned in this page.'; list.appendChild(empty);
    }
    const needle = form.querySelector<HTMLInputElement>('[data-scope-search]')?.value.trim().toLowerCase() || '';
    list.querySelectorAll<HTMLElement>('.scope-folder').forEach((row) => { row.hidden = !!needle && !(row.textContent || '').toLowerCase().includes(needle); });
    const more = form.querySelector<HTMLElement>('[data-scope-more=""]'); if (more) more.hidden = !draft.nextCursor;
    renderScopeReview(form, draft);
  }

  async function browseScope(form: HTMLFormElement, trail: ScopeTrail, append = false): Promise<void> {
    const draft = scopeDraft(form);
    if (!scopeAllowed(form, draft) || !options.transport.read) return;
    const parent = trail.at(-1)?.key;
    const cursor = append ? (parent ? draft.branchCursors.get(parent) : draft.nextCursor) : undefined;
    draft.busy = true; scopeControls(form, draft); scopeMessage(form, 'Listing folder names…');
    try {
      const result = await options.transport.read({
        view: 'dispositions', action: 'browse_folder_scope',
        source_id: form.dataset.folderScopeSource as OlympusFolderScopeSourceId,
        ...(parent ? { parent_key: parent } : {}), ...(cursor ? { cursor } : {}),
      });
      if (disposed || options.signal.aborted || !root.contains(form)) return;
      if (result.status === 401 || result.status === 403 || !result.can_write) {
        canWrite = false; scopeMessage(form, 'Write access expired. Reconnect before browsing private folders.'); return;
      }
      const page: OlympusFolderScopeBrowseResult | undefined = result.scope_browser;
      if (result.status < 200 || result.status >= 300 || !page
        || page.source_id !== form.dataset.folderScopeSource || !page.account_generation || !page.scope_revision
        || !Array.isArray(page.nodes) || page.nodes.some((node) => typeof node.key !== 'string'
          || typeof node.name !== 'string' || node.kind !== 'folder' || typeof node.selectable !== 'boolean')) {
        scopeMessage(form, 'Could not list folders. Check the connection and reopen this picker.'); return;
      }
      if (draft.loaded && (draft.generation !== page.account_generation || draft.revision !== page.scope_revision)) {
        draft.invalid = true;
        scopeMessage(form, 'The account or saved scope changed. Reopen this picker before applying choices.'); return;
      }
      if (!draft.loaded) {
        draft.generation = page.account_generation; draft.revision = page.scope_revision;
        draft.selections = new Map(page.selections.map((selection) => [selection.key, selection.state]));
        page.selections.forEach((selection) => draft.ancestors.set(selection.key, selection.ancestor_keys || []));
        draft.whole = page.whole_account_selected;
        const whole = form.querySelector<HTMLInputElement>('[data-scope-whole-account]'); if (whole) whole.checked = draft.whole;
      }
      if (page.nodes.some((node) => trail.some((ancestor) => ancestor.key === node.key))) {
        scopeMessage(form, 'The folder listing contains a cycle. Reopen the picker before continuing.'); draft.invalid = true; return;
      }
      draft.loaded = true;
      const previous = parent ? draft.branches.get(parent) || [] : draft.nodes;
      const nodes = append ? [...previous, ...page.nodes.filter((node) => !previous.some((old) => old.key === node.key))] : page.nodes;
      if (parent) {
        draft.branches.set(parent, nodes); draft.expanded.add(parent);
        if (page.next_cursor) draft.branchCursors.set(parent, page.next_cursor); else draft.branchCursors.delete(parent);
      } else { draft.nodes = nodes; draft.nextCursor = page.next_cursor; }
      page.nodes.forEach((node) => {
        draft.catalog.set(node.key, node);
        draft.names.set(node.key, [...trail.map((entry) => entry.name), node.name].join(' / '));
        draft.ancestors.set(node.key, trail.map((entry) => entry.key));
      });
      renderScopeNodes(form, draft);
      scopeMessage(form, 'Only folder names were listed. Review your choices, then save and start.');
    } catch {
      if (!disposed && root.contains(form)) scopeMessage(form, 'Folder browsing failed. Your choices are still here; retry when the connection is ready.');
    } finally {
      draft.busy = false;
      if (!disposed && root.contains(form)) scopeControls(form, draft);
    }
  }

  async function approveScope(form: HTMLFormElement): Promise<void> {
    const draft = scopeDraft(form);
    const confirmation = form.querySelector<HTMLInputElement>('[data-scope-whole-confirm]')?.checked === true;
    if (!scopeAllowed(form, draft) || !draft.loaded || !draft.generation || !draft.revision
      || (!draft.whole && !draft.edited && !Array.from(draft.selections.keys()).some((key) => effectiveScopeState(draft, key) !== 'exclude'))
      || (draft.whole && !confirmation)) {
      scopeMessage(form, 'Choose folders first. Entire-account access also needs explicit confirmation.'); return;
    }
    draft.busy = true; scopeControls(form, draft); scopeMessage(form, 'Saving your approved scope…');
    try {
      const result = await options.transport.control({
        action: 'approve_source_scope_and_start', source_id: form.dataset.folderScopeSource as OlympusFolderScopeSourceId,
        account_generation: draft.generation, expected_scope_revision: draft.revision,
        selections: Array.from(draft.selections, ([key, state]) => ({ key, state, ancestor_keys: draft.ancestors.get(key) || [] })),
        whole_account: draft.whole, explicit_whole_account_confirmation: confirmation,
      });
      if (disposed || options.signal.aborted || !root.contains(form)) return;
      if (result.status < 200 || result.status >= 300 || result.body.ok !== true) {
        if (result.status === 401 || result.status === 403) canWrite = false;
        if (result.status === 409) draft.invalid = true;
        const error = result.body.error;
        const message = error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
        scopeMessage(form, typeof message === 'string' ? message : 'Scope was not activated. Your choices are still here.'); return;
      }
      draft.edited = false;
      scopeMessage(form, 'Scope saved. Opening the source status…');
      if (!dirty && !Array.from(scopeDrafts.values()).some((other) => other.edited)) {
        options.navigate(`/dashboard?source=${encodeURIComponent(form.dataset.folderScopeSource || '')}`);
      }
    } catch {
      if (!disposed && root.contains(form)) scopeMessage(form, 'Could not confirm the result. Reopen the picker to check saved scope before retrying.');
    } finally {
      draft.busy = false;
      if (!disposed && root.contains(form)) scopeControls(form, draft);
    }
  }

  function scopeClick(target: Element): boolean {
    const form = target.closest<HTMLFormElement>('form[data-folder-scope-source]');
    if (!form || !root.contains(form)) return false;
    const draft = scopeDraft(form);
    if (target.closest('[data-scope-cancel]')) {
      if (draft.busy) return true;
      scopeDrafts.delete(form);
      const list = form.querySelector('[data-scope-nodes]'); list?.replaceChildren();
      form.querySelectorAll<HTMLInputElement>('input').forEach((input) => { input.checked = input.defaultChecked; });
      const empty = form.querySelector<HTMLElement>('[data-scope-inspector-empty]'); if (empty) empty.hidden = false;
      const content = form.querySelector<HTMLElement>('[data-scope-inspector-content]'); if (content) content.hidden = true;
      form.querySelectorAll<HTMLElement>('[data-scope-more]').forEach((element) => { element.hidden = true; });
      const location = form.querySelector('[data-scope-location]'); if (location) location.textContent = 'Top level';
      const fresh = scopeDraft(form); renderScopeReview(form, fresh); scopeMessage(form, 'Changes cancelled. Browse again to review the saved scope.'); return true;
    }
    if (!scopeAllowed(form, draft)) return true;
    if (target.closest('[data-scope-browse-root]')) { void browseScope(form, []); return true; }
    const more = target.closest<HTMLElement>('[data-scope-more]');
    if (more) {
      const key = more.dataset.scopeMore;
      if (key && draft.branchCursors.has(key)) void browseScope(form, scopeTrail(draft, key), true);
      else if (!key && draft.nextCursor) void browseScope(form, [], true);
      return true;
    }
    const open = target.closest<HTMLElement>('[data-scope-open]');
    if (open) {
      const node = draft.catalog.get(open.dataset.scopeOpen || '');
      if (node && draft.expanded.has(node.key)) { draft.expanded.delete(node.key); renderScopeNodes(form, draft); }
      else if (node && draft.branches.has(node.key)) { draft.expanded.add(node.key); renderScopeNodes(form, draft); }
      else if (node) void browseScope(form, scopeTrail(draft, node.key));
      return true;
    }
    const select = target.closest<HTMLElement>('[data-scope-select]');
    if (select) {
      draft.selected = draft.catalog.get(select.dataset.scopeSelect || '');
      const empty = form.querySelector<HTMLElement>('[data-scope-inspector-empty]'); if (empty) empty.hidden = !!draft.selected;
      const content = form.querySelector<HTMLElement>('[data-scope-inspector-content]'); if (content) content.hidden = !draft.selected;
      const name = form.querySelector('[data-scope-selected-name]'); if (name) name.textContent = draft.selected?.name || '';
      const path = form.querySelector('[data-scope-selected-path]'); if (path) path.textContent = draft.selected ? draft.names.get(draft.selected.key) || draft.selected.name : '';
      const note = form.querySelector('[data-scope-selected-note]'); if (note) note.textContent = 'This choice applies to this folder and its contents. Review narrower choices before starting.';
      updateScopeRows(form, draft); return true;
    }
    const choice = target.closest<HTMLElement>('[data-scope-state]');
    const state = choice?.dataset.scopeState;
    if (draft.selected?.selectable && state && scopeChoiceAllowed(draft, state) && (state === 'ingest' || state === 'metadata_only' || state === 'exclude')) {
      draft.selections.set(draft.selected.key, state); draft.edited = true; updateScopeRows(form, draft);
    }
    return true;
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
          ? 'Uses the Full ingestion default until you choose otherwise.'
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
    root.querySelectorAll<HTMLFormElement>('form[data-folder-scope-source]').forEach((form) => scopeControls(form, scopeDraft(form)));
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

  function onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    if (scopeClick(target)) return;
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
    if (event.target instanceof Element && event.target.closest('form[data-folder-scope-source]')) return;
    if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) return;
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.folder-row') : null;
    if (!row || !root.contains(row)) return;
    event.preventDefault();
    selectFolder(row);
  }

  function onInput(event: Event): void {
    if (event.target instanceof HTMLInputElement && root.contains(event.target)) {
      const form = event.target.closest<HTMLFormElement>('form[data-folder-scope-source]');
      if (form && event.target.matches('[data-scope-search]')) { renderScopeNodes(form, scopeDraft(form)); return; }
      if (form && (event.target.matches('[data-scope-whole-account]') || event.target.matches('[data-scope-whole-confirm]'))) {
        const draft = scopeDraft(form);
        if (!scopeAllowed(form, draft) || !draft.loaded) return;
        draft.whole = form.querySelector<HTMLInputElement>('[data-scope-whole-account]')?.checked === true;
        if (!draft.whole) { const confirm = form.querySelector<HTMLInputElement>('[data-scope-whole-confirm]'); if (confirm) confirm.checked = false; }
        draft.edited = true; renderScopeReview(form, draft); return;
      }
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
    if (disposed || inFlight || options.signal.aborted || (!force && (!presented || dirty || Array.from(scopeDrafts.values()).some((draft) => draft.loaded || draft.busy)))) return;
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted) return;
      canWrite = result.can_write;
      if (!force && (dirty || Array.from(scopeDrafts.values()).some((draft) => draft.loaded || draft.busy))) {
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
