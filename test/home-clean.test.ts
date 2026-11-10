/**
 * Home holds only what the owner must act on (#1085, #1044), and Settings ›
 * Models on this computer names the model that really answers Private
 * questions (#1043).
 */
import { describe, expect, test } from 'bun:test';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { dashboardModelsOnComputer } from '../src/workers/dashboard/models-on-computer.ts';
import { renderDashboardLocalPage } from '../src/workers/dashboard/index.ts';
import { loadSovereigntyPreset, type SovereigntyConfig } from '../src/core/sovereignty.ts';
import type { LocalModelReadiness } from '../src/core/linux-model-readiness.ts';

const NOW = new Date('2026-11-10T15:30:00.000Z');
const HOUR = 3_600_000;

function xCard(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'internal.x.bookmarks',
    source_id: 'x.bookmarks',
    label: 'X bookmarks',
    provider: 'x',
    family: 'bookmark',
    trust_domain: 'internal',
    configured: true,
    freshness: { label: 'Last checked 12 hours ago', hours: 12, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 900, content_ready_items: 900, embedded_items: 900, embedded_files: 0, needs_review_items: 0, answer_ready_eligible_items: 900 },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: '' },
    tier_composition: [],
    queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 0, retrying_tasks: 1 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 12 hours ago', action: { kind: 'none' }, handles: ['x.personal'] },
    sync_now_available: true,
    last_sync_at: new Date(NOW.getTime() - 12 * HOUR).toISOString(),
    ...overrides,
  } as DashboardSourceCard;
}

function viewOf(card: DashboardSourceCard) {
  const view = { sources: [card], generated_at: NOW.toISOString() } as unknown as SourceDashboardViewModel;
  return copyDashboardViewModel(buildChatGptDashboardViewModel(view, { now: NOW }));
}

describe('Needs you holds only what the owner must act on (#1044)', () => {
  test('X parked on its daily cost guard is not Needs you: it waits, with the reason and 00:00 UTC, and no Sync now', () => {
    for (const reason of ['daily_cost_guard', 'head_cost_reserve_guard', 'daily_api_request_guard']) {
      const view = viewOf(xCard({ schedule: { running: false, consecutive_failures: 0, last_error_kind: 'api_request_guard', degraded_reason: reason } }));
      expect(view.needsYou).toEqual([]);
      expect(view.waits).toEqual([{ sourceId: 'x.bookmarks', label: 'X bookmarks', reason: 'daily_budget', api: 'X', resumesAt: '2026-11-11T00:00:00.000Z' }]);
      expect(view.sources[0]!.status).not.toBe('Needs you');
    }
  });

  test('a sync retrying on its own is not Needs you', () => {
    const view = viewOf(xCard());
    expect(view.needsYou).toEqual([]);
    expect(view.waits).toBeUndefined();
  });

  test('a signed-out source still needs the owner, and items that cannot be read still do', () => {
    const signedOut = viewOf(xCard({ connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'oauth', label: 'Reconnect' }, handles: [] } as never }));
    expect(signedOut.needsYou).toHaveLength(1);
    const unreadable = viewOf(xCard({ queue_health: { label: 'Needs attention', waiting: 0, active: 0, needs_attention: 2 } as never }));
    expect(unreadable.needsYou).toHaveLength(1);
  });
});

const READY: LocalModelReadiness[] = [
  { name: 'Embedding', state: 'ready', detail: '', downloadBytes: 1 },
  { name: 'Private answers', state: 'ready', detail: 'Qwen3.5 4B: ready.', downloadBytes: 1, model: 'Qwen3.5 4B' },
  { name: 'Transcription', state: 'unavailable', detail: 'Built-in transcription is turned off by OLYMPUS_BUILT_IN_TRANSCRIPTION=off.', downloadBytes: 1, model: 'Qwen3-ASR 0.6B', cause: 'OLYMPUS_BUILT_IN_TRANSCRIPTION is set to off' },
];

/** The owner's route (#1043): a model server on another computer first, then Venice. */
function remoteThenVenice(): SovereigntyConfig {
  const config = structuredClone(loadSovereigntyPreset('local-first'));
  const route = config.routes.secure_local!;
  const [local, venice] = route.pool!.order!;
  const profile = config.modelProfiles[local!]!;
  config.modelProfiles[local!] = { ...profile, model: 'Qwen 3.6 35B', baseUrl: 'http://delphi.local:8080/v1' } as never;
  expect(config.modelProfiles[venice!]!.provider).toBe('venice');
  return config;
}

describe('Settings › Models on this computer (#1043)', () => {
  test('names the saved route\'s first model, then its fallback, and never the 4B when the route does not use it', () => {
    const models = dashboardModelsOnComputer({ config: remoteThenVenice(), builtInAnswers: false, readiness: READY });
    expect(models.privateAnswers).toEqual({ first: 'Qwen 3.6 35B on delphi.local', fallback: 'Venice' });
    expect(models.builtIn).toEqual({ name: 'Qwen3.5 4B', state: 'downloaded', used: false });
    const html = renderDashboardLocalPage('settings', { url: new URL('http://127.0.0.1:8787/dashboard?settings'), options: { settings: { models } } });
    const pane = html.slice(html.indexOf('<section class="setpane" id="models">'), html.indexOf('</section>', html.indexOf('id="models"')));
    expect(pane).toContain('<b>Private answers</b> — answered by Qwen 3.6 35B on delphi.local, then Venice if it can&#39;t.');
    expect(pane).toContain('href="/dashboard?keys#private-routing"');
    expect(pane).toContain('<b>Built-in model</b> — Qwen3.5 4B, downloaded · not used by your current route');
    expect(pane).not.toMatch(/Private answers<\/b>[^<]*4B/);
  });

  test('when the built-in model answers for the route\'s local member, it is named and marked used', () => {
    const models = dashboardModelsOnComputer({ config: loadSovereigntyPreset('local-first'), builtInAnswers: true, readiness: READY });
    expect(models.privateAnswers).toEqual({ first: 'Qwen3.5 4B on this computer', fallback: 'Venice' });
    expect(models.builtIn?.used).toBe(true);
  });

  test('a Venice-only route never uses the built-in model, whatever it has downloaded', () => {
    const models = dashboardModelsOnComputer({ config: loadSovereigntyPreset('private-cloud-only'), builtInAnswers: true, readiness: READY });
    expect(models.privateAnswers).toEqual({ first: 'Venice' });
    expect(models.builtIn?.used).toBe(false);
  });

  test('a pool with no order is not a fallback chain: each question goes to the healthiest, fastest member, and Settings says so (#1163 review)', () => {
    const config = remoteThenVenice();
    delete config.routes.secure_local!.pool!.order;
    const models = dashboardModelsOnComputer({ config, builtInAnswers: false, readiness: READY });
    expect(models.privateAnswers).toEqual({ any: ['Qwen 3.6 35B on delphi.local', 'Venice'] });
    const html = renderDashboardLocalPage('settings', { url: new URL('http://127.0.0.1:8787/dashboard?settings'), options: { settings: { models } } });
    expect(html).toContain('<b>Private answers</b> — answered by Qwen 3.6 35B on delphi.local or Venice, whichever is working and fastest for each question.');
    expect(html).not.toContain('then Venice');
    // An order names the chain, kept to the pool's members.
    const ordered = remoteThenVenice();
    ordered.routes.secure_local!.pool!.order = [...ordered.routes.secure_local!.pool!.order!].reverse();
    expect(dashboardModelsOnComputer({ config: ordered, builtInAnswers: false, readiness: READY }).privateAnswers).toEqual({ first: 'Venice', fallback: 'Qwen 3.6 35B on delphi.local' });
  });

  test('transcription names the one cause that applies', () => {
    const off = dashboardModelsOnComputer({ config: undefined, builtInAnswers: false, readiness: READY });
    expect(off.transcription).toEqual({ line: 'off: OLYMPUS_BUILT_IN_TRANSCRIPTION is set to off' });
    const noFfmpeg = dashboardModelsOnComputer({ config: undefined, builtInAnswers: false, readiness: [{ ...READY[2]!, cause: 'ffmpeg is not installed' }] });
    expect(noFfmpeg.transcription!.line).toBe('off: ffmpeg is not installed');
    expect(noFfmpeg.transcription!.line).not.toContain('OLYMPUS_BUILT_IN_TRANSCRIPTION');
  });
});

describe('the Sources tab is the list (#1085)', () => {
  test('each connected source\'s ⋯ menu has Details, which opens its own row on Home', () => {
    const view = { sources: [xCard()], generated_at: NOW.toISOString() } as unknown as SourceDashboardViewModel;
    const html = renderDashboardLocalPage('connect', { url: new URL('http://127.0.0.1:8787/dashboard?connect'), view });
    expect(html).toContain('href="/dashboard#olympus-open=source.x.bookmarks" data-source-details>Details</a>');
  });
});
