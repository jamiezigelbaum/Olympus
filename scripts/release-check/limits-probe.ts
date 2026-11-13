/** Throwaway-machine setup and content-free observations. No limit handler is invoked in this process. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { workerSetupEnvPath, environmentWithWorkerSetupEnv } from '../../src/core/worker-auth.ts';
import { engineChildrenPath } from '../../src/core/engine-children.ts';
import { sharedDataPath } from '../../src/core/olympus-layout.ts';
import { writePrivateFileAtomicSync } from '../../src/core/atomic-file.ts';
import { resolveClassificationLedgerPath } from '../../src/workers/classification/tier-ledger-path.ts';
import { configureInstalledTierClassification } from '../../src/workers/classification/installed-tier-classification.ts';
import { privacyOwnerContext } from '../../src/workers/classification/privacy-profile.ts';
import './archive-live-seed-telegram.ts';
import { liveSeedHook } from './archive-live-seeds.ts';
import { FIXTURE_ITEMS } from './fixture.ts';
import { TELEGRAM_BESIDE_LIVE } from './archive-fixtures.ts';
import { defaultTelegramCaptureSpoolDir } from '../../src/workers/telegram-messages/index.ts';
import { liveSpoolLine } from '../../test/support/telegram-spool-fixtures.ts';

/** The step a failure is reported against: a fixed name, never machine output, paths or item text. */
let step = 'input';
const at = (name: string) => { step = name; };
function cli(...args: string[]): any {
  const result = Bun.spawnSync([join(homedir(), '.local/bin/olympus'), ...args], { timeout: 180_000 });
  if (result.exitCode !== 0) { step += result.exitCode === null ? ' (CLI timed out)' : ` (CLI exit ${result.exitCode})`; throw new Error('installed CLI failed'); }
  const value = JSON.parse(result.stdout.toString());
  if (value.ok === false) throw new Error('installed CLI refused the operation');
  return value;
}
interface Saved { envPath: string; hadEnv: boolean; limitLines: string[]; settingsPath: string; settings: string | null; pause: string }
const limitLine = (line: string) => /^\s*(?:export\s+)?OLYMPUS_(?:TIER_SNIFFER_MAX_CALLS_PER_DAY|VENICE_CREDIT_STATUS_PROVIDER_PAUSE_FILE)\s*=/.test(line);
function text(path: string): string | null { return existsSync(path) ? readFileSync(path, 'utf8') : null; }
function restoreFile(path: string, value: string | null) {
  if (value === null) rmSync(path, { force: true });
  else writePrivateFileAtomicSync(path, value);
}
async function probe(command: string, scratch: string): Promise<unknown> {
  const savedPath = join(scratch, 'saved.json');
  if (command === 'prepare') {
    at('prepare.scratch'); mkdirSync(scratch, { mode: 0o700 });
    at('prepare.engine-status'); const status = cli('engine', 'status');
    at('prepare.config'); const config = JSON.parse(readFileSync(status.config.path, 'utf8'));
    const env = environmentWithWorkerSetupEnv({ env: process.env });
    at('prepare.pause-marker');
    const pause = config.worker?.creditMonitor?.pauseFile ?? env.OLYMPUS_VENICE_CREDIT_STATUS_PROVIDER_PAUSE_FILE ?? join(scratch, 'pause.json');
    if (existsSync(pause)) throw new Error('a provider marker already exists');
    if (/[\p{Cc}']/u.test(pause)) throw new Error('pause path cannot be stored in the managed environment');
    at('prepare.worker-env'); const envPath = workerSetupEnvPath();
    const settingsPath = sharedDataPath('limit-settings', env);
    const current = text(envPath);
    const lines = (current ?? '').split('\n');
    // Keep only the two nonsecret settings in scratch, never a copy of worker.env's credentials.
    const saved: Saved = { envPath, hadEnv: current !== null, limitLines: lines.filter(limitLine), settingsPath, settings: text(settingsPath), pause };
    writeFileSync(savedPath, JSON.stringify(saved), { mode: 0o600 });
    const kept = lines.filter(line => !limitLine(line));
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(envPath, `${kept.join('\n')}\nOLYMPUS_TIER_SNIFFER_MAX_CALLS_PER_DAY=1\nOLYMPUS_VENICE_CREDIT_STATUS_PROVIDER_PAUSE_FILE='${pause}'\n`);
    // Preserve an earlier owner setting for cleanup; the leg must exercise the environment cap of 1.
    rmSync(settingsPath, { force: true });
    return { ok: true };
  }
  if (command === 'restore') {
    at('restore');
    if (!existsSync(savedPath)) { rmSync(scratch, { recursive: true, force: true }); return { ok: true }; }
    const saved: Saved = JSON.parse(readFileSync(savedPath, 'utf8'));
    rmSync(saved.pause, { force: true });
    const kept = (text(saved.envPath) ?? '').split('\n').filter(line => !limitLine(line));
    restoreFile(saved.envPath, !saved.hadEnv && !kept.some(line => line.trim()) ? null : [...kept, ...saved.limitLines].join('\n'));
    restoreFile(saved.settingsPath, saved.settings);
    // Restoration is outside the no-restart observation interval. Keep the receipt if restart fails.
    at('restore.restart'); cli('engine', 'restart', '--now');
    rmSync(scratch, { recursive: true, force: true });
    return { ok: true };
  }
  at(`${command}.saved`); const saved: Saved = JSON.parse(readFileSync(savedPath, 'utf8'));
  const env = environmentWithWorkerSetupEnv({ env: process.env });
  if (command === 'seed') {
    at('seed.spool');
    // New identities and materials prevent an earlier archive leg's cached judgments satisfying this proof.
    const items = FIXTURE_ITEMS.filter(item => item.tier === 'personal');
    const spool = defaultTelegramCaptureSpoolDir(env);
    mkdirSync(spool, { recursive: true, mode: 0o700 });
    appendFileSync(join(spool, '2024-04-02.jsonl'), items.map((item, index) => liveSpoolLine({
      chat: `-${TELEGRAM_BESIDE_LIVE.chatId}`, id: String(Date.now() + index), sentAt: '2024-04-02T12:00:00Z',
      text: `${item.document.summary} Synthetic planning note ${crypto.randomUUID()}.`,
      chatTitle: TELEGRAM_BESIDE_LIVE.chatName,
    })).join(''), { mode: 0o600 });
    // The existing hook registers the synthetic account and pulls through the thin connector and shared intake.
    // The running engine reads the same spool and may store these lines before the hook's pull does, and the hook's own
    // lines are already stored when an earlier stage seeded, so its count is not the proof. A pull that fails is: its
    // cause goes to the report. The judge stop appearing next is what shows the fresh lines reached intake.
    at('seed.classification'); const classification = configureInstalledTierClassification({ env, retirePublic: true, ownerContext: () => privacyOwnerContext({ env }) });
    try {
      at('seed.intake'); await liveSeedHook('telegram').seed({ env, home: homedir() });
    }
    finally { classification.close(); }
    at('seed.restart'); cli('engine', 'restart', '--now');
    return { count: items.length };
  }
  if (command === 'snapshot') {
    at('snapshot.engine-status'); const status = cli('engine', 'status');
    at('snapshot.engine-children'); const children = JSON.parse(readFileSync(engineChildrenPath(env), 'utf8'));
    const workerPids = children.children.filter((child: { service: string }) => /^olympus-worker(?:-background)?$/.test(child.service))
      .map((child: { pgid: number }) => child.pgid).sort((a: number, b: number) => a - b);
    at('snapshot.judge-counter'); const budget = text(join(dirname(resolveClassificationLedgerPath(env)), 'tier-sniffer-budget.json'));
    const calls = budget ? JSON.parse(budget).used : 0;
    if (!Number.isSafeInteger(calls) || calls < 0) throw new Error('judge counter unavailable');
    const healthy = status.ok === true && status.engine?.state === 'running'
      && Object.entries(status.engine.services ?? {}).filter(([name]) => /^olympus-worker(?:-background)?$/.test(name))
        .every(([, service]) => (service as { state: string }).state === 'ok');
    return { pid: healthy ? status.engine.pid : 0, workerPids, calls };
  }
  if (command === 'credential') {
    at('credential');
    const config = JSON.parse(readFileSync(cli('engine', 'status').config.path, 'utf8'));
    const values = { ...env, ...config.worker?.creditMonitor?.credentials };
    return { present: ['OLYMPUS_SOURCE_INDEX_VENICE_API_KEY', 'OLYMPUS_VENICE_API_KEY', 'VENICE_API_KEY', 'API_KEY_VENICE'].some(key =>
      typeof values[key] === 'string' ? values[key].trim().length > 0 : values[key] !== undefined && values[key] !== null) };
  }
  at(command);
  if (command === 'marker-write') {
    if (existsSync(saved.pause)) throw new Error('refusing to overwrite a provider marker');
    mkdirSync(dirname(saved.pause), { recursive: true, mode: 0o700 });
    writeFileSync(saved.pause, JSON.stringify({ active: true, kind: 'venice', reason: 'provider_credit_exhausted',
      error_kind: 'venice_billing_credit_exhausted', created_at: new Date().toISOString(),
      message: 'Venice escalation paused because billing/balance.canConsume is false. Refill Venice credits; Olympus re-checks automatically within 15 minutes, or use olympus limits continue venice.credit.' }), { mode: 0o600, flag: 'wx' });
  } else if (command === 'marker-remove') rmSync(saved.pause, { force: true });
  else if (command !== 'marker-exists') throw new Error('unknown limits probe command');
  return { exists: existsSync(saved.pause) };
}
if (import.meta.main) {
  try { const input = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(await probe(input.command, input.scratch))); }
  // Only the fixed step name leaves the machine, so the report says where setup stopped without machine output.
  catch (error) {
    // The cause comes from a throwaway machine with synthetic items only; the adapter scrubs paths and cuts it short.
    console.log(JSON.stringify({ failed: step, why: error instanceof Error ? error.message : String(error) })); process.exit(1);
  }
}
