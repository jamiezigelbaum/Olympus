import { expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { openTierFixture, tempDir, fixtureConnector, FIXTURE_PLACEMENT, CORPORA, PROVIDER, ACCOUNT, identityOf } from './helpers/tier-fixtures.ts';
import { createFileExtractionRuntime } from '../src/workers/email-source/file-extraction-runtime.ts';
import { runTierSet } from '../src/workers/classification/tier-cli.ts';
import { tieredExtractionView } from '../src/workers/connector-store/tiered-extraction.ts';

// The production runtime and tier command, not a fake tier reader: a hidden
// copy can retain S4 while the owner has already ruled its content Secrets.
for (const change of ['personal', 'owner secrets', 'ledger secrets', 'unreadable ledger'] as const) {
  test(`live tier decision during OCR: ${change}`, async () => {
    const tmp = tempDir('extraction-live-tier-');
    const fx = openTierFixture(tmp.dir, { embed: false });
    const previous = process.env.OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH;
    const jobsDbPath = join(tmp.dir, 'jobs.sqlite');
    process.env.OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH = jobsDbPath;
    let runtime: ReturnType<typeof createFileExtractionRuntime> = undefined;
    let failedRead: ReturnType<typeof spyOn> | undefined;
    try {
      const spec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' };
      await fx.set.sync(fixtureConnector(() => [spec]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const view = tieredExtractionView(fx.set, { home: 'secure_local' });
      const lane = { corpusId: CORPORA.secure_local, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files' };
      const ref = { ...lane, providerItemId: 'garden', localItemId: 'personal:garden', sourceVersion: 'v1', mimeType: 'image/png', name: spec.name };
      let calls = 0;
      runtime = createFileExtractionRuntime({
        enabled: true, connectorStores: [fx.stores.secure_local!],
        corpora: [{ corpusId: lane.corpusId, provider: PROVIDER, scopes: [lane.approvedScopeKey], maxTrustTierForRemote: 'S4' }],
        tierSets: new Map([[lane.corpusId, fx.set]]), jobsDbPath,
        scopeGuard: { assertAuthorized() {}, allowsRef: ({ reader, ref }) => reader.itemMatchesSearchFilters(ref.localItemId, ref.accountScope, undefined) },
        sourceFactories: new Map([[PROVIDER, () => ({ id: 'fixture', corpusId: lane.corpusId, provider: PROVIDER,
          listCandidates: async () => ({ candidates: [], done: true }),
          fetch: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
        })]]),
        extractors: { remote: {
          localReader: { extract: async () => {
            if (change === 'owner secrets') runTierSet(['garden', 'secrets'], { storePaths: [fx.paths.internal, fx.paths.secure_local] });
            if (change === 'ledger secrets') fx.ledger.flipToSecrets(identityOf('garden'), { expectedGeneration: fx.ledger.getCurrent(identityOf('garden'))!.generation });
            if (change === 'unreadable ledger') failedRead = spyOn(fx.ledger, 'getOverride').mockImplementation(() => { throw new Error('ledger unavailable'); });
            return { status: 'metadata_only' };
          } },
          client: { describe: async () => { calls++; return { text: 'ordinary garden image' }; } },
        } },
      });
      expect(runtime).toBeDefined();
      const id = runtime!.jobs.enqueue({ refs: [ref], extractorKind: 'venice_e2ee_document', extractorVersion: 'venice-v1', policyDecision: 'index_allowed' }).jobRefs[0]!.jobId;
      await runtime!.runner.run(lane);
      failedRead?.mockRestore();
      expect(calls).toBe(change === 'personal' ? 1 : 0);
      if (change === 'owner secrets' || change === 'ledger secrets') {
        expect(fx.ledger.itemIsSecret(identityOf('garden'))).toBe(true);
        expect(view.itemTrustTier(ref.localItemId)).toBe('S5');
        expect(runtime!.jobs.get(id)?.status).toBe('blocked_policy');
      }
      if (change === 'unreadable ledger') expect(runtime!.jobs.get(id)?.status).toBe('failed_retryable');
    } finally {
      failedRead?.mockRestore();
      runtime?.close(); fx.close(); tmp.cleanup();
      if (previous === undefined) delete process.env.OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH;
      else process.env.OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH = previous;
    }
  });
}

// A Secrets ruling that commits between the reader's own reads still counts:
// any `secrets` value it sees is S5, never a fall back to the stored tier.
for (const read of ['override', 'decision'] as const) {
  test(`a Secrets ${read} seen after the Secrets check reads as S5`, async () => {
    const tmp = tempDir('extraction-live-tier-race-');
    const fx = openTierFixture(tmp.dir, { embed: false });
    const spies: ReturnType<typeof spyOn>[] = [];
    try {
      const spec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' };
      await fx.set.sync(fixtureConnector(() => [spec]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      const view = tieredExtractionView(fx.set, { home: 'secure_local' });
      expect(['S3', 'S4'].includes(view.itemTrustTier('personal:garden') ?? '')).toBe(true);
      spies.push(spyOn(fx.ledger, 'itemIsSecret').mockImplementation(() => false));
      if (read === 'override') {
        spies.push(spyOn(fx.ledger, 'getOverride').mockImplementation((() => ({ kind: 'tier', tier: 'secrets' })) as never));
      } else {
        const current = fx.ledger.getCurrent(identityOf('garden'))!;
        spies.push(spyOn(fx.ledger, 'getCurrent').mockImplementation((() => ({ ...current, contentTier: 'secrets' })) as never));
      }
      expect(view.itemTrustTier('personal:garden')).toBe('S5');
    } finally {
      for (const spy of spies) spy.mockRestore();
      fx.close(); tmp.cleanup();
    }
  });
}
