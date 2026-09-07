import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const CORPUS_SHA='0ff72eb926c9556e8fafa7e334d2221c59dac1e79a968640dc372f6740aafcc8';
const QUESTIONS_SHA='db198b3cc853614648a0ddbdf1258a18bb8294a88b0befed177996300b53da36';
const REVISIONS={main:'911caf3f834433f3547049ca07a7bb8d8d268ee7',parallel:'7aac1040d7235574925ddf94002dd1b42f8591ed'};
const MODEL='gemini-2.5-flash',BASE='https://generativelanguage.googleapis.com/v1beta/openai',ENDPOINT=BASE+'/chat/completions';
const LIMITS={requests:62,bodyUtf8Bytes:40000,maxTokens:1024,requestTimeoutMs:45000,maxResults:12,maxCharsPerCandidate:800,maxOutputChars:3072};
const FAMILIES:Record<string,string>={gmail:'email',google_drive:'file',dropbox:'file',telegram:'chat',whatsapp_personal:'chat',x:'x',readwise:'readwise'};
const hash=(x:string|Uint8Array)=>createHash('sha256').update(x).digest('hex');
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
let secret='',outputDir='';
const clean=(x:string)=>secret?x.split(secret).join('[REDACTED]'):x;
function save(p:string,x:unknown,exclusive=false){writeFileSync(p,clean(JSON.stringify(x,null,2))+'\n',{mode:0o600,...(exclusive?{flag:'wx'}:{})});}
function errorInfo(e:any){return {name:clean(String(e?.name??'Error')),message:clean(String(e?.message??e)).slice(0,1200)};}
function args(){const a:Record<string,string>={};for(let i=2;i<process.argv.length;i++){const k=process.argv[i]!;if(['--prepare','--smoke','--run'].includes(k)){if(a.mode)throw Error('Select one mode');a.mode=k.slice(2);}else{if(!k.startsWith('--')||!process.argv[i+1])throw Error('Invalid arguments');a[k.slice(2)]=process.argv[++i]!;}}for(const k of ['mode','rootMain','rootParallel','corpus','questions','snapshotDir','outputDir'])if(!a[k])throw Error('Missing --'+k);return a;}
async function imp(root:string,p:string){return import(pathToFileURL(join(root,p)).href);}
function sourceBinding(root:string,arm:'main'|'parallel'){
 const paths:string[]=[];function walk(p:string){for(const n of readdirSync(join(root,p)).sort()){const r=join(p,n);if(statSync(join(root,r)).isDirectory())walk(r);else if(r.endsWith('.ts'))paths.push(r);}}walk('src');
 for(const p of ['eval/types.ts','eval/grade.ts','eval/run.ts','eval/qualification.ts'])paths.push(p);
 const measured=hash(paths.map(p=>p+'\0'+hash(readFileSync(join(root,p)))).join('\n'));
 const git=Bun.spawnSync(['git','-C',root,'rev-parse','HEAD'],{stdout:'pipe',stderr:'pipe'});const gitSha=git.exitCode===0?git.stdout.toString().trim():null;
 if(gitSha)assert.equal(gitSha,REVISIONS[arm]);return {expectedRevision:REVISIONS[arm],gitSha,sourceTreeSha256:measured,sourceFiles:paths.length};
}
async function prepare(a:any,records:any[],dataset:any){
 assert.ok(!existsSync(join(a.outputDir,'execution-spec.json')),'Execution spec already exists; use a fresh directory');
 assert.ok(!existsSync(join(a.snapshotDir,'seed')),'Snapshot seed already exists; use a fresh snapshot directory');
 const main=await imp(a.rootMain,'src/workers/connector-store/index.ts'),types=await imp(a.rootMain,'src/core/source-index/types.ts');
 const snapshots:any={};
 for(const provider of Object.keys(FAMILIES)){
  const rows=records.filter(r=>r.provider===provider),family=FAMILIES[provider],corpusId=rows[0].metadata.corpusId;
  const seed=join(a.snapshotDir,'seed',provider+'.sqlite');mkdirSync(dirname(seed),{recursive:true});
  const store=new main.LocalConnectorStore({dbPath:seed,corpusId,family,trustDomain:'public_safe'});
  const raw=(r:any)=>({identity:{family,provider,accountScope:'fixture',providerItemId:r.id,localItemId:`fixture:${r.id}`,sourceVersion:'frozen-v1',...(family==='file'?{providerFileId:r.id}:{}),...(family==='chat'?{providerConversationId:`${provider}:fixture-thread`,providerThreadId:`${provider}:fixture-thread`}:{})},mimeType:r.metadata.extractionStatus==='unreadable'?'application/pdf':'text/plain',content:r.metadata.extractionStatus==='unreadable'?{kind:'metadata_only'}:{kind:'text',text:r.text},metadata:Object.freeze({...r.metadata,title:r.title,name:r.title,authoredAt:r.authoredAt,timestamp:r.authoredAt,locatorUri:r.url}),fetchedAt:'2026-09-07T00:00:00.000Z'});
  try{await store.syncFromConnector({id:`fixture-${provider}`,family,async authenticate(){},async *listItems(){yield{items:rows.map(raw),done:true};},async fetchItem(id:string){const r=rows.find(r=>`fixture:${r.id}`===id);assert.ok(r);return raw(r);},classify(){return types.buildSourceSensitivity({trustTier:'S0',trustDomain:'public_safe'});}},{fetchContent:true});assert.equal(store.status().counts.items,rows.length);}finally{store.close();}
  const consolidated=join(a.snapshotDir,'consolidated',provider+'.sqlite');mkdirSync(dirname(consolidated),{recursive:true});const db=new Database(seed,{readonly:true});try{db.exec('PRAGMA busy_timeout=10000');db.exec(`VACUUM INTO '${consolidated.replaceAll("'","''")}'`);}finally{db.close();}
  const check=new Database(consolidated,{readonly:true});try{assert.equal(Object.values(check.query('PRAGMA integrity_check').get() as object)[0],'ok');}finally{check.close();}
  const sha256=hash(readFileSync(consolidated));for(const arm of ['main','parallel']){const p=join(a.snapshotDir,arm,provider+'.sqlite');mkdirSync(dirname(p),{recursive:true});copyFileSync(consolidated,p);assert.equal(hash(readFileSync(p)),sha256);}
  snapshots[provider]={corpusId,family,sha256,items:rows.length,unreadableIds:rows.filter(r=>r.metadata.extractionStatus==='unreadable').map(r=>r.id)};
 }
 const bindings={main:sourceBinding(a.rootMain,'main'),parallel:sourceBinding(a.rootParallel,'parallel')};
 const spec={kind:'olympus_real_model_synthetic_ab_spec',version:1,frozenAt:new Date().toISOString(),corpusSha256:CORPUS_SHA,questionsSha256:QUESTIONS_SHA,questionCount:dataset.questions.length,scriptSha256:hash(readFileSync(import.meta.path)),bindings,snapshots,model:MODEL,endpoint:ENDPOINT,limits:LIMITS,requestsAlreadyUsedOutsideHarness:2,absoluteTotalRequestCeiling:64,options:{analyst_provider:'cloud',retrieval_mode:'keyword',temperature:0,reasoning_effort:'none',serviceTier:false,queryPlanner:false,selfHeal:false,analystAudit:false,localSQLiteCloudQueryApproved:false},order:'Even zero-based question: main then parallel; odd: parallel then main',projection:'S0/public_safe only. Retrieval stays in local SQLite with cloudQueryApproved:false; cloud synthesis is explicitly selected separately. Frozen extractionStatus=unreadable records are metadata-only PDFs; their descriptive text is not fabricated extracted content.',grading:'Each revision uses its actual runSourceQualificationEval/gradeAnswer. True content-provider coverage gaps captured during actual retrieval only. No expected labels are passed to the model. Pending privacy is not accepted as privacy proof.',comparison:'Different prose alone is not failure. Compare frozen grades, evidence identities, true coverage, policy and prompt hashes. Identical prompts with different outcomes require repeated inference before attribution.'};
 save(join(a.outputDir,'execution-spec.json'),spec,true);save(join(a.outputDir,'budget.json'),{specSha256:hash(readFileSync(join(a.outputDir,'execution-spec.json'))),attempted:0},true);console.log('PREPARED: frozen spec and identical read-only A/B snapshot inputs; no credential read or model call.');
}
function readKey(path:string){if(!path)throw Error('Missing --workerEnv for model execution');const matches=readFileSync(path,'utf8').split(/\r?\n/).filter(l=>l.startsWith('OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY='));assert.equal(matches.length,1,'Expected one explicit Olympus Gemini key assignment');let value=matches[0]!.slice(matches[0]!.indexOf('=')+1).trim();if(value.startsWith("'")&&value.endsWith("'"))value=value.slice(1,-1);else if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1);if(!value||/[\r\n\0]/.test(value))throw Error('Invalid key assignment');return value;}
async function main(){
 const a=args();outputDir=resolve(a.outputDir);a.outputDir=outputDir;mkdirSync(outputDir,{recursive:true});
 const corpusBytes=readFileSync(a.corpus),questionBytes=readFileSync(a.questions);assert.equal(hash(corpusBytes),CORPUS_SHA);assert.equal(hash(questionBytes),QUESTIONS_SHA);
 const records=JSON.parse(corpusBytes.toString()),dataset=JSON.parse(questionBytes.toString());assert.equal(records.length,32);assert.equal(dataset.questions.length,16);
 const originalFetch=globalThis.fetch.bind(globalThis);globalThis.fetch=(()=>{throw Error('Uninstrumented network forbidden');}) as typeof fetch;
 if(a.mode==='prepare'){await prepare(a,records,dataset);return;}
 const specPath=join(outputDir,'execution-spec.json'),spec=json(specPath),specSha256=hash(readFileSync(specPath));assert.equal(spec.corpusSha256,CORPUS_SHA);assert.equal(spec.questionsSha256,QUESTIONS_SHA);assert.equal(spec.scriptSha256,hash(readFileSync(import.meta.path)));
 for(const arm of ['main','parallel'] as const){assert.deepEqual(sourceBinding(arm==='main'?a.rootMain:a.rootParallel,arm),spec.bindings[arm]);for(const provider of Object.keys(FAMILIES))assert.equal(hash(readFileSync(join(a.snapshotDir,arm,provider+'.sqlite'))),spec.snapshots[provider].sha256);}
 secret=readKey(a.workerEnv);let active={arm:'smoke',questionId:'smoke'};const events:any[]=[];
 const journal=(event:any)=>{events.push(event);appendFileSync(join(outputDir,'model-calls.jsonl'),clean(JSON.stringify(event))+'\n',{mode:0o600});};
 const guardedFetch=async(url:string,init:RequestInit)=>{
  assert.equal(url,ENDPOINT);assert.equal(init.method,'POST');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+secret);
  assert.equal(typeof init.body,'string');const body=JSON.parse(init.body as string);assert.equal(body.model,MODEL);assert.equal(body.temperature,0);assert.equal(body.reasoning_effort,'none');assert.ok(!('service_tier'in body));
  assert.ok(Object.keys(body).every(k=>['temperature','model','messages','reasoning_effort','max_tokens'].includes(k)),'Unexpected generation body option');assert.ok(body.max_tokens>0&&body.max_tokens<=LIMITS.maxTokens);assert.ok(new TextEncoder().encode(init.body as string).length<=LIMITS.bodyUtf8Bytes);
  const budget=json(join(outputDir,'budget.json'));assert.equal(budget.specSha256,specSha256);assert.ok(budget.attempted<LIMITS.requests,'Global request budget exhausted');budget.attempted++;save(join(outputDir,'budget.json'),budget);
  const started=performance.now(),event:any={...active,requestOrdinal:budget.attempted,requestedModel:MODEL,promptSha256:hash(JSON.stringify(body.messages)),bodySha256:hash(init.body as string),bodyUtf8Bytes:new TextEncoder().encode(init.body as string).length,maxTokens:body.max_tokens};
  const controller=new AbortController(),abort=()=>controller.abort();init.signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,LIMITS.requestTimeoutMs);
  try{
   const response=await originalFetch(url,{...init,redirect:'error',signal:controller.signal});event.httpStatus=response.status;
   const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;if(reader)while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>262144){controller.abort();throw Error('Response body too large');}chunks.push(next.value);}
   const full=new Uint8Array(size);let offset=0;for(const chunk of chunks){full.set(chunk,offset);offset+=chunk.length;}const responseText=new TextDecoder().decode(full);event.responseSha256=hash(full);
   try{const data=JSON.parse(responseText);event.responseModel=data.model??null;event.usage=data.usage??null;event.finishReason=data.choices?.[0]?.finish_reason??null;event.modelResponseSha256=hash(String(data.choices?.[0]?.message?.content??''));if(!response.ok)event.safeErrorBody=clean(responseText).slice(0,1200);}catch{event.invalidJson=true;}
   event.durationMs=performance.now()-started;journal(event);return new Response(full,{status:response.status,headers:{'Content-Type':'application/json'}});
  }catch(e){event.durationMs=performance.now()-started;event.error=errorInfo(e);journal(event);throw Error('Bounded Gemini request failed');}finally{clearTimeout(timer);init.signal?.removeEventListener('abort',abort);}
 };
 async function modelFor(root:string){const {createOpenAICompatibleAnalystModel}=await imp(root,'src/core/analyst-openai.ts');return createOpenAICompatibleAnalystModel({apiKey:secret,model:MODEL,baseUrl:BASE,reasoningEffort:'none',serviceTier:false,timeoutMs:LIMITS.requestTimeoutMs,maxTokensField:'max_tokens',extraBody:{temperature:0},fetchImpl:guardedFetch,providerLabel:'Gemini synthetic A/B'});}
 if(a.mode==='smoke'){
  assert.ok(!existsSync(join(outputDir,'smoke.json')),'Smoke already attempted; no automatic retry');save(join(outputDir,'smoke.json'),{specSha256,attempted:true,passed:false},true);
  const model=await modelFor(a.rootMain);const started=performance.now();const result=await model.complete({system:'Return a JSON object with a single key named status whose value is ready.',prompt:'This is a synthetic transport smoke test. Return the requested JSON only.',localOnly:false,maxOutputChars:96});
  assert.equal(result.modelId,MODEL,'Returned model identity differs');assert.ok(result.text.trim());save(join(outputDir,'smoke.json'),{specSha256,attempted:true,passed:true,modelId:result.modelId,responseSha256:hash(result.text),durationMs:performance.now()-started});console.log('SMOKE PASSED: one real bounded request; bulk not started.');return;
 }
 assert.equal(a.mode,'run');assert.equal(json(join(outputDir,'smoke.json')).specSha256,specSha256);assert.equal(json(join(outputDir,'smoke.json')).passed,true);save(join(outputDir,'run-started.json'),{specSha256,startedAt:new Date().toISOString()},true);
 const arms:any={};
 for(const arm of ['main','parallel']){
  const root=arm==='main'?a.rootMain:a.rootParallel;const storeApi=await imp(root,'src/workers/connector-store/index.ts'),corpusApi=await imp(root,'src/core/source-index/corpus.ts'),analystApi=await imp(root,'src/core/analyst.ts'),answerApi=await imp(root,'src/workers/source-index/analyst-answer.ts'),qualification=await imp(root,'eval/qualification.ts');
  const state:any={root,qualification,stores:[],coverage:[],retrieval:[],hydration:[]};const adapters:any={},contentProviders:any={},definitions=[];
  for(const provider of Object.keys(FAMILIES)){
   const s=spec.snapshots[provider],store=new storeApi.LocalConnectorStore({dbPath:join(a.snapshotDir,arm,provider+'.sqlite'),corpusId:s.corpusId,family:s.family,trustDomain:'public_safe',readOnly:true});state.stores.push(store);assert.equal(store.status().counts.items,s.items);
   definitions.push(corpusApi.defineSourceIndexCorpus({corpusId:s.corpusId,family:s.family,trustDomain:'public_safe',storageProfileInput:{cloudQueryApproved:false}}));const adapter=storeApi.createConnectorStoreCorpusAdapter({store,accountScope:'fixture',retrievalMode:'keyword'}),content=storeApi.createConnectorStoreContentProvider({store});
   adapters[s.corpusId]=async(request:any)=>{const result=await adapter(request);state.retrieval.push({corpusId:s.corpusId,querySha256:hash(request.query),hits:result.hits.map((h:any)=>({sourceItem:h.sourceItem,score:h.score,provenance:h.provenance}))});return result;};
   contentProviders[s.corpusId]={fetchLocalContent:async(request:any)=>{const result=await content.fetchLocalContent(request);state.hydration.push({corpusId:s.corpusId,providerItemId:request.provenance.sourceItem.providerItemId,chunksSha256:hash(JSON.stringify(result?.chunks??[])),gaps:result?.coverageGaps??[]});state.coverage.push(...(result?.coverageGaps??[]));return result;},...(content.readability?{readability:content.readability.bind(content)}:{})};
  }
  const registry=corpusApi.buildSourceIndexCorpusRegistry(definitions),model=await modelFor(root),cloudAnalyst=analystApi.createAnalyst(model,{defaultMaxOutputChars:LIMITS.maxOutputChars,auditSuspiciousDrafts:false});
  state.handler=answerApi.createAnalystSourceIndexAnswerHandler({analyst:{async analyze(){throw Error('Local analyst unconfigured; Google is never a local lane');}},cloudAnalyst,lanes:()=>({registry,adapters,contentProviders}),defaultMaxResults:LIMITS.maxResults,maxCharsPerCandidate:LIMITS.maxCharsPerCandidate,selfHealEnabled:false,cloudAnalystTimeoutMs:LIMITS.requestTimeoutMs,localAnalystTimeoutMs:1});arms[arm]=state;
 }
 const observations:any[]=[];
 try{
  for(let ordinal=0;ordinal<dataset.questions.length;ordinal++){
   const question=dataset.questions[ordinal],order=ordinal%2?['parallel','main']:['main','parallel'];
   for(const arm of order){const state=arms[arm];active={arm,questionId:question.id};state.coverage=[];state.retrieval=[];state.hydration=[];const start=performance.now(),callStart=events.length;let wire:any;
    const adapter={authority:'connector_store_loopback',answer:async(q:any)=>{wire=await state.handler.answer({question:q.question,analyst_provider:'cloud',retrieval_mode:'keyword',max_results:LIMITS.maxResults,include_internal:false,include_secure_local:false,timeout_ms:LIMITS.requestTimeoutMs});return{result:wire,coverage:{searchedCorpora:wire.audit.searched_corpora,skippedCorpora:wire.audit.skipped_corpora.map((x:any)=>({corpusId:x.corpus_id,reason:x.reason})),extractionGaps:[...new Set(state.coverage)]}};}};
    const run=await state.qualification.runSourceQualificationEval({...dataset,questions:[question]},{adapter,questionTimeoutMs:LIMITS.requestTimeoutMs+1000});const grade=run.report.grades[0],calls=events.slice(callStart);const identities=(wire?.evidence??[]).map((x:any)=>({corpusId:x.corpus_id,provider:x.provider,providerItemId:x.provider_item_id,uri:x.uri??null,citationSpan:x.citation_span??null}));
    const observation={arm,questionId:question.id,ordinal:ordinal+1,grade,privacyProven:grade?.privacyRespected===true,passedWithPrivacy:grade?.passed===true&&grade?.privacyRespected===true,wallMs:performance.now()-start,wireTimings:wire?.audit?.phase_timings??null,backend:wire?.audit?.answer_synthesis?.analyst_backend??null,identities,coverageGaps:[...new Set(state.coverage)],skippedCorpora:wire?.audit?.skipped_corpora??[],policy:wire?.policy??null,opsec:wire?.opsec??null,calls};
    observations.push(observation);save(join(outputDir,`${ordinal+1}-${arm}.synthetic-answer.json`),{...observation,wire,retrieval:state.retrieval,hydration:state.hydration});save(join(outputDir,'partial-report.json'),{specSha256,observations});console.log(JSON.stringify({arm,ordinal:ordinal+1,passed:observation.passedWithPrivacy,modelCalls:calls.length}));
   }
  }
 }finally{for(const state of Object.values(arms) as any[])for(const store of state.stores)store.close();}
 for(const arm of ['main','parallel'])for(const provider of Object.keys(FAMILIES))assert.equal(hash(readFileSync(join(a.snapshotDir,arm,provider+'.sqlite'))),spec.snapshots[provider].sha256,'Read-only snapshot changed');
 const pairs=dataset.questions.map((q:any)=>{const main=observations.find(x=>x.arm==='main'&&x.questionId===q.id),parallel=observations.find(x=>x.arm==='parallel'&&x.questionId===q.id);return{questionId:q.id,mainPassed:main.passedWithPrivacy,parallelPassed:parallel.passedWithPrivacy,gradeEqual:JSON.stringify(main.grade)===JSON.stringify(parallel.grade),evidenceIdentityEqual:JSON.stringify(main.identities)===JSON.stringify(parallel.identities),coverageEqual:JSON.stringify(main.coverageGaps)===JSON.stringify(parallel.coverageGaps),promptParity:JSON.stringify(main.calls.map((x:any)=>x.promptSha256))===JSON.stringify(parallel.calls.map((x:any)=>x.promptSha256))};});
 const allCalls=readFileSync(join(outputDir,'model-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
 save(join(outputDir,'safe-report.json'),{kind:'olympus_real_model_synthetic_ab_result',specSha256,model:MODEL,bindings:spec.bindings,corpusSha256:CORPUS_SHA,questionsSha256:QUESTIONS_SHA,snapshotHashes:spec.snapshots,requestCount:json(join(outputDir,'budget.json')).attempted,requestsAlreadyUsedOutsideHarness:2,totalRequestsIncludingPriorSmoke:json(join(outputDir,'budget.json')).attempted+2,usage:allCalls.map(x=>({ordinal:x.requestOrdinal,model:x.responseModel,usage:x.usage??null})),pairs,observations,limits:LIMITS,limitations:['Fictional S0/public_safe corpus only; no real-provider, private-corpus, embedding, default-preset or onboarding proof.','One sample per arm/question; different outcomes under identical prompts do not establish a branch effect.','Literal expected-value/citation/gap grades are reported unchanged; all failed questions remain visible.','No automatic retry or prompt tuning. No model is labelled local.']});console.log('COMPLETE: safe-report.json; inspect all failures and limits.');
}
main().catch(e=>{if(outputDir)save(join(outputDir,'failure.json'),{error:errorInfo(e),failedAt:new Date().toISOString()});console.error('Harness failed; inspect the redacted failure.json and model-calls.jsonl.');process.exitCode=1;});
