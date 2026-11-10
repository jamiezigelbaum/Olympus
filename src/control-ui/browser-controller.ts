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
  /** Local-only session mint; never supplied by the native or remote bridge. */
  openLocalControls?(): Promise<boolean>;
  /** Only the standalone local dashboard supplies this direct same-origin transport. */
  messaging?(operation: 'start' | 'status' | 'respond' | 'cancel' | 'scope' | 'chats', params: { source: 'telegram' | 'whatsapp'; field?: string; value?: string; wholeAccount?: boolean; chatScopes?: string[]; chatKinds?: string[] }): Promise<OlympusDashboardControlResult>;
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
/** The event a part of the page dispatches to have the dashboard read and redraw the page now. */
export const DASHBOARD_REDRAW_EVENT = 'olympus:redraw';

export function mountDashboardController(options: OlympusBrowserControllerOptions): OlympusBrowserController {
  // The page serializes this function, so module constants are not in scope
  // there: keep this equal to the exported highlight constant above.
  const landedHighlightMs = 4000;
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
  /** That start's wait line and the sheet it shows in: a redraw replaces the form, so it is said again until the owner comes back. */
  let authorizationWait: { sheetId: string; message: string } | undefined;
  const root = options.root;
  const uploadedClientFiles = new WeakMap<HTMLFormElement, string>();
  const submittedFormValues = new WeakMap<HTMLFormElement, Record<string, string>>();
  const startedFromSheet = new WeakSet<HTMLFormElement>();
  const pendingForms = new WeakSet<HTMLFormElement>();
  let pendingFormCount = 0;
  // Keep equal to the exported redraw event constant above (serialized, as above).
  const redrawEvent = 'olympus:redraw';
  /** A redraw was asked for while a read or a control was in flight: the next read is forced. */
  let redrawOwed = false;
  // Only this tab's successful save keeps the walkthrough alive. A reload
  // renders the saved policy normally; upgrades never create this state.
  let firstRunChoice: string | undefined;
  let firstRunCheckRequested = false;

  function showSetupStep(sheet: HTMLElement, next: number): void {
    const panels = Array.from(sheet.querySelectorAll<HTMLElement>(':scope > [data-setup-panel]'));
    const firstRun = sheet.closest('[data-first-run-sheet]');
    const noConnection = firstRun && firstRunChoice === 'no-sensitive';
    panels.forEach((panel, index) => { panel.hidden = index !== next; });
    const count = noConnection ? 2 : panels.length;
    const position = noConnection && next === 2 ? 2 : next + 1;
    const counter = sheet.querySelector<HTMLElement>('[data-setup-counter]');
    if (counter) counter.textContent = sheet.hasAttribute('data-setup-guided') ? `STEP ${position} OF ${count}` : `Step ${position} of ${count}`;
    sheet.querySelectorAll<HTMLElement>('[data-setup-segment]').forEach((segment, index) => segment.classList.toggle('filled', index <= next));
    sheet.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(position));
    const progress = sheet.querySelector<HTMLProgressElement>('[data-setup-progress]');
    if (progress) { progress.max = count; progress.value = position; }
    const forward = sheet.querySelector<HTMLElement>('[data-setup-next]');
    if (forward) forward.hidden = next === panels.length - 1 || Boolean(firstRun && next === 0);
    const back = sheet.querySelector<HTMLButtonElement>('[data-setup-back]');
    if (back) back.disabled = next === 0 || Boolean(firstRun && (next < 2 || noConnection));
    const submit = sheet.querySelector<HTMLButtonElement>('[data-setup-submit]');
    const actionForm = panels[next]?.dataset.setupForm;
    if (submit) {
      submit.hidden = !actionForm && next !== panels.length - 1;
      if (actionForm) {
        submit.setAttribute('form', actionForm);
        submit.textContent = panels[next]!.dataset.setupLabel ?? 'Continue';
      }
    }
    const actions = sheet.querySelector<HTMLElement>('[data-setup-actions]');
    if (actions) actions.hidden = false;
    const done = sheet.querySelector<HTMLElement>('[data-first-run-done]');
    if (done) done.hidden = true;
    if (sheet.querySelector('[data-setup-error]')) {
      sheet.querySelectorAll<HTMLFormElement>('form').forEach(form => say(form, ''));
      sheet.querySelector('[data-setup-error]')?.remove();
    }
    const heading = panels[next]?.querySelector<HTMLElement>('h2, h4');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }

  function firstRunResult(message: string, working = false, redo?: string): void {
    const slot = query<HTMLElement>('[data-first-run-result]');
    if (slot) slot.textContent = message;
    const done = query<HTMLElement>('[data-first-run-done]');
    const verifying = query<HTMLElement>('[data-first-run-sheet] [data-model-check]')?.closest<HTMLElement>('[data-setup-panel]')?.hidden === false;
    if (done) done.hidden = !working || !verifying;
    const primary = query<HTMLElement>('[data-first-run-sheet] [data-setup-submit]');
    if (primary && verifying) primary.hidden = working;
    const retry = query<HTMLElement>('[data-first-run-redo]');
    if (retry) { retry.hidden = !redo; retry.textContent = redo ?? ''; }
    const keys = query<HTMLElement>('[data-first-run-keys]');
    if (keys) keys.hidden = working || !firstRunCheckRequested;
  }

  /**
   * A requested read while the walkthrough is open (a connection finished, a
   * dialog closed) also brings the rest of the page up to date (#705): every
   * outermost region with an id outside the walkthrough is swapped for the
   * fresh one, unless the owner is working in it (typed input, focus, an open
   * confirmation) or it runs its own pairing poll. The walkthrough, its typed
   * fields and its saved choice stay exactly as they are.
   */
  function refreshAroundWalkthrough(template: HTMLTemplateElement): void {
    const walkthrough = query<HTMLElement>('[data-first-run-sheet]');
    if (!walkthrough) return;
    const active = activeElement();
    const dirty = (region: HTMLElement) => Array.from(region.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type="hidden"]):not([data-source-search]),textarea,select',
    )).some((field) => field instanceof HTMLSelectElement
      ? Array.from(field.options).some((option) => option.selected !== option.defaultSelected)
      : field.value !== field.defaultValue);
    for (const region of queryAll<HTMLElement>('[id]')) {
      // A region inside one already replaced went with it.
      if (!region.isConnected || !root.contains(region)) continue;
      if (region.contains(walkthrough) || walkthrough.contains(region)) continue;
      if (region.matches('[data-messaging-source]') || region.querySelector('[data-messaging-source]')) continue;
      if ((active && region.contains(active)) || region.querySelector('dialog[open]') || dirty(region)) continue;
      const next = Array.from(template.content.querySelectorAll<HTMLElement>('[id]')).find((candidate) => candidate.id === region.id);
      if (!next || next.querySelector('[data-first-run-sheet]')) continue;
      const openSheets = new Set(Array.from(region.querySelectorAll<HTMLElement>('.sheet.on')).map((sheet) => sheet.id).concat(region.matches('.sheet.on') ? [region.id] : []));
      const open = new Set(Array.from(region.querySelectorAll<HTMLDetailsElement>('details[open]')).map((node) =>
        node.dataset.pollKey || node.querySelector('summary')?.textContent?.trim() || ''));
      const fresh = document.importNode(next, true);
      region.replaceWith(fresh);
      fresh.querySelectorAll<HTMLDetailsElement>('details').forEach((node) => {
        if (open.has(node.dataset.pollKey || node.querySelector('summary')?.textContent?.trim() || '')) node.open = true;
      });
      [fresh, ...Array.from(fresh.querySelectorAll<HTMLElement>('.sheet'))].filter((sheet) => sheet.classList.contains('sheet') && openSheets.has(sheet.id)).forEach((sheet) => setSheetOpen(sheet, true));
      const wait = authorizationWait;
      const waitingSheet = wait && [fresh, ...Array.from(fresh.querySelectorAll<HTMLElement>('.sheet'))].find((candidate) => candidate.id === wait.sheetId);
      if (wait && waitingSheet) say(waitingSheet.querySelector('form[data-connect-kind="oauth"]') ?? waitingSheet, wait.message);
      fresh.querySelectorAll<HTMLScriptElement>('script[data-dashboard-rerun]').forEach((inert) => {
        const script = root.ownerDocument.createElement('script');
        for (const attribute of Array.from(inert.attributes)) script.setAttribute(attribute.name, attribute.value);
        script.text = inert.text;
        inert.replaceWith(script);
      });
    }
    applyWriteCapability();
  }

  async function readFirstRunReadiness(refreshAround = false): Promise<void> {
    try {
      const page = await options.refresh();
      if (disposed || options.signal.aborted || !firstRunChoice) return;
      if (!page || page.status !== 200) throw new Error('unavailable');
      canWrite = page.can_write;
      applyWriteCapability();
      const template = document.createElement('template');
      template.innerHTML = page.body;
      if (refreshAround) refreshAroundWalkthrough(template);
      // The walkthrough keeps its inputs. Only the independent download line
      // is replaced from this read, even before the readiness check is pressed.
      const previousProgress = query<HTMLElement>('[data-private-model-progress]');
      const nextProgress = template.content.querySelector<HTMLElement>('[data-private-model-progress]');
      if (previousProgress) {
        if (nextProgress) previousProgress.replaceWith(document.importNode(nextProgress, true));
        else previousProgress.remove();
      } else if (nextProgress) query('[data-first-run-sheet]')?.before(document.importNode(nextProgress, true));
      if (!firstRunCheckRequested) return;
      const encoded = template.content.querySelector<HTMLElement>('[data-model-setup-status]')?.dataset.modelSetupStatus;
      if (!encoded) throw new Error('missing readiness');
      const status = JSON.parse(encoded);
      if (status.privacy_choice_pending === true) {
        firstRunResult('Olympus is still applying your choice. Check readiness again after it restarts.');
      } else if (status.ready === true) {
        firstRunResult('Working', true);
      } else {
        const card = Array.isArray(status.cards) ? status.cards.find((item: { required: boolean; state: string }) => item.required && item.state !== 'ready') : undefined;
        const redo = card?.id === 'venice' && ['local-first', 'private-cloud-only'].includes(firstRunChoice)
          ? 'Redo Add a Venice key' : card?.id === 'local' && firstRunChoice === 'local-only' ? 'Redo Connect my local models' : undefined;
        firstRunResult(typeof card?.detail === 'string' ? card.detail
          : typeof status.attention === 'string' ? status.attention : 'Olympus is not ready yet. Check readiness again after it finishes applying your choice.', false, redo);
      }
    } catch {
      if (firstRunCheckRequested) firstRunResult('Could not read readiness. Olympus may be restarting; check again.');
    }
  }

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
    if (!open) {
      const choice = sheet.querySelector<HTMLElement>('[data-setup-choice], [data-setup-lead]');
      const walkthrough = sheet.querySelector<HTMLElement>('[data-setup-walkthrough]');
      if (choice && walkthrough) {
        choice.hidden = false;
        walkthrough.hidden = true;
        const note = choice.querySelector<HTMLElement>('[data-shared-app-note]');
        if (note) note.hidden = false;
      }
    }
    if (!sheet.id) return;
    queryAll<HTMLElement>('[data-sheet-toggle]').forEach((toggle) => {
      if (toggle.dataset.sheetToggle === `#${sheet.id}`) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  function say(form: ParentNode, message: string): void {
    // An open confirmation dialog inside the form covers it, so its answer goes
    // there; a form that itself sits in a dialog answers in its own slot.
    const slot = form.querySelector('dialog[open] [data-action-message]')
      ?? Array.from(form.querySelectorAll('[data-action-message]')).find(node => { const box = node.closest('dialog'); return !box || !(form as Node).contains(box); });
    if (slot) slot.textContent = message;
  }

  function errorCode(result: OlympusDashboardControlResult): string | undefined {
    const error = result.body.error;
    if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === 'string' ? code : undefined;
  }

  /**
   * A change that only a session opened on this computer may make (the first-run
   * privacy choice, local models): the session is fine, it is just not local yet.
   * Say so and offer the unlock in place; the person presses it, then the form is sent again.
   */
  function askLocalUnlock(form: HTMLFormElement): void {
    say(form, 'Unlock on this computer to save this.');
    if (!options.transport.openLocalControls) return;
    const slot = form.querySelector('[data-action-message]');
    if (!slot || slot.parentElement?.querySelector('[data-unlock-here]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.setAttribute('data-unlock-here', '');
    button.textContent = 'Unlock on this computer';
    button.addEventListener('click', () => {
      button.disabled = true;
      void (async () => {
        let opened = false;
        try { opened = await options.transport.openLocalControls!(); } catch { opened = false; }
        if (!opened) {
          button.disabled = false;
          say(form, 'Could not unlock. Open this dashboard in a browser on this computer and try again.');
          return;
        }
        button.remove();
        form.requestSubmit();
      })();
    });
    slot.after(button);
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
      'form[data-connect-kind],form[data-model-check],form[data-first-run-privacy],form[data-computer-use],form[data-judge-choice],form[data-model-choice],form[data-source-action],form[data-local-models-discover],form[data-local-models-test],form[data-agent-kind],form[data-settings-proposal]',
    ).forEach((form) => {
      // A form whose request is still outstanding keeps its submit controls
      // disabled, so a second click cannot issue a second transport call,
      // without taking the caret out of the fields the owner is still typing.
      const pending = pendingForms.has(form) || form.dataset.keyAccepted === 'true';
      Array.from(form.elements).filter((control): control is HTMLButtonElement | HTMLInputElement => control.matches('button,input:not([type="hidden"])'))
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
      // A redraw that waited on this control runs once the control's own answer is on the page.
      if (pendingFormCount === 0 && redrawOwed) setTimeout(() => { void refreshNow(false); }, 0);
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
      case 'connect_this_computer': return 'Connecting…';
      case 'apply_settings_proposal': return 'Applying…';
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
      case 'connect_this_computer': return 'Connected. Choose the folders Olympus may read.';
      case 'sync_now': return 'Checking now. The row updates when it finishes.';
      case 'disconnect_source': return 'Disconnected.';
      case 'delete_source_data': return 'Deleted what Olympus indexed from this source.';
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
    options: { keepSheetOpen?: boolean } = {},
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
    if (sheet && !options.keepSheetOpen) {
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
    if (form.hasAttribute('data-local-models-discover')) return { action: 'discover_local_models', base_url: body.base_url ?? '' };
    if (form.hasAttribute('data-local-models-test')) return { action: 'save_local_answer_model', base_url: body.base_url ?? '', answer_model: body.answer_model ?? '' };
    if (form.hasAttribute('data-judge-choice')) {
      // A spending limit only governs Venice: Local saves without one (#950).
      const choice = body.choice === 'venice' || body.choice === 'local-then-venice' ? body.choice : 'local';
      const cap = (body.cap_dollars ?? '').trim();
      if (choice !== 'local' && cap === '') { say(form, 'Enter a total cloud spending limit in dollars to use Venice.'); return undefined; }
      return { action: 'save_judge', choice, cap_dollars: cap === '' ? 0 : Number(cap) };
    }
    if (form.hasAttribute('data-model-choice')) {
      const provider = body.provider === 'local' || body.provider === 'venice' || body.provider === 'zkapi' ? body.provider : undefined;
      const model = (body.model ?? '').trim();
      if (!provider || model === '') { say(form, 'Choose a model.'); return undefined; }
      return { action: 'save_model_choice', provider, model };
    }
    if (form.hasAttribute('data-source-action')) {
      const kind = form.dataset.sourceAction;
      if (kind === 'sync_now' && body.source) return { action: 'sync_now', source: body.source };
      if ((kind === 'disconnect_source' || kind === 'delete_source_data') && body.source_id) return { action: kind, source_id: body.source_id, acknowledge: true };
      return undefined;
    }
    if (form.hasAttribute('data-computer-use')) return { action: 'set_computer_use', choice: (form.hasAttribute('data-server-mode') ? body.server === 'on' : body.choice === 'server') ? 'server' : 'everyday' };
    if (form.hasAttribute('data-first-run-privacy')) return { action: 'save_first_run_privacy', choice: body.choice ?? '' };
    if (form.hasAttribute('data-settings-proposal')) {
      // The proposal the owner is looking at, by id: a newer one from the agent is never applied unseen.
      if (!body.id) return undefined;
      return { action: form.dataset.settingsProposal === 'discard' ? 'discard_settings_proposal' : 'apply_settings_proposal', id: body.id };
    }
    const connect = form.dataset.connectKind;
    if (connect === 'oauth') {
      return {
        action: 'start_oauth',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'start_oauth' }>['source'],
        ...(body.client_id ? { client_id: body.client_id } : {}),
        ...(body.client_secret ? { client_secret: body.client_secret } : {}),
        ...(body.google_desktop === 'true' ? { google_desktop: true } : {}),
        ...(uploadedClientFiles.has(form) ? { google_client_json: uploadedClientFiles.get(form)! } : {}),
      };
    }
    if (connect === 'this_computer') {
      return {
        action: 'connect_this_computer',
        source: body.source as Extract<OlympusDashboardControlParams, { action: 'connect_this_computer' }>['source'],
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
    if (params.action === 'start_oauth') {
      clearAuthorizationFallback(form);
      uploadedClientFiles.delete(form);
    }
    if (firstRunChoice && ['check_model_setup', 'save_local_answer_model', 'connect_api_key'].includes(params.action)) {
      firstRunCheckRequested = false;
      firstRunResult('Check readiness after Olympus applies your changes.');
    }
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
      if (result.status === 403 && errorCode(result) === 'mac_dashboard_only') { askLocalUnlock(form); return; }
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
      const message = errorMessage(result);
      say(form, message);
      showSetupFailure(form, message);
      return;
    }
    if (params.action === 'discover_local_models') {
      renderDiscoveredModels(form, result.body.results);
      return;
    }
    if (params.action === 'save_first_run_privacy' && form.closest('[data-first-run-sheet]')) {
      firstRunChoice = params.choice;
      releaseSubmittedForm(form, submittedValues);
      form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(control => { control.disabled = true; });
      const venice = query<HTMLElement>('[data-first-run-venice]');
      const local = query<HTMLElement>('[data-first-run-local]');
      if (venice) venice.hidden = !['local-first', 'private-cloud-only'].includes(params.choice);
      if (local) local.hidden = params.choice !== 'local-only';
      const help = query<HTMLElement>('[data-first-run-venice-help]');
      if (help) help.textContent = params.choice === 'local-first'
        ? 'Optional: add a key for Venice fallback, or continue with the built-in model on this computer.'
        : 'Add your Venice key in the existing field below, then return here to check readiness.';
      const steps = form.closest<HTMLElement>('[data-setup-steps]');
      if (steps) showSetupStep(steps, params.choice === 'no-sensitive' ? 2 : 1);
      return;
    }
    if (params.action === 'check_model_setup' && form.closest('[data-first-run-sheet]')) {
      firstRunCheckRequested = true;
      say(form, 'Readiness check requested.');
      firstRunResult('Checking readiness…');
      await readFirstRunReadiness();
      return;
    }
    if (params.action === 'test_local_models') {
      const checked = result.body.result;
      if (checked && typeof checked === 'object' && !Array.isArray(checked)) {
        const detail = checked as Record<string, unknown>;
        say(form, detail.working === true ? 'Working. Synthetic checks passed. Your configured models have not changed.'
          : `${typeof detail.step === 'string' ? detail.step : 'Model'}: ${typeof detail.detail === 'string' ? detail.detail : 'The model check failed.'}`);
      } else say(form, 'The local model check did not return a result.');
      return;
    }
    if (typeof authorizationUrl === 'string' && authorizationUrl.startsWith('https://')) {
      // The provider has not answered yet. Only the server's card may ever
      // report a live connection, so the page states what it is waiting for
      // and reads again when the owner comes back.
      awaitingAuthorizationReturn = true;
      if (authorizationTab) authorizationTab.location.href = authorizationUrl;
      else if (!openAuthorizationExternally(authorizationUrl)) {
        say(form, 'Waiting for authorization. Open the page to continue — this card updates when the connection completes.');
        showAuthorizationFallback(form, authorizationUrl);
        return;
      }
      const wait = `Authorization opened in ${authorizationTab ? 'a new tab' : 'your default browser'}. Approve it there, then come back to Olympus — this card updates when the connection completes.`;
      say(form, wait);
      // The form's secrets are the backend's now, but its sheet stays open on this line: closing it (and the
      // redraw that follows replacing the form) left the owner nothing saying the sign-in had started.
      if (releaseSubmittedForm(form, submittedValues, { keepSheetOpen: true })) {
        const sheetId = form.closest<HTMLElement>('.sheet')?.id;
        authorizationWait = sheetId ? { sheetId, message: wait } : undefined;
        void refreshNow(false, true);
      }
      return;
    }
    closeAuthorizationTab(authorizationTab);
    if (firstRunChoice && (params.action === 'save_local_answer_model' || params.action === 'connect_api_key')) {
      firstRunCheckRequested = false;
      firstRunResult('Saved. Check readiness after Olympus applies the change.');
    }
    const statusMessage = result.body.status_message;
    if (params.action === 'save_model_choice' || params.action === 'save_local_answer_model' || params.action === 'disconnect_source' || params.action === 'delete_source_data') {
      form.closest<HTMLDialogElement>('dialog[open]')?.close();
    }
    if (params.action === 'save_judge') {
      // The choice is accepted: only now does its confirmation close (a refusal keeps it open, saying why).
      form.dataset.judgeCurrent = params.choice;
      form.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach(dialog => dialog.close());
    }
    const released = releaseSubmittedForm(form, submittedValues);
    if (released && params.action === 'connect_api_key') {
      form.dataset.keyAccepted = 'true';
      form.querySelectorAll<HTMLInputElement>('input[name="api_key"]').forEach((input) => { input.value = ''; input.hidden = true; });
      Array.from(form.elements).filter((control): control is HTMLButtonElement => control.matches('button[type="submit"],button:not([type])')).forEach((button) => {
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
    // Checking changes nothing on a page whose models are already ready, and a redraw clears the line the form just said:
    // the owner must still see that the check ran.
    if (params.action === 'check_model_setup' && !disposed) {
      const again = query<HTMLFormElement>('form[data-model-check]');
      if (again && !again.querySelector('[data-action-message]')?.textContent) say(again, 'Checked just now.');
    }
    // Saving the choice already shown redraws the same form; its answer must survive that redraw (#950).
    if (params.action === 'save_judge' && typeof statusMessage === 'string' && !disposed) {
      const again = query<HTMLFormElement>('form[data-judge-choice]');
      if (again && !again.querySelector('[data-action-message]')?.textContent) say(again, statusMessage);
    }
  }

  function renderDiscoveredModels(form: HTMLFormElement, value: unknown): void {
    const sheet = form.closest('.sheet, dialog');
    const output = sheet?.querySelector<HTMLElement>('[data-local-models-results]');
    const testForm = sheet?.querySelector<HTMLFormElement>('[data-local-models-test]');
    if (!output || !testForm) return;
    output.replaceChildren();
    testForm.hidden = true;
    const results = Array.isArray(value) ? value : [];
    if (!results.length) { say(form, 'No model servers were found. Start an existing server or enter its loopback URL.'); return; }
    let selected = false;
    results.forEach(result => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return;
      const item = result as Record<string, unknown>;
      const row = document.createElement('div');
      const description = document.createElement('p');
      description.textContent = `${typeof item.provider === 'string' ? item.provider : 'Local server'}: ${typeof item.detail === 'string' ? item.detail : 'No result'}`;
      row.append(description);
      const models = Array.isArray(item.models) ? item.models.filter(model => model && typeof model === 'object' && !Array.isArray(model) && typeof model.id === 'string') : [];
      models.filter(model => model.allowed !== true).forEach(model => {
        const notice = document.createElement('p');
        notice.textContent = `${model.id}: ${typeof model.reason === 'string' ? model.reason : 'Cannot be used as a local model.'}`;
        row.append(notice);
      });
      const allowed = models.filter(model => model.allowed === true);
      if (item.working === true && allowed.length && typeof item.baseUrl === 'string') {
        const choose = (): void => {
          const endpoint = testForm.querySelector<HTMLInputElement>('input[name="base_url"]');
          if (endpoint) endpoint.value = item.baseUrl as string;
          testForm.querySelectorAll<HTMLSelectElement>('select').forEach(select => {
            select.replaceChildren();
            allowed.forEach(model => {
              const option = document.createElement('option');
              option.value = model.id;
              option.textContent = model.id;
              select.append(option);
            });
          });
          testForm.hidden = false;
          say(testForm, `Using ${item.baseUrl}. Choose an answer model, then test.`);
        };
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.textContent = `Use ${item.baseUrl}`;
        button.addEventListener('click', choose);
        row.append(button);
        if (!selected) { choose(); selected = true; }
      }
      output.append(row);
    });
    say(form, selected ? 'Server detected. Select an answer model below.' : 'No usable local models found. Olympus does not download models.');
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
    if (kind === 'key') {
      // The agent chosen on Connect an agent sets who hosts the connection.
      const route = form.dataset.privateRoute;
      const privateRoute = route === 'loopback' || route === 'tailnet' ? route : undefined;
      const agent = privateRoute ? 'other' : form.closest<HTMLElement>('[data-agent]')?.dataset.agent;
      return { action: 'create_agent_key', name: formRecord(form).name || '', ...(agent ? { agent } : {}), ...(privateRoute ? { route: privateRoute } : {}) };
    }
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

  function showAgentSecret(form: HTMLFormElement, value: string, note: string, mcpUrl?: string): void {
    const holder = form.closest('[data-agent-step]') || form.parentElement || form;
    const slot = holder.querySelector<HTMLElement>('[data-agent-secret-slot]');
    const field = slot?.querySelector<HTMLInputElement>('[data-agent-secret]');
    if (!slot || !field) return;
    field.value = value;
    slot.querySelectorAll<HTMLInputElement>('[data-agent-setup]').forEach(setup => {
      setup.value = mcpUrl
        ? `Connect Olympus to ${setup.dataset.agentSetup}. Add a remote MCP server named olympus with URL ${mcpUrl} and header Authorization: Bearer ${value}. Keep this key private. Confirm that Olympus tools are available.`
        : '';
    });
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
      showAgentSecret(form, result.body.token, 'Copy it now. Olympus keeps only a fingerprint of this key and cannot show it again. Each setup line includes this key; keep it private.',
        typeof result.body.mcp_url === 'string' ? result.body.mcp_url : undefined);
      await refreshAgentList();
      return;
    }
    // A pairing code or a key that did not come back is a failure to say, never a revoke.
    if (params.action === 'mint_agent_pairing_code' || params.action === 'create_agent_key') {
      say(form, params.action === 'create_agent_key'
        ? 'Olympus did not return a key. Try again; if it keeps happening, restart Olympus.'
        : 'Olympus did not return a pairing code. Try again; if it keeps happening, restart Olympus.');
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
      'input:not([type="hidden"]):not([data-source-search]),textarea,select',
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
      if (sheet) setSheetOpen(sheet, true);
      queryAll<HTMLElement>('[data-sheet-toggle]').filter((toggle) => toggle.dataset.sheetToggle === `#${id}`).forEach((toggle) => toggle.setAttribute('aria-expanded', 'true'));
    }
    const wait = authorizationWait;
    const waitingSheet = wait && queryAll<HTMLElement>('.sheet').find((candidate) => candidate.id === wait.sheetId);
    if (wait && waitingSheet) say(waitingSheet.querySelector('form[data-connect-kind="oauth"]') ?? waitingSheet, wait.message);
    findByFocusKey(focused)?.focus();
    // A part that binds its own controls (the anonymous answers card) marks its
    // scripts to run again: inserted markup leaves them inert, and without them
    // its controls would be disconnected.
    queryAll<HTMLScriptElement>('script[data-dashboard-rerun]').forEach((inert) => {
      const script = root.ownerDocument.createElement('script');
      for (const attribute of Array.from(inert.attributes)) script.setAttribute(attribute.name, attribute.value);
      script.text = inert.text;
      inert.replaceWith(script);
    });
    signature = result.signature;
    pollIntervalMs = result.poll_interval_ms;
    deferredSince = 0;
    applyWriteCapability();
    resumeMessaging();
  }

  async function refreshNow(force: boolean, requested = false): Promise<void> {
    if (disposed || inFlight || pendingFormCount > 0 || options.signal.aborted) return;
    if (firstRunChoice) {
      // Read authoritative readiness while leaving the active walkthrough and
      // any typed key/model fields in place, even during worker activation.
      // A requested or forced read also redraws the rest of the page around it (#705).
      const around = force || requested || redrawOwed;
      redrawOwed = false;
      inFlight = true;
      try { await readFirstRunReadiness(around); } finally { inFlight = false; }
      return;
    }
    if (redrawOwed) { redrawOwed = false; force = true; }
    if (!force && !presented) return;
    const ownerDocument = root.ownerDocument;
    if (!force && !requested && ownerDocument.visibilityState === 'hidden') return;
    if (!force && (query('[data-messaging-input] input,[data-messaging-chats] input') || messagingTimers.size > 0 || queryAll('.sheet.on input:not([type="hidden"]),.sheet.on textarea,.sheet.on select').some((field) => !field.closest('dialog:not([open])')))) return;
    // The owner is reading the agreement: a poll must not close it under them.
    if (!force && query('[data-remote-terms]:not([hidden])')) return;
    // Nor a confirmation or Add a source while it is open; closing it reads again.
    if (!force && query('dialog[open]')) return;
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
      // A choice may have saved while this earlier poll was in flight.
      if (firstRunChoice) return;
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
      if (redrawOwed && pendingFormCount === 0) void refreshNow(false);
    }
  }

  /**
   * A part of the page that saved its own settings (the anonymous answers
   * card) asks for the page to be read again now. Claiming the event tells it
   * no reload is needed: the fresh page is swapped in place, open sections and
   * sheets kept, and the part's own scripts run again.
   */
  function onRedrawRequest(event: Event): void {
    event.preventDefault();
    redrawOwed = true;
    void refreshNow(false);
  }

  function restartPoll(): void {
    if (interval) clearInterval(interval);
    interval = pollIntervalMs > 0
      ? setInterval(() => { void refreshNow(false); }, pollIntervalMs)
      : undefined;
  }

  options.signal.addEventListener('abort', () => {
    messagingTimers.forEach(timer => clearTimeout(timer));
    messagingTimers.clear();
    queryAll<HTMLInputElement>('[data-messaging-input] input').forEach(input => { input.value = ''; });
    queryAll<HTMLImageElement>('[data-messaging-qr]').forEach(qr => { qr.removeAttribute('src'); qr.hidden = true; });
  }, { once: true });
  const messagingTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const messagingBusy = new WeakSet<HTMLElement>();
  const messagingQueued = new Map<HTMLElement, () => void>();
  const messagingSeen = new Set<string>();
  // Cards whose last answer was a pairing still running, and how many status
  // reads in a row have failed since.
  const messagingActive = new WeakSet<HTMLElement>();
  const messagingMisses = new Map<HTMLElement, number>();
  const PAIRING_ACTIVE = (state: string): boolean => state !== '' && !['paired', 'complete', 'completed', 'failed', 'cancelled', 'idle', 'not_paired', 'scope_selection_required'].includes(state);
  const stillWorkingWords = (source: string): string => source === 'whatsapp'
    ? 'Still preparing WhatsApp on this computer. The first time can take about a minute.'
    : 'Still working on this computer…';
  /** Schedules the next status read with backoff when a pairing was running; false when it was not. */
  function keepPolling(card: HTMLElement): boolean {
    if (!messagingActive.has(card)) return false;
    const misses = (messagingMisses.get(card) ?? 0) + 1;
    // About ten minutes of failed reads, the bridge build's own limit, then the error stands.
    if (misses > 60) { messagingMisses.delete(card); messagingActive.delete(card); return false; }
    messagingMisses.set(card, misses);
    const delay = Math.min(10_000, 1_200 * 2 ** Math.min(misses - 1, 3));
    messagingTimers.set(card, setTimeout(() => { messagingTimers.delete(card); void messagingRequest(card, 'status'); }, delay));
    return true;
  }

  function resumeMessaging(): void {
    messagingTimers.forEach((timer, card) => { if (!card.isConnected) { clearTimeout(timer); messagingTimers.delete(card); } });
    // A card showing "Open controls on this computer" has no pairing controls: this session cannot use the routes, so it must not ask them.
    queryAll<HTMLElement>('[data-messaging-source]').forEach(card => { if (!card.querySelector('[data-messaging-open-controls]')) void messagingRequest(card, 'status'); });
  }

  /** A pressed button shows it (#1086): busy and disabled in place, with its own words, until its request ends. */
  const MESSAGING_BUSY_WORDS: Record<string, string> = { chats: 'Loading chats…', scope: 'Saving…', status: 'Checking…', start: 'Starting…', respond: 'Checking…', cancel: 'Cancelling…' };
  function startButtonBusy(button: HTMLButtonElement | null | undefined, operation: string): void {
    if (!button) return;
    button.dataset.idleLabel = button.textContent ?? '';
    button.textContent = MESSAGING_BUSY_WORDS[operation] ?? 'Working…';
    button.disabled = true;
    button.classList.add('busy');
    button.setAttribute('aria-busy', 'true');
  }
  function endButtonBusy(button: HTMLButtonElement | null | undefined): void {
    if (!button || !button.classList.contains('busy')) return;
    button.textContent = button.dataset.idleLabel ?? button.textContent;
    delete button.dataset.idleLabel;
    button.disabled = false;
    button.classList.remove('busy');
    button.removeAttribute('aria-busy');
  }
  const messagingQueuedButton = new Map<HTMLElement, HTMLButtonElement>();

  async function messagingRequest(card: HTMLElement, operation: 'start' | 'status' | 'respond' | 'cancel' | 'scope' | 'chats', extra: { field?: string; value?: string; wholeAccount?: boolean; chatScopes?: string[]; chatKinds?: string[] } = {}, button?: HTMLButtonElement | null): Promise<void> {
    if (!canWrite || disposed || !options.transport.messaging) { endButtonBusy(button); return; }
    if (messagingBusy.has(card)) {
      // A status poll is in flight: run the user's action right after it instead of dropping it.
      if (operation !== 'status') {
        const replaced = messagingQueuedButton.get(card);
        if (replaced && replaced !== button) endButtonBusy(replaced);
        if (button) messagingQueuedButton.set(card, button); else messagingQueuedButton.delete(card);
        messagingQueued.set(card, () => { messagingQueuedButton.delete(card); void messagingRequest(card, operation, extra, button); });
      } else endButtonBusy(button);
      return;
    }
    const source = card.dataset.messagingSource;
    if ((source !== 'telegram' && source !== 'whatsapp') || card.querySelector('[data-messaging-open-controls]')) { endButtonBusy(button); return; }
    const timer = messagingTimers.get(card);
    if (timer) clearTimeout(timer);
    messagingTimers.delete(card);
    messagingBusy.add(card);
    const status = card.querySelector<HTMLElement>('[data-messaging-status]');
    const wasPaired = card.hasAttribute('data-messaging-paired');
    // No separate "working" line: the pressed button itself is busy.
    if (status && operation !== 'status') status.textContent = '';
    try {
      const params = { source: source as 'telegram' | 'whatsapp', ...extra };
      let result: OlympusDashboardControlResult;
      try {
        result = await options.transport.messaging(operation, params);
        // Authentication rejects the request before the pairing handler runs.
        // Renew only for a gesture, once, so the first press after an idle tab works.
        if (operation !== 'status' && (result.status === 401 || result.status === 403)
          && options.transport.openLocalControls && await options.transport.openLocalControls()) {
          result = await options.transport.messaging(operation, params);
        }
      }
      finally { delete params.value; delete extra.value; }
      if (disposed || !card.isConnected) return;
      const body = result.body;
      const inputSlot = card.querySelector<HTMLElement>('[data-messaging-input]');
      const qr = card.querySelector<HTMLImageElement>('[data-messaging-qr]');
      if (result.status < 200 || result.status >= 300 || body.ok === false) {
        // A status read can fail while the computer is busy (the first
        // WhatsApp pairing builds its helper for about a minute). The pairing
        // itself is still running, so keep asking, more slowly, and say so;
        // only the pairing's own failed state is an error.
        if (operation === 'status' && result.status !== 401 && result.status !== 403 && keepPolling(card)) {
          if (status) status.textContent = stillWorkingWords(source);
          return;
        }
        if (status) status.textContent = result.status === 401 || result.status === 403 ? 'Open dashboard controls on this computer to use this, then try again.' : 'Could not complete this step. Try again from this computer.';
        if (qr) { qr.hidden = true; qr.removeAttribute('src'); }
        if (inputSlot) inputSlot.replaceChildren();
        return;
      }
      const state = typeof body.state === 'string' ? body.state : '';
      messagingMisses.delete(card);
      if (PAIRING_ACTIVE(state)) messagingActive.add(card); else messagingActive.delete(card);
      if (['paired', 'complete', 'completed'].includes(state) && !card.hasAttribute('data-messaging-paired')) {
        // Paired: the pairing explanation and Pair go; Choose chats is the one primary action, and the ⋯ menu holds the rest.
        card.setAttribute('data-messaging-paired', '');
        card.querySelectorAll<HTMLElement>('[data-paired-only]').forEach((element) => { element.hidden = element.matches('[data-messaging-kind="chats"]') && !!card.querySelector('[data-messaging-chats] [data-kind-picker]'); });
        card.querySelectorAll<HTMLElement>('[data-unpaired-only]').forEach((element) => { element.hidden = true; });
        const account = card.querySelector<HTMLElement>('[data-messaging-account]');
        if (account && account.textContent === 'Not paired yet') account.textContent = source === 'whatsapp' ? 'Your linked WhatsApp account' : 'Your linked Telegram account';
      }

      const field = typeof body.field === 'string' ? body.field : '';
      const labels: Record<string, string> = { api_id: 'Telegram API ID', api_hash: 'Telegram API hash', phone: 'Phone number (with country code)', code: 'Telegram login code', password: 'Telegram two-step verification password' };
      const label = labels[field];
      const restoring = operation === 'status' && !messagingSeen.has(source);
      messagingSeen.add(source);
      const setupSheet = card.querySelector<HTMLElement>('[data-messaging-setup]');
      if (setupSheet) {
        const intro = setupSheet.querySelector<HTMLElement>('[data-messaging-setup-intro]');
        const active = !['idle', 'failed', 'cancelled', 'completed', 'complete', 'paired', 'not_paired', 'scope_selection_required'].includes(state);
        if (intro) intro.hidden = active || state === 'failed';
        const cancel = card.querySelector<HTMLElement>('[data-messaging-kind="cancel"]');
        if (cancel) {
          const choosingScope = state === 'scope_selection_required';
          cancel.hidden = !active && !choosingScope;
          // A pending grant can still be cancelled after the sign-in sheet closes.
          (choosingScope ? card : setupSheet).append(cancel);
        }
        const choosingChats = operation === 'chats' || operation === 'scope' || ['scope_selection_required', 'paired', 'complete', 'completed'].includes(state);
        if (choosingChats) setSheetOpen(setupSheet, false);
        else if (operation !== 'status' || (restoring && (active || state === 'failed'))) {
          queryAll<HTMLElement>('.sheet.on').forEach(other => { if (other !== setupSheet) setSheetOpen(other, false); });
          setSheetOpen(setupSheet, true);
        }
        setupSheet.querySelector('[data-pairing-error]')?.remove();
        if (state === 'failed') {
          const error = document.createElement('div'); error.dataset.pairingError = '';
          const details = document.createElement('details'); details.className = 'howto';
          const summary = document.createElement('summary'); summary.textContent = 'How to fix';
          const hint = document.createElement('p'); hint.textContent = source === 'whatsapp'
            ? (body.reason === 'bridge_build_tools_missing' ? 'This install has no ready WhatsApp helper, and this computer has no Go and C compiler to build one. Reinstall Olympus with the installer from olympusplugin.ai, which includes the helper, then pair again.'
              : body.reason === 'bridge_build_failed' ? 'Olympus could not build its WhatsApp helper on this computer. Reinstall Olympus with the installer from olympusplugin.ai, which includes the helper, then pair again.'
              : body.unlinked === 'removed' ? 'Olympus removed itself from your phone\'s linked devices, so there is nothing to clean up. Pair again; if it fails again, press Copy details and send what it copies to support.'
              : body.unlinked === 'offline' || body.unlinked === 'failed' ? 'Olympus could not remove itself from your phone. Remove the Olympus entry in WhatsApp → Settings → Linked devices, then pair again. If it fails again, press Copy details and send what it copies to support.'
                : 'Pair again. If it fails again, press Copy details and send what it copies to support.')
            : 'Check api_id and api_hash at my.telegram.org/apps. Enter the latest code from Telegram and your two-step verification password if asked. Then try pairing again.';
          details.append(summary, hint);
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.dataset.messagingRetry = ''; retry.textContent = 'Back to setup';
          error.append(details, retry);
          // What support needs instead of a Terminal command: fixed codes, version and OS only (built by the engine).
          if (typeof body.details === 'string' && body.details) {
            const report = document.createElement('div'); report.className = 'promptbox'; report.id = `pairing-details-${source}`; report.textContent = body.details;
            const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn'; copy.dataset.copyTarget = `#${report.id}`; copy.textContent = 'Copy details';
            const said = document.createElement('span'); said.dataset.copyStatus = ''; said.setAttribute('aria-live', 'polite');
            const note = document.createElement('p'); note.textContent = 'Nothing from your account: no names, numbers or chats.';
            const row = document.createElement('div'); row.append(copy, said);
            error.append(report, note, row);
          }
          setupSheet.append(error);
        }
      }
      // Cancel pairing is offered only while a pairing is running, including while it waits for the chat choice; at any other time it would do nothing.
      const cardCancel = card.querySelector<HTMLElement>('.actionrow [data-messaging-kind="cancel"]');
      if (cardCancel) cardCancel.hidden = ['idle', 'failed', 'cancelled', 'completed', 'complete', 'paired', 'not_paired'].includes(state);
      // A cancelled re-pair leaves the earlier grant suspended: say so, never that capture carries on (#706).
      const cancelledLead = body.capturePaused === true
        ? 'Setup cancelled. Your chat choices were not changed, but capture of this account stays paused until pairing again succeeds'
        : 'Setup cancelled. Capture permission was not changed';
      if (status) status.textContent = label ? `Enter ${label.toLowerCase()} to continue.` : state === 'failed' ? (body.registrationMayBeSaved === true ? 'Pairing could not finish. The connection may already be saved; check connection and capture status before retrying.' : (body.capturePaused === true ? 'Pairing failed. Capture of this account stays paused until pairing again succeeds. Start pairing again to retry.' : 'Pairing failed. Start pairing again to retry.')) + (typeof body.reason === 'string' && /^[a-z0-9_]{1,64}$/.test(body.reason) ? ` (${body.reason})` : '') : state === 'not_paired' ? 'Not paired yet. Pair this account first, then choose the chats Olympus may read.' : state === 'idle' ? '' : state === 'scope_selection_required' ? 'Paired. Nothing is being captured. Choose what Olympus may read.' : state === 'committing' ? 'Saving the connection and chat permission…' : (state === 'paired' || state === 'complete' || state === 'completed') && operation !== 'scope' && operation !== 'chats' ? (wasPaired ? (operation === 'status' && button ? 'Connected.' : '') : 'Paired. Choose the chats Olympus reads.') : state === 'cancelled' ? (source === 'whatsapp'
        ? (body.unlinked === 'removed' ? cancelledLead + ', and Olympus removed itself from your phone\'s linked devices.'
          : body.unlinked === 'offline' || body.unlinked === 'failed' ? cancelledLead + '. Olympus could not remove itself from your phone: remove Olympus in WhatsApp linked devices.'
            : cancelledLead + '. If your phone linked Olympus, Olympus removes it from WhatsApp linked devices.')
        : cancelledLead + '. If you linked a new device, remove Olympus in Telegram active sessions to unlink it.') : operation === 'scope' ? 'Chat choices saved. Capture will use this selection.' : operation === 'chats' ? '' : source === 'whatsapp' ? (body.linked === true ? 'Linked. Reading your chat list from WhatsApp; this can take a minute…' : typeof body.qr === 'string' && body.qr ? 'Open WhatsApp → Settings → Linked devices and scan the QR code.' : 'Preparing WhatsApp. The first time can take about a minute.') : 'Pairing is running on this computer…';
      if (qr) {
        const value = typeof body.qr === 'string' ? body.qr : '';
        // Only the local helper's raster QR image is displayed; no external requests or SVG markup.
        if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) { qr.src = value; qr.hidden = false; }
        else { qr.hidden = true; qr.removeAttribute('src'); }
      }
      if (inputSlot && inputSlot.dataset.field !== field) {
        inputSlot.replaceChildren();
        inputSlot.dataset.field = field;
        if (label) {
          const form = document.createElement('form'); form.method = 'dialog'; form.dataset.messagingKind = 'respond'; form.dataset.field = field;
          const wrapper = document.createElement('label'); wrapper.textContent = label + ' ';
          const input = document.createElement('input'); input.name = 'value'; input.required = true; input.type = field === 'phone' || field === 'api_id' ? 'text' : 'password'; input.autocomplete = 'off'; input.setAttribute('autocapitalize', 'off'); input.spellcheck = false;
          wrapper.append(input); form.append(wrapper);
          // Where to find what is asked for (owner, 2026-11-03: say the code is in a Telegram message).
          const hints: Record<string, string> = { code: 'Telegram has just sent you a message in the Telegram app, from the account called Telegram. The login code is in that message.', password: 'The password you set under Two-Step Verification in Telegram\u2019s Privacy and Security settings.' };
          if (hints[field]) { const hint = document.createElement('p'); hint.className = 'setupnote'; hint.dataset.messagingFieldHint = field; hint.textContent = hints[field]!; form.append(hint); }
          const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Continue'; button.className = 'btn'; form.append(button); inputSlot.append(form); input.focus();
        }
      }
      const choosingScope = state === 'scope_selection_required';
      const chatSlot = card.querySelector<HTMLElement>('[data-messaging-chats]');
      if (!choosingScope && chatSlot?.dataset.pendingChoice === 'true') chatSlot.replaceChildren();
      if (chatSlot) { chatSlot.dataset.pendingChoice = String(choosingScope); }
      if (Array.isArray(body.chats) && typeof body.wholeAccount === 'boolean' && Array.isArray(body.chatScopes)) {
        const slot = card.querySelector<HTMLElement>('[data-messaging-chats]');
        if (slot) {
          slot.replaceChildren(buildChatPicker(source, body, choosingScope));
          // The chooser is the content now, and its Save the one primary action.
          const chooseChats = card.querySelector<HTMLElement>('form[data-messaging-kind="chats"]');
          if (chooseChats) chooseChats.hidden = true;
        }
      }
      // A saved choice closes the chooser, whose chat list the save used up, and
      // brings Choose chats back so the choice can be changed again.
      if (operation === 'scope' && ['paired', 'complete', 'completed'].includes(state)) {
        card.querySelector<HTMLElement>('[data-messaging-chats]')?.replaceChildren();
        const chooseChats = card.querySelector<HTMLElement>('form[data-messaging-kind="chats"]');
        if (chooseChats) chooseChats.hidden = false;
      }
      if ((state === 'cancelled' && body.cleaning === true) || (operation !== 'chats' && (operation !== 'cancel' || state === 'committing') && !['paired', 'complete', 'completed', 'failed', 'cancelled', 'idle', 'not_paired', 'scope_selection_required'].includes(state))) {
        messagingTimers.set(card, setTimeout(() => { messagingTimers.delete(card); void messagingRequest(card, 'status'); }, 1200));
      }
    } catch {
      if (operation === 'status' && keepPolling(card)) {
        if (status) status.textContent = stillWorkingWords(source);
      } else if (status) status.textContent = 'Could not reach pairing on this computer. Try again.';
    } finally {
      messagingBusy.delete(card);
      endButtonBusy(button);
      const queued = messagingQueued.get(card);
      messagingQueued.delete(card);
      if (queued && !disposed) queued();
    }
  }

  function submitMessaging(form: HTMLFormElement): void {
    const card = form.closest<HTMLElement>('[data-messaging-source]');
    const kind = form.dataset.messagingKind;
    if (!card) return;
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]:not([data-kind-open])');
    // A second press while the first runs does nothing.
    if (button?.classList.contains('busy')) return;
    form.closest<HTMLDetailsElement>('details.rowmenu')?.removeAttribute('open');
    if (kind === 'respond') {
      const input = form.querySelector<HTMLInputElement>('input[name="value"]');
      if (!input) return;
      const value = input.value; input.value = '';
      startButtonBusy(button, kind);
      void messagingRequest(card, 'respond', { ...(form.dataset.field ? { field: form.dataset.field } : {}), value }, button);
    } else if (kind === 'scope') {
      const choice = chatPickerChoice(form);
      if (!choice) {
        const status = card.querySelector<HTMLElement>('[data-messaging-status]');
        if (status) status.textContent = 'Choose all chats, a kind, or at least one chat.';
        return;
      }
      startButtonBusy(button, kind);
      void messagingRequest(card, 'scope', choice, button);
    } else if (kind === 'start' || kind === 'chats' || kind === 'cancel' || kind === 'status') {
      startButtonBusy(button, kind);
      void messagingRequest(card, kind, {}, button);
    }
  }

  // The chat chooser (#1075): Read all chats on top, then one switch per kind
  // (every chat of that kind, including new ones), each opening to a search
  // and its chats, most recent first. Choosing chats never decides privacy.
  const CHAT_KIND_LABELS: Record<string, [string, string]> = {
    dm: ['One-to-one', 'one-to-one chats'], group: ['Groups', 'groups'], channel: ['Channels', 'channels'],
    bot: ['Bots', 'bots'], community: ['Communities', 'communities'],
  };
  const SOURCE_KINDS: Record<string, string[]> = { telegram: ['dm', 'group', 'channel', 'bot'], whatsapp: ['dm', 'group', 'community'] };
  /** The suggested start at first pairing: one-to-one chats and groups on, the rest off; nothing is read until Save. */
  const SUGGESTED_KINDS = ['dm', 'group'];

  function whenLabel(iso: unknown): string {
    if (typeof iso !== 'string') return '';
    const time = Date.parse(iso);
    if (Number.isNaN(time)) return '';
    const days = Math.floor((Date.now() - time) / 86_400_000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(time).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function chatPickerChoice(form: HTMLFormElement): { wholeAccount: boolean; chatScopes: string[]; chatKinds: string[] } | undefined {
    const whole = form.querySelector<HTMLInputElement>('[name="wholeAccount"]')?.checked === true;
    if (whole) return { wholeAccount: true, chatScopes: [], chatKinds: [] };
    const chatKinds = Array.from(form.querySelectorAll<HTMLInputElement>('[name="chatKind"]:checked')).map((input) => input.value);
    // A chat whose whole kind is on is already covered by the kind.
    const chatScopes = Array.from(form.querySelectorAll<HTMLInputElement>('[name="chatScope"]:checked'))
      .filter((input) => !chatKinds.includes(input.closest<HTMLElement>('[data-kind-group]')?.dataset.kindGroup ?? ''))
      .map((input) => input.value);
    return chatKinds.length || chatScopes.length ? { wholeAccount: false, chatScopes, chatKinds } : undefined;
  }

  function buildChatPicker(source: string, body: Record<string, unknown>, choosingScope: boolean): HTMLFormElement {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    };
    const kinds = SOURCE_KINDS[source] ?? [];
    const selected = new Set(Array.isArray(body.chatScopes) ? body.chatScopes.filter((value): value is string => typeof value === 'string') : []);
    const kindsOn = new Set(choosingScope
      ? SUGGESTED_KINDS.filter((kind) => kinds.includes(kind))
      : Array.isArray(body.chatKinds) ? body.chatKinds.filter((value): value is string => typeof value === 'string') : []);
    const whole = !choosingScope && body.wholeAccount === true;
    const chats = (Array.isArray(body.chats) ? body.chats : []).flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const chat = entry as Record<string, unknown>;
      if (typeof chat.chatScope !== 'string') return [];
      const title = typeof chat.title === 'string' && chat.title.trim() ? chat.title : 'Chat ' + chat.chatScope.split(':').at(-1);
      return [{ scope: chat.chatScope, title, kind: typeof chat.kind === 'string' ? chat.kind : '', at: typeof chat.lastMessageAt === 'string' ? chat.lastMessageAt : '' }];
    });
    const form = make('form', 'kindpicker'); form.method = 'dialog'; form.dataset.messagingKind = 'scope'; form.dataset.kindPicker = '';
    const switchInput = (name: string, value: string, checked: boolean, label: string): HTMLInputElement => {
      const input = make('input', 'switch'); input.type = 'checkbox'; input.name = name; input.value = value; input.checked = checked;
      input.setAttribute('role', 'switch'); input.setAttribute('aria-label', label);
      return input;
    };
    const allRow = make('label', 'kindrow allrow');
    const allText = make('span', 'kindtext');
    allText.append(make('b', '', 'Read all chats, including new ones'), make('small', '', 'Every chat now and every chat you start or join later'));
    const all = switchInput('wholeAccount', 'true', whole, 'Read all chats, including new ones');
    allRow.append(allText, all);
    form.append(allRow, make('p', 'kindcap', 'Or choose by kind'));
    const groups: { kind: string; toggle?: HTMLInputElement; note: HTMLElement; boxes: HTMLInputElement[]; list: HTMLElement; open: HTMLButtonElement }[] = [];
    const known = new Set(kinds);
    const order = [...kinds, ...(chats.some((chat) => !known.has(chat.kind)) ? ['other'] : [])];
    for (const kind of order) {
      const members = chats.filter((chat) => kind === 'other' ? !known.has(chat.kind) : chat.kind === kind);
      const recent = members.some((chat) => chat.at);
      members.sort((a, b) => recent ? (b.at.localeCompare(a.at) || a.title.localeCompare(b.title)) : a.title.localeCompare(b.title));
      const [label, plural] = CHAT_KIND_LABELS[kind] ?? ['Other chosen chats', 'chats'];
      const group = make('div', 'kindgroup'); group.dataset.kindGroup = kind;
      const row = make('div', 'kindrow');
      const open = make('button', 'kindopen'); open.type = 'button'; open.dataset.kindOpen = ''; open.setAttribute('aria-expanded', 'false');
      const title = make('span', 'kindtext');
      const name = make('b', '', label); name.append(' ', make('span', 'kindcount', String(members.length)));
      const note = make('small', 'kindnote');
      title.append(name, note);
      open.append(title, make('span', 'kindchev', '›'));
      row.append(open);
      const toggle = kind === 'other' ? undefined : switchInput('chatKind', kind, whole || kindsOn.has(kind), `All ${plural}, including new ones`);
      if (toggle) row.append(toggle);
      const list = make('div', 'kindlist'); list.hidden = true;
      const search = make('input', 'kindsearch'); search.type = 'search'; search.placeholder = `Search ${plural}`; search.setAttribute('aria-label', `Search ${plural}`); search.dataset.kindSearch = '';
      list.append(search, make('p', 'kindcap', members.length ? (recent ? 'Most recent first' : 'By name') : `No ${plural} yet. New ones are read when this kind is on.`));
      const lines = make('fieldset', 'kindlines');
      const boxes: HTMLInputElement[] = [];
      for (const chat of members) {
        const line = make('label', 'chatline'); line.dataset.chatTitle = chat.title.toLowerCase();
        const box = make('input'); box.type = 'checkbox'; box.name = 'chatScope'; box.value = chat.scope; box.checked = selected.has(chat.scope);
        boxes.push(box);
        line.append(box, make('span', 'chatname', chat.title), make('span', 'chatwhen', whenLabel(chat.at)));
        lines.append(line);
      }
      list.append(lines);
      group.append(row, list);
      form.append(group);
      groups.push({ kind, ...(toggle ? { toggle } : {}), note, boxes, list, open });
    }
    const refresh = (): void => {
      for (const group of groups) {
        const [, plural] = CHAT_KIND_LABELS[group.kind] ?? ['', 'chats'];
        const on = group.toggle?.checked === true;
        const chosen = group.boxes.filter((box) => box.checked).length;
        const lines = group.list.querySelector<HTMLFieldSetElement>('fieldset');
        if (lines) lines.disabled = on;
        group.note.classList.toggle('partial', !on && chosen > 0);
        group.note.textContent = on ? `All ${plural}, including new ones`
          : !group.toggle ? `${chosen} chosen`
            : chosen > 0 ? `${chosen} of ${group.boxes.length} chosen · new ${plural} are not read` : `Off · new ${plural} are not read`;
      }
    };
    form.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      // Read all switches every kind on; turning a kind off leaves Read all.
      if (target === all && all.checked) for (const group of groups) if (group.toggle) group.toggle.checked = true;
      if (target.name === 'chatKind' && !target.checked) all.checked = false;
      if (target.name === 'chatScope' && !target.checked) all.checked = false;
      refresh();
    });
    form.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      if (!target.matches('[data-kind-search]')) return;
      const words = target.value.trim().toLowerCase();
      target.closest('.kindlist')?.querySelectorAll<HTMLElement>('.chatline').forEach((line) => { line.hidden = !!words && !(line.dataset.chatTitle ?? '').includes(words); });
    });
    form.addEventListener('click', (event) => {
      const open = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-kind-open]');
      if (!open) return;
      const group = groups.find((candidate) => candidate.open === open);
      if (!group) return;
      group.list.hidden = !group.list.hidden;
      open.setAttribute('aria-expanded', String(!group.list.hidden));
      if (!group.list.hidden) group.list.querySelector<HTMLInputElement>('[data-kind-search]')?.focus();
    });
    refresh();
    if (body.coverage === 'contacts_and_joined_groups') form.append(make('p', 'hint', 'The list shows saved contacts and groups and may omit unsaved chats. A chat that is not listed is still read when its kind is on.'));
    form.append(make('p', 'hint kindprivacy', 'Choosing chats never decides privacy. Every message is still judged on its own.'));
    const bar = make('div', 'pickbar kindsave');
    const save = make('button', 'btn primary', 'Save'); save.type = 'submit';
    bar.append(make('span', 'hint', choosingScope ? 'Nothing is read until you press Save' : 'Changes save when you press Save'), save);
    form.append(bar);
    return form;
  }

  async function openMessagingControls(form: HTMLFormElement): Promise<void> {
    if (pendingForms.has(form)) return;
    if (!options.transport.openLocalControls) { say(form, 'Open this dashboard in a browser on this computer.'); return; }
    pendingForms.add(form);
    say(form, 'Opening controls…');
    try {
      if (await options.transport.openLocalControls()) options.navigate(options.returnUrl);
      else say(form, 'Could not open controls. Open this dashboard in a browser on this computer and try again.');
    } catch { say(form, 'Could not open controls. Open this dashboard in a browser on this computer and try again.'); }
    finally { pendingForms.delete(form); }
  }

  function onSubmit(event: Event): void {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || !root.contains(form)) return;
    if (form.hasAttribute('data-messaging-open-controls')) {
      event.preventDefault();
      void openMessagingControls(form);
      return;
    }
    if (form.hasAttribute('data-messaging-kind')) {
      event.preventDefault();
      submitMessaging(form);
      return;
    }
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
      '[data-connect-kind],[data-model-check],[data-first-run-privacy],[data-computer-use],[data-judge-choice],[data-model-choice],[data-source-action],[data-local-models-discover],[data-local-models-test],[data-settings-proposal]',
    )) return;
    event.preventDefault();
    // Every control form records what it submitted: the answer may only
    // replace input that has not changed since, whatever the action.
    const submittedValues = formRecord(form);
    submittedFormValues.set(form, submittedValues);
    const tab = form.dataset.connectKind === 'oauth' ? openAuthorizationTab() : null;
    void submitControl(form, tab, submittedValues);
  }

  function showSetupFailure(form: HTMLFormElement, message: string): void {
      const setup = form.closest<HTMLElement>('[data-setup-steps]');
      const step = message.includes('Redo the Set up your account step') ? 0 : message.includes('Redo the Create an API key step') ? 1 : -1;
      if (setup && form.querySelector('[data-client-file-drop]')) {
        const panels = Array.from(setup.querySelectorAll<HTMLElement>('[data-setup-panel]'));
        showSetupStep(setup, panels.length - 1);
        const error = document.createElement('div'); error.dataset.setupError = '';
        const banner = document.createElement('p'); banner.className = 'why'; banner.setAttribute('role', 'alert'); banner.textContent = message;
        const details = document.createElement('details'); details.className = 'howto';
        const summary = document.createElement('summary'); summary.textContent = 'How to fix';
        const hint = document.createElement('p'); hint.textContent = 'Check the app settings in Google Cloud, then choose the Desktop app file again or paste the ID and secret.';
        details.append(summary, hint); error.append(banner, details);
        form.querySelector('[data-client-file-drop]')!.after(error);
        return;
      }
      if (setup) {
        const panels = Array.from(setup.querySelectorAll<HTMLElement>('[data-setup-panel]'));
        const current = panels.findIndex(panel => !panel.hidden);
        panels.forEach(panel => { panel.hidden = true; });
        const actions = setup.querySelector<HTMLElement>('[data-setup-actions]');
        if (actions) actions.hidden = true;
        setup.querySelector('[data-setup-error]')?.remove();
        const error = document.createElement('div');
        error.dataset.setupError = '';
        const banner = document.createElement('p');
        banner.className = 'why'; banner.setAttribute('role', 'alert'); banner.textContent = message;
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'btn'; retry.dataset.setupRetry = String(step >= 0 ? step : Math.max(0, current));
        retry.textContent = step === 0 ? 'Go to account and credit' : step === 1 ? 'Go to API key' : 'Try again';
        const details = document.createElement('details'); details.className = 'howto';
        const summary = document.createElement('summary'); summary.textContent = 'How to fix';
        const hint = document.createElement('p'); hint.textContent = 'Return to setup, check the app settings and add the key again. Your login code and password are never shown here.';
        details.append(summary, hint); error.append(banner, details, retry); setup.append(error); retry.focus();
      }
  }

  async function readClientFile(form: HTMLFormElement, file: File | undefined): Promise<void> {
    const revision = form.querySelector<HTMLInputElement>('[name="client_file_revision"]');
    const status = form.querySelector<HTMLElement>('[data-client-file-status]');
    if (!revision || !status || !file) return;
    uploadedClientFiles.delete(form);
    try {
      if (file.size > 64 * 1024) throw new Error();
      const text = await file.text();
      const app = JSON.parse(text)?.installed;
      if (!app || typeof app.client_id !== 'string' || typeof app.client_secret !== 'string' || !app.client_id.endsWith('.apps.googleusercontent.com') || !app.client_secret.trim()) throw new Error();
      uploadedClientFiles.set(form, text);
      revision.value = String(Number(revision.value) + 1);
      for (const field of Array.from(form.querySelectorAll<HTMLInputElement>('[name="client_id"], [name="client_secret"]'))) { field.value = ''; field.disabled = true; field.dataset.olympusOriginallyDisabled = 'true'; }
      status.textContent = 'Desktop app file ready. Connect to check the key with Google.';
    } catch {
      status.textContent = '';
      showSetupFailure(form, 'Choose the JSON downloaded for a Desktop app in Google Cloud Clients. Web app keys cannot use this flow.');
      for (const field of Array.from(form.querySelectorAll<HTMLInputElement>('[name="client_id"], [name="client_secret"]'))) { field.disabled = false; field.dataset.olympusOriginallyDisabled = 'false'; }
    }
    const picker = form.querySelector<HTMLInputElement>('[data-client-file]');
    if (picker) picker.value = '';
  }

  function onClientFileKeydown(event: Event): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const key = (event as KeyboardEvent).key;
    if (target?.matches('[data-client-file-drop]') && (key === 'Enter' || key === ' ')) {
      event.preventDefault();
      target.querySelector<HTMLInputElement>('[data-client-file]')?.click();
    }
  }

  function onClientFileChange(event: Event): void {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (input?.matches('[data-client-file]') && input.form) void readClientFile(input.form, input.files?.[0]);
  }
  function onClientFileDrop(event: Event): void {
    const zone = event.target instanceof Element ? event.target.closest('[data-client-file-drop]') : null;
    if (!zone) return;
    event.preventDefault();
    const form = zone.closest('form');
    if (form && event.type === 'drop') void readClientFile(form, (event as DragEvent).dataTransfer?.files[0]);
  }

  function onClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    const fileZone = target.closest('[data-client-file-drop]');
    if (fileZone && !target.matches('[data-client-file]')) {
      fileZone.querySelector<HTMLInputElement>('[data-client-file]')?.click();
      return;
    }
    const messagingRetry = target.closest('[data-messaging-retry]');
    if (messagingRetry) {
      const sheet = messagingRetry.closest('[data-messaging-setup]');
      const intro = sheet?.querySelector<HTMLElement>('[data-messaging-setup-intro]');
      if (intro) intro.hidden = false;
      sheet?.querySelector('[data-pairing-error]')?.remove();
      const status = sheet?.querySelector<HTMLElement>('[data-messaging-status]');
      if (status) status.textContent = '';
      return;
    }
    if (target.closest('[data-client-paste] summary')) {
      const form = target.closest('form');
      if (form) uploadedClientFiles.delete(form);
      const fileStatus = form?.querySelector<HTMLElement>('[data-client-file-status]');
      if (fileStatus) fileStatus.textContent = '';
      form?.querySelectorAll<HTMLInputElement>('[name="client_id"], [name="client_secret"]').forEach(field => { field.disabled = false; field.dataset.olympusOriginallyDisabled = 'false'; });
    }
    const begin = target.closest('[data-setup-begin]');
    if (begin) {
      const sheet = begin.closest('.sheet');
      const walkthrough = sheet?.querySelector<HTMLElement>('[data-setup-walkthrough]');
      if (walkthrough) {
        walkthrough.hidden = false;
        const heading = walkthrough.querySelector<HTMLElement>('h2, h4');
        if (heading) { heading.tabIndex = -1; heading.focus(); }
      }
      const choice = sheet?.querySelector<HTMLElement>('[data-setup-choice]');
      if (choice) choice.hidden = true;
      const sharedNote = sheet?.querySelector<HTMLElement>('[data-shared-app-note]');
      if (sharedNote) sharedNote.hidden = true;
      const lead = sheet?.querySelector<HTMLElement>('[data-setup-lead]');
      if (lead) lead.hidden = true;
      return;
    }
    if (target.closest('[data-first-run-done],[data-first-run-keys]')) {
      firstRunChoice = undefined;
      query('[data-first-run-sheet]')?.remove();
      void refreshNow(false, true);
      return;
    }
    if (target.closest('[data-first-run-redo]')) {
      const steps = query<HTMLElement>('[data-first-run-sheet] [data-setup-steps]');
      if (steps) showSetupStep(steps, 1);
      return;
    }
    if (target.closest('[data-connect-retry]')) {
      const sheet = target.closest('.sheet');
      const error = sheet?.querySelector<HTMLElement>('[data-connect-error]');
      const content = sheet?.querySelector<HTMLElement>('[data-connect-content]');
      if (error) error.hidden = true;
      if (content) {
        content.hidden = false;
        const steps = content.querySelector<HTMLElement>('[data-setup-steps]');
        if (steps) showSetupStep(steps, 0);
      }
      return;
    }
    const setupOpen = target.closest<HTMLElement>('[data-setup-open]');
    if (setupOpen) {
      const url = setupOpen.dataset.setupOpen;
      if (url && !openAuthorizationExternally(url)) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const setupControl = target.closest<HTMLElement>('[data-setup-next], [data-setup-back], [data-setup-retry], [data-setup-jump]');
    if (setupControl) {
      const sheet = setupControl.closest<HTMLElement>('[data-setup-steps]');
      if (!sheet) return;
      const panels = Array.from(sheet.querySelectorAll<HTMLElement>(':scope > [data-setup-panel]'));
      const current = panels.findIndex(panel => !panel.hidden);
      const next = Math.max(0, Math.min(panels.length - 1, setupControl.hasAttribute('data-setup-retry') ? Number(setupControl.dataset.setupRetry) : setupControl.hasAttribute('data-setup-jump') ? Number(setupControl.dataset.setupJump) : current + (setupControl.hasAttribute('data-setup-next') ? 1 : -1)));
      showSetupStep(sheet, next);
      return;
    }
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
      if (open && form && !form.closest('[hidden]') && (canWrite || csrfToken) && !startedFromSheet.has(form)
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
   * A dialog that an address can open (`dialog[data-open-hash]`): Sources'
   * Build a connector, which the old `?connector` page redirects to as
   * `?connect#build-connector` (#1087). The fragment is cleared at once, so a
   * reload or a close does not open it again.
   */
  function applyOpenHash(): void {
    const view = root.ownerDocument.defaultView;
    const id = view ? view.location.hash.slice(1) : '';
    if (!view || !/^[A-Za-z0-9_-]+$/.test(id)) return;
    const dialog = root.querySelector<HTMLDialogElement>(`dialog[data-open-hash][id="${id}"]`);
    if (!dialog || typeof dialog.showModal !== 'function') return;
    try {
      view.history.replaceState(null, '', view.location.pathname + view.location.search);
    } catch {
      // An unchangeable history keeps the fragment; the dialog still opens.
    }
    if (!dialog.open) dialog.showModal();
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
      'connect.evernote': 'evernote.notes',
      'dropbox.permissions': 'dropbox.files',
    };
    let focus: HTMLElement | null = null;
    const sourceId = Object.prototype.hasOwnProperty.call(sources, wanted) ? sources[wanted] : undefined;
    if (sourceId) {
      const row = queryAll<HTMLElement>('[data-source-id]').find((candidate) => candidate.dataset.sourceId === sourceId);
      // On Sources a source's setup sits in Add a source: open it there first.
      // A connected Telegram or WhatsApp card sits in its pairing dialog instead.
      const addSheet = row?.closest<HTMLDialogElement>('dialog');
      if (row && addSheet && typeof addSheet.showModal === 'function') {
        if (addSheet.matches('[data-add-source]')) showSourceSetup(addSheet, row.closest<HTMLElement>('[data-source-setup]')?.dataset.sourceSetup);
        if (!addSheet.open) addSheet.showModal();
      }
      if (row) {
        const toggle = row.querySelector<HTMLElement>('[data-sheet-toggle]');
        const selector = toggle ? toggle.dataset.sheetToggle || '' : '';
        const sheet = /^#[A-Za-z0-9_-]+$/.test(selector) ? query<HTMLElement>(selector) : null;
        if (sheet) {
          queryAll<HTMLElement>('.sheet.on').forEach((other) => { if (other !== sheet) setSheetOpen(other, false); });
          setSheetOpen(sheet, true);
          if (wanted === 'dropbox.permissions') {
            const walkthrough = sheet.querySelector<HTMLElement>('[data-setup-steps]');
            const panels = walkthrough ? Array.from(walkthrough.querySelectorAll<HTMLElement>('[data-setup-panel]')) : [];
            if (walkthrough && panels.length > 2) {
              const error = sheet.querySelector<HTMLElement>('[data-connect-error]');
              const content = sheet.querySelector<HTMLElement>('[data-connect-content]');
              if (error) error.hidden = true;
              if (content) content.hidden = false;
              showSetupStep(walkthrough, 2);
              const disclosure = walkthrough.closest('details');
              if (disclosure) disclosure.open = true;
            }
          }
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
    view.setTimeout(() => landed.classList.remove('landed'), landedHighlightMs);
    if (typeof focus.scrollIntoView === 'function') focus.scrollIntoView({ block: 'center' });
    focus.focus();
  }

  // Sorting choice: picking the card not in use opens its confirmation
  // dialog; Cancel, Esc or a backdrop close puts the choice back.
  const judgeDialog = (form: HTMLFormElement, pick: string): HTMLDialogElement | null =>
    form.querySelector<HTMLDialogElement>(`dialog[data-judge-dialog="${pick}"]`);
  const resetJudge = (dialog: HTMLDialogElement): void => {
    const form = dialog.closest<HTMLFormElement>('form[data-judge-choice]');
    if (dialog.open) dialog.close();
    const current = form?.dataset.judgeCurrent;
    const radio = current ? form?.querySelector<HTMLInputElement>(`input[name="choice"][value="${current}"]`) : null;
    if (radio) radio.checked = true;
  };
  const echoJudgeCap = (form: HTMLFormElement, scope: ParentNode): void => {
    const value = Number(form.querySelector<HTMLInputElement>('input[name="cap_dollars"]')?.value.trim() || NaN);
    const text = Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'not set';
    scope.querySelectorAll<HTMLElement>('[data-judge-cap-echo]').forEach(echo => { echo.textContent = text; });
  };
  const onJudgeCapInput = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'cap_dollars') return;
    const form = input.closest<HTMLFormElement>('form[data-judge-choice]');
    if (form) echoJudgeCap(form, form);
  };
  const onJudgePick = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'choice') return;
    const form = input.closest<HTMLFormElement>('form[data-judge-choice]');
    if (!form || !input.checked) return;
    // An unset limit follows the picked choice: its own estimate plus 25% (#884).
    const cap = form.querySelector<HTMLInputElement>('input[name="cap_dollars"][data-cap-auto="true"]');
    const auto = input.value === 'venice' ? cap?.dataset.capVenice : input.value === 'local-then-venice' ? cap?.dataset.capLocalThenVenice : undefined;
    if (cap && auto) cap.value = auto;
    if (input.value === form.dataset.judgeCurrent) return;
    const dialog = judgeDialog(form, input.value);
    // The confirmation states the limit that will be sent: the field's current value.
    if (dialog) echoJudgeCap(form, dialog);
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  };
  const onJudgeDialogClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const cancel = target?.closest('[data-judge-cancel]');
    // A click on the backdrop lands on the dialog itself, outside its box.
    const outside = (dialog: HTMLDialogElement): boolean => {
      const box = dialog.getBoundingClientRect(); const at = event as MouseEvent;
      return box.width > 0 && (at.clientX < box.left || at.clientX > box.right || at.clientY < box.top || at.clientY > box.bottom);
    };
    const dialog = cancel?.closest('dialog') ?? (target instanceof HTMLDialogElement && target.matches('[data-judge-dialog]') && outside(target) ? target : null);
    if (dialog instanceof HTMLDialogElement) { event.preventDefault(); resetJudge(dialog); }
  };
  const onJudgeDialogCancel = (event: Event): void => {
    const dialog = event.target;
    if (dialog instanceof HTMLDialogElement && dialog.matches('[data-judge-dialog]')) { event.preventDefault(); resetJudge(dialog); }
  };

  // Add a model: a dialog over Privacy rules; ✕, Esc or a click outside closes it.
  const onAddModelClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const open = target?.closest<HTMLElement>('[data-add-model-open]');
    if (open) {
      const provider = open.dataset.addModelOpen ?? '';
      const dialog = open.closest('.pickrow')?.querySelector<HTMLDialogElement>(`dialog[data-add-model="${provider}"]`);
      if (!dialog || typeof dialog.showModal !== 'function' || dialog.open) return;
      dialog.showModal();
      if (provider === 'venice') void loadAddableModels(dialog);
      return;
    }
    const close = target?.closest('[data-dialog-close]')?.closest('dialog');
    if (close instanceof HTMLDialogElement) { close.close(); return; }
    if (target instanceof HTMLDialogElement && target.matches('[data-add-model]')) {
      const box = target.getBoundingClientRect(); const at = event as MouseEvent;
      if (box.width > 0 && (at.clientX < box.left || at.clientX > box.right || at.clientY < box.top || at.clientY > box.bottom)) target.close();
    }
  };
  const loadAddableModels = async (dialog: HTMLDialogElement): Promise<void> => {
    const slot = dialog.querySelector<HTMLElement>('[data-addable-models]');
    if (!slot || slot.dataset.loaded === 'true') return;
    let result: OlympusDashboardControlResult;
    try { result = await options.transport.control({ action: 'list_addable_models', provider: 'venice' }); } catch { result = { status: 0, body: {} }; }
    const models = Array.isArray(result.body.models) ? result.body.models.filter((entry): entry is string => typeof entry === 'string') : [];
    slot.replaceChildren();
    if (result.status < 200 || result.status >= 300 || models.length === 0) {
      const line = document.createElement('p'); line.className = 'pnote'; line.setAttribute('role', 'status');
      line.textContent = models.length === 0 && result.status === 200 ? 'Venice listed no private models just now. Try again later.' : 'Olympus could not reach Venice. Try again later.';
      slot.append(line);
      return;
    }
    slot.dataset.loaded = 'true';
    for (const id of models) {
      const label = document.createElement('label'); label.className = 'pickopt';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'model'; radio.value = id;
      const name = document.createElement('b'); name.textContent = id;
      label.append(radio, ' ', name); slot.append(label);
    }
  };
  // Sources: [data-dialog-open="id"] opens a dialog (confirmations, Add a
  // source); in Add a source a tile shows that source's setup, Back the
  // catalog again, and the search box filters the tiles.
  function showSourceSetup(sheet: HTMLElement, sourceId: string | undefined): void {
    const grid = sheet.querySelector<HTMLElement>('[data-source-catalog]');
    sheet.querySelectorAll<HTMLElement>('[data-source-setup]').forEach((panel) => { panel.hidden = panel.dataset.sourceSetup !== sourceId; });
    if (grid) grid.hidden = sourceId !== undefined;
  }
  const onSourcesClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const opener = target?.closest<HTMLElement>('[data-dialog-open]');
    if (opener) {
      const id = opener.dataset.dialogOpen ?? '';
      const dialog = /^[A-Za-z0-9_-]+$/.test(id) ? root.querySelector<HTMLDialogElement>(`dialog[id="${id}"]`) : null;
      if (!dialog || typeof dialog.showModal !== 'function') return;
      if (dialog.matches('[data-add-source]')) showSourceSetup(dialog, opener.dataset.sourceOpen);
      if (!dialog.open) dialog.showModal();
      return;
    }
    const pick = target?.closest<HTMLElement>('[data-source-pick]');
    const sheet = pick?.closest<HTMLElement>('[data-add-source]');
    if (pick && sheet) { showSourceSetup(sheet, pick.dataset.sourcePick); return; }
    const back = target?.closest<HTMLElement>('[data-source-back]')?.closest<HTMLElement>('[data-add-source]');
    if (back) { showSourceSetup(back, undefined); return; }
    if (target instanceof HTMLDialogElement && target.matches('[data-closable]')) {
      const box = target.getBoundingClientRect(); const at = event as MouseEvent;
      if (box.width > 0 && (at.clientX < box.left || at.clientX > box.right || at.clientY < box.top || at.clientY > box.bottom)) target.close();
    }
  };
  const onSourceSearch = (event: Event): void => {
    const input = event.target instanceof HTMLInputElement && event.target.matches('[data-source-search]') ? event.target : null;
    const sheet = input?.closest<HTMLElement>('[data-add-source]');
    if (!input || !sheet) return;
    const words = input.value.trim().toLowerCase();
    sheet.querySelectorAll<HTMLElement>('[data-source-pick]').forEach((tile) => { tile.hidden = words !== '' && !(tile.textContent ?? '').toLowerCase().includes(words); });
  };
  // `close` does not bubble, so listen in the capture phase.
  const onDialogClose = (event: Event): void => {
    if (event.target instanceof HTMLDialogElement && !query('dialog[open]')) void refreshNow(false);
  };
  root.addEventListener('close', onDialogClose, true);
  root.addEventListener('click', onSourcesClick);
  root.addEventListener('input', onSourceSearch);
  root.addEventListener('click', onAddModelClick);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onJudgePick);
  root.addEventListener('input', onJudgeCapInput);
  root.addEventListener('click', onJudgeDialogClick);
  root.addEventListener('cancel', onJudgeDialogCancel, true);
  root.addEventListener('change', onClientFileChange);
  root.addEventListener('keydown', onClientFileKeydown);
  root.addEventListener('dragover', onClientFileDrop);
  root.addEventListener('drop', onClientFileDrop);
  // Coming back from the approval browser or tab is the moment the exchange
  // may have just landed: one authoritative read, and only while this
  // controller still owes the owner an answer about a start it performed.
  const refreshOnReturn = (): void => {
    if (disposed || options.signal.aborted || !awaitingAuthorizationReturn) return;
    awaitingAuthorizationReturn = false;
    authorizationWait = undefined;
    void refreshNow(false, true);
  };
  const onVisibilityReturn = (): void => {
    if (root.ownerDocument.visibilityState !== 'visible') return;
    refreshOnReturn();
  };
  const view = root.ownerDocument.defaultView || window;
  view.addEventListener('focus', refreshOnReturn);
  root.ownerDocument.addEventListener('visibilitychange', onVisibilityReturn);
  root.addEventListener(redrawEvent, onRedrawRequest);
  applyWriteCapability();
  applyOpenTarget();
  applyOpenHash();
  restartPoll();
  resumeMessaging();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    messagingTimers.forEach(timer => clearTimeout(timer));
    messagingTimers.clear();
    queryAll<HTMLInputElement>('[data-messaging-input] input').forEach(input => { input.value = ''; });
    queryAll<HTMLImageElement>('[data-messaging-qr]').forEach(qr => { qr.removeAttribute('src'); qr.hidden = true; });
    if (interval) clearInterval(interval);
    view.removeEventListener('focus', refreshOnReturn);
    root.ownerDocument.removeEventListener('visibilitychange', onVisibilityReturn);
    root.removeEventListener('click', onAddModelClick);
    root.removeEventListener('close', onDialogClose, true);
    root.removeEventListener('click', onSourcesClick);
    root.removeEventListener('input', onSourceSearch);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onJudgePick);
    root.removeEventListener('input', onJudgeCapInput);
    root.removeEventListener('click', onJudgeDialogClick);
    root.removeEventListener('cancel', onJudgeDialogCancel, true);
    root.removeEventListener('change', onClientFileChange);
    root.removeEventListener('keydown', onClientFileKeydown);
    root.removeEventListener('dragover', onClientFileDrop);
    root.removeEventListener('drop', onClientFileDrop);
    root.removeEventListener(redrawEvent, onRedrawRequest);
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
