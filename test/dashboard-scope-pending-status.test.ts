import { expect, test } from 'bun:test';
import { DASHBOARD_PREVIEW_NOW, buildDashboardPreviewView } from '../scripts/dashboard-preview.ts';
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
  expect(html).toContain('Waiting — 2');
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
  expect(html).toContain('Waiting — 2');
  expect(html).not.toContain('Fresh — ');
  const start = html.indexOf('Waiting — 2');
  const section = html.slice(start, html.indexOf('<div class="sect', start + 1));
  expect(section).toContain('>Dropbox<');
  expect(section).toContain('waiting for folder selection');
  expect(section).toContain('>Readwise<');
  expect(section).toContain('waiting for the first sync');
});

function cardFor(html: string, sourceId: string): string {
  const start = html.indexOf(`href="/dashboard?source=${sourceId}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf('</a>', start));
}
