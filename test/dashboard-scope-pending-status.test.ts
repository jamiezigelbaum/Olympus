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
import { renderDashboardHomePage } from '../src/workers/dashboard/pages/home.ts';
import { renderDashboardSetupPage } from '../src/workers/dashboard/pages/setup.ts';
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

test('home shows a scope-pending source as one orange row with Choose folders, never Fresh', () => {
  // The ChatGPT dashboard's rule, from the shared derivation: a stall the owner
  // fixes here needs them, says why in one sentence and carries its fix.
  const html = renderDashboardHomePage(view, { now: DASHBOARD_PREVIEW_NOW });
  expect(html).not.toContain('— Fresh');
  const row = rowFor(html, 'dropbox.files');
  expect(row).toContain('class="dot tone-warn"');
  expect(row).toContain('Paused until you choose folders');
  expect(row).toContain('>Choose folders</a>');
  expect(row).not.toContain('Synced');
  // Readwise before its first sync is in progress, calmly: a yellow dot and
  // the card's own sentence, never an alarm and never Fresh.
  const readwise = rowFor(html, 'readwise.library');
  expect(readwise).toContain('class="dot tone-run"');
  expect(readwise).toContain('Waiting for the first sync');
  expect(readwise).not.toContain('· stalled');
});

test('setup lists a scope-pending source at the top with its one fix, not Fresh', () => {
  const html = renderDashboardSetupPage(view);
  expect(html).not.toContain('— Fresh');
  const rows = [...html.matchAll(/data-source-row="([^"]+)"/g)].map((match) => match[1]);
  expect(rows.slice(0, 2).sort()).toEqual(['dropbox.files', 'google_drive.docs']);
  for (const id of ['dropbox.files', 'google_drive.docs']) {
    const row = rowFor(html, id);
    expect(row).toContain('Paused until you choose folders');
    expect(row).toContain('>Choose folders</');
  }
  expect(rowFor(html, 'readwise.library')).toContain('Waiting for the first sync');
});

test('Google Drive connected with no approved folders reads Waiting through the real scope authority and builder', () => {
  // The chain the worker runs: the connect flow's Drive handle, the scope
  // authority's snapshot with no saved approval, the worker's summary status,
  // then the view-model builder. Nothing on the card is hand-set.
  const dir = mkdtempSync(join(tmpdir(), 'olympus-drive-scope-'));
  try {
    const registry = {
      version: 1,
      handles: [{
        handle: 'google_drive.personal',
        provider: 'google_drive',
        accountRole: 'personal',
        trustDomain: 'internal',
        allowedCapabilities: ['google_drive.docs.sync'],
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        connectedAt: '2026-07-07T15:35:00.000Z',
      }],
    } as unknown as ConnectedHandleRegistry;
    const authority = new FileSourceScopeAuthority({
      statePath: join(dir, 'file-source-scopes.json'),
      readRegistry: () => registry,
    });
    const snapshot = authority.snapshot('google_drive.docs');
    expect(snapshot.status).toBe('scope_pending');
    expect(snapshot.accountGeneration).toBeDefined();

    const built = buildSourceDashboardViewModel({
      sourceIndexStatus: { ...emptyStatusFor(DASHBOARD_PREVIEW_NOW) },
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: registry,
      fileSourceScopeStatus: { 'google_drive.docs': snapshot.status },
      now: DASHBOARD_PREVIEW_NOW,
    });
    const drive = built.sources.find((source) => source.source_id === 'google_drive.docs')!;
    expect(drive.scope_selection).toMatchObject({ required: true, status: 'scope_pending', connected: true });
    expect(dashboardStatus({ source: drive })).toBe('Waiting');
    expect(dashboardSubLine(drive)).toBe('choose which folders to include');
    const home = renderDashboardHomePage(built, { now: DASHBOARD_PREVIEW_NOW });
    expect(rowFor(home, 'google_drive.docs')).toContain('Paused until you choose folders');
    expect(rowFor(home, 'google_drive.docs')).toContain('class="dot tone-warn"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
