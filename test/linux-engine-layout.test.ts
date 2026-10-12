import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveLinuxEngineLayout, publishLinuxEngineReceipt, preflightLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { defaultOlympusConfigDir } from '../src/core/secret-store.ts';
import { defaultSovereigntyConfigPath } from '../src/core/sovereignty.ts';
import { workerSetupEnvPath } from '../src/core/worker-auth.ts';
import { workerServicePaths } from '../src/core/worker-service.ts';
import { olympusDataDir } from '../src/core/remote-access.ts';
import { enginePaths, engineServicePaths, renderEnginePlist } from '../src/core/engine-service.ts';
const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'svc-layout-')); roots.push(home);
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, 'cfg'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache'), XDG_RUNTIME_DIR: join(home, 'run') };
  mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
  return { home, env };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('XDG roots reach worker, data, engine and receipt; shell overrides cannot move an installed layout', () => {
  const { home, env } = fixture();
  const layout = resolveLinuxEngineLayout(env);
  expect(engineServicePaths({ homeDir: home, platform: 'linux', env }).configPath).toBe(layout.configPath);
  expect(workerSetupEnvPath({ env })).toBe(join(home, 'cfg/olympus/worker.env'));
  expect(defaultOlympusConfigDir(env, 'linux')).toBe(layout.configDir);
  expect(defaultSovereigntyConfigPath(env)).toBe(layout.sovereigntyPath);
  expect(workerServicePaths('linux', home, env).envPath).toBe(layout.workerEnvPath);
  expect(olympusDataDir(env)).toBe(join(home, 'data/openclaw/olympus'));
  publishLinuxEngineReceipt(layout);
  expect(statSync(layout.receiptPath).mode & 0o777).toBe(0o600);
  expect(resolveLinuxEngineLayout({ ...env, XDG_DATA_HOME: join(home, 'wrong') }).dataDir).toBe(layout.dataDir);
  expect(JSON.parse(readFileSync(layout.receiptPath, 'utf8')).schema).toBe('olympus.engine.install.v1');
});
test('legacy data refuses before writes and names exact path and fresh-install remedy', () => {
  const { home, env } = fixture(); const legacy = join(home, '.olympus'); mkdirSync(legacy, { mode: 0o700 }); writeFileSync(join(legacy, 'sovereignty.json'), '{}');
  expect(() => publishLinuxEngineReceipt(resolveLinuxEngineLayout(env))).toThrow(legacy);
  expect(() => publishLinuxEngineReceipt(resolveLinuxEngineLayout(env))).toThrow('back up and move');
  expect(existsSync(env.XDG_CONFIG_HOME)).toBe(false);
});
test('symlink, unsafe runtime, relative root and foreign owner refuse without changing files', () => {
  const { home, env } = fixture(); mkdirSync(join(home, 'target')); symlinkSync(join(home, 'target'), env.XDG_CONFIG_HOME);
  expect(() => publishLinuxEngineReceipt(resolveLinuxEngineLayout(env))).toThrow('symbolic link');
  expect(existsSync(join(home, 'target/olympus'))).toBe(false);
  rmSync(env.XDG_CONFIG_HOME); chmodSync(env.XDG_RUNTIME_DIR, 0o755);
  expect(() => preflightLinuxEngineLayout(resolveLinuxEngineLayout(env))).toThrow('private');
  expect(() => resolveLinuxEngineLayout({ ...env, XDG_DATA_HOME: 'relative' })).toThrow('absolute');
  expect(() => preflightLinuxEngineLayout(resolveLinuxEngineLayout(env), { uid: 123456 })).toThrow('owner');
});
test('two discoverable receipts refuse instead of picking an installation', () => {
  const { home, env } = fixture(); const layout = resolveLinuxEngineLayout(env); publishLinuxEngineReceipt(layout);
  const defaultDir = join(home, '.config/olympus'); mkdirSync(defaultDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(defaultDir, 'install-receipt.json'), readFileSync(layout.receiptPath), { mode: 0o600 });
  expect(() => resolveLinuxEngineLayout(env)).toThrow('multiple');
});
test('Mac path and plist bytes are independent of XDG roots', () => {
  const paths = enginePaths('/Users/example');
  expect(paths.configPath).toBe('/Users/example/.olympus/engine.json');
  const input = { paths, homeDir: '/Users/example', program: { runtimePath: '/opt/bun', entryPath: '/opt/app/dist/cli.js', workingDirectory: '/opt/app', source: 'package' as const, build: '1+abc' } };
  expect(renderEnginePlist(input)).toBe(readFileSync(new URL('./fixtures/engine-mac.plist', import.meta.url), 'utf8'));
});
test('an existing same-path engine unit without a receipt is not adopted',()=>{
 const {env}=fixture(); const l=resolveLinuxEngineLayout(env);mkdirSync(join(l.configHome,'systemd/user'),{recursive:true,mode:0o700});writeFileSync(l.unitPath,'owner unit',{mode:0o600});
 expect(()=>publishLinuxEngineReceipt(l)).toThrow(l.unitPath); expect(readFileSync(l.unitPath,'utf8')).toBe('owner unit');expect(existsSync(l.receiptPath)).toBe(false);
});

test('matching receipt permits its verified default-root manager link, but never a replacement',()=>{
 const {home,env}=fixture();const l=resolveLinuxEngineLayout(env);publishLinuxEngineReceipt(l);mkdirSync(join(l.configHome,'systemd/user'),{recursive:true,mode:0o700});writeFileSync(l.unitPath,'owned',{mode:0o600});
 const defaultDir=join(home,'.config/systemd/user');mkdirSync(defaultDir,{recursive:true,mode:0o700});const link=join(defaultDir,'olympus-engine.service');symlinkSync(l.unitPath,link);
 expect(()=>preflightLinuxEngineLayout(l)).not.toThrow();rmSync(link);symlinkSync('/unowned/unit',link);expect(()=>preflightLinuxEngineLayout(l)).toThrow('Existing Olympus');
});
