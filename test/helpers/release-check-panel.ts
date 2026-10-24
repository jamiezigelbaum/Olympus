// The product's real dashboard panel in a DOM, and a journey driver over it: shared by the archive-import leg's tests
// (release-check-archive-leg.test.ts, release-check-archive-stages.test.ts). The panel is mounted the way
// archive-import-dashboard-ui.test.ts mounts it, on a host that answers its tool calls from `serve`; a journey that goes to the
// dashboard mounts it afresh, as a page load would.

import { createHash } from 'node:crypto';
import { Window } from 'happy-dom';
import {
  COMPUTER_META_KEY,
  OLYMPUS_HOST_CONTEXT_KEY,
  SCOPE_UI_META_KEY,
  type ComputerArchiveEntry,
  type ComputerArchivesMeta,
} from '../../src/workers/chatgpt/dashboard-contract.ts';
import { chatgptDashboardPageHtml } from '../../src/workers/dashboard/chatgpt/page.ts';
import { dashboardImportAttentionSentence } from '../../src/workers/dashboard/vocabulary.ts';
import type { DashboardImportAttention } from '../../src/workers/source-dashboard.ts';
import { previewDashboardToolResult } from '../../scripts/dashboard-preview.ts';
import { FIXTURE_FOLDER, type LegFixture } from '../../scripts/release-check/archive-fixtures.ts';
import type { ElementInfo, JourneyDriver, PageEvents } from '../../scripts/release-check/journey.ts';
import { PROBE_SOURCE, type WireTarget } from '../../scripts/release-check/probe.ts';

const windows: Window[] = [];
/** Closes every window a test opened; call from afterEach. */
export async function closeWindows(): Promise<void> {
  while (windows.length) await windows.pop()!.happyDOM.close();
}
export const settle = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Message = { jsonrpc?: string; id?: number; method?: string; params?: any };
export type Serve = Record<string, (args: any) => unknown>;

/** The product's dashboard panel in a DOM, on a host that answers its tool calls from `serve` (as archive-import-dashboard-ui.test.ts mounts it). */
export async function mountPanel(serve: Serve): Promise<{ win: Window; sent: Message[] }> {
  const html = chatgptDashboardPageHtml({ resultTimeoutMs: 5_000 });
  const start = html.indexOf('<script>') + '<script>'.length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const win = new Window({ url: 'https://sandbox.test/' });
  windows.push(win);
  win.document.write(html.slice(0, start - '<script>'.length) + html.slice(html.indexOf('</script>', start) + '</script>'.length));
  const sent: Message[] = [];
  const dispatch = (data: unknown) => win.dispatchEvent(new win.MessageEvent('message', { data, source: parent as any }));
  const reply = (id: number, result: unknown) => setTimeout(() => dispatch({ jsonrpc: '2.0', id, result }), 0);
  const parent = {
    postMessage: (message: Message) => {
      sent.push(message);
      if (message.id === undefined) return;
      if (message.method === 'ui/initialize') {
        reply(message.id, {
          protocolVersion: '2026-01-26',
          hostContext: { theme: 'light', displayMode: 'fullscreen', availableDisplayModes: ['fullscreen'], [OLYMPUS_HOST_CONTEXT_KEY]: { kind: 'computer', readOnly: false, links: {} } },
        });
      } else if (message.method === 'tools/call') {
        const handler = serve[message.params.name];
        if (handler) reply(message.id, handler(message.params.arguments ?? {}));
      } else if (message.method === 'ui/open-link') reply(message.id, {});
    },
  };
  Object.defineProperty(win, 'parent', { value: parent, configurable: true });
  new Function('window', 'document', script)(win, win.document);
  await settle(30);
  return { win, sent };
}

/** Runs page-side source in a happy-dom window the way Runtime.evaluate does in a browser. */
export function evalIn(window: Window, code: string): unknown {
  const globals = window as unknown as { __rc?: unknown };
  return new Function('window', 'document', 'getComputedStyle', 'NodeFilter', '__rc', `return (${code});`)(window, window.document, window.getComputedStyle.bind(window), (window as any).NodeFilter, globals.__rc);
}

/** The journey driver over the mounted panel: going to the dashboard mounts it afresh, as a page load would. */
export class PanelDriver implements JourneyDriver {
  win!: Window;
  /** The page around the panel, which holds only its frame. */
  host = new Window({ url: 'http://127.0.0.1:8010/dashboard' });
  events: PageEvents = { console: [], requests: [] };
  constructor(private readonly mount: () => Promise<Window>) { windows.push(this.host); }
  private frameOf(frame: 'host' | 'panel'): Window { return frame === 'host' ? this.host : this.win; }
  async hasPanel(): Promise<boolean> { return true; }
  async probe(frame: 'host' | 'panel', call: string): Promise<unknown> { return evalIn(this.frameOf(frame), call); }
  async click(frame: 'host' | 'panel', target: WireTarget): Promise<ElementInfo | null> {
    const info = evalIn(this.frameOf(frame), `__rc.find(${JSON.stringify(target)})`) as ElementInfo | null;
    if (!info) return null;
    evalIn(this.frameOf(frame), `__rc.element(${JSON.stringify(target)}).click()`);
    return info;
  }
  async type(): Promise<boolean> { return false; }
  async open(): Promise<void> { await this.go(); }
  async go(_path?: string): Promise<void> {
    this.win = await this.mount();
    const place = function (this: any) {
      const hidden = this.hasAttribute?.('hidden') || /display:\s*none/.test(this.getAttribute?.('style') ?? '');
      return hidden ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 } : { left: 10, top: 10, width: 120, height: 24, right: 130, bottom: 34 };
    };
    for (const window of [this.win, this.host]) (window.Element.prototype as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = place;
    this.host.document.body.innerHTML = '<iframe id="olympus-panel"></iframe>';
    evalIn(this.win, PROBE_SOURCE);
    evalIn(this.host, PROBE_SOURCE);
  }
  async reload(): Promise<void> { await this.go(); }
  async setViewport(): Promise<void> {}
  async where(): Promise<string> { return '/dashboard'; }
  async pages(): Promise<number> { return 1; }
  async screenshot(): Promise<boolean> { return true; }
  drainEvents(): PageEvents { return this.events; }
}

export const PANEL_IDS = { agent: '6a1f0e2d-4c3b-4a59-8e7d-1b2c3d4e5f60', picker: '7b2a1f3e-5d4c-4b6a-9f8e-2c3d4e5f6a71', held: '8c3b2a1f-6e5d-4c7b-8a9f-3d4e5f6a7b82' };

/** The archive's id on the page: the fixed one for the first format's archive of a role, one derived from the file's name for any other format's. */
export function panelIdFor(fx: LegFixture): string {
  if (fx.format === 'mbox') return PANEL_IDS[fx.role as keyof typeof PANEL_IDS] ?? PANEL_IDS.agent;
  const hex = createHash('sha256').update(fx.fileName).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function entryFor(fx: LegFixture, over: Partial<ComputerArchiveEntry> = {}): ComputerArchiveEntry {
  const expect = fx.expect;
  return {
    id: panelIdFor(fx), name: fx.fileName, format: expect.label, family: expect.family, where: `~/${FIXTURE_FOLDER}`, status: 'imported',
    items: expect.messages, judged: expect.messages, held: 0, earliest: expect.earliest, latest: expect.latest,
    startedAt: '2026-10-22T08:00:00.000Z', importedAt: '2026-10-22T09:00:00.000Z', gaps: expect.gaps.map((g) => ({ ...g })), skipped: expect.leftOut.map((g) => ({ ...g })), ...over,
  };
}

/**
 * The dashboard tool's answer with this list in the computer's meta. The card around it is a preview state (none, or imported); the list is the one
 * given, and the Needs you items are rebuilt from it the way the engine derives them (the same sentences, from the product's own words).
 */
export function dashboardAnswer(archives: ComputerArchiveEntry[], requests: ComputerArchivesMeta['requests'] = [], privateModel: ComputerArchivesMeta['privateModel'] = 'ready') {
  // The card around the list is a preview state: with nothing imported "Import an archive" is the row's own button, with something imported it moves into the ⋯ menu.
  const result = previewDashboardToolResult(archives.length === 0 ? 'archives-none' : 'archives-imported', false) as { _meta: Record<string, any>; structuredContent: Record<string, any> };
  const meta = { ...result._meta[COMPUTER_META_KEY], archives: { sourceId: 'archive.imports', archives, requests, privateModel } };
  const fix = { tool: 'olympus_dashboard', args: {}, href: 'https://olympusplugin.ai/open/archives/', openHref: true };
  const attention: DashboardImportAttention[] = [];
  for (const entry of archives) if (entry.status === 'stopped') attention.push({ kind: 'stopped', id: entry.id, name: entry.name });
  for (const request of requests) {
    if (request.origin === 'agent' && request.status === 'pending') attention.push({ kind: request.kind === 'remove' ? 'removal' : 'request', id: request.id, name: request.name });
  }
  const held = archives.filter((entry) => entry.status !== 'removing' && !entry.countsUnavailable).reduce((sum, entry) => sum + entry.held, 0);
  if (privateModel !== 'ready' && held > 0) attention.push({ kind: 'held', count: held, model: privateModel });
  const needsYou = attention.map((entry) => ({
    id: entry.kind === 'held' ? 'archives:held' : `archive${entry.kind === 'stopped' ? '' : '-request'}:${'id' in entry ? entry.id : ''}`,
    sentence: dashboardImportAttentionSentence(entry),
    fix: { label: entry.kind === 'held' ? 'Set up the private model' : entry.kind === 'stopped' ? 'See why' : 'Review', ...fix },
  }));
  return { ...result, structuredContent: { ...result.structuredContent, needsYou }, _meta: { ...result._meta, [COMPUTER_META_KEY]: meta } };
}

/** The picker as the machine's home shows it: the fixtures folder, with the fixture files in it. */
export function browseFixtures(files: string[]) {
  const home = '/Users/you';
  const nodes = (args: { parent_key?: unknown }): unknown[] => {
    if (!args.parent_key) return [{ key: `${home}/${FIXTURE_FOLDER}`, name: FIXTURE_FOLDER, kind: 'folder', has_children: true, selectable: true }];
    return files.map((name) => ({ key: `${home}/${FIXTURE_FOLDER}/${name}`, parent_key: `${home}/${FIXTURE_FOLDER}`, name, kind: 'file', has_children: false, selectable: true, size_bytes: 900 }));
  };
  return (args: { parent_key?: unknown }) => ({ content: [{ type: 'text', text: 'Listed.' }], structuredContent: { status: 'listed' }, _meta: { [SCOPE_UI_META_KEY]: { nodes: nodes(args) } } });
}

/** Real time, with a pause between looks so the panel's own messages are delivered; the journeys' bounds are set to a few seconds. */
export const live = { now: Date.now, sleep: (ms: number) => settle(Math.min(ms, 20)) };


