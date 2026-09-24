/**
 * OAuth state for remote agent connections, kept in the connection database.
 *
 * An OAuth grant IS a connection: approving Claude, ChatGPT or Grok creates a
 * `remote_connections` row of kind `oauth`, named from the client's own
 * metadata. `olympus connections list|revoke` and audit attribution therefore
 * treat it exactly like a bearer connection, and revoking it kills every access
 * and refresh token issued under it.
 *
 * Only SHA-256 digests of tokens and pairing codes are stored. Access tokens
 * are opaque, live one hour, and are bound to the protected resource they were
 * issued for. Refresh tokens rotate on every use; presenting a used one again
 * is treated as theft and revokes the whole grant.
 *
 * Pairing codes are minted by `olympus connections pair` and prove that the
 * person approving on the (public) consent page is the owner. They expire in
 * ten minutes, work once, and are protected by a per-code and a global failure
 * lockout.
 *
 * Plain functions over a factory, like remote-connections.ts: this module is
 * reachable from the bundled CLI.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { SqliteMigration } from './sqlite-migrations.ts';

export const REMOTE_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REMOTE_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 90 * 24 * 3600;
export const REMOTE_PAIRING_CODE_TTL_MS = 10 * 60_000;
/** Failed approvals, anywhere, that burn every pairing code live at the time. */
export const REMOTE_PAIRING_CODE_MAX_FAILURES = 10;
/** Failed approvals within the window that lock all pairing until they age out. */
export const REMOTE_PAIRING_GLOBAL_MAX_FAILURES = 20;
export const REMOTE_PAIRING_GLOBAL_WINDOW_MS = 15 * 60_000;
/** Registered (DCR) clients kept at most; unused ones are pruned first. */
export const REMOTE_OAUTH_MAX_REGISTERED_CLIENTS = 500;

export const REMOTE_OAUTH_ACCESS_TOKEN_PREFIX = 'olympus_at_';
export const REMOTE_OAUTH_REFRESH_TOKEN_PREFIX = 'olympus_rt_';
const ACCESS_TOKEN_PATTERN = /^olympus_at_[A-Za-z0-9_-]{43}$/;
const REFRESH_TOKEN_PATTERN = /^olympus_rt_[A-Za-z0-9_-]{43}$/;
const REGISTERED_CLIENT_ID_PATTERN = /^olympus_client_[a-f0-9]{24}$/;

// Crockford-style: no 0/O, 1/I/L or U, so a code read off a terminal and typed
// on a phone survives. 30 symbols x 10 characters is about 49 bits.
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const PAIRING_CODE_LENGTH = 10;
const UNUSED_CLIENT_PRUNE_AGE_MS = 24 * 3600_000;

export interface MintedPairingCode {
  /** Shown once, formatted `XXXXX-XXXXX`. */
  code: string;
  expiresAt: string;
}

export type PairingCodeCheck = { ok: true } | { ok: false; reason: 'invalid' | 'locked' };

export interface RegisteredOAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

export interface IssuedOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface OAuthConnectionRef {
  id: string;
  displayName: string;
  clientId: string;
}

export type OAuthAccessTokenCheck =
  | { ok: true; connection: OAuthConnectionRef }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'wrong_audience' };

export type OAuthRefreshResult =
  | { ok: true; connection: OAuthConnectionRef; tokens: IssuedOAuthTokens }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'client_mismatch' | 'wrong_audience' | 'reused' };

export interface RemoteOAuthStore {
  mintPairingCode(): MintedPairingCode;
  checkPairingCode(input: string): PairingCodeCheck;
  registerClient(input: { clientName: string; redirectUris: string[] }): RegisteredOAuthClient | 'capacity';
  getRegisteredClient(clientId: string): RegisteredOAuthClient | undefined;
  /** Creates the connection (the grant) and its first token pair. */
  createGrant(input: { clientId: string; displayName: string; resource: string }): {
    connection: OAuthConnectionRef;
    tokens: IssuedOAuthTokens;
  };
  verifyAccessToken(token: string, resource: string): OAuthAccessTokenCheck;
  refresh(input: { refreshToken: string; clientId: string; resource: string }): OAuthRefreshResult;
  /** RFC 7009: an access token dies alone; a refresh token takes its grant with it. */
  revokeToken(token: string): void;
  revokeGrant(connectionId: string): void;
}

export function isWellFormedOAuthAccessToken(token: string): boolean {
  return ACCESS_TOKEN_PATTERN.test(token);
}

export function isWellFormedOAuthRefreshToken(token: string): boolean {
  return REFRESH_TOKEN_PATTERN.test(token);
}

export function isRegisteredOAuthClientId(value: string): boolean {
  return REGISTERED_CLIENT_ID_PATTERN.test(value);
}

/** Uppercases and drops separators; returns undefined for anything off-alphabet. */
export function normalizePairingCode(input: string): string | undefined {
  if (typeof input !== 'string' || input.length > 64) return undefined;
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const char of compact) if (!PAIRING_ALPHABET.includes(char)) return undefined;
  return compact;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function randomPairingCode(): string {
  // Rejection sampling keeps every symbol equally likely.
  const limit = 256 - (256 % PAIRING_ALPHABET.length);
  let out = '';
  while (out.length < PAIRING_CODE_LENGTH) {
    for (const byte of randomBytes(PAIRING_CODE_LENGTH * 2)) {
      if (byte >= limit) continue;
      out += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
      if (out.length === PAIRING_CODE_LENGTH) break;
    }
  }
  return out;
}

interface TokenRow {
  token_hash: Uint8Array;
  connection_id: string;
  kind: 'access' | 'refresh';
  resource: string;
  client_id: string;
  expires_at: string;
  used_at: string | null;
  display_name: string;
  revoked_at: string | null;
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
  created_at: string;
}

export function createRemoteOAuthStore(
  db: Database,
  now: () => Date,
  recordLastUse: (connectionId: string, at: Date) => void,
): RemoteOAuthStore {
  const readToken = (token: string, kind: 'access' | 'refresh'): TokenRow | null =>
    db.query(`
      SELECT t.token_hash, t.connection_id, t.kind, t.resource, t.client_id, t.expires_at, t.used_at,
             c.display_name, c.revoked_at
      FROM remote_oauth_tokens t JOIN remote_connections c ON c.id = t.connection_id
      WHERE t.token_hash = ? AND t.kind = ?
    `).get(digest(token), kind) as TokenRow | null;

  const issueTokens = (connectionId: string, clientId: string, resource: string, at: Date): IssuedOAuthTokens => {
    const accessToken = `${REMOTE_OAUTH_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const refreshToken = `${REMOTE_OAUTH_REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const insert = db.query(`
      INSERT INTO remote_oauth_tokens (token_hash, connection_id, kind, resource, client_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const createdAt = at.toISOString();
    insert.run(digest(accessToken), connectionId, 'access', resource, clientId, createdAt,
      new Date(at.getTime() + REMOTE_OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString());
    insert.run(digest(refreshToken), connectionId, 'refresh', resource, clientId, createdAt,
      new Date(at.getTime() + REMOTE_OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString());
    // Expired rows carry nothing a check still needs.
    db.query('DELETE FROM remote_oauth_tokens WHERE expires_at <= ?').run(createdAt);
    return { accessToken, refreshToken, expiresIn: REMOTE_OAUTH_ACCESS_TOKEN_TTL_SECONDS };
  };

  const revokeGrant = (connectionId: string): void => {
    db.transaction(() => {
      db.query("UPDATE remote_connections SET revoked_at = ? WHERE id = ? AND kind = 'oauth' AND revoked_at IS NULL")
        .run(now().toISOString(), connectionId);
      db.query('DELETE FROM remote_oauth_tokens WHERE connection_id = ?').run(connectionId);
    })();
  };

  const toClient = (row: ClientRow): RegisteredOAuthClient => ({
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
    createdAt: row.created_at,
  });

  return {
    mintPairingCode(): MintedPairingCode {
      const at = now();
      const code = randomPairingCode();
      const expiresAt = new Date(at.getTime() + REMOTE_PAIRING_CODE_TTL_MS).toISOString();
      db.transaction(() => {
        db.query('DELETE FROM remote_pairing_codes WHERE expires_at <= ?').run(at.toISOString());
        db.query('INSERT INTO remote_pairing_codes (code_hash, created_at, expires_at) VALUES (?, ?, ?)')
          .run(digest(code), at.toISOString(), expiresAt);
      })();
      return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresAt };
    },

    checkPairingCode(input: string): PairingCodeCheck {
      const at = now();
      const atIso = at.toISOString();
      const windowStart = new Date(at.getTime() - REMOTE_PAIRING_GLOBAL_WINDOW_MS).toISOString();
      return db.transaction((): PairingCodeCheck => {
        db.query('DELETE FROM remote_pairing_failures WHERE at <= ?').run(windowStart);
        const failures = (db.query('SELECT COUNT(*) AS n FROM remote_pairing_failures').get() as { n: number }).n;
        if (failures >= REMOTE_PAIRING_GLOBAL_MAX_FAILURES) return { ok: false, reason: 'locked' };
        const normalized = normalizePairingCode(input);
        if (normalized) {
          const consumed = db.query(`
            UPDATE remote_pairing_codes SET used_at = ?
            WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? AND failed_attempts < ?
          `).run(atIso, digest(normalized), atIso, REMOTE_PAIRING_CODE_MAX_FAILURES);
          if (consumed.changes === 1) return { ok: true };
        }
        db.query('INSERT INTO remote_pairing_failures (at) VALUES (?)').run(atIso);
        // A wrong guess cannot say which code it aimed at, so it counts against
        // every code live right now.
        db.query('UPDATE remote_pairing_codes SET failed_attempts = failed_attempts + 1 WHERE used_at IS NULL AND expires_at > ?')
          .run(atIso);
        return { ok: false, reason: 'invalid' };
      })();
    },

    registerClient(input): RegisteredOAuthClient | 'capacity' {
      const at = now();
      return db.transaction((): RegisteredOAuthClient | 'capacity' => {
        const count = (db.query('SELECT COUNT(*) AS n FROM remote_oauth_clients').get() as { n: number }).n;
        if (count >= REMOTE_OAUTH_MAX_REGISTERED_CLIENTS) {
          db.query(`
            DELETE FROM remote_oauth_clients
            WHERE created_at <= ?
              AND client_id NOT IN (SELECT client_id FROM remote_connections WHERE client_id IS NOT NULL)
          `).run(new Date(at.getTime() - UNUSED_CLIENT_PRUNE_AGE_MS).toISOString());
          const after = (db.query('SELECT COUNT(*) AS n FROM remote_oauth_clients').get() as { n: number }).n;
          if (after >= REMOTE_OAUTH_MAX_REGISTERED_CLIENTS) return 'capacity';
        }
        const clientId = `olympus_client_${randomBytes(12).toString('hex')}`;
        const createdAt = at.toISOString();
        db.query('INSERT INTO remote_oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
          .run(clientId, input.clientName, JSON.stringify(input.redirectUris), createdAt);
        return { clientId, clientName: input.clientName, redirectUris: [...input.redirectUris], createdAt };
      })();
    },

    getRegisteredClient(clientId: string): RegisteredOAuthClient | undefined {
      if (!isRegisteredOAuthClientId(clientId)) return undefined;
      const row = db.query('SELECT * FROM remote_oauth_clients WHERE client_id = ?').get(clientId) as ClientRow | null;
      return row ? toClient(row) : undefined;
    },

    createGrant(input) {
      const at = now();
      return db.transaction(() => {
        const id = randomBytes(9).toString('hex');
        db.query(`
          INSERT INTO remote_connections (id, display_name, kind, token_hash, client_id, created_at)
          VALUES (?, ?, 'oauth', NULL, ?, ?)
        `).run(id, input.displayName, input.clientId, at.toISOString());
        const tokens = issueTokens(id, input.clientId, input.resource, at);
        return { connection: { id, displayName: input.displayName, clientId: input.clientId }, tokens };
      })();
    },

    verifyAccessToken(token: string, resource: string): OAuthAccessTokenCheck {
      if (!isWellFormedOAuthAccessToken(token)) return { ok: false, reason: 'unknown' };
      const row = readToken(token, 'access');
      if (!row) return { ok: false, reason: 'unknown' };
      const at = now();
      if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
      if (Date.parse(row.expires_at) <= at.getTime()) return { ok: false, reason: 'expired' };
      // Audience binding: a token issued for another resource (for example
      // before the public address changed) opens nothing here.
      if (row.resource !== resource) return { ok: false, reason: 'wrong_audience' };
      recordLastUse(row.connection_id, at);
      return { ok: true, connection: { id: row.connection_id, displayName: row.display_name, clientId: row.client_id } };
    },

    refresh(input): OAuthRefreshResult {
      if (!isWellFormedOAuthRefreshToken(input.refreshToken)) return { ok: false, reason: 'unknown' };
      const at = now();
      return db.transaction((): OAuthRefreshResult => {
        const row = readToken(input.refreshToken, 'refresh');
        if (!row) return { ok: false, reason: 'unknown' };
        if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
        if (row.used_at !== null) {
          // Rotation reuse: someone holds a copy of an old refresh token.
          revokeGrant(row.connection_id);
          return { ok: false, reason: 'reused' };
        }
        if (Date.parse(row.expires_at) <= at.getTime()) return { ok: false, reason: 'expired' };
        if (row.client_id !== input.clientId) return { ok: false, reason: 'client_mismatch' };
        if (row.resource !== input.resource) return { ok: false, reason: 'wrong_audience' };
        db.query('UPDATE remote_oauth_tokens SET used_at = ? WHERE token_hash = ?').run(at.toISOString(), row.token_hash);
        // The previous access token retires with its refresh token.
        db.query("DELETE FROM remote_oauth_tokens WHERE connection_id = ? AND kind = 'access'").run(row.connection_id);
        const tokens = issueTokens(row.connection_id, row.client_id, row.resource, at);
        return {
          ok: true,
          connection: { id: row.connection_id, displayName: row.display_name, clientId: row.client_id },
          tokens,
        };
      })();
    },

    revokeToken(token: string): void {
      if (isWellFormedOAuthRefreshToken(token)) {
        const row = readToken(token, 'refresh');
        if (row) revokeGrant(row.connection_id);
        return;
      }
      if (isWellFormedOAuthAccessToken(token)) {
        db.query("DELETE FROM remote_oauth_tokens WHERE token_hash = ? AND kind = 'access'").run(digest(token));
      }
    },

    revokeGrant,
  };
}

/**
 * Schema v2 of the connection database: connections gain the `oauth` kind (a
 * grant, with no bearer digest of its own) and the client id it was issued to;
 * OAuth tokens, registered clients and pairing codes get their own tables.
 * SQLite cannot alter a CHECK constraint, so the connections table is rebuilt.
 */
export function remoteOAuthSchemaMigration(version: number): SqliteMigration {
  return {
    version,
    name: 'add_oauth_grants',
    up(db) {
      db.exec(`
        CREATE TABLE remote_connections_v2 (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('bearer', 'oauth')),
          token_hash BLOB UNIQUE,
          client_id TEXT,
          created_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT,
          CHECK ((kind = 'bearer' AND token_hash IS NOT NULL)
              OR (kind = 'oauth' AND token_hash IS NULL AND client_id IS NOT NULL))
        );
        INSERT INTO remote_connections_v2 (id, display_name, kind, token_hash, created_at, last_used_at, revoked_at)
          SELECT id, display_name, kind, token_hash, created_at, last_used_at, revoked_at FROM remote_connections;
        DROP TABLE remote_connections;
        ALTER TABLE remote_connections_v2 RENAME TO remote_connections;

        CREATE TABLE remote_oauth_tokens (
          token_hash BLOB PRIMARY KEY,
          connection_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('access', 'refresh')),
          resource TEXT NOT NULL,
          client_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT
        );
        CREATE INDEX remote_oauth_tokens_connection ON remote_oauth_tokens(connection_id);

        CREATE TABLE remote_oauth_clients (
          client_id TEXT PRIMARY KEY,
          client_name TEXT NOT NULL,
          redirect_uris TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE remote_pairing_codes (
          code_hash BLOB PRIMARY KEY,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          failed_attempts INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE remote_pairing_failures (at TEXT NOT NULL);
      `);
    },
  };
}
