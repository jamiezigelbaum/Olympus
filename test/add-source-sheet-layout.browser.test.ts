import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { buildSourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { renderDashboardConnectPage } from '../src/workers/dashboard/pages/local.ts';

// 2026-11-15: in the Add a source sheet (480px wide) a setup row's description
// got a 0px grid column and printed one letter per line (Roam). The sheet must
// put the description on its own line, for every source's setup panel.

function freshView() {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: { generated_at: '2026-11-15T12:00:00.000Z', corpora: [] } as never,
    sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
    now: new Date('2026-11-15T12:00:00.000Z'),
  });
}

test('the Add a source sheet stacks each setup row description under its name', () => {
  const css = readFileSync(new URL('../src/workers/dashboard/pages/local.ts', import.meta.url), 'utf8');
  expect(css.includes('.srcsheet .setrow .blurb { grid-column: 1 / -1; grid-row: 2; }')).toBe(true);
});

function playwright(): { chromium: { launch(options?: object): Promise<any> } } | undefined {
  // Not an OLYMPUS_ name: the test preload clears those.
  const path = process.env.PLAYWRIGHT_MODULE;
  try {
    return createRequire(import.meta.url)(path ?? 'playwright');
  } catch {
    return undefined;
  }
}
const pw = playwright();

test.skipIf(!pw)('in a real browser, no setup panel in the Add a source sheet squeezes its text', async () => {
  const html = renderDashboardConnectPage(freshView(), { controlSessionCsrfToken: 'csrf-test' } as never);
  const browser = await pw!.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(html);
    const results: { id: string; narrow: string[] }[] = await page.evaluate(() => {
      const sheet = document.querySelector('dialog#add-source') as HTMLDialogElement;
      sheet.showModal();
      (sheet.querySelector('[data-source-catalog]') as HTMLElement).hidden = true;
      const panels = Array.from(sheet.querySelectorAll<HTMLElement>('[data-source-setup]'));
      return panels.map((panel) => {
        for (const other of panels) other.hidden = other !== panel;
        const narrow: string[] = [];
        // Any element holding a sentence of its own text must be wide enough to read.
        for (const el of Array.from(panel.querySelectorAll<HTMLElement>('*'))) {
          const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
          if (own.split(/\s+/).length < 4) continue;
          const box = el.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) continue;
          if (box.width < 160) narrow.push(`${el.className || el.tagName}: ${Math.round(box.width)}px "${own.slice(0, 40)}"`);
        }
        return { id: panel.dataset.sourceSetup ?? '', narrow };
      });
    });
    expect(results.length).toBeGreaterThan(5);
    expect(results.map((r) => r.id)).toContain('roam.archive');
    expect(results.filter((r) => r.narrow.length)).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30000);
