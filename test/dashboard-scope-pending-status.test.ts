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
import { statusGlyph } from '../src/workers/dashboard/components.ts';

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
  expect(dashboardSubLine(dropbox)).toBe('waiting for folder selection');
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

test('home groups a scope-pending source with the first-sync wait, under the waiting glyph', () => {
  const html = renderDashboardHomePage(view, { now: DASHBOARD_PREVIEW_NOW });
  expect(html).toContain('Waiting — 3');
  expect(html).not.toContain('Fresh — ');
  const card = cardFor(html, 'dropbox.files');
  expect(card).toContain('waiting for folder selection');
  expect(card).not.toContain('synced');
  // The same glyph Readwise draws while it waits for its first sync.
  const waitingGlyph = statusGlyph('Waiting');
  expect(card).toContain(waitingGlyph);
  expect(cardFor(html, 'readwise.library')).toContain(waitingGlyph);
  expect(cardFor(html, 'readwise.library')).toContain('waiting for the first sync');
});

test('setup lists a scope-pending source under Waiting, not Fresh', () => {
  const html = renderDashboardSetupPage(view);
  expect(html).toContain('Waiting — 3');
  expect(html).not.toContain('Fresh — ');
  const start = html.indexOf('Waiting — 3');
  const section = html.slice(start, html.indexOf('<div class="sect', start + 1));
  expect(section).toContain('>Dropbox<');
  expect(section).toContain('>Google Drive<');
  expect(section).toContain('waiting for folder selection');
  expect(section).toContain('>Readwise<');
  expect(section).toContain('waiting for the first sync');
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
    expect(dashboardSubLine(drive)).toBe('waiting for folder selection');
    const home = renderDashboardHomePage(built, { now: DASHBOARD_PREVIEW_NOW });
    expect(cardFor(home, 'google_drive.docs')).toContain('waiting for folder selection');
    expect(cardFor(home, 'google_drive.docs')).toContain(statusGlyph('Waiting'));
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

function cardFor(html: string, sourceId: string): string {
  const start = html.indexOf(`href="/dashboard?source=${sourceId}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</a>', start));
}
