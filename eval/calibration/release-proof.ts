// Counts-only release proof. NEVER use live data: supply a fresh checkpointed disposable data COPY
// and copied settings home. The real gate writes sniffer verdicts and queues item raises.
// HOME=/tmp/copied-home bun eval/calibration/release-proof.ts --root /tmp/copied-data --home /tmp/copied-home
// Inherit the engine's config/setup env (including sovereignty path); no endpoint/model override.
// Exit 1 means leakage, incomplete judging, or unavailable configuration, never a passing proof.
import { existsSync, realpathSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { appReleaseLogDbPaths } from '../../src/core/app-release-log.ts';
import { jobLedgerPathsToVisit } from '../../src/workers/file-extraction/job-names.ts';
import { loadWorkerConfig } from '../../src/core/config.ts';
import { isPublicTierRetired, isStandaloneEngineProcess } from '../../src/core/sovereignty.ts';
import { environmentWithWorkerSetupEnv } from '../../src/core/worker-auth.ts';
import { readClassificationLedger, isClassifierApproved } from '../../src/workers/classification-ledger.ts';
import { resolveSecretRefValueSync } from '../../src/core/secret-store.ts';
import { RELEASE_CHUNK_JUDGE_BUDGET_MS, type ReleaseInput, type ChunkReleaseResult } from '../../src/core/release-manifest.ts';
import type { SourceFamily, SourceTrustDomain } from '../../src/core/source-index/types.ts';
import { resolveJudgeChoiceRuntime } from '../../src/workers/classification/built-in-sniffer.ts';
import { judgeSpendingPath, readJudgeSpending } from '../../src/workers/classification/judge-spending.ts';
import { configureInstalledTierClassification, clearInstalledTierClassification } from '../../src/workers/classification/installed-tier-classification.ts';
import { privacyOwnerContext } from '../../src/workers/classification/privacy-profile.ts';
import { TierSnifferService, tierSnifferServiceEnv } from '../../src/workers/classification/sniffer-service.ts';
import { completeSnifferQuestion, prepareSnifferModel } from '../../src/workers/classification/sniffer-resolver.ts';
import type { SnifferModel, SnifferModelCompletion } from '../../src/workers/classification/sniffer-decision.ts';
import { parseSnifferBatchResponse, snifferPromptVersions, snifferVerdictTier, snifferMaterialForModel, snifferOwnMaterial, snifferMaterialCarriesSecret, snifferInjectionRule } from '../../src/workers/classification/sniffer.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { TIER_LEDGER_FILE_SUFFIX, SECRET_LOCATIONS_FILE_SUFFIX, tierSnifferPathForLedger, resolveClassificationLedgerPath } from '../../src/workers/classification/tier-ledger-path.ts';
import { LocalConnectorStore, TIER_SET_BINDING_RUN_ID } from '../../src/workers/connector-store/local-index.ts';
import { TieredStoreSet } from '../../src/workers/connector-store/tiered-store-set.ts';
import { createReleaseTierCheck, type TierVisibilityScope } from '../../src/workers/connector-store/tier-visibility.ts';
import { WorkerBootSecretResolver } from '../../src/workers/credential-degradation.ts';
import { loadSourceWorkerSovereignty } from '../../src/workers/engine/runtime/embedding-providers.ts';
import { createTierSnifferModel } from '../../src/workers/engine/runtime/judging-models.ts';
import { count, closeStores, openImmutable, pickLongItems, store, storesFor, unseenWindows } from './long-item-selection.ts';
import { storedJudgeInput, type Row } from './stored-input.ts';

export function releaseCounts(inputs: readonly ReleaseInput[], truth: readonly ReadonlySet<string>[], result: ChunkReleaseResult) {
  if (result.allowed.length !== inputs.length || truth.length !== inputs.length) throw new Error('Invalid result shape');
  let chunksAllowed = 0, chunksHeld = 0, privateChunksAllowed = 0, itemsWithPrivateWindowAnyAllowed = 0;
  inputs.forEach((input, i) => {
    const hashes = new Set(input.chunkHashes);
    const allowed = new Set(result.allowed[i]);
    if ([...allowed].some(hash => !hashes.has(hash))) throw new Error('Unknown release chunk');
    chunksAllowed += allowed.size;
    chunksHeld += hashes.size - allowed.size;
    privateChunksAllowed += [...allowed].filter(hash => truth[i]!.has(hash)).length;
    if (truth[i]!.size && allowed.size) itemsWithPrivateWindowAnyAllowed++;
  });
  if (chunksHeld !== result.withheldPassages) throw new Error('Invalid held count');
  return { chunksAllowed, chunksHeld, privateChunksAllowed, itemsWithPrivateWindowAnyAllowed, heldPassages: result.withheldPassages };
}

export function batchTimes(ms: readonly number[]) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { firstBatchMs: ms[0] ?? 0, perBatchMs: [...ms], medianMs: at(0.5), p90Ms: at(0.9), maxMs: at(1) };
}

function loopback(endpoint: string) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local judge required');
}

// Keep the production set's placement/raise/parent behavior, without startup cleanup
// changing the sampled population or deleting unrelated copied passages.
class ProofSet extends TieredStoreSet {
  override repairLowerContent() { return Promise.resolve(); }
  override sweepOrphanedChildren() { return Promise.resolve({ removed: 0, retry: 0 }); }
}

let stage = 'setup';
const OWN_ERRORS = new Set(['200 items required', 'Ambiguous tier domain', 'Configured local judge required', 'Copy boundary', 'Explicit copies required', 'Invalid held count', 'Invalid result shape', 'Judge not approved', 'Judge not ready', 'Judge unavailable', 'Local judge required', 'Sample not mounted', 'Unknown release chunk']);

export async function main(argv = process.argv.slice(2)) {
  const flag = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  const rootArg = flag('--root'), homeArg = flag('--home');
  if (!rootArg || !homeArg || !existsSync(rootArg) || !existsSync(homeArg)) throw new Error('Explicit copies required');
  const root = realpathSync(rootArg), home = realpathSync(homeArg);
  const inside = (path: string) => {
    const target = existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), path.split(sep).pop()!);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== target) throw new Error('Copy boundary');
    return path;
  };
  const env = environmentWithWorkerSetupEnv({ env: { ...process.env, HOME: home } });
  // All mutable classification state belongs to this run's root, even if setup.env names the original.
  env.OLYMPUS_CLASSIFICATION_LEDGER_PATH = inside(resolve(root, 'classification-ledger.jsonl'));
  const config = loadWorkerConfig({}, env);
  const engine = loadSourceWorkerSovereignty(config, env);
  const runtime = resolveJudgeChoiceRuntime({ engine, standaloneEngine: isStandaloneEngineProcess(env) }, readJudgeSpending(judgeSpendingPath(env)));
  const serviceEnv = tierSnifferServiceEnv(env);
  if (!serviceEnv.enabled || runtime.source !== 'configured' || runtime.lane.kind !== 'local' || !runtime.lane.profile.baseUrl) throw new Error('Configured local judge required');
  const lane = runtime.lane;
  loopback(lane.profile.baseUrl!);
  const ownerContext = () => privacyOwnerContext({ env });
  if (!isClassifierApproved((await readClassificationLedger(resolveClassificationLedgerPath(env))).entries, { lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: snifferPromptVersions(ownerContext()).approval })) throw new Error('Judge not approved');
  let calls = 0, httpCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    loopback(input instanceof Request ? input.url : String(input));
    httpCalls++;
    return originalFetch(input, { ...init, redirect: 'error' });
  }, { preconnect: originalFetch.preconnect });
  const mounted: LocalConnectorStore[] = [], ledgers: TierLedger[] = [], secretIndexes: SecretLocationsIndex[] = [];
  let service: TierSnifferService | undefined;
  // Production side-store cleanup resolves paths through process.env. Give it an
  // isolated XDG alias of THIS copy; original absolute job-ledger paths remain outside.
  const alias = mkdtempSync(resolve(tmpdir(), 'olympus-release-proof-'));
  const pathEnv = { HOME: home, XDG_DATA_HOME: alias, OPENCLAW_STATE_DIR: alias,
    OLYMPUS_STANDALONE: '0', OLYMPUS_ENGINE_HOST: '0' };
  const savedEnv = Object.fromEntries(Object.keys(pathEnv).map(key => [key, process.env[key]]));
  try {
    mkdirSync(resolve(alias, 'openclaw'));
    symlinkSync(root, resolve(alias, 'openclaw', 'olympus'));
    Object.assign(process.env, pathEnv);
    const base = createTierSnifferModel({ lane, configuredProfile: engine.config.modelProfiles[lane.profileId], olympusConfig: config, env,
      bootSecretResolver: new WorkerBootSecretResolver({ resolveSecretRefValueSync: (ref, values) => resolveSecretRefValueSync(ref, { env: values }) }) }) as SnifferModel | undefined;
    if (!base) throw new Error('Judge unavailable');
    const model: SnifferModel = { complete: request => { calls++; return base.complete(request); },
      ...(base.prepareSniffer ? { prepareSniffer: (signal?: AbortSignal) => base.prepareSniffer!(signal) } : {}) };
    stage = 'pick-items';
    const population = count(root);
    const picked = pickLongItems(population.long);
    if (picked.length !== 200) throw new Error('200 items required');
    inside(resolve(root, 'tier-sniffer-budget.json'));
    const automaticMoveContext = {
      localEmbeddingsOnly: () => (['public_safe', 'internal', 'secure_local'] as const).every(domain => {
        const profile = engine.resolveEmbeddingProfile(domain);
        return profile === undefined || profile.profile.provider === 'built-in';
      }),
      embeddingLedgerPath: inside(resolve(root, 'embedding-ledger.jsonl')),
    };
    const installed = configureInstalledTierClassification({ env, lane, automaticMoveContext, retirePublic: isPublicTierRetired(engine.config), ownerContext });
    stage = 'read-copy';
    // Read everything the proof needs through the immutable handles BEFORE any writable open:
    // TierLedger and LocalConnectorStore migrate these same files in place, and an immutable
    // handle reading a file this process has changed reports SQLITE_CORRUPT.
    const sampled = picked.map(item => ({ row: item.store.row.get(item.pk) as Row,
      parts: item.store.chunks.all(item.pk) as Array<{ bounded_text: string; content_hash: string }> }));
    const plans: Array<{ ledgerPath: string; legs: Array<{ path: string; corpusId: string; family: SourceFamily; domain: SourceTrustDomain }> }> = [];
    for (const ledgerPath of new Set(picked.map(item => item.ledgerPath))) {
      inside(tierSnifferPathForLedger(ledgerPath));
      const db = openImmutable(inside(ledgerPath));
      const sample = picked.findIndex(item => item.ledgerPath === ledgerPath);
      const fallbackFamily = sampled[sample]!.row['family'] as SourceFamily;
      const legs: (typeof plans)[number]['legs'] = [];
      try {
        for (const path of storesFor(ledgerPath)) {
          const read = store(inside(path));
          if (!read) continue;
          const corpus = read.db.query('SELECT corpus_id FROM sync_runs ORDER BY (sync_run_id = ?) DESC, started_at DESC LIMIT 1').get(TIER_SET_BINDING_RUN_ID) as { corpus_id: string } | null;
          if (!corpus) continue;
          const corpusId = corpus.corpus_id;
          const domains = db.query('SELECT DISTINCT trust_domain FROM tier_copies WHERE corpus_id = ?').all(corpusId) as Array<{ trust_domain: SourceTrustDomain }>;
          if (domains.length > 1) throw new Error('Ambiguous tier domain');
          const domain = domains.length === 1 ? domains[0]!.trust_domain : (['public_safe', 'internal', 'secure_local'] as const).find(value => corpusId.startsWith(`${value}.`));
          const row = read.db.query('SELECT family FROM items LIMIT 1').get() as { family: SourceFamily } | null;
          if (!domain) continue;
          legs.push({ path, corpusId, family: row?.family ?? fallbackFamily, domain });
        }
      } finally { db.close(); }
      plans.push({ ledgerPath, legs });
    }
    closeStores();
    stage = 'mount-stores';
    const scopes: TierVisibilityScope[] = [];
    for (const { ledgerPath, legs } of plans) {
      const ledger = new TierLedger({ dbPath: ledgerPath });
      ledgers.push(ledger);
      const stores = legs.map(leg => new LocalConnectorStore({ dbPath: leg.path, corpusId: leg.corpusId, family: leg.family, trustDomain: leg.domain }));
      mounted.push(...stores);
      const secrets = new SecretLocationsIndex({ dbPath: inside(ledgerPath.slice(0, -TIER_LEDGER_FILE_SUFFIX.length) + SECRET_LOCATIONS_FILE_SUFFIX) });
      secretIndexes.push(secrets);
      new ProofSet({ setId: ledgerPath, ledger, secretLocations: secrets, legs: stores.map(opened => ({ corpusId: opened.corpusId, trustDomain: opened.trustDomain, store: opened })) });
      scopes.push({ ledger, corpusIds: new Set(stores.map(opened => opened.corpusId)), stores: () => stores });
    }
    service = new TierSnifferService({ installed, lane, model, stores: () => mounted, ownerContext,
      classificationLedgerPath: resolveClassificationLedgerPath(env), budgetStatePath: resolve(root, 'tier-sniffer-budget.json'),
      ...(serviceEnv.maxCallsPerDay !== undefined ? { maxCallsPerDay: serviceEnv.maxCallsPerDay } : {}) });
    // No service.start(): only synchronous release questions may write this copy.
    stage = 'prepare-judge';
    await prepareSnifferModel({ model });
    if (lane.rejudgeReady === false) throw new Error('Judge not ready');
    const inputs: ReleaseInput[] = [], truth: Set<string>[] = [];
    let windows = 0, privateWindows = 0, unjudgedWindows = 0, groundFailures = 0;
    stage = 'screen';
    // Windows the deterministic screens hold are Private truth at once; the rest need a judge call.
    const judgeJobs: Array<{ item: number; material: Parameters<typeof snifferMaterialForModel>[0]; hashes: readonly string[]; flags: readonly string[] }> = [];
    const hold = (hashes: readonly string[], into: Set<string>) => { privateWindows++; for (const hash of hashes) into.add(hash); };
    for (const [index, item] of picked.entries()) {
      const opened = mounted.find(candidate => candidate.dbPath === item.storePath);
      const { row, parts } = sampled[index]!;
      if (!opened) throw new Error('Sample not mounted');
      inputs.push({ ...item.identity, corpusId: opened.corpusId, privateAtAnswer: false, chunkHashes: parts.map(part => part.content_hash) });
      const privateHashes = new Set<string>();
      truth.push(privateHashes);
      for (const window of unseenWindows(parts, Infinity)) {
        windows++;
        const input = storedJudgeInput(row, window.text, item.provider);
        if (input.secret || (input.material === undefined && input.privateWithoutJudge)) { hold(window.chunkHashes, privateHashes); continue; }
        if (input.material === undefined) continue;
        const own = snifferOwnMaterial(snifferMaterialForModel(input.material));
        if (snifferMaterialCarriesSecret(own) || snifferInjectionRule(own)) { hold(window.chunkHashes, privateHashes); continue; }
        judgeJobs.push({ item: index, material: input.material, hashes: window.chunkHashes, flags: input.flags });
      }
    }
    for (const path of [...appReleaseLogDbPaths(), ...jobLedgerPathsToVisit(ledgers.flatMap(ledger => ledger.knownJobLedgerPaths())).visit]) inside(path);
    stage = 'release-check';
    // The release check runs first, cold, so its timing is the first-question delay. Ground truth
    // then covers every item the check let ANY chunk of through, in full: a wholly held item
    // cannot leak, so the leak counts below are exact, not sampled.
    const check = createReleaseTierCheck(() => scopes, () => 'allow');
    const raw: Array<{ results: ChunkReleaseResult[]; times: number[]; callsMade: number; httpCallsMade: number }> = [];
    for (let run = 0; run < 2; run++) {
      const before = calls, beforeHttp = httpCalls, times: number[] = [], results: ChunkReleaseResult[] = [];
      for (let at = 0; at < inputs.length; at += 24) {
        const start = performance.now();
        results.push(await check.chunks!(inputs.slice(at, at + 24), { budgetMs: RELEASE_CHUNK_JUDGE_BUDGET_MS }));
        times.push(performance.now() - start);
      }
      raw.push({ results, times, callsMade: calls - before, httpCallsMade: httpCalls - beforeHttp });
      process.stderr.write(JSON.stringify({ stage, run, calls }) + '\n');
    }
    const released = new Set<number>();
    for (const { results } of raw) results.forEach((result, b) => result.allowed.forEach((hashes, i) => { if (hashes.length) released.add(b * 24 + i); }));
    stage = 'ground-truth';
    const jobs = judgeJobs.filter(job => released.has(job.item));
    const groundCalls = calls, groundHttp = httpCalls;
    // Numbers-only progress on stderr, so a slow run can be told from a stuck one.
    const progress = (done: number) => process.stderr.write(JSON.stringify({ stage, done, total: jobs.length, itemsReleased: released.size, calls }) + '\n');
    progress(0);
    let next = 0, done = 0;
    const concurrency = Math.max(1, Math.min(16, Number(process.env.RELEASE_PROOF_CONCURRENCY) || 2));
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++]!;
        const material = snifferMaterialForModel(job.material);
        // A slow or failed ground-truth call holds the window and counts as unjudged; it never ends the run.
        let reply: SnifferModelCompletion | undefined;
        for (const ms of [60_000, 180_000]) {
          try { reply = await completeSnifferQuestion(model, { pass: 'content', material, ownerContext: ownerContext(), signal: AbortSignal.timeout(ms) }) as SnifferModelCompletion; break; }
          catch { groundFailures++; }
        }
        const parsed = reply && (reply.decisionVerdict ?? parseSnifferBatchResponse(reply.text, new Set([1])).get(1));
        const verdict = parsed ? { ...parsed, failSafe: reply!.decisionVerdict?.failSafe ?? false } : undefined;
        if (!verdict || verdict.failSafe) unjudgedWindows++;
        if (!verdict || snifferVerdictTier(verdict, lane, job.flags).tier !== 'private') hold(job.hashes, truth[job.item]!);
        if (++done % 25 === 0 || done === jobs.length) progress(done);
      }
    }));
    const groundTruth = { windows, windowsNeedingJudge: judgeJobs.length, itemsReleased: released.size, windowsJudged: jobs.length,
      privateWindows, unjudgedWindows, groundFailures, callsMade: calls - groundCalls, httpCallsMade: httpCalls - groundHttp };
    const leakedItems = new Set<number>(), leakedPrivateChunks = new Set<string>();
    const runs = raw.map(({ results, times, callsMade, httpCallsMade }) => {
      const batches = results.map((result, b) => releaseCounts(inputs.slice(b * 24, b * 24 + 24), truth.slice(b * 24, b * 24 + 24), result));
      const perItem: Array<{ chunksAllowed: number; chunksHeld: number }> = [];
      results.forEach((result, b) => result.allowed.forEach((hashes, i) => {
        const at = b * 24 + i, allowed = new Set(hashes);
        perItem.push({ chunksAllowed: allowed.size, chunksHeld: new Set(inputs[at]!.chunkHashes).size - allowed.size });
        if (truth[at]!.size && allowed.size) leakedItems.add(at);
        for (const hash of allowed) if (truth[at]!.has(hash)) leakedPrivateChunks.add(JSON.stringify([at, hash]));
      }));
      const sum = (key: keyof ReturnType<typeof releaseCounts>) => batches.reduce((total, batch) => total + batch[key], 0);
      return { chunksAllowed: sum('chunksAllowed'), chunksHeld: sum('chunksHeld'), heldPassages: sum('heldPassages'),
        privateChunksAllowed: sum('privateChunksAllowed'), itemsWithPrivateWindowAnyAllowed: sum('itemsWithPrivateWindowAnyAllowed'),
        perItem, ...batchTimes(times), callsMade, httpCallsMade };
    });
    return { items: picked.length, itemsWithKnownPrivateWindows: truth.filter(hashes => hashes.size).length, groundTruth, runs,
      privateChunksAllowed: leakedPrivateChunks.size,
      itemsWithPrivateWindowAnyAllowed: leakedItems.size, callsMade: calls, httpCallsMade: httpCalls };
  } finally {
    service?.stop();
    clearInstalledTierClassification();
    for (const opened of mounted) opened.close();
    for (const index of secretIndexes) index.close();
    for (const ledger of ledgers) ledger.close();
    closeStores();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(alias, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  // Production diagnostics may include corpus labels or paths. This program emits numeric JSON only.
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) console[method] = () => {};
  try {
    const report = await main();
    process.stdout.write(JSON.stringify(report) + '\n');
    if (report.privateChunksAllowed || report.itemsWithPrivateWindowAnyAllowed || report.groundTruth.unjudgedWindows) process.exitCode = 1;
  } catch (error) {
    // Only fixed strings leave: the stage, the error class, a SQLite-style code, and messages this file wrote.
    const name = error instanceof Error ? error.name : typeof error;
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error && OWN_ERRORS.has(error.message) ? error.message : undefined;
    process.stdout.write(JSON.stringify({ errors: 1, stage, error: name,
      ...(typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { code } : {}), ...(message ? { message } : {}) }) + '\n');
    process.exitCode = 1;
  }
}
