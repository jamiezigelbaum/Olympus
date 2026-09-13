import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from '../scripts/dashboard-preview.ts';
import { buildDispositionsPreviewView } from '../scripts/control-ui-preview.ts';
import { renderDashboardControlUi, renderDashboardHtmlRoute } from '../src/workers/dashboard/index.ts';
import { renderSourceDispositionsControlUi, renderSourceDispositionsHtml } from '../src/workers/source-dispositions.ts';

describe('native Control UI rendering', () => {
  test('projects the full dashboard as an inert fragment with Gateway-owned authority', () => {
    const view = buildDashboardPreviewView('full');
    const native = renderDashboardControlUi({
      params: { view: 'home' },
      view,
      canWrite: true,
      options: { now: DASHBOARD_PREVIEW_NOW, nativeOAuthAvailable: true },
    });
    expect(native).toMatchObject({ status: 200, controller: 'dashboard', can_write: true, poll_interval_ms: 15_000 });
    expect(native.body).toContain('Dashboard sections');
    expect(native.body).toContain('data-connect-kind="oauth"');
    expect(native.body).not.toContain('<!doctype');
    expect(native.body).not.toContain('<script');
    expect(native.body).not.toContain('<style');
    expect(native.body).not.toContain('csrf');
    expect(native.body).not.toContain('worker_token');
    expect(native.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  test('native Setup never renders the standalone worker-token gate', () => {
    const native = renderDashboardControlUi({
      params: { view: 'setup' },
      view: buildDashboardPreviewView('partial'),
      canWrite: false,
      options: { now: DASHBOARD_PREVIEW_NOW, nativeOAuthAvailable: false },
    });
    expect(native.body).toContain('Read-only OpenClaw connection');
    expect(native.body).toContain('OAuth connections are unavailable until the Gateway has a trusted public origin.');
    expect(native.body).toContain('data-native-oauth-unavailable');
    expect(native.body).not.toContain('Worker token');
    expect(native.body).not.toContain('data-control-session-kind');
  });

  test('source and folder pages keep internal navigation and contain no executable response content', () => {
    const view = buildDashboardPreviewView('full');
    view.folder_picker = { available: true, label: 'Choose folders', path: '/dashboard/dispositions', rules: 2 };
    const source = renderDashboardControlUi({
      params: { view: 'source', source_id: 'dropbox.files' },
      view,
      canWrite: true,
      options: { now: DASHBOARD_PREVIEW_NOW },
    });
    expect(source.title).toBe('Olympus / Dropbox');
    expect(source.body).toContain('href="/dashboard?sensitivity"');
    const dispositions = renderSourceDispositionsControlUi(buildDispositionsPreviewView(), true);
    expect(dispositions.controller).toBe('dispositions');
    expect(dispositions.body).toContain('data-dispositions-source="dropbox.files"');
    expect(dispositions.body).not.toMatch(/<script|<style|on[a-z]+\s*=/i);
  });
});

describe('shared standalone controller', () => {
  test('the standalone dashboard and picker serialize the same imported controllers', () => {
    const page = renderDashboardHtmlRoute({
      url: new URL('http://worker.test/dashboard?setup'),
      view: buildDashboardPreviewView('partial'),
      options: { now: DASHBOARD_PREVIEW_NOW, controlSessionCsrfToken: 'csrf-fixture' },
    }).html;
    expect(page).toContain('function mountDashboardController');
    expect(page).toContain('data-olympus-dashboard-root');
    expect(page.match(/<script>/g)).toHaveLength(1);
    const picker = renderSourceDispositionsHtml(buildDispositionsPreviewView(), { csrfToken: 'csrf-fixture' });
    expect(picker).toContain('function mountDispositionsController');
    expect(picker).toContain('data-olympus-dispositions-root');
    expect(picker.match(/<script>/g)).toHaveLength(1);
  });

  test('the browser entry has no server-runtime dependency', async () => {
    const output = join('/tmp', `olympus-control-ui-test-${process.pid}.js`);
    const result = Bun.spawnSync([
      'bun', 'build', './src/control-ui.ts', '--target=browser', '--format=esm', `--outfile=${output}`,
    ], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const bundle = readFileSync(output, 'utf8');
    expect(bundle).not.toMatch(/bun:sqlite|node:fs|node:crypto|new Function|\beval\(/);
  }, 30_000);
});
