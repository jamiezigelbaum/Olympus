// The journey runner and the visual comparison: a journey must FAIL when the outcome its action should have is absent, the generic
// rules must catch a broken page, and a changed picture must fail its check. The runner is exercised on a DOM (happy-dom) through the
// same page-side script the machine's browser runs.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PNG } from 'pngjs';
import { journeyChecks, runJourney, type ElementInfo, type Journey, type JourneyDriver, type PageEvents } from '../scripts/release-check/journey.ts';
import { PROBE_SOURCE, describeTarget, type WireTarget } from '../scripts/release-check/probe.ts';
import { JOURNEYS, selectJourneys } from '../scripts/release-check/journeys.ts';
import { DASHBOARD_CHATGPT_PAGE_COPY as PANEL } from '../src/workers/dashboard/vocabulary.ts';
import { DEFAULT_TOLERANCE, SCREENS, compareImages, APPROVAL_FILE, approvalDigestOf, compareScreens, maskScript, normaliseDynamicText, screenName, visualChecks } from '../scripts/release-check/visual.ts';
import { parseCli } from '../scripts/release-check/run.ts';
import { buildReport, renderHtml, type MachineReport } from '../scripts/release-check/report.ts';

/** Runs page-side source in a happy-dom window the way Runtime.evaluate does in a browser (happy-dom has no eval of its own). */
function evalIn(window: Window, code: string): unknown {
  const globals = window as unknown as { __rc?: unknown };
  return new Function('window', 'document', 'getComputedStyle', 'NodeFilter', '__rc', `return (${code});`)(window, window.document, window.getComputedStyle.bind(window), (window as any).NodeFilter, globals.__rc);
}

/** A page in a DOM, with the pages a journey moves between, and a "pressing this control does that" hook per control. */
class DomDriver implements JourneyDriver {
  /** The dashboard's panel (where the content is) and the host page around it (which holds only the frame). */
  readonly window = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  readonly host = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  private frameOf(frame: 'host' | 'panel'): Window { return frame === 'host' ? this.host : this.window; }
  events: PageEvents = { console: [], requests: [] };
  pagesOpen = 1;
  path = '/dashboard';
  /** What pressing a control (by its name) does to the page. */
  onPress = new Map<string, (document: Window['document']) => void>();
  constructor(readonly pagesByPath: Record<string, string>) {
    const place = function (this: any) {
      const hidden = this.hasAttribute?.('hidden') || /display:\s*none/.test(this.getAttribute?.('style') ?? '');
      return hidden ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } : { left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34 };
    };
    for (const window of [this.window, this.host]) (window.Element.prototype as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = place;
  }
  show(path: string): void {
    this.window.document.body.innerHTML = this.pagesByPath[path] ?? '<p>not found</p>';
    this.path = path;
    this.host.document.body.innerHTML = '<iframe id="olympus-panel"></iframe>';
    evalIn(this.window, PROBE_SOURCE);
    evalIn(this.host, PROBE_SOURCE);
  }
  async hasPanel(): Promise<boolean> { return true; }
  async probe(frame: 'host' | 'panel', call: string): Promise<unknown> { return evalIn(this.frameOf(frame), call); }
  async click(frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const info = evalIn(this.frameOf(frame), `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (!info) return null;
    evalIn(this.frameOf(frame), `__rc.element(${JSON.stringify(target)}).click()`);
    this.onPress.get(String(info.name || info.text))?.(this.window.document);
    return info;
  }
  async type(frame: 'host' | 'panel', target: WireTarget, text: string): Promise<boolean> {
    return evalIn(this.frameOf(frame), `(() => { const el = __rc.element(${JSON.stringify(target)}); if (!el) return false; el.value = ${JSON.stringify(text)}; return true; })()`) === true;
  }
  async open(): Promise<void> { this.show('/dashboard'); }
  async go(path: string): Promise<void> { this.show(path); }
  async reload(): Promise<void> { this.show(this.path); }
  async setViewport(): Promise<void> {}
  async where(): Promise<string> { return this.path; }
  async pages(): Promise<number> { return this.pagesOpen; }
  async screenshot(): Promise<boolean> { return true; }
  drainEvents(): PageEvents {
    const out = this.events;
    this.events = { console: [], requests: [] };
    return out;
  }
}

/** A clock that moves 7 s per read and never sleeps, so a step that never reaches its outcome gives up at once. */
const options = () => ({ now: ((): (() => number) => { let t = 0; return () => (t += 7_000); })(), sleep: async () => {} });

const GOOD_DASHBOARD = `<main><h1>Olympus</h1><section><h2>Sources</h2>
  <div class="row"><span>Readwise</span> <span>Working</span><button aria-label="${PANEL.moreActions.replace('{source}', 'Readwise')}">...</button></div>
  <div class="row"><span>Files on this computer</span><button>Connect</button></div></section></main>`;

describe('journey runner', () => {
  const saveJourney: Journey = {
    id: 'save', title: 'Saving shows the saved note', source: 'test',
    steps: [
      { name: 'Open', do: { open: 'dashboard' }, expect: [{ text: 'Notes' }] },
      { name: 'Press Save', do: { click: { role: 'button', name: 'Save' } }, expect: [{ text: 'Saved' }, { noText: 'Not saved' }], timeoutMs: 20_000 },
    ],
  };

  test('passes when pressing the control has the outcome, and records a trace with the action and the outcome', async () => {
    const driver = new DomDriver({ '/dashboard': '<h2>Notes</h2><button>Save</button>' });
    driver.onPress.set('Save', (document) => { document.body.insertAdjacentHTML('beforeend', '<p>Saved</p>'); });
    const trace = await runJourney(driver, saveJourney, options());
    expect(trace.ok).toBe(true);
    expect(trace.steps.map((step) => step.n)).toEqual([1, 2]);
    expect(trace.steps[1]!.action).toBe('click button "Save"');
    expect(trace.steps[1]!.expected).toContain('"Saved"');
    expect(trace.steps[1]!.screenshot).toBe('save/02-press-save.jpg');
    expect(journeyChecks([trace])[0]).toMatchObject({ id: 'journey.save', status: 'pass' });
  });

  test('FAILS when the control does nothing: the outcome is absent, and the trace says what was expected and what was there', async () => {
    const driver = new DomDriver({ '/dashboard': '<h2>Notes</h2><button>Save</button><p>Not saved</p>' });
    const trace = await runJourney(driver, saveJourney, options());
    expect(trace.ok).toBe(false);
    const failed = trace.steps[1]!;
    expect(failed.ok).toBe(false);
    expect(failed.expected).toContain('"Saved"');
    expect(failed.inventory?.controls.join(' ')).toContain('button: Save');
    const check = journeyChecks([trace])[0]!;
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('step 2');
  });

  test('FAILS when the control cannot be found, and never goes around it', async () => {
    const driver = new DomDriver({ '/dashboard': '<h2>Notes</h2>' });
    const trace = await runJourney(driver, saveJourney, options());
    expect(trace.ok).toBe(false);
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1]!.ok).toBe(false);
  });

  test('generic rules: undefined, NaN, an unnamed button, a console error and a failed request each fail a step that expects something else', async () => {
    const driver = new DomDriver({ '/dashboard': '<h2>Notes</h2><p>You have undefined items and NaN% done</p><button></button>' });
    const journey: Journey = { id: 'rules', title: 'rules', source: 'test', steps: [{ name: 'Open', do: { open: 'dashboard' }, expect: [{ text: 'Notes' }] }] };
    const original = driver.open.bind(driver);
    driver.open = async () => {
      await original();
      driver.events = { console: ['TypeError: x is not a function'], requests: [{ url: '/v1/thing', status: 500, text: 'GET /v1/thing' }] };
    };
    const trace = await runJourney(driver, journey, options());
    const findings = trace.steps[0]!.findings.join(' | ');
    expect(trace.ok).toBe(false);
    expect(findings).toContain('placeholder');
    expect(findings).toContain('no name');
    expect(findings).toContain('console error');
    expect(findings).toContain('failed request');
  });

  test('a declared request is allowed, and a favicon never counts', async () => {
    const driver = new DomDriver({ '/dashboard': '<h2>Notes</h2>' });
    const journey: Journey = { id: 'allowed', title: 'allowed', source: 'test', steps: [{ name: 'Open', do: { open: 'dashboard' }, expect: [{ text: 'Notes' }], allowRequests: [{ url: /\/v1\/health/, status: 404 }] }] };
    const original = driver.open.bind(driver);
    driver.open = async () => {
      await original();
      driver.events = { console: [], requests: [{ url: '/v1/health', status: 404, text: 'GET /v1/health' }, { url: '/favicon.ico', status: 404, text: 'GET /favicon.ico' }] };
    };
    expect((await runJourney(driver, journey, options())).ok).toBe(true);
  });

  test('a count outcome fails when the number of rows did not change by exactly the delta', async () => {
    const rows = (n: number) => `<ul>${Array.from({ length: n }, (_, i) => `<li role="row">row ${i}</li>`).join('')}</ul><button>Delete</button>`;
    const journey: Journey = { id: 'del', title: 'delete one', source: 'test', steps: [
      { name: 'Open', do: { open: 'dashboard' }, expect: [{ count: { role: 'row' }, atLeast: 2 }] },
      { name: 'Delete one', do: { click: { role: 'button', name: 'Delete' } }, remember: { before: { countOf: { role: 'row' } } }, expect: [{ countSince: { target: { role: 'row' }, since: 'before', delta: -1 } }], timeoutMs: 8_000 },
    ] };
    const works = new DomDriver({ '/dashboard': rows(3) });
    works.onPress.set('Delete', (document) => { document.querySelector('li')!.remove(); });
    const good = await runJourney(works, journey, options());
    expect(good.ok).toBe(true);
    const broken = new DomDriver({ '/dashboard': rows(3) });
    broken.onPress.set('Delete', (document) => { document.querySelectorAll('li').forEach((li) => li.remove()); });
    const trace = await runJourney(broken, journey, options());
    expect(trace.ok).toBe(false);
    expect(trace.steps[1]!.ok).toBe(false);
  });

  test('describeTarget names a control the way a person would', () => {
    expect(describeTarget({ role: 'button', name: 'Save', within: { css: 'section' } })).toBe('button "Save" in element [section]');
  });
});

describe('the shipped journeys, on a DOM', () => {
  const find = (id: string): Journey => JOURNEYS.find((journey) => journey.id === id)!;

  test('sources-healthy passes on a healthy Sources page and FAILS when the Files on this computer card is gone', async () => {
    const good = await runJourney(new DomDriver({ '/dashboard': GOOD_DASHBOARD }), find('sources-healthy'), options());
    expect(good.steps[0]!.actual).toContain('Connect');
    expect(good.ok).toBe(true);
    const without = GOOD_DASHBOARD.replace(/<div class="row"><span>Files on this computer.*?<\/div>/s, '');
    const bad = await runJourney(new DomDriver({ '/dashboard': without }), find('sources-healthy'), options());
    expect(bad.ok).toBe(false);
    expect(journeyChecks([bad])[0]!.detail).toContain('Files on this computer');
  });

  test('sources-healthy FAILS when the source shows a stuck state', async () => {
    const stuck = GOOD_DASHBOARD.replace('<span>Readwise</span> <span>Working</span>', '<span>Readwise — Needs you</span>');
    const bad = await runJourney(new DomDriver({ '/dashboard': stuck }), find('sources-healthy'), options());
    expect(bad.ok).toBe(false);
  });

  test('no-public-tier FAILS on any page that shows a Public card', async () => {
    const clean: Record<string, string> = Object.fromEntries(['/dashboard', '/dashboard?keys', '/dashboard?agents', '/dashboard?private-answers'].map((path) => [path, '<h2>Tiers</h2><p>Personal, Private, Secrets</p>']));
    expect((await runJourney(new DomDriver(clean), find('no-public-tier'), options())).ok).toBe(true);
    const leaky = { ...clean, '/dashboard?agents': '<h2>Tiers</h2><p>Public · S0</p>' };
    const bad = await runJourney(new DomDriver(leaky), find('no-public-tier'), options());
    expect(bad.ok).toBe(false);
    expect(bad.steps.find((step) => !step.ok)!.name).toContain('agents');
  });

  test('every journey has a source, steps with outcomes, and a unique id; the ones that change the install run last', () => {
    const ids = JOURNEYS.map((journey) => journey.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const journey of JOURNEYS) {
      expect(journey.source.length).toBeGreaterThan(10);
      for (const step of journey.steps) if (!('viewport' in step.do)) expect(step.expect.length, `${journey.id} / ${step.name}`).toBeGreaterThan(0);
    }
    const order = selectJourneys().map((journey) => journey.mutates === true);
    expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)));
    expect(selectJourneys(['no-public-tier']).map((journey) => journey.id)).toEqual(['no-public-tier']);
  });
});

function png(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const at = (y * width + x) * 4;
      image.data[at] = r; image.data[at + 1] = g; image.data[at + 2] = b; image.data[at + 3] = 255;
    }
  }
  return PNG.sync.write(image);
}

describe('visual baselines', () => {
  const base = png(100, 100, () => [250, 250, 250]);

  test('an identical picture matches; a missing approved picture, a changed size and an unreadable file are reported as such', () => {
    expect(compareImages(base, base).status).toBe('match');
    expect(compareImages(undefined, base).status).toBe('missing');
    expect(compareImages(png(100, 120, () => [250, 250, 250]), base).status).toBe('size');
    expect(compareImages(Buffer.from('nope'), base).status).toBe('unreadable');
  });

  test('a difference within the tolerance passes and one beyond it FAILS with a diff picture', () => {
    const few = png(100, 100, (x, y) => (x < 3 && y < 3 ? [0, 0, 0] : [250, 250, 250]));
    expect(compareImages(base, few).status).toBe('match');
    const many = png(100, 100, (x) => (x < 20 ? [0, 0, 0] : [250, 250, 250]));
    const result = compareImages(base, many);
    expect(result.status).toBe('different');
    expect(result.diffRatio).toBeGreaterThan(DEFAULT_TOLERANCE.maxDiffRatio);
    expect(result.diffPng).toBeDefined();
  });

  test('compareScreens: a changed screen fails its check, --update-baselines writes a candidate and warns, and the next look matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-visual-'));
    try {
      const actualDir = join(dir, 'actual');
      const baselinesDir = join(dir, 'baselines');
      const outDir = join(dir, 'out');
      for (const folder of [actualDir, baselinesDir, outDir]) mkdirSync(folder, { recursive: true });
      const screen = SCREENS[0]!;
      const name = screenName(screen.id, 1280, 'light');
      const names = [{ name, screen, width: 1280, theme: 'light' }];
      writeFileSync(join(actualDir, `${name}.png`), png(100, 100, (x) => (x < 20 ? [0, 0, 0] : [250, 250, 250])));
      writeFileSync(join(baselinesDir, `${name}.png`), base);
      const failing = compareScreens({ actualDir, baselinesDir, outDir, update: false, names });
      expect(visualChecks(failing)[0]).toMatchObject({ id: `visual.${name}`, status: 'fail' });
      expect(failing.results[0]!.baseline).toBeTruthy();
      expect(existsSync(join(outDir, failing.results[0]!.diff!))).toBe(true);
      expect(readFileSync(join(baselinesDir, `${name}.png`)).equals(base)).toBe(true);

      const updated = compareScreens({ actualDir, baselinesDir, outDir, update: true, names });
      expect(visualChecks(updated)[0]!.status).toBe('warn');
      expect(readFileSync(join(baselinesDir, `${name}.png`)).equals(readFileSync(join(actualDir, `${name}.png`)))).toBe(true);
      expect(visualChecks(compareScreens({ actualDir, baselinesDir, outDir, update: false, names }))[0]!.status).toBe('pass');

      rmSync(join(baselinesDir, `${name}.png`));
      expect(visualChecks(compareScreens({ actualDir, baselinesDir, outDir, update: false, names }))[0]!.status).toBe('fail');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unreadable candidate never replaces an approved picture, even with --update-baselines, and its check fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-visual-'));
    try {
      const actualDir = join(dir, 'actual');
      const baselinesDir = join(dir, 'baselines');
      const outDir = join(dir, 'out');
      for (const folder of [actualDir, baselinesDir, outDir]) mkdirSync(folder, { recursive: true });
      const screen = SCREENS[0]!;
      const name = screenName(screen.id, 1280, 'light');
      const names = [{ name, screen, width: 1280, theme: 'light' }];
      writeFileSync(join(actualDir, `${name}.png`), base.subarray(0, 40));
      writeFileSync(join(baselinesDir, `${name}.png`), base);
      const run = compareScreens({ actualDir, baselinesDir, outDir, update: true, names });
      expect(visualChecks(run)[0]).toMatchObject({ status: 'fail' });
      expect(readFileSync(join(baselinesDir, `${name}.png`)).equals(base)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an approved design change refreshes the references; the same approval with a different look still fails; an unreadable picture still fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-visual-'));
    try {
      const actualDir = join(dir, 'actual');
      const baselinesDir = join(dir, 'baselines');
      const outDir = join(dir, 'out');
      for (const folder of [actualDir, baselinesDir, outDir]) mkdirSync(folder, { recursive: true });
      const screen = SCREENS[0]!;
      const name = screenName(screen.id, 1280, 'light');
      const names = [{ name, screen, width: 1280, theme: 'light' }];
      const changed = png(100, 100, (x) => (x < 20 ? [0, 0, 0] : [250, 250, 250]));
      const before = approvalDigestOf({ design_review: { id: 'a' }, reviewed_states: [{ id: 'panel', rendered_html_sha256: '1' }] });
      const after = approvalDigestOf({ design_review: { id: 'a' }, reviewed_states: [{ id: 'panel', rendered_html_sha256: '2' }] });
      expect(before).not.toBe(after);
      const setUp = (actual: Buffer): void => {
        writeFileSync(join(actualDir, `${name}.png`), actual);
        writeFileSync(join(baselinesDir, `${name}.png`), base);
        writeFileSync(join(baselinesDir, APPROVAL_FILE), JSON.stringify({ approvalDigest: before }));
      };

      // Same approval, different look: a defect, and the reference is untouched.
      setUp(changed);
      const same = compareScreens({ actualDir, baselinesDir, outDir, update: false, approvalDigest: before, names });
      expect(visualChecks(same)[0]).toMatchObject({ status: 'fail' });
      expect(readFileSync(join(baselinesDir, `${name}.png`)).equals(base)).toBe(true);

      // A newer approval: the changed look is reported as approved, shown old and new, and written for commit with the new fingerprint.
      const refreshed = compareScreens({ actualDir, baselinesDir, outDir, update: false, approvalDigest: after, names });
      expect(visualChecks(refreshed)[0]).toMatchObject({ status: 'warn', detail: expect.stringContaining('approved change, references refreshed') });
      expect(refreshed.results[0]!.baseline).toBeTruthy();
      expect(refreshed.results[0]!.approvedRefresh).toBe(true);
      expect(readFileSync(join(baselinesDir, `${name}.png`)).equals(changed)).toBe(true);
      expect(JSON.parse(readFileSync(join(baselinesDir, APPROVAL_FILE), 'utf8')).approvalDigest).toBe(after);
      expect(visualChecks(compareScreens({ actualDir, baselinesDir, outDir, update: false, approvalDigest: after, names }))[0]!.status).toBe('pass');

      // References with no recorded approval cannot be refreshed this way.
      setUp(changed);
      rmSync(join(baselinesDir, APPROVAL_FILE));
      expect(visualChecks(compareScreens({ actualDir, baselinesDir, outDir, update: false, approvalDigest: after, names }))[0]!.status).toBe('fail');

      // A newer approval does not excuse an unreadable picture.
      setUp(base.subarray(0, 40));
      const broken = compareScreens({ actualDir, baselinesDir, outDir, update: false, approvalDigest: after, names });
      expect(visualChecks(broken)[0]!.status).toBe('fail');
      expect(readFileSync(join(baselinesDir, `${name}.png`)).equals(base)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a newer approval is recorded after a complete clean comparison even if nothing changed, and an incomplete or broken run leaves it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-visual-'));
    try {
      const actualDir = join(dir, 'actual');
      const baselinesDir = join(dir, 'baselines');
      const outDir = join(dir, 'out');
      for (const folder of [actualDir, baselinesDir, outDir]) mkdirSync(folder, { recursive: true });
      const names = [SCREENS[0]!, SCREENS[1]!].map((screen) => ({ name: screenName(screen.id, 1280, 'light'), screen, width: 1280, theme: 'light' }));
      const recorded = (): string => JSON.parse(readFileSync(join(baselinesDir, APPROVAL_FILE), 'utf8')).approvalDigest;
      const setUp = (): void => {
        for (const item of names) { writeFileSync(join(actualDir, `${item.name}.png`), base); writeFileSync(join(baselinesDir, `${item.name}.png`), base); }
        writeFileSync(join(baselinesDir, APPROVAL_FILE), JSON.stringify({ approvalDigest: 'old' }));
      };
      const look = (): ReturnType<typeof compareScreens> => compareScreens({ actualDir, baselinesDir, outDir, update: false, approvalDigest: 'new', names });

      setUp();
      look(); // every screen still matches
      expect(recorded()).toBe('new');

      setUp();
      rmSync(join(actualDir, `${names[1]!.name}.png`)); // a screen did not come back
      look();
      expect(recorded()).toBe('old');

      setUp();
      writeFileSync(join(actualDir, `${names[1]!.name}.png`), base.subarray(0, 40)); // unreadable
      look();
      expect(recorded()).toBe('old');

      setUp();
      rmSync(join(baselinesDir, `${names[1]!.name}.png`)); // no reference
      look();
      expect(recorded()).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the Inbox mask hides what varies with the run and keeps the intro paragraph', () => {
    const window = new Window({ url: 'http://127.0.0.1/' });
    window.document.body.innerHTML = '<section class="pasection" aria-labelledby="waiting"><h3 id="waiting">Inbox</h3><p class="pnote" data-pa-none>none</p><p class="pnote" id="intro">Intro</p><ul data-pa-list><li>row</li></ul><div class="pbuttons"><button>Delete all</button></div><p data-pa-older-removed>older</p></section>';
    evalIn(window, maskScript());
    const css = window.document.getElementById('rc-visual-mask')!.textContent!;
    for (const selector of ['[data-pa-none]', '[data-pa-list]', '.pbuttons', '[data-pa-older-removed]']) expect(css).toContain(selector);
    expect(css).not.toContain(':not(h3)');
    expect(window.document.querySelector('#waiting + p[data-pa-none]')).not.toBeNull();
    expect(window.document.querySelector('section.pasection[aria-labelledby="waiting"] > #intro')).not.toBeNull();
    expect(css).not.toMatch(/waiting"\] > p/);
  });

  test('selectJourneys refuses ids it does not know', () => {
    expect(() => selectJourneys(['no-such-journey'])).toThrow(/no-such-journey/);
    expect(() => selectJourneys([JOURNEYS[0]!.id, 'typo'])).toThrow(/typo/);
    expect(selectJourneys([JOURNEYS[0]!.id]).length).toBe(1);
  });

  test('the mask makes the parts that vary between runs the same text, in the page and in plain strings', () => {
    expect(normaliseDynamicText('Updated 106 days ago, 3 min ago, in 14 min, 42% done, 1 unread private answer, 3 of 12 files, 1.2 GB, Oct 22, 2026 at 14:05'))
      .toBe(normaliseDynamicText('Updated 2 days ago, 9 min ago, in 2 min, 7% done, 4 unread private answers, 5 of 12 files, 340 MB, Nov 3, 2026 at 09:50'));
    expect(normaliseDynamicText('Already checking Readwise')).toBe(normaliseDynamicText('Checking Readwise…'));
    expect(normaliseDynamicText('Checking Google Drive…')).toBe('Checking Google Drive…');
    const window = new Window({ url: 'http://127.0.0.1/' });
    window.document.body.innerHTML = '<p>Updated 5 min ago</p><section class="pasection" aria-labelledby="waiting"><h3 id="waiting">Inbox</h3><ul><li>row</li></ul></section>';
    evalIn(window, maskScript());
    expect(window.document.querySelector('p')!.textContent).toBe('Updated 0 min ago');
    expect(evalIn(window, maskScript())).toBe(0);
    expect(window.document.getElementById('rc-visual-mask')!.textContent).toContain('display:none');
  });
});

describe('run options and the report', () => {
  test('--baselines and --update-baselines are parsed, and --update-baselines alone is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-journeys-cli-'));
    try {
      const config = join(dir, 'config.json');
      writeFileSync(config, JSON.stringify({ driver: ['/bin/true'] }));
      const base = ['--config', config, '--candidate', dir, '--out', join(dir, 'out')];
      const parsed = parseCli([...base, '--baselines', join(dir, 'b'), '--update-baselines', '--only-journeys', 'a,b']);
      expect(parsed.baselinesDir).toBe(join(dir, 'b'));
      expect(parsed.updateBaselines).toBe(true);
      expect(parsed.onlyJourneys).toEqual(['a', 'b']);
      expect(parseCli(base).baselinesDir).toBeUndefined();
      expect(() => parseCli([...base, '--update-baselines'])).toThrow('--baselines');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the report page shows each journey step by step with its picture, and the baseline, actual and diff of a failing screen', () => {
    const machine: MachineReport = {
      id: 'm', label: 'VM', os: 'linux', driver: 'd', timings: {}, checks: [], agents: [], screenshots: [], logs: [],
      traces: [{ id: 'save', title: 'Saving', source: 'test', ok: false, ms: 1000, steps: [
        { n: 1, name: 'Open', action: 'open the dashboard', expected: 'Notes', actual: 'it does', ok: true, ms: 500, at: '/dashboard', screenshot: 'save/01-open.jpg', consoleErrors: [], failedRequests: [], findings: [] },
        { n: 2, name: 'Press Save', action: 'click button "Save"', expected: '"Saved"', actual: 'it does not', ok: false, ms: 900, at: '/dashboard', screenshot: 'save/02-press-save.jpg', consoleErrors: ['boom'], failedRequests: ['GET /x -> 500'], findings: [], inventory: { text: 'Notes', controls: ['button: Save'] } },
      ] }],
      visual: [{ screen: 'dashboard', title: 'The dashboard', width: 1280, theme: 'light', comparison: { status: 'different', diffPixels: 900, diffRatio: 0.09, width: 100, height: 100 }, baseline: 'visual/a.baseline.png', actual: 'visual/a.actual.png', diff: 'visual/a.diff.png' }],
    };
    const html = renderHtml(buildReport({ runId: 'r', candidate: { label: 'c' }, startedAt: 'a', finishedAt: 'b', machines: [machine], errors: [] }));
    for (const needle of ['Step-by-step traces', 'traces/save/02-press-save.jpg', 'click button', 'console error', 'boom', 'GET /x -&gt; 500', 'Visual baselines', 'visual/a.baseline.png', 'visual/a.diff.png', 'Approved', 'Difference']) {
      expect(html, needle).toContain(needle);
    }
  });
});
