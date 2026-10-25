/**
 * Journeys: a person's path through the dashboard, written down as data, with the outcome each action must have.
 *
 * A journey is a list of steps. A step is one action (open a page the owner's way, click a control named by its role and name or by
 * its visible text, type into a field, reload, resize) and the outcomes that action must have: this text is on the page, that one
 * is not, this control is there, the count of rows changed by exactly one, the address is this, the field still holds what was
 * typed after a reload. Every outcome is written for its action; nothing is "the page did not crash". Each step also runs the
 * generic rules on whatever page it ends on: no console error or failed request the journey did not declare, no `undefined`,
 * `NaN` or `[object Object]` in the text, no button or link without a name, no sideways scroll.
 *
 * The runner does what a person does: it finds the control by what it says, scrolls it into view and presses the mouse on it. A
 * step never reaches for an address or an API to get around a control that does not work: a control that cannot be found, or does
 * nothing, fails the step, and the step's trace says what was on the page instead.
 *
 * The runner is independent of the browser. It speaks to a `JourneyDriver`: the machine's headless Chrome over DevTools
 * (journey-driver.ts), or a DOM in the tests. What each step saw (the action, the expected and actual outcome, a screenshot taken
 * after it, the console errors and failed requests, how long it took) is the trace the report shows.
 */
import { describeTarget, wireTarget, type Target, type WireTarget } from './probe.ts';
import type { CheckResult } from './report.ts';

// ---------------------------------------------------------------------------
// The format

export type FrameName = 'auto' | 'host' | 'panel';

/** A place the owner opens with an opening link (`olympus dashboard --no-open --target <place>`): the dashboard, or the Inbox page. */
export type OpenPlace = 'dashboard' | 'private';

/** What an expectation compares against; a function reads what an earlier step remembered. */
export type Matcher = string | RegExp | ((vars: Vars) => string | RegExp);

export type Vars = Record<string, string | number>;

export type Action =
  /** The owner's way in: a one-time opening link signs the browser in, and Unlock opens the controls where the page offers it. */
  | { open: OpenPlace }
  | { click: Target; frame?: FrameName }
  | { type: { into: Target; text: string }; frame?: FrameName }
  /** Another page of the dashboard, in the signed-in browser (a path such as /dashboard?keys). */
  | { go: string }
  | { reload: true }
  | { viewport: { width: number; theme?: 'light' | 'dark' } }
  /** Nothing is done: the step only checks what is on the page. */
  | { observe: true };

export type Expectation =
  | { text: Matcher; frame?: FrameName }
  | { noText: Matcher; frame?: FrameName }
  | { present: Target; frame?: FrameName }
  | { absent: Target; frame?: FrameName }
  | { count: Target; equals?: number; atLeast?: number; atMost?: number; frame?: FrameName }
  /** The number of matches changed by `delta` since the step that remembered `since`. */
  | { countSince: { target: Target; since: string; delta: number }; frame?: FrameName }
  | { url: RegExp }
  /** A field holds this (after a reload, that is what persisted). */
  | { value: Target; equals: string | RegExp; frame?: FrameName }
  /** No part of the page scrolls sideways. */
  | { noOverflow: true }
  /** The dashboard opened its page here: no new window or tab appeared. */
  | { noNewWindow: true }
  | { custom: (context: StepContext) => Promise<{ ok: boolean; expected: string; actual: string }> };

export type Remember = { countOf: Target; frame?: FrameName } | { textOf: Target; frame?: FrameName } | { attrOf: Target; attr: string; frame?: FrameName };

export interface JourneyStep {
  name: string;
  do: Action;
  expect: Expectation[];
  /** How long the outcomes may take to appear (the page loads, the engine answers). Default 20 s; opening a page 90 s. */
  timeoutMs?: number;
  /** Read before the action, for an outcome that compares with it. */
  remember?: Record<string, Remember>;
  /** Console messages and failed requests this step declares expected. */
  allowConsole?: RegExp[];
  allowRequests?: Array<{ url: RegExp; status?: number }>;
}

export interface Journey {
  id: string;
  title: string;
  /** Where the journey comes from: the owner's test plan, or the bug the owner found by hand. */
  source: string;
  steps: JourneyStep[];
  /** Changes the install's state: runs after the journeys that do not, and the screens are captured before it. */
  mutates?: boolean;
  /**
   * Legs of the run that set up what it checks (an agent that connected and worked; answered private questions in the Inbox). A run
   * that skips one of them (`--skip-suite`, `--skip-inbox`) skips the journey and says why, rather than failing it.
   */
  needs?: Array<'suite' | 'inbox'>;
  allowConsole?: RegExp[];
  allowRequests?: Array<{ url: RegExp; status?: number }>;
}

// ---------------------------------------------------------------------------
// The trace

export interface StepTrace {
  n: number;
  name: string;
  /** What was done, in words: `click button "Save"`. */
  action: string;
  expected: string;
  actual: string;
  ok: boolean;
  ms: number;
  /** Where the page was after the step (path, query and fragment). */
  at: string;
  /** The screenshot taken after the step, relative to the traces folder. */
  screenshot?: string;
  consoleErrors: string[];
  failedRequests: string[];
  /** Generic rules this step broke. */
  findings: string[];
  /** The text and controls on the page after the step, when the step failed. */
  inventory?: { text: string; controls: string[] };
}

export interface JourneyTrace {
  id: string;
  title: string;
  source: string;
  ok: boolean;
  steps: StepTrace[];
  ms: number;
  /** The journey could not run at all (the browser, the opening link). */
  error?: string;
}

// ---------------------------------------------------------------------------
// The driver

export interface PageEvents {
  /** Console errors and uncaught page errors since the last drain. */
  console: string[];
  /** Requests that failed or were answered 400 or above, as `GET /path -> 404`. */
  requests: Array<{ url: string; status: number; text: string; detail?: string }>;
}

export interface ElementInfo {
  tag: string;
  role: string;
  name: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  disabled: boolean;
  href: string | null;
  value: string | null;
  checked: boolean | null;
  expanded: string | null;
  open: boolean | null;
}

export interface Audit { bad: string[]; emptyButtons: string[]; overflowX: number; textLength: number }

export interface JourneyDriver {
  /** Whether the dashboard's framed panel is on the page. */
  hasPanel(): Promise<boolean>;
  /** Calls a function of the page-side script (`__rc`) in a frame and returns what it gave. */
  probe(frame: 'host' | 'panel', call: string): Promise<unknown>;
  /** A real mouse press on the first match; null when nothing matches. */
  click(frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null>;
  /** Focuses the field (a real press), selects what it holds and types the text; false when no field matches. */
  type(frame: 'host' | 'panel', target: WireTarget, text: string): Promise<boolean>;
  open(place: OpenPlace): Promise<void>;
  go(path: string): Promise<void>;
  reload(): Promise<void>;
  setViewport(width: number, theme?: 'light' | 'dark'): Promise<void>;
  /** Where the page is now: path, query and fragment. */
  where(): Promise<string>;
  /** The number of windows and tabs the browser has open. */
  pages(): Promise<number>;
  screenshot(relativeFile: string): Promise<boolean>;
  drainEvents(): PageEvents;
}

export interface StepContext {
  driver: JourneyDriver;
  vars: Vars;
  text(frame?: FrameName): Promise<string>;
  count(target: Target, frame?: FrameName): Promise<number>;
}

// ---------------------------------------------------------------------------
// Running

const DEFAULT_STEP_TIMEOUT_MS = 20_000;
const OPEN_STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 400;

/** Requests every page makes that say nothing about the product. */
const ALWAYS_ALLOWED_REQUESTS: Array<{ url: RegExp; status?: number }> = [{ url: /\/favicon\.ico(\?|$)/ }];
const ALWAYS_ALLOWED_CONSOLE: RegExp[] = [/favicon/i];

const frames = (frame: FrameName | undefined, panel: boolean): Array<'host' | 'panel'> => {
  if (frame === 'host') return ['host'];
  if (frame === 'panel') return panel ? ['panel'] : [];
  return panel ? ['host', 'panel'] : ['host'];
};

const resolve = (matcher: Matcher, vars: Vars): string | RegExp => (typeof matcher === 'function' ? matcher(vars) : matcher);
const matches = (value: string, want: string | RegExp): boolean => (typeof want === 'string' ? value.toLowerCase().includes(want.toLowerCase()) : want.test(value));
const show = (want: string | RegExp): string => (typeof want === 'string' ? `"${want}"` : String(want));
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

function contextFor(driver: JourneyDriver, vars: Vars): StepContext {
  const pageText = async (frame?: FrameName): Promise<string> => {
    const panel = await driver.hasPanel();
    const parts: string[] = [];
    for (const name of frames(frame, panel)) {
      try { parts.push(String(await driver.probe(name, '__rc.visibleText()') ?? '')); } catch { /* the frame is changing */ }
    }
    return parts.join('\n');
  };
  const countOf = async (target: Target, frame?: FrameName): Promise<number> => {
    const panel = await driver.hasPanel();
    let total = 0;
    for (const name of frames(frame, panel)) {
      try { total += Number(await driver.probe(name, `__rc.count(${JSON.stringify(wireTarget(target))})`) ?? 0); } catch { /* the frame is changing */ }
    }
    return total;
  };
  return { driver, vars, text: pageText, count: countOf };
}

interface Outcome { ok: boolean; expected: string; actual: string }

async function evaluate(expectation: Expectation, context: StepContext, state: { pagesBefore: number; initialUrl: string; counts: Record<string, number> }): Promise<Outcome> {
  const { vars } = context;
  if ('text' in expectation) {
    const want = resolve(expectation.text, vars);
    const text = await context.text(expectation.frame);
    const ok = matches(text, want);
    return { ok, expected: `the page says ${show(want)}`, actual: ok ? 'it does' : 'it does not' };
  }
  if ('noText' in expectation) {
    const want = resolve(expectation.noText, vars);
    const text = await context.text(expectation.frame);
    const ok = !matches(text, want);
    return { ok, expected: `the page does not say ${show(want)}`, actual: ok ? 'it does not' : 'it does' };
  }
  if ('present' in expectation) {
    const n = await context.count(expectation.present, expectation.frame);
    return { ok: n > 0, expected: `${describeTarget(expectation.present)} is on the page`, actual: n > 0 ? `found ${n}` : 'not found' };
  }
  if ('absent' in expectation) {
    const n = await context.count(expectation.absent, expectation.frame);
    return { ok: n === 0, expected: `${describeTarget(expectation.absent)} is not on the page`, actual: n === 0 ? 'not found' : `found ${n}` };
  }
  if ('count' in expectation) {
    const n = await context.count(expectation.count, expectation.frame);
    const parts: string[] = [];
    let ok = true;
    if (expectation.equals !== undefined) { parts.push(`exactly ${expectation.equals}`); ok = ok && n === expectation.equals; }
    if (expectation.atLeast !== undefined) { parts.push(`at least ${expectation.atLeast}`); ok = ok && n >= expectation.atLeast; }
    if (expectation.atMost !== undefined) { parts.push(`at most ${expectation.atMost}`); ok = ok && n <= expectation.atMost; }
    return { ok, expected: `${parts.join(' and ')} of ${describeTarget(expectation.count)}`, actual: `${n}` };
  }
  if ('countSince' in expectation) {
    const { target, since, delta } = expectation.countSince;
    const before = Number(vars[since]);
    const n = await context.count(target, expectation.frame);
    const ok = Number.isFinite(before) && n - before === delta;
    return { ok, expected: `${describeTarget(target)} changes by ${delta >= 0 ? '+' : ''}${delta} (from ${Number.isFinite(before) ? before : 'an unknown count'})`, actual: `now ${n}` };
  }
  if ('url' in expectation) {
    const at = await context.driver.where();
    return { ok: expectation.url.test(at), expected: `the address matches ${expectation.url}`, actual: at };
  }
  if ('value' in expectation) {
    let value: string | null = null;
    const panel = await context.driver.hasPanel();
    for (const name of frames(expectation.frame, panel)) {
      try {
        const got = await context.driver.probe(name, `__rc.value(${JSON.stringify(wireTarget(expectation.value))})`);
        if (typeof got === 'string') { value = got; break; }
      } catch { /* the frame is changing */ }
    }
    const want = expectation.equals;
    const ok = value !== null && (typeof want === 'string' ? squash(value) === squash(want) : want.test(value));
    return { ok, expected: `${describeTarget(expectation.value)} holds ${show(want)}`, actual: value === null ? 'the field is not on the page' : `it holds "${squash(value).slice(0, 80)}"` };
  }
  if ('noOverflow' in expectation) {
    const audits = await auditAll(context.driver);
    const wide = Math.max(0, ...audits.map((audit) => audit.overflowX));
    return { ok: wide === 0, expected: 'nothing scrolls sideways', actual: wide === 0 ? 'nothing does' : `the page is ${wide} px too wide` };
  }
  if ('noNewWindow' in expectation) {
    const now = await context.driver.pages();
    return { ok: now === state.pagesBefore, expected: 'the page opened here, in the same window', actual: now === state.pagesBefore ? 'no new window or tab' : `${now - state.pagesBefore} new window or tab(s)` };
  }
  return await expectation.custom(context);
}

async function auditAll(driver: JourneyDriver): Promise<Audit[]> {
  const panel = await driver.hasPanel();
  const out: Audit[] = [];
  for (const name of frames('auto', panel)) {
    try { out.push(await driver.probe(name, '__rc.audit()') as Audit); } catch { /* the frame is changing */ }
  }
  return out;
}

async function inventoryOf(driver: JourneyDriver): Promise<{ text: string; controls: string[] }> {
  const panel = await driver.hasPanel();
  const text: string[] = [];
  const controls: string[] = [];
  for (const name of frames('auto', panel)) {
    try {
      const got = await driver.probe(name, '__rc.inventory()') as { text: string; controls: string[] };
      if (got.text) text.push(`${name === 'panel' ? '[panel] ' : ''}${got.text}`);
      controls.push(...got.controls.map((control) => `${name === 'panel' ? '[panel] ' : ''}${control}`));
    } catch { /* the frame is changing */ }
  }
  return { text: text.join(' | ').slice(0, 900), controls: controls.slice(0, 60) };
}

const allowed = (list: Array<{ url: RegExp; status?: number }>, request: { url: string; status: number }): boolean =>
  list.some((rule) => rule.url.test(request.url) && (rule.status === undefined || rule.status === request.status));

function describeAction(action: Action): string {
  if ('open' in action) return `open the ${action.open} page the owner's way (opening link, then Unlock where it is offered)`;
  if ('click' in action) return `click ${describeTarget(action.click)}`;
  if ('type' in action) return `type "${action.type.text}" into ${describeTarget(action.type.into)}`;
  if ('go' in action) return `go to ${action.go}`;
  if ('reload' in action) return 'reload the page';
  if ('viewport' in action) return `resize to ${action.viewport.width} px wide${action.viewport.theme ? `, ${action.viewport.theme}` : ''}`;
  return 'look at the page';
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step';

async function perform(action: Action, driver: JourneyDriver): Promise<{ ok: boolean; detail: string }> {
  if ('open' in action) { await driver.open(action.open); return { ok: true, detail: 'opened' }; }
  if ('go' in action) { await driver.go(action.go); return { ok: true, detail: 'went there' }; }
  if ('reload' in action) { await driver.reload(); return { ok: true, detail: 'reloaded' }; }
  if ('viewport' in action) { await driver.setViewport(action.viewport.width, action.viewport.theme); return { ok: true, detail: 'resized' }; }
  if ('observe' in action) return { ok: true, detail: 'looked' };
  const panel = await driver.hasPanel();
  if ('click' in action) {
    // The first frame that has the control: the page, then the framed panel.
    for (const name of frames(action.frame, panel)) {
      const info = await driver.click(name, wireTarget(action.click));
      if (info) return info.disabled ? { ok: false, detail: `${describeTarget(action.click)} is there but disabled` } : { ok: true, detail: `pressed ${info.role || info.tag} "${info.name.slice(0, 50)}"` };
    }
    return { ok: false, detail: `${describeTarget(action.click)} is not on the page` };
  }
  for (const name of frames(action.frame, panel)) {
    if (await driver.type(name, wireTarget(action.type.into), action.type.text)) return { ok: true, detail: 'typed' };
  }
  return { ok: false, detail: `${describeTarget(action.type.into)} is not on the page` };
}

export interface RunOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Requests and console messages expected on every step of every journey (a stand-in server that lacks a route the real one has). */
  allowRequests?: Array<{ url: RegExp; status?: number }>;
  allowConsole?: RegExp[];
}

/** Runs one journey and returns its trace. Steps after a failed step do not run: they depend on it. */
export async function runJourney(driver: JourneyDriver, journey: Journey, options: RunOptions = {}): Promise<JourneyTrace> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  const vars: Vars = {};
  const steps: StepTrace[] = [];
  let error: string | undefined;

  // Events are drained once, here; what arrives between steps (while a picture is taken) belongs to the next step's verdict.
  driver.drainEvents();
  for (const [index, step] of journey.steps.entries()) {
    const stepStarted = now();
    const context = contextFor(driver, vars);
    const state = { pagesBefore: 0, initialUrl: '', counts: {} as Record<string, number> };
    let actionResult: { ok: boolean; detail: string };
    try {
      state.pagesBefore = await driver.pages();
      for (const [name, what] of Object.entries(step.remember ?? {})) {
        if ('countOf' in what) vars[name] = await context.count(what.countOf, what.frame);
        else {
          const panel = await driver.hasPanel();
          let text = '';
          for (const frame of frames(what.frame, panel)) {
            const got = 'attrOf' in what
              ? await driver.probe(frame, `__rc.attr(${JSON.stringify(wireTarget(what.attrOf))}, ${JSON.stringify(what.attr)})`)
              : await driver.probe(frame, `(() => { const info = __rc.find(${JSON.stringify(wireTarget(what.textOf))}); return info ? info.text : null; })()`);
            if (typeof got === 'string') { text = got; break; }
          }
          vars[name] = text;
        }
      }
      actionResult = await perform(step.do, driver);
    } catch (caught) {
      actionResult = { ok: false, detail: `the action failed: ${caught instanceof Error ? caught.message.slice(0, 200) : String(caught)}` };
    }

    // The outcomes: polled until they all hold, or until the step's time is up.
    const timeoutMs = step.timeoutMs ?? ('open' in step.do ? OPEN_STEP_TIMEOUT_MS : DEFAULT_STEP_TIMEOUT_MS);
    const until = stepStarted + timeoutMs;
    let outcomes: Outcome[] = [];
    if (actionResult.ok) {
      for (;;) {
        outcomes = [];
        for (const expectation of step.expect) {
          try { outcomes.push(await evaluate(expectation, context, state)); } catch (caught) { outcomes.push({ ok: false, expected: 'the outcome can be read', actual: caught instanceof Error ? caught.message.slice(0, 160) : String(caught) }); }
        }
        if (outcomes.every((outcome) => outcome.ok) || now() >= until) break;
        await sleep(POLL_MS);
      }
    }

    // The generic rules, on the page the step ended on.
    const findings: string[] = [];
    if (actionResult.ok) {
      for (const audit of await auditAll(driver)) {
        for (const text of audit.bad) findings.push(`the page shows a placeholder value: "${text}"`);
        for (const control of audit.emptyButtons) findings.push(`a button or link has no name: ${control}`);
        if (audit.overflowX > 0 && !step.expect.some((expectation) => 'noOverflow' in expectation)) findings.push(`the page scrolls sideways (${audit.overflowX} px too wide)`);
      }
    }
    const events = driver.drainEvents();
    const allowConsole = [...ALWAYS_ALLOWED_CONSOLE, ...(options.allowConsole ?? []), ...(journey.allowConsole ?? []), ...(step.allowConsole ?? [])];
    const allowRequests = [...ALWAYS_ALLOWED_REQUESTS, ...(options.allowRequests ?? []), ...(journey.allowRequests ?? []), ...(step.allowRequests ?? [])];
    const failedRequests = events.requests.filter((request) => !allowed(allowRequests, request)).map((request) => `${request.text} -> ${request.status || 'failed'}`);
    // A failed request also logs "Failed to load resource" to the console; it is reported once, as the request.
    const consoleErrors = events.console.filter((message) => !allowConsole.some((rule) => rule.test(message)) && !(/Failed to load resource/.test(message) && failedRequests.length + events.requests.length > 0));
    for (const message of consoleErrors) findings.push(`console error: ${message.slice(0, 200)}`);
    for (const request of failedRequests) findings.push(`failed request: ${request}`);

    const ok = actionResult.ok && outcomes.every((outcome) => outcome.ok) && findings.length === 0;
    const expected = step.expect.length === 0 ? 'the action works' : outcomes.length > 0 ? outcomes.map((outcome) => outcome.expected).join('; ') : 'the outcomes could not be checked';
    const actual = !actionResult.ok ? actionResult.detail : [actionResult.detail, ...outcomes.map((outcome) => outcome.actual)].join('; ');
    const at = await driver.where().catch(() => '');
    const shot = `${journey.id}/${String(index + 1).padStart(2, '0')}-${slug(step.name)}.jpg`;
    const trace: StepTrace = {
      n: index + 1, name: step.name, action: describeAction(step.do), expected, actual, ok, ms: now() - stepStarted, at: at.replace(/token=[^&#]*/g, 'token=…'),
      consoleErrors: consoleErrors.map((message) => message.slice(0, 300)), failedRequests, findings,
    };
    if (await driver.screenshot(shot).catch(() => false)) trace.screenshot = shot;
    if (!ok) trace.inventory = await inventoryOf(driver).catch(() => ({ text: '', controls: [] }));
    steps.push(trace);
    if (!ok) {
      error = undefined;
      break;
    }
  }
  return { id: journey.id, title: journey.title, source: journey.source, ok: steps.length === journey.steps.length && steps.every((step) => step.ok), steps, ms: now() - started, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// Checks

/** One check per journey: it fails at the first step whose outcome was not the expected one, and says which and what the page did. */
export function journeyChecks(traces: readonly JourneyTrace[]): CheckResult[] {
  return traces.map((trace) => {
    const failed = trace.steps.find((step) => !step.ok);
    const detail = trace.error
      ? trace.error
      : failed
        ? `step ${failed.n} "${failed.name}" (${failed.action}): expected ${failed.expected}; got ${failed.actual}${failed.findings.length > 0 ? `; ${failed.findings.join('; ')}` : ''}`
        : trace.steps.length < 1
          ? 'no steps ran'
          : `${trace.steps.length} step(s), each with the outcome its action must have`;
    return {
      id: `journey.${trace.id}`,
      title: `${trace.title} (${trace.source})`,
      status: trace.ok && !trace.error ? 'pass' : 'fail',
      detail,
      ms: trace.ms,
    } satisfies CheckResult;
  });
}
