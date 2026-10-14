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
      for (const name of ['home', 'keys', 'agents', 'private-answers', 'private-answers-on', 'private-answers-opened', 'connector']) {
        const privatePage = name.startsWith('private-answers');
        await page.goto(`${base}/dashboard?controls&${privatePage ? 'private-answers&anonymous=' + (name === 'private-answers' ? 'off' : 'on') : name === 'home' ? '' : name}`);
        await page.waitForTimeout(250);
        if (privatePage) {
          assert.deepEqual(await page.locator('.paasks h3').allTextContents(), ['Ask privately', 'Ask anonymously']);
          assert.equal(await page.locator('.paasks .paask textarea').count(), 2);
          assert.equal(await page.locator('[data-pa-path=anonymous] button').isEnabled(), name !== 'private-answers');
          assert.equal(await page.locator('#anonymous a').getAttribute('href'), '/dashboard?keys#anonymous');
          if (name === 'private-answers-opened') {
            await page.locator('#wq_preview_2 [data-pa-read]').click();
            await page.locator('#wq_preview_2 .paanswer').waitFor();
            assert.ok((await page.locator('#wq_preview_2 .paout').textContent()).includes('What was sent outside'));
          }
          await page.locator('[data-pa-ask]').first().locator('textarea').fill('What does my lease say about renewal?');
          await page.locator('[data-pa-ask]').first().locator('button[type=submit]').click();
          await page.locator('[data-pa-ask]').first().locator('.paanswer ul').waitFor();
          assert.equal(await page.locator('[data-pa-ask]').first().locator('.paquestion strong').textContent(), 'What does my lease say about renewal?');
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
  console.log('No horizontal overflow: all five dashboard pages plus anonymous on/off/opened states, light/dark, 320/390/700/1280px, opened disclosures and long text/code/tables.');
} finally { await browser.close(); }
