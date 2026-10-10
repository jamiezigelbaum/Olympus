import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import type { ModelSetupView } from '../src/core/model-setup.ts';
import { DASHBOARD_PICKER_COPY } from '../src/workers/dashboard/vocabulary.ts';
import { renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';

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

const SETUP_STATES = ['partial', 'full', 'fresh', 'models', 'models-applying', 'first-install', 'connect-dropbox-refused', 'review', 'review-unconfigured'];

/**
 * The older scope and tier words (holistic review 2026-10-02, item 21): a
 * folder is fully indexed, names only or skipped, and the owner's tiers are
 * Personal, Private and Secrets. The storage enums keep their old names; the
 * pages never print them.
 */
const LEGACY = /\b(Full ingestion|Metadata only|metadata only|invisible|Public)\b/;

function legacyIn(html: string): string[] {
  return ownerFacingText(html)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => LEGACY.test(line));
}

describe('owner-facing dashboard pages carry no implementation jargon outside Details', () => {
  // Unified dashboard phase 4: the panel is the dashboard (its own words are
  // checked in the ChatGPT tests); the computer's own pages are checked here.
  for (const state of SETUP_STATES) {
    test(`Keys, Agents and Build a connector speak plainly (${state})`, () => {
      const url = new URL('http://worker.test/dashboard?keys');
      for (const page of ['keys', 'agents', 'connector'] as const) {
        const html = renderDashboardLocalPage(page, { url, view: buildDashboardPreviewView(state), options: { now: DASHBOARD_PREVIEW_NOW } });
        expect(jargonIn(html)).toEqual([]);
        expect(legacyIn(html)).toEqual([]);
      }
    });
  }

  test('the folder picker\'s words, which the browser renders from the page, carry no jargon', () => {
    const words = (value: unknown): string[] => typeof value === 'string' ? [value]
      : Array.isArray(value) ? value.flatMap(words)
        : value && typeof value === 'object' ? Object.values(value).flatMap(words) : [];
    expect(jargonIn(words(DASHBOARD_PICKER_COPY).map((line) => `<p>${line}</p>`).join(''))).toEqual([]);
  });

  test('the legacy check itself catches the old words', () => {
    expect(legacyIn('<span>Metadata only</span><span>Full ingestion</span>')).toEqual(['Metadata only', 'Full ingestion']);
    expect(legacyIn('<td>Public</td>')).toEqual(['Public']);
  });

  test('the check itself catches jargon outside Details and ignores it inside', () => {
    expect(jargonIn('<p>Embeddings 98% done</p>')).toEqual(['Embeddings 98% done']);
    expect(jargonIn('<button aria-label="Lane progress"></button>')).toEqual(['Lane progress']);
    expect(jargonIn('<details><summary>Details</summary><p>the guard parked the lane</p></details>')).toEqual([]);
  });
});

describe('the Keys blocker', () => {
  function setup(cards: ModelSetupView['cards']): string {
    const view = buildDashboardPreviewView('fresh');
    view.model_setup = { ready: false, checked_at: DASHBOARD_PREVIEW_NOW.toISOString(), cards };
    return renderDashboardLocalPage('keys', { url: new URL('http://worker.test/dashboard?keys'), view, options: { now: DASHBOARD_PREVIEW_NOW } });
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
