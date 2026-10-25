/**
 * The crawl of the dashboard's other pages (scripts/release-check/explore-pages.ts) against a small stateful page in a DOM: each
 * control is pressed by itself from a fresh load, the ones that ask first are answered both ways, links to other sites are validated and
 * not followed, the ones a throwaway machine must not press are named, and each rule fails the run when it is broken. The inventory is
 * read from the product's real templates.
 */
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { explorePages, inboxAnswers, matches, pagesChecks, type PageDef, type PageControl, type PagesOptions } from '../scripts/release-check/explore-pages.ts';
import { buildPageInventory, scanControls } from '../scripts/release-check/explore-pages-inventory.ts';
import type { ElementInfo, JourneyDriver, PageEvents } from '../scripts/release-check/journey.ts';
import { PROBE_SOURCE, type WireTarget } from '../scripts/release-check/probe.ts';
import { pagesSection } from '../scripts/release-check/report.ts';

function evalIn(window: Window, code: string): unknown {
  const globals = window as unknown as { __rc?: unknown };
  return new Function('window', 'document', 'getComputedStyle', 'NodeFilter', '__rc', 'location', 'sessionStorage', `return (${code});`)(window, window.document, window.getComputedStyle.bind(window), (window as any).NodeFilter, globals.__rc, window.location, window.sessionStorage);
}

interface State {
  connections: string[];
  secret: string;
  sheetOpen: boolean;
  locked: boolean;
  /** Pairing code makes nothing. */
  noCode?: boolean;
  /** Revoke goes ahead without asking. */
  noQuestion?: boolean;
  /** Revoke ignores the answer. */
  ignoresCancel?: boolean;
  /** A button that does nothing at all. */
  deadButton?: boolean;
  /** The pairing button logs a console error. */
  logs?: boolean;
  /** The link to another site is plain http. */
  httpLink?: boolean;
  /** A disabled button with no reason. */
  silentDisabled?: boolean;
  /** A disabled button marked busy ("Checking…"), which says what it is doing in its own words. */
  busyDisabled?: boolean;
  /** A row whose name says how long ago it came ("· 3m ago"), a minute older on each load, as the Inbox's rows are. */
  agedRow?: boolean;
  loads?: number;
  agedRead?: boolean;
  /** An unnamed field. */
  unnamedField?: boolean;
  /** Reload keeps the confirmation record (a full page load clears window state). */
  reloadsOnRevoke?: boolean;
  /** The Build a connector page has no Lock, as in the product. */
  noLockOnConnector?: boolean;
  /** A closed section and an open one, each holding a button (the box stub gives both a box, as Chrome does). */
  sections?: boolean;
  /** A closed section whose summary reloads the page (it comes back open), holding a button that asks before it acts. */
  reloadingSection?: boolean;
  zkOpen?: boolean;
  zkAdded?: boolean;
  /** Sections inside sections, as the agent picker has (Connect an agent, an agent, Add it yourself instead), each opened by its summary. */
  nested?: boolean;
  nestedOpen?: number;
  deepPressed?: boolean;
  /** A sign-in button that keeps a blank tab while its address comes, as the product does, then sends it on to the provider, leaves it blank, or closes it. */
  signInTab?: 'provider' | 'blank' | 'closes';
  /** The Ask form: the local model answers on the machine, Venice sends the question out. */
  ask?: boolean;
  asked?: string;
}

class PagesDriver implements JourneyDriver {
  readonly host = new Window({ url: 'http://127.0.0.1:8010/dashboard?agents' });
  events: PageEvents = { console: [], requests: [] };
  state: State = { connections: [], secret: '', sheetOpen: false, locked: false };
  pressed: string[] = [];
  path = '/dashboard?agents';
  /** A tab the page opens: one that has gone on to another site no longer lets the page read where it is, as in a browser. A load starts from this one again. */
  private readonly windowOpen = () => {
    const tab = { closed: false, gone: false, get location() { if (tab.gone) throw new Error('SecurityError: cross-origin'); return { href: 'about:blank' }; } };
    return tab;
  };
  constructor(initial: Partial<State> = {}) {
    Object.assign(this.state, initial);
    (this.host as any).open = this.windowOpen;
    (this.host.Element.prototype as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = function (this: any) {
      const hidden = this.hasAttribute?.('hidden') || this.closest?.('[hidden]');
      return hidden ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } : { left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34 };
    };
  }
  private render(): void {
    const s = this.state;
    const rows = s.connections.map((name) => `<li>${name} <form class="rowform" data-agent-kind="revoke" data-confirmation="Revoke ${name}?"><button class="btn" type="submit">Revoke</button></form></li>`).join('');
    const secret = `<input data-agent-secret type="text" readonly aria-label="Pairing code" value="${s.secret}">`;
    this.host.document.body.innerHTML = `<main>
      <h1>Agents</h1>
      <a href="/dashboard">Olympus</a>
      <a href="${s.httpLink ? 'http' : 'https'}://example.com/keys" target="_blank" rel="noopener noreferrer">Get a key</a>
      <form class="rowform" data-agent-kind="pair"><button class="btn" type="submit">Get pairing code</button></form>
      <form class="rowform" data-agent-kind="key"><input type="text" name="name" value="My agent" required aria-label="Connection name"><button class="btn" type="submit">Create key</button></form>
      <form class="rowform" data-connect-kind="api_key"><input ${s.unnamedField ? '' : 'aria-label="API key"'} type="password" name="api_key" required><button class="btn" type="submit">Connect</button></form>
      <form class="rowform" data-agent-kind="remote-on"><button class="btn" type="submit">Turn on remote access</button></form>
      <button type="button" class="btn" aria-expanded="${s.sheetOpen}" data-sheet-toggle="#sheet">Get opening link</button>
      <div id="sheet" ${s.sheetOpen ? '' : 'hidden'}><p>Paste this into your agent.</p><button type="button" class="btn" data-copy-target="#sheet">Copy prompt</button></div>
      ${s.deadButton ? '<button type="button" class="btn">Check readiness</button>' : ''}
      ${s.silentDisabled ? '<button type="button" class="btn" disabled>Wait</button>' : ''}
      ${s.busyDisabled ? '<button type="button" class="btn" disabled aria-busy="true">Checking…</button>' : ''}
      ${s.agedRow ? `<button type="button" class="btn" data-aged>What is due? · ${s.loads ?? 0}m ago</button>${s.agedRead ? '<p>Read.</p>' : ''}` : ''}
      ${s.sections ? '<details><summary>Add it yourself instead</summary><button type="button" class="btn">Copy the address</button></details><details open><summary>Advanced</summary><button type="button" class="btn">Show advanced</button></details>' : ''}
      ${s.reloadingSection ? `<details data-zk-section ${s.zkOpen ? 'open' : ''}><summary>Set up zkAPI</summary><button type="button" class="btn" data-zk-add>Add zkAPI to Olympus</button>${s.zkAdded ? '<p>zkAPI added.</p>' : ''}</details>` : ''}
      ${s.signInTab ? '<button type="button" class="btn" data-sign-in>Connect Drive</button>' : ''}
      ${s.nested ? `<details data-level="1" ${(s.nestedOpen ?? 0) >= 1 ? 'open' : ''}><summary>Level one</summary><details data-level="2" ${(s.nestedOpen ?? 0) >= 2 ? 'open' : ''}><summary>Level two</summary><details data-level="3" ${(s.nestedOpen ?? 0) >= 3 ? 'open' : ''}><summary>Level three</summary><button type="button" class="btn" data-deep>Deep button</button>${s.deepPressed ? '<p>Deep button pressed.</p>' : ''}</details></details></details>` : ''}
      ${s.ask ? `<form data-pa-ask><textarea name="question" aria-label="Your question"></textarea><button type="submit" data-pa-destination="computer" data-pa-action="ask_computer">Ask the local model</button><button type="submit" data-pa-destination="venice" data-pa-action="ask_venice">Ask Venice</button>${s.asked ? `<p>${s.asked}</p>` : ''}</form>` : ''}
      ${s.secret ? secret : ''}
      <ul>${rows}</ul>
      ${s.noLockOnConnector && this.path.endsWith('connector') ? '' : s.locked ? '<form data-control-session-kind="unlock"><button type="submit">Unlock</button></form>' : '<form data-control-session-kind="lock"><button type="submit">Lock</button></form>'}
    </main>`;
    evalIn(this.host, PROBE_SOURCE);
    const on = (selector: string, handler: (el: Element) => void): void => {
      for (const el of Array.from(this.host.document.querySelectorAll(selector))) el.addEventListener('click', ((event: { preventDefault(): void }) => { event.preventDefault(); handler(el as unknown as Element); }) as never);
    };
    on('form[data-agent-kind="pair"] button', () => {
      this.pressed.push('pair');
      if (this.state.logs) this.events.console.push('TypeError: x is not a function');
      if (!this.state.noCode) this.state.secret = 'PAIR-1234';
      this.render();
    });
    on('form[data-agent-kind="key"] button', () => { this.pressed.push('key'); this.state.connections.push(`agent-${this.state.connections.length + 1}`); this.state.secret = 'KEY-5678'; this.render(); });
    on('form[data-connect-kind="api_key"] button', () => {
      const form = this.host.document.querySelector('form[data-connect-kind="api_key"]') as any;
      if (!form.checkValidity()) return;
      this.events.requests.push({ url: '/dashboard/connect/api-key', status: 500, text: 'POST /dashboard/connect/api-key -> 500' });
    });
    on('[data-sheet-toggle]', () => { this.state.sheetOpen = !this.state.sheetOpen; this.render(); });
    on('form[data-agent-kind="remote-on"] button', () => { this.pressed.push('remote-on'); });
    on('form[data-agent-kind="revoke"] button', (el) => {
      this.pressed.push('revoke');
      const win = this.host as unknown as { confirm(text: string): boolean };
      const name = el.closest('li')!.textContent!.trim().split(' ')[0]!;
      const yes = this.state.noQuestion ? true : win.confirm(`Revoke ${name}?`);
      if (yes || this.state.ignoresCancel) this.state.connections = this.state.connections.filter((known) => known !== name);
      this.render();
    });
    on('[data-zk-section] > summary', () => {
      // The section redraws itself with a page load: it comes back open, and the page's own window state (the hooks) is new.
      this.state.zkOpen = true;
      delete (this.host as any).__rcConfirms;
      delete (this.host as any).__rcOpened;
      (this.host as any).open = this.windowOpen;
      (this.host as any).__rc = undefined;
      (this.host as any).confirm = (text: string) => { this.events.console.push(`a browser dialog opened (confirm): ${text}`); return false; };
      this.render();
    });
    on('[data-zk-add]', () => {
      const win = this.host as unknown as { confirm(text: string): boolean };
      if (win.confirm('This adds zkAPI. Continue?')) this.state.zkAdded = true;
      this.render();
    });
    for (const level of [1, 2, 3]) on(`details[data-level="${level}"] > summary`, () => { this.state.nestedOpen = level; this.render(); });
    on('[data-deep]', () => { this.state.deepPressed = true; this.render(); });
    on('[data-aged]', () => { this.state.agedRead = true; this.render(); });
    on('[data-sign-in]', () => {
      const tab = (this.host as any).open('', '_blank');
      if (this.state.signInTab === 'provider') tab.gone = true;
      if (this.state.signInTab === 'closes') tab.closed = true;
    });
    on('form[data-control-session-kind="lock"] button', () => { this.pressed.push('lock'); this.state.locked = true; this.render(); });
    on('button[data-copy-target]', () => { this.pressed.push('copy'); });
    on('[data-pa-destination]', (el) => { this.pressed.push(`ask:${el.getAttribute('data-pa-destination')}`); this.state.asked = 'Answering…'; this.render(); });
    on('a[href="/dashboard"]', () => { this.path = '/dashboard'; this.host.happyDOM.setURL('http://127.0.0.1:8010/dashboard'); });
    on('button:not([type]), button[type="button"]:not([data-sheet-toggle]):not([data-copy-target])', () => { this.pressed.push('other'); });
  }
  async hasPanel(): Promise<boolean> { return false; }
  async probe(_frame: 'host' | 'panel', call: string): Promise<unknown> { return evalIn(this.host, call); }
  async click(_frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const info = evalIn(this.host, `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (!info) return null;
    if (!info.disabled) evalIn(this.host, `__rc.element(${JSON.stringify(target)}).click()`);
    return info;
  }
  async type(): Promise<boolean> { return false; }
  async open(): Promise<void> { this.reset(); }
  async go(path: string): Promise<void> { this.path = path; this.host.happyDOM.setURL(`http://127.0.0.1:8010${path}`); this.reset(); }
  async reload(): Promise<void> { this.reset(); }
  private reset(): void {
    this.state.sheetOpen = false;
    this.state.zkOpen = false;
    this.state.nestedOpen = 0;
    this.state.secret = '';
    this.state.loads = (this.state.loads ?? 0) + 1;
    this.state.agedRead = false;
    delete this.state.asked;
    (this.host as unknown as { sessionStorage: Storage }).sessionStorage.clear();
    delete (this.host as any).__rcConfirms;
    delete (this.host as any).__rcOpened;
    (this.host as any).open = this.windowOpen;
    this.host.document.body.innerHTML = '';
    (this.host as any).__rc = undefined;
    this.render();
  }
  async setViewport(): Promise<void> {}
  async where(): Promise<string> { return this.path; }
  async pages(): Promise<number> { return 1; }
  async screenshot(): Promise<boolean> { return true; }
  drainEvents(): PageEvents { const out = this.events; this.events = { console: [], requests: [] }; return out; }
}

const quick = () => ({ sleep: async () => {}, now: ((): (() => number) => { let t = 0; return () => (t += 50); })(), settleMs: 400 });
const PAGES: PageDef[] = [{ id: 'agents', title: 'Agents', path: '/dashboard?agents' }, { id: 'connector', title: 'Build a connector', path: '/dashboard?connector' }];
const inventory = () => buildPageInventory();

async function run(driver: PagesDriver, pages: PageDef[] = PAGES, extra: Partial<PagesOptions> = {}) {
  const result = await explorePages({ driver, pages, inventory: inventory(), ...quick(), ...extra });
  const steps = result.traces.flatMap((trace) => trace.steps);
  return { result, steps, failed: steps.filter((step) => !step.ok) };
}

describe('the inventory of the other pages, read from the product\'s templates', () => {
  test('it names the controls the pages can show, each by an attribute or fixed words', () => {
    const { entries, unmatchable, files } = inventory();
    const ids = entries.map((entry) => entry.id);
    expect(files.length).toBe(5);
    for (const wanted of ['agents.ts:Revoke', 'agents.ts:Get pairing code', 'agents.ts:Create key', 'components.ts:Lock', 'components.ts:Unlock', 'model-setup.ts:Check readiness', 'private-answers.ts:data-pa-delete']) expect(ids).toContain(wanted);
    expect(entries.length).toBeGreaterThan(30);
    expect(unmatchable).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a template is scanned for its tags, hidden fields are not controls, and words that come from data make a control unmatchable', () => {
    const scanned = scanControls('x/page.ts', "const a = `<form><input type=\"hidden\" name=\"s\"><button class=\"btn\" type=\"submit\">Save it</button><button>${label}</button><summary aria-label=\"More actions\">⋯</summary><a data-open-link href=\"${href}\">x</a></form>`;");
    expect(scanned.entries.map((entry) => entry.id).sort()).toEqual(['page.ts:Save it', 'page.ts:data-open-link', 'page.ts:More actions'].sort());
    expect(scanned.unmatchable).toBe(1);
  });

  test('a control on the page is matched to the template by its attribute or its words', () => {
    const control = (over: Partial<PageControl>): PageControl => ({ n: 1, sig: 's', tag: 'button', type: '', name: '', text: '', href: null, target: null, rel: null, disabled: false, reason: '', visible: true, attrs: [], formKind: '', expanded: null, copy: false, field: false, invalid: false, confirms: false, ...over });
    expect(matches({ id: 'a', file: 'f', tag: 'button', label: 'Add key' }, control({ name: 'Add Venice key' }))).toBe(true);
    expect(matches({ id: 'a', file: 'f', tag: 'button', label: 'Add key' }, control({ name: 'Remove key' }))).toBe(false);
    expect(matches({ id: 'a', file: 'f', tag: 'button', attr: 'data-pa-delete' }, control({ attrs: ['data-pa-delete'] }))).toBe(true);
    expect(matches({ id: 'a', file: 'f', tag: 'a', label: 'Get a API key' }, control({ tag: 'a', name: 'Get a Venice API key' }))).toBe(true);
  });
});

describe('exploring the other pages', () => {
  test('each control is pressed by itself from a fresh page; the ones that ask are answered both ways; outside links are validated; the unsafe ones are named; Lock is pressed once, last', async () => {
    const driver = new PagesDriver();
    const { result, steps, failed } = await run(driver);
    expect(failed.map((step) => `${step.name}: ${step.findings.join('; ') || step.actual}`)).toEqual([]);
    const names = steps.map((step) => step.name).join(' | ');
    expect(names).toContain('Get pairing code');
    expect(names).toContain('Create key');
    expect(names).toContain('Get opening link');
    expect(names).toContain('Copy prompt');
    expect(names).toContain('Revoke (answer Cancel to its question)');
    expect(names).toContain('Revoke (answer OK to its question)');
    expect(names).toContain('Get a key (link to another site, validated)');
    expect(names).toContain('Turn on remote access (not pressed)');
    // The remote-access form was listed, not pressed; Lock was pressed once, on the last page.
    expect(driver.pressed).not.toContain('remote-on');
    expect(driver.pressed.filter((press) => press === 'lock')).toHaveLength(1);
    expect(driver.pressed.indexOf('lock')).toBeGreaterThan(driver.pressed.lastIndexOf('revoke') - 1);
    expect(steps.some((step) => step.name === 'Lock (not pressed)' && /pressed once, after every other page/.test(step.actual))).toBe(true);
    // A control made by an earlier press (Revoke after Create key) is found on a later load and pressed.
    expect(result.pages[0]!.pressed).toBeGreaterThan(5);
    expect(result.pages[0]!.validated).toBe(1);
    // Fields are found, not pressed; the sheet's Copy prompt is reached through its toggle.
    expect(result.coverage.entries.find((entry) => entry.id === 'components.ts:Copy prompt')?.status).toBe('pressed');
    expect(result.coverage.entries.find((entry) => entry.id === 'agents.ts:Revoke')?.status).toBe('pressed');
    expect(result.coverage.entries.find((entry) => entry.id === 'agents.ts:Review agreement')?.status).toBe('missed');
    const checks = pagesChecks(result);
    expect(checks.map((check) => `${check.id}:${check.status}`)).toEqual(['pages.agents:pass', 'pages.connector:pass', 'pages.coverage:warn']);
    expect(pagesSection(result)).toContain('Revoke');
  });

  test('the local model\'s Ask is pressed, since it answers on this machine; an Ask that sends the question out is named, not pressed', async () => {
    const driver = new PagesDriver({ ask: true });
    const { steps } = await run(driver, [PAGES[0]!]);
    expect(driver.pressed).toContain('ask:computer');
    expect(driver.pressed).not.toContain('ask:venice');
    expect(steps.find((step) => step.name === 'Ask the local model')?.ok).toBe(true);
    expect(steps.find((step) => step.name === 'Ask Venice (not pressed)')?.actual).toBe('it sends a question to a model outside this machine');
  });

  test('a page is prepared before its first load (not again for Lock), and a preparation that fails fails that page, with why', async () => {
    const calls: string[] = [];
    const prepare: PagesOptions['prepare'] = async (page) => { calls.push(page.id); return page.id === 'agents' ? { ok: true, detail: 'ready' } : { ok: false, detail: 'the Inbox could not be filled' }; };
    const { result } = await run(new PagesDriver({ noLockOnConnector: true }), PAGES, { prepare });
    expect(calls).toEqual(['agents', 'connector']);
    const agents = result.traces.find((trace) => trace.id === 'pages-agents')!.steps;
    expect(agents[0]).toMatchObject({ n: 1, name: 'Prepare the Agents page', ok: true, actual: 'ready' });
    expect(agents[1]).toMatchObject({ n: 2, name: 'The Agents page as loaded' });
    expect(result.traces.find((trace) => trace.id === 'pages-connector')!.steps[0]).toMatchObject({ ok: false, findings: ['the Inbox could not be filled'] });
    expect(pagesChecks(result).map((check) => `${check.id}:${check.status}`)).toEqual(['pages.agents:pass', 'pages.connector:fail', 'pages.coverage:warn']);
  });

  test('a form with a required field left empty must send nothing', async () => {
    const driver = new PagesDriver();
    const { steps } = await run(driver, [PAGES[0]!]);
    expect(steps.find((step) => step.name === 'Connect')).toMatchObject({ ok: true, actual: 'nothing was sent' });
  });

  test('a control inside a closed section is not pressed, since a person cannot press it; its summary and an open section\'s controls are', async () => {
    const { steps } = await run(new PagesDriver({ sections: true }), [PAGES[0]!]);
    const names = steps.map((step) => step.name);
    expect(names).not.toContain('Copy the address');
    expect(names).toContain('Add it yourself instead');
    expect(names).toContain('Show advanced');
  });

  test('a control three sections deep is reached through each one in turn and pressed', async () => {
    const driver = new PagesDriver({ nested: true });
    const { steps } = await run(driver, [PAGES[0]!]);
    expect(steps.find((step) => step.name.startsWith('Deep button'))).toMatchObject({ name: 'Deep button (after 3 earlier presses)', ok: true });
    expect(driver.state.deepPressed).toBe(true);
  });

  test('a control reached through a section that reloads the page still has its question answered, not left to the browser', async () => {
    const driver = new PagesDriver({ reloadingSection: true });
    const { steps } = await run(driver, [PAGES[0]!]);
    const add = steps.find((step) => step.name.startsWith('Add zkAPI to Olympus'));
    expect(add).toMatchObject({ name: 'Add zkAPI to Olympus (after 1 earlier press)', ok: true, consoleErrors: [] });
    expect(driver.state.zkAdded).toBe(true);
  });

  test('a button that does nothing fails', async () => {
    const { failed } = await run(new PagesDriver({ deadButton: true }), [PAGES[0]!]);
    expect(failed.map((step) => step.name)).toEqual(['Check readiness']);
    expect(failed[0]!.findings.join(' ')).toContain('did nothing');
  });

  test('a pairing code that is not shown fails its own outcome', async () => {
    const { failed } = await run(new PagesDriver({ noCode: true }), [PAGES[0]!]);
    expect(failed.map((step) => step.name)).toContain('Get pairing code');
    expect(failed.find((step) => step.name === 'Get pairing code')!.actual).toBe('no code or key is showing');
  });

  test('Revoke that forgets to ask, or whose Cancel revokes, fails', async () => {
    const forgetful = await run(new PagesDriver({ noQuestion: true }), [PAGES[0]!]);
    expect(forgetful.failed.map((step) => step.name)).toContain('Revoke (answer Cancel to its question)');
    const eager = await run(new PagesDriver({ ignoresCancel: true }), [PAGES[0]!]);
    expect(eager.failed.find((step) => step.name === 'Revoke (answer Cancel to its question)')!.actual).toBe('Cancel went ahead anyway');
  });

  test('a console error, a link to another site that is not https, a disabled button with no reason and an unnamed field each fail', async () => {
    const logs = await run(new PagesDriver({ logs: true }), [PAGES[0]!]);
    expect(logs.failed.find((step) => step.name === 'Get pairing code')!.findings.join(' ')).toContain('console error');
    const http = await run(new PagesDriver({ httpLink: true }), [PAGES[0]!]);
    expect(http.failed.map((step) => step.name)).toContain('Get a key (link to another site, validated)');
    expect(http.failed[0]!.findings.join(' ')).toContain('not https');
    const disabled = await run(new PagesDriver({ silentDisabled: true }), [PAGES[0]!]);
    expect(disabled.failed.some((step) => /disabled and says nothing about why/.test(step.findings.join(' ')))).toBe(true);
    const field = await run(new PagesDriver({ unnamedField: true }), [PAGES[0]!]);
    expect(field.failed.some((step) => /has no name/.test(step.findings.join(' ')))).toBe(true);
  });

  test('a busy control says why it is off in its own words, and a row whose time changes between loads is still found and pressed', async () => {
    const busy = await run(new PagesDriver({ busyDisabled: true }), [PAGES[0]!]);
    expect(busy.failed).toEqual([]);
    expect(busy.steps.find((step) => step.name === 'Checking… (disabled)')).toMatchObject({ ok: true, actual: 'it is busy and says so: "Checking…"' });
    const driver = new PagesDriver({ agedRow: true });
    const aged = await run(driver, [PAGES[0]!]);
    expect(aged.steps.find((step) => step.name.startsWith('What is due?'))).toMatchObject({ ok: true, actual: 'the page changed' });
    expect(driver.pressed).toContain('other');
  });

  test('a tab kept blank for a sign-in is judged by where it went: on to the provider or closed again passes, left blank fails', async () => {
    const step = async (signInTab: NonNullable<State['signInTab']>) => (await run(new PagesDriver({ signInTab }), [PAGES[0]!])).steps.find((entry) => entry.name === 'Connect Drive')!;
    expect(await step('provider')).toMatchObject({ ok: true, findings: [] });
    expect(await step('closes')).toMatchObject({ ok: true, findings: [] });
    const blank = await step('blank');
    expect(blank.ok).toBe(false);
    expect(blank.findings).toContain('a window was opened and left blank');
  });

  test('when the last page has no Lock, Lock is pressed once at the end, back on a page that has it', async () => {
    const driver = new PagesDriver({ noLockOnConnector: true });
    const { result, steps, failed } = await run(driver);
    expect(failed.map((step) => step.name)).toEqual([]);
    expect(driver.pressed.filter((press) => press === 'lock')).toHaveLength(1);
    expect(driver.pressed[driver.pressed.length - 1]).toBe('lock');
    expect(steps.some((step) => step.name === 'Lock' && step.ok)).toBe(true);
    expect(result.pages.map((page) => page.id)).toEqual(['agents', 'connector']);
    expect(result.coverage.entries.find((entry) => entry.id === 'components.ts:Lock')?.status).toBe('pressed');
  });

  test('a page whose controls cannot be read fails instead of passing empty', async () => {
    const driver = new PagesDriver();
    driver.probe = async () => { throw new Error('no answer'); };
    const { result } = await run(driver, [PAGES[0]!]);
    expect(pagesChecks(result)[0]).toMatchObject({ id: 'pages.agents', status: 'fail' });
    expect(result.pages[0]!.error).toContain('could not be read');
  });

  test('a first load that never answers is bounded and the next page still runs', async () => {
    const driver = new PagesDriver();
    const go = driver.go.bind(driver);
    driver.go = async (path: string) => { if (path.endsWith('agents')) return await new Promise<void>(() => {}); return await go(path); };
    const { result } = await run(driver, PAGES, { itemBoundMs: 300 });
    expect(result.pages[0]!.error).toContain('took longer');
    expect(result.pages[1]!.pressed).toBeGreaterThan(0);
  });

  test('a page that cannot be explored is reported as such, with the reason', async () => {
    const driver = new PagesDriver();
    driver.go = async () => { throw new Error('the browser went away'); };
    const { result, failed } = await run(driver, [PAGES[0]!]);
    expect(result.pages[0]!.error).toContain('the browser went away');
    expect(failed).toHaveLength(1);
    expect(pagesChecks(result)[0]).toMatchObject({ id: 'pages.agents', status: 'fail' });
  });
});

/**
 * The Ask page and its Inbox, as far as filling the Inbox needs: the question field, the local model's Ask, the answer panel and the
 * rows. As in the product, a question is a row as soon as it is asked; its answer shows in the panel some reads later.
 */
class InboxPage {
  readonly window = new Window({ url: 'http://127.0.0.1:8010/dashboard?private-answers' });
  rows: number;
  asked: string[] = [];
  /** Reads of the answer panel left before the answer shows (Infinity: it never does). */
  private pending = 0;
  private answer = '';
  constructor(rows = 0, private readonly ready = true, private readonly answerAfter = 2) { this.rows = rows; }
  private render(): void {
    const ask = this.ready ? `<button type="submit" data-pa-destination="computer"${this.pending > 0 ? ' aria-busy="true" disabled' : ''}>Ask the local model</button>` : '<a class="btn" href="/dashboard?models">Set up the local model</a>';
    const out = this.pending > 0 ? '<p class="pamsg">Answering…</p>' : this.answer ? `<div class="paanswer">${this.answer}</div>` : '';
    this.window.document.body.innerHTML = `<form data-pa-ask><textarea name="question"></textarea>${ask}<div data-pa-out>${out}</div></form><ul data-pa-list>${Array.from({ length: this.rows }, (_, i) => `<li data-pa-question="q${i}">Question ${i}</li>`).join('')}</ul>`;
  }
  get driver(): JourneyDriver {
    const field = () => this.window.document.querySelector('textarea[name="question"]') as unknown as { value: string } | null;
    return {
      go: async () => { this.render(); },
      probe: async (_frame: 'host' | 'panel', call: string) => {
        if (call.includes('data-pa-out') && this.pending > 0 && --this.pending === 0) this.render();
        return evalIn(this.window, call);
      },
      type: async (_frame: 'host' | 'panel', target: WireTarget, text: string) => { const el = field(); if (!el || target.css !== 'form[data-pa-ask] textarea[name="question"]') return false; el.value = text; return true; },
      click: async (_frame: 'host' | 'panel', target: WireTarget) => {
        if (!this.window.document.querySelector(`${target.css ?? ''}:not([disabled])`)) return null;
        const question = field()!.value;
        this.asked.push(question);
        this.rows += 1;
        this.pending = this.answerAfter;
        this.answer = `An answer to ${question}`;
        this.render();
        return {} as ElementInfo;
      },
    } as unknown as JourneyDriver;
  }
}

describe('filling the Inbox before it is crawled', () => {
  const inbox: PageDef = { id: 'inbox', title: 'Inbox', path: '/dashboard?private-answers' };
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

  test('an empty Inbox gets one answer per question, asked of the local model on the page', async () => {
    const page = new InboxPage();
    const prepare = inboxAnswers(page.driver, { questions: ['One?', 'Two?'], ...clock() });
    expect(await prepare(inbox, 60_000)).toEqual({ ok: true, detail: 'the local model answered; the Inbox holds 2 answer(s)' });
    expect(page.asked).toEqual(['One?', 'Two?']);
    // The second question waited for the first answer (the button is busy until then), not only for its row.
    const slow = new InboxPage(0, true, 5);
    expect((await inboxAnswers(slow.driver, { questions: ['One?', 'Two?'], ...clock() })(inbox, 60_000))?.ok).toBe(true);
    expect(slow.asked).toEqual(['One?', 'Two?']);
  });

  test('answers already there count, and another page is left as it is', async () => {
    const page = new InboxPage(1);
    const prepare = inboxAnswers(page.driver, { questions: ['One?', 'Two?'], ...clock() });
    expect(await prepare({ id: 'agents', title: 'Agents', path: '/dashboard?agents' }, 60_000)).toBeUndefined();
    expect((await prepare(inbox, 60_000))?.ok).toBe(true);
    expect(page.asked).toEqual(['Two?']);
  });

  test('a local model that is not ready, or an answer that never reaches the Inbox, fails with why once the time is up', async () => {
    const notReady = inboxAnswers(new InboxPage(0, false).driver, { questions: ['One?'], ...clock() });
    expect(await notReady(inbox, 10_000)).toEqual({ ok: false, detail: '"Ask the local model" was not ready to press (the Inbox holds 0 of 1 answers)' });
    // The question is in the Inbox at once; an answer that never comes is not counted as one.
    const silent = inboxAnswers(new InboxPage(0, true, Infinity).driver, { questions: ['One?'], ...clock() });
    expect(await silent(inbox, 10_000)).toEqual({ ok: false, detail: 'the local model\'s answer was not finished and in the Inbox in time (no answer yet; the Inbox holds 1 of 1)' });
  });
});
