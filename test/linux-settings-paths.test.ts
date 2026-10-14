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
});
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
});

for (const owned of [false, true]) test(`Linux refuses unmigrated privacy settings (receipt: ${owned}) instead of silently ignoring them`, () => {
  const { home, env, layout } = fixture(); if (!owned) rmSync(layout.receiptPath);
  mkdirSync(join(home, '.olympus'), { mode: 0o700 });
  writeFileSync(join(home, '.olympus/privacy.json'), JSON.stringify({ schemaVersion: 1, description: 'synthetic', rules: [] }), { mode: 0o600 });
  const result = probe(env, `const { readPrivacyProfile } = await import('./src/workers/classification/privacy-profile.ts');
    try { readPrivacyProfile(); console.log(JSON.stringify({ refused: false })); }
    catch { console.log(JSON.stringify({ refused: true })); }`);
  expect(result.refused).toBe(true);
  const tier = probe(env, `const { loadOwnerTierRules } = await import('./src/workers/classification/tier-rules.ts');try { loadOwnerTierRules({ allowMissing: true });console.log(false); } catch {console.log(true);}`);
  expect(tier).toBe(true);
});

test('migrated OAuth state resolves its legacy log reference without changing stored bytes',()=>{
 const {home,env,layout}=fixture();const old=join(home,'.olympus/logs/dropbox.personal.2026-10-14T00-00-00Z.log');
 const target=join(layout.configDir,'logs',old.split('/').pop()!);mkdirSync(join(layout.configDir,'logs'),{mode:0o700});writeFileSync(target,'synthetic',{mode:0o600});
 mkdirSync(join(layout.configDir,'pending-oauth'),{mode:0o700});const path=join(layout.configDir,'pending-oauth/dropbox.personal.json');
 const text=JSON.stringify({source:'dropbox',accountRole:'personal',status:'died',startedAt:'2026-10-14T00:00:00Z',expiresAt:'2026-10-14T01:00:00Z',logPath:old});writeFileSync(path,text,{mode:0o600});
 const state=probe(env,`const {readDetachedOAuthState}=await import('./src/core/connect.ts');console.log(JSON.stringify(readDetachedOAuthState(${JSON.stringify(path)})));`);
 expect(state.logPath).toBe(target);expect(readFileSync(path,'utf8')).toBe(text);
},15_000);
