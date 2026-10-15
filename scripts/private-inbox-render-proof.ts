/** Synthetic dashboard preview QA, via an isolated Chrome CDP session on Xanthos.
 * Start scripts/dashboard-preview.ts and Chrome --remote-debugging-port=9223
 * with a scratch --user-data-dir. No production data or worker is involved.
 * REMOTE_BUILD_LOCAL_REASON=dashboard-preview bun scripts/private-inbox-render-proof.ts <durable-shots-dir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const shots = process.argv[2];
if (!shots) throw new Error('Supply the durable screenshot directory.');
mkdirSync(shots, { recursive: true });
const port = 9223;
for (const theme of ['light', 'dark']) for (const width of [390, 1280]) for (const opened of [false, true]) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('Chrome connection failed')); });
  let id = 0;
  const pending = new Map<number, { resolve: (result: Record<string, any>) => void; reject: (error: unknown) => void }>();
  ws.onmessage = event => {
    const response = JSON.parse(String(event.data));
    if (!response.id) return;
    const call = pending.get(response.id); pending.delete(response.id);
    if (response.error) call?.reject(new Error(response.error.message)); else call?.resolve(response.result);
  };
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, any>>((resolve, reject) => {
    pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await send('Page.navigate', { url: 'http://127.0.0.1:8930/dashboard?private-answers&controls&waiting=3' + (opened ? '#wq_preview_2' : '') });
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await send('Runtime.evaluate', { expression: `document.readyState === 'complete' && !!document.querySelector('[data-private-answers]') && ${opened ? "!!document.querySelector('[data-pa-out] .paanswer')" : 'true'}`, returnByValue: true });
      if (ready.result?.value === true) break;
      if (attempt === 39) throw new Error('Preview did not render');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const metrics = await send('Runtime.evaluate', { expression: `JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,body:document.body.scrollWidth,background:getComputedStyle(document.body).backgroundColor,hasList:!!document.querySelector('.paanswer ul'),hasBold:!!document.querySelector('.paanswer strong')})`, returnByValue: true });
    const dimensions = JSON.parse(metrics.result.value);
    const name = `${theme}-${width}-${opened ? 'opened' : 'inbox'}.png`;
    console.log(JSON.stringify({ name, ...dimensions }));
    if (dimensions.scroll > width || dimensions.body > width) throw new Error(`Sideways overflow in ${name}`);
    if (opened && (!dimensions.hasList || !dimensions.hasBold)) throw new Error(`Missing Markdown proof in ${name}`);
    await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
    const layout = await send('Page.getLayoutMetrics');
    const height = Math.ceil(layout.cssContentSize.height);
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    writeFileSync(join(shots, name), Buffer.from(screenshot.data, 'base64'));
  } finally {
    ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
  }
}
