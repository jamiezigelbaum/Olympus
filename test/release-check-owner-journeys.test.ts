// The release check's Owner controls journeys (1.5 lane 4): fix one item, update from the dashboard, and restore on a clean machine.
// fix-one-item is walked on the real Your items page (its markup and its script) over a stubbed engine, so a change that does not
// stick fails it; update-from-dashboard's stand-in is driven through its routes with the engine's own updater behind them; the
// restore comparison and the runner's Terminal steps are exercised on their own.

import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { journeyChecks, runJourney, COMMAND_OUTPUT, type Command, type ElementInfo, type Journey, type JourneyDriver, type PageEvents } from '../scripts/release-check/journey.ts';
import { PROBE_SOURCE, type WireTarget } from '../scripts/release-check/probe.ts';
import { JOURNEYS, selectJourneys } from '../scripts/release-check/journeys.ts';
import { evaluateRestore } from '../scripts/release-check/restore.ts';
import { startUpdateStandIn, STAND_IN_FROM, STAND_IN_TO, standInInstaller } from '../scripts/release-check/update-stand-in.ts';
import type { ItemRow, StateSnapshot } from '../scripts/release-check/upgrade.ts';
import { renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';
import { DASHBOARD_PRIVACY_ITEMS_PATHS } from '../src/workers/dashboard/pages/privacy-items.ts';
import { DASHBOARD_PRIVACY_ITEMS_COPY as ITEMS } from '../src/workers/dashboard/vocabulary.ts';
import { DASHBOARD_SELF_UPDATE_PATHS } from '../src/workers/http.ts';
import { flushMicrotasks, waitFor } from './helpers/test-clock.ts';

/** A clock that moves 7 s per read and never sleeps, so a step that never reaches its outcome gives up at once. */
const fast = () => ({ now: ((): (() => number) => { let t = 0; return () => (t += 7_000); })(), sleep: async () => { await flushMicrotasks(); } });
const find = (id: string): Journey => JOURNEYS.find((journey) => journey.id === id)!;

function evalIn(window: Window, code: string): unknown {
  const globals = window as unknown as { __rc?: unknown };
  return new Function('window', 'document', 'getComputedStyle', 'NodeFilter', '__rc', `return (${code});`)(window, window.document, window.getComputedStyle.bind(window), (window as any).NodeFilter, globals.__rc);
}

/** One page in a DOM (no framed panel), whose content a subclass draws; clicks reach the page's own handlers. */
class PageDriver implements JourneyDriver {
  window = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  path = '/dashboard';
  events: PageEvents = { console: [], requests: [] };
  commands: Command[] = [];
  answer: (command: Command) => { code: number; output: string } = () => ({ code: 0, output: '' });
  protected prepare(): void {
    const place = function (this: any) {
      const hidden = this.hasAttribute?.('hidden') || this.closest?.('[hidden]');
      return hidden ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } : { left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34 };
    };
    (this.window.Element.prototype as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = place;
    evalIn(this.window, PROBE_SOURCE);
  }
  async hasPanel(): Promise<boolean> { return false; }
  async probe(_frame: 'host' | 'panel', call: string): Promise<unknown> { return evalIn(this.window, call); }
  async click(_frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const info = evalIn(this.window, `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (!info) return null;
    evalIn(this.window, `__rc.element(${JSON.stringify(target)}).click()`);
    await flushMicrotasks();
    return info;
  }
  async type(): Promise<boolean> { return false; }
  async open(): Promise<void> { /* subclasses draw */ }
  async go(path: string): Promise<void> { this.path = path; }
  async reload(): Promise<void> { /* subclasses draw */ }
  async setViewport(): Promise<void> {}
  async where(): Promise<string> { return this.path; }
  async pages(): Promise<number> { return 1; }
  async screenshot(): Promise<boolean> { return true; }
  drainEvents(): PageEvents { const out = this.events; this.events = { console: [], requests: [] }; return out; }
  async command(command: Command): Promise<{ code: number; output: string }> { this.commands.push(command); return this.answer(command); }
}

interface Item { item_id: string; source: string; family: string; title: string; sender: string | null; location: string | null; tier: string; owner_set: boolean; judge_reason: string | null; decided_at: string; preview: string }
const item = (id: string, tier: 'Personal' | 'Private'): Item => ({ item_id: id, source: 'readwise', family: 'document', title: `Item ${id}`, sender: null, location: null, tier, owner_set: false, judge_reason: 'ordinary:0.9', decided_at: '2026-11-06T09:12:00.000Z', preview: `What ${id} says.` });

/**
 * The Privacy page and Your items as the engine serves them, over a stubbed engine that keeps its items across reloads. `forgets`:
 * the engine answers that the change was made but keeps nothing, so the next load shows the judge's label again.
 */
class YourItemsDriver extends PageDriver {
  private readonly saved: Item[];
  private items: Item[];
  constructor(items: Item[], private readonly faults: { forgets?: boolean } = {}) {
    super();
    this.saved = items.map((one) => ({ ...one }));
    this.items = items.map((one) => ({ ...one }));
  }
  private draw(): void {
    this.window = new Window({ url: `http://127.0.0.1:8010${this.path}` });
    if (this.path.includes('privacy-items')) {
      this.items = this.saved.map((one) => ({ ...one }));
      const html = renderDashboardLocalPage('privacy_items', { url: new URL(`http://127.0.0.1:8010${this.path}`), options: { controlSessionCsrfToken: 'csrf', outsideHelpLocalSession: true } });
      const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>')).replace(/^<body[^>]*>/, '');
      this.window.document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/g, '');
      this.prepare();
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes('[data-privacy-items]'))!;
      const page = { location: this.window.location, setTimeout: () => 0, clearTimeout: () => undefined, matchMedia: () => ({ matches: false }) };
      new Function('window', 'document', 'fetch', script)(page, this.window.document, (path: string, init: { body: string }) => this.engine(path, JSON.parse(init.body)));
    } else {
      // The Privacy page: its tabs (the Inbox below them is not under test here).
      this.window.document.body.innerHTML = `<nav class="ptabs"><a class="ptab on" href="/dashboard?private-answers">Private questions</a><a class="ptab" href="/dashboard?privacy-items">${ITEMS.tab}</a></nav>`;
      this.prepare();
      this.window.document.querySelector('a[href="/dashboard?privacy-items"]')!.addEventListener('click', (event) => { event.preventDefault(); this.path = '/dashboard?privacy-items'; this.draw(); });
    }
  }
  private async engine(path: string, request: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    let result: unknown;
    if (path === DASHBOARD_PRIVACY_ITEMS_PATHS.find) {
      const filter = request.filter;
      result = {
        ok: true,
        items: this.items.filter((one) => filter === undefined || (filter === 'changed' ? one.owner_set : one.tier === (filter === 'personal' ? 'Personal' : 'Private'))),
        counts: { personal: this.items.filter((one) => one.tier === 'Personal').length, private: this.items.filter((one) => one.tier === 'Private').length, changed: this.items.filter((one) => one.owner_set).length },
      };
    } else {
      const one = this.items.find((candidate) => candidate.item_id === request.item_id)!;
      Object.assign(one, { tier: request.tier === 'personal' ? 'Personal' : 'Private', owner_set: true });
      if (!this.faults.forgets) Object.assign(this.saved.find((candidate) => candidate.item_id === one.item_id)!, { tier: one.tier, owner_set: true });
      result = { ok: true, item: { ...one }, changed: 'set', applies: 'now', results: [] };
    }
    return { ok: true, status: 200, json: async () => result };
  }
  override async open(): Promise<void> { this.path = '/dashboard?private-answers'; this.draw(); }
  override async reload(): Promise<void> { this.draw(); }
  override async click(frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const info = await super.click(frame, target);
    // The page's own fetches answer on later turns; let them land as a browser would before the outcome is read.
    for (let i = 0; i < 5; i += 1) await flushMicrotasks();
    return info;
  }
}

describe('fix-one-item, on the real Your items page', () => {
  test('passes when the label the owner sets is kept across a reload, both ways, and the change is listed as theirs', async () => {
    const driver = new YourItemsDriver([item('a', 'Personal'), item('b', 'Private'), item('c', 'Personal')]);
    const trace = await runJourney(driver, find('fix-one-item'), fast());
    expect(trace.steps.filter((step) => !step.ok).map((step) => `${step.name}: ${step.actual}`)).toEqual([]);
    expect(trace.ok).toBe(true);
    // The item the owner changed is the first Personal one, and it ends Personal, set by the owner.
    expect(trace.steps.find((step) => step.name === 'Make it Private')!.actual).toContain('listed as Private, Changed by you');
  });

  test('FAILS at the reload when the engine says the change was made but keeps nothing', async () => {
    const trace = await runJourney(new YourItemsDriver([item('a', 'Personal'), item('b', 'Private')], { forgets: true }), find('fix-one-item'), fast());
    expect(trace.ok).toBe(false);
    const failed = trace.steps.find((step) => !step.ok)!;
    expect(failed.name).toBe('Show the items changed by you: it is there, still Private');
    expect(failed.actual).toContain('the item is not listed');
  });

  test('FAILS when there is no Personal item to correct, rather than passing on nothing', async () => {
    const trace = await runJourney(new YourItemsDriver([item('b', 'Private')]), find('fix-one-item'), fast());
    expect(trace.ok).toBe(false);
    expect(trace.steps.find((step) => !step.ok)!.name).toBe('Show only Personal items');
  });
});

describe('the update stand-in, with the engine\'s own updater behind it', () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });
  const call = async (base: string, path: string, csrf = 'release-check-stand-in') => {
    const response = await fetch(new URL(path, base), { method: 'POST', headers: { 'X-Olympus-CSRF': csrf } });
    return response.status === 502 ? { status: 502 as const } : { status: response.status, body: await response.json() as { ok: boolean; update?: { state: string; reason?: string; version?: string } } };
  };
  const settle = async (base: string, until: (state: string) => boolean) => await waitFor(async () => {
    const got = await call(base, DASHBOARD_SELF_UPDATE_PATHS.status);
    return 'body' in got && got.body.update && until(got.body.update.state) ? got.body.update : undefined;
  }, { timeoutMs: 15_000, intervalMs: 100, description: 'the update settles' });

  test('the installer it serves carries complete release pins and says what the outcome is', () => {
    expect(standInInstaller(STAND_IN_TO, 'rolled-back')).toContain('Previous installation restoration proved healthy.');
    expect(standInInstaller(STAND_IN_TO, 'done')).toMatch(/OLYMPUS_VERSION=1\.5\.1\n/);
  });

  test('offers the update, puts the previous version back when the new one does not start, runs the new one when it does, and refuses a bad signature', async () => {
    const standIn = startUpdateStandIn({ installerPauseS: 0 });
    stop = standIn.stop;
    const page = await (await fetch(`${standIn.url}?outcome=rolled-back`)).text();
    expect(page).toContain(`Olympus ${STAND_IN_TO} is available.`);
    expect(page).toContain('data-update-now');
    expect((await call(standIn.url, DASHBOARD_SELF_UPDATE_PATHS.start, 'wrong')).status).toBe(403);
    const started = await call(standIn.url, DASHBOARD_SELF_UPDATE_PATHS.start);
    expect(started).toMatchObject({ status: 200, body: { ok: true, update: { state: 'running', from: STAND_IN_FROM, to: STAND_IN_TO } } });
    expect(await settle(standIn.url, (state) => state !== 'running')).toMatchObject({ state: 'rolled_back', from: STAND_IN_FROM, to: STAND_IN_TO });

    await fetch(`${standIn.url}?outcome=done`);
    await call(standIn.url, DASHBOARD_SELF_UPDATE_PATHS.start);
    expect(await settle(standIn.url, (state) => state !== 'running')).toMatchObject({ state: 'done', version: STAND_IN_TO });

    await fetch(`${standIn.url}?outcome=bad-signature`);
    await call(standIn.url, DASHBOARD_SELF_UPDATE_PATHS.start);
    expect(await settle(standIn.url, (state) => state !== 'running')).toMatchObject({ state: 'failed', reason: 'bad_signature' });
  });
});

describe('the restore comparison', () => {
  const rows: ItemRow[] = [
    { store: 'readwise', id: 'r1', tier: 'personal', tombstoned: 0, contentHash: 'h1', metadataTier: 'personal', contentTier: 'personal' },
    { store: 'readwise', id: 'r2', tier: 'private', tombstoned: 0, contentHash: 'h2', metadataTier: 'private', contentTier: 'private' },
  ];
  const snapshot = (over: Partial<StateSnapshot> = {}): StateSnapshot => ({
    version: '1.5.0', build: 'b', engineState: 'running', installId: 'first', relayConnected: true,
    policy: { sha256: 'x', json: { retrieval: { a: 1 } }, backups: [] }, configFiles: [], workerEnvKeys: [], tierRuleIds: ['rule-1', 'rule-2'],
    connections: ['c1'], items: rows, dashboard: null, ...over,
  });

  test('passes when the clean machine holds the same stores, rules and settings, whatever its own relay identity and connections', () => {
    const checks = evaluateRestore(snapshot(), snapshot({ installId: 'second', connections: [] }));
    expect(checks.filter((check) => check.status !== 'pass')).toEqual([]);
    expect(checks.map((check) => check.id)).toEqual(['restore.engine-running', 'restore.sources', 'restore.owner-rules', 'restore.privacy-settings', 'restore.stores']);
  });

  test('FAILS for a lost rule, a lost source, a changed judgment, different settings, or nothing to compare', () => {
    const failed = (after: Partial<StateSnapshot>, before: Partial<StateSnapshot> = {}) => evaluateRestore(snapshot(before), snapshot(after)).filter((check) => check.status === 'fail').map((check) => check.id);
    expect(failed({ tierRuleIds: ['rule-1'] })).toEqual(['restore.owner-rules']);
    expect(failed({ items: [] })).toEqual(['restore.sources', 'restore.stores']);
    expect(failed({ items: [rows[0]!, { ...rows[1]!, contentTier: 'personal' }] })).toEqual(['restore.stores']);
    expect(failed({ policy: { sha256: 'y', json: { retrieval: { a: 2 } }, backups: [] } })).toEqual(['restore.privacy-settings']);
    expect(failed({ engineState: 'stopped' })).toEqual(['restore.engine-running']);
    expect(failed({}, { tierRuleIds: [], items: [] })).toEqual(['restore.sources', 'restore.owner-rules', 'restore.stores']);
  });
});

describe('Terminal steps and the restore leg\'s journeys', () => {
  const terminal: Journey = {
    id: 'terminal', title: 'A command runs', source: 'test',
    steps: [{ name: 'Back up', do: { run: { argv: ['data', 'backup'], stdin: 'secret words\n' } }, expect: [{ exit: 0 }, { output: /\.olympusbackup/ }] }],
  };

  test('a command\'s exit status and output are its step\'s outcomes; what it was typed is never in the trace', async () => {
    const driver = new PageDriver();
    driver.answer = () => ({ code: 0, output: 'wrote /home/o/rc/restore/olympus-backup-2026-11-10-1200.olympusbackup' });
    const trace = await runJourney(driver, terminal, fast());
    expect(trace.ok).toBe(true);
    expect(driver.commands).toEqual([{ argv: ['data', 'backup'], stdin: 'secret words\n' }]);
    expect(trace.steps[0]!.action).toBe('run "olympus data backup", typing what it asks for');
    expect(JSON.stringify(trace)).not.toContain('secret words');
  });

  test('FAILS on a non-zero exit, on output without what it must print, and where there is no machine to run on', async () => {
    const failing = new PageDriver();
    failing.answer = () => ({ code: 3, output: 'This computer already holds Olympus data for readwise, so nothing was restored.' });
    const trace = await runJourney(failing, terminal, fast());
    expect(trace.ok).toBe(false);
    expect(journeyChecks([trace])[0]!.detail).toContain('it exited 3');
    const noMachine = new PageDriver();
    (noMachine as { command?: unknown }).command = undefined;
    const none = await runJourney(noMachine, terminal, fast());
    expect(none.steps[0]!.actual).toBe('this browser has no machine to run a command on');
    expect(COMMAND_OUTPUT).toBe('commandOutput');
  });

  test('the restore journeys are walked only by the restore leg, each on its own machine', () => {
    const main = selectJourneys().map((journey) => journey.id);
    expect(main).toContain('fix-one-item');
    expect(main).toContain('update-from-dashboard');
    expect(main).not.toContain('backup-for-restore');
    expect(main).not.toContain('restore-clean-machine');
    expect(selectJourneys(undefined, [], 'restore-from').map((journey) => journey.id)).toEqual(['backup-for-restore']);
    expect(selectJourneys(undefined, [], 'restore-to').map((journey) => journey.id)).toEqual(['restore-clean-machine']);
    // The clean machine looks for the item fix-one-item changed on the first one, and the backup carries the passphrase in, never a flag.
    const restore = find('restore-clean-machine');
    expect(restore.steps.at(-1)!.name).toContain('the owner\'s decision came back');
    // The engine owns the stores; the worker service commands are refused beside it.
    const commands = restore.steps.flatMap((step) => ('run' in step.do ? [step.do.run.argv.slice(0, 2).join(' ')] : []));
    expect(commands).toEqual(['engine stop', 'data restore', 'engine start']);
    for (const step of [...find('backup-for-restore').steps, ...restore.steps]) {
      if ('run' in step.do) expect(step.do.run.argv.join(' ')).not.toContain('passphrase for');
    }
  });
});
