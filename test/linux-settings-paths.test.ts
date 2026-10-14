import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxEngineEnvironment, publishLinuxEngineReceipt, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'linux-settings-')); roots.push(home);
  const env = { HOME: home, XDG_RUNTIME_DIR: join(home, 'run') };
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  const layout = resolveLinuxEngineLayout(env); publishLinuxEngineReceipt(layout);
  return { home, layout, env: linuxEngineEnvironment(layout) };
}
function probe(env: Record<string, string>, code: string) {
  const result = Bun.spawnSync([process.execPath, '-e', code], { env: { PATH: process.env.PATH, ...env }, stdout: 'pipe', stderr: 'pipe' });
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: '' });
  return JSON.parse(result.stdout.toString());
}
for (const platform of ['linux', 'darwin']) test(`${platform} settings defaults use the expected platform root`, () => {
  const { home, env, layout } = fixture();
  const paths = probe(env, `
    Object.defineProperty(process, 'platform', { value: '${platform}' });
    const { defaultPrivacyProfilePath } = await import('./src/workers/classification/privacy-profile.ts');
    const { defaultTierRulesPath } = await import('./src/workers/classification/tier-rules.ts');
    const { defaultDropboxIngestionPolicyPath } = await import('./src/core/source-ingestion-policy.ts');
    const { defaultSourceIngestionExclusionsPath } = await import('./src/core/source-ingestion-exclusions.ts');
    const { consultSettingsPath } = await import('./src/core/consult-settings.ts');
    const { consultUserVocabularyDir } = await import('./src/core/consult-gate.ts');
    const { defaultDetachedOAuthStateDir, defaultDetachedOAuthLogDir } = await import('./src/core/connect.ts');
    const { sovereigntyPolicyPath } = await import('./src/core/zkapi-consult-settings.ts');
    delete process.env.OLYMPUS_SOVEREIGNTY_CONFIG;
    console.log(JSON.stringify([defaultPrivacyProfilePath(), defaultTierRulesPath(), defaultDropboxIngestionPolicyPath(), defaultSourceIngestionExclusionsPath(), consultSettingsPath(), consultUserVocabularyDir(), defaultDetachedOAuthStateDir(), defaultDetachedOAuthLogDir(), sovereigntyPolicyPath()]));
  `);
  const root = platform === 'linux' ? layout.configDir : join(home, '.olympus');
  expect(paths).toEqual(['privacy.json', 'tier-rules.json', 'sources/dropbox.personal.ingestion.json', 'sources/ingestion-exclusions.json', 'consult.json', 'consult/vocabulary', 'pending-oauth', 'logs', 'sovereignty.json'].map(p => join(root, p)));
},15_000);
test('dashboard privacy backend saves and reads Linux preferences in the receipt layout, including tier rules', () => {
  const { home, env, layout } = fixture();
  const result = probe(env, `
    const { createChatGptSetupBackend } = await import('./src/workers/chatgpt/setup-backend.ts');
    const backend = createChatGptSetupBackend({ sovereignty: { config: {} }, env: { ...process.env, XDG_DATA_HOME: process.env.HOME + '/drift' } });
    backend.savePrivacy({ description: 'Synthetic health preference', rules: [{ kind: 'sender', source_id: 'gmail.email', value: '@example.test' }] });
    console.log(JSON.stringify(backend.privacySettings()));
  `);
  expect(result.description).toBe('Synthetic health preference');
  expect(existsSync(join(home, '.olympus'))).toBe(false);
  for (const file of ['privacy.json', 'tier-rules.json']) expect(statSync(join(layout.configDir, file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(layout.configDir, 'privacy.json'), 'utf8')).description).toBe(result.description);
},15_000);

for (const owned of [false, true]) test(`Linux refuses unmigrated privacy settings (receipt: ${owned}) instead of silently ignoring them`, () => {
  const { home, env, layout } = fixture(); if (!owned) rmSync(layout.receiptPath);
  mkdirSync(join(home, '.olympus'), { mode: 0o700 });
  writeFileSync(join(home, '.olympus/privacy.json'), JSON.stringify({ schemaVersion: 1, description: 'synthetic', rules: [] }), { mode: 0o600 });
  const result = probe(env, `const { readPrivacyProfile } = await import('./src/workers/classification/privacy-profile.ts');
    try { readPrivacyProfile(); console.log(JSON.stringify({ refused: false })); }
    catch { console.log(JSON.stringify({ refused: true })); }`);
  expect(result.refused).toBe(owned);
  const tier = probe(env, `const { loadOwnerTierRules } = await import('./src/workers/classification/tier-rules.ts');try { loadOwnerTierRules({ allowMissing: true });console.log(false); } catch {console.log(true);}`);
  expect(tier).toBe(owned);
},15_000);

for(const hosted of [false,true])test(`unreceipted Linux ${hosted?'OpenClaw':'CLI'} preserves existing settings`,()=>{
 const {home,env,layout}=fixture();rmSync(layout.receiptPath);
 mkdirSync(join(home,'.olympus'),{mode:0o700});writeFileSync(join(home,'.olympus/privacy.json'),JSON.stringify({schemaVersion:1,description:'Synthetic existing policy',rules:[]}),{mode:0o600});
 const result=probe({...env,...(hosted?{OPENCLAW_STATE_DIR:join(home,'.openclaw')}:{})},`const {readPrivacyProfile}=await import('./src/workers/classification/privacy-profile.ts');console.log(JSON.stringify(readPrivacyProfile()));`);
 expect(result.description).toBe('Synthetic existing policy');
},15_000);

test('migrated OAuth state resolves its legacy log reference without changing stored bytes',()=>{
 const {home,env,layout}=fixture();const old=join(home,'.olympus/logs/dropbox.personal.2026-10-14T00-00-00Z.log');
 const target=join(layout.configDir,'logs',old.split('/').pop()!);mkdirSync(join(layout.configDir,'logs'),{mode:0o700});writeFileSync(target,'synthetic',{mode:0o600});
 mkdirSync(join(layout.configDir,'pending-oauth'),{mode:0o700});const path=join(layout.configDir,'pending-oauth/dropbox.personal.json');
 const text=JSON.stringify({source:'dropbox',accountRole:'personal',status:'died',startedAt:'2026-10-14T00:00:00Z',expiresAt:'2026-10-14T01:00:00Z',logPath:old});writeFileSync(path,text,{mode:0o600});
 const state=probe(env,`const {readDetachedOAuthState}=await import('./src/core/connect.ts');console.log(JSON.stringify(readDetachedOAuthState(${JSON.stringify(path)})));`);
 expect(state.logPath).toBe(target);expect(readFileSync(path,'utf8')).toBe(text);
},15_000);

test('a fresh unreceipted Linux user can read absent settings normally',()=>{
 const {home,env,layout}=fixture();rmSync(layout.receiptPath);
 const result=probe(env,`const {defaultPrivacyProfilePath,readPrivacyProfile}=await import('./src/workers/classification/privacy-profile.ts');readPrivacyProfile();console.log(JSON.stringify(defaultPrivacyProfilePath()));`);
 expect(result).toBe(join(home,'.olympus/privacy.json'));
},15_000);

for (const hosted of [false, true]) test(`unreceipted Linux ${hosted ? 'OpenClaw' : 'CLI'} blocks Private evidence after an XDG sovereignty edit`, () => {
  const { home, env, layout } = fixture(); rmSync(layout.receiptPath);
  const result = probe({ ...env, ...(hosted ? { OPENCLAW_STATE_DIR: join(home, '.openclaw') } : {}) }, `
    delete process.env.OLYMPUS_SOVEREIGNTY_CONFIG;
    const { writeSovereigntyConfigFile, defaultSovereigntyConfigPath, loadSovereigntyPreset, loadSovereigntyEngine } = await import('./src/core/sovereignty.ts');
    const { sovereigntyPolicyPath, ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, ZKAPI_RISK_ACKNOWLEDGEMENTS } = await import('./src/core/zkapi-consult-settings.ts');
    const { runOwnConsultWriter } = await import('./src/core/consult-writer.ts');
    const config = loadSovereigntyPreset('local-first');
    writeSovereigntyConfigFile({ config }); loadSovereigntyEngine();
    config.modelProfiles.synthetic = { provider: 'zkapi', trust: 'standard_cloud', purpose: 'consult', baseUrl: 'http://127.0.0.1:41074/v1', model: 'synthetic', secretRef: 'env:SYNTHETIC_KEY', zkapi: { tor: 'off', acknowledgements: { version: ZKAPI_RISK_ACKNOWLEDGEMENTS_VERSION, accepted: ZKAPI_RISK_ACKNOWLEDGEMENTS.map(x => x.id) } } };
    writeSovereigntyConfigFile({ config, force: true });
    let dispatched = 0;
    const outcome = await runOwnConsultWriter({ question: 'What should I prepare for a trip?', answer: 'The synthetic itinerary covers three days.', gaps: [], evidence: ['SYNTHETIC_PRIVATE_EVIDENCE'] }, {
      endpoint: { baseUrl: 'http://127.0.0.1:41074/v1', model: 'local-fixture' }, kill: new AbortController().signal, deadlineMs: 5000, level: 'unnamed',
      fetchImpl: async () => { dispatched++; return Response.json({ choices: [{ message: { content: '{"questions":null}' } }] }); },
    });
    console.log(JSON.stringify({ writer: defaultSovereigntyConfigPath(), guard: sovereigntyPolicyPath(), dispatched, outcome }));
  `);
  expect(result.dispatched).toBe(0);
  expect(result.outcome).toMatchObject({ kind: 'failed', reason: 'request_failed' });
  expect(result.writer).toBe(layout.sovereigntyPath);
  expect(result.guard).toBe(layout.sovereigntyPath);
}, 15_000);

for (const owned of [false, true]) test(`sovereignty readers and writers refuse unmigrated settings (receipt: ${owned})`, () => {
  const { home, env, layout } = fixture(); if (!owned) rmSync(layout.receiptPath);
  mkdirSync(join(home, '.olympus'), { mode: 0o700 });
  const legacy = join(home, '.olympus/sovereignty.json'); writeFileSync(legacy, '{}', { mode: 0o600 });
  const result = probe(env, `
    delete process.env.OLYMPUS_SOVEREIGNTY_CONFIG;
    const { defaultSovereigntyConfigPath, loadSovereigntyEngine, writeSovereigntyConfigFile, loadSovereigntyPreset } = await import('./src/core/sovereignty.ts');
    const { sovereigntyPolicyPath } = await import('./src/core/zkapi-consult-settings.ts');
    console.log(JSON.stringify([() => defaultSovereigntyConfigPath(), () => loadSovereigntyEngine(), () => writeSovereigntyConfigFile({config: loadSovereigntyPreset('local-first')}), () => sovereigntyPolicyPath()].map(run => {try {run(); return false;} catch (error) {return error.message.includes('migration');}})));
  `);
  expect(result).toEqual([true, true, true, true]);
  expect(readFileSync(legacy, 'utf8')).toBe('{}'); expect(existsSync(layout.sovereigntyPath)).toBe(false);
}, 15_000);
