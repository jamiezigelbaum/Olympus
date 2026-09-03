// whatsapp-live-sync shares its connector store with the WhatsApp archive-import
// lane, whose cursors are bare integers. Resuming from the store's unscoped
// "most recent run" accessor hands the live connector a foreign cursor, which it
// refuses — the exact wedge the drain was taught to survive on 2026-07-05. The
// resume point must be scoped to this connector's own completed runs and
// sanitized, the same way scripts/whatsapp-live-drain.ts does it.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

const ACCOUNT = 'personal';
const SCRIPT = join(import.meta.dir, '..', 'scripts', 'whatsapp-live-sync.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('whatsapp live sync resume cursor', () => {
  test('ignores a foreign lane cursor that is newer than the live lane run', () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsapp-live-sync-resume-'));
    roots.push(root);
    const stateDir = join(root, 'state');
    const spoolDir = join(stateDir, 'spool');
    const dbPath = join(stateDir, 'connector-store.db');
    const spoolFile = join(spoolDir, '2026-07-05.jsonl');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(spoolFile, spoolLine('a1') + spoolLine('a2'));

    const first = runSync(stateDir, dbPath);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).summary.cursor).toBe('2026-07-05.jsonl:2');

    // The archive-import lane writes the same store with a bare-integer cursor.
    seedForeignSyncRun(dbPath, '1200');
    appendFileSync(spoolFile, spoolLine('a3'));

    const second = runSync(stateDir, dbPath);
    expect(second.stderr).not.toContain('WhatsApp live spool cursors look like');
    expect(second.exitCode).toBe(0);
    const summary = JSON.parse(second.stdout).summary as { itemsSeen: number; cursor: string };
    expect(summary.cursor).toBe('2026-07-05.jsonl:3');
    expect(summary.itemsSeen).toBe(1);
  }, 20_000);
});

function runSync(stateDir: string, dbPath: string) {
  const run = Bun.spawnSync([process.execPath, SCRIPT, '--db', dbPath, '--account', ACCOUNT], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, OLYMPUS_WHATSAPP_STATE_DIR: stateDir },
  });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function seedForeignSyncRun(dbPath: string, cursor: string): void {
  const db = new Database(dbPath);
  try {
    db.query(`
      INSERT INTO sync_runs (
        sync_run_id, corpus_id, connector_id, status, cursor,
        items_seen, items_indexed, started_at, completed_at
      ) VALUES (?, ?, 'whatsapp', 'completed', ?, 0, 0, ?, ?)
    `).run(
      'archive-import-run',
      'secure_local.whatsapp.messages',
      cursor,
      '2099-01-01T00:00:00.000Z',
      '2099-01-01T00:00:01.000Z',
    );
  } finally {
    db.close();
  }
}

function spoolLine(id: string): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Ada',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Ada',
    from_me: false,
    timestamp: '2026-07-05T10:00:00Z',
    text: `message ${id}`,
  })}\n`;
}
