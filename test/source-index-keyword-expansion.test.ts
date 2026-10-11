import { afterEach, expect, test } from 'bun:test';
import { sourceIndexFtsQuery, sourceIndexFtsTermGroups } from '../src/core/source-index/fts.ts';
import { sourceIndexChunkQueryTerms } from '../src/core/source-index/chunk-selection.ts';
import { withKeywordAlternatives, withKeywordRequestScope } from '../src/core/source-index/keyword-context.ts';
import { expandSourceIndexKeywords, parseKeywordExpansion, withExpandedSourceIndexKeywords } from '../src/core/source-index/keyword-expansion.ts';
import { registerBuiltInPrivateModel } from '../src/workers/classification/built-in-sniffer.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { Database } from 'bun:sqlite';
import { storeKeywordLanguages } from '../src/core/source-index/keyword-languages.ts';

afterEach(() => registerBuiltInPrivateModel(undefined));

const reply = (alternatives: string[]) => JSON.stringify({spa: {'0': alternatives}});

test('translations preserve the concept count and are shared by passage selection', () => {
  const query = 'Letter of Intent notary';
  const base = sourceIndexFtsTermGroups(query);
  withKeywordAlternatives(query, new Map([['notary', ['notario', 'notaría', 'escritura pública']]]), () => {
    const groups = sourceIndexFtsTermGroups(query);
    expect(groups.length).toBe(base.length);
    expect(groups.at(-1)).toEqual(['notary', 'notario', 'notaría', 'escritura pública']);
    expect(sourceIndexChunkQueryTerms(query).at(-1)).toEqual(groups.at(-1));
    expect(sourceIndexFtsQuery(query)).toContain('"escritura pública"');
    expect(sourceIndexFtsQuery(query)).toContain('"loi" OR');
    expect(sourceIndexFtsTermGroups('other question')).toEqual([['other'], ['question']]);
  });
  expect(sourceIndexFtsTermGroups(query)).toEqual(base);
});

test('untrusted output is bounded, phrase-safe and cannot create source concepts', () => {
  expect(parseKeywordExpansion('not JSON', ['notary'], ['spa']).size).toBe(0);
  const parsed = parseKeywordExpansion(JSON.stringify({
    spa: {invented:['gastos'], notary: ['notario', 'OR *', 'a b c d', '"injection"', ...Array.from({length:10},(_,i)=>'palabra'+String.fromCharCode(97+i))]},
    fra: {notary:['foreign']},
  }), ['notary'], ['spa']);
  expect(parsed.has('invented')).toBe(false);
  expect(parsed.get('notary')?.length).toBeLessThanOrEqual(8);
  expect(parsed.get('notary')).not.toContain('foreign');
  expect(parsed.get('notary')).not.toContain('duplicate');
  expect(parsed.get('notary')).not.toContain('OR *');
});

test('one local-only question call is memoized and carries no evidence text', async () => {
  const requests: AnalystModelRequest[] = [];
  registerBuiltInPrivateModel({available: () => true, model: {async complete(request) {
    requests.push(request); return {text: reply(['notario']), modelId: 'fixture'};
  }}});
  const results = await Promise.all([expandSourceIndexKeywords('asteroid', ['spa']), expandSourceIndexKeywords('asteroid', ['spa'])]);
  expect(results[0]).toBe(results[1]);
  expect(requests.length).toBe(1);
  expect(requests[0]?.localOnly).toBe(true);
  expect(JSON.parse(requests[0]!.prompt)).toEqual({context:'asteroid',concepts:[{id:'0',term:'asteroid'}],languages:['spa'],languageNames:{spa:'Spanish'}});
  await expandSourceIndexKeywords('asteroid', ['por']);
  expect(requests.length).toBe(2);
});

test('absent, unavailable and failing built-in model leave the original search intact', async () => {
  expect((await expandSourceIndexKeywords('asteroid', ['spa'])).size).toBe(0);
  let calls = 0;
  const model = {async complete() { calls++; throw new Error('offline'); }};
  registerBuiltInPrivateModel({available: () => false, model});
  await expandSourceIndexKeywords('asteroid', ['spa']);
  expect(calls).toBe(0);
  registerBuiltInPrivateModel({available: () => true, model});
  const result = await withExpandedSourceIndexKeywords('asteroid', ['spa'], () => sourceIndexFtsTermGroups('asteroid'));
  expect(result).toEqual([['asteroid']]);
  expect(calls).toBe(1);
});

test("concurrent questions cannot read one another's translations", async () => {
  registerBuiltInPrivateModel({available: () => true, model: {async complete(request) {
    const {concepts} = JSON.parse(request.prompt);
    const source=concepts[0].term;
    return {text: JSON.stringify({spa: {'0': [source === 'asteroid' ? 'notario' : 'comprador']}}), modelId:'fixture'};
  }}});
  const values = await Promise.all(['asteroid','buyer'].map(query => withExpandedSourceIndexKeywords(query,['spa'],async () => {
    await Promise.resolve(); return sourceIndexFtsTermGroups(query);
  })));
  expect(values[0]![0]).toContain('notario');
  expect(values[1]).toEqual([['buyer','comprador']]);
});

test('language profile tracks additions, replacements and deletions without writing to the store', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE items(item_pk INTEGER PRIMARY KEY, tombstoned INTEGER); CREATE TABLE chunks(item_pk INTEGER, bounded_text TEXT, content_hash TEXT); INSERT INTO items VALUES(1,0)');
  const text = 'La escritura pública se firmará ante el notario y los gastos correspondientes serán abonados por el comprador, conforme a las condiciones pactadas por ambas partes en el contrato.';
  db.query("INSERT INTO chunks VALUES(1,?, 'v1')").run(text);
  expect(storeKeywordLanguages(db)).toContain('spa');
  db.query("UPDATE chunks SET bounded_text = ?, content_hash = 'v2'").run('The buyer must pay the registration fees before signing the contract. The seller will arrange the final inspection and deliver the keys at the agreed time.');
  expect(storeKeywordLanguages(db)).toContain('eng');
  expect(storeKeywordLanguages(db)).not.toContain('spa');
  db.exec('UPDATE items SET tombstoned=1');
  expect(storeKeywordLanguages(db)).toEqual([]);
  db.close();
});

test('one translation cannot satisfy two concepts, including accented collisions', () => {
  withKeywordAlternatives('cost price', new Map([['cost',['precio']],['price',['précio','precio','cost']]]), () => {
    expect(sourceIndexFtsTermGroups('cost price')).toEqual([['cost','precio'],['price']]);
  });
});

test('an unavailable model never reads the language profile', async () => {
  let reads = 0;
  await expandSourceIndexKeywords('asteroid', () => {reads++;return ['spa'];});
  expect(reads).toBe(0);
});

test('routed preparation does not consume the lane deadline, even when the model fails', async () => {
  const {routeSourceIndexSearch} = await import('../src/core/source-index/router.ts');
  const {buildSourceIndexCorpusRegistry, defineSourceIndexCorpus} = await import('../src/core/source-index/corpus.ts');
  const corpus = defineSourceIndexCorpus({corpusId:'internal.prepared.files',family:'file',trustDomain:'internal',activationMode:'lexical_only'});
  const adapter = Object.assign(() => ({hits:[],latencyMs:0,rawExposed:false as const}), {prepareKeywords: async () => {
    await new Promise(resolve=>setTimeout(resolve,25)); throw new Error('model down');
  }});
  const result = await routeSourceIndexSearch({registry:buildSourceIndexCorpusRegistry([corpus]),adapters:{[corpus.corpusId]:adapter},request:{query:'notary',maxResults:4,context:{allowedTrustDomains:['internal']}},laneTimeoutMs:10});
  expect(result.searchedCorpora).toEqual([corpus.corpusId]);
  expect(result.skippedCorpora).toEqual([]);
});

test('prepared failure stays pinned when ingestion changes the profile', async () => {
  const owner = {};
  let calls=0;
  registerBuiltInPrivateModel({available:()=>true,model:{async complete(){calls++;throw new Error('offline');}}});
  await withKeywordRequestScope(async () => {
    await expandSourceIndexKeywords('asteroid',['spa'],owner);
    expect((await expandSourceIndexKeywords('asteroid',['por'],owner)).size).toBe(0);
  });
  expect(calls).toBe(1);
});

test('Porter and prefix-equivalent translations cannot count twice in real FTS', () => {
  const db=new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE words USING fts5(text, tokenize='porter unicode61'); INSERT INTO words VALUES('precios')");
  withKeywordAlternatives('cost price',new Map([['cost',['precio']],['price',['precios']]]),()=>{
    const groups=sourceIndexFtsTermGroups('cost price');
    expect(groups).toEqual([['cost','precio'],['price']]);
    const matches=groups.filter(group=>db.query('SELECT rowid FROM words WHERE words MATCH ?').get(group.map(term=>'"'+term+'"*').join(' OR '))).length;
    expect(matches).toBe(1);
  });
  db.close();
});

test('design vocabulary works both ways without a model; baseline can disable every expansion', async () => {
  const {withKeywordExpansionDisabled}=await import('../src/core/source-index/keyword-context.ts');
  expect((await expandSourceIndexKeywords('notary',['spa'])).get('notary')).toContain('escritura pública');
  expect((await expandSourceIndexKeywords('notário',['eng'])).get('notário')).toContain('notary');
  expect((await withKeywordExpansionDisabled(()=>expandSourceIndexKeywords('notary',['spa']))).size).toBe(0);
});

test('reverse questions do not count foreign articles as topic concepts', () => {
  const groups=sourceIndexFtsTermGroups('¿Qué escritura pública debe recoger la transferencia definitiva del apartamento?');
  expect(groups.some(group=>group[0]==='qué')).toBe(false);
  expect(groups.some(group=>group[0]==='la')).toBe(false);
  expect(groups.some(group=>group[0]==='escritura')).toBe(true);
  expect(sourceIndexFtsTermGroups('What does my will say about the house in May?').map(group=>group[0])).toEqual(['will','house','may']);
});


test('overlapping translated phrases cannot satisfy two concepts with one occurrence', () => {
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE words USING fts5(text, tokenize='porter unicode61'); INSERT INTO words VALUES('precio total')");
  for (const alternatives of [new Map([['cost',['precio']],['price',['precio total']]]), new Map([['cost',['precio total']],['price',['precio']]])]) {
    withKeywordAlternatives('cost price', alternatives, () => {
      const groups = sourceIndexFtsTermGroups('cost price');
      const matches = groups.filter(group => db.query('SELECT rowid FROM words WHERE words MATCH ?').get(group.map(term=>'"'+term+'"*').join(' OR '))).length;
      expect(matches).toBe(1);
    });
  }
  db.close();
});


test('English request scaffolding excludes English as a translation target despite a short topic', async () => {
  let calls = 0;
  registerBuiltInPrivateModel({available:()=>true,model:{async complete(){calls++;return {text:'{}',modelId:'fixture'};}}});
  for (const query of ['Where is Lagrange?', 'Who wrote the quantum paper?']) {
    expect((await expandSourceIndexKeywords(query,['eng'])).size).toBe(0);
  }
  expect(calls).toBe(0);
  await expandSourceIndexKeywords('Quem escreveu este documento?',['eng']);
  expect(calls).toBe(1);
});


test('a single shared preposition does not turn a short foreign question into English', async () => {
  registerBuiltInPrivateModel({available:()=>true,model:{async complete(){return {text:'{"eng":{"0":["cost"]}}',modelId:'fixture'};}}});
  expect((await expandSourceIndexKeywords('gastos a cargo',['eng'])).get('gastos')).toContain('fees');
});
