import test from 'node:test';
import assert from 'node:assert/strict';
import {pair,encrypt,decrypt,aad} from './probe.mjs';
test('legacy ciphertext authenticates and only the addressed client can decrypt',()=>{
 const a=pair(),b=pair(),c=encrypt('synthetic ORCHID',a.getPublicKey('hex'));
 assert.equal(decrypt(c,a),'synthetic ORCHID');assert.throws(()=>decrypt(c,b));
 const bad=Buffer.from(c,'hex');bad[bad.length-1]^=1;assert.throws(()=>decrypt(bad.toString('hex'),a));
 for(const plain of [' ', 'ORCHID', '', '04', 'f'.repeat(187)])assert.throws(()=>decrypt(plain,a),/not_ciphertext/);
});
test('v2 published AAD vector is byte exact; altered context fails authentication',()=>{
 const ctx={purpose:'aci.e2ee.request.v2',algo:'x25519-aes-256-gcm-hkdf-sha256',model:'demo-model',field:'messages.0.content',nonce:'000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',ts:1750000000};
 assert.equal(aad(ctx).toString(),'{"algo":"x25519-aes-256-gcm-hkdf-sha256","field":"messages.0.content","model":"demo-model","nonce":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f","purpose":"aci.e2ee.request.v2","ts":1750000000}');
 const p=pair(),info='aci.e2ee.v2.secp256k1',bound={...ctx,algo:'secp256k1-aes-256-gcm-hkdf-sha256'};
 const c=encrypt('synthetic ORCHID',p.getPublicKey('hex'),info,aad(bound));assert.equal(decrypt(c,p,info,aad(bound)),'synthetic ORCHID');
 assert.throws(()=>decrypt(c,p,info,aad({...bound,model:'another-model'})));
 assert.throws(()=>decrypt(c,p));
});
