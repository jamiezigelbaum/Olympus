import {expect, test} from 'bun:test';
import type {RawItem, SourceConnector} from '../src/core/contracts.ts';
import {LocalConnectorStore, createConnectorStoreCorpusAdapter, defineConnectorCorpus} from '../src/workers/connector-store/index.ts';
import {withKeywordExpansionDisabled} from '../src/core/source-index/keyword-context.ts';
import {withExpandedSourceIndexKeywords} from '../src/core/source-index/keyword-expansion.ts';
import {ARCTIC_EMBED_M_V1_5} from '../src/workers/source-index/built-in-embedding/manifest.ts';
import type {SourceEmbeddingProvider} from '../src/workers/source-index/embeddings.ts';

const english = 'The notary verifies the identity of both parties before the deed is signed. The final appointment takes place in the office and the original is kept there.';
const languages = [
  ['Spanish','notario','La escritura pública se firma ante el notario. Ambas partes presentan sus documentos de identidad antes de la firma y reciben una copia del documento firmado.'],
  ['Portuguese','notário','A escritura pública é assinada perante o notário. As duas partes apresentam os documentos de identificação antes da assinatura e recebem uma cópia do documento assinado.'],
  ['French','notaire',"L’acte authentique est signé devant le notaire. Les deux parties présentent leurs documents d’identité avant la signature et reçoivent une copie du document signé."],
  ['German','Notar','Die öffentliche Urkunde wird vor dem Notar unterschrieben. Beide Parteien legen vor der Unterzeichnung ihre Ausweisdokumente vor und erhalten eine Kopie der unterschriebenen Urkunde.'],
  ['Italian','notaio',"L’atto pubblico viene firmato davanti al notaio. Le due parti presentano i documenti di identità prima della firma e ricevono una copia del documento firmato."],
] as const;
const questions = ['¿Quién es el notario?', 'Quem é o notário?', 'Qui est le notaire?', 'Wer ist der Notar?', 'Chi è il notaio?'];
for (const [index, [language, word, text]] of languages.entries()) {
  test(`English keywords retrieve ${language} content and the reverse without any model`, async () => {
    for (const [query, body] of [['Who is the notary?',text],[word,english],[questions[index]!,english]]) {
      await withStore([{id:'answer',text:body!}], async store => {
        const response = await search(store,query!);
        expect({query,ids:response.hits.map(hit=>hit.sourceItem.localItemId)}).toEqual({query,ids:['answer']});
      });
    }
  });
}

test('a saturated translated lane retains a previously complete baseline hit', async () => {
  const padding = 'background information '.repeat(200);
  const items = [
    {id:'baseline',text:'notary fees deposit '+padding},
    ...Array.from({length:100},(_,i)=>({id:'partial-'+i,text:(i%2 ? 'notary ' : 'fees ')+padding})),
    ...Array.from({length:51},(_,i)=>({id:'translated-'+i,text:languages[0][2]+' Los gastos y honorarios se pagan al notario y las arras se entregan antes de la firma.'})),
  ];
  await withStore(items, async store => {
    const query = 'notary fees deposit';
    const baseline = await withKeywordExpansionDisabled(()=>search(store,query));
    expect(baseline.hits[0]?.sourceItem.localItemId).toBe('baseline');
    const provider: SourceEmbeddingProvider = {provider:'built-in',modelId:ARCTIC_EMBED_M_V1_5.modelId,dimension:2,configHash:'keyword-regression',epochId:'keyword-regression',backend:'local',async embed(inputs,options){return inputs.map(()=>options.taskType==='RETRIEVAL_QUERY' ? [0,1] : [1,0]);}};
    await store.embedChunks({provider});
    await withExpandedSourceIndexKeywords(query,()=>store.keywordLanguages(), async () => {
      // This is the bounded SQL condition that previously lost completeness.
      const rows = store.searchItemsDetailed(query,50,undefined,undefined,{prefix:false}).rows;
      expect(rows.length).toBe(50);
      expect(rows.some(row=>row.sourceItem.localItemId==='baseline')).toBe(false);
    });
    const response = await search(store,query,provider);
    expect(response.hits[0]?.sourceItem.localItemId).toBe('baseline');
  });
});

async function search(store:LocalConnectorStore,query:string,provider?:SourceEmbeddingProvider) {
  const adapter = createConnectorStoreCorpusAdapter({store,retrievalMode:provider?'hybrid':'keyword',...(provider?{embeddingProvider:provider}:{})});
  return adapter({query,maxResults:1,corpus:defineConnectorCorpus({corpusId:store.corpusId,family:'file',trustDomain:'internal'}),context:{allowedTrustDomains:['internal']}});
}
async function withStore(items:readonly {id:string;text:string}[],run:(store:LocalConnectorStore)=>Promise<void>) {
  const store = new LocalConnectorStore({dbPath:':memory:',corpusId:'internal.keyword.files',family:'file',trustDomain:'internal',tierLedger:null});
  const raws:RawItem[] = items.map(item=>({identity:{family:'file',provider:'fixture',accountScope:'fixture',providerItemId:item.id,localItemId:item.id,sourceVersion:'v1'},mimeType:'text/plain',content:{kind:'text',text:item.text},metadata:{name:'record'},fetchedAt:'2026-10-11T00:00:00Z'}));
  const connector:SourceConnector = {id:'fixture',family:'file',async authenticate(){},async *listItems(){yield {items:raws,done:true};},async fetchItem(id){return raws.find(row=>row.identity.localItemId===id)!;},classificationSignals(){return {};}};
  try {await store.syncFromConnector(connector,{fetchContent:true});await run(store);} finally {store.close();}
}
