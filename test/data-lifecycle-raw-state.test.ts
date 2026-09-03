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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
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
      expect(whatsappSpec().connectorStorePaths!(context)).toEqual([join(stateDir, 'connector-store.db')]);
      expect(whatsappSpec().rawStatePaths!(context)).toContain(join(stateDir, 'spool'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lifecycle names Telegram capture continuity without widening deletion', () => {
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

      const dryRun = deleteOlympusData({ sourceId: 'telegram.messages', homeDir, dryRun: true });
      expect(dryRun.removed).not.toContain(join(dataHome, 'olympus', 'telegram-capture', 'spool'));
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
