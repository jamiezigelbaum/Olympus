/**
 * The shared top nav: three destinations, the current one marked in a way a
 * screen reader can hear, and the reader's token carried on every link.
 */
import { describe, expect, test } from 'bun:test';
import { DASHBOARD_NAV_CSS, renderDashboardNav } from '../src/workers/dashboard/nav.ts';

describe('dashboard nav', () => {
  test('names the three pages that have an address of their own', () => {
    // Read from a page that is none of them, so no item is the current one and
    // every link renders in its plain shape.
    const html = renderDashboardNav('setup');

    expect(html).toContain('<a class="dnavlink" href="/dashboard">Home</a>');
    expect(html).toContain('<a class="dnavlink" href="/dashboard?background">Background</a>');
    expect(html).toContain('>Setup</a>');
    // The pages reached FROM those are not tabs: their target would change
    // meaning depending on what the reader last clicked.
    expect(html).not.toContain('source=');
    expect(html).not.toContain('sensitivity');
  });

  test('marks the active page for the eye and for a screen reader', () => {
    const background = renderDashboardNav('background');

    expect(background).toContain('<a class="dnavlink on" href="/dashboard?background" aria-current="page">Background</a>');
    // Exactly one item is current, whichever page is being read.
    expect(background.split('aria-current="page"').length - 1).toBe(1);
    expect(background.split('class="dnavlink on"').length - 1).toBe(1);
  });

  test('marks each of the three, and only that one', () => {
    for (const active of ['home', 'background', 'setup'] as const) {
      const html = renderDashboardNav(active);
      expect(html.split('aria-current="page"').length - 1).toBe(1);
    }
    expect(renderDashboardNav('home')).toContain('<a class="dnavlink on" href="/dashboard" aria-current="page">Home</a>');
    expect(renderDashboardNav('setup')).toContain('<a class="dnavlink on" href="/dashboard?setup" aria-current="page">Setup</a>');
  });

  test('carries the reader own query token onto every link', () => {
    // A browser can only reach this HTML with the read-only token in the URL,
    // so a nav on the bare path would 401 on its own first click.
    const html = renderDashboardNav('background', { basePath: '/dashboard?token=dash_abc' });

    expect(html).toContain('href="/dashboard?token=dash_abc"');
    expect(html).toContain('href="/dashboard?token=dash_abc&amp;background"');
    expect(html).toContain('href="/dashboard?token=dash_abc&amp;setup"');
  });

  test('refuses a base path that is not a same-document target', () => {
    const html = renderDashboardNav('home', { basePath: 'javascript:alert(1)' });

    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="/dashboard"');
  });

  test('stays an anchor on the current page, so tab order never changes shape', () => {
    const html = renderDashboardNav('background');

    expect(html.split('<a ').length - 1).toBe(3);
    expect(html).toContain('<nav class="dnav" aria-label="Dashboard sections">');
  });

  test('styles itself from theme tokens rather than a second palette', () => {
    expect(DASHBOARD_NAV_CSS).toContain('var(--t3)');
    expect(DASHBOARD_NAV_CSS).toContain('var(--link)');
    expect(DASHBOARD_NAV_CSS).not.toContain('#');
  });
});
