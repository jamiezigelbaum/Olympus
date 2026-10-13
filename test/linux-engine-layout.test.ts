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
import { resolveRemoteConnectionsDbPath, resolveRemoteConnectionsDbPathForCli } from '../src/core/remote-connections.ts';
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
  expect(layout.lifecycleLockPath).toBe(join(env.XDG_RUNTIME_DIR,'olympus/lifecycle.lock'));
  expect(layout.launcherPath).toBe(join(home,'.local/bin/olympus'));
  expect(engineServicePaths({ homeDir: home, platform: 'linux', env }).configPath).toBe(layout.configPath);
  expect(workerSetupEnvPath({ env })).toBe(join(home, 'cfg/olympus/worker.env'));
  expect(defaultOlympusConfigDir(env, 'linux')).toBe(layout.configDir);
  expect(defaultSovereigntyConfigPath(env)).toBe(layout.sovereigntyPath);
  expect(workerServicePaths('linux', home, env).envPath).toBe(layout.workerEnvPath);
  expect(layout.dataDir).toBe(join(home, 'data/olympus'));
  expect(olympusDataDir({ ...env, OLYMPUS_ENGINE_HOST: '1' })).toBe(layout.dataDir);
  publishLinuxEngineReceipt(layout);
  expect(statSync(layout.receiptPath).mode & 0o777).toBe(0o600);
  expect(resolveLinuxEngineLayout({ ...env, XDG_DATA_HOME: join(home, 'wrong') }).dataDir).toBe(layout.dataDir);
  expect(JSON.parse(readFileSync(layout.receiptPath, 'utf8')).schema).toBe('olympus.engine.install.v1');
  expect(JSON.parse(readFileSync(layout.receiptPath,'utf8')).installationState).toBe('installed');
});
test('a retained-data uninstall receipt cannot be adopted as a fresh installation',()=>{
 const {env}=fixture();const layout=resolveLinuxEngineLayout(env);const receipt=publishLinuxEngineReceipt(layout);
 writeFileSync(layout.receiptPath,`${JSON.stringify({...receipt,installationState:'data_retained',ownedUnitLinks:[],machineArtifacts:[]})}\n`,{mode:0o600});
 expect(()=>preflightLinuxEngineLayout(layout)).toThrow('--purge --yes');
});
test('receipt layout key order is irrelevant to shell-written canonical JSON',()=>{
 const {env}=fixture();const layout=resolveLinuxEngineLayout(env),receipt=publishLinuxEngineReceipt(layout);
 const shuffled=Object.fromEntries(Object.entries(receipt.layout).reverse());writeFileSync(layout.receiptPath,`${JSON.stringify({...receipt,layout:shuffled})}\n`,{mode:0o600});
 expect(resolveLinuxEngineLayout(env)).toEqual(layout);
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
test('overlapping managed XDG roots refuse before any install mutation',()=>{
 const {home,env}=fixture();
 expect(()=>resolveLinuxEngineLayout({...env,XDG_CONFIG_HOME:join(home,'data/olympus/config')})).toThrow('must not overlap');
 expect(()=>resolveLinuxEngineLayout({...env,XDG_STATE_HOME:env.XDG_DATA_HOME})).toThrow('must not overlap');
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

test('a legacy standalone receipt keeps its data root even when empty or XDG has data', () => {
  const { home, env } = fixture();
  const layout = resolveLinuxEngineLayout(env);
  const receipt = publishLinuxEngineReceipt(layout);
  const legacy = join(env.XDG_DATA_HOME, 'openclaw/olympus');
  const old = { ...receipt, layout: { ...layout, dataDir: legacy, packageDir: join(env.XDG_DATA_HOME, 'olympus/engine') } };
  writeFileSync(layout.receiptPath, JSON.stringify(old), { mode: 0o600 });
  expect(resolveLinuxEngineLayout(env).dataDir).toBe(legacy);
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy, 'retained.sqlite'), 'existing data');
  mkdirSync(layout.dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(layout.dataDir, 'unrelated'), 'keep');
  expect(olympusDataDir(env)).toBe(legacy);
  expect(readFileSync(join(legacy, 'retained.sqlite'), 'utf8')).toBe('existing data');
});
test('standalone discovery uses nonempty legacy data in place, including before an XDG override', () => {
  const { home, env } = fixture();
  const legacy = join(home, '.local/share/openclaw/olympus');
  mkdirSync(legacy, { recursive: true, mode: 0o700 });
  writeFileSync(join(legacy, 'existing.sqlite'), 'keep');
  expect(resolveLinuxEngineLayout(env).dataDir).toBe(legacy);
});
test('uninstalled and explicitly OpenClaw-hosted data paths keep the historical layout', () => {
  const { env } = fixture();
  expect(olympusDataDir(env)).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus'));
  publishLinuxEngineReceipt(resolveLinuxEngineLayout(env));
  expect(olympusDataDir({ ...env, OPENCLAW_STATE_DIR: '/openclaw-host' })).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus'));
});

test('default OpenClaw config keeps hosted stores on the legacy namespace beside an engine receipt', () => {
  const { home, env } = fixture();
  const layout = resolveLinuxEngineLayout(env); publishLinuxEngineReceipt(layout);
  mkdirSync(join(home, '.openclaw'), { mode: 0o700 });
  writeFileSync(join(home, '.openclaw/openclaw.json'), JSON.stringify({ plugins: { entries: { olympus: { enabled: true } } } }));
  expect(olympusDataDir(env)).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus'));
  expect(olympusDataDir({ ...env, OLYMPUS_ENGINE_HOST: '1' })).toBe(layout.dataDir);
});
for (const config of ['enabled', 'unreadable', 'malformed'] as const) {
  test(`standalone CLI uses the daemon receipt with ${config} OpenClaw config`, () => {
    const { home, env } = fixture();
    const layout = resolveLinuxEngineLayout(env);
    publishLinuxEngineReceipt(layout);
    mkdirSync(join(home, '.openclaw'), { mode: 0o700 });
    const configPath = join(home, '.openclaw/openclaw.json');
    // EISDIR is a deterministic read failure even when the test runner is root.
    if (config === 'unreadable') mkdirSync(configPath);
    else writeFileSync(configPath, config === 'malformed' ? '{broken' : JSON.stringify({ plugins: { entries: { olympus: { enabled: true } } } }));
    const driftedEnv = { ...env, XDG_DATA_HOME: join(home, 'other-data') };
    const expected = join(env.XDG_DATA_HOME, 'olympus');
    expect(olympusDataDir({ ...driftedEnv, OLYMPUS_ENGINE_HOST: '1' })).toBe(expected);
    expect(resolveRemoteConnectionsDbPath({ ...driftedEnv, OLYMPUS_ENGINE_HOST: '1' })).toBe(join(expected, 'remote-connections.sqlite'));
    // No standalone marker: genuine hosted processes still use their namespace.
    expect(olympusDataDir(env)).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus'));
    expect(resolveRemoteConnectionsDbPath(env)).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus/remote-connections.sqlite'));
    expect(resolveRemoteConnectionsDbPathForCli({ ...driftedEnv, OLYMPUS_STANDALONE: '1' })).toBe(join(expected, 'remote-connections.sqlite'));
    expect(olympusDataDir({ ...driftedEnv, OLYMPUS_STANDALONE: '1' })).toBe(expected);
    expect(olympusDataDir({ ...driftedEnv, OLYMPUS_STANDALONE: '1', OPENCLAW_CONFIG_PATH: configPath })).toBe(expected);
  });
}
test('standalone markers do not change Mac data or connection paths', () => {
  const { env } = fixture();
  publishLinuxEngineReceipt(resolveLinuxEngineLayout(env));
  const probe = Bun.spawnSync([process.execPath, '--eval', `
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { olympusDataDir } = await import('./src/core/remote-access.ts');
    const { resolveRemoteConnectionsDbPath, resolveRemoteConnectionsDbPathForCli } = await import('./src/core/remote-connections.ts');
    console.log(JSON.stringify([olympusDataDir(), resolveRemoteConnectionsDbPath(), resolveRemoteConnectionsDbPathForCli()]));
  `], { env: { ...env, OLYMPUS_STANDALONE: '1', OLYMPUS_ENGINE_HOST: '1' }, stdout: 'pipe', stderr: 'pipe' });
  expect(probe.exitCode).toBe(0);
  const dataDir = join(env.XDG_DATA_HOME, 'openclaw/olympus');
  expect(JSON.parse(probe.stdout.toString())).toEqual([dataDir, join(dataDir, 'remote-connections.sqlite'), join(dataDir, 'remote-connections.sqlite')]);
}, 15_000);
test('receipt discovery validates the recorded legacy layout before considering fresh-root overlap', () => {
  const { env } = fixture();
  const layout = resolveLinuxEngineLayout(env), receipt = publishLinuxEngineReceipt(layout);
  rmSync(layout.receiptPath);
  const configHome = join(env.XDG_DATA_HOME, 'olympus/settings');
  const oldLayout = Object.fromEntries(Object.entries(layout).map(([key, value]) => [key, value.startsWith(layout.configHome) ? configHome + value.slice(layout.configHome.length) : value]));
  oldLayout.dataDir = join(env.XDG_DATA_HOME, 'openclaw/olympus');
  oldLayout.packageDir = join(env.XDG_DATA_HOME, 'olympus/engine');
  mkdirSync(oldLayout.configDir!, { recursive: true, mode: 0o700 });
  writeFileSync(oldLayout.receiptPath!, JSON.stringify({ ...receipt, layout: oldLayout }), { mode: 0o600 });
  expect(resolveLinuxEngineLayout({ ...env, XDG_CONFIG_HOME: configHome }).dataDir).toBe(oldLayout.dataDir!);
});
test('an owned install re-checked after its engine wrote status is not refused as legacy data', () => {
  // Default XDG data home: the engine's status directory is <data>/olympus/engine,
  // which is also where a pre-XDG package directory used to live.
  const { home, env } = fixture(); const xdg = { ...env, XDG_DATA_HOME: join(home, '.local/share') };
  const layout = resolveLinuxEngineLayout(xdg);
  const engineDir = join(layout.dataDir, 'engine');
  mkdirSync(engineDir, { recursive: true, mode: 0o700 }); writeFileSync(join(engineDir, 'status.json'), '{}', { mode: 0o600 });
  // Without a receipt the same directory is someone else's data: refuse.
  expect(() => preflightLinuxEngineLayout(resolveLinuxEngineLayout(xdg))).toThrow(engineDir);
  rmSync(engineDir, { recursive: true });
  publishLinuxEngineReceipt(layout);
  mkdirSync(engineDir, { recursive: true, mode: 0o700 }); writeFileSync(join(engineDir, 'status.json'), '{}', { mode: 0o600 });
  expect(() => preflightLinuxEngineLayout(resolveLinuxEngineLayout(xdg))).not.toThrow();
});
