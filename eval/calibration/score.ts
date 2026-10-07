// Calibration score (design docs/design/categorization-precision.md, step 1).
//
// Runs Olympus's production classifier over the owner-labeled sample, exactly
// as a landing would: the shared tier classifier with the cache-backed
// sniffer, an in-memory tier ledger, and the sniffer's background pass
// answered by the built-in private model in its own loopback llama-server.
// Everything is in memory or in the calibration directory: no Olympus store,
// ledger or engine is opened, and the running engine is not touched. The
// owner's privacy words and folder rules are read (never written) so the
// classifier sees what the live one sees.
//
//   bun eval/calibration/score.ts [--dir DIR] [--split dev|test] [--model MODEL_ID] [--owner-words FILE] [--gguf PATH --server PATH] [--no-gpu] [--limit N]
//
// --model picks another manifest model (e.g. the 9B). Its file is read where
// Olympus installed it, or from <calibration dir>/models/<model id>/ for a
// model downloaded only to calibrate.
//
// --split scores one fixed half of the labels (by a hash of each item's id):
// tune on `dev`, judge the result on `test`, so a change is not fitted to the
// very answers it is scored on.
//
// Reports Private precision (of what Olympus made Private, the share the owner
// says is private), Private recall, how many items were still held when the
// model was done, and every miss by file name (names only, never text). Held
// items count as Private, because that is what the owner experiences.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBuiltInAnalystModel } from '../../src/core/analyst-built-in.ts';
import { BUILT_IN_SNIFFER_LANE } from '../../src/workers/classification/built-in-sniffer.ts';
import { privacyOwnerContext, privacyRuleToTierRule, readPrivacyProfile } from '../../src/workers/classification/privacy-profile.ts';
import { CachedTierSniffer, snifferPromptVersions } from '../../src/workers/classification/sniffer.ts';
import { runSnifferPass } from '../../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers, tierRank } from '../../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { loadOwnerTierRules } from '../../src/workers/classification/tier-rules.ts';
import { BUILT_IN_REASONING_MODELS } from '../../src/workers/source-index/built-in-reasoning/manifest.ts';
import { createLlamaServerHandle, type LlamaServerHandle } from '../../src/workers/source-index/built-in-reasoning/server.ts';
import { CALIBRATION_DIR_DEFAULT, readLabels, readSample } from './files.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const dir = flag('--dir') ?? CALIBRATION_DIR_DEFAULT;

/** The manifest model whose files Olympus installed here (the first manifest entry when none is). */
function installedSpec(base: string) {
  const wanted = flag('--model');
  if (wanted) {
    const spec = BUILT_IN_REASONING_MODELS.find((model) => model.modelId === wanted);
    if (!spec) throw new Error(`--model must be one of: ${BUILT_IN_REASONING_MODELS.map((model) => model.modelId).join(', ')}`);
    return spec;
  }
  return BUILT_IN_REASONING_MODELS.find((model) => existsSync(join(base, model.modelId, model.file.name)))
    ?? BUILT_IN_REASONING_MODELS[0]!;
}

/** Where a model Olympus never installed is kept for calibration only: inside the calibration directory. */
function calibrationModelPath(spec: ReturnType<typeof installedSpec>): string {
  return join(dir, 'models', spec.modelId, spec.file.name);
}

/** The built-in model Olympus installed on this Mac, read in place. */
function installedModel(): { gguf: string; server: string } {
  const base = join(homedir(), '.local', 'share', 'openclaw', 'olympus', 'models', 'built-in-reasoning');
  const spec = installedSpec(base);
  const installed = join(base, spec.modelId, spec.file.name);
  const gguf = flag('--gguf') ?? (existsSync(installed) ? installed : calibrationModelPath(spec));
  const runtime = existsSync(base) ? readdirSync(base).find((name) => name.startsWith('llama.cpp-')) : undefined;
  const server = flag('--server') ?? (runtime
    ? join(base, runtime, readdirSync(join(base, runtime)).find((name) => name.startsWith('llama-')) ?? '', 'llama-server')
    : '');
  if (!existsSync(gguf) || !existsSync(server)) {
    throw new Error('The built-in model is not installed where Olympus keeps it; pass --gguf and --server.');
  }
  return { gguf, server };
}

async function main(): Promise<void> {
  const sample = readSample(dir);
  const labels = readLabels(dir).labels;
  const split = flag('--split');
  if (split !== undefined && split !== 'dev' && split !== 'test') throw new Error('--split is dev or test.');
  const inSplit = (id: string) => split === undefined
    || ((createHash('sha256').update(id).digest()[0]! % 2 === 0) === (split === 'dev'));
  const labeled = sample.items
    .filter((item) => inSplit(item.id))
    .filter((item) => labels[item.id]?.label === 'personal' || labels[item.id]?.label === 'private')
    .slice(0, Number(flag('--limit') ?? Number.MAX_SAFE_INTEGER));
  const unsure = sample.items.filter((item) => labels[item.id]?.label === 'unsure').length;
  if (labeled.length === 0) throw new Error('No Personal or Private labels yet. Run: bun eval/calibration/label.ts');

  // --owner-words FILE tries other privacy words without touching the owner's
  // saved profile; by default the saved words are read as the live engine reads them.
  const wordsFile = flag('--owner-words');
  const ownerContext = wordsFile ? readFileSync(wordsFile, 'utf8').trim() || undefined : privacyOwnerContext();
  const profile = readPrivacyProfile();
  const rules = [...loadOwnerTierRules({ allowMissing: true }), ...(profile?.rules ?? []).map(privacyRuleToTierRule)];
  const spec = installedSpec(join(homedir(), '.local', 'share', 'openclaw', 'olympus', 'models', 'built-in-reasoning'));
  const paths = installedModel();
  let server: LlamaServerHandle | undefined;
  const model = createBuiltInAnalystModel({
    model: spec,
    install: async () => ({ modelPath: paths.gguf, serverPath: paths.server, gpu: !argv.includes('--no-gpu') }),
    createServer: (launch) => {
      server = createLlamaServerHandle({ ...launch, idleShutdownSeconds: 0 });
      return server;
    },
    waitForInstall: true,
  });

  // What the model said, per call: matched to items by name for the misses list.
  const exchanges: Array<{ prompt: string; text: string }> = [];
  const recordingModel: typeof model = {
    ...model,
    async complete(request) {
      const result = await model.complete(request);
      exchanges.push({ prompt: request.prompt, text: result.text });
      return result;
    },
  };
  const said = (name: string): string => exchanges
    .filter((exchange) => exchange.prompt.includes(name))
    .map((exchange) => (/"tier"\s*:\s*"(\w+)"[^}]*"category"\s*:\s*"(\w+)"/.exec(exchange.text) ?? []).slice(1).join('/'))
    .filter(Boolean)
    .join(', ') || 'not asked';

  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const startedAt = Date.now();
  try {
    const lane = BUILT_IN_SNIFFER_LANE;
    const sniffer = new CachedTierSniffer(store, lane, snifferPromptVersions(ownerContext).cache);
    const subjectOf = (id: string) => ({ provider: 'dropbox', accountScope: 'calibration', providerItemId: id });
    for (const item of labeled) {
      const decision = classifyItemTiers(
        { signals: { title: item.name, path: `/${item.rel}` }, provider: 'dropbox', text: item.text, subject: subjectOf(item.id) },
        { sniffer, rules, retirePublic: true },
      );
      ledger.recordDecision(subjectOf(item.id), decision);
    }
    const asked = store.counts().questions;
    process.stdout.write(`Classified ${labeled.length} labeled files; ${asked} question(s) for the private model.\n`);
    let calls = 0;
    for (let pass = 0; pass < 6; pass += 1) {
      const report = await runSnifferPass({
        targets: [{ ledger, sniffer: store }],
        lane,
        model: recordingModel,
        maxCallsPerPass: 10_000,
        pendingPageSize: 5_000,
        ...(ownerContext ? { ownerContext } : {}),
      });
      calls += report.calls;
      process.stdout.write(`  model pass ${pass + 1}: ${report.calls} call(s), ${report.verdictsApplied} verdict(s)\n`);
      if (report.calls === 0 && report.verdictsApplied === 0) break;
    }

    const rows = labeled.map((item) => {
      const record = ledger.getCurrent(subjectOf(item.id))!;
      const held = record.metadataPending || (record.contentPending && record.contentRead);
      const madePrivate = held || tierRank(record.contentTier) >= tierRank('secure');
      return {
        id: item.id,
        file: item.rel,
        owner: labels[item.id]!.label as 'personal' | 'private',
        olympus: held ? 'held' : madePrivate ? 'private' : 'personal',
        madePrivate,
        why: record.reasons.filter((reason) => reason !== 'metadata:default:personal'),
        modelSaid: said(item.name),
      };
    });
    const tp = rows.filter((row) => row.madePrivate && row.owner === 'private').length;
    const fp = rows.filter((row) => row.madePrivate && row.owner === 'personal');
    const fn = rows.filter((row) => !row.madePrivate && row.owner === 'private');
    const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    const precision = ratio(tp, tp + fp.length);
    const recall = ratio(tp, tp + fn.length);
    const held = rows.filter((row) => row.olympus === 'held').length;

    const summary = [
      `${split ? `Split: ${split}. ` : ''}Labeled: ${labeled.length} (${rows.filter((row) => row.owner === 'private').length} Private, ${rows.filter((row) => row.owner === 'personal').length} Personal; ${unsure} not sure, left out).`,
      `Private precision: ${pct(precision)} (target 95%) — ${fp.length} Personal file(s) made Private.`,
      `Private recall:    ${pct(recall)} (target 99%) — ${fn.length} Private file(s) left Personal.`,
      `Model: ${spec.modelId}. Still held when the model was done: ${held}. Model calls: ${calls}. Time: ${Math.round((Date.now() - startedAt) / 1000)} s.`,
    ];
    const misses = [
      ...fp.map((row) => `  made Private, owner says Personal: ${row.file}  [${row.olympus}; model: ${row.modelSaid}; ${row.why.join(' ')}]`),
      ...fn.map((row) => `  left Personal, owner says Private: ${row.file}  [model: ${row.modelSaid}; ${row.why.join(' ')}]`),
    ];
    process.stdout.write(`\n${summary.join('\n')}\n${misses.length ? `\nMisses:\n${misses.join('\n')}\n` : '\nNo misses.\n'}`);
    const resultPath = join(dir, `score-${split ?? 'all'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(resultPath, JSON.stringify({ at: new Date().toISOString(), split: split ?? 'all', model: spec.modelId, ownerWords: wordsFile ? 'trial' : 'saved', precision, recall, held, calls, rows }, null, 1), { mode: 0o600 });
    process.stdout.write(`\nFull result: ${resultPath}\n`);
  } finally {
    store.close();
    ledger.close();
    await model.stop?.();
    server?.stop?.();
  }
}

await main();
