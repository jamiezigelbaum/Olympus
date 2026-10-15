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
    for (const width of [390, 900, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of ['home', 'keys', 'agents', 'private-answers', 'private-answers-on', 'private-answers-opened', 'private-answers-venice-off', 'private-answers-venice-opened', 'connector']) {
        const privatePage = name.startsWith('private-answers');
        await page.goto(`${base}/dashboard?controls&${privatePage ? 'private-answers&waiting=3&venice=' + (name === 'private-answers-venice-off' ? 'off' : 'ready') + '&anonymous=' + (name === 'private-answers' ? 'off' : 'on') : name === 'home' ? '' : name}`);
        await page.waitForTimeout(250);
        if (privatePage) {
          assert.deepEqual(await page.locator('.paasks h3').allTextContents(), ['Local model', 'zkAPI model', 'Venice model']);
          assert.equal(await page.locator('.paask textarea').count(), 1);
          assert.equal(await page.locator('#anonymous .paaction button[data-pa-action]').count(), name !== 'private-answers' ? 1 : 0);
          if (name === 'private-answers') assert.equal(await page.locator('#anonymous .paaction a').getAttribute('href'), '/dashboard?keys#anonymous');
          const edges = await page.locator('.paask textarea, .paasks, .palist').evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right };
          }));
          for (const edge of ['left', 'right']) assert.ok(Math.max(...edges.map(rect => rect[edge])) - Math.min(...edges.map(rect => rect[edge])) < 1, `${width}: shared ${edge} edge ${JSON.stringify(edges)}`);
          const alignment = await page.locator('.padestination').evaluateAll(rows => rows.map(row => {
            const name = row.querySelector('h3').getBoundingClientRect();
            const button = row.querySelector('.paaction > .btn').getBoundingClientRect();
            const rect = row.getBoundingClientRect();
            return { id: row.id, nameTop: name.top, buttonTop: button.top, buttonLeft: button.left, rowTop: rect.top, rowBottom: rect.bottom };
          }));
          assert.deepEqual(alignment.map(row => row.id), ['computer', 'anonymous', 'venice']);
          if (width >= 900) {
            const xs = alignment.map(row => row.buttonLeft);
            assert.ok(Math.max(...xs) - Math.min(...xs) < 1, `${width}: button lefts ${xs}`);
            for (const row of alignment) assert.ok(Math.abs(row.nameTop - row.buttonTop) < 1, `${width}: ${JSON.stringify(row)}`);
          } else {
            for (let i = 1; i < alignment.length; i++) assert.ok(alignment[i].rowTop >= alignment[i - 1].rowBottom, 'Phone rows must stack in order');
          }
          console.log(JSON.stringify({ name, colorScheme, width, alignment }));
          if (name === 'private-answers-opened' || name === 'private-answers-venice-opened') {
            const id = name === 'private-answers-opened' ? 'wq_preview_2' : 'wq_preview_1';
            await page.locator(`#${id} [data-pa-read]`).click();
            await page.locator(`#${id} .paanswer`).waitFor();
            assert.ok((await page.locator(`#${id} .paout`).textContent()).includes(name === 'private-answers-opened' ? 'What was sent to zkAPI' : 'What was sent to Venice'));
          }
          if (shots) {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: `${shots}/${name}-${colorScheme}-${width}.png`, fullPage: true });
          }
          await page.locator('[data-pa-ask]').first().locator('textarea').fill('What does my lease say about renewal?');
          await page.locator('[data-pa-ask]').first().locator('[data-pa-destination=computer]').click();
          await page.locator('[data-pa-ask]').first().locator('.paanswer ul').waitFor();
          assert.equal(await page.locator('[data-pa-ask]').first().locator('.paquestion strong').textContent(), 'What does my lease say about renewal?');
          if (name !== 'private-answers') {
            if (name !== 'private-answers-venice-off') {
              await page.locator('[data-pa-destination=venice]').click();
              await page.locator('form[data-pa-ask] .pameta').filter({ hasText: 'What was sent to Venice' }).waitFor();
            }
            await page.locator('[data-pa-destination=anonymous]').click();
            await page.locator('form[data-pa-ask] .pasent').waitFor();
            assert.equal(await page.locator('form[data-pa-ask] .pasent').textContent(), 'Prepared synthetic question');
          }
        }
        if (shots && [390, 1280].includes(width) && name === 'home') {
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
  console.log('No horizontal overflow: all dashboard pages plus three-destination ready/zkAPI-off/opened states; buttons share one column and align to their row names at 900/1280px; ordered rows at 390px; light/dark, 390/900/1280px, opened disclosures and long text/code/tables.');
} finally { await browser.close(); }
