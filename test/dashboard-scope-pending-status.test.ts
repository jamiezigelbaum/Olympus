import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_NOW, buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import type { ConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import type { DashboardSourceCard } from '../src/workers/source-dashboard.ts';
import { dashboardStatus, dashboardSubLine } from '../src/workers/dashboard/vocabulary.ts';

// The owner's first-install test (2026-09-23): Dropbox connected with its
// folders not yet chosen read Fresh, green, "synced just now", while nothing
// had been read. Built through the real view-model builder, not a hand-made
// card, so the test covers the derivation the pages actually receive.
const view = buildDashboardPreviewView('first-install');
const dropbox = view.sources.find((source) => source.source_id === 'dropbox.files')!;
const readwise = view.sources.find((source) => source.source_id === 'readwise.library')!;

test('a connected source waiting for its folder scope reads Waiting, never Fresh', () => {
  expect(dropbox.scope_selection).toMatchObject({ status: 'scope_pending', connected: true });
  expect(dropbox.connection.state).toBe('connected');
  expect(dashboardStatus({ source: dropbox })).toBe('Waiting');
  expect(dashboardSubLine(dropbox)).toBe('choose which folders to include');
  // The same word Readwise gets before its first sync.
  expect(readwise.connection.state).toBe('waiting_for_first_sync');
  expect(dashboardStatus({ source: readwise })).toBe('Waiting');
  // Generic over scope selection, not a Dropbox branch: any card carrying the
  // same declaration reads the same way.
  const drive: DashboardSourceCard = { ...dropbox, source_id: 'google_drive.docs', label: 'Google Drive' };
  expect(dashboardStatus({ source: drive })).toBe('Waiting');
  // Once scope is approved the connection state speaks again.
  const approved: DashboardSourceCard = { ...dropbox, scope_selection: { ...dropbox.scope_selection!, status: 'approved' } };
  expect(dashboardStatus({ source: approved })).toBe('Fresh');
  // A lapsed credential still outranks the wait.
  const reauth: DashboardSourceCard = { ...dropbox, connection: { ...dropbox.connection, state: 'reauth_required' } };
  expect(dashboardStatus({ source: reauth })).toBe('Needs you');
});

function emptyStatusFor(now: Date): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: now.toISOString(),
    corpora: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function rowFor(html: string, sourceId: string): string {
  const start = html.indexOf(`data-source-row="${sourceId}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-source-row="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}
