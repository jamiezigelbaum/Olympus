/**
 * Bounded exploration of every control on one dashboard page (release-testing design, layer 3). The pilot page is the Sources section
 * of the dashboard panel: the page with the most controls and the most past escapes (button alignment, Sync now, Disconnect, Delete
 * indexed data).
 *
 * From each seeded starting state of the throwaway install (populated, failed, disconnected with its data, empty), the explorer lists
 * the controls the page shows, presses each one by itself from a fresh page (resetting the install first when the press changed it),
 * follows what the press opens (a confirmation's Confirm and Cancel get their own turn), and judges each press three ways:
 * the control's own expected outcome where one is cheap to state (EXPECTATIONS), the generic rules, and "something happened".
 *
 * Rules that block: an unexpected console error or failed request, `undefined`/`NaN`/an empty label, a disabled control that does not
 * say why, a problem with no way to fix it, sideways overflow, a window that opens when it should not (or opens twice), a press that
 * does nothing. Coverage is reported against the list taken from the product's source (explore-inventory.ts): found, pressed, missed
 * with the reason for each miss. Coverage is advisory; the rules are blocking.
 *
 * The explorer speaks to a `JourneyDriver` (the machine's Chrome, or a DOM in the tests) and to `Seed`s (what puts the install in a
 * state). The panel is a framed page with a message bridge to the page around it and an Unlock step; the driver already opens it the
 * owner's way, so the explorer works in the panel's frame and presses with real mouse events.
 */
import { kindOf, type ControlKind, type SeedId } from './explore-kinds.ts';
import type { InventoryControl } from './explore-inventory.ts';
import type { ElementInfo, JourneyDriver, JourneyTrace, StepTrace } from './journey.ts';
import type { CheckResult } from './report.ts';

export interface PanelControl {
  key: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  disabled: boolean;
  visible: boolean;
  expanded: string | null;
  reason: string;
  rowName: string;
  rowKind: '' | 'source' | 'need';
  menuKey: string;
  href: string | null;
}

export interface Seed {
  id: SeedId;
  title: string;
  /** Puts the install in this state (and checks it got there). `ok: false` says why it could not, and the seed is reported as missed. */
  apply(): Promise<{ ok: boolean; detail: string }>;
  /** The press changed the install in a way a reload does not undo (a disconnect): the next press starts by applying the seed again. */
  resetAfter?: ControlKind[];
  /** Presses whose effect cannot be undone (the data is gone): run last, and nothing is replayed after them. */
  last?: ControlKind[];
}

export interface ExploreOptions {
  driver: JourneyDriver;
  seeds: readonly Seed[];
  inventory: readonly InventoryControl[];
  /** Where the panel's screenshots go (relative to the traces folder). */
  screenshotDir?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The browser is already signed in and unlocked (a page was opened the owner's way): pages are then reached by address. */
  signedIn?: boolean;
  /** The most presses one seed may make (bounded exploration). */
  maxPresses?: number;
  /** Milliseconds the page may take to settle after a press. */
  settleMs?: number;
}

export type Missed = 'unreachable' | 'not shown' | 'disabled' | 'not pressed' | 'seed';

export interface CoverageEntry {
  id: string;
  sourceLabel: string;
  kind: ControlKind;
  label: string;
  destructive: boolean;
  status: 'pressed' | 'missed';
  /** For a miss: why. For a press: in which seeds. */
  detail: string;
  seeds: SeedId[];
}

export interface ExploreResult {
  seeds: Array<{ id: SeedId; title: string; produced: boolean; detail: string; pressed: number; failed: number }>;
  traces: JourneyTrace[];
  coverage: CoverageEntry[];
  /** Controls the page showed in the Sources section that the source-derived list does not name. */
  unlisted: Array<{ key: string; label: string; rowName: string; pressed: boolean }>;
  summary: { listed: number; found: number; pressed: number; missed: number; unlisted: number; presses: number };
  /** Why there is no accessibility audit, or its result. */
  accessibility: { status: 'skipped'; reason: string };
}

const ALWAYS_ALLOWED_REQUESTS: RegExp[] = [/\/favicon\.ico(\?|$)/];
const ALWAYS_ALLOWED_CONSOLE: RegExp[] = [/favicon/i];
/** A refusal the product shows on purpose (a source that cannot be reached): the engine answers the tool call with an error the panel words itself. */
const REFUSAL_REQUESTS: RegExp[] = [/\/dashboard\/tools\/call/];
const OWN_HOSTS = /^https:\/\/(www\.)?olympusplugin\.ai\//;

const keyed = (key: string): { css: string } => ({ css: `[data-key="${key.replace(/"/g, '\\"')}"]` });
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The page's own rules for a seeded state, as `(driver, seed) => findings`. */
export interface Outcome { ok: boolean; expected: string; actual: string }
export interface PressContext {
  seed: SeedId;
  control: PanelControl;
  kind: ControlKind;
  before: { keys: string[]; seeded: string[]; text: string; open: Array<{ key: string; open: boolean; text?: string }> };
  after: { controls: PanelControl[]; text: string; open: Array<{ key: string; open: boolean; text?: string }>; url: string };
  opened: string[];
}

/** Each control kind's own expected outcome, where one is cheap to state. A kind with no entry has only the generic rules and "something happened". */
export const EXPECTATIONS: Partial<Record<ControlKind, (context: PressContext) => Outcome>> = {
  menu: (c) => {
    const open = c.after.open.find((entry) => `summary:${entry.key}` === c.control.key);
    const items = c.after.controls.filter((control) => `summary:${control.menuKey}` === c.control.key && control.tag === 'button');
    return { ok: open?.open === true && items.some((item) => item.visible), expected: 'the ⋯ menu opens and shows its actions', actual: open?.open ? `${items.filter((item) => item.visible).length} action(s) showing` : 'the menu did not open' };
  },
  'see-why': (c) => {
    const open = c.after.open.find((entry) => `summary:${entry.key}` === c.control.key);
    const says = (open?.text ?? '').trim().length > 0;
    return { ok: open?.open === true && says, expected: 'See why opens and says why', actual: !open?.open ? 'it did not open' : says ? 'it opened and says why' : 'it opened with nothing in it' };
  },
  disconnect: (c) => {
    const yes = c.after.controls.some((control) => control.key === `${c.control.key}:yes` && control.visible);
    const no = c.after.controls.some((control) => control.key === `${c.control.key}:no` && control.visible);
    return { ok: yes && no, expected: 'Disconnect asks first, with Confirm and Cancel', actual: yes && no ? 'it asks' : 'it did not ask' };
  },
  'delete-data': (c) => {
    const yes = c.after.controls.some((control) => control.key === `${c.control.key}:yes` && control.visible);
    const no = c.after.controls.some((control) => control.key === `${c.control.key}:no` && control.visible);
    return { ok: yes && no, expected: 'Delete indexed data asks first, with Confirm and Cancel', actual: yes && no ? 'it asks' : 'it did not ask' };
  },
  cancel: (c) => {
    const base = c.control.key.replace(/:no$/, '');
    const gone = !c.after.controls.some((control) => control.key === `${base}:yes`);
    // Left as it was: the page offers the same controls as when it was seeded, apart from the question itself (a Cancel that did the action would swap Disconnect for Connect, or remove Delete).
    const rest = (keys: string[]): string => keys.filter((key) => !key.startsWith(`${base}:`)).sort().join('|');
    const same = rest(c.before.seeded) === rest(c.after.controls.map((control) => control.key));
    return { ok: gone && same, expected: 'Cancel closes the question and leaves things as they were', actual: !gone ? 'the question is still showing' : same ? 'the question closed' : 'the question closed, but the controls on the page changed: Cancel changed the source' };
  },
};

/** What a confirmed destructive press must leave: checked by the parent's kind (the control that asked). */
export const AFTER_CONFIRM: Partial<Record<ControlKind, (context: PressContext & { parent: ControlKind }) => Outcome>> = {
  disconnect: (c) => {
    const connect = c.after.controls.some((control) => control.rowName === c.control.rowName && kindOf(control.key, control.name) === 'connect');
    return { ok: connect, expected: 'after Disconnect the row offers Connect', actual: connect ? 'it does' : 'the row does not offer Connect' };
  },
  'delete-data': (c) => {
    const gone = !c.after.controls.some((control) => control.rowName === c.control.rowName && kindOf(control.key, control.name) === 'delete-data');
    return { ok: gone, expected: 'after Delete indexed data the row no longer offers it', actual: gone ? 'it is gone' : 'the row still offers it' };
  },
};

// ---------------------------------------------------------------------------
// Reading the page

async function panelControls(driver: JourneyDriver): Promise<PanelControl[]> {
  const got = await driver.probe('panel', '__rc.controls()') as PanelControl[] | null;
  return Array.isArray(got) ? got : [];
}

async function panelText(driver: JourneyDriver): Promise<string> {
  return squash(String(await driver.probe('panel', '__rc.visibleText()') ?? ''));
}

async function openDetails(driver: JourneyDriver): Promise<Array<{ key: string; open: boolean; text?: string }>> {
  const got = await driver.probe('panel', '__rc.openDetails()') as Array<{ key: string; open: boolean; text?: string }> | null;
  return Array.isArray(got) ? got : [];
}

async function frameAudits(driver: JourneyDriver): Promise<Array<{ bad: string[]; emptyButtons: string[]; overflowX: number }>> {
  const out: Array<{ bad: string[]; emptyButtons: string[]; overflowX: number }> = [];
  for (const frame of ['host', 'panel'] as const) {
    try { out.push(await driver.probe(frame, '__rc.audit()') as { bad: string[]; emptyButtons: string[]; overflowX: number }); } catch { /* the frame is changing */ }
  }
  return out;
}

/** The problems on the page as it stands, without any press: rules about what is shown. */
export async function pageFindings(driver: JourneyDriver, controls?: PanelControl[]): Promise<string[]> {
  const findings: string[] = [];
  for (const audit of await frameAudits(driver)) {
    for (const text of audit.bad) findings.push(`the page shows a placeholder value: "${text}"`);
    for (const control of audit.emptyButtons) findings.push(`a button or link has no name: ${control}`);
    if (audit.overflowX > 0) findings.push(`the page scrolls sideways (${audit.overflowX} px too wide)`);
  }
  const list = controls ?? await panelControls(driver);
  for (const control of list) {
    if (control.visible && control.disabled && !control.reason) findings.push(`"${control.name || control.key}" is disabled and says nothing about why${control.rowName ? ` (${control.rowName})` : ''}`);
  }
  const unfixed = await driver.probe('panel', `(() => {
    const rows = Array.from(document.querySelectorAll('li.row.need, li.row.source.need-row'));
    return rows.filter((row) => !row.querySelector('button, a[href]')).map((row) => __rc.clean(row.textContent).slice(0, 80));
  })()`) as string[] | null;
  for (const row of unfixed ?? []) findings.push(`a problem is shown with no way to fix it: "${row}"`);
  return findings;
}

// ---------------------------------------------------------------------------
// Pressing

interface PressRecord {
  path: string[];
  control: PanelControl;
  kind: ControlKind;
  ok: boolean;
  findings: string[];
  expected: string;
  actual: string;
  ms: number;
  screenshot?: string;
  parentKind?: ControlKind;
  destructive: boolean;
}

export async function explore(options: ExploreOptions): Promise<ExploreResult> {
  const { driver } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const settleMs = options.settleMs ?? 12_000;
  const maxPresses = options.maxPresses ?? 40;
  const seeds: ExploreResult['seeds'] = [];
  const traces: JourneyTrace[] = [];
  const foundIds = new Map<string, { seeds: Set<SeedId>; pressed: boolean; disabled: boolean }>();
  const unlisted = new Map<string, { key: string; label: string; rowName: string; pressed: boolean }>();
  const seedFailures = new Map<SeedId, string>();
  let totalPresses = 0;
  let opened = options.signedIn === true;

  const idOf = (control: PanelControl): string | undefined => {
    const source = options.inventory.find((entry) => entry.sourceLabel === control.rowName)?.sourceId;
    if (!source) return undefined;
    const kind = kindOf(control.key, control.name);
    return options.inventory.find((entry) => entry.sourceId === source && entry.kind === kind && new RegExp(entry.label, 'i').test(control.name))?.id;
  };
  const inScope = (control: PanelControl): boolean => control.rowKind === 'source' && ['button', 'summary', 'a'].includes(control.tag);
  /** A control the machine can press without leaving the throwaway install in a state it cannot restore, or starting a sign-in at a real provider. */
  const drivable = (control: PanelControl): boolean => {
    return options.inventory.some((entry) => entry.sourceLabel === control.rowName && entry.unreachable === undefined);
  };

  const settle = async (): Promise<void> => {
    const until = now() + settleMs;
    let last = '';
    let stable = 0;
    await sleep(500);
    for (;;) {
      let text = '';
      try { text = await panelText(driver); } catch { /* the page is changing */ }
      const busy = await driver.probe('panel', `!!document.querySelector('[aria-busy="true"]')`).catch(() => false);
      stable = text === last && busy !== true ? stable + 1 : 0;
      last = text;
      if (stable >= 2 || now() >= until) return;
      await sleep(400);
    }
  };

  const freshPage = async (): Promise<void> => {
    if (!opened) { await driver.open('dashboard'); opened = true; } else await driver.go('/dashboard');
    await settle();
  };

  const watch = async (): Promise<void> => {
    for (const frame of ['host', 'panel'] as const) await driver.probe(frame, '__rc.watchWindows()').catch(() => undefined);
  };
  const windowsOpened = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const frame of ['host', 'panel'] as const) {
      const got = await driver.probe(frame, '__rc.openedWindows()').catch(() => []) as string[];
      out.push(...(Array.isArray(got) ? got : []));
    }
    return out;
  };

  /** Presses the control (opening the menu it sits in, if it is closed). */
  const press = async (key: string): Promise<ElementInfo | null> => {
    return await driver.click('panel', keyed(key));
  };

  for (const seed of options.seeds) {
    const applied = await seed.apply().catch((error: unknown) => ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    if (!applied.ok) {
      seeds.push({ id: seed.id, title: seed.title, produced: false, detail: applied.detail, pressed: 0, failed: 0 });
      seedFailures.set(seed.id, applied.detail);
      continue;
    }
    await freshPage();
    await watch();
    // What the page logged and requested while loading is judged here, once, with the seeded page; each press then starts from a clean log.
    const load = driver.drainEvents();
    const loadRefusal = seed.id === 'failed';
    const loadRequests = load.requests.filter((request) => !ALWAYS_ALLOWED_REQUESTS.some((rule) => rule.test(request.url)) && !(loadRefusal && REFUSAL_REQUESTS.some((rule) => rule.test(request.url))));
    const loadConsole = load.console.filter((message) => !ALWAYS_ALLOWED_CONSOLE.some((rule) => rule.test(message)) && !(/Failed to load resource/.test(message) && load.requests.length > 0));
    const base = await panelControls(driver);
    const steps: StepTrace[] = [];
    const baseFindings = [
      ...await pageFindings(driver, base),
      ...loadConsole.map((message) => `console error while loading: ${message.slice(0, 200)}`),
      ...loadRequests.map((request) => `failed request while loading: ${request.text} -> ${request.status || 'failed'}`),
    ];
    steps.push({
      n: 1, name: `The ${seed.title} page as seeded`, action: `apply the seed "${seed.id}" and open the dashboard`,
      expected: 'the page follows the generic rules (labels, reasons for disabled controls, a fix for every problem, no sideways scroll)',
      actual: baseFindings.length === 0 ? `${base.filter(inScope).length} control(s) in the Sources section` : baseFindings.join('; '),
      ok: baseFindings.length === 0, ms: 0, at: '/dashboard', consoleErrors: loadConsole.map((message) => message.slice(0, 300)), failedRequests: loadRequests.map((request) => `${request.text} -> ${request.status || 'failed'}`), findings: baseFindings,
    });
    const record = (control: PanelControl, listed: string | undefined): void => {
      const known = listed ? foundIds.get(listed) : undefined;
      if (listed) {
        const entry = known ?? { seeds: new Set<SeedId>(), pressed: false, disabled: control.disabled };
        entry.seeds.add(seed.id);
        entry.disabled = entry.disabled && control.disabled;
        foundIds.set(listed, entry);
      } else if (inScope(control) && kindOf(control.key, control.name) !== 'menu' && kindOf(control.key, control.name) !== 'see-why' && !/:(yes|no|how)$/.test(control.key)) {
        const token = `${control.rowName}|${control.key.replace(/:[^:]*\d+$/, ':n')}|${control.name}`;
        if (!unlisted.has(token)) unlisted.set(token, { key: control.key, label: control.name, rowName: control.rowName, pressed: false });
      }
    };
    for (const control of base.filter(inScope)) record(control, idOf(control));

    // The queue: every control by itself, from the page as seeded. A control in a closed menu is reached through its menu.
    const queue: Array<{ path: string[]; parentKind?: ControlKind }> = [];
    const seen = new Set<string>();
    const enqueue = (path: string[], parentKind?: ControlKind): void => {
      const id = path.join(' > ');
      if (seen.has(id)) return;
      seen.add(id);
      queue.push({ path, ...(parentKind ? { parentKind } : {}) });
    };
    for (const control of base.filter(inScope)) {
      // Only the source the machine can drive (its stand-in): another source's Connect would start a real sign-in at its provider.
      if (!drivable(control)) continue;
      if (control.menuKey && control.tag !== 'summary') enqueue([`summary:${control.menuKey}`, control.key]);
      else enqueue([control.key]);
    }
    const lastKinds = new Set(seed.last ?? []);
    const orderKey = (entry: { path: string[]; parentKind?: ControlKind }): number => (entry.parentKind && lastKinds.has(entry.parentKind) && /:yes$/.test(entry.path[entry.path.length - 1]!) ? 1 : 0);

    let presses = 0;
    let dirty = false;
    let pressedHere = 0;
    let failedHere = 0;
    let destroyed = false;
    while (queue.length > 0 && presses < maxPresses && !destroyed) {
      queue.sort((a, b) => orderKey(a) - orderKey(b));
      const item = queue.shift()!;
      const started = now();
      try {
      if (dirty) {
        const again = await seed.apply().catch((error: unknown) => ({ ok: false, detail: String(error) }));
        if (!again.ok) { steps.push(failureStep(steps.length + 1, item.path, `the seed could not be applied again: ${again.detail}`)); failedHere += 1; break; }
        dirty = false;
      }
      await freshPage();
      await watch();
      let controlsNow = await panelControls(driver);
      // The path's earlier keys are pressed first (a menu opens, a question is asked); the last is the press being judged.
      let reachable = true;
      for (const key of item.path.slice(0, -1)) {
        if (!(await press(key))) { reachable = false; break; }
        await settle();
      }
      controlsNow = await panelControls(driver);
      const finalKey = item.path[item.path.length - 1]!;
      const control = controlsNow.find((candidate) => candidate.key === finalKey);
      if (!reachable || !control) {
        steps.push(failureStep(steps.length + 1, item.path, !reachable ? 'a control on its way could not be pressed' : 'it was on the page as seeded but is not there on a fresh page'));
        failedHere += 1;
        continue;
      }
      const kind = kindOf(control.key, control.name);
      const listed = idOf(control);
      if (control.disabled) {
        // Pressed: a disabled control must do nothing, and has to say why (the page rule above); it counts as found, not as pressed.
        steps.push({ n: steps.length + 1, name: `${control.name || control.key} (disabled)`, action: `look at ${control.rowName} "${control.name}"`, expected: 'a disabled control says why', actual: control.reason || 'it says nothing', ok: control.reason !== '', ms: now() - started, at: '/dashboard', consoleErrors: [], failedRequests: [], findings: control.reason ? [] : [`"${control.name}" is disabled and says nothing about why`] });
        if (!control.reason) failedHere += 1;
        continue;
      }
      const beforeText = await panelText(driver);
      const beforeOpen = await openDetails(driver);
      const pagesBefore = await driver.pages();
      driver.drainEvents();
      const info = await press(control.key);
      presses += 1;
      totalPresses += 1;
      pressedHere += 1;
      if (listed) foundIds.get(listed)!.pressed = true;
      else for (const entry of unlisted.values()) if (entry.key === control.key && entry.rowName === control.rowName) entry.pressed = true;
      let pagesMax = pagesBefore;
      // Watched while the page settles: a window that opens and goes is still seen.
      const settling = (async () => { for (let i = 0; i < 6; i++) { await sleep(250); pagesMax = Math.max(pagesMax, await driver.pages()); } })();
      await settle();
      await settling;
      // A press may leave the dashboard (a control that opens a page of its own): the panel is then gone, which is an outcome, not a crash.
      let afterControls: PanelControl[] = [];
      let afterText = '';
      let afterOpen: Array<{ key: string; open: boolean; text?: string }> = [];
      let left = false;
      try {
        afterControls = await panelControls(driver);
        afterText = await panelText(driver);
        afterOpen = await openDetails(driver);
      } catch { left = true; }
      const events = driver.drainEvents();
      const openedWindows = await windowsOpened();
      const at = await driver.where().catch(() => '');
      const pagesAfter = await driver.pages();

      const context: PressContext = {
        seed: seed.id, control, kind,
        before: { keys: controlsNow.map((candidate) => candidate.key), seeded: base.map((candidate) => candidate.key), text: beforeText, open: beforeOpen },
        after: { controls: afterControls, text: afterText, open: afterOpen, url: at },
        opened: openedWindows,
      };
      const findings: string[] = [];
      const outcomes: Outcome[] = [];
      if (!info) findings.push('the control could not be pressed');
      const parent = item.parentKind;
      const expectation = left ? undefined : (kind === 'confirm' && parent ? AFTER_CONFIRM[parent]?.({ ...context, parent }) : EXPECTATIONS[kind]?.(context));
      if (expectation) outcomes.push(expectation);
      // Something has to happen: the words, the controls, the address, a menu, a window or a request.
      const changed = left || afterText !== beforeText || JSON.stringify(afterControls.map((c) => [c.key, c.visible, c.disabled])) !== JSON.stringify(controlsNow.map((c) => [c.key, c.visible, c.disabled]))
        || JSON.stringify(afterOpen) !== JSON.stringify(beforeOpen) || at !== '/dashboard' || openedWindows.length > 0 || pagesAfter !== pagesBefore || events.requests.length + events.console.length > 0;
      if (!changed) findings.push(`pressing "${control.name}" did nothing: nothing on the page changed`);
      // The rules about what is shown.
      if (!left) findings.push(...await pageFindings(driver, afterControls).catch(() => []));
      // Errors the page logged, except a refusal the product makes on purpose.
      const refusal = seed.id === 'failed' || kind === 'confirm' || kind === 'delete-data';
      const requests = events.requests.filter((request) => !ALWAYS_ALLOWED_REQUESTS.some((rule) => rule.test(request.url)) && !(refusal && REFUSAL_REQUESTS.some((rule) => rule.test(request.url))));
      const consoleErrors = events.console.filter((message) => !ALWAYS_ALLOWED_CONSOLE.some((rule) => rule.test(message)) && !(/Failed to load resource/.test(message) && events.requests.length > 0));
      for (const message of consoleErrors) findings.push(`console error: ${message.slice(0, 200)}`);
      for (const request of requests) findings.push(`failed request: ${request.text} -> ${request.status || 'failed'}`);
      // Windows.
      for (const url of openedWindows) if (!OWN_HOSTS.test(url)) findings.push(`a window was opened to a page that is not Olympus's own: ${url.slice(0, 80)}`);
      if (openedWindows.length > 1) findings.push(`one press opened ${openedWindows.length} windows`);
      if (pagesMax > pagesBefore && pagesAfter <= pagesBefore) findings.push('a window flashed up and vanished');
      const ok = findings.length === 0 && outcomes.every((outcome) => outcome.ok);
      if (!ok) failedHere += 1;
      const trace: StepTrace = {
        n: steps.length + 1, name: `${control.rowName ? `${control.rowName}: ` : ''}${control.name || control.key}${item.path.length > 1 ? ` (after ${item.path.slice(0, -1).join(', ')})` : ''}`,
        action: `press ${control.tag} "${control.name}" [${control.key}] from the "${seed.id}" page`,
        expected: outcomes.length > 0 ? outcomes.map((outcome) => outcome.expected).join('; ') : 'something happens, and the generic rules hold',
        actual: left ? `the press left the dashboard for ${at || 'another page'}` : outcomes.length > 0 ? outcomes.map((outcome) => outcome.actual).join('; ') : (changed ? 'the page changed' : 'nothing changed'),
        ok, ms: now() - started, at: at.replace(/token=[^&#]*/g, 'token=…'),
        consoleErrors: consoleErrors.map((message) => message.slice(0, 300)), failedRequests: requests.map((request) => `${request.text} -> ${request.status || 'failed'}`), findings: [...new Set(findings)].slice(0, 10),
      };
      const shot = `explore-${seed.id}/${String(trace.n).padStart(2, '0')}.jpg`;
      if (await driver.screenshot(shot).catch(() => false)) trace.screenshot = shot;
      steps.push(trace);

      // What the press opened gets its own turn: a question's Confirm and Cancel (keys that extend the control's own). What a confirmed press
      // leaves behind (the row's Connect) is the next state's control, found by the seed that shows it.
      const newKeys = afterControls.filter((candidate) => !context.before.keys.includes(candidate.key) && candidate.key.startsWith(`${control.key}:`) && inScope(candidate) && candidate.visible && candidate.tag === 'button');
      for (const child of newKeys) {
        record(child, idOf(child));
        enqueue([...item.path, child.key], kind);
      }
      if ((seed.resetAfter ?? []).includes(kind) || kind === 'confirm') dirty = true;
      if (kind === 'confirm' && parent && lastKinds.has(parent)) destroyed = true;
      } catch (error) {
        // The page or the browser failed under a press: that press fails, with the reason, and the exploration goes on.
        steps.push(failureStep(steps.length + 1, item.path, `the press could not be judged: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`));
        failedHere += 1;
        dirty = true;
      }
    }
    traces.push({ id: `explore-${seed.id}`, title: `Pressing every control in the Sources section, from the ${seed.title} state`, source: 'bounded exploration (layer 3 of the release-testing design)', ok: steps.every((step) => step.ok), steps, ms: steps.reduce((sum, step) => sum + step.ms, 0) });
    seeds.push({ id: seed.id, title: seed.title, produced: true, detail: applied.detail, pressed: pressedHere, failed: failedHere });
    if (queue.length > 0 && presses >= maxPresses) steps.push({ n: steps.length + 1, name: 'Stopped at the bound', action: 'bounded exploration', expected: 'every control pressed', actual: `${queue.length} control(s) left when the ${maxPresses}-press bound was reached`, ok: true, ms: 0, at: '', consoleErrors: [], failedRequests: [], findings: [] });
  }

  // Coverage, against the list taken from the source.
  const coverage: CoverageEntry[] = options.inventory.map((entry) => {
    const found = foundIds.get(entry.id);
    const base = { id: entry.id, sourceLabel: entry.sourceLabel, kind: entry.kind, label: entry.label.replace(/^\^\(|\)\$$/g, '').replace(/\\/g, '').replace(/\|/g, ' or '), destructive: entry.destructive, seeds: entry.seeds };
    if (found?.pressed) return { ...base, status: 'pressed' as const, detail: `pressed from: ${[...found.seeds].join(', ')}` };
    if (entry.unreachable) return { ...base, status: 'missed' as const, detail: `${found ? 'found on the page, not pressed' : 'unreachable'} on a throwaway machine: ${entry.unreachable}` };
    if (found?.disabled) return { ...base, status: 'missed' as const, detail: 'found, but disabled in every state it showed (it says why; a disabled control is not pressed)' };
    if (found) return { ...base, status: 'missed' as const, detail: 'found but not pressed (the press bound was reached or its seed was not applied again)' };
    const needed = entry.seeds.filter((id) => seedFailures.has(id));
    if (needed.length > 0 && needed.length === entry.seeds.length) return { ...base, status: 'missed' as const, detail: `its seed could not be produced: ${needed.map((id) => `${id} (${seedFailures.get(id)!.slice(0, 120)})`).join('; ')}` };
    return { ...base, status: 'missed' as const, detail: `never showed on the page, in the states that should show it (${entry.seeds.join(', ')})` };
  });
  const listed = coverage.length;
  const pressed = coverage.filter((entry) => entry.status === 'pressed').length;
  const found = coverage.filter((entry) => foundIds.has(entry.id)).length;
  return {
    seeds, traces, coverage, unlisted: [...unlisted.values()],
    summary: { listed, found, pressed, missed: listed - pressed, unlisted: unlisted.size, presses: totalPresses },
    accessibility: { status: 'skipped', reason: 'no accessibility checker (axe-core or similar) is installed in the repository or on the machine, and adding one is a dependency decision for the owner; the generic rules above cover names, reasons and overflow only' },
  };
}

function failureStep(n: number, path: string[], actual: string): StepTrace {
  return { n, name: path.join(' > '), action: `press ${path[path.length - 1]}`, expected: 'the control can be pressed', actual, ok: false, ms: 0, at: '', consoleErrors: [], failedRequests: [], findings: [actual] };
}

// ---------------------------------------------------------------------------
// Checks

/** Blocking: a check per seed (the rules and the controls' own outcomes). Advisory: the coverage. */
export function exploreChecks(result: ExploreResult): CheckResult[] {
  const checks: CheckResult[] = [];
  for (const seed of result.seeds) {
    const trace = result.traces.find((candidate) => candidate.id === `explore-${seed.id}`);
    if (!seed.produced) {
      checks.push({ id: `explore.${seed.id}`, title: `Every control, from the ${seed.title} state`, status: 'fail', detail: `the state could not be produced, so its controls were not pressed: ${seed.detail}` });
      continue;
    }
    const failed = trace?.steps.filter((step) => !step.ok) ?? [];
    checks.push({
      id: `explore.${seed.id}`,
      title: `Every control, from the ${seed.title} state, meets its outcome and the generic rules`,
      status: failed.length === 0 ? 'pass' : 'fail',
      detail: failed.length === 0 ? `${seed.pressed} control(s) pressed, each with its outcome and no rule broken` : failed.slice(0, 4).map((step) => `${step.name}: ${step.findings.length > 0 ? step.findings.join('; ') : `expected ${step.expected}; got ${step.actual}`}`).join(' | '),
      ...(trace ? { ms: trace.ms } : {}),
    });
  }
  const s = result.summary;
  checks.push({
    id: 'explore.coverage', title: 'Coverage of the Sources section\'s controls (advisory)',
    status: s.missed === 0 ? 'pass' : 'warn',
    detail: `${s.listed} controls listed from the source; ${s.found} found on the page, ${s.pressed} pressed, ${s.missed} missed (reasons in the report); ${s.unlisted} found that the list does not name`,
  });
  checks.push({ id: 'explore.accessibility', title: 'Accessibility audit of the Sources section', status: 'skip', detail: result.accessibility.reason });
  return checks;
}
