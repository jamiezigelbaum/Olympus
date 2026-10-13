/**
 * Each connection knows its host (design docs/design/background-agents.md
 * section D): a provider per connection, set from a pinned client's host, the
 * agent the owner chose, or the name, else `other`; existing connections are
 * migrated the same way, once, safely under two processes.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { remoteOAuthSchemaMigration } from '../src/core/remote-oauth-store.ts';
import { readSqliteSchemaVersion } from '../src/core/sqlite-migrations.ts';
import { CHATGPT_CLIENT_ID, CLAUDE_CLIENT_ID, CURSOR_CLIENT_ID, GROK_CLIENT_ID } from '../src/workers/remote-oauth/pinned-clients.ts';

const RESOURCE = 'https://abc123.connect.olympusplugin.ai/mcp';
const STORE_ID = 'remote-connections';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-provider-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'private'), { mode: 0o700 });
  return join(dir, 'private', 'remote-connections.sqlite');
}

/**
 * A schema v2 database as the previous release left it: the v1 table, the
 * OAuth migration, schema_version 2, and the given connections.
 */
function legacyV2Database(path: string, rows: Array<{ id: string; name: string; kind: 'bearer' | 'oauth'; clientId?: string }>): void {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE schema_version (store_id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE remote_connections (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('bearer')),
      token_hash BLOB NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
  `);
  remoteOAuthSchemaMigration(2).up(db);
  db.query('INSERT INTO schema_version VALUES (?, 2, ?)').run(STORE_ID, '2026-10-01T00:00:00.000Z');
  const insert = db.query('INSERT INTO remote_connections (id, display_name, kind, token_hash, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  rows.forEach((row, index) => {
    insert.run(row.id, row.name, row.kind, row.kind === 'bearer' ? Buffer.alloc(32, index + 1) : null, row.clientId ?? null, `2026-10-0${index + 1}T00:00:00.000Z`);
  });
  db.close();
}

/** Each listed connection's provider, by id. */
function providersOf(store: { list(): Array<{ id: string; provider: string }> }): Record<string, string> {
  return Object.fromEntries(store.list().map((connection) => [connection.id, connection.provider]));
}

function providersById(path: string): Record<string, string | null> {
  const db = new Database(path);
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const rows = db.query('SELECT id, provider FROM remote_connections ORDER BY id').all() as Array<{ id: string; provider: string | null }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.provider]));
  } finally {
    db.close();
  }
}

const LEGACY_ROWS = [
  { id: 'a00000000000000001', name: 'My phone', kind: 'oauth', clientId: CHATGPT_CLIENT_ID },
  { id: 'a00000000000000002', name: 'Grok Bot or Cursor', kind: 'oauth', clientId: CURSOR_CLIENT_ID },
  { id: 'a00000000000000003', name: 'Work', kind: 'oauth', clientId: CLAUDE_CLIENT_ID },
  { id: 'a00000000000000004', name: 'Claude', kind: 'oauth', clientId: 'olympus_client_000000000000000000000001' },
  { id: 'a00000000000000005', name: 'Muse', kind: 'bearer' },
  { id: 'a00000000000000006', name: 'Grok API', kind: 'bearer' },
  { id: 'a00000000000000007', name: 'Agent', kind: 'bearer' },
  { id: 'a00000000000000008', name: 'Claude or ChatGPT', kind: 'bearer' },
] as const;

/** What each legacy connection's host must be after the upgrade. */
const LEGACY_EXPECTED: Record<string, string> = {
  a00000000000000001: 'openai', // ChatGPT pin, whatever it is called
  a00000000000000002: 'xai', // Grok Bot or Cursor pin
  a00000000000000003: 'anthropic', // Claude pin
  a00000000000000004: 'anthropic', // a self-registered client named Claude
  a00000000000000005: 'meta', // Muse is Meta's agent
  a00000000000000006: 'xai',
  a00000000000000007: 'other', // names no host
  a00000000000000008: 'other', // names two
};

describe('a new connection records who hosts its agent', () => {
  test('a key: the agent the owner chose, else the one host its name names, else other', () => {
    const store = openRemoteConnectionStore(freshDbPath());
    cleanups.unshift(() => store.close());
    const made: Record<string, string> = {};
    const create = (name: string, provider?: 'xai' | 'other' | 'anthropic') => {
      const created = store.create(name, provider ? { provider } : {});
      made[created.connection.id] = created.connection.provider;
      return created;
    };
    expect(create('Grok API').connection.provider).toBe('xai');
    expect(create('Muse').connection.provider).toBe('meta');
    expect(create('Agent').connection.provider).toBe('other');
    expect(create('Claude or ChatGPT').connection.provider).toBe('other');
    expect(create('Claude helper', 'other').connection.provider).toBe('other');
    expect(create('Scripts', 'xai').connection.provider).toBe('xai');
    expect(() => store.create('Scripts', { provider: 'google' as never })).toThrow('openai, xai, meta, anthropic or other');
    const { token } = create('My bot', 'anthropic');
    expect(store.verifyToken(token)).toMatchObject({ ok: true, connection: { displayName: 'My bot', provider: 'anthropic' } });
    // Stored as made.
    expect(providersOf(store)).toEqual(made);
  });

  test('a grant: a pinned client is its host whatever it is called; any other client by its name, else other', () => {
    const store = openRemoteConnectionStore(freshDbPath());
    cleanups.unshift(() => store.close());
    const made: Record<string, string> = {};
    const grant = (clientId: string, displayName: string, provider?: 'meta') => {
      const granted = store.oauth.createGrant({ clientId, displayName, resource: RESOURCE, ...(provider ? { provider } : {}) });
      made[granted.connection.id] = granted.connection.provider;
      return granted;
    };
    expect(grant(CHATGPT_CLIENT_ID, 'ChatGPT').connection.provider).toBe('openai');
    expect(grant(CLAUDE_CLIENT_ID, 'Claude').connection.provider).toBe('anthropic');
    expect(grant(GROK_CLIENT_ID, 'Grok').connection.provider).toBe('xai');
    const cursor = grant(CURSOR_CLIENT_ID, 'Grok Bot or Cursor');
    expect(cursor.connection.provider).toBe('xai');
    // A pin cannot be overridden: the client is that host.
    expect(grant(CHATGPT_CLIENT_ID, 'ChatGPT', 'meta').connection.provider).toBe('openai');
    expect(grant('olympus_client_000000000000000000000001', 'Claude').connection.provider).toBe('anthropic');
    expect(grant('olympus_client_000000000000000000000002', 'My agent').connection.provider).toBe('other');
    // Verified tokens carry it, so the remote caller is placed by it.
    expect(store.oauth.verifyAccessToken(cursor.tokens.accessToken, RESOURCE)).toMatchObject({ ok: true, connection: { provider: 'xai' } });
    const refreshed = store.oauth.refresh({ refreshToken: cursor.tokens.refreshToken, clientId: CURSOR_CLIENT_ID, resource: RESOURCE });
    expect(refreshed).toMatchObject({ ok: true, connection: { provider: 'xai' } });
    expect(providersOf(store)).toEqual(made);
  });
});

describe('existing connections migrate', () => {
  test('from their pin, else their name, else other; the version moves to 3', () => {
    const path = freshDbPath();
    legacyV2Database(path, [...LEGACY_ROWS]);
    const store = openRemoteConnectionStore(path);
    try {
      expect(providersOf(store)).toEqual(LEGACY_EXPECTED);
    } finally {
      store.close();
    }
    // Written to the file, not only derived on read.
    expect(providersById(path)).toEqual(LEGACY_EXPECTED);
    const db = new Database(path);
    expect(readSqliteSchemaVersion(db, STORE_ID)).toBe(3);
    db.close();
  });

  test('is idempotent: reopening changes nothing, and a re-upgrade after a rollback keeps every recorded choice', () => {
    const path = freshDbPath();
    legacyV2Database(path, [...LEGACY_ROWS]);
    openRemoteConnectionStore(path).close();
    const store = openRemoteConnectionStore(path);
    // The owner's choice for a connection whose name names a host.
    store.create('Claude helper', { provider: 'other' });
    store.close();
    const before = providersById(path);
    openRemoteConnectionStore(path).close();
    expect(providersById(path)).toEqual(before);

    // The documented rollback: version back to 2; the older build then adds
    // a connection with no provider, as it knows no such column.
    const older = new Database(path);
    older.exec('PRAGMA busy_timeout = 10000;');
    older.exec("UPDATE schema_version SET version = 2 WHERE store_id = 'remote-connections'");
    older.query("INSERT INTO remote_connections (id, display_name, kind, token_hash, created_at) VALUES ('b00000000000000001', 'Grok API', 'bearer', x'01', '2026-10-12T00:00:00.000Z')").run();
    older.close();

    const again = openRemoteConnectionStore(path);
    again.close();
    expect(providersById(path)).toEqual({ ...before, b00000000000000001: 'xai' });
    const db = new Database(path);
    expect(readSqliteSchemaVersion(db, STORE_ID)).toBe(3);
    db.close();
  });

  test('two handles on one file (the CLI\'s and the worker\'s): both read and write the same providers', () => {
    const path = freshDbPath();
    legacyV2Database(path, [...LEGACY_ROWS]);
    const worker = openRemoteConnectionStore(path);
    const cli = openRemoteConnectionStore(path);
    try {
      const created = cli.create('Grok API', { provider: 'xai' });
      const other = worker.create('Agent', { provider: 'other' });
      expect(worker.verifyToken(created.token)).toMatchObject({ ok: true, connection: { provider: 'xai' } });
      expect(cli.verifyToken(other.token)).toMatchObject({ ok: true, connection: { provider: 'other' } });
      const fromWorker = worker.list().map((connection) => [connection.id, connection.provider]);
      expect(cli.list().map((connection) => [connection.id, connection.provider])).toEqual(fromWorker);
      expect(Object.fromEntries(fromWorker)).toMatchObject(LEGACY_EXPECTED);
    } finally {
      cli.close();
      worker.close();
    }
  });

  test('two processes opening a v2 file at the same moment both open it, and it is migrated once', async () => {
    const path = freshDbPath();
    legacyV2Database(path, [...LEGACY_ROWS]);
    const module = join(import.meta.dir, '..', 'src', 'core', 'remote-connections.ts');
    const go = `${path}.go`;
    const script = `
      const { existsSync } = require('node:fs');
      const { openRemoteConnectionStore } = await import(${JSON.stringify(module)});
      while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(1);
      const store = openRemoteConnectionStore(${JSON.stringify(path)});
      console.log(JSON.stringify(store.list().map((c) => [c.id, c.provider])));
      store.close();
    `;
    const children = Array.from({ length: 4 }, () => Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
    // Every child is loaded and waiting before any may open the file.
    await Bun.sleep(1_500);
    await Bun.write(go, '');
    const results = await Promise.all(children.map(async (child) => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    })));
    for (const result of results) {
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(Object.fromEntries(JSON.parse(result.out) as Array<[string, string]>)).toEqual(LEGACY_EXPECTED);
    }
    expect(providersById(path)).toEqual(LEGACY_EXPECTED);
    const db = new Database(path);
    expect(readSqliteSchemaVersion(db, STORE_ID)).toBe(3);
    db.close();
  }, 30_000);
});
