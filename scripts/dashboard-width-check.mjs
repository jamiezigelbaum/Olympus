/** Browser regression proof against the fixture-only dashboard-preview server.
 * Run with Playwright installed; DASHBOARD_SHOTS optionally saves render proof.
 * No worker, private store, or live system is used.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.DASHBOARD_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ ...(process.env.DASHBOARD_CHROME_CHANNEL ? { channel: process.env.DASHBOARD_CHROME_CHANNEL } : {}), args: ['--no-sandbox'] });
const base = process.env.DASHBOARD_PREVIEW_URL || 'http://127.0.0.1:8930';
const shots = process.env.DASHBOARD_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const long = 'LongUnbrokenSourceName'.repeat(40);
try {
  for (const colorScheme of ['light', 'dark']) {
    const page = await browser.newPage({ colorScheme });
    for (const width of [320, 390, 700, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of ['home', 'keys', 'agents', 'private-answers', 'connector']) {
        await page.goto(`${base}/dashboard?controls&${name === 'home' ? '' : name}`);
        await page.waitForTimeout(250);
        if (name === 'private-answers') {
          await page.locator('textarea').fill('What does my lease say about renewal?');
          await page.locator('[data-pa-ask] button[type=submit]').click();
          await page.locator('.paanswer ul').waitFor();
          assert.equal(await page.locator('.paquestion strong').first().textContent(), 'What does my lease say about renewal?');
        }
        if (shots && [390, 1280].includes(width) && ['private-answers', 'home'].includes(name)) {
          await page.screenshot({ path: `${shots}/${name}-${colorScheme}-${width}.png`, fullPage: true });
        }
        // Exercise disclosures and long content after capturing the normal render.
        for (const frame of page.frames()) {
          await frame.evaluate((long) => {
            document.querySelectorAll('details').forEach((node) => { node.open = true; });
            for (const selector of ['.paq', '.pafrom', '.pasrc li', '.paquestion strong', '.source-name', '.sline', '.agentbody p']) {
              const node = document.querySelector(selector);
              if (node) node.append(document.createTextNode(' https://example.com/' + long));
            }
            const answer = document.querySelector('.paanswer');
            if (answer && window.olympusMarkdown) {
              window.olympusMarkdown(document, answer, '\n\n```\n' + long + '\n```\n\n| Source | Detail |\n| --- | --- |\n| ' + long + ' | ' + long + ' |');
            }
          }, long);
          const size = await frame.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
          assert.ok(size.document <= size.viewport, `${name} ${colorScheme} ${width}px: ${JSON.stringify(size)}`);
        }
      }
    }
    await page.close();
  }
  console.log('No horizontal overflow: all five dashboard pages, light/dark, 320/390/700/1280px, opened disclosures and long text/code/tables.');
} finally { await browser.close(); }
