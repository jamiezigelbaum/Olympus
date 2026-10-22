/**
 * The journey runner's hands and eyes on the machine: a headless Chrome driven over the DevTools Protocol (browser.ts), signed in as
 * the owner (the opening link, then Unlock) and looking at the dashboard page and, inside it, the framed panel.
 *
 * The framed panel is a sandboxed iframe with an opaque origin, so the page cannot reach into it; DevTools can, through the
 * iframe's own execution context. Clicks are real mouse presses at the control's centre (the iframe's offset added), typing is the
 * browser's own text insertion, so the page's own handlers run as they would for a person.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Cdp } from './browser.ts';
import type { ElementInfo, JourneyDriver, OpenPlace, PageEvents } from './journey.ts';
import { PROBE_SOURCE, type WireTarget } from './probe.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DriverSetup {
  cdp: Cdp;
  /** Where the browser's debugging port answers, to count its pages. */
  debugPort: number;
  /** Mints a one-time opening link for a place; the owner's own `olympus dashboard --no-open --target`. */
  mintLink(place: OpenPlace): Promise<string>;
  /** Where screenshots are written. */
  outDir: string;
  /** Called with the origin of each opening link, so a machine's owner-socket bridge can be started on its port. */
  onOrigin?(origin: string): void;
}

interface Context { id: number; frameId: string; isDefault: boolean }

export class CdpJourneyDriver implements JourneyDriver {
  private readonly cdp: Cdp;
  private contexts: Context[] = [];
  private mainFrameId = '';
  private events: PageEvents = { console: [], requests: [] };
  private readonly requests = new Map<string, { url: string; method: string }>();
  private origin = '';
  private width = 1280;
  private theme: 'light' | 'dark' = 'light';

  constructor(private readonly setup: DriverSetup) {
    this.cdp = setup.cdp;
  }

  async start(): Promise<void> {
    const cdp = this.cdp;
    cdp.on('Runtime.executionContextCreated', (params) => {
      const context = params?.context;
      if (!context) return;
      this.contexts.push({ id: context.id, frameId: String(context.auxData?.frameId ?? ''), isDefault: context.auxData?.isDefault === true });
    });
    cdp.on('Runtime.executionContextDestroyed', (params) => { this.contexts = this.contexts.filter((context) => context.id !== params?.executionContextId); });
    cdp.on('Runtime.executionContextsCleared', () => { this.contexts = []; });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params?.type !== 'error') return;
      this.events.console.push((params.args ?? []).map((arg: { value?: unknown; description?: string }) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 400));
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params?.exceptionDetails;
      this.events.console.push(`uncaught: ${String(details?.exception?.description ?? details?.text ?? 'error').split('\n')[0]!.slice(0, 300)}`);
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params?.entry;
      if (entry?.level === 'error') this.events.console.push(`${String(entry.source ?? 'log')}: ${String(entry.text ?? '').slice(0, 300)}${entry.url ? ` (${String(entry.url).slice(0, 120)})` : ''}`);
    });
    cdp.on('Network.requestWillBeSent', (params) => { this.requests.set(String(params?.requestId), { url: String(params?.request?.url ?? ''), method: String(params?.request?.method ?? 'GET') }); });
    cdp.on('Network.responseReceived', (params) => {
      const status = Number(params?.response?.status ?? 0);
      const url = String(params?.response?.url ?? '');
      if (status >= 400 && /^https?:/.test(url)) this.events.requests.push({ url, status, text: `${this.requests.get(String(params?.requestId))?.method ?? 'GET'} ${pathOf(url)}` });
    });
    cdp.on('Network.loadingFailed', (params) => {
      if (params?.canceled) return;
      const known = this.requests.get(String(params?.requestId));
      if (known && /^https?:/.test(known.url)) this.events.requests.push({ url: known.url, status: 0, text: `${known.method} ${pathOf(known.url)}` });
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Log.enable');
    await this.setViewport(1280, 'light');
  }

  // --- frames and the page-side script

  private async refreshMainFrame(): Promise<void> {
    const tree = await this.cdp.send('Page.getFrameTree');
    this.mainFrameId = String(tree?.frameTree?.frame?.id ?? '');
  }

  private contextOf(frame: 'host' | 'panel'): number | undefined {
    const defaults = this.contexts.filter((context) => context.isDefault);
    const chosen = frame === 'host'
      ? defaults.filter((context) => context.frameId === this.mainFrameId)
      : defaults.filter((context) => context.frameId !== this.mainFrameId);
    return chosen[chosen.length - 1]?.id;
  }

  async hasPanel(): Promise<boolean> {
    try {
      if (!this.mainFrameId) await this.refreshMainFrame();
      const present = await this.evalIn('host', `!!document.getElementById('olympus-panel')`);
      return present === true && this.contextOf('panel') !== undefined;
    } catch { return false; }
  }

  private async evalIn(frame: 'host' | 'panel', expression: string): Promise<unknown> {
    if (!this.mainFrameId) await this.refreshMainFrame();
    const contextId = this.contextOf(frame);
    if (frame === 'panel' && contextId === undefined) throw new Error('the dashboard panel is not on the page');
    const result = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId === undefined ? {} : { contextId }) });
    if (result.exceptionDetails) throw new Error(`a page script failed: ${String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 160)}`);
    return result.result?.value;
  }

  async probe(frame: 'host' | 'panel', call: string): Promise<unknown> {
    return await this.evalIn(frame, `${PROBE_SOURCE};\n${call}`);
  }

  // --- input

  private async offset(frame: 'host' | 'panel'): Promise<{ x: number; y: number }> {
    if (frame === 'host') return { x: 0, y: 0 };
    const box = await this.probe('host', `__rc.frameBox('olympus-panel')`) as { x: number; y: number } | null;
    return { x: box?.x ?? 0, y: box?.y ?? 0 };
  }

  private async press(x: number, y: number): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * Finds the control, scrolls it into view (`__rc.find` does), then reads its place again together with the frame's, so the press
   * lands where the control is after every scroll (the panel's own and the page's) has settled.
   */
  private async locate(frame: 'host' | 'panel', target: WireTarget): Promise<{ info: ElementInfo; x: number; y: number } | null> {
    let info = await this.probe(frame, `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (!info) return null;
    const again = await this.probe(frame, `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (again) info = again;
    const offset = await this.offset(frame);
    return { info, x: info.x + offset.x, y: info.y + offset.y };
  }

  async click(frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const at = await this.locate(frame, target);
    if (!at) return null;
    if (at.info.disabled) return at.info;
    await this.press(at.x, at.y);
    return at.info;
  }

  async type(frame: 'host' | 'panel', target: WireTarget, text: string): Promise<boolean> {
    const at = await this.locate(frame, target);
    if (!at || at.info.disabled) return false;
    await this.press(at.x, at.y);
    // The press focused the frame; the field is selected so the text replaces what it held.
    await this.probe(frame, `__rc.focus(${JSON.stringify(target)})`);
    await this.cdp.send('Input.insertText', { text });
    return true;
  }

  // --- the owner's way in, and moving about

  private async waitFor(frame: 'host' | 'panel', expression: string, timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try { if ((await this.probe(frame, expression)) === true) return true; } catch { /* the page is changing */ }
      if (Date.now() >= until) return false;
      await sleep(400);
    }
  }

  private async settleLoad(): Promise<void> {
    this.mainFrameId = '';
    await this.waitFor('host', `document.readyState === 'complete'`, 30_000);
    await this.refreshMainFrame().catch(() => undefined);
  }

  async open(place: OpenPlace): Promise<void> {
    const url = await this.setup.mintLink(place);
    this.origin = new URL(url).origin;
    this.setup.onOrigin?.(this.origin);
    await this.cdp.send('Page.navigate', { url });
    await this.settleLoad();
    if (place === 'private') {
      if (!(await this.waitFor('host', `!!document.querySelector('[data-private-answers]')`, 45_000))) throw new Error('the Private answers page did not open from the owner\'s opening link');
      if ((await this.probe('host', `!!document.querySelector('[data-private-answers] form[data-pa-unlock] button')`)) === true) {
        const info = await this.click('host', { css: '[data-private-answers] form[data-pa-unlock] button' });
        if (!info) throw new Error('the page\'s Unlock button could not be pressed');
      }
      if (!(await this.waitFor('host', `!!document.querySelector('[data-private-answers] form[data-pa-ask]') && !!document.querySelector('[data-private-answers] [data-pa-list]')`, 45_000))) throw new Error('Unlock did not open the Private answers controls');
    } else if (place === 'dashboard') {
      // The panel loads its content through the page's own bridge: it has text once it has read the dashboard.
      await this.waitFor('host', `!!document.getElementById('olympus-panel')`, 30_000);
      await this.waitFor('panel', `__rc.visibleText().trim().length > 40`, 45_000);
    }
  }

  async go(path: string): Promise<void> {
    if (!this.origin) throw new Error('no page has been opened yet');
    await this.cdp.send('Page.navigate', { url: `${this.origin}${path}` });
    await this.settleLoad();
    if (path.startsWith('/dashboard') && !path.includes('?')) {
      await this.waitFor('host', `!!document.getElementById('olympus-panel')`, 30_000);
      await this.waitFor('panel', `__rc.visibleText().trim().length > 40`, 45_000);
    }
  }

  async reload(): Promise<void> {
    await this.cdp.send('Page.reload');
    await this.settleLoad();
    if ((await this.probe('host', `!!document.getElementById('olympus-panel')`).catch(() => false)) === true) await this.waitFor('panel', `__rc.visibleText().trim().length > 40`, 45_000);
  }

  async setViewport(width: number, theme?: 'light' | 'dark'): Promise<void> {
    this.width = width;
    if (theme) this.theme = theme;
    await this.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: this.theme }] });
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await sleep(300);
  }

  /** The page's height needed to show the framed panel whole (the panel scrolls inside its frame), for a full-length capture. */
  async fullHeight(): Promise<number> {
    try {
      const host = Number(await this.probe('host', '__rc.scrollHeight()') ?? 900);
      if (!(await this.hasPanel())) return host;
      const box = await this.probe('host', `__rc.frameBox('olympus-panel')`) as { y: number } | null;
      const panel = Number(await this.probe('panel', '__rc.scrollHeight()') ?? 0);
      return Math.max(host, Math.ceil((box?.y ?? 0) + panel));
    } catch { return 900; }
  }

  async where(): Promise<string> {
    return String(await this.evalIn('host', `location.pathname + location.search + location.hash`));
  }

  async pages(): Promise<number> {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${this.setup.debugPort}/json`)).json() as Array<{ type: string }>;
      return targets.filter((target) => target.type === 'page').length;
    } catch { return 1; }
  }

  async screenshot(relativeFile: string): Promise<boolean> {
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    const path = join(this.setup.outDir, 'traces', relativeFile);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(shot.data as string, 'base64'));
    return true;
  }

  /** A lossless capture for the visual baselines, the page as tall as its content (the framed panel whole). */
  async capturePng(absoluteFile: string): Promise<{ width: number; height: number }> {
    const height = Math.min(4_000, Math.max(300, await this.fullHeight()));
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: this.width, height, deviceScaleFactor: 1, mobile: this.width < 600 });
    await sleep(500);
    const shot = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(absoluteFile), { recursive: true });
    writeFileSync(absoluteFile, Buffer.from(shot.data as string, 'base64'));
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width: this.width, height: 900, deviceScaleFactor: 1, mobile: this.width < 600 });
    return { width: this.width, height };
  }

  /** Runs a page script in every frame that has one (the page and the framed panel), for the capture's masks. */
  async everyFrame(expression: string): Promise<void> {
    for (const frame of ['host', 'panel'] as const) {
      try { await this.evalIn(frame, expression); } catch { /* no such frame */ }
    }
  }

  drainEvents(): PageEvents {
    const out = this.events;
    this.events = { console: [], requests: [] };
    return out;
  }
}

function pathOf(url: string): string {
  try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}`.replace(/token=[^&#]*/g, 'token=…'); } catch { return url.slice(0, 80); }
}

/** What one capture pass produced. */
export interface CapturedScreen { name: string; screen: string; width: number; theme: 'light' | 'dark'; bytes: number; height: number }

/**
 * The visual baselines' screens: every dashboard page at phone and desktop width, light and dark, taken with the run-dependent parts
 * normalised or left out (visual.ts). The dashboard's framed panel is shown whole. Pages are reached the owner's way: the first
 * opening link signs the browser in and Unlock opens the controls, then the others open in that session.
 */
export async function captureScreens(driver: CdpJourneyDriver, outDir: string): Promise<CapturedScreen[]> {
  const { maskScript, SCREENS, SCREEN_THEMES, SCREEN_WIDTHS, screenName } = await import('./visual-capture.ts');
  const { statSync } = await import('node:fs');
  const out: CapturedScreen[] = [];
  await driver.open('private');
  for (const theme of SCREEN_THEMES) {
    for (const width of SCREEN_WIDTHS) {
      await driver.setViewport(width, theme);
      for (const screen of SCREENS) {
        await driver.go(screen.path);
        // The pages settle (the panel reads the dashboard, the lists fill); then what varies by the clock or by the run is made fixed.
        await sleep(1_500);
        await driver.everyFrame(maskScript());
        await sleep(300);
        const name = screenName(screen.id, width, theme);
        const file = join(outDir, 'screens', `${name}.png`);
        const size = await driver.capturePng(file);
        out.push({ name, screen: screen.id, width, theme, bytes: statSync(file).size, height: size.height });
      }
    }
  }
  return out;
}
