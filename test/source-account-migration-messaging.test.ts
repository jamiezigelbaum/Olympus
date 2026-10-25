// The boot migration of existing Telegram and WhatsApp accounts into their folders
// (docs/design/source-storage.md, delivery step 4d). Everything runs on a throwaway
// home: real SQLite stores and sessions, real capture folders at the capture root
// (`<XDG data home>/olympus`) and the state root (`<XDG state home>/olympus`), a
// real capture grant beside the handle registry, and an in-memory secret store.
// Expected places are written from the design's layout (docs/design/source-storage.md,
// "Layout" and step 4b), not read back from the resolvers under test.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { tryHoldFileFlock, type HeldFileFlock } from '../src/core/data-owner-lock.ts';
import { withFileLease } from '../src/core/file-lease.ts';
import { messagingMoveFacts, repointMovedMessagingAccounts } from '../src/core/messaging-account-move.ts';
import { MessagingCaptureSupervisor, type CaptureChild } from '../src/core/messaging-capture.ts';
import { olympusDataRoot } from '../src/core/olympus-layout.ts';
import { settlePairingPlacement } from '../src/core/pairing-placement.ts';
import { accountMovePending, placedAccount, whatsappMovedPathMapper } from '../src/core/source-placement.ts';
import {
  AccountMigrationKilled,
  MIGRATE_ACCOUNT_FOLDERS_ENV,
  __accountMigrationTestHooks,
  migrateAccountFolders,
  type AccountMigrationOptions,
  type MigrationLook,
} from '../src/core/source-account-migration.ts';
import { readSourceRegistry, sourceAccountMovePending, sourceRegistryPath, updateSourceRegistry, type SourceRegistryAccount } from '../src/core/source-registry.ts';
import { CAPTURE_CLAIM_RECLAIM_AGE_MS, SourceStorageUnavailableError, __sourceStorageTestHooks, reclaimEmptyCaptureClaims, replaceEmptyLegacyAccounts } from '../src/core/source-storage.ts';
import type { SecretStore } from '../src/core/secret-store.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { WhatsAppExtractionSource } from '../src/workers/whatsapp/extraction-source.ts';
import { moveAccountsAtBoot } from '../src/workers/email-source/server.ts';

type Env = Record<string, string>;

const TELEGRAM = 'telegram.messages';
const WHATSAPP = 'whatsapp.personal.messages';

const dirs: string[] = [];
const locks: HeldFileFlock[] = [];
afterEach(() => {
  __accountMigrationTestHooks.reset();
  __sourceStorageTestHooks.disableAdoption();
  for (const lock of locks.splice(0)) lock.release();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Home {
  env: Env;
  home: string;
  data: string;
  capture: string;
  state: string;
}

function fixture(extra: (dir: string, home: string) => Env = () => ({})): Home {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-messaging-migration-'));
  dirs.push(dir);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const env: Env = {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    PATH: process.env.PATH ?? '',
    [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1',
  };
  Object.assign(env, extra(dir, home));
  // The design's roots (docs/design/source-storage.md, "Layout"): data under openclaw/olympus, capture beside it.
  const data = olympusDataRoot(env);
  return { env, home, data, capture: join(env.XDG_DATA_HOME!, 'olympus'), state: join(env.XDG_STATE_HOME!, 'olympus') };
}

const folder = (h: Home, sourceId: string): string => join(h.data, 'sources', sourceId, '1');

/** Where Telegram's stores have always been: the Linux receipt's data folder, else under the home whatever XDG_DATA_HOME says (design, step 1). */
const telegramStoreRoot = (h: Home): string => (process.platform === 'linux' && h.env.OLYMPUS_STANDALONE === '1'
  ? h.data
  : join(h.home, '.local', 'share', 'openclaw', 'olympus'));

function sqlite(path: string, rows = 3, wal = true): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  if (wal) db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (v TEXT)');
  for (let index = 0; index < rows; index += 1) db.query('INSERT INTO t VALUES (?)').run(`${basename(path)}-${index}`);
  if (wal) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

const inode = (path: string): string => {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

function grantPath(h: Home, source: 'telegram' | 'whatsapp'): string {
  return join(h.home, '.config', 'olympus', `messaging-capture.${source}.json`);
}

function writeGrant(h: Home, source: 'telegram' | 'whatsapp', sessionPath: string, extraEnv: Env = {}): void {
  const path = grantPath(h, source);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const env = source === 'telegram'
    ? { OLYMPUS_TELEGRAM_SESSION_PATH: sessionPath, OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT: 'telegram.personal', ...extraEnv }
    : { OLYMPUS_WHATSAPP_STATE_DIR: sessionPath, OLYMPUS_WHATSAPP_QR_STDOUT: 'false', ...extraEnv };
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    source,
    handle: source === 'telegram' ? 'telegram.personal' : 'whatsapp.personal_local',
    sessionPath,
    producer: { source, env, secretEnvironment: [] },
    grantedAt: '2026-10-01T00:00:00.000Z',
  }, null, 2)}\n`, { mode: 0o600 });
}

function memorySecretStore(values: Record<string, string> = {}): SecretStore & { values: Map<string, string> } {
  const stored = new Map(Object.entries(values));
  return {
    label: 'memory',
    values: stored,
    get: async (key) => stored.get(key),
    set: async (key, value) => { stored.set(key, value); },
    delete: async (key) => { stored.delete(key); },
    list: async () => [...stored.keys()],
  };
}

function recordLegacy(h: Home, sourceId: string, corpusIds: string[]): void {
  updateSourceRegistry(h.env, (registry) => {
    registry.accounts.push({ source_id: sourceId, slot: '1', state: 'active', layout: 'legacy', corpus_ids: corpusIds, created_at: '2026-10-01T00:00:00.000Z' });
  });
}

const entryOf = (h: Home, sourceId: string): SourceRegistryAccount | undefined =>
  readSourceRegistry(h.env).accounts.find((account) => account.source_id === sourceId);

/** A Telegram account as pairing and capture have always left it: what each file is, where it is, and where the design puts it. */
function telegramInstall(h: Home): Array<{ from: string; to: string }> {
  const base = join(h.capture, 'telegram', 'telegram.personal');
  const files = [
    { from: join(telegramStoreRoot(h), 'telegram-internal-connector-store.sqlite'), to: join(folder(h, TELEGRAM), 'stores', 'internal.sqlite') },
    { from: join(telegramStoreRoot(h), 'telegram-protected-connector-store.sqlite'), to: join(folder(h, TELEGRAM), 'stores', 'secure_local.sqlite') },
    { from: `${base}.session`, to: join(folder(h, TELEGRAM), 'session', 'telegram.session') },
    { from: `${base}.pairing.lock.db`, to: join(folder(h, TELEGRAM), 'session', 'telegram.pairing.lock.db') },
    { from: `${base}.pairing-4242-0a1b2c3d.session`, to: join(folder(h, TELEGRAM), 'session', 'telegram.pairing-4242-0a1b2c3d.session') },
    { from: join(h.state, 'telegram-capture-gateway'), to: join(folder(h, TELEGRAM), 'raw', 'telegram-gateway') },
    { from: join(h.capture, 'telegram-capture', 'spool'), to: join(folder(h, TELEGRAM), 'raw', 'telegram-spool') },
    { from: join(h.state, 'telegram-spool-drain'), to: join(folder(h, TELEGRAM), 'raw', 'telegram-spool-drain') },
  ];
  sqlite(files[0]!.from);
  sqlite(files[1]!.from);
  sqlite(tierLedgerPathForStore(files[1]!.from), 2);
  files.push({ from: tierLedgerPathForStore(files[1]!.from), to: tierLedgerPathForStore(files[1]!.to) });
  sqlite(files[2]!.from, 1, false);
  sqlite(files[3]!.from, 0, false);
  put(files[4]!.from, 'a login a killed pairing left aside');
  put(join(files[5]!.from, 'state.json'), '{"cursor":41}');
  put(join(files[5]!.from, 'gateway.lock'), '');
  put(join(files[6]!.from, '2026-10-24.jsonl'), '{"id":1}\n');
  put(join(files[7]!.from, 'cursor.json'), '{"line":12}');
  recordLegacy(h, TELEGRAM, ['internal.telegram.messages', 'secure_local.telegram.messages']);
  writeGrant(h, 'telegram', base);
  return files;
}

/** A WhatsApp account as the bridge has always left it. */
function whatsappInstall(h: Home): { files: Array<{ from: string; to: string }>; audio: string } {
  const state = join(h.capture, 'whatsapp-live');
  const files = [
    { from: join(state, 'connector-store.db'), to: join(folder(h, WHATSAPP), 'stores', 'secure_local.sqlite') },
    { from: join(state, 'connector-store-internal.db'), to: join(folder(h, WHATSAPP), 'stores', 'internal.sqlite') },
    { from: state, to: join(folder(h, WHATSAPP), 'raw', 'whatsapp') },
  ];
  sqlite(files[0]!.from);
  sqlite(files[1]!.from);
  sqlite(join(state, 'session.db'), 2, false);
  const audio = put(join(state, 'media', 'audio', 'voice-0011aabbccddeeff.ogg'), 'OggS voice');
  put(join(state, 'spool', '2026-10-24.jsonl'), `${JSON.stringify({ id: 'M1', chat_jid: 'a@s.whatsapp.net', media_path: audio })}\n`);
  put(join(state, 'qr.txt'), 'old qr');
  recordLegacy(h, WHATSAPP, ['internal.whatsapp.personal.messages', 'secure_local.whatsapp.personal.messages']);
  writeGrant(h, 'whatsapp', state);
  return { files, audio };
}

async function boot(h: Home, store: SecretStore, env: Env = h.env): Promise<ReturnType<typeof migrateAccountFolders>> {
  const facts = await messagingMoveFacts(env, store);
  return migrateAccountFolders(env, { messaging: facts });
}

// ---------------------------------------------------------------------------

describe('a Telegram account moves into its folder', () => {
  test('every file is renamed to the place the design gives it, the old folders go, and the registry names no home folder', async () => {
    const h = fixture();
    const files = telegramInstall(h);
    const before = new Map(files.map(({ from }) => [from, inode(from)]));
    const store = memorySecretStore({ 'telegram.personal.session_path': join(h.capture, 'telegram', 'telegram.personal') });

    const report = await boot(h, store);

    expect(report.moved, JSON.stringify(report)).toEqual([TELEGRAM]);
    for (const { from, to } of files) {
      expect(existsSync(from), from).toBe(false);
      expect(inode(to), to).toBe(before.get(from)!);
    }
    // What was inside the folders moved with them, and the old capture folders are gone.
    expect(readFileSync(join(folder(h, TELEGRAM), 'raw', 'telegram-gateway', 'state.json'), 'utf8')).toBe('{"cursor":41}');
    expect(existsSync(join(h.capture, 'telegram'))).toBe(false);
    expect(existsSync(join(h.capture, 'telegram-capture'))).toBe(false);
    const entry = entryOf(h, TELEGRAM)!;
    expect(entry.layout).toBe('folder');
    expect(entry.migration?.state).toBe('done');
    expect(readFileSync(sourceRegistryPath(h.env), 'utf8')).not.toContain(h.home);
    expect(placedAccount(TELEGRAM, h.env).layout).toBe('folder');
  });

  test('after the move the grant and the stored session path name the folder, as a folder pairing writes them', async () => {
    const h = fixture();
    telegramInstall(h);
    const legacy = join(h.capture, 'telegram', 'telegram.personal');
    const store = memorySecretStore({ 'telegram.personal.session_path': legacy, 'telegram.personal.app.api_id': '12' });
    await boot(h, store);

    const report = await repointMovedMessagingAccounts(h.env, store);

    expect(report.errors).toEqual([]);
    const grant = JSON.parse(readFileSync(grantPath(h, 'telegram'), 'utf8'));
    expect(grant.sessionPath).toBeUndefined();
    expect(grant.producer.env.OLYMPUS_TELEGRAM_SESSION_PATH).toBeUndefined();
    expect(grant.producer.env.OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT).toBe('telegram.personal');
    expect((lstatSync(grantPath(h, 'telegram')).mode & 0o077)).toBe(0);
    expect(store.values.get('telegram.personal.session_path')).toBe(join(folder(h, TELEGRAM), 'session', 'telegram'));
    expect(store.values.get('telegram.personal.app.api_id')).toBe('12');
    // Nothing anywhere still names the old place, and a second boot changes nothing.
    expect(readFileSync(grantPath(h, 'telegram'), 'utf8')).not.toContain(legacy);
    expect((await repointMovedMessagingAccounts(h.env, store)).rewritten).toEqual([]);
  });

  test('the capture child of the moved account is started on the folder\'s paths', async () => {
    const h = fixture();
    telegramInstall(h);
    const store = memorySecretStore({ 'telegram.personal.session_path': join(h.capture, 'telegram', 'telegram.personal') });
    await boot(h, store);
    await repointMovedMessagingAccounts(h.env, store);
    writeHandle(h, 'telegram');
    const seen: Array<Record<string, string>> = [];
    const supervisor = new MessagingCaptureSupervisor({
      source: 'telegram',
      registryPath: join(h.home, '.config', 'olympus', 'handles.json'),
      baseEnv: h.env,
      secretStore: store,
      pythonExecutable: '/bin/true',
      spawn: (input) => {
        seen.push(input.env);
        return fakeChild();
      },
    });
    const status = await supervisor.reconcile();
    expect(status, JSON.stringify(status)).toMatchObject({ state: 'running' });
    expect(seen[0]!.OLYMPUS_TELEGRAM_SESSION_PATH).toBe(join(folder(h, TELEGRAM), 'session', 'telegram'));
    expect(seen[0]!.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR).toBe(join(folder(h, TELEGRAM), 'raw', 'telegram-gateway'));
    expect(seen[0]!.OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR).toBe(join(folder(h, TELEGRAM), 'raw', 'telegram-spool'));
    await supervisor.stop();
  });
});

describe('wherever the roots are', () => {
  const layouts: Array<[string, (dir: string, home: string) => Env, string]> = [
    // macOS-like: a relocated XDG data home, while Telegram's stores stay under the home (`@telegram-stores`).
    ['a relocated XDG data home', (dir) => ({ XDG_DATA_HOME: join(dir, 'xdg-data') }), '@telegram-stores/'],
    ...(process.platform === 'linux'
      // The standalone Linux receipt layout: the capture root is the data root, so nothing is tagged.
      ? [['a standalone Linux install', () => ({ OLYMPUS_STANDALONE: '1' }), 'telegram-internal-connector-store.sqlite'] as [string, (dir: string, home: string) => Env, string]]
      : []),
  ];
  test.each(layouts)('%s: both accounts move, and the plan names each place by its root', async (_name, extra, planned) => {
    const h = fixture(extra);
    const telegram = telegramInstall(h);
    const { files: whatsapp } = whatsappInstall(h);
    const before = new Map([...telegram, ...whatsapp].map(({ from }) => [from, inode(from)]));
    const plans: string[] = [];
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'plan') plans.push(readFileSync(sourceRegistryPath(h.env), 'utf8'));
    };
    const report = await boot(h, memorySecretStore());
    expect(report.moved.sort(), JSON.stringify(report)).toEqual([TELEGRAM, WHATSAPP]);
    for (const { from, to } of [...telegram, ...whatsapp]) expect(inode(to), to).toBe(before.get(from)!);
    expect(plans.join('\n')).toContain(planned);
    for (const plan of plans) expect(plan).not.toContain(h.home);
  });
});

describe('a WhatsApp account moves into its folder', () => {
  test('its stores leave the bridge folder for stores/, then the bridge folder becomes raw/whatsapp whole', async () => {
    const h = fixture();
    const { files, audio } = whatsappInstall(h);
    const before = new Map(files.map(({ from }) => [from, inode(from)]));
    const session = inode(join(h.capture, 'whatsapp-live', 'session.db'));
    const store = memorySecretStore({ 'whatsapp.personal_local.session_path': join(h.capture, 'whatsapp-live') });

    const report = await boot(h, store);

    expect(report.moved, JSON.stringify(report)).toEqual([WHATSAPP]);
    for (const { from, to } of files) expect(inode(to), to).toBe(before.get(from)!);
    const raw = join(folder(h, WHATSAPP), 'raw', 'whatsapp');
    expect(inode(join(raw, 'session.db'))).toBe(session);
    expect(readdirSync(raw).sort()).toEqual(['bridge.lock', 'media', 'qr.txt', 'session.db', 'spool']);
    expect(existsSync(join(h.capture, 'whatsapp-live'))).toBe(false);
    // A spool line still names the audio's old place; readers find it in the folder.
    const mapped = whatsappMovedPathMapper(h.env)(audio);
    expect(mapped).toBe(join(raw, 'media', 'audio', 'voice-0011aabbccddeeff.ogg'));
    expect(readFileSync(mapped, 'utf8')).toBe('OggS voice');
    expect(whatsappMovedPathMapper(h.env)('/elsewhere/voice.ogg')).toBe('/elsewhere/voice.ogg');

    await repointMovedMessagingAccounts(h.env, store);
    const grant = JSON.parse(readFileSync(grantPath(h, 'whatsapp'), 'utf8'));
    expect(grant.sessionPath).toBeUndefined();
    expect(grant.producer.env.OLYMPUS_WHATSAPP_STATE_DIR).toBeUndefined();
    expect(store.values.get('whatsapp.personal_local.session_path')).toBe(raw);
  });

  test('media an item names at the old place is still read for extraction', async () => {
    const h = fixture();
    const { audio } = whatsappInstall(h);
    await boot(h, memorySecretStore());
    const raw = join(folder(h, WHATSAPP), 'raw', 'whatsapp');
    const source = new WhatsAppExtractionSource({
      id: 'x', corpusId: 'c', provider: 'whatsapp', accountScope: 'personal', approvedScopeKey: 'k',
      candidates: { extractionCandidates: async () => ({ candidates: [], done: true }) } as never,
      locators: { localContent: () => ({ locatorUri: audio }) },
      mediaRoots: [join(raw, 'media')],
      relocateLocator: whatsappMovedPathMapper(h.env),
    });
    const fetched = await source.fetch({ localItemId: 'i' } as never, {});
    expect(Buffer.from(fetched.bytes).toString()).toBe('OggS voice');
  });
});

describe('what keeps a messaging account where it is', () => {
  const cases: Array<[string, (h: Home, store: ReturnType<typeof memorySecretStore>) => Env | void, string]> = [
    ['the Gateway owns its capture', (h) => ({ ...h.env, OLYMPUS_NATIVE_TELEGRAM_CAPTURE_OWNER: 'true' }), 'pinned'],
    ['an override names its session', (h) => ({ ...h.env, OLYMPUS_TELEGRAM_SESSION_PATH: join(h.home, 'elsewhere', 'tg') }), 'pinned'],
    ['its grant names a session of its own', (h) => writeGrant(h, 'telegram', join(h.home, 'mine', 'tg')), 'pinned'],
    ['its grant starts capture with a path of its own', (h) => writeGrant(h, 'telegram', join(h.capture, 'telegram', 'telegram.personal'), { OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: join(h.home, 'gw') }), 'pinned'],
    ['it was connected with a session path of its own', (_h, store) => { store.values.set('telegram.personal.session_path', '/srv/other/tg'); }, 'pinned'],
    ['an Unpair did not finish', (h) => {
      put(join(h.home, '.config', 'olympus', 'handles.json.unpaired'), JSON.stringify({ version: 1, sources: [{ source_id: TELEGRAM, state: 'unpair_incomplete', unremoved_paths: [join(h.capture, 'telegram', 'telegram.personal.session')] }] }));
    }, 'pinned'],
    ['its grant cannot be read', (h) => { writeFileSync(grantPath(h, 'telegram'), 'not json', { mode: 0o600 }); }, 'unreadable'],
  ];

  test.each(cases)('%s: nothing moves, and why is recorded', async (_name, arrange, reason) => {
    const h = fixture();
    const files = telegramInstall(h);
    const store = memorySecretStore();
    const env = arrange(h, store) ?? h.env;
    const report = await boot(h, store, env);
    expect(report.skipped, JSON.stringify(report)).toEqual([{ sourceId: TELEGRAM, reason }]);
    for (const { from } of files) expect(existsSync(from), from).toBe(true);
    expect(entryOf(h, TELEGRAM)!.layout).toBe('legacy');
    expect(entryOf(h, TELEGRAM)!.migration).toMatchObject({ state: 'skipped', reason });
  });

  test('a Telegram reader that is running (it holds gateway.lock): busy, nothing moves', async () => {
    const h = fixture();
    const files = telegramInstall(h);
    locks.push(tryHoldFileFlock(join(h.state, 'telegram-capture-gateway', 'gateway.lock'))!);
    const report = await boot(h, memorySecretStore());
    expect(report.skipped).toEqual([{ sourceId: TELEGRAM, reason: 'busy' }]);
    for (const { from } of files) expect(existsSync(from), from).toBe(true);
  });

  test('a Telegram pairing that is running (it holds its lease): busy, nothing moves', async () => {
    const h = fixture();
    const files = telegramInstall(h);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pairing = withFileLease(join(h.capture, 'telegram', 'telegram.personal.pairing'), async () => { entered(); await held; }, { acquireTimeoutMs: 1 });
    await ready;
    __accountMigrationTestHooks.budgetMs = 3_000;
    const report = await boot(h, memorySecretStore());
    release();
    await pairing;
    expect(report.skipped).toEqual([{ sourceId: TELEGRAM, reason: 'busy' }]);
    for (const { from } of files) expect(existsSync(from), from).toBe(true);
  });

  test('a WhatsApp bridge that is running (it holds bridge.lock): busy, nothing moves', async () => {
    const h = fixture();
    const { files } = whatsappInstall(h);
    locks.push(tryHoldFileFlock(join(h.capture, 'whatsapp-live', 'bridge.lock'))!);
    const report = await boot(h, memorySecretStore());
    expect(report.skipped).toEqual([{ sourceId: WHATSAPP, reason: 'busy' }]);
    for (const { from } of files) expect(existsSync(from), from).toBe(true);
  });

  test('a second WhatsApp state folder outside the data folder (XDG_DATA_HOME moved): files_elsewhere', async () => {
    const h = fixture((dir) => ({ XDG_DATA_HOME: join(dir, 'xdg-data') }));
    whatsappInstall(h);
    put(join(h.home, '.local', 'share', 'olympus', 'whatsapp-live', 'session.db'), 'the service\'s own');
    const report = await boot(h, memorySecretStore());
    expect(report.skipped).toEqual([{ sourceId: WHATSAPP, reason: 'files_elsewhere' }]);
  });

  test('without the switch, or without the records gathered, a messaging account is not considered', async () => {
    const h = fixture();
    telegramInstall(h);
    const { [MIGRATE_ACCOUNT_FOLDERS_ENV]: _off, ...off } = h.env;
    expect(migrateAccountFolders(off, { messaging: await messagingMoveFacts(off, memorySecretStore()) }).moved).toEqual([]);
    expect(migrateAccountFolders(h.env).moved).toEqual([]);
    expect(entryOf(h, TELEGRAM)!.migration).toBeUndefined();
    // The worker's boot step gathers them only with the switch on.
    expect((await moveAccountsAtBoot(off, memorySecretStore()))?.moved).toEqual([]);
  });
});

describe('a move that stops part way', () => {
  test.each(['plan', 'rename:0', 'rename:3', 'rename:6', 'verified', 'flipped'])('killed at %s: the next boot finishes it, from the plan, whatever the switch says', async (at) => {
    const h = fixture();
    const files = telegramInstall(h);
    const before = new Map(files.map(({ from }) => [from, inode(from)]));
    __accountMigrationTestHooks.checkpoint = (point) => {
      if (point === at) throw new AccountMigrationKilled(point);
    };
    const facts = await messagingMoveFacts(h.env, memorySecretStore());
    expect(() => migrateAccountFolders(h.env, { messaging: facts })).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    if (at !== 'flipped') {
      expect(sourceAccountMovePending(entryOf(h, TELEGRAM)!)).toBe(true);
      expect(accountMovePending(TELEGRAM, h.env)).toBe(true);
    }
    const { [MIGRATE_ACCOUNT_FOLDERS_ENV]: _off, ...off } = h.env;
    const report = migrateAccountFolders(off);
    if (at !== 'flipped') expect(report.resumed).toEqual([TELEGRAM]);
    for (const { from, to } of files) expect(inode(to), to).toBe(before.get(from)!);
    expect(entryOf(h, TELEGRAM)!.layout).toBe('folder');
    // A boot that stopped after the flip leaves the old folders: the next one removes them.
    expect(existsSync(join(h.capture, 'telegram'))).toBe(false);
  });

  test('a failed check puts every file back at the capture and state roots, and the account stays legacy', async () => {
    const h = fixture();
    const files = telegramInstall(h);
    const before = new Map(files.map(({ from }) => [from, inode(from)]));
    const target = folder(h, TELEGRAM);
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path === join(target, 'session', 'telegram.session') && actual.kind === 'file' ? { ...actual, size: actual.size + 1n } : undefined
    );
    const report = await boot(h, memorySecretStore());
    expect(report.movedBack).toEqual([{ sourceId: TELEGRAM, reason: 'verify_failed' }]);
    for (const { from } of files) expect(inode(from), from).toBe(before.get(from)!);
    expect(entryOf(h, TELEGRAM)).toMatchObject({ layout: 'legacy', migration: { state: 'failed', reason: 'verify_failed' } });
    expect(existsSync(target)).toBe(false);
  });

  test('WhatsApp killed after its stores left the bridge folder and before the folder moved: it is put back whole when the next check fails', async () => {
    const h = fixture();
    const { files } = whatsappInstall(h);
    const before = new Map(files.map(({ from }) => [from, inode(from)]));
    __accountMigrationTestHooks.checkpoint = (point) => {
      if (point === 'rename:4') throw new AccountMigrationKilled(point);
    };
    const facts = await messagingMoveFacts(h.env, memorySecretStore());
    expect(() => migrateAccountFolders(h.env, { messaging: facts })).toThrow(AccountMigrationKilled);
    __accountMigrationTestHooks.reset();
    const raw = join(folder(h, WHATSAPP), 'raw', 'whatsapp');
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path === raw && actual.kind === 'dir' ? { ...actual, ino: actual.ino + 1n } : undefined
    );
    const report = migrateAccountFolders(h.env);
    expect(report.movedBack).toEqual([{ sourceId: WHATSAPP, reason: 'verify_failed' }]);
    __accountMigrationTestHooks.reset();
    for (const { from } of files) expect(inode(from), from).toBe(before.get(from)!);
    expect(existsSync(join(h.capture, 'whatsapp-live', 'session.db'))).toBe(true);
  });
});

describe('nothing starts on an account part way through a move', () => {
  function pendingPlan(h: Home, sourceId: string): void {
    updateSourceRegistry(h.env, (registry) => {
      const entry = registry.accounts.find((account) => account.source_id === sourceId)!;
      entry.migration = { state: 'moving', at: '2026-10-25T00:00:00.000Z', moves: [] };
    });
  }

  test('the worker\'s capture supervisor waits (account_moving) and starts no child', async () => {
    const h = fixture();
    whatsappInstall(h);
    pendingPlan(h, WHATSAPP);
    writeHandle(h, 'whatsapp');
    let spawned = 0;
    const supervisor = new MessagingCaptureSupervisor({
      source: 'whatsapp',
      registryPath: join(h.home, '.config', 'olympus', 'handles.json'),
      baseEnv: h.env,
      whatsappBridgePath: '/bin/true',
      secretStore: memorySecretStore(),
      spawn: () => { spawned += 1; return fakeChild(); },
    });
    expect(await supervisor.reconcile()).toMatchObject({ state: 'blocked', reason: 'account_moving' });
    expect(spawned).toBe(0);
  });

  test('a pairing refuses', async () => {
    const h = fixture();
    telegramInstall(h);
    pendingPlan(h, TELEGRAM);
    await expect(settlePairingPlacement({ sourceId: TELEGRAM }, h.env)).rejects.toBeInstanceOf(SourceStorageUnavailableError);
  });
});

describe('the WhatsApp bridge\'s session lock', () => {
  test('a second bridge on a session is not started while one holds its lock (helper_running)', async () => {
    const h = fixture();
    whatsappInstall(h);
    writeHandle(h, 'whatsapp');
    locks.push(tryHoldFileFlock(join(h.capture, 'whatsapp-live', 'bridge.lock'))!);
    let spawned = 0;
    const supervisor = new MessagingCaptureSupervisor({
      source: 'whatsapp',
      registryPath: join(h.home, '.config', 'olympus', 'handles.json'),
      baseEnv: h.env,
      whatsappBridgePath: '/bin/true',
      secretStore: memorySecretStore(),
      spawn: () => { spawned += 1; return fakeChild(); },
    });
    expect(await supervisor.reconcile()).toMatchObject({ state: 'blocked', reason: 'helper_running' });
    expect(spawned).toBe(0);
  });

  test('the bridge is handed the lock: it holds it while it runs, after its spawner let go, and it ends with it', async () => {
    const h = fixture();
    whatsappInstall(h);
    writeHandle(h, 'whatsapp');
    const lockPath = join(h.capture, 'whatsapp-live', 'bridge.lock');
    let child: ReturnType<typeof spawn> | undefined;
    const supervisor = new MessagingCaptureSupervisor({
      source: 'whatsapp',
      registryPath: join(h.home, '.config', 'olympus', 'handles.json'),
      baseEnv: h.env,
      whatsappBridgePath: '/bin/sleep',
      secretStore: memorySecretStore(),
      spawn: (input) => {
        // A real process inherits the descriptor, as the bridge does.
        child = spawn('/bin/sleep', ['30'], { stdio: ['ignore', 'ignore', 'ignore', ...(input.inheritFds ?? [])] });
        const exited = new Promise<number>((resolve) => child!.once('close', (code) => resolve(code ?? 0)));
        return { exited, kill: (signal) => { child!.kill(signal); } };
      },
    });
    expect(await supervisor.reconcile()).toMatchObject({ state: 'running' });
    expect(tryHoldFileFlock(lockPath)).toBeUndefined();
    await supervisor.stop();
    const free = tryHoldFileFlock(lockPath);
    expect(free).toBeDefined();
    free!.release();
  });
});

describe('an empty legacy claim folder left by a failed pairing', () => {
  function claim(h: Home, sourceId: string, names: string[], ageMs = CAPTURE_CLAIM_RECLAIM_AGE_MS + 60_000): string {
    const dir = sourceId === TELEGRAM ? join(h.capture, 'telegram') : join(h.capture, 'whatsapp-live');
    mkdirSync(dir, { recursive: true });
    for (const name of names) writeFileSync(join(dir, name), '');
    const then = new Date(Date.now() - ageMs);
    utimesSync(dir, then, then);
    recordLegacy(h, sourceId, []);
    return dir;
  }

  test('is taken back, and the account is placed in a folder', () => {
    const h = fixture();
    const dir = claim(h, TELEGRAM, ['telegram.personal.pairing.lock.db']);
    expect(replaceEmptyLegacyAccounts(h.env)).toEqual([TELEGRAM]);
    expect(existsSync(dir)).toBe(false);
    expect(entryOf(h, TELEGRAM)!.layout).toBe('folder');
  });

  test('WhatsApp\'s, holding only the bridge lock, too', () => {
    const h = fixture();
    const dir = claim(h, WHATSAPP, ['bridge.lock']);
    expect(reclaimEmptyCaptureClaims(h.env)).toEqual([WHATSAPP]);
    expect(existsSync(dir)).toBe(false);
  });

  const old = CAPTURE_CLAIM_RECLAIM_AGE_MS + 60_000;
  const kept: Array<[string, (h: Home) => Env | void, string[], number]> = [
    ['one made within the hour (a pairing may still be running)', () => {}, [], 60_000],
    ['one that holds a file', () => {}, ['telegram.personal.session'], old],
    ['one an override pins', (h) => ({ ...h.env, OLYMPUS_TELEGRAM_SESSION_PATH: join(h.home, 'x') }), [], old],
  ];
  test.each(kept)('stays: %s', (_name, arrange, names, age) => {
    const h = fixture();
    const dir = claim(h, TELEGRAM, names, age);
    const env = arrange(h) ?? h.env;
    expect(reclaimEmptyCaptureClaims(env)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(entryOf(h, TELEGRAM)!.layout).toBe('legacy');
  });

  test('stays while a pairing holds its lease', async () => {
    const h = fixture();
    const dir = claim(h, TELEGRAM, []);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const pairing = withFileLease(join(dir, 'telegram.personal.pairing'), async () => { entered(); await held; }, { acquireTimeoutMs: 1 });
    await ready;
    const then = new Date(Date.now() - CAPTURE_CLAIM_RECLAIM_AGE_MS - 60_000);
    utimesSync(dir, then, then);
    expect(reclaimEmptyCaptureClaims(h.env)).toEqual([]);
    release();
    await pairing;
    expect(existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function writeHandle(h: Home, source: 'telegram' | 'whatsapp'): void {
  const path = join(h.home, '.config', 'olympus', 'handles.json');
  // As test/messaging-account-folders.test.ts writes a connected handle.
  const handle = source === 'telegram'
    ? { handle: 'telegram.personal', provider: 'telegram', sessionKind: 'mtproto_session', accountRole: 'personal', allowedCapabilities: ['telegram.messages.sync'], backendState: { kind: 'mtproto_session', status: 'available' } }
    : { handle: 'whatsapp.personal_local', provider: 'whatsapp_personal', sessionKind: 'local_app_database', accountRole: 'personal_local', allowedCapabilities: ['whatsapp.personal.messages.sync'], backendState: { kind: 'local_app_database', status: 'available' } };
  put(path, JSON.stringify({
    version: 1,
    handles: [{ ...handle, trustDomain: 'secure_local', scopes: [], tokenSecretRefs: [], connectedAt: '2026-09-14T00:00:00.000Z' }],
  }));
}

function fakeChild(): CaptureChild {
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  return { exited, kill: () => exit(0) };
}

export type { AccountMigrationOptions };
