// P0 interoperability probe only. No attestation trust verdict or Olympus routing.
// Run with synthetic text only; secrets stay in the environment, keys in memory.
import { createECDH, hkdfSync, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const base = 'https://api.venice.ai/api/v1';
export const sha256 = b => createHash('sha256').update(b).digest('hex');
export function pair() { const p=createECDH('secp256k1'); p.generateKeys(); return p; }
function pub(hex) { const h=hex.replace(/^0x/,''); return Buffer.from(h.length===128?'04'+h:h,'hex'); }
export function aad(context) { return Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(context).sort(([a],[b])=>a<b?-1:a>b?1:0)))); }
export function encrypt(text, recipient, info='ecdsa_encryption', associatedData) {
  const ep=pair(), shared=ep.computeSecret(pub(recipient));
  const key=Buffer.from(hkdfSync('sha256',shared,Buffer.alloc(0),info,32));
  try { const iv=randomBytes(12), c=createCipheriv('aes-256-gcm',key,iv); if(associatedData)c.setAAD(associatedData); const cipher=Buffer.concat([c.update(text,'utf8'),c.final()]); return Buffer.concat([ep.getPublicKey(),iv,cipher,c.getAuthTag()]).toString('hex'); }
  finally { shared.fill(0); key.fill(0); /* OpenSSL ECDH object released on process exit. */ }
}
export function decrypt(hex, receiver, info='ecdsa_encryption', associatedData) {
  if(typeof hex!=='string'||hex.length<186||hex.length%2||!/^[0-9a-f]+$/i.test(hex))throw new Error('not_ciphertext');
  const raw=Buffer.from(hex,'hex'), shared=receiver.computeSecret(raw.subarray(0,65));
  const key=Buffer.from(hkdfSync('sha256',shared,Buffer.alloc(0),info,32));
  try { const d=createDecipheriv('aes-256-gcm',key,raw.subarray(65,77)); if(associatedData)d.setAAD(associatedData); d.setAuthTag(raw.subarray(-16)); return Buffer.concat([d.update(raw.subarray(77,-16)),d.final()]).toString('utf8'); }
  finally { shared.fill(0);key.fill(0); }
}
async function save(name,value) { await writeFile(new URL(`./${name}`,import.meta.url),typeof value==='string'?value:JSON.stringify(value,null,2)); }
async function main() {
  const model=process.argv[2], mode=process.argv[3]??'legacy';
  if(!['e2ee-qwen3-6-35b-a3b','e2ee-glm-5-2-p'].includes(model)||!['legacy','v2'].includes(mode))throw new Error('Explicit P0 model and mode required');
  const apiKey=process.env.VENICE_API_KEY;if(!apiKey)throw new Error('Missing Venice key');
  const auth={Authorization:`Bearer ${apiKey}`};
  const nonce=randomBytes(32).toString('hex');
  const ar=await fetch(`${base}/tee/attestation?${new URLSearchParams({model,nonce})}`,{headers:auth,signal:AbortSignal.timeout(60000)});
  if(!ar.ok)throw new Error(`attestation HTTP ${ar.status}`);
  const att=await ar.json(); if(att.nonce!==nonce)throw new Error('nonce mismatch');
  await save(`${model}-${mode}-attestation.json`,{fetchedAt:new Date().toISOString(),challenge:nonce,attestation:att});
  const keyset=att.attestation?.workload_keyset?.e2ee_public_keys;
  const entry=keyset?.find(k=>k.algo==='secp256k1-aes-256-gcm-hkdf-sha256');
  if(mode==='v2'&&!entry)throw new Error('No v2 secp256k1 key advertised');
  const modelKey=mode==='legacy'?(att.signing_key??att.signing_public_key):(entry.public_key??entry.key);
  if(typeof modelKey!=='string')throw new Error(`Unknown key entry shape: ${Object.keys(entry??{})}`);
  const client=pair(), other=pair();
  const context={algo:'secp256k1-aes-256-gcm-hkdf-sha256',model,nonce:randomBytes(32).toString('hex'),ts:Math.floor(Date.now()/1000)};
  const info=mode==='legacy'?'ecdsa_encryption':'aci.e2ee.v2.secp256k1';
  const plain={model,messages:[{role:'user',content:'Reply with exactly the word ORCHID. This is a synthetic encryption interoperability probe.'}],stream:true,max_tokens:64,venice_parameters:{include_venice_system_prompt:false,...(mode==='legacy'?{disable_thinking:true}:{}),enable_web_search:'off'}};
  const body=JSON.stringify({...plain,messages:plain.messages.map((m,i)=>({...m,content:encrypt(m.content,modelKey,info,mode==='v2'?aad({...context,purpose:'aci.e2ee.request.v2',field:`messages.${i}.content`}):undefined)}))});
  await save(`${model}-${mode}-request.json`,body);
  // Identical ciphertext in the swapped run: only the unauthenticated reply-key header changes.
  for(const swapped of mode==='legacy'?[false,true]:[false]) {
    const label=`${model}-${mode}-${swapped?'swapped':'normal'}`;
    const responseKey=swapped?other:client;
    const headers={...auth,'Content-Type':'application/json',...(mode==='legacy'?{
      'X-Venice-TEE-Client-Pub-Key':responseKey.getPublicKey('hex'),
      'X-Venice-TEE-Model-Pub-Key':modelKey,'X-Venice-TEE-Signing-Algo':'ecdsa'
    }:{'X-E2EE-Version':'2','X-Client-Pub-Key':responseKey.getPublicKey('hex'),'X-Model-Pub-Key':modelKey,'X-E2EE-Nonce':context.nonce,'X-E2EE-Timestamp':String(context.ts)})};
    const startedAt=new Date().toISOString();
    const res=await fetch(`${base}/chat/completions`,{method:'POST',headers,body,signal:AbortSignal.timeout(90000)});
    const wire=await res.text();
    await save(`${label}.sse`,wire);
    const selectedHeaders=Object.fromEntries([...res.headers].filter(([k])=>/^(x-e2ee|x-aci|x-venice-tee|x-venice-version|x-request-id|content-type)/.test(k)));
    const summary={startedAt,model,mode,swapped,httpStatus:res.status,headers:selectedHeaders,requestSha256:sha256(body),responseSha256:sha256(wire),encryptedChunks:0,plaintextChunks:0,emptyChunks:0,decryptFailures:0,originalKeySuccess:0,otherKeySuccess:0,done:false,ids:[],finishReasons:[],decrypted:'',errors:[]};
    for(const line of wire.split(/\r?\n/)){
      if(!line.startsWith('data:'))continue;
      const data=line.slice(5).trim();if(data==='[DONE]'){summary.done=true;continue;}
      let obj;try{obj=JSON.parse(data);}catch{summary.errors.push('invalid_json');continue;}
      if(obj.error)summary.errors.push(obj.error);
      if(obj.id&&!summary.ids.includes(obj.id))summary.ids.push(obj.id);
      for(const choice of obj.choices??[]){
        if(choice.finish_reason)summary.finishReasons.push(choice.finish_reason);
        for(const field of ['content','reasoning','reasoning_content']){
          const s=choice.delta?.[field];if(s===undefined||s===null)continue;
          if(s===''){summary.emptyChunks++;continue;}
          if(typeof s!=='string'||s.length<186||s.length%2||!/^[0-9a-f]+$/i.test(s)){summary.plaintextChunks++;continue;}
          summary.encryptedChunks++;
          const ad=mode==='v2'?aad({...context,purpose:'aci.e2ee.response.v2',id:obj.id??'',field:`choices.${choice.index??0}.delta.${field}`}):undefined;
          let success=false;
          for(const [name,k] of [['originalKeySuccess',client],['otherKeySuccess',other]]){
            try{const clear=decrypt(s,k,info,ad);summary[name]++;if(k===responseKey){summary.decrypted+=clear;success=true;}}catch{}
          }
          if(!success)summary.decryptFailures++;
        }
      }
    }
    if(!res.ok)summary.errorBody=wire.slice(0,2000);
    for(const id of summary.ids){
      const sr=await fetch(`${base}/tee/signature?${new URLSearchParams({model,request_id:id})}`,{headers:auth,signal:AbortSignal.timeout(30000)});
      const signatureWire=await sr.text();await save(`${label}-signature.json`,signatureWire);
      summary.signatureStatus=sr.status;
      try{const sig=JSON.parse(signatureWire);summary.signatureKeys=Object.keys(sig);summary.signatureText=sig.text;summary.signatureRequestHashMatches=sig.text?.includes(summary.requestSha256)??false;summary.signatureResponseHashMatches=sig.text?.includes(summary.responseSha256)??false;}catch{summary.errors.push('non_json_signature');}
    }
    await save(`${label}-summary.json`,summary);console.log(JSON.stringify(summary,null,2));
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
