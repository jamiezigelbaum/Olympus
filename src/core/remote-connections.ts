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
import { readWorkerSetupEnv } from './worker-auth.ts';
import { sanitizeCallerDisplayName } from './operation-caller.ts';
import {
  assertSqliteSchemaCanOpen,
  readSqliteSchemaVersion,
  runSqliteMigrations,
  type SqliteMigration,
} from './sqlite-migrations.ts';
import { closeSqliteStore } from './sqlite-store.ts';
import { createRemoteOAuthStore, remoteOAuthSchemaMigration, type RemoteOAuthStore } from './remote-oauth-store.ts';

export const REMOTE_CONNECTIONS_STORE_ID = 'remote-connections';
export const REMOTE_CONNECTIONS_SCHEMA_VERSION = 2;
export const REMOTE_CONNECTION_TOKEN_PREFIX = 'olympus_conn_';
/** How stale `last_used_at` may get before a successful call rewrites it. */
export const REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS = 60_000;

const STORE_BUSY_TIMEOUT_MS = 10_000;
const LAST_USED_BUSY_TIMEOUT_MS = 50;
const CONNECTION_ID_BYTES = 9;
const CONNECTION_SECRET_BYTES = 32;
const CONNECTION_ID_PATTERN = /^[a-f0-9]{18}$/;
const TOKEN_PATTERN = /^olympus_conn_([a-f0-9]{18})_([A-Za-z0-9_-]{43})$/;

/** `bearer`: a token from `olympus connections add`. `oauth`: an OAuth grant. */
export type RemoteConnectionKind = 'bearer' | 'oauth';

export interface RemoteConnectionRecord {
  id: string;
  displayName: string;
  kind: RemoteConnectionKind;
  /** The OAuth client the grant was issued to (oauth connections only). */
  clientId: string | null;
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
  /** OAuth grants, tokens, registered clients and pairing codes (same database). */
  readonly oauth: RemoteOAuthStore;
  close(): void;
}

interface ConnectionRow {
  id: string;
  display_name: string;
  kind: string;
  token_hash: Uint8Array | null;
  client_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export const REMOTE_CONNECTIONS_DB_PATH_ENV = 'OLYMPUS_REMOTE_CONNECTIONS_DB_PATH';

/**
 * Where the schema v1 database is copied before migration 2 (OAuth grants)
 * rewrites it. An older Olympus refuses a v2 database by design, so rolling
 * back to one means restoring this copy while the worker is stopped:
 *
 *   cp remote-connections.sqlite.pre-v2.bak remote-connections.sqlite
 *   rm -f remote-connections.sqlite-wal remote-connections.sqlite-shm
 *
 * Connections approved after the upgrade (OAuth grants, new bearer tokens)
 * are not in the copy; revoked ones are active again, so revoke them anew.
 */
export function remoteConnectionsPreV2BackupPath(dbPath: string): string {
  return `${dbPath}.pre-v2.bak`;
}

/**
 * Where the connection database lives for a process with this environment:
 * an explicit `OLYMPUS_REMOTE_CONNECTIONS_DB_PATH`, else the shared Olympus
 * data directory. The worker calls this with its own environment (the service
 * environment with worker.env layered in).
 */
export function resolveRemoteConnectionsDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[REMOTE_CONNECTIONS_DB_PATH_ENV]?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new TypeError(`${REMOTE_CONNECTIONS_DB_PATH_ENV} must be an absolute path.`);
    }
    return explicit;
  }
  return defaultRemoteConnectionsDbPath(env);
}

/**
 * The database the managed worker uses, as seen from an owner's shell.
 *
 * The shell's XDG_DATA_HOME is not the worker's: the supervised worker runs
 * with the service environment plus worker.env. So on a managed install the
 * path keys come from worker.env, the way the CLI already finds the worker's
 * auth token there. An explicit path in the shell still wins, because that is
 * the owner saying which database they mean. With no worker.env (a source
 * checkout, a foreground worker) the shell environment is the worker's.
 */
export function resolveRemoteConnectionsDbPathForCli(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env[REMOTE_CONNECTIONS_DB_PATH_ENV]?.trim();
  if (explicit) return resolveRemoteConnectionsDbPath({ [REMOTE_CONNECTIONS_DB_PATH_ENV]: explicit });
  // Located only from a HOME in the environment handed in, like
  // environmentWithWorkerSetupEnv: a scoped environment never reads the
  // process owner's install by accident.
  const workerEnv = env.HOME?.trim() ? readWorkerSetupEnv({ env }) : undefined;
  if (!workerEnv) return resolveRemoteConnectionsDbPath(env);
  return resolveRemoteConnectionsDbPath({
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(workerEnv[REMOTE_CONNECTIONS_DB_PATH_ENV] ? { [REMOTE_CONNECTIONS_DB_PATH_ENV]: workerEnv[REMOTE_CONNECTIONS_DB_PATH_ENV] } : {}),
    ...(workerEnv.XDG_DATA_HOME ? { XDG_DATA_HOME: workerEnv.XDG_DATA_HOME } : {}),
  });
}

export function defaultRemoteConnectionsDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.XDG_DATA_HOME?.trim();
  const dataRoot = configured || join(env.HOME?.trim() || homedir(), '.local', 'share');
  if (!isAbsolute(dataRoot)) {
    throw new TypeError('Remote connections XDG_DATA_HOME must be an absolute private data root.');
  }
  return join(dataRoot, 'openclaw', 'olympus', 'remote-connections.sqlite');
}

/** Shape check only; lets the endpoint refuse garbage without touching the store. */
export function isWellFormedRemoteConnectionToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
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
    db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}; PRAGMA secure_delete = ON; PRAGMA journal_mode = WAL;`);
    assertSqliteSchemaCanOpen(db, REMOTE_CONNECTIONS_STORE_ID, REMOTE_CONNECTIONS_SCHEMA_VERSION);
    backupBeforeOAuthMigration(db, dbPath);
    runSqliteMigrations(db, REMOTE_CONNECTIONS_STORE_ID, remoteConnectionMigrations());
  } catch (error) {
    closeSqliteStore(db);
    throw error;
  }

  let closed = false;
  // Last use is observability. It is written best-effort with a short lock
  // wait, so a busy database (the CLI mid-write) never blocks or fails an
  // authorized call; a skipped write is retried by the next call.
  const recordLastUse = (id: string, at: string): void => {
    if (closed) return;
    try {
      db.exec(`PRAGMA busy_timeout = ${LAST_USED_BUSY_TIMEOUT_MS};`);
      try {
        db.query('UPDATE remote_connections SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id);
      } finally {
        db.exec(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS};`);
      }
    } catch {
      // Deliberately swallowed; see above.
    }
  };

  const readRow = (id: string): ConnectionRow | null =>
    db.query('SELECT * FROM remote_connections WHERE id = ?').get(id) as ConnectionRow | null;

  return {
    dbPath,

    oauth: createRemoteOAuthStore(db, now, (id, at) => {
      const row = readRow(id);
      const lastUsedMs = row?.last_used_at ? Date.parse(row.last_used_at) : Number.NaN;
      if (!Number.isFinite(lastUsedMs) || at.getTime() - lastUsedMs >= REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS) {
        recordLastUse(id, at.toISOString());
      }
    }),

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
      db.transaction(() => {
        db.query('UPDATE remote_connections SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
          .run(now().toISOString(), id);
        // An OAuth grant's access and refresh tokens die with it.
        db.query('DELETE FROM remote_oauth_tokens WHERE connection_id = ?').run(id);
      })();
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
      // Compare against a fixed dummy when the id is unknown (or names an OAuth
      // grant, which has no bearer secret) so every path does the same work.
      const bearer = row && row.kind === 'bearer' && row.token_hash ? row : null;
      const stored = bearer ? Buffer.from(bearer.token_hash!) : Buffer.alloc(presented.length);
      const equal = stored.length === presented.length && timingSafeEqual(stored, presented);
      if (!bearer || !equal) return { ok: false, reason: 'unknown' };
      if (bearer.revoked_at !== null) return { ok: false, reason: 'revoked' };
      const at = now();
      const lastUsedMs = bearer.last_used_at ? Date.parse(bearer.last_used_at) : Number.NaN;
      if (!Number.isFinite(lastUsedMs) || at.getTime() - lastUsedMs >= REMOTE_CONNECTION_LAST_USED_RESOLUTION_MS) {
        recordLastUse(bearer.id, at.toISOString());
      }
      return { ok: true, connection: toRecord(bearer) };
    },

    close(): void {
      closed = true;
      closeSqliteStore(db);
    },
  };
}

function toRecord(row: ConnectionRow): RemoteConnectionRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind === 'oauth' ? 'oauth' : 'bearer',
    clientId: row.client_id ?? null,
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
    version: 1,
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
  }, remoteOAuthSchemaMigration(2)];
}

/**
 * A consistent copy (VACUUM INTO reads through the WAL) of a v1 database,
 * taken once, before migration 2 runs. An existing copy is never overwritten:
 * the first one is the pre-upgrade state.
 */
function backupBeforeOAuthMigration(db: Database, dbPath: string): void {
  if (readSqliteSchemaVersion(db, REMOTE_CONNECTIONS_STORE_ID) !== 1) return;
  const backupPath = remoteConnectionsPreV2BackupPath(dbPath);
  if (existsSync(backupPath)) return;
  db.query('VACUUM INTO ?').run(backupPath);
  chmodSync(backupPath, 0o600);
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
