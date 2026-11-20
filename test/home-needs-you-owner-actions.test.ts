/**
 * Needs you on Home holds only what the owner can do, and each line's button
 * does exactly that thing (rc.17, 2026-11-15: "4 things need you" where one
 * was his; 753 items waiting for the private model read as 753 files to check;
 * Dropbox's unsupported formats raised the broken-reader alarm; a Drive re-list
 * after a restart read "First index"; one idle source marked the page stalled).
 */
import { describe, expect, test } from 'bun:test';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { DASHBOARD_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';

const NOW = new Date('2026-11-15T15:30:00.000Z');
const HOUR = 3_600_000;

function dropbox(overrides: Partial<DashboardSourceCard> = {}): DashboardSourceCard {
  return {
    corpus_id: 'secure_local.dropbox.files',
    source_id: 'dropbox.files',
    label: 'Dropbox',
    provider: 'dropbox',
    family: 'file',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked 1 hour ago', hours: 1, threshold_hours: 26, stale: false },
    coverage: { indexed_items: 10_519, content_ready_items: 9_636, embedded_items: 9_636, embedded_files: 9_636, needs_review_items: 0,
      answer_ready_eligible_items: 10_519, unreadable_items: 883, unreadable_unsupported_items: 836, unsupported_formats: ['.heic', '.key', '.numbers'] },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: '' },
    tier_composition: [],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0 },
    answer_readiness: { state: 'ready', label: 'Ready for questions' },
    connection: { state: 'synced', label: 'synced 1 hour ago', action: { kind: 'none' }, handles: ['dropbox.personal'] },
    sync_now_available: true,
    last_sync_at: new Date(NOW.getTime() - HOUR).toISOString(),
    ...overrides,
  } as DashboardSourceCard;
}

type Options = Parameters<typeof buildChatGptDashboardViewModel>[1];

function home(cards: DashboardSourceCard[], options: Partial<Options> = {}) {
  const view = { sources: cards, generated_at: NOW.toISOString() } as unknown as SourceDashboardViewModel;
  return copyDashboardViewModel(buildChatGptDashboardViewModel(view, { now: NOW, ...options }));
}

const privacy = { configured: true, pendingCount: 763, ruleCount: 2 };

/** A button that does something: it opens a target or runs a tool with what to act on, never a bare re-read of the page. */
function ownerAction(fix: { label?: string; tool?: string; args?: Record<string, unknown>; href?: string } | undefined): boolean {
  if (!fix || typeof fix.label !== 'string' || !fix.label.trim()) return false;
  if (typeof fix.href === 'string' && fix.href) return true;
  return typeof fix.tool === 'string' && (fix.tool !== DASHBOARD_TOOL_NAME || Object.keys(fix.args ?? {}).length > 0);
}

describe('Needs you is only what the owner can do', () => {
  test('items waiting for the private model are never Needs you on their own, and carry its speed for In progress', () => {
    const view = home([dropbox()], { privacy: { ...privacy, judgePerMinute: 188 } });
    expect(view.needsYou).toEqual([]);
    expect(view.privacy).toMatchObject({ pendingCount: 763, judgePerMinute: 188 });
  });

  test('a stopped privacy check makes the waiting items one line, saying why, that opens the model', () => {
    const view = home([dropbox()], { privacy: { ...privacy, judgeStopped: 'model_not_answering' } });
    expect(view.needsYou).toHaveLength(1);
    const [item] = view.needsYou;
    expect(item!.id).toBe('privacy:judge_stopped');
    expect(item!.sentence).toBe('763 items are waiting because the privacy check stopped: the private model is not answering');
    expect(item!.fix?.label).toBe('Check the private model');
    expect(ownerAction(item!.fix)).toBe(true);
    // Stopped with nothing waiting asks nothing.
    expect(home([dropbox()], { privacy: { ...privacy, pendingCount: 0, judgeStopped: 'failed' } }).needsYou).toEqual([]);
  });

  test('missing label evidence has a counted owner action until the items are listed again', () => {
    const notice = (labelsUnavailable: number) => home([], { privacy: { ...privacy, labelsUnavailable } })
      .needsYou.find(item => item.id === 'privacy:labels_unavailable');
    expect(notice(0)).toBeUndefined();
    expect(notice(1)?.sentence).toBe("1 item can't be checked against your label rules. It would need to be listed again.");
    expect(notice(12)?.sentence).toBe("12 items can't be checked against your label rules. They would need to be listed again.");
    expect(ownerAction(notice(12)?.fix)).toBe(true);
  });

  test('every kind that reaches Needs you names an owner action with its target', () => {
    const producers: Array<[string, ReturnType<typeof home>]> = [
      ['privacy setup', home([dropbox()], { privacy: { ...privacy, configured: false } })],
      ['no judge', home([dropbox()], { privacy: { ...privacy, judgeMissing: 'no_model' } })],
      ['judge off', home([dropbox()], { privacy: { ...privacy, judgeMissing: 'turned_off' } })],
      ['judge stopped', home([dropbox()], { privacy: { ...privacy, judgeStopped: 'cloud_stopped' } })],
      ['reconnect', home([dropbox({ connection: { state: 'reauth_required', label: 'reauth required', action: { kind: 'reconnect' }, handles: ['dropbox.personal'] } as unknown as DashboardSourceCard['connection'] })])],
    ];
    for (const [kind, view] of producers) {
      expect(view.needsYou.length, kind).toBeGreaterThan(0);
      for (const item of view.needsYou) expect(ownerAction(item.fix), `${kind}: ${item.sentence}`).toBe(true);
    }
  });
});

describe('unreadable files on Home', () => {
  test('formats with no reader are their own reason on the row, and not an alarm', () => {
    const view = home([dropbox()]);
    expect(view.needsYou).toEqual([]);
    const row = view.sources.find((source) => source.id === 'dropbox.files')!;
    expect(row.unreadable?.reasons).toEqual([
      { code: 'damaged_or_unsupported', count: 47 },
      { code: 'unsupported_format', count: 836 },
    ]);
  });

  test('many damaged files are said on the row, never Needs you, finished or still indexing alike', () => {
    const many = { state: 'needs_attention', label: 'Many files cannot be read' } as const;
    const finished = home([dropbox({ answer_readiness: many })]);
    expect(finished.needsYou).toEqual([]);
    const row = finished.sources.find((source) => source.id === 'dropbox.files')!;
    expect(row.status).toBe('Fresh');
    expect(row.unreadable?.many).toBe(true);
    const indexing = home([dropbox({ answer_readiness: many, coverage: { ...dropbox().coverage, content_ready_items: 4_000, embedded_files: 4_000 } })]);
    expect(indexing.needsYou).toEqual([]);
  });
});

describe('the In progress line', () => {
  const listing = (overrides: Partial<DashboardSourceCard>) => dropbox({
    coverage: { ...dropbox().coverage, unreadable_items: 0, unreadable_unsupported_items: 0, unsupported_formats: [] },
    connection: { state: 'syncing', label: 'syncing', action: { kind: 'none' }, handles: ['dropbox.personal'] },
    queue_health: { label: 'Syncing', waiting: 1, active: 1, needs_attention: 0 },
    last_run: { status: 'running', items_seen: 2_318, items_indexed: 0, traversal_complete: false },
    ...overrides,
  });

  test('a re-list after a restart is a normal check; First index is only for a source never synced', () => {
    expect(home([listing({})]).progress?.phase).toBe('refresh');
    expect(home([listing({ freshness: { label: 'Waiting for the first sync', stale: false } as DashboardSourceCard['freshness'],
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0, needs_review_items: 0 } })]).progress?.phase).toBe('initial');
  });
});
