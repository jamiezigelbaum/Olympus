// Calibration labeler (design docs/design/categorization-precision.md, step 1).
//
// A local page for the owner to mark each sampled file Personal or Private.
// It listens on 127.0.0.1 only, behind a random one-time token in the URL,
// and writes nothing but its labels file in the calibration directory. It never
// opens an Olympus store, ledger or engine.
//
//   bun eval/calibration/label.ts [--dir DIR] [--port N] [--no-open] [--importance]
//
// --importance is a second pass over the items labeled Private: Important or
// Minor, saved to importance.json. Its only write to labels.json is P, Actually
// Personal, which corrects that item's label and records that it was corrected.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  CALIBRATION_DIR_DEFAULT,
  readImportance,
  readLabels,
  readSample,
  writeImportance,
  writeLabels,
  type CalibrationImportance,
  type CalibrationLabels,
} from './files.ts';
import { longMessageView } from './long-message-view.ts';

const EXCERPT_CHARS = 6_000;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const dir = flag('--dir') ?? CALIBRATION_DIR_DEFAULT;
const importancePass = argv.includes('--importance');
const sample = readSample(dir);
/** A whole-item sample (sample-whole.ts): the whole item is shown, and Private carries its importance. */
const wholePass = !importancePass && (sample.recipe as { kind?: string } | undefined)?.kind === 'whole-item';
/** A choice on the page: what is saved, what it reads, its key, and the button style it borrows. */
const CHOICES = wholePass
  ? [
      { label: 'personal', name: 'Personal', key: 'P', style: 'personal' },
      { label: 'private_important', name: 'Private: important', key: 'I', style: 'private' },
      { label: 'private_minor', name: 'Private: minor', key: 'M', style: 'private' },
      { label: 'secret', name: 'Secret', key: 'X', style: 'skip' },
      { label: 'unsure', name: 'Not sure', key: 'U', style: 'unsure' },
    ]
  : importancePass
  ? [
      { label: 'important', name: 'Important', key: 'I', style: 'private' },
      { label: 'minor', name: 'Minor', key: 'M', style: 'personal' },
      { label: 'unsure', name: 'Not sure', key: 'U', style: 'unsure' },
      { label: 'personal', name: 'Actually Personal', key: 'P', style: 'skip' },
    ]
  : [
      { label: 'personal', name: 'Personal', key: 'P', style: 'personal' },
      { label: 'private', name: 'Private', key: 'X', style: 'private' },
      { label: 'unsure', name: 'Not sure', key: 'U', style: 'unsure' },
      { label: 'skip', name: 'Skip', key: 'S', style: 'skip' },
    ];
/** Whole-item pass: where the sensitive part of a Private or Secret item is, asked after the label. */
const WHERE = [
  { where: 'excerpt', name: 'In the highlighted part', key: 'E' },
  { where: 'outside', name: 'Only outside it', key: 'O' },
  { where: 'attachment', name: 'In an attachment', key: 'A' },
  { where: 'names', name: 'In the name or sender', key: 'T' },
];
const HEADING = wholePass ? 'Olympus calibration: the whole item' : importancePass ? 'Olympus calibration: how much does this Private item matter?' : 'Olympus calibration: Personal or Private?';
const RULE = wholePass
  ? `<details class="rule"><summary>How to label</summary>
<p><b>Personal</b>: everything that is not Private, including articles, guides and work on sensitive topics.</p>
<p><b>Private</b>: a real person's own information (records, results, statements, bills, tax and bank papers, contracts, filled-in forms, identity documents, intimate or family matters).
<b>Important</b> must stay Private (a full lab report, a tax return); <b>minor</b> is Private but a rare slip would be acceptable (a meal receipt).</p>
<p><b>Secret</b>: passwords, keys, recovery codes, card or account numbers that unlock something.</p>
<p>Label the <b>whole item</b>: all of its text, its attachments and its name. The highlighted part is what the private judge reads.
For Private or Secret, then say where the sensitive part is.</p></details>`
  : importancePass
  ? `<details class="rule" open><summary>What counts as Important</summary>
<p><b>Important</b>: the things that must stay Private, such as a full blood lab report, full tax returns or a complete bank statement.</p>
<p><b>Minor</b>: Private, but a rare slip would be acceptable, such as a meal receipt, an Uber receipt or a casual question to a doctor.</p>
<p><b>Actually Personal</b>: this should not have been labeled Private. Pressing P corrects its label.</p></details>`
  : `<details class="rule"><summary>What counts as Private</summary>
<p><b>Private</b>: a real person's own information. Their records and results (labs, medical, therapy), statements, bills,
tax and bank papers, contracts and legal papers about them, filled-in forms, identity documents, intimate or family matters.</p>
<p><b>Personal</b>: everything else, including books, articles, guides, courses and program rules on sensitive topics
(health, money, law, psychology), work, plans, notes and hobbies.</p>
<p>Judge the file as it is. Nothing here changes Olympus; labels only measure it.</p></details>`;
const ownerLabels = readLabels(dir);
// A corrected item stays listed, so a slip of the P key can be undone.
const items = importancePass
  ? sample.items.filter((item) => ownerLabels.labels[item.id]?.label === 'private' || ownerLabels.labels[item.id]?.correctedInImportancePass)
  : sample.items;
const labels: { labels: Record<string, { label: string; at: string; importance?: string; where?: string }> } = importancePass ? readImportance(dir) : ownerLabels;
const save = () => (importancePass ? writeImportance(dir, labels as CalibrationImportance) : writeLabels(dir, labels as CalibrationLabels));
/** Importance pass: P turns the item's owner label to Personal and clears its tag; any other answer undoes that. */
function applyCorrection(id: string, label: string | null | undefined): void {
  const at = new Date().toISOString();
  if (label === 'personal') {
    delete labels.labels[id];
    ownerLabels.labels[id] = { label: 'personal', at, correctedInImportancePass: true };
  } else if (ownerLabels.labels[id]?.correctedInImportancePass) {
    ownerLabels.labels[id] = { label: 'private', at };
  } else return;
  writeLabels(dir, ownerLabels);
}
/** What the page shows as answered: a corrected item has no tag, so its label stands in. */
const pageLabels = () => (wholePass
  ? Object.fromEntries(Object.entries(labels.labels).map(([id, entry]) => [id, { ...entry, label: wholeChoiceOf(entry as WholeEntry) }]))
  : importancePass
  ? { ...labels.labels, ...Object.fromEntries(items.flatMap((item) => (ownerLabels.labels[item.id]?.correctedInImportancePass ? [[item.id, ownerLabels.labels[item.id]]] : []))) }
  : labels.labels);
type WholeEntry = CalibrationLabels['labels'][string];
/** The page's choice for a stored whole-item label, and back. */
function wholeChoiceOf(entry: WholeEntry): string {
  return entry.label === 'private' ? `private_${entry.importance ?? 'minor'}` : entry.label;
}
function wholeEntryOf(choice: string, before: WholeEntry | undefined): WholeEntry {
  const at = new Date().toISOString();
  const keepWhere = before?.where && (choice.startsWith('private_') || choice === 'secret') ? { where: before.where } : {};
  if (choice.startsWith('private_')) return { label: 'private', importance: choice.slice('private_'.length) as 'important' | 'minor', at, ...keepWhere };
  return { label: choice as WholeEntry['label'], at, ...keepWhere };
}
/** Everything the owner sees of one whole item. Sent one item at a time: long documents stay whole. */
function wholeView(item: (typeof items)[number]) {
  const detail = item.whole!;
  return {
    text: item.text,
    truncatedChars: detail.truncatedChars,
    judgeSees: item.judgeSees,
    judgeReadsAll: detail.judgeReadsAll,
    long: item.judgeSees === undefined ? undefined : longMessageView(item.text, item.judgeSees, item.text.length),
    extraction: detail.extraction,
    children: detail.children.map((child) => ({ name: child.name, mimeType: child.mimeType, text: child.text, truncatedChars: child.truncatedChars, extraction: child.extraction })),
  };
}
// A fixed --token keeps the link working when the labeler is restarted.
const token = flag('--token') ?? randomBytes(16).toString('hex');
const byId = new Map(items.map((item) => [item.id, item]));

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
    if (request.method === 'GET' && route === '/ping') return Response.json({ ok: true });
    if (request.method === 'GET' && route === '/items') {
      return Response.json({
        root: sample.root,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          folder: item.rel.includes('/') ? item.rel.slice(0, item.rel.lastIndexOf('/')) : '',
          sizeBytes: item.sizeBytes,
          modifiedAt: item.modifiedAt,
          textChars: item.text.length,
          excerpt: item.text.slice(0, EXCERPT_CHARS),
          source: item.source,
          judgeSees: item.judgeSees,
          context: item.context,
          long: wholePass || item.judgeSees === undefined ? undefined : longMessageView(item.text, item.judgeSees, EXCERPT_CHARS),
          whole: wholePass ? true : undefined,
          extraction: item.whole?.extraction?.outcome,
          attachments: item.whole?.children.length,
        })),
        labels: pageLabels(),
      }, { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'GET' && route === '/whole' && wholePass) {
      const item = byId.get(url.searchParams.get('id') ?? '');
      if (!item?.whole) return new Response('Unknown item', { status: 400 });
      return Response.json(wholeView(item), { headers: { 'cache-control': 'no-store' } });
    }
    if (request.method === 'POST' && route === '/where' && wholePass) {
      const body = await request.json() as { id?: string; where?: string };
      const entry = body.id ? labels.labels[body.id] as WholeEntry | undefined : undefined;
      if (!entry || !(entry.label === 'private' || entry.label === 'secret')) return new Response('Label it Private or Secret first', { status: 400 });
      if (!WHERE.some((choice) => choice.where === body.where)) return new Response('Unknown answer', { status: 400 });
      labels.labels[body.id!] = { ...entry, where: body.where as NonNullable<WholeEntry['where']> };
      save();
      return Response.json({ ok: true });
    }
    if (request.method === 'POST' && route === '/label') {
      const body = await request.json() as { id?: string; label?: string | null };
      if (!body.id || !byId.has(body.id)) return new Response('Unknown item', { status: 400 });
      if (body.label === null) delete labels.labels[body.id];
      else if (CHOICES.some((choice) => choice.label === body.label)) {
        labels.labels[body.id] = wholePass
          ? wholeEntryOf(body.label!, labels.labels[body.id] as WholeEntry | undefined)
          : { label: body.label!, at: new Date().toISOString() };
      } else return new Response('Unknown label', { status: 400 });
      if (importancePass) applyCorrection(body.id, body.label);
      save();
      return Response.json({ ok: true, labeled: Object.keys(labels.labels).length });
    }
    if (request.method === 'POST' && route === '/reveal') {
      const body = await request.json() as { id?: string };
      const item = body.id ? byId.get(body.id) : undefined;
      if (!item?.path) return new Response('Unknown item', { status: 400 });
      spawn('open', ['-R', item.path], { stdio: 'ignore', detached: true }).unref();
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  },
});

const address = `http://127.0.0.1:${server.port}/${token}/`;
console.log(`Labeling ${items.length} items (${Object.keys(labels.labels).length} already labeled).`);
console.log(`Open: ${address}`);
console.log('Labels are saved after every click to the calibration folder. Ctrl-C to stop.');
if (!argv.includes('--no-open')) spawn('open', [address], { stdio: 'ignore', detached: true }).unref();

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Olympus calibration</title>
<style>
:root { color-scheme: light dark; --bg:#f7f7f5; --card:#fff; --ink:#1d1d1f; --muted:#6b6b70; --line:#e3e3e0; --highlight:#ffe9a8;
  --personal:#1f7a4d; --private:#9b2c2c; --unsure:#8a6d1d; --skip:#55575c; }
@media (prefers-color-scheme: dark) { :root { --bg:#151517; --card:#1f1f22; --ink:#ececee; --muted:#9a9aa1; --line:#2e2e33; --highlight:#5c4a12; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 20px 16px 40px; }
header { display:flex; gap:12px; align-items:baseline; justify-content:space-between; flex-wrap:wrap; }
h1 { font-size:17px; margin:0; }
.progress { color:var(--muted); font-variant-numeric: tabular-nums; }
.bar { height:4px; background:var(--line); border-radius:2px; margin:10px 0 16px; overflow:hidden; }
.bar > div { height:100%; background:var(--personal); transform-origin:left; transform:scaleX(0); transition: transform .2s; }
details.rule { color:var(--muted); margin-bottom:14px; }
details.rule p { margin:6px 0; }
.long-badge { display:inline-block; margin-top:8px; padding:3px 8px; border-radius:6px; font-size:12px; font-weight:600; background:var(--highlight); color:var(--ink); }
.long-note { margin-top:10px; }
.long-names { margin-top:8px; font-size:12px; color:var(--muted); white-space:pre-wrap; word-break:break-word; }
.judge-read { background:var(--highlight); border-radius:2px; }
.judge-unread { opacity:.5; }
.cut-off { display:block; margin-top:10px; padding-top:8px; border-top:1px dashed var(--muted); font-weight:600; }
.context { margin:10px 0; padding:8px 10px; border-left:3px solid var(--line); opacity:.55; font-size:12px; line-height:1.45; }
.context-tag { font-weight:600; text-transform:uppercase; letter-spacing:.04em; font-size:10px; margin-bottom:4px; }
.context-line { white-space:pre-wrap; word-break:break-word; margin-top:4px; }
.context-line span { display:block; font-size:10px; }
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
<header><h1>${HEADING}</h1><div class="progress" id="progress"></div></header>
<div class="bar"><div id="bar"></div></div>
${RULE}
<div id="view"></div>
</main>
<script>
const base = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';
let items = [], labels = {}, index = 0;
const CHOICES = ${JSON.stringify(CHOICES)};
const WHERE = ${JSON.stringify(WHERE)};
const wholeCache = {};
const NAMES = Object.fromEntries(CHOICES.map((c) => [c.label, c.name]));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
function counts() {
  const done = items.filter((it) => labels[it.id]).length;
  document.getElementById('progress').textContent = done + ' of ' + items.length + ' labeled';
  document.getElementById('bar').style.transform = 'scaleX(' + (items.length ? done / items.length : 0) + ')';
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
  if (it.whole) return renderWhole(view, it);
  const chosen = labels[it.id]?.label;
  const judged = it.judgeSees !== undefined;
  view.innerHTML = '<div class="card">' + (judged ?
    '<div class="name">' + esc(it.source) + '</div>' +
    '<div class="meta">' + (it.long ? 'The whole message' : 'Exactly what the private judge reads') + ' · item ' + (index + 1) + ' of ' + items.length + '</div>' +
    (it.long ? '<div class="long-badge">Long message: the judge reads only part of it</div>' : '') :
    '<div class="name">' + esc(it.name) + '</div>' +
    '<div class="meta">' + esc(it.folder || '(top level)') + '</div>' +
    '<div class="meta">' + fmtSize(it.sizeBytes) + ' · modified ' + esc(it.modifiedAt.slice(0, 10)) + ' · item ' + (index + 1) + ' of ' + items.length +
      (it.textChars > it.excerpt.length ? ' · showing the first ' + it.excerpt.length.toLocaleString() + ' characters' : '') + '</div>') +
    (chosen ? '<div class="current">Labeled: <b>' + NAMES[chosen] + '</b></div>' : '') +
    contextBlock(it.context?.before) +
    (it.long ? longBlock(it.long) : '<pre>' + esc(judged ? it.judgeSees : it.excerpt) + '</pre>') +
    contextBlock(it.context?.after) +
    '<div class="buttons">' +
      CHOICES.map((c) => '<button class="label ' + c.style + (chosen === c.label ? ' chosen' : '') + '" data-label="' + c.label + '">' +
        c.name + '<kbd>' + c.key + '</kbd></button>').join('') +
    '</div>' +
    '<div class="nav"><button id="prev">← Previous</button>' + (judged ? '' : '<button id="reveal">Show in Finder<kbd>F</kbd></button>') +
      '<button id="next">Next →</button><button id="nextOpen">Next unlabeled<kbd>N</kbd></button></div></div>';
  for (const b of view.querySelectorAll('button[data-label]')) b.onclick = () => choose(b.dataset.label);
  document.getElementById('prev').onclick = () => { index = Math.max(0, index - 1); render(); };
  document.getElementById('next').onclick = () => { index = Math.min(items.length, index + 1); render(); };
  document.getElementById('nextOpen').onclick = nextUnlabeled;
  if (!judged) document.getElementById('reveal').onclick = reveal;
}
const needsWhere = (label) => label === 'secret' || String(label || '').startsWith('private_');
function renderWhole(view, it) {
  const detail = wholeCache[it.id];
  if (!detail) {
    view.innerHTML = '<div class="card"><div class="meta">Loading the whole item…</div></div>';
    fetch(base + 'whole?id=' + encodeURIComponent(it.id), { cache: 'no-store' }).then((r) => r.json()).then((d) => {
      wholeCache[it.id] = d;
      if (items[index] === it) render();
    }).catch(() => stopLabeling());
    return;
  }
  const entry = labels[it.id];
  const chosen = entry?.label;
  const failed = detail.extraction && detail.extraction.outcome === 'failed';
  const readNote = (x) => !x ? '' : x.outcome === 'failed' ? 'Olympus could not read its text (' + esc(x.status) + (x.errorKind ? ', ' + esc(x.errorKind) : '') + ')'
    : x.outcome === 'ocr' ? 'Text read from a scan or picture (OCR)' : x.outcome === 'transcript' ? 'Text transcribed from audio' : x.outcome === 'pending' ? 'Not read yet' : '';
  const body = detail.long ? longBlock(detail.long)
    : '<div class="meta long-note">' + (detail.judgeSees === undefined ? 'The private judge is not asked about this text.' : 'The private judge reads all of this text.') + '</div>' +
      '<pre>' + esc(detail.text || '(no text)') + '</pre>';
  view.innerHTML = '<div class="card">' +
    '<div class="name">' + esc(it.name) + '</div>' +
    '<div class="meta">' + esc(it.folder || '(top level)') + ' · ' + esc(it.source || '') + '</div>' +
    '<div class="meta">' + fmtSize(it.sizeBytes) + ' · ' + esc((it.modifiedAt || '').slice(0, 10)) + ' · item ' + (index + 1) + ' of ' + items.length +
      (detail.children.length ? ' · ' + detail.children.length + ' attachment' + (detail.children.length === 1 ? '' : 's') : '') + '</div>' +
    (readNote(detail.extraction) ? '<div class="long-badge"' + (failed ? ' style="background:#c00;color:#fff"' : '') + '>' + readNote(detail.extraction) + '</div>' : '') +
    (chosen ? '<div class="current">Labeled: <b>' + NAMES[chosen] + '</b>' + (entry.where ? ' · ' + esc(WHERE.find((w) => w.where === entry.where)?.name || '') : '') + '</div>' : '') +
    body +
    (detail.truncatedChars ? '<div class="meta">' + detail.truncatedChars.toLocaleString() + ' more characters are not shown.</div>' : '') +
    (detail.judgeSees !== undefined ? '<details class="rule"><summary>Exactly what the private judge reads</summary><pre>' + esc(detail.judgeSees) + '</pre></details>' : '') +
    detail.children.map((c) => '<div class="context" style="opacity:1"><div class="context-tag">Attachment · ' + esc(c.name) + ' · ' + esc(c.mimeType) +
      (readNote(c.extraction) ? ' · ' + readNote(c.extraction) : '') + '</div><pre>' + esc(c.text || '(no text)') + '</pre>' +
      (c.truncatedChars ? '<div class="meta">' + c.truncatedChars.toLocaleString() + ' more characters are not shown.</div>' : '') + '</div>').join('') +
    '<div class="buttons">' +
      CHOICES.map((c) => '<button class="label ' + c.style + (chosen === c.label ? ' chosen' : '') + '" data-label="' + c.label + '">' + c.name + '<kbd>' + c.key + '</kbd></button>').join('') +
    '</div>' +
    (needsWhere(chosen) ? '<div class="meta long-note">Where is the sensitive part?</div><div class="buttons">' +
      WHERE.map((w) => '<button class="' + (entry.where === w.where ? 'chosen' : '') + '" data-where="' + w.where + '">' + w.name + '<kbd>' + w.key + '</kbd></button>').join('') + '</div>' : '') +
    '<div class="nav"><button id="prev">← Previous</button><button id="next">Next →</button><button id="nextOpen">Next unlabeled<kbd>N</kbd></button></div></div>';
  for (const b of view.querySelectorAll('button[data-label]')) b.onclick = () => choose(b.dataset.label);
  for (const b of view.querySelectorAll('button[data-where]')) b.onclick = () => chooseWhere(b.dataset.where);
  document.getElementById('prev').onclick = () => { index = Math.max(0, index - 1); render(); };
  document.getElementById('next').onclick = () => { index = Math.min(items.length, index + 1); render(); };
  document.getElementById('nextOpen').onclick = nextUnlabeled;
}
function chooseWhere(where) {
  const it = items[index];
  if (!labels[it.id] || !needsWhere(labels[it.id].label)) return;
  labels[it.id] = { ...labels[it.id], where };
  nextUnlabeled();
  saving = saving.then(async () => {
    try {
      const res = await fetch(base + 'where', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id, where }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch { stopLabeling(); }
  });
}
function longBlock(long) {
  const note = long.located ? 'Highlighted: what the judge reads. Dimmed: what it does not. Label the whole message.' :
    'The judge reads only part of this, but those parts could not be marked. Label the whole message.';
  return '<div class="meta long-note">' + note + '</div>' +
    (long.names ? '<div class="long-names">' + esc(long.names) + '</div>' : '') +
    '<pre>' + long.parts.map((p) => '<span class="' + (p.read ? 'judge-read' : 'judge-unread') + '">' + esc(p.text) + '</span>').join('') +
    (long.cutOff ? '<span class="cut-off">Cut off here · ' + long.totalChars.toLocaleString() + ' characters in all</span>' : '') + '</pre>';
}
function contextBlock(messages) {
  if (!messages || messages.length === 0) return '';
  return '<div class="context"><div class="context-tag">Context only · not labeled</div>' +
    messages.map((m) => '<div class="context-line"><span>' + esc(m.sender) + ' · ' + esc(m.at.slice(0, 16).replace('T', ' ')) + '</span>' + esc(m.text) + '</div>').join('') + '</div>';
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
  labels[it.id] = { label, at: new Date().toISOString(), ...(before && before.where && needsWhere(label) ? { where: before.where } : {}) };
  // A whole item labeled Private or Secret stays up for the where question.
  if (it.whole && needsWhere(label)) render(); else nextUnlabeled();
  saving = saving.then(async () => {
    try {
      const res = await fetch(base + 'label', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: it.id, label }) });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      if (before) labels[it.id] = before; else delete labels[it.id];
      counts();
      stopLabeling();
    }
  });
}
// A lost server must stop the work at once: clicks that cannot save are wasted.
let stopped = false;
function stopLabeling() {
  stopped = true;
  document.getElementById('view').innerHTML = '<div class="card done" style="border:2px solid #c00"><div class="name" style="color:#c00">Stop: labels are not saving</div>' +
    '<p>The labeler is not answering, so nothing you click now would be kept. This page continues by itself when it comes back.</p></div>';
}
setInterval(async () => {
  let up = false;
  try { up = (await fetch(base + 'ping', { cache: 'no-store' })).ok; } catch {}
  if (!up && !stopped) stopLabeling();
  if (up && stopped) location.reload();
}, 3000);
async function reveal() { await fetch(base + 'reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: items[index].id }) }); }
document.addEventListener('keydown', (e) => {
  if (stopped || e.metaKey || e.ctrlKey || e.altKey || index >= items.length) return;
  const k = e.key.toLowerCase();
  const map = Object.fromEntries(CHOICES.map((c) => [c.key.toLowerCase(), c.label]));
  const it = items[index];
  const where = it.whole && needsWhere(labels[it.id]?.label) ? WHERE.find((w) => w.key.toLowerCase() === k) : undefined;
  if (where) { e.preventDefault(); chooseWhere(where.where); }
  else if (map[k]) { e.preventDefault(); choose(map[k]); }
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
