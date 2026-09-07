/**
 * Synthetic browser harness for the compiled native Control UI entry.
 * It exercises the real dashboard renderers and contains no accounts, worker
 * tokens, cookies, or live provider calls.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  OlympusDashboardControlParams,
  OlympusDashboardReadParams,
} from '../src/control-ui-contract.ts';
import { renderDashboardControlUi } from '../src/workers/dashboard/index.ts';
import { renderEmbeddingLedgerControlUi } from '../src/workers/dashboard/pages/embedding-ledger.ts';
import {
  renderSourceDispositionsControlUi,
  type SourceDispositionsView,
} from '../src/workers/source-dispositions.ts';
import { buildDashboardPreviewView, DASHBOARD_PREVIEW_NOW } from './dashboard-preview.ts';

const PORT = Number(process.env.CONTROL_UI_PREVIEW_PORT ?? 8931);
const ROOT = join(import.meta.dir, '..');

export function buildDispositionsPreviewView(): SourceDispositionsView {
  const counts = {
    items: 24,
    items_with_content: 16,
    excluded_items: 6,
    metadata_only_items: 8,
    metadata_only_items_with_content: 8,
    excluded_items_would_purge: 6,
    metadata_only_content_would_strip: 8,
    unevaluable_items: 0,
  };
  return {
    kind: 'source_dispositions',
    generated_at: DASHBOARD_PREVIEW_NOW.toISOString(),
    rules_path: '/preview/ingestion-dispositions.json',
    rules_present: true,
    schema_version: 1,
    rule_count: 2,
    sources: [{
      source_id: 'dropbox.files',
      label: 'Dropbox',
      corpus_ids: ['secure_local.dropbox.files'],
      store_present: true,
      editable_by_path: true,
      unenforceable_rule_ids: [],
      non_folder_rules: [],
      tree: {
        roots: [{
          name: '2 Areas',
          path: '/2 Areas',
          display_path: '/2 Areas',
          depth: 1,
          state: 'ingest',
          origin: 'default',
          mixed_below: true,
          unevaluable: false,
          truncated: false,
          counts,
          children: [{
            name: 'Finances',
            path: '/2 Areas/Finances',
            display_path: '/2 Areas/Finances',
            depth: 2,
            state: 'metadata_only',
            origin: 'explicit',
            mixed_below: false,
            unevaluable: false,
            truncated: false,
            counts: { ...counts, items: 8, excluded_items: 0, excluded_items_would_purge: 0 },
            children: [],
          }],
        }, {
          name: '3 Resources',
          path: '/3 Resources',
          display_path: '/3 Resources',
          depth: 1,
          state: 'exclude',
          origin: 'explicit',
          mixed_below: false,
          unevaluable: false,
          truncated: false,
          counts: { ...counts, items: 6, metadata_only_items: 0, metadata_only_content_would_strip: 0 },
          children: [],
        }],
        counts,
        truncated_nodes: 0,
        unplaced_items: 0,
      },
    }],
    cleanup: {
      dry_run_command: 'bun run source-exclusions:purge -- --dry-run',
      purge_command: 'bun run source-exclusions:purge -- --purge',
      strip_command: 'bun run source-exclusions:purge -- --strip-metadata-only',
      items_would_purge: 6,
      items_would_strip: 8,
      items_unevaluable: 0,
    },
    policy: {
      folder_paths_returned: true,
      writes_config_only: true,
      deletes_store_content: false,
      runs_purge_or_strip: false,
    },
  };
}

function readResult(params: OlympusDashboardReadParams, canWrite: boolean) {
  if (params.view === 'dispositions') {
    return renderSourceDispositionsControlUi(buildDispositionsPreviewView(), canWrite);
  }
  if (params.view === 'embedding_ledger') {
    return renderEmbeddingLedgerControlUi({
      skipped: 0,
      path: '/preview/embedding-ledger.jsonl',
      entries: [{
        recorded_at: '2026-07-07T18:00:00.000Z',
        kind: 'model_decision',
        what: 'Keep the approved local embedding model for secure Dropbox material.',
        model_id: 'preview/local-embedding-model',
        epoch: 'preview-v1',
        endpoint: 'http://127.0.0.1:8000/v1',
        scope: { corpora: ['secure_local.dropbox.files'], chunks: { 'secure_local.dropbox.files': 600_000 } },
        why: 'Preserve semantic search without sending secure material to a public endpoint.',
        approved_by: 'jamie',
        status: 'complete',
      }],
    }, canWrite, { now: DASHBOARD_PREVIEW_NOW });
  }
  return renderDashboardControlUi({
    params,
    view: buildDashboardPreviewView(params.view === 'setup' ? 'partial' : 'full'),
    canWrite,
    options: {
      now: DASHBOARD_PREVIEW_NOW,
      nativeOAuthAvailable: true,
      embeddingLedgerAvailable: true,
      embeddingRuntime: {
        state: 'running',
        stateLine: 'Embeddings: running now (metadata caught up)',
        scheduleLine: 'Runs whenever the source-processing guard admits the lane.',
        model: { name: 'preview/local-embedding-model', live: true, local: true, text: 'preview/local-embedding-model · local' },
        overrideOn: false,
        override: 'none',
        overridePath: '/preview/operator-override',
      },
    },
  });
}

function page(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Olympus native UI preview</title><style>
    body{margin:0;background:#09090c;color:#ddd;font:14px system-ui}.hostbar{position:sticky;top:0;z-index:20;display:flex;gap:10px;align-items:center;padding:10px 14px;background:#17171c;border-bottom:1px solid #292930}.hostbar button{background:#24242b;color:#ddd;border:1px solid #3a3a44;border-radius:6px;padding:6px 10px}.hostbar .spacer{flex:1}#app{min-height:calc(100vh - 50px)}</style></head>
  <body><div class="hostbar"><strong>OpenClaw · Plugins</strong><span id="nav"></span><span class="spacer"></span><label><input id="write" type="checkbox" checked> operator.write</label></div><div id="app"></div>
  <script type="module">
    import plugin from '/dist/control-ui/index.js';
    const listeners = new Set(); let mounted; let pageDef; let params = Object.fromEntries(new URL(location.href).searchParams);
    const connection = {connected:true,canRead:true,canWrite:true,canGrant:false,canAdmin:false,assistantAgentId:null};
    const host = {apiVersion:1,pluginId:'olympus',signal:new AbortController().signal,basePath:'/',locale:'en',connection,
      redact:t=>t,components:{},sessions:{},agents:{},onEvent:()=>()=>{},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},
      async request(method, body){const response=await fetch('/rpc/'+(method.endsWith('.read')?'read':'control'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,__can_write:connection.canWrite})});return response.json()},
      navigation:{openPage(target){params={...(target.params||{})};history.pushState({},'',this.pageHref(target));show()},pageHref(target){const q=new URLSearchParams(target.params||{});return '/?'+q}},
      ui:{registerPage(page){pageDef=page;return()=>{}},registerNavigation(item){const b=document.createElement('button');b.textContent=item.label;b.onclick=()=>host.navigation.openPage(item.page);document.querySelector('#nav').append(b);return()=>b.remove()},registerPanel:()=>()=>{},registerAction:()=>()=>{},registerAccessory:()=>()=>{},registerWidget:()=>()=>{},registerReplacement:()=>()=>{},selectReplacement(){},invalidate(){}}};
    plugin.activate(host);
    function show(){const context={host,signal:host.signal,props:params,presented:true,mountDefault:()=>()=>{}};if(!mounted)mounted=pageDef.mount(document.querySelector('#app'),context);else mounted.update(context)}
    document.querySelector('#write').onchange=e=>{connection.canWrite=e.target.checked;listeners.forEach(fn=>fn())};
    addEventListener('popstate',()=>{params=Object.fromEntries(new URL(location.href).searchParams);show()});show();
  </script></body></html>`;
}

if (import.meta.main) {
  Bun.serve({
    port: PORT,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') return new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (url.pathname === '/dist/control-ui/index.js') {
        return new Response(await readFile(join(ROOT, 'dist/control-ui/index.js')), { headers: { 'content-type': 'text/javascript' } });
      }
      if (request.method === 'POST' && url.pathname === '/rpc/read') {
        const body = await request.json() as OlympusDashboardReadParams & { __can_write?: boolean };
        const { __can_write, ...params } = body;
        return Response.json(readResult(params, __can_write === true));
      }
      if (request.method === 'POST' && url.pathname === '/rpc/control') {
        const body = await request.json() as OlympusDashboardControlParams & { __can_write?: boolean };
        if (body.__can_write !== true) return Response.json({ status: 403, body: { error: { message: 'Preview connection is read-only.' } } });
        return Response.json({ status: 501, body: { error: { message: 'Preview only: no worker or provider action runs here.' } } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  console.log(`native Control UI preview listening on http://127.0.0.1:${PORT}`);
}
