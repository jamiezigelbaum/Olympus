/** Opt-in VM scale proof. All imports use the agent request and the owner's dashboard approval. */
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFixture, type LegFixture } from './archive-fixtures.ts';
import { SCALE_FIRST, SCALE_LAST, scaleFixture, scaleReadwise, type ScaleFormat } from './archive-scale-fixtures.ts';
import {
  ALL_SOURCES_PATH, ARCHIVE_PANEL_PROBE, approveRequestSteps, datesWord, expectedLists, judgedLineOf, messagesWord,
  panelArchivesOf, removeJourney, rowNamed, shownPath, startViewOf, statusViewOf,
  type AgentArchiveView, type RowView,
} from './archive-leg.ts';
import type { ArchiveHost } from './archive-stages.ts';
import { OPEN_ALL_SOURCES } from './journeys.ts';
import { runJourney, type JourneyDriver, type JourneyTrace } from './journey.ts';
import type { ArchiveScaleMeasurement, CheckResult } from './report.ts';

export const SCALE_BOUND_S = 3_600;
export const SCALE_REPEAT_S = 300;
export const SCALE_REMOVE_S = 900;

export interface ReadwiseScaleSnapshot {
  items: number;
  held: number;
  earliest?: string;
  latest?: string;
  gaps: Record<string, number>;
  /** A completed provider traversal, including the export lane, rather than a quiet partial pass. */
  complete: boolean;
  run: string;
}
export interface ScaleHost extends ArchiveHost {
  /** An asynchronous status read of the front, including its response body. */
  frontStatus(): Promise<boolean>;
  /** Sum of RSS for the front and background processes, bytes, or null if unavailable. */
  engineRss(): number | null;
  archiveGaps(id: string): Record<string, number> | undefined;
  /** Isolate the synthetic source, serving scale fixtures via the existing fake API. */
  beginReadwise(seed: string): Promise<void>;
  readwiseSnapshot(): Promise<ReadwiseScaleSnapshot>;
  syncReadwise(): Promise<void>;
  /** Delete the scale source, restore the ordinary fake and original test life. Idempotent after interruption. */
  endReadwise(): Promise<boolean>;
}

export interface ScaleSample { ms: number; items: number | null; status: string }
export interface ScaleObservation {
  format: ScaleFormat;
  ok: boolean;
  detail?: string;
  expected: number;
  archive?: AgentArchiveView;
  row?: RowView;
  gaps?: Record<string, number>;
  samples: ScaleSample[];
  drained: boolean;
  held?: number;
  repeat?: { already: boolean; added: number | null };
  renamed?: { already: boolean; added: number | null };
  removed: boolean;
  traces: JourneyTrace[];
  measurement: ArchiveScaleMeasurement;
}

export function percentile(values: readonly number[], p: number): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]! : null;
}

/** Independent 2 s front/RSS sampler. Failed requests remain visible beside latency percentiles. */
async function measured<T>(host: ScaleHost, obs: ScaleObservation, work: () => Promise<T>): Promise<T> {
  const started = host.now();
  const latencies: number[] = [];
  let active = true;
  let peak: number | null = null;
  let failures = 0;
  const loop = (async () => {
    while (active) {
      const at = host.now();
      try { const rss = host.engineRss(); if (rss !== null) peak = Math.max(peak ?? 0, rss); } catch { /* measurement unavailable */ }
      try { if (!await host.frontStatus()) failures++; } catch { failures++; }
      latencies.push(host.now() - at);
      if (active) await host.sleep(Math.max(1, 2_000 - (host.now() - at)));
    }
  })();
  try { return await work(); }
  finally {
    const wallMs = host.now() - started;
    active = false;
    await loop;
    const items = obs.archive?.messages ?? 0;
    obs.measurement = { format: obs.format, wallMs, items, itemsPerMinute: wallMs > 0 ? items * 60_000 / wallMs : 0,
      peakRssBytes: peak, frontP50Ms: percentile(latencies, 0.5), frontP95Ms: percentile(latencies, 0.95), frontSamples: latencies.length, frontFailures: failures };
  }
}

const empty = (format: ScaleFormat, expected: number): ScaleObservation => ({ format, expected, ok: false, samples: [], drained: false, removed: false, traces: [],
  measurement: { format, items: 0, wallMs: 0, itemsPerMinute: 0, peakRssBytes: null, frontP50Ms: null, frontP95Ms: null, frontSamples: 0, frontFailures: 0 } });
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const panelRow = async (driver: JourneyDriver, name: string): Promise<RowView | undefined> => rowNamed(panelArchivesOf(await driver.probe('panel', ARCHIVE_PANEL_PROBE)), name);
/** Parse a total shown on the row, never substitute the agent's count for a missing UI count. */
export function scaleRowCount(row: RowView | undefined): number | null {
  if (!row || row.text.includes('Counting')) return null;
  const found = /\b([\d,]+) (?:messages?|notes?|items?)\b/.exec(row.text);
  if (found) return Number(found[1]!.replaceAll(',', ''));
  if (/\bno (?:messages|notes|items)\b/.test(row.text)) return 0;
  return null;
}

/** Approval without waiting for completion, so 10 s dashboard samples include the running import. */
async function approve(host: ScaleHost, driver: JourneyDriver, fx: LegFixture, path: string, obs: ScaleObservation, repeat = false): Promise<string> {
  const answer = host.cli(['start', '--path', path]);
  const start = startViewOf(answer.json, fx.token);
  if (answer.code !== 0 || start.code !== 'needs_approval' || !start.requestId) throw new Error(`archive start: ${start.code || answer.stderr}`);
  const steps = approveRequestSteps(fx, shownPath(host.home, path));
  // A duplicate must end in an already-imported request, without a row for the renamed copy.
  if (repeat) steps[steps.length - 1] = { ...steps[steps.length - 1]!, expect: [] };
  const trace = await runJourney(driver, { id: `archive-scale-${obs.format}-${repeat ? 'repeat' : 'approve'}-${obs.traces.length}`, title: `Approve ${fx.fileName}`, source: 'archive scale', mutates: true, steps });
  obs.traces.push(trace);
  if (!trace.ok) throw new Error(`dashboard approval failed for ${fx.fileName}`);
  return start.requestId;
}

async function repeatImport(host: ScaleHost, driver: JourneyDriver, fx: LegFixture, path: string, obs: ScaleObservation, boundS: number): Promise<{ already: boolean; added: number | null }> {
  const before = host.cli(['status']);
  const previous = statusViewOf(before.json, fx.token);
  if (before.code !== 0 || !previous.ok || previous.archives.some(a => a.messages === undefined)) throw new Error('cannot count archives before re-import');
  const count = previous.archives.reduce((sum, archive) => sum + archive.messages!, 0);
  const requestId = await approve(host, driver, fx, path, obs, true);
  const deadline = host.now() + boundS * 1_000;
  let already = false;
  let after: ReturnType<typeof statusViewOf> | undefined;
  for (;;) {
    const answer = host.cli(['status']);
    const raw = answer.json as { requests?: Array<{ request_id: string; state: string }> } | undefined;
    const state = raw?.requests?.find(r => r.request_id === requestId)?.state;
    if (answer.code === 0) {
      after = statusViewOf(answer.json, fx.token);
      already = state === 'already_imported';
      if (already || state === 'not_imported' || after.archives.length > previous.archives.length) break;
    }
    if (host.now() >= deadline) break;
    await host.sleep(2_000);
  }
  return { already, added: after?.ok && after.archives.every(a => a.messages !== undefined) ? after.archives.reduce((sum, a) => sum + a.messages!, 0) - count : null };
}

export async function scaleArchiveStage(host: ScaleHost, format: Exclude<ScaleFormat, 'readwise'>, seed: string, bounds: { importS?: number; repeatS?: number; removeS?: number } = {}): Promise<ScaleObservation> {
  const fx = scaleFixture(format, seed);
  const obs = empty(format, fx.expect.messages);
  const path = writeFixture(host.home, fx);
  const renamedName = `rc-scale-renamed-${fx.fileName}`;
  const renamedPath = join(host.home, 'rc-archives', renamedName);
  try {
    await host.withBrowser(async ({ driver }) => {
      try {
        await measured(host, obs, async () => {
          const started = host.now();
          const deadline = started + (bounds.importS ?? SCALE_BOUND_S) * 1_000;
          await approve(host, driver, fx, path, obs);
          for (;;) {
            obs.row = await panelRow(driver, fx.fileName);
            obs.samples.push({ ms: host.now() - started, items: scaleRowCount(obs.row), status: obs.row?.status ?? 'missing' });
            const answer = host.cli(['status']);
            const status = statusViewOf(answer.json, fx.token);
            obs.archive = answer.code === 0 && status.ok ? status.archives.find(a => a.name === fx.fileName) : undefined;
            obs.held = obs.archive?.waiting;
            obs.drained = obs.archive?.status === 'imported' && obs.held === 0 && judgedLineOf(obs.row?.text ?? '')?.held === 0;
            if (obs.drained || obs.archive?.status === 'stopped' || host.now() >= deadline) break;
            await host.sleep(Math.min(10_000, Math.max(1, deadline - host.now())));
          }
          if (obs.archive) obs.gaps = host.archiveGaps(obs.archive.id);
        });
        if (obs.archive?.status === 'imported') {
          obs.repeat = await repeatImport(host, driver, fx, path, obs, bounds.repeatS ?? SCALE_REPEAT_S);
          copyFileSync(path, renamedPath);
          obs.renamed = await repeatImport(host, driver, { ...fx, fileName: renamedName }, renamedPath, obs, bounds.repeatS ?? SCALE_REPEAT_S);
        }
        obs.ok = true;
      } finally {
        const trace = await runJourney(driver, removeJourney(`scale-${format}`, fx.fileName, bounds.removeS ?? SCALE_REMOVE_S));
        obs.traces.push(trace);
        const answer = host.cli(['status']);
        const view = statusViewOf(answer.json, fx.token);
        const stores = host.readStores({ family: fx.expect.family, provider: format === 'roam' ? 'roam' : format === 'mbox' ? 'mbox' : 'reflect' }, obs.archive?.id, fx.token);
        obs.removed = trace.ok && answer.code === 0 && view.ok && !view.archives.some(a => a.name === fx.fileName || a.name === renamedName)
          && stores.every(store => !store.error && store.live === 0 && store.tokenRows === 0);
      }
    });
  } catch (error) { obs.detail = errorText(error); }
  finally { rmSync(path, { force: true }); rmSync(renamedPath, { force: true }); }
  return obs;
}

/** Readwise's source card is sampled in the real dashboard, separately from /dashboard.json truth. */
export const READWISE_SCALE_ROW = String.raw`(() => {
  const row = document.querySelector('[data-source-row="readwise.library"]');
  return row ? String(row.textContent || '').replace(/\s+/g, ' ').trim() : null;
})()`;

export async function scaleReadwiseStage(host: ScaleHost, seed: string, boundS = SCALE_BOUND_S): Promise<ScaleObservation> {
  const expected = scaleReadwise(seed).items;
  const obs = empty('readwise', expected);
  try {
    await host.withBrowser(async ({ driver }) => {
      await measured(host, obs, async () => {
        // Start sampling before connecting so the first visible count may be zero.
        await driver.go(ALL_SOURCES_PATH);
        const opened = await runJourney(driver, { id: 'archive-scale-readwise-open', title: 'Open Readwise progress', source: 'archive scale', mutates: false, steps: [OPEN_ALL_SOURCES] });
        obs.traces.push(opened);
        const started = host.now();
        await host.beginReadwise(seed);
        const deadline = started + boundS * 1_000;
        for (;;) {
          const snapshot = await host.readwiseSnapshot();
          const text = await driver.probe('host', READWISE_SCALE_ROW);
          const match = typeof text === 'string' ? /\b([\d,]+) (?:items?|documents?|highlights?)\b/.exec(text) : null;
          obs.samples.push({ ms: host.now() - started, items: match ? Number(match[1]!.replaceAll(',', '')) : null, status: snapshot.complete ? 'imported' : 'importing' });
          obs.archive = { id: 'readwise.library', name: 'Readwise', format: 'readwise', status: snapshot.complete ? 'imported' : 'importing', messages: snapshot.items,
            ...(snapshot.earliest ? { earliest: snapshot.earliest } : {}), ...(snapshot.latest ? { latest: snapshot.latest } : {}), waiting: snapshot.held, notImported: [], howRead: [] };
          obs.held = snapshot.held; obs.gaps = snapshot.gaps;
          obs.drained = snapshot.complete && snapshot.held === 0;
          if (obs.drained || host.now() >= deadline) break;
          await host.sleep(Math.min(10_000, Math.max(1, deadline - host.now())));
        }
      });
      if (obs.archive?.status === 'imported') {
        const before = await host.readwiseSnapshot();
        await host.syncReadwise();
        const deadline = host.now() + boundS * 1_000;
        for (;;) {
          const after = await host.readwiseSnapshot();
          if (after.complete && after.run !== before.run) {
            obs.repeat = { already: true, added: after.items - before.items };
            break;
          }
          if (host.now() >= deadline) break;
          await host.sleep(2_000);
        }
      }
      obs.ok = true;
    });
  } catch (error) { obs.detail = errorText(error); }
  finally {
    try { obs.removed = await host.endReadwise(); }
    catch (error) { obs.detail = [obs.detail, `cleanup: ${errorText(error)}`].filter(Boolean).join('; '); }
  }
  return obs;
}

const exact = (got: Record<string, number> | undefined, expected: Record<string, number>): boolean => got !== undefined
  && Object.keys(got).length === Object.keys(expected).length && Object.entries(expected).every(([kind, count]) => got[kind] === count);
export function scaleChecks(format: ScaleFormat, obs: ScaleObservation | undefined): CheckResult[] {
  const check = (what: string, title: string, pass: boolean, detail: string): CheckResult => ({ id: `archive.scale.${format}.${what}`, title, status: pass ? 'pass' : 'fail', detail });
  if (!obs) return [check('ran', 'The scale import ran', false, 'no result from the machine')];
  const row = obs.archive;
  const gaps = format === 'mbox' ? { message_unreadable: 5 } : {};
  const visible = obs.samples.filter((s): s is ScaleSample & { items: number } => s.items !== null);
  const rising = visible.some((s, i) => i > 0 && visible.slice(0, i).some(previous => previous.items < s.items));
  const expectedLines = format === 'readwise' ? [] : expectedLists({ notImported: Object.entries(gaps).map(([kind, count]) => ({ kind, count })), howRead: [] } as LegFixture['expect']).notImported;
  return [
    check('ran', 'The scale import ran through the product', obs.ok, obs.detail ?? 'agent request and dashboard approval'),
    check('items', 'Imported items equal the designed count', row?.status === 'imported' && row.messages === obs.expected, `${row?.messages ?? 'unknown'} imported; expected ${obs.expected}; state ${row?.status ?? 'missing'}`),
    check('dates', 'Oldest and newest dates are preserved', row?.earliest?.slice(0, 10) === SCALE_FIRST && row?.latest?.slice(0, 10) === SCALE_LAST,
      `${row?.earliest ?? 'unknown'} to ${row?.latest ?? 'unknown'}; expected ${SCALE_FIRST} to ${SCALE_LAST}`),
    check('held', 'Held and awaiting judgement reach zero within the bound', obs.drained && obs.held === 0, `${obs.held ?? 'unknown'} still held; ${Math.round(obs.measurement.wallMs / 1_000)} s observed (bound ${SCALE_BOUND_S} s)`),
    check('gaps', 'Only the designed gaps occur, with exact kinds', exact(obs.gaps, gaps), `observed ${JSON.stringify(obs.gaps ?? null)}; expected ${JSON.stringify(gaps)}`),
    check('progress', 'The dashboard shows a rising imported count in 10 s samples', rising, `${obs.samples.length} samples: ${obs.samples.map(s => `${Math.round(s.ms / 1_000)}s:${s.items ?? 'unreadable'}`).join(', ')}`),
    ...(format === 'readwise' ? [] : [check('dashboard', 'The final dashboard row shows the count, dates and exact failure reasons',
      obs.row?.status === 'imported' && obs.row.text.includes(messagesWord(obs.expected, format === 'mbox' ? 'email' : 'note'))
        && obs.row.facts.includes(datesWord({ earliest: SCALE_FIRST, latest: SCALE_LAST }))
        && JSON.stringify([...(obs.row.notImported ?? [])].sort()) === JSON.stringify([...expectedLines].sort()),
      obs.row ? `${obs.row.facts}; ${obs.row.notImported.join('; ') || 'no failed items'}` : 'row missing')]),
    check('repeat', format === 'readwise' ? 'A completed second Readwise sync adds zero items' : 'Re-importing the same file says already imported and adds zero items',
      obs.repeat?.already === true && obs.repeat.added === 0, JSON.stringify(obs.repeat ?? 'not completed')),
    ...(format === 'readwise' ? [] : [check('renamed', 'A renamed byte-identical copy adds zero items', obs.renamed?.already === true && obs.renamed.added === 0, JSON.stringify(obs.renamed ?? 'not completed'))]),
    check('removed', 'All data imported by the scale stage was removed', obs.removed, obs.removed ? 'removed and verified' : 'removal or verification failed'),
  ];
}
