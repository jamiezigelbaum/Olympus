// Who should translate a question's search words? The frozen cross-language
// blind cases (fictional, no user content), three arms, one per run:
//   bun eval/cross-language-arms.ts --arm static     no model: the static word list only
//   bun eval/cross-language-arms.ts --arm built-in   the built-in model
//   bun eval/cross-language-arms.ts --arm owner      the local Analyst profile (the owner's model)
// Each answerable case is searched twice: a first ask, which starts on the
// static list after the product's wait (4 s) as it does on the owner's
// computer, and the same ask again once the translation has landed. Prints
// counts and times only.
import { LocalConnectorStore, createConnectorStoreCorpusAdapter, createConnectorStoreContentProvider, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { registerBuiltInPrivateModel } from '../src/workers/classification/built-in-sniffer.ts';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { createDelphiAnalystModel } from '../src/core/analyst-delphi.ts';
import { DelphiClient } from '../src/core/delphi.ts';
import { loadConfig, parseLane, parseModelProfile } from '../src/core/config.ts';
import type { AnalystModel } from '../src/core/analyst.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { expandSourceIndexKeywords, registerOwnerKeywordModel } from '../src/core/source-index/keyword-expansion.ts';
import { routeSourceIndexSearch } from '../src/core/source-index/router.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import cases from './fixtures/cross-language-blind.json';

const arm = process.argv[process.argv.indexOf('--arm') + 1];
if (!['static', 'built-in', 'owner'].includes(arm ?? '')) { console.error(JSON.stringify({ errors: 1, reason: '--arm takes static, built-in or owner.' })); process.exit(1); }

const calls = { calls: 0, failed: 0, wallMs: 0 };
const timed = (model: AnalystModel): AnalystModel => ({ complete: async request => {
  const started = performance.now(); calls.calls++;
  try { return await model.complete(request); }
  catch (error) { calls.failed++; throw error; }
  finally { calls.wallMs += Math.round(performance.now() - started); }
} });

const builtIn = arm === 'built-in' ? createBuiltInAnalystModel({ env: { ...process.env, OLYMPUS_BUILT_IN_ANALYST: 'on' }, waitForInstall: true }) : undefined;
let translator: AnalystModel | undefined;
if (builtIn) { await builtIn.prepare(); translator = timed(builtIn); }
if (arm === 'owner') {
  const lane = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE?.trim() ? parseLane(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE) : undefined;
  const profile = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE?.trim() ? parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE) : 'source_answer';
  translator = timed(createDelphiAnalystModel(new DelphiClient(loadConfig()), lane ? { lane } : { profile }));
  process.env.OLYMPUS_KEYWORD_EXPANSION_MODEL = 'owner';
}

const totals = { answerable: 0, firstAskDocument: 0, firstAskParagraph: 0, landedDocument: 0, landedParagraph: 0, firstAskMs: 0, landedWaitMs: 0 };
try {
  for (const item of cases.filter(item => item.expectedIds.length)) {
    const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'secure_local.blind.files', family: 'file', trustDomain: 'secure_local', tierLedger: null });
    try {
      const raws: RawItem[] = item.documents.map(doc => ({
        identity: { family: 'file', provider: 'fixture', accountScope: 'blind', providerItemId: doc.id, localItemId: doc.id, sourceVersion: 'v1' },
        mimeType: 'text/plain', content: { kind: 'text', text: doc.text }, metadata: { name: doc.title }, fetchedAt: '2026-10-10T00:00:00Z',
      }));
      const connector: SourceConnector = { id: 'blind', family: 'file', async authenticate() {}, async *listItems() { yield { items: raws, done: true }; }, async fetchItem(id) { return raws.find(row => row.identity.localItemId === id)!; }, classificationSignals() { return {}; } };
      await store.syncFromConnector(connector, { fetchContent: true });
      const corpus = defineConnectorCorpus({ corpusId: store.corpusId, family: 'file', trustDomain: 'secure_local' });
      const adapter = createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' });
      const provider = createConnectorStoreContentProvider({ store });
      // Each case is its own install: a fresh handle, so one case's languages are not asked for in the next.
      const handle: AnalystModel | undefined = translator ? { complete: request => translator!.complete(request) } : undefined;
      registerBuiltInPrivateModel(arm === 'built-in' && handle ? { model: handle, available: () => true } : undefined);
      registerOwnerKeywordModel(arm === 'owner' && handle ? async () => handle : undefined);
      const search = async () => {
        const result = await routeSourceIndexSearch({ request: { query: item.query, maxResults: 4, context: { allowedTrustDomains: ['secure_local'] as const } }, registry: buildSourceIndexCorpusRegistry([corpus]), adapters: { [store.corpusId]: adapter } });
        const hits = result.hits.filter(hit => item.expectedIds.includes(hit.sourceItem.localItemId));
        let paragraph = false;
        for (const hit of hits) {
          const content = await provider.fetchLocalContent({ provenance: hit.provenance!, trustDomain: 'secure_local', query: item.query, maxChars: 400, maxPassages: 2 });
          const text = content?.chunks.join(' ') ?? '';
          if (item.expectedPassageContains.every(expected => text.includes(expected))) paragraph = true;
        }
        return { document: hits.length > 0, paragraph };
      };
      totals.answerable++;
      let started = performance.now();
      const first = await search();
      totals.firstAskMs += Math.round(performance.now() - started);
      // The translation keeps running after the search started without it: wait for it, then ask again.
      started = performance.now();
      if (handle) await expandSourceIndexKeywords(item.query, () => store.keywordLanguages(), {});
      totals.landedWaitMs += Math.round(performance.now() - started);
      const landed = await search();
      totals.firstAskDocument += Number(first.document); totals.firstAskParagraph += Number(first.paragraph);
      totals.landedDocument += Number(landed.document); totals.landedParagraph += Number(landed.paragraph);
      console.log(JSON.stringify({ case: totals.answerable, firstAsk: first, landed }));
    } finally { store.close(); }
  }
  console.log(JSON.stringify({ arm, ...totals, translation: calls }));
} finally { registerBuiltInPrivateModel(undefined); registerOwnerKeywordModel(undefined); await builtIn?.stop(); }
