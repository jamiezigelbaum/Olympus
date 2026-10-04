// Calibration labeler (design docs/design/categorization-precision.md, step 1).
//
// A local page for the owner to mark each sampled file Personal or Private.
// It listens on 127.0.0.1 only, behind a random one-time token in the URL,
// and writes nothing but labels.json in the calibration directory. It never
// opens an Olympus store, ledger or engine.
//
//   bun eval/calibration/label.ts [--dir DIR] [--port N] [--no-open]

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { CALIBRATION_DIR_DEFAULT, readLabels, readSample, writeLabels, type CalibrationLabel } from './files.ts';

const LABELS: readonly CalibrationLabel[] = ['personal', 'private', 'unsure', 'skip'];
const EXCERPT_CHARS = 6_000;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const dir = flag('--dir') ?? CALIBRATION_DIR_DEFAULT;
const sample = readSample(dir);
const labels = readLabels(dir);
const token = randomBytes(16).toString('hex');
const byId = new Map(sample.items.map((item) => [item.id, item]));

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(flag('--port') ?? 0),
  async fetch(request) {
    const url = new URL(request.url);
    const host = request.headers.get('host') ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return new Response('Forbidden', { status: 403 });
    const prefix = `/${token}`;
    if (!url.pathname.startsWith(prefix)) return new Response('Not found', { status: 404 });
    const route = url.pathname.slice(prefix.length) || '/';
    if (request.method === 'GET' && route === '/') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && route === '/items') {
      return Response.json({
        root: sample.root,
        items: sample.items.map((item) => ({
          id: item.id,
          name: item.name,
          folder: item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : '',
          sizeBytes: item.sizeBytes,
          modifiedAt: item.modifiedAt,
          textChars: item.text.length,
          excerpt: item.text.slice(0, EXCERPT_CHARS),
        })),
        labels: labels.labels,
      }, { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'POST' && route === '/label') {
      const body = await request.json() as { id?: string; label?: string | null };
      if (!body.id || !byId.has(body.id)) return new Response('Unknown item', { status: 400 });
      if (body.label === null) delete labels.labels[body.id];
      else if (LABELS.includes(body.label as CalibrationLabel)) {
        labels.labels[body.id] = { label: body.label as CalibrationLabel, at: new Date().toISOString() };
      } else return new Response('Unknown label', { status: 400 });
      writeLabels(dir, labels);
      return Response.json({ ok: true, labeled: Object.keys(labels.labels).length });
    }
    if (request.method === 'POST' && route === '/reveal') {
      const body = await request.json() as { id?: string };
      const item = body.id ? byId.get(body.id) : undefined;
      if (!item) return new Response('Unknown item', { status: 400 });
      spawn('open', ['-R', item.path], { stdio: 'ignore', detached: true }).unref();
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  },
});

const address = `http://127.0.0.1:${server.port}/${token}/`;
console.log(`Labeling ${sample.items.length} files (${Object.keys(labels.labels).length} already labeled).`);
console.log(`Open: ${address}`);
console.log('Labels are saved after every click to the calibration folder. Ctrl-C to stop.');
if (!argv.includes('--no-open')) spawn('open', [address], { stdio: 'ignore', detached: true }).unref();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Olympus calibration</title>
<style>
:root { color-scheme: light dark; --bg:#f7f7f5; --card:#fff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e3e3e0;
  --personal:#1f7a4d; --private:#9b2c2c; --unsure:#8a6d1d; --skip:#55575c; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --card:#1f1f22; --ink:#ececee; --muted:#9a9aa1; --line:#2e2e33; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 20px 16px 40px; }
header { display:flex; gap:12px; align-items:baseline; justify-content:space-between; flex-wrap:wrap; }
h1 { font-size:17px; margin:0; }
.progress { color:var(--muted); font-variant-numeric: tabular-nums; }
.bar { height:4px; background:var(--line); border-radius:2px; margin:10px 0 16px; overflow:hidden; }
.bar > div { height:100%; background:var(--personal); width:0; transition: width .2s; }
details.rule { color:var(--muted); margin-bottom:14px; }
details.rule p { margin:6px 0; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; }
.name { font-size:19px; font-weight:600; word-break:break-word; }
.meta { color:var(--muted); font-size:13px; margin-top:4px; word-break:break-word; }
.current { margin-top:8px; font-size:13px; }
pre { white-space:pre-wrap; word-break:break-word; font:13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:12px; max-height:46vh; overflow:auto; margin:14px 0 0; }
.buttons { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:8px; margin-top:16px; }
button { font:inherit; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--ink); padding:11px 8px; cursor:pointer; }
button.label { color:#fff; border:none; font-weight:600; }
button.personal { background:var(--personal); } button.private { background:var(--private); }
button.unsure { background:var(--unsure); } button.skip { background:var(--skip); }
button.chosen { outline:3px solid var(--ink); outline-offset:2px; }
kbd { font:12px ui-monospace, Menlo, monospace; opacity:.8; margin-left:4px; }
.nav { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
.nav button { flex:1 1 auto; }
.done { text-align:center; padding:40px 10px; }
@media (max-width: 520px) { .buttons { grid-template-columns: repeat(2, minmax(0,1fr)); } }
</style></head>
<body><main>
<header><h1>Olympus calibration: Personal or Private?</h1><div class="progress" id="progress"></div></header>
<div class="bar"><div id="bar"></div></div>
<details class="rule"><summary>What counts as Private</summary>
<p><b>Private</b>: a real person's own information. Their records and results (labs, medical, therapy), statements, bills,
tax and bank papers, contracts and legal papers about them, filled-in forms, identity documents, intimate or family matters.</p>
<p><b>Personal</b>: everything else, including books, articles, guides, courses and program rules on sensitive topics
(health, money, law, psychology), work, plans, notes and hobbies.</p>
<p>Judge the file as it is. Nothing here changes Olympus; labels only measure it.</p></details>
<div id="view"></div>
</main>
<script>
const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
let items = [], labels = {}, index = 0;
const NAMES = { personal: 'Personal', private: 'Private', unsure: 'Not sure', skip: 'Skip' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function counts() {
  const done = items.filter((it) => labels[it.id]).length;
  document.getElementById('progress').textContent = done + ' of ' + items.length + ' labeled';
  document.getElementById('bar').style.width = (items.length ? done * 100 / items.length : 0) + '%';
  return done;
}
function render() {
  const done = counts();
  const view = document.getElementById('view');
  if (index >= items.length) {
    const by = {}; for (const it of items) { const l = labels[it.id]?.label; if (l) by[l] = (by[l] || 0) + 1; }
    view.innerHTML = '<div class="card done"><div class="name">' + (done === items.length ? 'All labeled. Thank you.' : 'End of the list.') +
      '</div><p class="meta">' + Object.entries(by).map(([k, v]) => NAMES[k] + ': ' + v).join(' · ') + '</p>' +
      '<div class="nav"><button id="first">Back to the first unlabeled</button></div></div>';
    document.getElementById('first').onclick = () => { const i = items.findIndex((it) => !labels[it.id]); index = i < 0 ? 0 : i; render(); };
    return;
  }
  const it = items[index];
  const chosen = labels[it.id]?.label;
  view.innerHTML = '<div class="card">' +
    '<div class="name">' + esc(it.name) + '</div>' +
    '<div class="meta">' + esc(it.folder || '(top level)') + '</div>' +
    '<div class="meta">' + fmtSize(it.sizeBytes) + ' · modified ' + esc(it.modifiedAt.slice(0, 10)) + ' · item ' + (index + 1) + ' of ' + items.length +
      (it.textChars > it.excerpt.length ? ' · showing the first ' + it.excerpt.length.toLocaleString() + ' characters' : '') + '</div>' +
    (chosen ? '<div class="current">Labeled: <b>' + NAMES[chosen] + '</b></div>' : '') +
    '<pre>' + esc(it.excerpt) + '</pre>' +
    '<div class="buttons">' +
      ['personal', 'private', 'unsure', 'skip'].map((l, i) => '<button class="label ' + l + (chosen === l ? ' chosen' : '') + '" data-label="' + l + '">' +
        NAMES[l] + '<kbd>' + ['P', 'X', 'U', 'S'][i] + '</kbd></button>').join('') +
    '</div>' +
    '<div class="nav"><button id="prev">← Previous</button><button id="reveal">Show in Finder<kbd>F</kbd></button>' +
      '<button id="next">Next →</button><button id="nextOpen">Next unlabeled<kbd>N</kbd></button></div></div>';
  for (const b of view.querySelectorAll('button[data-label]')) b.onclick = () => choose(b.dataset.label);
  document.getElementById('prev').onclick = () => { index = Math.max(0, index - 1); render(); };
  document.getElementById('next').onclick = () => { index = Math.min(items.length, index + 1); render(); };
  document.getElementById('nextOpen').onclick = nextUnlabeled;
  document.getElementById('reveal').onclick = reveal;
}
function nextUnlabeled() {
  for (let step = 1; step <= items.length; step += 1) {
    const i = (index + step) % items.length;
    if (!labels[items[i].id]) { index = i; render(); return; }
  }
  index = items.length; render();
}
// Label and move on at once; saves go out one at a time, in order.
let saving = Promise.resolve();
function choose(label) {
  const it = items[index];
  const before = labels[it.id];
  labels[it.id] = { label, at: new Date().toISOString() };
  nextUnlabeled();
  saving = saving.then(async () => {
    try {
      const res = await fetch(base + 'label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id, label }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      if (before) labels[it.id] = before; else delete labels[it.id];
      counts();
      alertBox('Could not save "' + it.name + '". Is the labeler still running?');
    }
  });
}
function alertBox(text) { document.getElementById('progress').textContent = text; }
async function reveal() { await fetch(base + 'reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: items[index].id }) }); }
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || index >= items.length) return;
  const k = e.key.toLowerCase();
  const map = { p: 'personal', x: 'private', u: 'unsure', s: 'skip' };
  if (map[k]) { e.preventDefault(); choose(map[k]); }
  else if (k === 'n') nextUnlabeled();
  else if (k === 'f') reveal();
  else if (e.key === 'ArrowLeft') { index = Math.max(0, index - 1); render(); }
  else if (e.key === 'ArrowRight') { index = Math.min(items.length, index + 1); render(); }
});
fetch(base + 'items').then((r) => r.json()).then((data) => {
  items = data.items; labels = data.labels || {};
  const first = items.findIndex((it) => !labels[it.id]);
  index = first < 0 ? items.length : first;
  render();
});
</script></body></html>`;
