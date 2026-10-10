import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const key = process.env.VENICE_API_KEY;
if (!key) throw new Error('Missing Venice key');
const base = 'https://api.venice.ai/api/v1';
const catalogRes = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
if (!catalogRes.ok) throw new Error(`catalog HTTP ${catalogRes.status}`);
const catalog = await catalogRes.json();
const models = catalog.data.filter(m => m.model_spec?.capabilities?.supportsE2EE === true);
console.log(JSON.stringify({ models: models.map(m => ({id:m.id,capabilities:m.model_spec.capabilities})) }));
await writeFile(new URL('./catalog.json', import.meta.url), JSON.stringify(models, null, 2));
for (const model of ['e2ee-qwen3-6-35b-a3b', 'e2ee-glm-5-2-p']) {
  if (!models.some(m => m.id === model)) throw new Error(`Model no longer in catalog: ${model}`);
  const nonce = randomBytes(32).toString('hex');
  const res = await fetch(`${base}/tee/attestation?${new URLSearchParams({model,nonce})}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`attestation HTTP ${res.status}`);
  const a = await res.json();
  await writeFile(new URL(`./${model}-attestation.json`, import.meta.url), JSON.stringify({fetchedAt:new Date().toISOString(),challenge:nonce,attestation:a},null,2));
  function shape(v, depth=0) { if (v===null) return null; if(typeof v==='string') return `string(${v.length})`; if(typeof v!=='object') return v; if(depth>3) return Array.isArray(v)?`array(${v.length})`:'object'; if(Array.isArray(v)) return v.slice(0,2).map(x=>shape(x,depth+1)); return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shape(x,depth+1)])); }
  console.log(JSON.stringify({model,status:res.status,provider:a.tee_provider,nonceMatches:a.nonce===nonce,shape:shape(a)},null,2));
}
