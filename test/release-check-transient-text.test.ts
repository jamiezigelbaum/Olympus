import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { runJourney, type ElementInfo, type JourneyDriver, type PageEvents } from '../scripts/release-check/journey.ts';
import { JOURNEYS } from '../scripts/release-check/journeys.ts';
import { PROBE_SOURCE, type WireTarget } from '../scripts/release-check/probe.ts';
import { DASHBOARD_PRIVACY_ITEMS_PATHS, PRIVACY_ITEMS_TOAST_MS, privacyItemsClientScript, renderDashboardPrivacyItemsPage } from '../src/workers/dashboard/pages/privacy-items.ts';
import { DASHBOARD_PRIVACY_ITEMS_COPY as ITEMS } from '../src/workers/dashboard/vocabulary.ts';
import { createTestClock, flushMicrotasks } from './helpers/test-clock.ts';

/** The real Your items controller, with only its engine replies, browser layout and clock replaced. */
class SaveDriver implements JourneyDriver {
  readonly window = new Window({ url: 'http://localhost/dashboard?privacy-items' });
  readonly clock = createTestClock(0);
  readonly item = { item_id: 'one', source: 'readwise', family: 'document', title: 'One item', tier: 'Personal', owner_set: false };
  saves = 0;
  firstObservationAt: number | undefined;
  toastWasVisible = false;
  toastExpired = false;
  private observed = false;

  constructor(private readonly fails = false, private readonly saveDelayMs = 0, private readonly delayObservation = true) {
    const html = renderDashboardPrivacyItemsPage({ controlSessionCsrfToken: 'csrf', outsideHelpLocalSession: true });
    this.window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
    // happy-dom has no layout or user-agent rule for [hidden].
    this.window.document.head.insertAdjacentHTML('beforeend', '<style>[hidden] { display: none !important; }</style>');
    const Rect = this.window.DOMRect;
    this.window.Element.prototype.getBoundingClientRect = function () {
      const hidden = this.closest('[hidden]');
      return new Rect(0, 0, hidden ? 0 : 120, hidden ? 0 : 24);
    };
    this.eval(PROBE_SOURCE);
    const page = {
      location: this.window.location,
      matchMedia: () => ({ matches: false }),
      setTimeout: (callback: () => void, ms: number) => this.clock.setTimeout(() => {
        if (ms === PRIVACY_ITEMS_TOAST_MS) this.toastWasVisible = !this.window.document.querySelector('[data-pi-toast]')!.hasAttribute('hidden');
        callback();
        if (ms === PRIVACY_ITEMS_TOAST_MS) this.toastExpired = this.window.document.querySelector('[data-pi-toast]')!.hasAttribute('hidden');
      }, ms),
      clearTimeout: this.clock.clearTimeout,
    };
    new Function('window', 'document', 'fetch', privacyItemsClientScript({ csrfToken: 'csrf', unlockOnly: false }))(
      page, this.window.document, async (path: string) => {
        if (path === DASHBOARD_PRIVACY_ITEMS_PATHS.find) return { ok: true, json: async () => ({ ok: true, items: [{ ...this.item }], counts: { personal: 1, private: 0, changed: 0 } }) };
        expect(path).toBe(DASHBOARD_PRIVACY_ITEMS_PATHS.set);
        this.saves += 1;
        if (this.saveDelayMs) await this.clock.sleep(this.saveDelayMs);
        if (this.fails) return { ok: false, json: async () => ({ ok: false, message: 'Save refused' }) };
        Object.assign(this.item, { tier: 'Private', owner_set: true });
        return { ok: true, json: async () => ({ ok: true, item: { ...this.item }, applies: 'now' }) };
      },
    );
  }

  eval(code: string): unknown {
    return new Function('window', 'document', 'getComputedStyle', 'NodeFilter', '__rc', `return (${code});`)(
      this.window, this.window.document, this.window.getComputedStyle.bind(this.window), this.window.NodeFilter, (this.window as any).__rc,
    );
  }
  async prepare(): Promise<void> {
    await flushMicrotasks();
    await this.click('host', { css: '[data-pi-item="one"]' });
  }
  async hasPanel(): Promise<boolean> { return false; }
  async probe(_frame: 'host' | 'panel', call: string): Promise<unknown> {
    if (this.saves && !this.observed) {
      this.observed = true;
      if (this.delayObservation) await this.clock.advance(this.saveDelayMs + PRIVACY_ITEMS_TOAST_MS + 1);
      this.firstObservationAt = this.clock.now();
    }
    return this.eval(call);
  }
  async click(_frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const info = this.eval(`__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (info && !info.disabled) this.eval(`__rc.element(${JSON.stringify(target)}).click()`);
    await flushMicrotasks();
    return info;
  }
  async type(): Promise<boolean> { return false; }
  async open(): Promise<void> {}
  async go(): Promise<void> {}
  async reload(): Promise<void> {}
  async setViewport(): Promise<void> {}
  async where(): Promise<string> { return '/dashboard?privacy-items'; }
  async pages(): Promise<number> { return 1; }
  async screenshot(): Promise<boolean> { return false; }
  drainEvents(): PageEvents { return { console: [], requests: [] }; }
  async close(): Promise<void> { await this.window.happyDOM.close(); }
}

async function save(driver: SaveDriver, pollAdvanceMs = 0) {
  await driver.prepare();
  const step = JOURNEYS.find((journey) => journey.id === 'fix-one-item')!.steps.find((step) => step.name === 'Make it Private')!;
  return runJourney(driver, {
    id: 'transient-save', title: 'Save one item', source: '#1324',
    steps: [{ ...step, remember: { itemId: { attrOf: { css: '[data-pi-item]' }, attr: 'data-pi-item', frame: 'host' } } }],
  }, { now: driver.clock.now, sleep: (ms) => driver.clock.advance(Math.max(ms, pollAdvanceMs)) });
}

describe('journey save confirmations with the real page controller', () => {
  test('passes when the 6-second success toast expires before the first observation', async () => {
    const driver = new SaveDriver();
    try {
      const trace = await save(driver);
      expect(driver.firstObservationAt).toBe(6_001);
      expect(driver.toastWasVisible).toBe(true);
      expect(driver.toastExpired).toBe(true);
      expect(String(driver.eval('__rc.visibleText()'))).not.toContain(ITEMS.toastPrivate);
      expect(trace.steps[0]!.actual).toContain('listed as Private, Changed by you');
      expect(trace.ok).toBe(true);
      expect(driver.eval('__rc.sawText("0:0")')).toBe(false); // The completed step released its observer and receipt.
    } finally { await driver.close(); }
  });

  test('fails on a save error without recording a success', async () => {
    const driver = new SaveDriver(true);
    try {
      const trace = await save(driver, 130_000);
      expect(trace.ok).toBe(false);
      expect(trace.steps[0]!.expected).toContain(ITEMS.toastPrivate);
      expect(trace.steps[0]!.actual).toContain('it does not');
      expect(driver.toastWasVisible).toBe(false);
      expect(driver.toastExpired).toBe(false);
      expect(driver.item).toMatchObject({ tier: 'Personal', owner_set: false });
    } finally { await driver.close(); }
  });

  test('waits for a forwarded save near the 120-second deadline', async () => {
    const driver = new SaveDriver(false, 119_900, false);
    try {
      const trace = await save(driver);
      expect(driver.clock.now()).toBeGreaterThanOrEqual(119_900);
      expect(trace.ok).toBe(true);
    } finally { await driver.close(); }
  });

  test('a latched success still fails if the current row loses its saved state', async () => {
    const driver = new SaveDriver();
    const probe = driver.probe.bind(driver);
    driver.probe = async (frame, call) => {
      const result = await probe(frame, call);
      if (driver.toastExpired) driver.window.document.querySelector('[data-pi-item] .pipill.Private')?.classList.remove('Private');
      return result;
    };
    try {
      const trace = await save(driver, 130_000);
      expect(driver.toastExpired).toBe(true);
      expect(trace.ok).toBe(false);
      expect(trace.steps[0]!.actual).toContain('it appeared after the action');
      expect(trace.steps[0]!.actual).not.toContain('listed as Private, Changed by you');
    } finally { await driver.close(); }
  });

  test('every journey save confirmation opts into latching and the forwarding budget', () => {
    const confirmations = new Set(['Privacy saved.', ITEMS.toastPrivate, ITEMS.toastPersonal]);
    const steps = JOURNEYS.flatMap((journey) => journey.steps).filter((step) => step.expect.some((expectation) => 'text' in expectation && confirmations.has(String(expectation.text))));
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step.timeoutMs).toBeGreaterThan(120_000);
      expect(step.expect.some((expectation) => 'text' in expectation && expectation.transient)).toBe(true);
    }
  });
});
