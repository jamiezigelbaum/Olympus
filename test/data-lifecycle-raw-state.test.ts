// WhatsApp is the one family whose corpus does not arrive from a remote API:
// the bridge writes every message as plaintext JSONL into a spool beside the
// connector store, and keeps the linked-device keys in session.db next to it.
//
// The lifecycle inventory only ever knew about the store, so
// `olympus data delete --source whatsapp.messages` removed three files,
// returned ok:true, and left the complete message history and a live WhatsApp
// session on disk — a deletion surface reporting a completion it had not
// performed. Export has the mirrored duty: it cannot copy raw ingest or secret
// material, so it has to say so rather than let the manifest imply it did.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { deleteOlympusData, exportOlympusData, lifecycleSourceSpecs } from '../src/data-lifecycle.ts';

const SPOOL_LINE = JSON.stringify({
  id: '3EB0',
  chat_jid: '123@s.whatsapp.net',
  chat_name: 'Ada',
  text: 'plaintext message body that a deleted corpus must not keep',
});
const SESSION_SECRET = 'whatsmeow device keys';

function whatsappSpec() {
  return lifecycleSourceSpecs().find((spec) => spec.sourceId === 'whatsapp.personal.messages')!;
}

// The installer's own list of state-dir artifacts
// (scripts/ops/install-private-host-whatsapp-bridge-systemd.sh), read independently
// of the inventory under test.
function seedStateDir(stateDir: string): { spoolFile: string; sessionDb: string; qr: string; audio: string } {
  const spoolFile = join(stateDir, 'spool', '2026-08-18.jsonl');
  const sessionDb = join(stateDir, 'session.db');
  const qr = join(stateDir, 'qr.txt');
  const audio = join(stateDir, 'media', 'audio', 'voice-note.ogg');
  for (const [path, contents] of [
    [spoolFile, `${SPOOL_LINE}\n`],
    [sessionDb, SESSION_SECRET],
    [`${sessionDb}-wal`, 'session wal'],
    [qr, 'pairing qr'],
    [audio, 'voice note bytes'],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return { spoolFile, sessionDb, qr, audio };
}

describe('lifecycle covers the raw WhatsApp state beside the connector store', () => {
  test('delete --source whatsapp.messages removes the spool, the session and the captured audio', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-whatsapp-state-'));
    const homeDir = join(dir, 'home');
    try {
      const storePath = whatsappSpec().connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(dirname(storePath), { recursive: true });
      const db = new Database(storePath, { create: true });
      db.exec('CREATE TABLE preserved (value TEXT NOT NULL);');
      db.query('INSERT INTO preserved (value) VALUES (?)').run('store bytes');
      db.close();
      const seeded = seedStateDir(dirname(storePath));

      const result = deleteOlympusData({ sourceId: 'whatsapp.messages', homeDir });

      expect(result.sourceId).toBe('whatsapp.personal.messages');
      expect(result.removed).toContain(join(dirname(storePath), 'spool'));
      expect(result.removed).toContain(seeded.sessionDb);
      for (const path of [storePath, seeded.spoolFile, seeded.sessionDb, `${seeded.sessionDb}-wal`, seeded.qr, seeded.audio]) {
        expect(`${path}:${existsSync(path)}`).toBe(`${path}:false`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export names the raw state it cannot copy instead of implying it took it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-whatsapp-export-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    try {
      const storePath = whatsappSpec().connectorStorePaths!({ homeDir })[0]!;
      mkdirSync(dirname(storePath), { recursive: true });
      const db = new Database(storePath, { create: true });
      db.exec('CREATE TABLE preserved (value TEXT NOT NULL);');
      db.query('INSERT INTO preserved (value) VALUES (?)').run('store bytes');
      db.close();
      const seeded = seedStateDir(dirname(storePath));

      const result = exportOlympusData({ destination, sourceId: 'whatsapp.messages', homeDir });

      expect(result.skipped).toContain(join(dirname(storePath), 'spool'));
      expect(result.skipped).toContain(seeded.sessionDb);
      const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as { skipped: string[] };
      expect(manifest.skipped).toContain(seeded.sessionDb);
      // Named, never copied: the session keys are exactly what an export marked
      // secrets_excluded must leave behind.
      for (const file of result.files) {
        if (file.endsWith('manifest.json')) continue;
        expect(readFileSync(file, 'utf8')).not.toContain(SESSION_SECRET);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete refuses raw state an operator has pointed outside every Olympus root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-whatsapp-external-'));
    const homeDir = join(dir, 'home');
    const stateDir = join(dir, 'elsewhere', 'whatsapp-live');
    try {
      const seeded = seedStateDir(stateDir);

      expect(() => deleteOlympusData({
        sourceId: 'whatsapp.messages',
        homeDir,
        env: { OLYMPUS_WHATSAPP_STATE_DIR: stateDir },
      })).toThrow('Refusing to delete source state outside an Olympus-owned root');
      expect(existsSync(seeded.spoolFile)).toBe(true);
      expect(existsSync(seeded.sessionDb)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The inventory resolved the store and the spool from its own defaults while
  // the drain resolved both from OLYMPUS_WHATSAPP_STATE_DIR, so an install that
  // moved the state directory left export snapshotting a path nothing had ever
  // written — and delete --all erasing the real one with the root around it.
  test('the inventory follows the state-dir knob the live drain resolves from', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-whatsapp-statedir-'));
    const homeDir = join(dir, 'home');
    const stateDir = join(dir, 'moved-whatsapp-state');
    try {
      const context = { homeDir, env: { OLYMPUS_WHATSAPP_STATE_DIR: stateDir } };

      // The writer's resolution, quoted from scripts/whatsapp-live-drain.ts
      // (`optionsFromEnv`: stateDir from OLYMPUS_WHATSAPP_STATE_DIR, then
      // `join(stateDir, 'connector-store.db')` and `join(stateDir, 'spool')`)
      // rather than imported, so this stays a statement about paths and not a
      // second construction of the live store.
      // Its Personal tier store (P1c, created on first need) sits in the same state dir.
      expect(whatsappSpec().connectorStorePaths!(context)).toEqual([
        join(stateDir, 'connector-store.db'),
        join(stateDir, 'connector-store-internal.db'),
      ]);
      expect(whatsappSpec().rawStatePaths!(context)).toContain(join(stateDir, 'spool'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lifecycle names Telegram capture state: the raw copy goes with a delete, the pairing login does not', () => {
  test('export reports the spool, cursor, gateway state, and Telethon session as manual preservation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-telegram-preservation-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    const dataHome = join(homeDir, '.local', 'share');
    const stateHome = join(homeDir, '.local', 'state');
    try {
      const result = exportOlympusData({ destination, sourceId: 'telegram.messages', homeDir });
      expect(result.skipped).toEqual(expect.arrayContaining([
        join(dataHome, 'olympus', 'telegram-capture', 'spool'),
        join(stateHome, 'olympus', 'telegram-spool-drain', 'cursor.json'),
        join(stateHome, 'olympus', 'telegram-capture-gateway'),
        join(dataHome, 'olympus', 'telegram', 'telegram.personal.session'),
      ]));

      // Only what exists is listed; lay the artifacts down.
      for (const dirPath of [join(dataHome, 'olympus', 'telegram-capture', 'spool'), join(stateHome, 'olympus', 'telegram-capture-gateway')]) {
        mkdirSync(dirPath, { recursive: true });
        writeFileSync(join(dirPath, 'x'), 'raw');
      }
      mkdirSync(join(stateHome, 'olympus', 'telegram-spool-drain'), { recursive: true });
      writeFileSync(join(stateHome, 'olympus', 'telegram-spool-drain', 'cursor.json'), '{}');
      mkdirSync(join(dataHome, 'olympus', 'telegram'), { recursive: true });
      writeFileSync(join(dataHome, 'olympus', 'telegram', 'telegram.personal.session'), 'login');
      const dryRun = deleteOlympusData({ sourceId: 'telegram.messages', homeDir, dryRun: true });
      expect(dryRun.removed).toEqual(expect.arrayContaining([
        join(dataHome, 'olympus', 'telegram-capture', 'spool'),
        join(stateHome, 'olympus', 'telegram-spool-drain', 'cursor.json'),
        join(stateHome, 'olympus', 'telegram-capture-gateway'),
      ]));
      // The pairing login is Unpair's, never a data delete's.
      expect(dryRun.removed).not.toContain(join(dataHome, 'olympus', 'telegram', 'telegram.personal.session'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('inventory follows explicit Telegram continuity path overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-telegram-overrides-'));
    const homeDir = join(dir, 'home');
    const destination = join(dir, 'export');
    const spoolDir = join(dir, 'private', 'spool');
    const cursorPath = join(dir, 'private', 'cursor.json');
    const gatewayState = join(dir, 'private', 'gateway');
    const sessionBase = join(dir, 'private', 'telegram-session');
    try {
      const result = exportOlympusData({
        destination,
        sourceId: 'telegram.messages',
        homeDir,
        env: {
          OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: spoolDir,
          OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH: cursorPath,
          OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: gatewayState,
          OLYMPUS_TELEGRAM_SESSION_PATH: sessionBase,
        },
      });
      expect(result.skipped).toEqual(expect.arrayContaining([
        spoolDir,
        cursorPath,
        gatewayState,
        `${sessionBase}.session`,
        `${sessionBase}.session-journal`,
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recursive raw-state deletes stay inside Olympus\'s own, unshared directories', () => {
  const symlinkSync = (target: string, path: string) => require('node:fs').symlinkSync(target, path);
  function lab() {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-containment-'));
    const homeDir = join(dir, 'home');
    const dataHome = join(homeDir, '.local', 'share');
    const external = join(dir, 'external');
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, 'precious.txt'), 'keep');
    const olympusRoot = join(dataHome, 'olympus');
    mkdirSync(olympusRoot, { recursive: true });
    // Another source's data, which a wide override must never reach.
    const whatsappSpool = join(olympusRoot, 'whatsapp-live', 'spool');
    mkdirSync(whatsappSpool, { recursive: true });
    writeFileSync(join(whatsappSpool, 'm.jsonl'), 'other source');
    const del = (env: Record<string, string> = {}, sourceId = 'telegram.messages', dryRun = false) =>
      deleteOlympusData({ sourceId, homeDir, env, dryRun } as never);
    return { dir, homeDir, dataHome, external, olympusRoot, whatsappSpool, del };
  }

  test('a normal spool still deletes', () => {
    const l = lab();
    try {
      const spool = join(l.olympusRoot, 'telegram-capture', 'spool');
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, 'x.jsonl'), 'raw');
      const result = l.del();
      expect(result.removed).toContain(spool);
      expect(existsSync(spool)).toBe(false);
      expect(existsSync(join(l.whatsappSpool, 'm.jsonl'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test('a raw directory that is a symbolic link is refused and its target is untouched', () => {
    const l = lab();
    try {
      mkdirSync(join(l.olympusRoot, 'telegram-capture'), { recursive: true });
      symlinkSync(l.external, join(l.olympusRoot, 'telegram-capture', 'spool'));
      expect(() => l.del()).toThrow('symbolic link');
      expect(existsSync(join(l.external, 'precious.txt'))).toBe(true);
      // A link higher up is refused the same way.
      rmSync(join(l.olympusRoot, 'telegram-capture'), { recursive: true, force: true });
      symlinkSync(l.external, join(l.olympusRoot, 'telegram-capture'));
      expect(() => l.del()).toThrow('symbolic link');
      expect(existsSync(join(l.external, 'precious.txt'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test('a symlinked gateway-state directory or cursor file is refused, never silently unlinked', () => {
    const l = lab();
    try {
      const gateway = join(l.homeDir, '.local', 'state', 'olympus', 'telegram-capture-gateway');
      mkdirSync(dirname(gateway), { recursive: true });
      symlinkSync(l.external, gateway);
      expect(() => l.del()).toThrow('symbolic link');
      expect(existsSync(join(l.external, 'precious.txt'))).toBe(true);
      expect(lstatSync(gateway).isSymbolicLink()).toBe(true);
      rmSync(gateway, { force: true });
      const cursor = join(l.homeDir, '.local', 'state', 'olympus', 'telegram-spool-drain', 'cursor.json');
      mkdirSync(dirname(cursor), { recursive: true });
      symlinkSync(join(l.external, 'precious.txt'), cursor);
      expect(() => l.del()).toThrow('symbolic link');
      expect(existsSync(join(l.external, 'precious.txt'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test('a link NESTED inside the spool is unlinked, never followed', () => {
    const l = lab();
    try {
      const spool = join(l.olympusRoot, 'telegram-capture', 'spool');
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, 'x.jsonl'), 'raw');
      symlinkSync(l.external, join(spool, 'escape'));
      l.del();
      expect(existsSync(spool)).toBe(false);
      expect(existsSync(join(l.external, 'precious.txt'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test.each([
    ['equal to an Olympus root', (l: ReturnType<typeof lab>) => l.olympusRoot],
    ['above an Olympus root', (l: ReturnType<typeof lab>) => l.dataHome],
  ])('an override %s is refused and nothing is deleted', (_name, pick) => {
    const l = lab();
    try {
      const spool = join(l.olympusRoot, 'telegram-capture', 'spool');
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, 'x.jsonl'), 'raw');
      expect(() => l.del({ OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: pick(l) })).toThrow('Refusing to delete source state');
      expect(existsSync(join(spool, 'x.jsonl'))).toBe(true);
      expect(existsSync(join(l.whatsappSpool, 'm.jsonl'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test('an override that overlaps another source\'s data is refused, nothing deleted', () => {
    const l = lab();
    try {
      const spool = join(l.olympusRoot, 'telegram-capture', 'spool');
      mkdirSync(spool, { recursive: true });
      writeFileSync(join(spool, 'x.jsonl'), 'raw');
      // Equal to another source's spool, and containing it.
      expect(() => l.del({ OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: l.whatsappSpool })).toThrow('overlaps another source');
      expect(() => l.del({ OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: join(l.olympusRoot, 'whatsapp-live') })).toThrow('overlaps another source');
      expect(existsSync(join(spool, 'x.jsonl'))).toBe(true);
      expect(existsSync(join(l.whatsappSpool, 'm.jsonl'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test('WhatsApp\'s own spool and media are held to the same rules', () => {
    const l = lab();
    try {
      mkdirSync(join(l.olympusRoot, 'whatsapp-live'), { recursive: true });
      rmSync(l.whatsappSpool, { recursive: true, force: true });
      symlinkSync(l.external, l.whatsappSpool);
      expect(() => l.del({}, 'whatsapp.personal.messages')).toThrow('symbolic link');
      expect(existsSync(join(l.external, 'precious.txt'))).toBe(true);
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });

  test('a gateway-state override that holds the handle registry is refused, files intact', () => {
    const l = lab();
    try {
      const gw = join(l.olympusRoot, 'gw-override');
      mkdirSync(gw, { recursive: true });
      writeFileSync(join(gw, 'cursor.json'), '{}');
      const registry = join(gw, 'handles.json');
      writeFileSync(registry, '{"handles":[]}');
      writeFileSync(`${registry}.grant-epoch.json`, '{}');
      writeFileSync(join(gw, 'this-computer.json'), '{}');
      // Through the engine's context value and through the env override.
      expect(() => deleteOlympusData({
        sourceId: 'telegram.messages', homeDir: l.homeDir, registryPath: registry,
        env: { OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: gw },
      } as never)).toThrow('overlaps another source');
      expect(() => l.del({ OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: gw, OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH: registry }))
        .toThrow('overlaps another source');
      for (const path of [registry, `${registry}.grant-epoch.json`, join(gw, 'this-computer.json'), join(gw, 'cursor.json')]) {
        expect(`${path}:${existsSync(path)}`).toBe(`${path}:true`);
      }
    } finally { rmSync(l.dir, { recursive: true, force: true }); }
  });
});

describe('shared files and stores stay out of a recursive delete, whichever variable relocates them', () => {
  // Every shared-store or config location a deployment can relocate. The
  // protection is by variable NAME pattern, so a new one is covered; this
  // table pins the known ones and the sweep test below catches a new name.
  const SHARED_ENV = [
    'OLYMPUS_CONFIG',
    'OLYMPUS_SOVEREIGNTY_CONFIG',
    'OLYMPUS_SOVEREIGNTY_CONFIG_PATH',
    'OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH',
    'OLYMPUS_REMOTE_CONNECTIONS_DB_PATH',
    'OLYMPUS_CREDENTIAL_BROKER_STATE_PATH',
    'OLYMPUS_CREDENTIAL_SESSION_BACKEND_STATE_PATH',
    'OLYMPUS_SOURCE_INDEX_CORPUS_REGISTRY_PATH',
    'OLYMPUS_SOURCE_INDEX_X_API_USAGE_DB_PATH',
    'OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH',
  ];
  for (const name of SHARED_ENV) {
    test(`${name} inside a state-directory override is refused, file and sidecars intact`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-shared-'));
      const homeDir = join(dir, 'home');
      const gw = join(homeDir, '.local', 'share', 'olympus', 'gw');
      mkdirSync(gw, { recursive: true });
      const shared = join(gw, name.endsWith('_DB_PATH') ? 'shared.sqlite' : 'shared.json');
      writeFileSync(shared, 'x');
      writeFileSync(`${shared}-wal`, 'x');
      try {
        expect(() => deleteOlympusData({
          sourceId: 'telegram.messages', homeDir,
          env: { OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: gw, [name]: shared },
        } as never)).toThrow('overlaps another source');
        expect(existsSync(shared)).toBe(true);
        expect(existsSync(`${shared}-wal`)).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('a state-directory override that IS an authoritative file is refused, never selected for removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-shared-file-'));
    const homeDir = join(dir, 'home');
    const config = join(homeDir, '.olympus', 'config.json');
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '{"keep":true}');
    try {
      expect(() => deleteOlympusData({ sourceId: 'telegram.messages', homeDir, env: { OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: config } } as never))
        .toThrow('overlaps another source');
      expect(readFileSync(config, 'utf8')).toBe('{"keep":true}');
      // Also through the variable that relocates the config itself.
      const moved = join(homeDir, 'elsewhere', 'owner.json');
      mkdirSync(dirname(moved), { recursive: true });
      writeFileSync(moved, 'x');
      expect(() => deleteOlympusData({ sourceId: 'telegram.messages', homeDir, env: { OLYMPUS_CONFIG: moved, OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: moved } } as never))
        .toThrow('overlaps another source');
      expect(existsSync(moved)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a RELATIVE override is resolved the way its consumer resolves it before the overlap check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-relative-'));
    const homeDir = join(dir, 'home');
    const gw = join(homeDir, '.local', 'share', 'olympus', 'gw');
    mkdirSync(gw, { recursive: true });
    writeFileSync(join(gw, 'broker.json'), 'x');
    const cwd = process.cwd();
    try {
      process.chdir(gw);
      expect(() => deleteOlympusData({
        sourceId: 'telegram.messages', homeDir,
        env: { OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: gw, OLYMPUS_CREDENTIAL_BROKER_STATE_PATH: 'broker.json' },
      } as never)).toThrow('overlaps another source');
      expect(existsSync(join(gw, 'broker.json'))).toBe(true);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a source\'s own relocated legacy index and its journal do not read as shared', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-own-journal-'));
    const homeDir = join(dir, 'home');
    const gw = join(homeDir, '.local', 'share', 'olympus', 'gw');
    mkdirSync(gw, { recursive: true });
    const legacy = join(gw, 'legacy.sqlite');
    writeFileSync(legacy, 'x');
    writeFileSync(`${legacy}-journal`, 'x');
    try {
      const result = deleteOlympusData({
        sourceId: 'telegram.messages', homeDir,
        env: { OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: gw, OLYMPUS_SOURCE_INDEX_TELEGRAM_MESSAGES_DB_PATH: legacy },
      } as never);
      expect(result.removed).toContain(gw);
      expect(existsSync(gw)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('every OLYMPUS_*_PATH / _DB_PATH variable the source reads is covered by the name sweep', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs');
    const names = new Set<string>();
    const walk = (d: string) => {
      for (const entry of readdirSync(d)) {
        const path = join(d, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          for (const m of readFileSync(path, 'utf8').matchAll(/\b(OLYMPUS_[A-Z0-9_]*_DB_PATH)\b/g)) names.add(m[1]!);
        }
      }
    };
    walk(join(import.meta.dir, '..', 'src'));
    expect(names.size).toBeGreaterThan(10);
    const pattern = /^OLYMPUS_[A-Z0-9_]*(_PATH|_DB|_CONFIG|_FILE)$/;
    expect([...names].filter((name) => !pattern.test(name))).toEqual([]);
  });
});

describe('a per-source delete clears that source\'s shared file-extraction job rows', () => {
  test('rows of the deleted source go (jobs and artifacts); another source\'s rows stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-extraction-jobs-'));
    const homeDir = join(dir, 'home');
    const jobsPath = join(dir, 'jobs.sqlite');
    const env = { OLYMPUS_FILE_EXTRACTION_JOBS_DB_PATH: jobsPath };
    try {
      const store = new LocalFileExtractionJobStore(jobsPath);
      const extractor = { extractorKind: 'local_text', extractorVersion: 'text-v1' } as const;
      const ref = (corpusId: string, provider: string, id: string) => ({
        corpusId, provider, accountScope: 'a', approvedScopeKey: 'k',
        providerItemId: id, localItemId: `l:${id}`, sourceVersion: 'v1', contentHash: `h${id}`,
        name: `${id}.txt`, mimeType: 'text/plain', sizeBytes: 4,
      });
      store.enqueue({ refs: [ref('secure_local.dropbox.files', 'dropbox', 'd1')], ...extractor, policyDecision: 'index_allowed' });
      store.enqueue({ refs: [ref('secure_local.local.files', 'local_files', 'f1')], ...extractor, policyDecision: 'index_allowed' });
      store.close();
      const count = (sql: string) => {
        const db = new Database(jobsPath, { readonly: true });
        try { return (db.query(sql).get() as { n: number }).n; } finally { db.close(); }
      };
      expect(count('SELECT COUNT(*) n FROM extraction_jobs')).toBe(2);

      const dry = deleteOlympusData({ sourceId: 'dropbox.files', homeDir, env, dryRun: true });
      expect(dry.removed.some((entry) => entry.includes('extraction jobs'))).toBe(false);
      expect(count('SELECT COUNT(*) n FROM extraction_jobs')).toBe(2);

      const result = deleteOlympusData({ sourceId: 'dropbox.files', homeDir, env });
      expect(result.removed).toContain(`${jobsPath} (extraction jobs: 1)`);
      expect(count("SELECT COUNT(*) n FROM extraction_jobs WHERE corpus_id = 'secure_local.dropbox.files'")).toBe(0);
      expect(count("SELECT COUNT(*) n FROM extraction_jobs WHERE corpus_id = 'secure_local.local.files'")).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
