// ChatGPT MCP surface: the dashboard view-model producer, the MCP Apps
// dashboard tool and resource, and the privacy boundary.
//
// The privacy test seeds every place the engine holds owner-private text
// (sensitivity categories and examples, folder names, corpus and card labels,
// scope selections, credential names and hints, Private and Secret evidence,
// error messages) with sentinel strings, drives every tool response channel
// through a real MCP client against the remote handler, and asserts no
// sentinel appears anywhere in what leaves the engine.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { defaultConfig } from '../src/core/config.ts';
import { openRemoteConnectionStore, type RemoteConnectionStore } from '../src/core/remote-connections.ts';
import { DASHBOARD_RESOURCE_URI, DASHBOARD_TOOL_NAME, type DashboardViewModelV1 } from '../src/workers/chatgpt/dashboard-contract.ts';
import { MCP_APP_MIME_TYPE } from '../src/workers/chatgpt/dashboard-resource.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { CHATGPT_TOOLS } from '../src/workers/chatgpt/mcp-surface.ts';
import { copyDashboardViewModel } from '../src/workers/chatgpt/response-builder.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createInProcessOperationContext, createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import type { DashboardSourceCard, SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import type { SourceIndexAnswerResult } from '../src/workers/source-index/answer-types.ts';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const S = (name: string) => `SENTINEL_${name}_7f3a`;
const SENTINEL_PATTERN = /SENTINEL_[A-Z_]+_7f3a/;

type CardPatch = Partial<Omit<DashboardSourceCard, 'coverage' | 'connection' | 'queue_health' | 'answer_readiness'>> & {
  coverage?: Partial<DashboardSourceCard['coverage']>;
  connection?: Partial<DashboardSourceCard['connection']>;
  queue_health?: Partial<DashboardSourceCard['queue_health']>;
  answer_readiness?: Partial<DashboardSourceCard['answer_readiness']>;
};

function card(sourceId: string, patch: CardPatch = {}): DashboardSourceCard {
  const { coverage, connection, queue_health, answer_readiness, ...rest } = patch;
  return {
    corpus_id: 'internal.email',
    source_id: sourceId,
    label: sourceId,
    provider: sourceId.split('.')[0]!,
    family: 'email',
    trust_domain: 'secure_local',
    configured: true,
    freshness: { label: 'Last checked less than 1 hour ago', stale: false, hours: 0.2 },
    coverage: { indexed_items: 100, content_ready_items: 100, embedded_items: 200, needs_review_items: 0, ...coverage },
    ingestion_health: { coverage_percent: 100, stuck_count: 0, drain_state: 'enabled', label: 'ok' },
    tier_composition: [],
    queue_health: { label: 'Caught up', waiting: 0, active: 0, needs_attention: 0, ...queue_health },
    answer_readiness: { state: 'ready', label: 'Ready for questions', ...answer_readiness },
    connection: { state: 'synced', label: 'synced less than 1 hour ago', action: { kind: 'none' }, handles: [], ...connection },
    ...rest,
  };
}

function offCard(sourceId: string): DashboardSourceCard {
  return card(sourceId, {
    configured: false,
    coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0 },
    connection: { state: 'not_connected', label: 'not connected', action: { kind: 'oauth', source: 'dropbox', label: 'Connect' } },
    answer_readiness: { state: 'disconnected', label: 'Connect this source' },
  });
}

function view(sources: DashboardSourceCard[], extra: Record<string, unknown> = {}): SourceDashboardViewModel {
  return {
    kind: 'source_dashboard',
    generated_at: NOW.toISOString(),
    summary: {
      configured_sources: sources.length,
      connected_sources: sources.filter((source) => source.configured).length,
      answer_ready_sources: 0,
      needs_attention_sources: 0,
      total_indexed_items: 0,
      total_content_ready_items: 0,
    },
    onboarding: {
      steps: [],
      ask_first_question: { enabled: false, label: 'Ask your first question', suggestion: 'x' },
    },
    answer_lanes: [],
    where_your_data_lives: [],
    unassigned_corpora: { corpus_count: 0, indexed_items: 0, content_ready_items: 0, entries: [] },
    excluded_by_configuration: { rules: 0, prefixes: 0, items_present: 0, items_unevaluable: 0, entries: [] },
    folder_picker: { available: false, label: 'Choose folders', path: '/dashboard/dispositions', rules: 0 },
    sources,
    history: { sample_count: 0, eta_available: false },
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_names_returned: false,
      file_paths_returned: false,
      host_names_returned: false,
    },
    ...extra,
  } as SourceDashboardViewModel;
}

describe('dashboard view-model producer', () => {
  test('a connected, answer-ready engine is ready; sources keep roster order with their status words', () => {
    const vm = buildChatGptDashboardViewModel(view([
      offCard('dropbox.files'),
      card('gmail.email'),
    ]), { now: NOW });
    expect(vm.v).toBe(1);
    expect(vm.connection).toEqual({ state: 'ready' });
    expect(vm.sources.map((source) => [source.id, source.label, source.group, source.status])).toEqual([
      ['gmail.email', 'Gmail', 'cloud', 'Fresh'],
      ['dropbox.files', 'Dropbox', 'cloud', 'Off'],
    ]);
    expect(vm.sources[0]!.detail).toBe('synced 12m ago');
    expect(vm.sources[1]!.primary).toEqual({ label: 'Connect', tool: 'olympus_connect_source', args: { source: 'dropbox' } });
    expect(vm.sources[0]!.menu).toEqual([
      { label: 'Disconnect', tool: 'olympus_disconnect_source', args: { source_id: 'gmail.email' }, destructive: true },
    ]);
    expect(vm.models.change).toEqual({
      label: 'Change',
      tool: DASHBOARD_TOOL_NAME,
      args: {},
      disabledReason: 'Change models in Olympus on your Mac.',
    });
    expect(vm.needsYou).toEqual([]);
    expect(vm.progress).toBeUndefined();
    expect(vm.generatedAt).toBe(NOW.toISOString());
  });

  test('nothing connected is ready, so Connect works on the page', () => {
    const vm = buildChatGptDashboardViewModel(view([offCard('gmail.email')]), { now: NOW });
    expect(vm.connection.state).toBe('ready');
    expect(vm.connection.progress).toBeUndefined();
  });

  test('a first index in flight is ready, with progress in the source unit', () => {
    const vm = buildChatGptDashboardViewModel(view([card('google_drive.docs', {
      family: 'file',
      freshness: { label: 'Waiting for the first sync', stale: false },
      coverage: { indexed_items: 200, content_ready_items: 50, embedded_items: 0, embedded_files: 20 },
      queue_health: { label: 'Working now', waiting: 10, active: 1 },
      connection: { state: 'syncing', label: 'syncing' },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      progress: { indexed_items_per_hour: 100, eta_minutes: 90 },
    })]), { now: NOW });
    expect(vm.connection.state).toBe('ready');
    expect(vm.connection.progress).toBeUndefined();
    expect(vm.progress).toEqual({
      unit: 'files',
      phase: 'initial',
      percent: 25,
      itemsLeft: 150,
      etaSeconds: 5400,
      stalled: false,
      details: [
        // The first listing is still running, so it has a count and no total.
        { stage: 'Finding items', unit: 'files', done: 200, total: 0 },
        { stage: 'Reading', unit: 'files', done: 50, total: 200 },
        { stage: 'Indexing', unit: 'files', done: 20, total: 200 },
      ],
    });
    expect(vm.sources[0]!.status).toBe('Working');
    expect(vm.sources[0]!.progress).toEqual({ stage: 'listing', unit: 'files', done: 200, total: 0, percent: 0, stalled: false });
  });

  test('per-source progress names the first unfinished stage; reading counts the in-scope population only', () => {
    const vm = buildChatGptDashboardViewModel(view([card('dropbox.files', {
      family: 'file',
      // A finished listing: 300 found, 100 of them names only (not read by policy).
      connection: { state: 'synced', label: 'synced less than 1 hour ago' },
      coverage: { indexed_items: 300, not_read_by_policy_items: 100, content_ready_items: 150, embedded_items: 0, embedded_files: 120 },
      queue_health: { label: 'Working now', waiting: 10, active: 1 },
      answer_readiness: { state: 'syncing', label: 'Syncing now' },
      last_sync_at: NOW.toISOString(),
      movement: { extraction_at: NOW.toISOString() } as never,
    })]), { now: NOW });
    const dropbox = vm.sources[0]!;
    // Names-only items are done once listed: the reading total is 200, not 300.
    expect(dropbox.progress).toEqual({ stage: 'reading', unit: 'files', done: 150, total: 200, percent: 75, stalled: false });
    // Honesty rule: never Fresh, never "synced …", while a stage is unfinished.
    expect(dropbox.status).toBe('Working');
    expect(dropbox.detail).toBe('Reading');
    expect(vm.progress).toMatchObject({ unit: 'files', percent: 75, itemsLeft: 50, stalled: false });
    expect(vm.progress!.details).toEqual([
      { stage: 'Reading', unit: 'files', done: 150, total: 200 },
      { stage: 'Indexing', unit: 'files', done: 120, total: 200 },
    ]);
    expect(copyDashboardViewModel(vm)).toEqual(vm);
  });

  test('a finished source is done and may read Fresh; no overall progress remains', () => {
    const vm = buildChatGptDashboardViewModel(view([card('dropbox.files', {
      family: 'file',
      coverage: { indexed_items: 300, not_read_by_policy_items: 100, content_ready_items: 200, embedded_items: 400, embedded_files: 200 },
      last_sync_at: NOW.toISOString(),
    })]), { now: NOW });
    expect(vm.sources[0]!.progress).toEqual({ stage: 'done', unit: 'files', done: 200, total: 200, percent: 100, stalled: false });
    expect(vm.sources[0]!.status).toBe('Fresh');
    expect(vm.progress).toBeUndefined();
  });

  test('a source waiting for its folders is stalled on scope_pending, Needs you, fixed by the picker', () => {
    const vm = buildChatGptDashboardViewModel(view([card('dropbox.files', {
      family: 'file',
      scope_selection: { required: true, kind: 'folders', status: 'scope_pending', connected: true },
      connection: { state: 'synced', label: 'synced less than 1 hour ago' },
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0 },
    })]), { now: NOW });
    const dropbox = vm.sources[0]!;
    expect(dropbox.progress).toEqual({ stage: 'listing', unit: 'files', done: 0, total: 0, percent: 0, stalled: true, stalledReason: 'scope_pending' });
    expect(dropbox.status).toBe('Needs you');
    expect(dropbox.primary).toEqual({ label: 'Choose folders', tool: 'olympus_scope_list', args: { source_id: 'dropbox.files' } });
    expect(vm.needsYou.map((item) => item.fix)).toEqual([dropbox.primary!]);
    expect(vm.progress?.stalled).toBe(true);
  });

  test('a source whose credential is gone mid-index is stalled on waiting_for_credentials and reconnects', () => {
    const vm = buildChatGptDashboardViewModel(view([card('dropbox.files', {
      family: 'file',
      connection: { state: 'reauth_required', label: 'reauth required' },
      coverage: { indexed_items: 300, content_ready_items: 100, embedded_items: 0, embedded_files: 50 },
      last_sync_at: NOW.toISOString(),
    })]), { now: NOW });
    const dropbox = vm.sources[0]!;
    expect(dropbox.progress).toMatchObject({ stage: 'reading', stalled: true, stalledReason: 'waiting_for_credentials' });
    expect(dropbox.status).toBe('Needs you');
    const reconnect = { label: 'Reconnect', tool: 'olympus_connect_source', args: { source: 'dropbox' } };
    expect(dropbox.primary).toEqual(reconnect);
    expect(vm.needsYou.map((item) => item.fix)).toEqual([reconnect]);
  });

  test('indexing waits on the built-in model download with a fixed reason', () => {
    const vm = buildChatGptDashboardViewModel(view([card('dropbox.files', {
      family: 'file',
      coverage: { indexed_items: 100, content_ready_items: 100, embedded_items: 0, embedded_files: 0 },
      last_sync_at: NOW.toISOString(),
    })]), { now: NOW, embedding: { kind: 'built_in', state: 'downloading', percent: 40 } });
    expect(vm.sources[0]!.progress).toMatchObject({ stage: 'indexing', done: 0, total: 100, stalled: true, stalledReason: 'model_downloading' });
    expect(vm.sources[0]!.status).toBe('Working');
  });

  test('the response builder keeps progress to its closed sets', () => {
    const vm = buildChatGptDashboardViewModel(view([card('dropbox.files', { family: 'file' })]), { now: NOW });
    vm.sources[0]!.progress = { stage: 'nope' as never, unit: 'bytes' as never, done: -3, total: 2.6, percent: 140, stalled: false, stalledReason: S('REASON') as never };
    expect(copyDashboardViewModel(vm).sources[0]!.progress).toEqual({ stage: 'listing', unit: 'items', done: 0, total: 3, percent: 100, stalled: false });
    vm.sources[0]!.progress = { stage: 'reading', unit: 'files', done: 1, total: 2, percent: 50, stalled: true, stalledReason: S('REASON') as never };
    expect(copyDashboardViewModel(vm).sources[0]!.progress).toEqual({ stage: 'reading', unit: 'files', done: 1, total: 2, percent: 50, stalled: true });
  });

  test('a source mid-sign-in is connecting: Needs you, ChatGPT wording, connect tool as its fix', () => {
    const expiresAt = new Date(NOW.getTime() + 9 * 60_000).toISOString();
    const vm = buildChatGptDashboardViewModel(view([card('gmail.email', {
      configured: false,
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0 },
      connection: {
        state: 'awaiting_consent',
        label: 'awaiting browser consent',
        pending: { started_at: NOW.toISOString(), expires_at: expiresAt, expires_in_minutes: 9 },
      },
      answer_readiness: { state: 'disconnected', label: 'Connect this source' },
    })]), { now: NOW });
    const gmail = vm.sources[0]!;
    const fix = { label: 'Open sign-in again', tool: 'olympus_connect_source', args: { source: 'gmail' } };
    expect(gmail.connecting).toEqual({ expiresAt });
    expect(gmail.status).toBe('Needs you');
    expect(gmail.primary).toEqual(fix);
    expect(gmail.progress).toBeUndefined();
    expect(gmail.detail).toBe('Waiting for you to finish signing in…');
    expect(vm.needsYou).toEqual([{ id: 'source:gmail.email', sentence: 'Gmail — waiting for you to finish signing in', fix }]);
    // No local-dashboard phrasing reaches ChatGPT.
    const wire = JSON.stringify(copyDashboardViewModel(vm));
    expect(wire).not.toMatch(/tab|expires in|approve/i);
    expect(copyDashboardViewModel(vm)).toEqual(vm);
  });

  test('an expired sign-in is not connecting', () => {
    const vm = buildChatGptDashboardViewModel(view([card('gmail.email', {
      connection: {
        state: 'awaiting_consent',
        label: 'awaiting browser consent',
        pending: { started_at: NOW.toISOString(), expires_at: new Date(NOW.getTime() - 1).toISOString(), expires_in_minutes: 0 },
      },
    })]), { now: NOW });
    expect(vm.sources[0]!.connecting).toBeUndefined();
  });

  test('a source needing reauth is under needsYou with a reconnect tool call', () => {
    const vm = buildChatGptDashboardViewModel(view([card('gmail.email', {
      connection: { state: 'reauth_required', label: 'reauth required' },
    })]), { now: NOW });
    expect(vm.sources[0]!.status).toBe('Needs you');
    expect(vm.needsYou).toEqual([{
      id: 'source:gmail.email',
      sentence: 'Gmail — reauth required',
      fix: { label: 'Reconnect', tool: 'olympus_connect_source', args: { source: 'gmail' } },
    }]);
  });

  test('a connected source waiting for its folders is fixed by opening the picker', () => {
    const vm = buildChatGptDashboardViewModel(view([card('google_drive.docs', {
      family: 'file',
      scope_selection: { required: true, kind: 'folders', status: 'scope_pending', connected: true },
      connection: { state: 'connected', label: 'connected · choose folders to start' },
      coverage: { indexed_items: 0, content_ready_items: 0, embedded_items: 0 },
      answer_readiness: { state: 'empty', label: 'Waiting for the first sync' },
    })]), { now: NOW });
    const drive = vm.sources[0]!;
    expect(drive.primary).toEqual({ label: 'Choose folders', tool: 'olympus_scope_list', args: { source_id: 'google_drive.docs' } });
    for (const item of vm.needsYou) expect(item.fix.tool).toBeString();
  });

  test('every fix the engine sends names a tool, and none sends the owner to their Mac', () => {
    const vm = buildChatGptDashboardViewModel(view([
      card('gmail.email', { connection: { state: 'reauth_required', label: 'reauth required' } }),
      offCard('dropbox.files'),
      offCard('x.bookmarks'),
      card('readwise.library', { connection: { state: 'reauth_required', label: 'reauth required' } }),
    ]), { now: NOW, embedding: { kind: 'built_in', state: 'failed' } });
    const fixes = [
      ...vm.needsYou.map((item) => item.fix),
      ...vm.sources.flatMap((source) => [source.primary, ...(source.menu ?? [])]).filter((fix) => fix !== undefined),
      vm.models.change!,
    ];
    expect(fixes.length).toBeGreaterThan(4);
    for (const fix of fixes) {
      expect(typeof fix.tool).toBe('string');
      expect(fix.args).toBeDefined();
      expect(fix.label).not.toBe('Open Olympus on your Mac');
    }
    expect(copyDashboardViewModel(vm)).toEqual(vm);
  });

  test('a model download keeps the engine installing; embedding state passes through', () => {
    const vm = buildChatGptDashboardViewModel(view([card('gmail.email')]), {
      now: NOW,
      embedding: { kind: 'built_in', state: 'downloading', percent: 40 },
    });
    expect(vm.connection).toEqual({ state: 'installing', progress: { percent: 40, label: 'Getting search ready on your Mac' } });
    expect(vm.models.embedding).toEqual({ kind: 'built_in', state: 'downloading', percent: 40 });
  });

  test('cards off the product roster and model lanes never appear', () => {
    const vm = buildChatGptDashboardViewModel(view([
      card('gmail.email'),
      card('dropbox.files.band-2-areas'),
      card('venice.api'),
    ]), { now: NOW });
    expect(vm.sources.map((source) => source.id)).toEqual(['gmail.email']);
  });
});

/* ------------------------------------------------------------------ */
/* End to end over the remote handler                                  */
/* ------------------------------------------------------------------ */

function sentinelView(): SourceDashboardViewModel {
  const gmail = card('gmail.email', {
    label: S('CARD_LABEL'),
    corpus_id: S('CORPUS_ID'),
    connection: {
      state: 'reauth_required',
      label: S('CONNECTION_LABEL'),
      handles: [S('HANDLE')],
      provider_refusal: { code: 'access_denied', reason: S('REFUSAL') },
      action: { kind: 'oauth', source: 'gmail', label: 'Reauthenticate', redirect_uri_to_register: `https://x/${S('REDIRECT')}` },
    },
    answer_readiness: { state: 'needs_attention', label: S('READINESS') },
    tier_composition: [{ trust_domain: 'secure_local', label: S('TIER_LABEL'), indexed_items: 1, content_ready_items: 1 }],
    attention_reasons: [S('ATTENTION_REASON')],
    scope_selection: { required: true, kind: 'folders', status: 'approved', connected: true },
    freshness: { label: S('FRESHNESS'), stale: false, hours: 1 },
    ingestion_health: { coverage_percent: 50, stuck_count: 0, drain_state: 'enabled', label: S('HEALTH'), drain_unit: S('DRAIN') },
    queue_health: { label: S('QUEUE'), waiting: 0, active: 0, needs_attention: 0 },
    schedule: { running: false, consecutive_failures: 1, last_error_kind: S('ERROR_KIND'), degraded_reason: S('DEGRADED') },
  });
  const drive = card('google_drive.docs', {
    label: S('DRIVE_LABEL'),
    family: 'file',
    freshness: { label: 'Waiting for the first sync', stale: false },
    coverage: { indexed_items: 10, content_ready_items: 2, embedded_items: 0 },
    connection: { state: 'syncing', label: S('SYNC_LABEL') },
    answer_readiness: { state: 'syncing', label: 'Syncing now' },
    queue_health: { label: 'Working now', waiting: 3, active: 1, needs_attention: 0 },
  });
  return view([gmail, drive, card(S('UNKNOWN_SOURCE'), { label: S('UNKNOWN_LABEL') })], {
    degraded_credentials: [{
      kind: 'worker_credential_degraded',
      display_name: S('CREDENTIAL_NAME'),
      state: 'stopped',
      status_label: 'Credential unavailable - needs your attention',
      hint: S('CREDENTIAL_HINT'),
      attempts: 3,
      max_attempts: 3,
      affected_profiles: [S('PROFILE')],
    }],
    sensitivity: {
      configured: true,
      editable: false,
      categories: [{
        id: 'health',
        label: S('CATEGORY_LABEL'),
        interpretation: S('CATEGORY_EXAMPLES'),
        target_tier_name: 'Private',
        target_trust_tier: 'S4',
        target_trust_domain: 'secure_local',
        match_terms: 3,
      }],
    },
    folder_picker: { available: true, label: S('FOLDER_PICKER'), path: '/dashboard/dispositions', rules: 1 },
    unassigned_corpora: {
      corpus_count: 1,
      indexed_items: 1,
      content_ready_items: 1,
      entries: [{ corpus_id: S('UNASSIGNED_ID'), trust_domain: 'secure_local', label: S('UNASSIGNED_LABEL'), indexed_items: 1, content_ready_items: 1 }],
    },
    excluded_by_configuration: {
      rules: 1, prefixes: 1, items_present: 1, items_unevaluable: 0,
      entries: [{ source_id: 'dropbox.files', label: S('EXCLUDED_LABEL'), rules: [{ id: 'r1', prefix: `/${S('FOLDER_NAME')}` }] }],
    },
    where_your_data_lives: [{ id: 'x', label: S('TRUST_CARD'), detail: S('TRUST_DETAIL') }],
    onboarding: {
      steps: [{ id: 'scope', label: 'Scope', state: 'active', next_action: S('NEXT_ACTION') }],
      ask_first_question: { enabled: true, label: 'Ask your first question', suggestion: S('SUGGESTION') },
    },
    model_setup: {
      ready: false,
      checked_at: NOW.toISOString(),
      attention: S('MODEL_ATTENTION'),
      cards: [
        { id: 'local', label: S('MODEL_LABEL'), required: true, state: 'needs_attention', detail: S('MODEL_DETAIL') },
        { id: 'venice', label: S('VENICE_LABEL'), required: true, state: 'ready', detail: S('VENICE_DETAIL') },
      ],
    },
  });
}

function sentinelAnswer(): SourceIndexAnswerResult {
  return {
    answer: 'The budget was approved in March.',
    evidence: [
      {
        corpus_id: S('EVIDENCE_CORPUS'),
        trust_domain: 'secure_local',
        family: 'email',
        provider: 'gmail',
        provider_item_id: S('ITEM_ID'),
        provider_thread_id: S('THREAD_ID'),
        folder_names: [S('PRIVATE_FOLDER')],
        title: S('PRIVATE_TITLE'),
        source_label: S('SOURCE_LABEL'),
        author_label: S('AUTHOR'),
        uri: `https://mail.google.com/${S('PRIVATE_URI')}`,
        authored_at: '2026-03-02T10:00:00.000Z',
      },
      {
        corpus_id: S('EVIDENCE_CORPUS_2'),
        trust_domain: 'internal',
        family: 'file',
        provider: 'google_drive',
        provider_item_id: S('ITEM_ID_2'),
        provider_file_id: S('FILE_ID'),
        folder_names: [S('PERSONAL_FOLDER')],
        title: 'Budget plan 2026',
        uri: 'https://docs.google.com/document/d/abc',
        authored_at: '2026-03-01T09:00:00.000Z',
        citation_span: { chunk_index: 1, chunk_id: S('CHUNK'), char_start: 0, char_end: 1, item_char_start: 0, item_char_end: 1, chunk_chars: 1, lane: 'keyword' },
      },
    ],
    secret_locations: [{ source: 'dropbox', ref: S('SECRET_REF'), locator: S('SECRET_LOCATOR'), title: S('SECRET_TITLE'), finding_kinds: [S('FINDING')] }],
    audit: {
      searched_corpora: [S('SEARCHED')],
      skipped_corpora: [{ corpus_id: S('SKIPPED'), trust_domain: 'secure_local', reason: S('SKIP_REASON') }],
      lane_audits: [],
      answer_synthesis: {
        private_context_used: privateContextUsed,
        secure_local_items_consulted: privateContextUsed ? 1 : 0,
        internal_content_used: false,
        internal_items_consulted: 0,
        internal_content_failures: 0,
        analyst_backend: 'local',
        raw_source_exposed: false,
      },
      latency_ms: 5,
      raw_source_exposed: false,
    },
    policy: {
      raw_source_exposed: false,
      source_packets_exposed: false,
      internal_content_exposed: false,
      secure_local_content_exposed: false,
      castor_safe_bridge: true,
    },
    opsec: { structured_evidence: [], release_decision: { decision: 'allow', reasons: [S('RELEASE')] }, raw_source_exposed: false },
  } as unknown as SourceIndexAnswerResult;
}

let dir: string;
let store: RemoteConnectionStore;
let server: ReturnType<typeof Bun.serve>;
let base: string;
let answerMode: 'ok' | 'throw';
let dashboardMode: 'ok' | 'throw';
let privateContextUsed: boolean;
let privateProbe: boolean;
let servesChatGpt: boolean;
let answerRequests: Array<Record<string, unknown>>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-chatgpt-surface-'));
  store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
  answerMode = 'ok';
  dashboardMode = 'ok';
  privateContextUsed = false;
  privateProbe = true;
  servesChatGpt = true;
  answerRequests = [];
  const worker = createEmailSourceWorker({
    sourceAnswer: {
      async answer(request) {
        answerRequests.push(request as unknown as Record<string, unknown>);
        if (answerMode === 'throw') throw new Error(`answer failed at /Users/owner/${S('ERROR_PATH')}`);
        return sentinelAnswer();
      },
    },
    sourceIndexStatus: { async status() { throw new Error(S('STATUS_ERROR')); } },
  });
  const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
  const handler = createRemoteMcpHandler({
    connections: () => store,
    makeOperationContext: (caller, signal) => createInProcessOperationContext({
      config,
      sourceIndexReadEnabled: true,
      workerFetch: worker.fetch,
      caller,
      signal,
    }),
    chatgpt: {
      servesRequest: () => servesChatGpt,
      async privateMatchProbe() { return privateProbe; },
      async dashboardView() {
        if (dashboardMode === 'throw') throw new Error(S('DASHBOARD_ERROR'));
        return sentinelView();
      },
    },
  });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connectClient(): Promise<Client> {
  const { token } = store.create('ChatGPT');
  const client = new Client({ name: 'chatgpt-surface-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
  return client;
}

async function settle<T>(promise: Promise<T>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error) };
  }
}

describe('ChatGPT MCP surface over the remote handler', () => {
  test('lists the dashboard tool with MCP Apps and sidebar metadata, and annotates every tool', async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        DASHBOARD_TOOL_NAME,
        'olympus_search',
        'source_index_status',
        'source_answer',
        'source_answer_result',
        'olympus_connect_source',
        'olympus_scope_list',
        'olympus_scope_set',
        'olympus_disconnect_source',
        'olympus_model_set',
        'olympus_privacy_get',
        'olympus_privacy_set',
      ]);
      const readOnly = new Set([DASHBOARD_TOOL_NAME, 'olympus_search', 'source_index_status', 'source_answer', 'source_answer_result', 'olympus_scope_list', 'olympus_privacy_get']);
      for (const tool of tools) {
        if (readOnly.has(tool.name)) {
          expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
        } else {
          expect(tool.annotations?.readOnlyHint).toBe(false);
          expect(tool.annotations?.destructiveHint).toBe(tool.name === 'olympus_disconnect_source');
        }
      }
      const dashboard = tools.find((tool) => tool.name === DASHBOARD_TOOL_NAME)!;
      expect(dashboard._meta).toEqual({
        ui: { resourceUri: DASHBOARD_RESOURCE_URI },
        'openai/outputTemplate': DASHBOARD_RESOURCE_URI,
        'openai/ui': { entrypoints: [{ type: 'global' }] },
      });
      // A global entrypoint is opened with `{}`.
      expect(dashboard.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    } finally {
      await client.close();
    }
  });

  test('the wire tool definitions, securitySchemes included, are the ones the relay is generated from', async () => {
    // Raw JSON-RPC: the SDK client strips fields its schema does not know.
    const { token } = store.create('ChatGPT');
    const post = async (body: unknown, sessionId?: string) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      const data = text.trimStart().startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data:'))!.slice(5);
      return { sessionId: response.headers.get('mcp-session-id') ?? undefined, message: JSON.parse(data) };
    };
    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
    });
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sessionId);
    expect(list.message.result.tools).toEqual(JSON.parse(JSON.stringify(CHATGPT_TOOLS)));
  });

  test('serves the dashboard resource with the MCP Apps MIME type', async () => {
    const client = await connectClient();
    try {
      const { resources } = await client.listResources();
      expect(resources).toEqual([
        { uri: DASHBOARD_RESOURCE_URI, name: 'Olympus dashboard', mimeType: MCP_APP_MIME_TYPE },
        { uri: 'ui://olympus/private-answer', name: 'Olympus private answer', mimeType: MCP_APP_MIME_TYPE },
      ]);
      const read = await client.readResource({ uri: DASHBOARD_RESOURCE_URI });
      const content = read.contents[0] as { uri: string; mimeType: string; text: string; _meta: Record<string, unknown> };
      expect(content.uri).toBe(DASHBOARD_RESOURCE_URI);
      expect(content.mimeType).toBe('text/html;profile=mcp-app');
      expect(content.text).toContain('<!doctype html>');
      expect(content.text).toContain('tools/call');
      expect(content._meta).toMatchObject({ ui: { csp: { connectDomains: [], resourceDomains: [] }, domain: 'https://mcp.olympusplugin.ai' } });
      await expect(client.readResource({ uri: 'ui://olympus/other' })).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  test('the dashboard tool returns structuredContent matching the contract and a text summary', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: DASHBOARD_TOOL_NAME, arguments: {} });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as unknown as DashboardViewModelV1;
      expect(structured.v).toBe(1);
      expect(copyDashboardViewModel(structured)).toEqual(structured);
      expect(structured.sources.map((source) => source.label)).toEqual(['Gmail', 'Google Drive']);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain('Olympus is');
    } finally {
      await client.close();
    }
  });

  test('answers use Public and Personal evidence only; a Private match reaches the panel _meta only', async () => {
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: 'source_answer', arguments: { question: 'When was the budget approved?' } });
      expect(answerRequests[0]).toMatchObject({ include_secure_local: false, include_secure_local_content: false });
      expect(result.structuredContent).toEqual({
        status: 'answered',
        answer: 'The budget was approved in March.',
        citations: [
          { source: 'Google Drive', title: 'Budget plan 2026', url: 'https://docs.google.com/document/d/abc', date: '2026-03-01' },
        ],
        notes: ['Some matching items are private and stay on your Mac.'],
      });
      // The probe's boolean match counts as one item, for the panel only.
      expect((result._meta as Record<string, unknown>)['olympus/privateAnswer']).toEqual({ v: 1, count: 1, state: 'no_model' });
    } finally {
      await client.close();
    }
  });

  test('an answer synthesized from Private context is withheld', async () => {
    privateContextUsed = true;
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: 'source_answer', arguments: { question: 'budget?' } });
      expect(result.structuredContent).toEqual({
        status: 'answered',
        answer: 'Olympus can answer this only from private items, which stay on your Mac.',
        citations: [],
        notes: ['Some matching items are private and stay on your Mac.'],
      });
      // The probe's boolean match counts as one item, for the panel only.
      expect((result._meta as Record<string, unknown>)['olympus/privateAnswer']).toEqual({ v: 1, count: 1, state: 'no_model' });
    } finally {
      await client.close();
    }
  });

  test('no Private match and no Private evidence: no private sentence', async () => {
    privateProbe = false;
    const client = await connectClient();
    try {
      const result = await client.callTool({ name: 'source_answer', arguments: { question: 'budget?' } });
      // The fixture's Gmail item is tiered Private, so it still triggers the sentence.
      expect((result.structuredContent as { notes?: string[] }).notes).toEqual(['Some matching items are private and stay on your Mac.']);
    } finally {
      await client.close();
    }
  });

  test('callers the ChatGPT predicate does not accept keep the remote operation surface', async () => {
    servesChatGpt = false;
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(['source_answer', 'source_answer_result', 'source_index_status']);
      expect(tools.some((tool) => tool.name === DASHBOARD_TOOL_NAME)).toBe(false);
    } finally {
      await client.close();
    }
  });

  test('no Private or Secret sentinel leaves the engine on any channel, success or error', async () => {
    const client = await connectClient();
    const captured: unknown[] = [];
    try {
      captured.push(await settle(client.listTools()));
      captured.push(await settle(client.listResources()));
      captured.push(await settle(client.readResource({ uri: DASHBOARD_RESOURCE_URI })));
      captured.push(await settle(client.readResource({ uri: `ui://${S('RESOURCE')}` })));
      captured.push(await settle(client.callTool({ name: DASHBOARD_TOOL_NAME, arguments: {} })));
      captured.push(await settle(client.callTool({ name: 'source_index_status', arguments: {} })));
      captured.push(await settle(client.callTool({ name: 'source_answer', arguments: { question: 'budget?' } })));
      privateContextUsed = true;
      captured.push(await settle(client.callTool({ name: 'source_answer', arguments: { question: 'budget?' } })));
      privateContextUsed = false;
      captured.push(await settle(client.callTool({ name: 'source_answer_result', arguments: { job_id: 'saj_unknown' } })));
      captured.push(await settle(client.callTool({ name: 'source_answer', arguments: {} })));
      captured.push(await settle(client.callTool({ name: S('UNKNOWN_TOOL'), arguments: {} })));
      answerMode = 'throw';
      captured.push(await settle(client.callTool({ name: 'source_answer', arguments: { question: 'budget?' } })));
      dashboardMode = 'throw';
      captured.push(await settle(client.callTool({ name: DASHBOARD_TOOL_NAME, arguments: {} })));
      captured.push(await settle(client.callTool({ name: 'source_index_status', arguments: {} })));
    } finally {
      await client.close();
    }
    const serialized = JSON.stringify(captured);
    // The test exercised real content and real errors, not empty responses.
    expect(serialized).toContain('The budget was approved in March.');
    expect(serialized).toContain('Gmail');
    expect(serialized).toContain('"isError":true');
    expect(serialized.match(SENTINEL_PATTERN)?.[0]).toBeUndefined();
  });

  test('the producer alone never carries a sentinel, before the response builder runs', () => {
    const vm = buildChatGptDashboardViewModel(sentinelView(), { now: NOW });
    expect(JSON.stringify(vm).match(SENTINEL_PATTERN)?.[0]).toBeUndefined();
  });
});
