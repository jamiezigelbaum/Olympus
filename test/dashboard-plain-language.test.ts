import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readResult } from '../scripts/control-ui-preview.ts';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import type { ModelSetupView } from '../src/core/model-setup.ts';
import { renderDashboardHtmlRoute } from '../src/workers/dashboard/index.ts';
import { dashboardIndexingProgress } from '../src/workers/dashboard/pages/background.ts';
import { renderDashboardSetupPage } from '../src/workers/dashboard/pages/setup.ts';
import { dashboardEtaWords, dashboardIndexingLine } from '../src/workers/dashboard/vocabulary.ts';

/**
 * Owner-facing pages speak the owner's language (dashboard UX review,
 * 2026-10-01: "no lanes, guards, supervisors, chunks, epochs or preset jargon
 * on owner-facing surfaces"). Internals live behind a Details disclosure, and
 * a prompt the owner copies to an agent is the agent's text, not the page's.
 */
const JARGON = /\b(lanes?|guards?|supervisors?|chunks?|epochs?|reauth\w*|embed\w*|ingest\w*)\b/i;

/** Every word a reader sees or hears: visible text plus accessible names. */
function ownerFacingText(html: string): string {
  const template = new Window().document.createElement('template');
  // One text run per element, so a finding reads as the line it is on.
  template.innerHTML = html.replaceAll('<', '\n<');
  const root = template.content;
  for (const node of root.querySelectorAll('script,style,details,.promptbox')) node.remove();
  const spoken = [...root.querySelectorAll('[aria-label],[title],[placeholder]')]
    .flatMap((node) => ['aria-label', 'title', 'placeholder'].map((name) => node.getAttribute(name) ?? ''));
  return [root.textContent ?? '', ...spoken].join('\n');
}

function jargonIn(html: string): string[] {
  return ownerFacingText(html)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => JARGON.test(line));
}

const SETUP_STATES = ['partial', 'full', 'fresh', 'models', 'models-applying', 'first-install', 'connect-dropbox-refused'];

describe('owner-facing dashboard pages carry no implementation jargon outside Details', () => {
  for (const view of ['home', 'background'] as const) {
    test(`native ${view}`, () => {
      const page = readResult({ view }, true);
      expect(jargonIn(page.body)).toEqual([]);
    });
  }
  for (const state of SETUP_STATES) {
    test(`native setup (${state})`, () => {
      const page = readResult({ view: 'setup' }, true, state);
      expect(jargonIn(page.body)).toEqual([]);
    });
  }
  for (const [route, state] of [['/dashboard', 'full'], ['/dashboard?background', 'full'], ['/dashboard?setup', 'partial'], ['/dashboard?setup', 'models']] as const) {
    test(`standalone ${route} (${state})`, () => {
      const { html } = renderDashboardHtmlRoute({
        url: new URL(`http://olympus.test${route}`),
        view: buildDashboardPreviewView(state),
        options: { now: DASHBOARD_PREVIEW_NOW },
      });
      expect(jargonIn(html)).toEqual([]);
    });
  }

  test('the check itself catches jargon outside Details and ignores it inside', () => {
    expect(jargonIn('<p>Embeddings 98% done</p>')).toEqual(['Embeddings 98% done']);
    expect(jargonIn('<button aria-label="Lane progress"></button>')).toEqual(['Lane progress']);
    expect(jargonIn('<details><summary>Details</summary><p>the guard parked the lane</p></details>')).toEqual([]);
  });
});

describe('the indexing progress line', () => {
  const NOW = DASHBOARD_PREVIEW_NOW;
  function view(backlog: { chunks: number; embedded_chunks: number; missing_chunks: number }, extra: Record<string, unknown> = {}) {
    const base = buildDashboardPreviewView('full');
    return {
      ...base,
      // No card publishes a per-item count here, so no item count may appear.
      sources: base.sources.map((source) => ({ ...source, coverage: { ...source.coverage, embedded_files: undefined } })),
      background_work: { embedding_backlog: { ...backlog, refresh_needed: false }, ...extra },
    } as unknown as ReturnType<typeof buildDashboardPreviewView>;
  }
  const moving = (count: number) => ({
    lanes: [{
      id: 'embedding-drain', name: 'Embedding drain', unit: 'chunks', reportsLive: true, phase: 'embedding',
      lastActivityAt: new Date(NOW.getTime() - 8_000),
      samples: [
        { at: new Date(NOW.getTime() - 5 * 60_000), count, heartbeatSeq: 1 },
        { at: NOW, count: count + 6_200, heartbeatSeq: 2 },
      ],
    }],
    guardActions: [],
  });
  const runtime = (state: string) => ({
    embeddingRuntime: {
      state, stateLine: `Embeddings: ${state}`, scheduleLine: 'No fixed hours.',
      overrideOn: false, override: 'none', overridePath: '/preview/override',
    },
  });
  const line = (v: ReturnType<typeof view>, options: Record<string, unknown> = {}) => {
    const progress = dashboardIndexingProgress(v, { now: NOW, ...options }, NOW);
    return progress === undefined ? undefined : dashboardIndexingLine(progress);
  };

  test('reads percent done and an estimate only once a rate is measured', () => {
    const v = view({ chunks: 1_000_000, embedded_chunks: 851_200, missing_chunks: 148_800 });
    // 6,200 in five minutes is 1,240 a minute: 148,800 left is two hours.
    expect(line(v, { backgroundRuntime: moving(100_000) })).toBe('Indexing — 85% done, about 2 hours');
    // Running, but no rate yet: an honest "estimating", never a guessed time.
    expect(line(v, runtime('running'))).toBe('Indexing — 85% done, estimating time left…');
  });

  test('never relabels chunks as items, and counts items only from a per-item field', () => {
    const v = view({ chunks: 208_212, embedded_chunks: 204_157, missing_chunks: 4_055 });
    expect(line(v, runtime('running'))).not.toContain('4,055');
    const withFiles = {
      ...v,
      sources: v.sources.map((source) => source.embedding_backlog === undefined ? source
        : { ...source, coverage: { ...source.coverage, content_ready_items: 120, embedded_files: 100 } }),
    };
    const indexing = withFiles.sources.filter((source) => source.embedding_backlog !== undefined).length;
    expect(indexing).toBeGreaterThan(0);
    expect(line(withFiles, runtime('running')))
      .toBe(`Indexing — 98% done, ${indexing * 20} items left, estimating time left…`);
  });

  test('says stalled when the lane stopped moving, and paused when something parked it', () => {
    const v = view({ chunks: 200_000, embedded_chunks: 70_000, missing_chunks: 130_000 });
    const stopped = moving(88_000);
    stopped.lanes[0]!.samples[1]!.count = 88_000;
    stopped.lanes[0]!.samples[0]!.at = new Date(NOW.getTime() - 12 * 60_000);
    expect(line(v, { backgroundRuntime: stopped })).toBe('Indexing — 35% done, stalled');
    expect(line(v, runtime('parked')))
      .toBe('Indexing — 35% done, paused');
    expect(line(view({ chunks: 200_000, embedded_chunks: 70_000, missing_chunks: 130_000 }, { embedding_lane_state: 'embedding_lane_disabled' })))
      .toBe('Indexing — 35% done, switched off');
  });

  test('handles zero and changing totals without inventing a number', () => {
    expect(line(view({ chunks: 0, embedded_chunks: 0, missing_chunks: 0 }))).toBe('Indexing — up to date');
    expect(line(view({ chunks: 500, embedded_chunks: 500, missing_chunks: 0 }))).toBe('Indexing — up to date');
    // New material grew the total: the percent drops, it never reads above 100
    // or below 0, and the line still says where it stands.
    const grown = line(view({ chunks: 400_000, embedded_chunks: 210_000, missing_chunks: 190_000 }), runtime('running'));
    expect(grown).toBe('Indexing — 52% done, estimating time left…');
    const overCounted = line(view({ chunks: 100, embedded_chunks: 140, missing_chunks: 5 }), runtime('running'));
    expect(overCounted).toBe('Indexing — 100% done, estimating time left…');
  });

  test('rounds an estimate to the precision a rate measured over minutes has', () => {
    expect(dashboardEtaWords(50_000)).toBe('about a minute');
    expect(dashboardEtaWords(17 * 60_000)).toBe('about 17 minutes');
    expect(dashboardEtaWords(70 * 60_000)).toBe('about an hour');
    expect(dashboardEtaWords(5 * 3_600_000)).toBe('about 5 hours');
    expect(dashboardEtaWords(50 * 3_600_000)).toBe('about 2 days');
  });
});

describe('the Setup blocker', () => {
  function setup(cards: ModelSetupView['cards']): string {
    const view = buildDashboardPreviewView('fresh');
    view.model_setup = { ready: false, checked_at: DASHBOARD_PREVIEW_NOW.toISOString(), cards };
    return renderDashboardSetupPage(view, { now: DASHBOARD_PREVIEW_NOW });
  }
  const local = (state: ModelSetupView['cards'][number]['state']) =>
    [{ id: 'local' as const, label: 'Local models', required: true, state, detail: 'Local detail.' }];

  test('a local model under its automatic check reads Checking…, never Not configured', () => {
    const html = setup(local('applying'));
    expect(html).toContain('Checking your local models… Sources unlock when the check passes.');
    expect(html).toContain('<span role="status">Checking…</span>');
    expect(html).not.toContain('Not configured');
    // Configured local models are checked on their own; nothing asks the
    // owner to connect them again.
    expect(html).not.toContain('data-sheet-toggle="#local-model-setup-sheet"');
  });

  test('a local model that is not answering offers one Check again in the banner', () => {
    const html = setup(local('needs_attention'));
    const banner = html.slice(html.indexOf('data-blocker'), html.indexOf('aria-label="Models"'));
    expect(banner).toContain('Your local model server is not answering');
    expect(banner).toContain('data-model-check');
    expect(banner).toContain('>Check again</button>');
    const template = new Window().document.createElement('template');
    template.innerHTML = html;
    expect(template.content.querySelectorAll('form[data-model-check]').length).toBe(1);
  });

  test('blocked source controls are disabled, say why, and submit nothing', () => {
    const html = setup(local('applying'));
    expect(html).toContain('disabled aria-disabled="true">Connect</button><span class="hint">Locked until models are ready</span>');
    expect(html).not.toContain('data-connect-kind="oauth"><input type="hidden" name="source" value="gmail">');
  });
});
