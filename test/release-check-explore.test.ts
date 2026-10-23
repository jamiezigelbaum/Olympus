/**
 * The control exploration (scripts/release-check/explore.ts) against a small stateful panel in a DOM: every control is pressed by
 * itself from a fresh page, the destructive ones ask first, and each rule fails the run when it is broken. The inventory is checked
 * against the product's real source.
 */
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { EXPECTATIONS, exploreChecks, explore, type Seed } from '../scripts/release-check/explore.ts';
import { buildInventory, setLiteral } from '../scripts/release-check/explore-inventory.ts';
import { kindOf } from '../scripts/release-check/explore-kinds.ts';
import type { ElementInfo, JourneyDriver, PageEvents } from '../scripts/release-check/journey.ts';
import { PROBE_SOURCE, type WireTarget } from '../scripts/release-check/probe.ts';
import { exploreSection } from '../scripts/release-check/report.ts';

function evalIn(window: Window, code: string): unknown {
  const globals = window as unknown as { __rc?: unknown };
  return new Function('window', 'document', 'getComputedStyle', 'NodeFilter', '__rc', `return (${code});`)(window, window.document, window.getComputedStyle.bind(window), (window as any).NodeFilter, globals.__rc);
}

interface PanelState {
  connected: boolean;
  menuOpen: boolean;
  confirming: boolean;
  line: string;
  /** Pressing Sync now does nothing at all (a dead button). */
  deadSync?: boolean;
  /** Disconnect forgets to ask. */
  noQuestion?: boolean;
  /** A disabled Sync now with or without its reason. */
  disabledSync?: 'reason' | 'silent';
  /** Pressing Sync now logs a console error. */
  syncLogs?: boolean;
  /** Connect opens this address in a new window. */
  connectOpens?: string;
  /** Show a "Needs you" row with no control. */
  bareProblem?: boolean;
  /** Pressing Sync now makes a text with undefined in it. */
  undefinedText?: boolean;
  /** Also show Gmail's row, whose Connect would start a real sign-in. */
  gmailRow?: boolean;
  /** Connect leaves the dashboard for another page (the panel is gone). */
  connectLeaves?: boolean;
  /** Cancel on the Disconnect question disconnects anyway. */
  cancelDisconnects?: boolean;
  /** Rows that are not sources: the computer's Keys row (a link that leaves the page). */
  computerRow?: boolean;
  /** A Needs-you style source row with no control. */
  bareNeedRow?: boolean;
  /** Disconnect leaves the page instead of asking. */
  disconnectLeaves?: boolean;
  /** Connect leaves for this address (default /dashboard?connect). */
  connectAt?: string;
  /** The page logs a console error while it loads. */
  loadLogs?: boolean;
}

/** A panel with one source, Readwise, that behaves the way the dashboard's does: a row, a ⋯ menu, a question before Disconnect. */
class PanelDriver implements JourneyDriver {
  readonly panel = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  readonly host = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  events: PageEvents = { console: [], requests: [] };
  pagesOpen = 1;
  state: PanelState = { connected: true, menuOpen: false, confirming: false, line: 'Synced 5 min ago', connectOpens: 'https://olympusplugin.ai/open/connect' };
  readonly pressed: string[] = [];
  constructor(initial: Partial<PanelState> = {}) {
    Object.assign(this.state, initial);
    const place = function (this: any) {
      const closed = this.closest?.('details:not([open])') && this.tagName !== 'SUMMARY';
      const hidden = closed || this.hasAttribute?.('hidden');
      return hidden ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } : { left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34 };
    };
    for (const window of [this.panel, this.host]) (window.Element.prototype as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = place;
  }
  private render(): void {
    const s = this.state;
    const sync = s.disabledSync ? `<button data-key="menu:readwise.library:0" disabled>Sync now</button>${s.disabledSync === 'reason' ? '<span class="reason">Waiting for the first sync</span>' : ''}` : `<button data-key="menu:readwise.library:0">Sync now</button>`;
    const disconnect = s.confirming
      ? `<span class="fix confirm"><span class="reason strong">Disconnect Readwise?</span><button data-key="menu:readwise.library:1:yes">Confirm disconnect</button><button data-key="menu:readwise.library:1:no">Cancel</button></span>`
      : `<span class="fix"><button data-key="menu:readwise.library:1">Disconnect</button></span>`;
    const row = s.connected
      ? `<li class="row source"><div class="source-main"><p class="source-head"><span class="source-name">Readwise</span></p><p class="muted">${s.line}</p></div>
          <details class="menu" data-open-key="menu:readwise.library" ${s.menuOpen ? 'open' : ''}><summary data-key="summary:menu:readwise.library">⋯<span class="sr">More actions for Readwise</span></summary><div class="menu-panel"><span class="fix">${sync}</span>${disconnect}</div></details></li>`
      : `<li class="row source"><div class="source-main"><p class="source-head"><span class="source-name">Readwise</span></p><p class="muted">Not connected</p></div><div class="source-actions"><span class="fix"><button data-key="primary:readwise.library">Connect</button></span></div></li>`;
    const need = s.bareProblem ? '<ul><li class="row need"><div class="need-body"><p class="row-text">Readwise is stuck</p></div></li></ul>' : '';
    const gmail = s.gmailRow ? '<li class="row source"><div class="source-main"><p class="source-head"><span class="source-name">Gmail</span></p></div><div class="source-actions"><span class="fix"><button data-key="primary:gmail.email">Connect</button></span></div></li>' : '';
    const computer = s.computerRow ? '<li class="row"><span class="row-text">Keys</span><a data-key="computer:keys" href="/dashboard?keys">Open Keys</a></li>' : '';
    const needRow = s.bareNeedRow ? '<li class="row source need-row"><div class="source-main"><p class="row-text">Gmail needs you</p></div></li>' : '';
    this.panel.document.body.innerHTML = `<main><h2>Sources</h2>${need}<ul>${row}${gmail}${needRow}</ul><ul>${computer}</ul></main>`;
    evalIn(this.panel, PROBE_SOURCE);
    this.host.document.body.innerHTML = '<iframe id="olympus-panel"></iframe>';
    evalIn(this.host, PROBE_SOURCE);
    // The panel's own handlers.
    const on = (key: string, handler: () => void): void => {
      const el = this.panel.document.querySelector(`[data-key="${key}"]`);
      if (el) el.addEventListener('click', () => { this.pressed.push(key); handler(); this.render(); });
    };
    on('summary:menu:readwise.library', () => { this.state.menuOpen = !this.state.menuOpen; });
    on('menu:readwise.library:0', () => {
      if (this.state.deadSync) return;
      if (this.state.syncLogs) this.events.console.push('TypeError: x is not a function');
      this.state.line = this.state.undefinedText ? 'Found undefined items' : 'Checking Readwise…';
    });
    on('menu:readwise.library:1', () => { if (this.state.disconnectLeaves) { this.at = '/dashboard?away'; this.gone = true; return; } if (this.state.noQuestion) this.state.connected = false; else this.state.confirming = true; });
    on('menu:readwise.library:1:yes', () => { this.state.connected = false; this.state.confirming = false; });
    on('menu:readwise.library:1:no', () => { this.state.confirming = false; if (this.state.cancelDisconnects) this.state.connected = false; });
    on('computer:keys', () => { this.at = '/dashboard?keys'; this.gone = true; });
    on('primary:readwise.library', () => {
      if (this.state.connectLeaves) { this.at = this.state.connectAt ?? '/dashboard?connect'; this.gone = true; return; }
      if (this.state.connectOpens) this.opened.push(this.state.connectOpens);
    });
    on('primary:gmail.email', () => { this.opened.push('https://accounts.google.com/o/oauth2'); });
  }
  at = '/dashboard';
  gone = false;
  /** What window.open was called with (the page-side recorder reads this through the stubbed __rcOpened). */
  readonly opened: string[] = [];
  async hasPanel(): Promise<boolean> { return true; }
  async probe(frame: 'host' | 'panel', call: string): Promise<unknown> {
    if (frame === 'panel' && this.gone) throw new Error('the dashboard panel is not on the page');
    if (call.includes('openedWindows')) return frame === 'panel' ? [...this.opened] : [];
    if (call.includes('watchWindows')) return 0;
    return evalIn(frame === 'host' ? this.host : this.panel, call);
  }
  async click(frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const window = frame === 'host' ? this.host : this.panel;
    const info = evalIn(window, `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (!info) return null;
    if (!info.disabled) evalIn(window, `__rc.element(${JSON.stringify(target)}).click()`);
    return info;
  }
  async type(): Promise<boolean> { return false; }
  async open(): Promise<void> { this.reset(); }
  async go(): Promise<void> { this.reset(); }
  async reload(): Promise<void> { this.reset(); }
  /** A fresh page: the server's state (connected or not) stays; the page's own (menu open, question asked, windows opened) starts over. */
  private reset(): void { if (this.state.loadLogs) this.events.console.push('ReferenceError: boot is not defined'); this.state.menuOpen = false; this.state.confirming = false; this.opened.length = 0; this.at = '/dashboard'; this.gone = false; this.render(); }
  async setViewport(): Promise<void> {}
  async where(): Promise<string> { return this.at; }
  async pages(): Promise<number> { return this.pagesOpen; }
  async screenshot(): Promise<boolean> { return true; }
  drainEvents(): PageEvents { const out = this.events; this.events = { console: [], requests: [] }; return out; }
}

/** The inventory the panel is judged against: Readwise's controls (as the source says), and Gmail's, which a machine cannot press. */
const inventory = () => buildInventory().filter((entry) => ['readwise.library', 'gmail.email'].includes(entry.sourceId));

const quick = () => ({ sleep: async () => {}, now: ((): (() => number) => { let t = 0; return () => (t += 50); })(), settleMs: 400 });

const populated = (driver: PanelDriver): Seed => ({
  id: 'populated', title: 'populated',
  apply: async () => { driver.state.connected = true; return { ok: true, detail: 'connected, 4 indexed' }; },
  resetAfter: ['confirm'],
});
const disconnected = (driver: PanelDriver): Seed => ({
  id: 'disconnected', title: 'disconnected',
  apply: async () => { driver.state.connected = false; return { ok: true, detail: 'disconnected' }; },
});

describe('the inventory, taken from the product\'s source', () => {
  test('it names every roster source and each control the view model can build for it, and says why a machine cannot press the others', () => {
    const all = buildInventory();
    const rw = all.filter((entry) => entry.sourceId === 'readwise.library').map((entry) => entry.kind).sort();
    expect(rw).toEqual(['connect', 'delete-data', 'disconnect', 'reconnect', 'sync']);
    expect(all.filter((entry) => entry.sourceId === 'readwise.library').every((entry) => entry.unreachable === undefined)).toBe(true);
    const gmail = all.filter((entry) => entry.sourceId === 'gmail.email').map((entry) => entry.kind);
    expect(gmail).toContain('scope');
    expect(all.filter((entry) => entry.sourceId === 'gmail.email').every((entry) => typeof entry.unreachable === 'string')).toBe(true);
    expect(new Set(all.map((entry) => entry.sourceId)).size).toBeGreaterThanOrEqual(8);
    // The destructive ones are marked as such.
    expect(all.filter((entry) => entry.destructive).every((entry) => entry.kind === 'delete-data' || entry.kind === 'disconnect' || entry.kind === 'unpair')).toBe(true);
  });

  test('the sets are read from the view model\'s source, and a source that changes shape fails loudly', () => {
    expect(setLiteral("const A = new Set<string>(['x.y', 'z'])", 'A')).toEqual(['x.y', 'z']);
    expect(() => setLiteral('const B = 1', 'A')).toThrow(/no longer defines/);
  });

  test('a control is classed by its key and its words', () => {
    expect(kindOf('summary:menu:readwise.library', '⋯')).toBe('menu');
    expect(kindOf('menu:readwise.library:1:yes', 'Confirm disconnect')).toBe('confirm');
    expect(kindOf('menu:readwise.library:0', 'Sync now')).toBe('sync');
    expect(kindOf('primary:readwise.library', 'Reconnect')).toBe('reconnect');
    expect(kindOf('x', 'Something else')).toBe('other');
  });
});

describe('exploring the Sources section', () => {
  test('every control is pressed by itself from a fresh page, Disconnect asks first and its Confirm and Cancel get their own turn, and all of it passes', async () => {
    const driver = new PanelDriver();
    const result = await explore({ driver, seeds: [populated(driver), disconnected(driver)], inventory: inventory(), ...quick() });
    const steps = result.traces.flatMap((trace) => trace.steps).map((step) => step.name);
    expect(steps.join(' | ')).toContain('Sync now');
    expect(steps.join(' | ')).toContain('Confirm disconnect');
    expect(steps.join(' | ')).toContain('Cancel');
    expect(steps.join(' | ')).toContain('Connect');
    expect(result.traces.every((trace) => trace.ok)).toBe(true);
    expect(exploreChecks(result).filter((check) => check.id.startsWith('explore.') && check.id !== 'explore.coverage' && check.id !== 'explore.accessibility').every((check) => check.status === 'pass')).toBe(true);
    // Coverage: Readwise's sync, disconnect and connect were pressed; delete-data and reconnect never showed; Gmail's are unreachable.
    const byId = new Map(result.coverage.map((entry) => [entry.id, entry]));
    expect(byId.get('readwise.library:sync')).toMatchObject({ status: 'pressed' });
    expect(byId.get('readwise.library:disconnect')).toMatchObject({ status: 'pressed' });
    expect(byId.get('readwise.library:connect')).toMatchObject({ status: 'pressed' });
    expect(byId.get('readwise.library:delete-data')?.status).toBe('missed');
    expect(byId.get('readwise.library:delete-data')?.detail).toContain('never showed');
    expect(byId.get('gmail.email:sync')?.status).toBe('missed');
    expect(byId.get('gmail.email:sync')?.detail).toContain('unreachable on a throwaway machine');
    expect(result.summary.listed).toBe(inventory().length);
    expect(result.summary.pressed).toBe(result.coverage.filter((entry) => entry.status === 'pressed').length);
    expect(exploreChecks(result).find((check) => check.id === 'explore.coverage')?.status).toBe('warn');
    expect(exploreChecks(result).find((check) => check.id === 'explore.accessibility')?.status).toBe('skip');
    expect(exploreSection(result)).toContain('MISSED');
  });

  test('the menu opens, and an after-confirm outcome is checked: the row offers Connect again', async () => {
    const driver = new PanelDriver();
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    const confirm = result.traces[0]!.steps.find((step) => /Confirm disconnect/.test(step.name))!;
    expect(confirm.expected).toContain('offers Connect');
    expect(confirm.ok).toBe(true);
    const menu = result.traces[0]!.steps.find((step) => step.action.includes('summary:menu'))!;
    expect(menu.expected).toContain('menu opens');
  });

  test('a press that does nothing fails the seed\'s check', async () => {
    const driver = new PanelDriver({ deadSync: true });
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    const check = exploreChecks(result).find((entry) => entry.id === 'explore.populated')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('did nothing');
  });

  test('an unexpected console error, a placeholder word and an unnamed fix each fail; a disabled control passes only when it says why', async () => {
    const logs = new PanelDriver({ syncLogs: true });
    expect(exploreChecks(await explore({ driver: logs, seeds: [populated(logs)], inventory: inventory(), ...quick() })).find((entry) => entry.id === 'explore.populated')!.detail).toContain('console error');
    const undef = new PanelDriver({ undefinedText: true });
    expect(exploreChecks(await explore({ driver: undef, seeds: [populated(undef)], inventory: inventory(), ...quick() })).find((entry) => entry.id === 'explore.populated')!.detail).toContain('placeholder');
    const silent = new PanelDriver({ disabledSync: 'silent' });
    const silentResult = await explore({ driver: silent, seeds: [populated(silent)], inventory: inventory(), ...quick() });
    expect(exploreChecks(silentResult).find((entry) => entry.id === 'explore.populated')!.detail).toContain('says nothing about why');
    const reason = new PanelDriver({ disabledSync: 'reason' });
    const reasonResult = await explore({ driver: reason, seeds: [populated(reason)], inventory: inventory(), ...quick() });
    expect(exploreChecks(reasonResult).find((entry) => entry.id === 'explore.populated')!.status).toBe('pass');
    expect(reasonResult.coverage.find((entry) => entry.id === 'readwise.library:sync')?.detail).toContain('disabled');
  });

  test('a problem with no way to fix it fails', async () => {
    const driver = new PanelDriver({ bareProblem: true });
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    expect(exploreChecks(result).find((entry) => entry.id === 'explore.populated')!.detail).toContain('no way to fix it');
  });

  test('a Disconnect that forgets to ask fails its own expectation', async () => {
    const driver = new PanelDriver({ noQuestion: true });
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    const check = exploreChecks(result).find((entry) => entry.id === 'explore.populated')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('asks first');
  });

  test('a window opened to somewhere that is not Olympus\'s own fails; Olympus\'s own page is fine', async () => {
    const stray = new PanelDriver({ connectOpens: 'https://example.com/x' });
    const result = await explore({ driver: stray, seeds: [disconnected(stray)], inventory: inventory(), ...quick() });
    expect(exploreChecks(result).find((entry) => entry.id === 'explore.disconnected')!.detail).toContain('not Olympus');
    const own = new PanelDriver({ connectOpens: 'https://olympusplugin.ai/open/connect' });
    const ownResult = await explore({ driver: own, seeds: [disconnected(own)], inventory: inventory(), ...quick() });
    expect(exploreChecks(ownResult).find((entry) => entry.id === 'explore.disconnected')!.status).toBe('pass');
  });

  test('a state that cannot be produced is reported as such and its controls count as missed with that reason', async () => {
    const driver = new PanelDriver();
    const failedSeed: Seed = { id: 'failed', title: 'failed', apply: async () => ({ ok: false, detail: 'the sync was not refused' }) };
    const result = await explore({ driver, seeds: [failedSeed], inventory: inventory(), ...quick() });
    expect(exploreChecks(result).find((entry) => entry.id === 'explore.failed')).toMatchObject({ status: 'fail' });
    expect(result.coverage.find((entry) => entry.id === 'readwise.library:reconnect')?.detail).toContain('its seed could not be produced');
  });

  test('only the source the machine can drive is pressed; another source\'s Connect is found, counted, and left alone, with the reason', async () => {
    const driver = new PanelDriver({ gmailRow: true });
    const result = await explore({ driver, seeds: [disconnected(driver)], inventory: inventory(), ...quick() });
    expect(driver.pressed).not.toContain('primary:gmail.email');
    expect(driver.pressed).toContain('primary:readwise.library');
    const gmail = result.coverage.find((entry) => entry.id === 'gmail.email:connect')!;
    expect(gmail.status).toBe('missed');
    expect(gmail.detail).toContain('found on the page, not pressed');
    expect(result.summary.found).toBeGreaterThanOrEqual(2);
  });

  test('a press that leaves the dashboard is an outcome, not a crash: it is recorded with where it went, and the exploration goes on', async () => {
    const driver = new PanelDriver({ connectLeaves: true });
    const result = await explore({ driver, seeds: [disconnected(driver), populated(driver)], inventory: inventory(), ...quick() });
    const left = result.traces[0]!.steps.find((step) => /Connect/.test(step.name))!;
    expect(left.actual).toContain('left the dashboard');
    expect(left.ok).toBe(true);
    expect(result.seeds.map((seed) => seed.produced)).toEqual([true, true]);
  });

  test('a failure while judging one press fails that press, with the reason, and the next press still runs', async () => {
    const driver = new PanelDriver();
    const original = driver.pages.bind(driver);
    let calls = 0;
    driver.pages = async () => { if (++calls === 1) throw new Error('the browser went away'); return original(); };
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    expect(result.traces[0]!.steps.some((step) => step.actual.includes('the press could not be judged'))).toBe(true);
    expect(result.summary.presses).toBeGreaterThan(1);
  });

  test('a Cancel that performs the action fails: the page is compared with how it was seeded', async () => {
    const driver = new PanelDriver({ cancelDisconnects: true });
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    const check = exploreChecks(result).find((entry) => entry.id === 'explore.populated')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('Cancel changed the source');
  });

  test('See why has to open and say something', () => {
    const make = (open: boolean, text: string) => ({ seed: 'populated', kind: 'see-why', before: { keys: [], seeded: [], text: '', open: [] }, after: { controls: [], text: '', open: [{ key: 'why:x', open, text }], url: '/dashboard' }, opened: [], control: { key: 'summary:why:x' } }) as never;
    expect(EXPECTATIONS['see-why']!(make(true, 'Because the key was refused.')).ok).toBe(true);
    expect(EXPECTATIONS['see-why']!(make(true, '')).ok).toBe(false);
    expect(EXPECTATIONS['see-why']!(make(false, 'text')).ok).toBe(false);
  });

  test('only source rows are pressed: another row\'s link that leaves the page is never touched', async () => {
    const driver = new PanelDriver({ computerRow: true });
    await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    expect(driver.pressed).not.toContain('computer:keys');
  });

  test('a source row that needs the owner but offers nothing fails, as a Needs-you row does', async () => {
    const driver = new PanelDriver({ bareNeedRow: true });
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    expect(exploreChecks(result).find((entry) => entry.id === 'explore.populated')!.detail).toContain('no way to fix it');
  });

  test('what the page logs while loading fails the seeded page', async () => {
    const driver = new PanelDriver({ loadLogs: true });
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), ...quick() });
    const check = exploreChecks(result).find((entry) => entry.id === 'explore.populated')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('console error while loading');
  });

  test('a control that must show an outcome fails when it leaves the dashboard instead; one made to leave must go to a page of Olympus\'s own', async () => {
    const leaves = new PanelDriver({ disconnectLeaves: true });
    const result = await explore({ driver: leaves, seeds: [populated(leaves)], inventory: inventory(), ...quick() });
    const check = exploreChecks(result).find((entry) => entry.id === 'explore.populated')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('must stay on the page');

    const elsewhere = new PanelDriver({ connectLeaves: true, connectAt: 'https://evil.example/x' });
    const away = await explore({ driver: elsewhere, seeds: [disconnected(elsewhere)], inventory: inventory(), ...quick() });
    expect(exploreChecks(away).find((entry) => entry.id === 'explore.disconnected')!.detail).toContain('not Olympus\'s own');

    const fine = new PanelDriver({ connectLeaves: true });
    const ok = await explore({ driver: fine, seeds: [disconnected(fine)], inventory: inventory(), ...quick() });
    expect(exploreChecks(ok).find((entry) => entry.id === 'explore.disconnected')!.status).toBe('pass');
  });

  test('the privacy-settings link of a stalled Mac folder is listed for Files on this computer, unreachable on the VM', () => {
    const entry = buildInventory().find((control) => control.kind === 'privacy-settings');
    expect(entry).toMatchObject({ sourceId: 'local.files', label: '^(Open privacy settings)$' });
    expect(typeof entry!.unreachable).toBe('string');
    expect(kindOf('source:local.files:privacy-settings', 'Open privacy settings')).toBe('privacy-settings');
  });

  test('the press bound is per seed: a later seed still presses', async () => {
    const driver = new PanelDriver();
    const result = await explore({ driver, seeds: [populated(driver), disconnected(driver)], inventory: inventory(), maxPresses: 2, ...quick() });
    expect(result.seeds.map((seed) => seed.pressed > 0)).toEqual([true, true]);
    expect(result.summary.presses).toBeGreaterThan(2);
  });

  test('Telegram and WhatsApp Unpair are listed, destructive, and unreachable on a throwaway machine', () => {
    const unpair = buildInventory().filter((entry) => entry.kind === 'unpair');
    expect(unpair.map((entry) => entry.sourceId).sort()).toEqual(['telegram.messages', 'whatsapp.personal.messages']);
    expect(unpair.every((entry) => entry.destructive && typeof entry.unreachable === 'string')).toBe(true);
    expect(kindOf('x', 'Unpair Telegram')).toBe('unpair');
    // Sources that cannot be synced here offer Check again when they need the owner.
    const again = buildInventory().filter((entry) => entry.kind === 'check-again');
    expect(again.map((entry) => entry.sourceId)).toContain('telegram.messages');
    expect(again.map((entry) => entry.sourceId)).toContain('whatsapp.personal.messages');
    expect(again.every((entry) => typeof entry.unreachable === 'string' || entry.sourceId !== 'readwise.library')).toBe(true);
    expect(kindOf('x', 'Check again')).toBe('check-again');
  });

  test('the press bound stops the exploration and says so', async () => {
    const driver = new PanelDriver();
    const result = await explore({ driver, seeds: [populated(driver)], inventory: inventory(), maxPresses: 2, ...quick() });
    expect(result.summary.presses).toBe(2);
    expect(result.traces[0]!.steps.some((step) => step.name === 'Stopped at the bound')).toBe(true);
  });

  test('the expectation table names a kind only where one is cheap to state', () => {
    expect(Object.keys(EXPECTATIONS).sort()).toEqual(['cancel', 'delete-data', 'disconnect', 'menu', 'see-why']);
  });
});
