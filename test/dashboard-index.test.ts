import { describe, expect, test } from 'bun:test';
import {
  DASHBOARD_HTML_PATH,
  DASHBOARD_LEGACY_QUERY_PARAMS,
  dashboardHtmlRoutePage,
  dashboardLegacyRedirect,
  dashboardReadToken,
  isDashboardHtmlRoute,
} from '../src/workers/dashboard/index.ts';
import { computerOpenTargets, dashboardLocalPageHref } from '../src/workers/dashboard/host-page.ts';

function dashboardUrl(query = ''): URL {
  return new URL(`http://worker.test${DASHBOARD_HTML_PATH}${query}`);
}

describe('dashboard html route matching', () => {
  test('claims exactly the /dashboard pathname, with or without a query', () => {
    expect(isDashboardHtmlRoute(dashboardUrl())).toBe(true);
    expect(isDashboardHtmlRoute(dashboardUrl('?source=gmail.email'))).toBe(true);
    expect(isDashboardHtmlRoute(dashboardUrl('?token=dash_abc'))).toBe(true);
    // The pathname is what workers/http.ts allowlists for the dash_ query
    // token, so this module must never claim a path of its own.
    expect(isDashboardHtmlRoute(new URL('http://worker.test/dashboard.json'))).toBe(false);
    expect(isDashboardHtmlRoute(new URL('http://worker.test/dashboard/dispositions'))).toBe(false);
    expect(isDashboardHtmlRoute(new URL('http://worker.test/'))).toBe(false);
  });
});

// Unified dashboard phase 4 (owner decision 2026-10-09): the panel is the only
// dashboard; /dashboard is its host page plus the computer's own pages.
describe('which page a /dashboard address names', () => {
  test('the bare address is the host page; the computer\'s pages are query flags', () => {
    expect(dashboardHtmlRoutePage(dashboardUrl())).toBe('host');
    expect(dashboardHtmlRoutePage(dashboardUrl('?token=dash_abc'))).toBe('host');
    expect(dashboardHtmlRoutePage(dashboardUrl('?keys'))).toBe('keys');
    expect(dashboardHtmlRoutePage(dashboardUrl('?agents'))).toBe('agents');
    expect(dashboardHtmlRoutePage(dashboardUrl('?outside-help'))).toBe('outside_help');
    expect(dashboardHtmlRoutePage(dashboardUrl('?connector'))).toBe('connector');
    expect(dashboardHtmlRoutePage(dashboardUrl('?panel-read'))).toBe('panel_read');
  });

  test('every replaced page\'s address is legacy, and legacy wins over any other flag', () => {
    expect([...DASHBOARD_LEGACY_QUERY_PARAMS]).toEqual(['source', 'background', 'sensitivity', 'setup', 'privacy', 'embedding-ledger']);
    for (const param of DASHBOARD_LEGACY_QUERY_PARAMS) {
      expect(dashboardHtmlRoutePage(dashboardUrl(`?${param}=x`))).toBe('legacy');
      expect(dashboardHtmlRoutePage(dashboardUrl(`?keys&${param}`))).toBe('legacy');
    }
  });

  test('a legacy address goes to /dashboard, keeping only a dash_ reader\'s token', () => {
    expect(dashboardLegacyRedirect(dashboardUrl('?source=gmail.email'))).toBe('/dashboard');
    expect(dashboardLegacyRedirect(dashboardUrl('?setup&token=dash_abc'))).toBe('/dashboard?token=dash_abc');
    // Anything that is not a dash_ token is never carried into a Location.
    expect(dashboardLegacyRedirect(dashboardUrl('?background&token=worker-secret'))).toBe('/dashboard');
    expect(dashboardReadToken(dashboardUrl('?token=dash_abc'))).toBe('dash_abc');
    expect(dashboardReadToken(dashboardUrl('?token=other'))).toBeUndefined();
  });

  test('local page links carry the reader\'s token', () => {
    expect(dashboardLocalPageHref('keys')).toBe('/dashboard?keys');
    expect(dashboardLocalPageHref('outsideHelp', 'dash_abc')).toBe('/dashboard?outside-help&token=dash_abc');
  });

  test('olympusplugin.ai open links land on the computer: Connect and model fixes on Keys, the dashboard on itself', () => {
    const targets = computerOpenTargets('http://127.0.0.1:8787');
    expect(Object.values(targets)).toContain('http://127.0.0.1:8787/dashboard');
    const connects = Object.entries(targets).filter(([path]) => path.startsWith('connect/'));
    expect(connects.length).toBeGreaterThan(0);
    for (const [, target] of connects) expect(target.startsWith('http://127.0.0.1:8787/dashboard?keys#')).toBe(true);
    for (const target of Object.values(targets)) expect(target.startsWith('http://127.0.0.1:8787/dashboard')).toBe(true);
  });
});
