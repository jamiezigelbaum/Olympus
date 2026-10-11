// Frozen, independently authored fictional blind cases. No real user content.
// --record uses the actual built-in model; --replay validates stored completions
// through the same production parsing, FTS, counting and content-provider paths.
import { readFileSync, writeFileSync } from 'node:fs';
import { LocalConnectorStore, createConnectorStoreCorpusAdapter, createConnectorStoreContentProvider, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { registerBuiltInPrivateModel } from '../src/workers/classification/built-in-sniffer.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import { createBuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { createAnalyst, type AnalystModel, type AnalystModelRequest } from '../src/core/analyst.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import cases from './fixtures/cross-language-blind.json';
import { withKeywordExpansionDisabled } from '../src/core/source-index/keyword-context.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { routeSourceIndexSearch } from '../src/core/source-index/router.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';

type Recording = Record<string, {text: string; modelId: string}>;
const recordingPath = process.env.OLYMPUS_KEYWORD_RECORDING ?? 'eval/fixtures/cross-language-completions.json';
const recording: Recording = process.argv.includes('--replay') ? JSON.parse(readFileSync(recordingPath, 'utf8')) : {};
let missingCompletions = 0;
const real = process.argv.includes('--record') ? createBuiltInAnalystModel({ env: {...process.env, OLYMPUS_BUILT_IN_ANALYST:'on', OLYMPUS_BUILT_IN_ANALYST_MODEL:'small'}, waitForInstall: true, ...(process.env.OLYMPUS_KEYWORD_MODEL === 'standard' ? {model: QWEN35_4B} : {}) }) : undefined;
const model: AnalystModel = { async complete(request: AnalystModelRequest) {
  // Record by the exact bounded request, never by expectations or evidence.
  const key = JSON.stringify([request.system,request.prompt,request.responseSchema]);
  if (real) { const reply = await real.complete(request); recording[key] = reply; return reply; }
  const reply = recording[key];
  if (!reply) { missingCompletions++; throw new Error('Missing blind completion'); }
  return reply;
}};
let baseline = 0, expanded = 0, baselineNegativeReads = 0, expandedNegativeReads = 0, passages = 0;
const gapResponses: {ordinal:number;answer:string;unanswered:readonly string[];citations:number}[] = [];
const results: {ordinal: number; before: boolean; after: boolean; passage: boolean; beforeReads: number; afterReads: number}[] = [];
try {
  if (real) {
    await real.prepare();
    await real.complete({system:'Return only JSON.',prompt:'Return {"ready":true}',localOnly:true,maxOutputChars:40,signal:AbortSignal.timeout(120_000)});
  }
  for (const [ordinal, item] of cases.entries()) {
    const store = new LocalConnectorStore({dbPath:':memory:', corpusId:'secure_local.blind.files', family:'file', trustDomain:'secure_local', tierLedger:null});
    try {
      const raws: RawItem[] = item.documents.map(doc => ({
        identity: {family:'file',provider:'fixture',accountScope:'blind',providerItemId:doc.id,localItemId:doc.id,sourceVersion:'v1'},
        mimeType:'text/plain',content:{kind:'text',text:doc.text},metadata:{name:doc.title},fetchedAt:'2026-10-10T00:00:00Z',
      }));
      const connector: SourceConnector = {id:'blind', family:'file', async authenticate(){}, async *listItems(){yield {items:raws,done:true};}, async fetchItem(id){return raws.find(row=>row.identity.localItemId===id)!;}, classificationSignals(){return {};}};
      await store.syncFromConnector(connector, {fetchContent:true});
      const corpus = defineConnectorCorpus({corpusId:store.corpusId,family:'file',trustDomain:'secure_local'});
      const adapter = createConnectorStoreCorpusAdapter({store,retrievalMode:'keyword'});
      const request = {query:item.query,maxResults:4,context:{allowedTrustDomains:['secure_local'] as const}};
      const search = () => routeSourceIndexSearch({request,registry:buildSourceIndexCorpusRegistry([corpus]),adapters:{[store.corpusId]:adapter}});
      registerBuiltInPrivateModel(undefined);
      const before = await withKeywordExpansionDisabled(search);
      registerBuiltInPrivateModel({model,available:()=>true});
      const after = await search();
      const isFound = (hits: typeof after.hits) => hits.some(hit=>item.expectedIds.includes(hit.sourceItem.localItemId));
      const foundBefore = isFound(before.hits), foundAfter = isFound(after.hits);
      let passage = false;
      const provider = createConnectorStoreContentProvider({store});
      for (const hit of after.hits.filter(hit=>item.expectedIds.includes(hit.sourceItem.localItemId))) {
        const content = await provider.fetchLocalContent({provenance:hit.provenance!,trustDomain:'secure_local',query:item.query,maxChars:400,maxPassages:2});
        const text = content?.chunks.join(' ') ?? '';
        if (item.expectedPassageContains.every(expected=>text.includes(expected))) passage = true;
      }
      if (item.expectedIds.length) { baseline+=Number(foundBefore); expanded+=Number(foundAfter); passages+=Number(passage); }
      else {
        baselineNegativeReads+=before.hits.length; expandedNegativeReads+=after.hits.length;
        const detail = await buildEvidencePackDetailed({question:item.query,registry:buildSourceIndexCorpusRegistry([corpus]),adapters:{[store.corpusId]:adapter},contentProviders:{[store.corpusId]:provider},searchContext:{allowedTrustDomains:['secure_local'],allowCloudQueries:false},maxResults:4,maxCharsPerCandidate:400});
        const answer = await createAnalyst(model).analyze(detail.pack,{localOnly:true,maxAnswerChars:600});
        gapResponses.push({ordinal,answer:answer.answer,unanswered:answer.unanswered,citations:answer.citations.length});
      }
      results.push({ordinal, before:foundBefore,after:foundAfter,passage,beforeReads:before.hits.length,afterReads:after.hits.length});
      console.log(JSON.stringify({ordinal, before:foundBefore, after:foundAfter, passage}));
    } finally { store.close(); }
  }
  const gapHonest = gapResponses.filter(row => row.unanswered.length > 0 || (row.citations > 0 && /\b(?:does not|not mention|not specify)\b|^no[, .]/i.test(row.answer))).length;
  const report = {missingCompletions,gapHonest,gapResponses,answerable:cases.filter(item=>item.expectedIds.length).length,gapCases:cases.filter(item=>!item.expectedIds.length).length,baseline,expanded,passages,baselineGapReads:baselineNegativeReads,expandedGapReads:expandedNegativeReads,results};
  console.log(JSON.stringify(report));
  if (real) writeFileSync(recordingPath, JSON.stringify(recording,null,2)+'\n');
  if (process.env.OLYMPUS_KEYWORD_REPORT) writeFileSync(process.env.OLYMPUS_KEYWORD_REPORT, JSON.stringify(report,null,2)+'\n');
  if (!process.argv.includes('--measure') && (missingCompletions > 0 || gapHonest !== gapResponses.length || expanded <= baseline || results.some(row=>row.before&&!row.after))) process.exitCode=1;
} finally {registerBuiltInPrivateModel(undefined); await real?.stop();}
