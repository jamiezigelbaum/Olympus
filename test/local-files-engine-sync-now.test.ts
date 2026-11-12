import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEnvBridgeSovereigntyConfig } from '../src/core/sovereignty.ts';
import { approveClassifier } from '../src/workers/classification-ledger.ts';
import { snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { STATUS_COUNTS_MAX_AGE_MS } from '../src/workers/connector-store/local-index.ts';
import { createWorkerFetch } from '../src/core/worker-transport.ts';
import type { DashboardSourceCard } from '../src/workers/source-dashboard.ts';
import { createTestClock, waitFor } from './helpers/test-clock.ts';

const REPO = join(import.meta.dir, '..');
const TOKEN = 'local-files-engine-sync-fixture';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function engine(split: boolean, tier: 'private' | 'secure') {
  const home = mkdtempSync('/tmp/olympus-files-engine-');
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'run'), { mode: 0o700 });
  const socket = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = socket.port;
  socket.stop(true);
  const clock = createTestClock(0);
  const clockPath = join(home, 'clock-offset');
  writeFileSync(clockPath, '0');
  const preload = join(home, 'clock.ts');
  // Advance cache age without waiting five minutes; subprocess timers keep
  // running normally while the parent controls the offset with its test clock.
  writeFileSync(preload, `import { readFileSync } from 'node:fs';
    const realNow = Date.now;
    Date.now = () => realNow() + Number(readFileSync(${JSON.stringify(clockPath)}, 'utf8'));
  `);
  let releaseJudge!: () => void;
  const judgeGate = new Promise<void>(resolve => { releaseJudge = resolve; });
  cleanups.push(() => releaseJudge());
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/models')) return Response.json({ data: [{ id: 'test-answer' }, { id: 'test-judge' }] });
    const body = await request.json() as { model: string; messages: Array<{ content: string }> };
    const items = body.messages.flatMap(message => message.content.split('\n'))
      .filter(line => line.startsWith('{')).flatMap(line => {
        try { const item = JSON.parse(line); return typeof item.i === 'number' ? [item] : []; } catch { return []; }
      });
    if (body.model === 'test-judge') await judgeGate;
    const content = body.model === 'test-judge' ? JSON.stringify({ verdicts: items.map(item => ({
      i: item.i, tier: tier === 'secure' ? 'private' : 'personal', category: 'ordinary',
      ownRecord: false, privateKind: 'none', confidence: 0.99,
    })) }) : 'ready';
    return Response.json({ model: body.model, choices: [{ message: { content } }] });
  } });
  cleanups.push(() => { model.stop(true); });
  const env = {
    PATH: process.env.PATH ?? '', HOME: home,
    XDG_DATA_HOME: join(home, 'd'), XDG_STATE_HOME: join(home, 's'),
    XDG_CONFIG_HOME: join(home, 'c'), XDG_RUNTIME_DIR: join(home, 'run'),
    OLYMPUS_EMAIL_SOURCE_PORT: String(port), OLYMPUS_WORKER_AUTH_TOKEN: TOKEN,
    OLYMPUS_WORKER_SCHEDULER_ENABLED: 'true', OLYMPUS_TIER_SNIFFER_ENABLED: 'true',
    OLYMPUS_TIER_SNIFFER_INTERVAL_MS: '100',
    OLYMPUS_WORKER_SCHEDULER_TICK_SECONDS: '1',
    OLYMPUS_WORKER_SCHEDULER_SYNC_INTERVAL_SECONDS: '2',
    OLYMPUS_SOURCE_INDEX_ENABLED: 'true',
    OLYMPUS_ARGUS_SOURCE_ANSWER_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
    OLYMPUS_ARGUS_SOURCE_ANSWER_MODEL: 'test-answer',
    OLYMPUS_ENGINE_BACKGROUND_SOCKET: join(home, 'run', 'olympus', 'background.sock'),
    OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: join(home, 'c', 'olympus', 'handles.json'),
    NODE_ENV: 'test',
  };
  const config = buildEnvBridgeSovereigntyConfig(env);
  config.modelProfiles['fixture-judge'] = {
    provider: 'local-openai-compatible', trust: 'local', purpose: 'classification',
    baseUrl: `http://127.0.0.1:${model.port}/v1`, model: 'test-judge', snifferMode: 'full',
  };
  const policyPath = join(home, 'sovereignty.json');
  writeFileSync(policyPath, JSON.stringify(config));
  const ledgerPath = join(home, 'classification.jsonl');
  await approveClassifier(ledgerPath, { kind: 'local', profileId: 'fixture-judge', modelId: 'test-judge' },
    snifferPromptVersions().approval, 'Fixture owner approved the deterministic local judge.');
  let output = '';
  const spawn = (role?: 'background' | 'front') => {
    const child = Bun.spawn([process.execPath, '--preload', preload, join(REPO, 'src/workers/engine/server.ts')], {
      cwd: REPO, env: { ...env, OLYMPUS_SOVEREIGNTY_CONFIG_PATH: policyPath, OLYMPUS_CLASSIFICATION_LEDGER_PATH: ledgerPath, ...(role ? { OLYMPUS_WORKER_ENGINE_ROLE: role } : {}) },
      stdout: 'pipe', stderr: 'pipe',
    });
    cleanups.push(async () => { child.kill('SIGKILL'); await child.exited; });
    for (const stream of [child.stdout, child.stderr]) void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk);
        output += text;
      }
    })();
  };
  if (split) {
    spawn('background');
    await waitFor(() => output.includes('engine background ready'), { timeoutMs: 30_000 });
    spawn('front');
  } else spawn();
  await waitFor(() => output.includes('worker listening'), { timeoutMs: 30_000 });
  const workerFetch = createWorkerFetch({ platform: 'linux', env });
  const call = async (path: string, body?: unknown): Promise<any> => {
    const response = await workerFetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(response.status, `${path}: ${text}\n${output}`).toBe(200);
    return JSON.parse(text);
  };
  const card = async (): Promise<DashboardSourceCard> => {
    const dashboard = await call('/dashboard.json');
    return dashboard.sources.find((source: DashboardSourceCard) => source.source_id === 'local.files');
  };
  const count = (path: string, sql: string): number => {
    let db: Database | undefined;
    try { db = new Database(path, { readonly: true }); return (db.query(sql).get() as { n: number }).n; }
    catch { return 0; }
    finally { db?.close(); }
  };
  return { home, call, card, output: () => output, releaseJudge,
    extracted: () => count(join(home, 'd/openclaw/olympus/file-extraction-jobs.sqlite'),
      "SELECT COUNT(*) AS n FROM extraction_jobs WHERE status = 'indexed'"),
    judged: () => count(join(home, 'd/openclaw/olympus/sources/local.files/1/stores/secure_local.tier-ledger.sqlite'),
      `SELECT COUNT(*) AS n FROM tier_items WHERE state = 'current' AND content_pending = 0 AND content_read = 1 AND content_tier = '${tier}'`),
    async expireCounts() { await clock.advance(STATUS_COUNTS_MAX_AGE_MS + 1); writeFileSync(clockPath, String(clock.now())); },
  };
}

for (const split of [false, true]) for (const tier of ['private', 'secure'] as const) {
  test(`fresh folder: connect, approve, Sync now (${split ? 'split' : 'single'} engine, judged ${tier})`, async () => {
    const f = await engine(split, tier);
    const folder = join(f.home, 'rc-files');
    mkdirSync(folder);
    for (const [name, text] of [
      ['trip-notes', 'Packing list for the lake trip: tent, stove, two jackets.'],
      ['recipes', 'Lentil soup: onion, carrot, lentils, stock, forty minutes.'],
      ['budget', 'October budget check: groceries, transport, books.'],
    ]) writeFileSync(join(folder, `${name}.txt`), text!);
    writeFileSync(join(f.home, 'outside.txt'), 'This file has no approval.');
    expect((await f.card()).coverage.indexed_items).toBe(0);
    await f.call('/dashboard/connect/this-computer', { source: 'local.files' });
    const listed = await f.call('/dashboard/tools/call', {
      name: 'olympus_scope_list', arguments: { source_id: 'local.files' },
    });
    const scope = listed._meta['olympus/scope'];
    const node = scope.nodes.find((entry: { name: string }) => entry.name === 'rc-files');
    expect(node).toBeDefined();
    const saved = await f.call('/dashboard/tools/call', {
      name: 'olympus_scope_set', arguments: {
        source_id: 'local.files', account_generation: scope.account_generation,
        scope_revision: scope.scope_revision, selections: [{ key: node.key, state: 'ingest' }],
      },
    });
    expect(saved.isError, JSON.stringify(saved)).toBeFalsy();
    await waitFor(async () => (await f.card()).sync_now_available, { timeoutMs: 20_000, intervalMs: 100 });
    await f.call('/dashboard/sync-now', { source: 'local.files' });
    await waitFor(() => f.extracted() === 3, { timeoutMs: 30_000 });
    // Populate the dashboard snapshot while the real judge still holds text Private.
    await f.call('/v1/source/index/status', { include_items: false });
    await f.card();
    const unjudged = await f.call('/v1/source/index/search', {
      corpus_id: 'internal.local.files', query: 'Packing',
    });
    expect(JSON.stringify(unjudged)).not.toContain('stove');
    f.releaseJudge();
    await waitFor(() => f.judged() === 3, { timeoutMs: 30_000 });
    // The first refresh after the allowed cache age must count the new copies,
    // rather than caching an expired held projection for another five minutes.
    await f.expireCounts();
    const card = await f.card();
    expect(card.coverage.indexed_items, JSON.stringify(card)).toBe(3);
    expect(card.coverage.not_read_by_policy_items, JSON.stringify(card)).toBe(0);

    // A new approval must hide the old rows immediately, even though their
    // judged copies are still stored and the preceding snapshot is fresh.
    const empty = join(f.home, 'empty-folder');
    mkdirSync(empty);
    const current = (await f.call('/dashboard/tools/call', {
      name: 'olympus_scope_list', arguments: { source_id: 'local.files' },
    }))._meta['olympus/scope'];
    const changed = await f.call('/dashboard/tools/call', {
      name: 'olympus_scope_set', arguments: {
        source_id: 'local.files', account_generation: current.account_generation,
        scope_revision: current.scope_revision, selections: [{ key: empty, state: 'ingest' }],
      },
    });
    expect(changed.isError, JSON.stringify(changed)).toBeFalsy();
    const narrowed = await f.card();
    expect(narrowed.coverage.indexed_items).toBe(0);
    expect(narrowed.coverage.not_read_by_policy_items ?? 0).toBe(0);
    for (const corpus_id of ['internal.local.files', 'secure_local.local.files']) {
      expect((await f.call('/v1/source/index/search', { corpus_id, query: 'Packing' })).hits).toHaveLength(0);
    }
  }, 120_000);
}
