import { createBuiltInAnalystModel } from '../../src/core/analyst-built-in.ts';
import { BUILT_IN_SNIFFER_LANE } from '../../src/workers/classification/built-in-sniffer.ts';
import { CachedTierSniffer, snifferCacheModelId, snifferPromptVersions } from '../../src/workers/classification/sniffer.ts';
import { runSnifferPass } from '../../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../../src/workers/classification/sniffer-store.ts';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';
import { classifyItemTiers } from '../../src/workers/classification/tier-classifier.ts';
import { QWEN35_4B, type BuiltInReasoningModelSpec } from '../../src/workers/source-index/built-in-reasoning/manifest.ts';

/** Same production dispatch and cache path in the request thread and a real Worker. */
export async function runBuiltInUnionFixture(options: {
  endpoint: string; dir: string; spec?: BuiltInReasoningModelSpec; timeoutMs?: number;
}) {
  const spec = options.spec ?? QWEN35_4B;
  const lane = { ...BUILT_IN_SNIFFER_LANE, cacheModelId: `${spec.modelId}:${spec.revision}:${spec.file.sha256}` };
  const model = createBuiltInAnalystModel({ model: spec,
    env: { OLYMPUS_BUILT_IN_REASONING_DIR: options.dir },
    requestTimeoutMs: options.timeoutMs ?? 1_000,
    install: async () => ({ modelPath: '/fixture.gguf', serverPath: '/fixture-server', gpu: false }),
    createServer: () => ({ ensureRunning: async () => ({ baseUrl: options.endpoint, token: 'fixture-token' }),
      touch() {}, async stop() {}, pid: 123 }),
  });
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const subject = { provider: 'fixture', accountScope: 'synthetic', providerItemId: 'one' };
  const sniffer = new CachedTierSniffer(store, lane);
  const material = 'Bring apples and sandwiches to the picnic.';
  const request = { pass: 'content' as const, subject, material, flags: [], mapRevision: 'none' };
  try {
    await model.prepare();
    const decision = classifyItemTiers({ signals: {}, text: material });
    ledger.recordDecision(subject, { ...decision, metadataTier: 'private', metadataFlagged: false, state: 'pending', contentTier: 'private', contentPending: true, metadataPending: false });
    sniffer.judge(request);
    const question = store.listQuestions()[0]!;
    const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane, model, maxCallsPerPass: 1 });
    const row = ledger.getCurrent(subject);
    const cached = store.getVerdict({ materialHash: question.materialHash, modelId: snifferCacheModelId(lane),
      promptVersion: snifferPromptVersions().cache, mapRevision: 'none' });
    return { report, row, cached, reread: sniffer.judge(request) };
  } finally { store.close(); ledger.close(); await model.stop(); }
}
