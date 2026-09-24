/**
 * Remote agent connections: one owner approval each, revocable.
 *
 * A connection is what an agent outside this machine presents to the worker's
 * remote MCP endpoint (`/mcp`). This slice ships bearer connections: the owner
 * runs `olympus connections add <name>`, which prints a long random token
 * exactly once. The store keeps only its SHA-256 digest (a 256-bit random
 * secret needs no slow hash), so a copy of the database cannot be replayed.
 *
 * The token embeds its connection id (`olympus_conn_<id>_<secret>`), so
 * verification is one primary-key read plus a constant-time digest compare
 * rather than a lookup keyed on secret material.
 *
 * Plain functions over a factory, not a class: this module is reachable from
 * the bundled CLI, and class-field initializers balloon the committed dist/.
 */
import { Database } from 'bun:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { OperationError } from './operation-error.ts';
import { sanitizeCallerDisplayName } from './operation-caller.ts';
import {
  assertSqliteSchemaCanOpen,
  runSqliteMigrations,
  type SqliteMigration,
} from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';

export const REMOTE_CONNECTIONS_STORE_ID = 'remote-connections';
export const REMOTE_CONNECTIONS_SCHEMA_VERSION = 1;
export const REMOTE_CONNECTION_TOKEN_PREFIX = 'olympus_conn_';
/** How stale `last_used_at` may get before a successful call rewrites it. */
export const REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS = 60_000;

const CONNECTION_ID_BYTES = 9;
const CONNECTION_SECRET_BYTES = 32;
const CONNECTION_ID_PATTERN = /^[a-f0-9]{18}$/;
const TOKEN_PATTERN = /^olympus_conn_([a-f0-9]{18})_([A-Za-z0-9_-]{43})$/;

export type RemoteConnectionKind = 'bearer';

export interface RemoteConnectionRecord {
  id: string;
  displayName: string;
  kind: RemoteConnectionKind;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedRemoteConnection {
  connection: RemoteConnectionRecord;
  /** Shown once. Never stored, never logged. */
  token: string;
}

export type RemoteConnectionVerification =
  | { ok: true; connection: RemoteConnectionRecord }
  | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' };

export interface RemoteConnectionStore {
  readonly dbPath: string;
  create(displayName: string): CreatedRemoteConnection;
  list(): RemoteConnectionRecord[];
  revoke(id: string): RemoteConnectionRecord;
  verifyToken(token: string): RemoteConnectionVerification;
  close(): void;
}

interface ConnectionRow {
  id: string;
  display_name: string;
  kind: string;
  token_hash: Uint8Array;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function defaultRemoteConnectionsDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const dataRoot = configured || join(homedir(), '.local', 'share');
  if (!isAbsolute(dataRoot)) {
    throw new TypeError('Remote connections XDG_DATA_HOME must be an absolute private data root.');
  }
  return join(dataRoot, 'openclaw', 'olympus', 'remote-connections.sqlite');
}

export function hashRemoteConnectionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function openRemoteConnectionStore(
  dbPath = defaultRemoteConnectionsDbPath(),
  options: { now?: () => Date } = {},
): RemoteConnectionStore {
  const now = options.now ?? (() => new Date());
  hardenPrivateDatabasePath(dbPath);
  const db = new Database(dbPath, { create: true });
  try {
    chmodSync(dbPath, 0o600);
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;');
    assertSqliteSchemaCanOpen(db, REMOTE_CONNECTIONS_STORE_ID, REMOTE_CONNECTIONS_SCHEMA_VERSION);
    runSqliteMigrations(db, REMOTE_CONNECTIONS_STORE_ID, remoteConnectionMigrations());
  } catch (error) {
    closeSqliteStore(db);
    throw error;
  }

  const readRow = (id: string): ConnectionRow | null =>
    db.query('SELECT * FROM remote_connections WHERE id = ?').get(id) as ConnectionRow | null;

  return {
    dbPath,

    create(displayName: string): CreatedRemoteConnection {
      const name = requireDisplayName(displayName);
      const id = randomBytes(CONNECTION_ID_BYTES).toString('hex');
      const secret = randomBytes(CONNECTION_SECRET_BYTES).toString('base64url');
      const token = `${REMOTE_CONNECTION_TOKEN_PREFIX}${id}_${secret}`;
      const createdAt = now().toISOString();
      db.query(`
        INSERT INTO remote_connections (id, display_name, kind, token_hash, created_at)
        VALUES (?, ?, 'bearer', ?, ?)
      `).run(id, name, hashRemoteConnectionToken(token), createdAt);
      const row = readRow(id);
      if (!row) throw new Error('Remote connection could not be read after creation.');
      return { connection: toRecord(row), token };
    },

    list(): RemoteConnectionRecord[] {
      return (db.query('SELECT * FROM remote_connections ORDER BY created_at, id').all() as ConnectionRow[])
        .map(toRecord);
    },

    revoke(id: string): RemoteConnectionRecord {
      if (typeof id !== 'string' || !CONNECTION_ID_PATTERN.test(id)) {
        throw new OperationError('invalid_params', 'Connection id must be the id shown by olympus connections list.');
      }
      db.query('UPDATE remote_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(now().toISOString(), id);
      const row = readRow(id);
      if (!row) {
        throw new OperationError('invalid_params', `No remote connection has id ${id}.`, 'Run olympus connections list.');
      }
      return toRecord(row);
    },

    verifyToken(token: string): RemoteConnectionVerification {
      const match = typeof token === 'string' ? TOKEN_PATTERN.exec(token) : null;
      if (!match) return { ok: false, reason: 'malformed' };
      const row = readRow(match[1]!);
      const presented = hashRemoteConnectionToken(token);
      // Compare against a fixed dummy when the id is unknown so both paths do
      // the same digest work.
      const stored = row ? Buffer.from(row.token_hash) : Buffer.alloc(presented.length);
      const equal = stored.length === presented.length && timingSafeEqual(stored, presented);
      if (!row || !equal) return { ok: false, reason: 'unknown' };
      if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
      const at = now();
      const lastUsedMs = row.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
      if (!Number.isFinite(lastUsedMs) || at.getTime() - lastUsedMs >= REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS) {
        try {
          db.query('UPDATE remote_connections SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL')
            .run(at.toISOString(), row.id);
          row.last_used_at = at.toISOString();
        } catch {
          // Last-use is observability; a busy database never fails an authorized call.
        }
      }
      return { ok: true, connection: toRecord(row) };
    },

    close(): void {
      closeSqliteStore(db);
    },
  };
}

function toRecord(row: ConnectionRow): RemoteConnectionRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: 'bearer',
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function requireDisplayName(value: unknown): string {
  const name = sanitizeCallerDisplayName(value);
  if (!name) {
    throw new OperationError('invalid_params', 'A connection needs a name, for example: olympus connections add muse.');
  }
  return name;
}

function remoteConnectionMigrations(): SqliteMigration[] {
  return [{
    version: REMOTE_CONNECTIONS_SCHEMA_VERSION,
    name: 'create_remote_connections',
    up(db) {
      db.exec(`
        CREATE TABLE remote_connections (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('bearer')),
          token_hash BLOB NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT
        );
      `);
    },
  }];
}

function hardenPrivateDatabasePath(dbPath: string): void {
  if (!isAbsolute(dbPath)) {
    throw new TypeError('Remote connections database path must be absolute.');
  }
  const leafDir = dirname(dbPath);
  const forbiddenLeafDirs = new Set(['/', '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', homedir()]);
  if (forbiddenLeafDirs.has(leafDir)) {
    throw new Error('Remote connections database must live inside a dedicated private leaf directory.');
  }
  mkdirSync(leafDir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(leafDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('Remote connections database leaf must be a real private directory.');
  }
  chmodSync(leafDir, 0o700);
  if (existsSync(dbPath)) {
    const dbStat = lstatSync(dbPath);
    if (dbStat.isSymbolicLink() || !dbStat.isFile()) {
      throw new Error('Remote connections database must be a regular file, not a symlink.');
    }
  }
}
