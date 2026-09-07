import type {
  OlympusDashboardControlParams,
  OlympusDashboardControlResult,
  OlympusDashboardReadResult,
} from '../control-ui-contract.ts';

export interface OlympusDashboardTransport {
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

  function openAuthorizationTab(): Window | null {
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

  async function submitControl(form: HTMLFormElement, authorizationTab: Window | null): Promise<void> {
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
    const tab = form.dataset.connectKind === 'oauth' ? openAuthorizationTab() : null;
    void submitControl(form, tab);
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
    if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) return;
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>('.folder-row') : null;
    if (!row || !root.contains(row)) return;
    event.preventDefault();
    selectFolder(row);
  }

  function onInput(event: Event): void {
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
    if (!form || !root.contains(form) || !form.hasAttribute('data-dispositions-source')) return;
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
    if (disposed || inFlight || options.signal.aborted || (!force && (!presented || dirty))) return;
    inFlight = true;
    try {
      const result = await options.refresh();
      if (!result || disposed || options.signal.aborted) return;
      canWrite = result.can_write;
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
