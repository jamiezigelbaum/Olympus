/**
 * Registered installs: install id -> Ed25519 public key, plus the timestamps
 * the relay needs to expire unused registrations. Nothing else about the
 * install or its owner is stored (no IP address, no account, no email, no
 * token).
 *
 * The operator can revoke an install (`server/admin.ts revoke`): its record
 * goes and its id is refused from then on, since an install otherwise
 * re-registers itself automatically. `restore` lifts that.
 *
 * Revocation and restore are acknowledged only once their log line is
 * fsync'd. Each id's operator change is pending, failed, or durable:
 * concurrent callers share the pending write; a call after a failed write
 * writes again; and while the outcome is uncertain the id stays refused (a
 * revocation refuses it before its write starts, a restore lifts the refusal
 * only after its write is durable).
 */
import { open } from 'node:fs/promises';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { installIdForPublicKey, publicKeyFromSpki } from '../shared/protocol.ts';

export interface InstallRecord {
  readonly installId: string;
  /** base64url SPKI DER of the Ed25519 install key. */
  readonly publicKey: string;
  readonly registeredAt: number;
  lastSeenAt: number;
  /**
   * The install authenticated again after registering (a `hello`), or was
   * online at a sweep. An unconfirmed registration expires after a day.
   */
  confirmed: boolean;
}

/** Aggregate numbers only: safe to print, names no install. */
export interface RegistryCounts {
  readonly registered: number;
  readonly revoked: number;
}

/** Where an id's last operator change stands. */
export type OperatorChangeState = 'none' | 'pending' | 'failed' | 'durable';

type OperatorOp = 'revoke' | 'restore';

/**
 * `register` entries written before confirmation existed carry no
 * `unconfirmed` flag and load as confirmed: installs already in a registry
 * keep their 90-day expiry.
 */
export type LogEntry =
  | { op: 'register'; installId: string; publicKey: string; at: number; unconfirmed?: true }
  | { op: 'seen' | 'confirm' | 'remove' | 'revoke' | 'restore'; installId: string; at: number };

/** Expired ids remembered, so their return is told apart from a new registration. */
const MAX_REMEMBERED_REMOVALS = 20_000;

/** Rewrites of `seen` are throttled: a daily resolution is enough for a 90-day expiry. */
const SEEN_RESOLUTION_MS = 24 * 60 * 60_000;

export class MemoryInstallRegistry {
  protected readonly records = new Map<string, InstallRecord>();
  protected readonly revoked = new Set<string>();
  /** Ids that were registered here and expired, oldest first (bounded). */
  protected readonly removed = new Set<string>();
  /** Operator changes whose write has not finished. */
  private readonly pendingChanges = new Map<string, { op: OperatorOp; promise: Promise<boolean> }>();
  /** Operator changes whose write failed and was not retried successfully since. */
  private readonly failedChanges = new Map<string, OperatorOp>();

  constructor(
    private readonly maxInstalls = 100_000,
    protected readonly now: () => number = Date.now,
  ) {}

  get(installId: string): InstallRecord | undefined {
    return this.records.get(installId);
  }

  /** Idempotent for the same key. False when the id is revoked or the registry is full. */
  register(installId: string, publicKey: string): boolean {
    if (this.revoked.has(installId)) return false;
    if (this.records.has(installId)) return true;
    if (this.records.size >= this.maxInstalls) return false;
    const entry: LogEntry = { op: 'register', installId, publicKey, at: this.now(), unconfirmed: true };
    this.apply(entry);
    void this.append(entry).catch(() => {});
    return true;
  }

  /** True when this id was registered here before and expired since (a returning install). */
  wasRemoved(installId: string): boolean {
    return this.removed.has(installId);
  }

  /** The install authenticated with `hello`: its registration keeps the long expiry from now on. */
  confirm(installId: string): void {
    const record = this.records.get(installId);
    if (!record || record.confirmed) return;
    const entry: LogEntry = { op: 'confirm', installId, at: this.now() };
    this.apply(entry);
    void this.append(entry).catch(() => {});
  }

  /** Records a session start or heartbeat. */
  seen(installId: string): void {
    const record = this.records.get(installId);
    if (!record) return;
    const at = this.now();
    const stale = at - record.lastSeenAt >= SEEN_RESOLUTION_MS;
    record.lastSeenAt = at;
    if (stale) void this.append({ op: 'seen', installId, at }).catch(() => {});
  }

  /**
   * Removes registrations with no session for `inactiveMs`, and unconfirmed
   * ones older than `unconfirmedMs` with no session, and returns their ids.
   * An unconfirmed install that is online is confirmed instead.
   */
  expire(
    now: number,
    inactiveMs: number,
    isLive: (installId: string) => boolean = () => false,
    unconfirmedMs = Number.POSITIVE_INFINITY,
  ): string[] {
    const expired: string[] = [];
    for (const record of [...this.records.values()]) {
      const live = isLive(record.installId);
      if (!record.confirmed && live) {
        this.confirm(record.installId);
        continue;
      }
      if (live) continue;
      if (now - record.lastSeenAt > inactiveMs || (!record.confirmed && now - record.registeredAt > unconfirmedMs)) {
        expired.push(record.installId);
      }
    }
    for (const installId of expired) {
      const entry: LogEntry = { op: 'remove', installId, at: now };
      this.apply(entry);
      void this.append(entry).catch(() => {});
    }
    return expired;
  }

  /**
   * Removes the install (if registered) and refuses its id from now on; the
   * refusal takes effect before this returns. Resolves true once the
   * revocation is durable, false if it already was; rejects if the write
   * failed (the id stays refused, and the next call writes again).
   */
  revoke(installId: string): Promise<boolean> {
    const pending = this.pendingChanges.get(installId);
    if (pending?.op === 'revoke') return pending.promise;
    if (pending) {
      // A restore is being written; until it is durable the id is still
      // refused. Revoke once it settles, whichever way.
      return pending.promise.then(() => this.revoke(installId), () => this.revoke(installId));
    }
    if (this.revoked.has(installId) && !this.failedChanges.has(installId)) return Promise.resolve(false);
    const entry: LogEntry = { op: 'revoke', installId, at: this.now() };
    this.apply(entry);
    return this.write(installId, 'revoke', entry, () => {});
  }

  /**
   * Lets a revoked id register again. Resolves true once the restore is
   * durable (the id is refused until then), false if it was not revoked;
   * rejects if the write failed (still refused; the next call writes again).
   */
  restore(installId: string): Promise<boolean> {
    const pending = this.pendingChanges.get(installId);
    if (pending?.op === 'restore') return pending.promise;
    if (pending) return pending.promise.then(() => this.restore(installId), () => this.restore(installId));
    if (!this.revoked.has(installId)) return Promise.resolve(false);
    const entry: LogEntry = { op: 'restore', installId, at: this.now() };
    return this.write(installId, 'restore', entry, () => this.apply(entry));
  }

  /** Where `installId`'s last operator change stands. */
  operatorChangeState(installId: string): OperatorChangeState {
    if (this.pendingChanges.has(installId)) return 'pending';
    if (this.failedChanges.has(installId)) return 'failed';
    return this.revoked.has(installId) ? 'durable' : 'none';
  }

  private write(installId: string, op: OperatorOp, entry: LogEntry, onDurable: () => void): Promise<boolean> {
    this.failedChanges.delete(installId);
    const promise = this.append(entry).then(
      () => {
        this.pendingChanges.delete(installId);
        onDurable();
        return true;
      },
      (error: unknown) => {
        this.pendingChanges.delete(installId);
        this.failedChanges.set(installId, op);
        throw error;
      },
    );
    this.pendingChanges.set(installId, { op, promise });
    return promise;
  }

  isRevoked(installId: string): boolean {
    return this.revoked.has(installId);
  }

  counts(): RegistryCounts {
    return { registered: this.records.size, revoked: this.revoked.size };
  }

  /** Resolves when every accepted change is durable; rejects if one failed. */
  async flush(): Promise<void> {}

  protected apply(entry: LogEntry): void {
    switch (entry.op) {
      case 'register':
        if (installIdForPublicKey(Buffer.from(entry.publicKey, 'base64url')) !== entry.installId) {
          throw new Error('a registry entry does not match its key');
        }
        this.records.set(entry.installId, {
          installId: entry.installId,
          publicKey: entry.publicKey,
          registeredAt: entry.at,
          lastSeenAt: entry.at,
          confirmed: entry.unconfirmed !== true,
        });
        this.removed.delete(entry.installId);
        return;
      case 'confirm': {
        const record = this.records.get(entry.installId);
        if (record) record.confirmed = true;
        return;
      }
      case 'seen': {
        const record = this.records.get(entry.installId);
        if (record) record.lastSeenAt = Math.max(record.lastSeenAt, entry.at);
        return;
      }
      case 'remove':
        this.records.delete(entry.installId);
        this.removed.delete(entry.installId);
        this.removed.add(entry.installId);
        if (this.removed.size > MAX_REMEMBERED_REMOVALS) this.removed.delete(this.removed.values().next().value!);
        return;
      case 'revoke':
        this.records.delete(entry.installId);
        this.revoked.add(entry.installId);
        return;
      case 'restore':
        this.revoked.delete(entry.installId);
        return;
    }
  }

  protected async append(_entry: LogEntry): Promise<void> {}
}

/**
 * Append-only JSON-lines registry. Each change appends one line and fsyncs
 * (serialized, so order is preserved); nothing rewrites the whole file on the
 * request path. On start the log is replayed and compacted once.
 */
export class FileInstallRegistry extends MemoryInstallRegistry {
  private writes: Promise<void> = Promise.resolve();
  private failed: Error | undefined;
  /** A write failed and may have left a partial line: the next one starts on a fresh line. */
  private torn = false;

  constructor(
    private readonly path: string,
    maxInstalls?: number,
    now?: () => number,
  ) {
    super(maxInstalls, now);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      for (const entry of parseLog(readFileSync(path, 'utf8'))) {
        try {
          this.apply(entry);
        } catch {
          // An entry whose id does not match its key is dropped by compaction.
        }
      }
    }
    this.compact();
  }

  private compact(): void {
    const lines: string[] = [];
    // Remembered removals (expired ids), oldest first, so a returning
    // install is still told apart after a restart.
    for (const installId of this.removed) {
      lines.push(JSON.stringify({ op: 'remove', installId, at: 0 }));
    }
    for (const record of this.records.values()) {
      lines.push(JSON.stringify({
        op: 'register',
        installId: record.installId,
        publicKey: record.publicKey,
        at: record.registeredAt,
        ...(record.confirmed ? {} : { unconfirmed: true }),
      }));
      if (record.lastSeenAt !== record.registeredAt) lines.push(JSON.stringify({ op: 'seen', installId: record.installId, at: record.lastSeenAt }));
    }
    for (const installId of this.revoked) lines.push(JSON.stringify({ op: 'revoke', installId, at: 0 }));
    const temporary = `${this.path}.tmp.${process.pid}`;
    writeFileSync(temporary, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    fsyncPath(temporary);
    renameSync(temporary, this.path);
  }

  protected override append(entry: LogEntry): Promise<void> {
    const write = this.writes.then(async () => {
      const handle = await open(this.path, 'a', 0o600);
      try {
        await handle.write(`${this.torn ? '\n' : ''}${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.torn = false;
    });
    // A failed append is remembered (flush rethrows it) and does not stall later ones.
    this.writes = write.catch((error: Error) => {
      this.failed = error;
      this.torn = true;
    });
    return write;
  }

  override async flush(): Promise<void> {
    await this.writes;
    if (this.failed) throw this.failed;
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parseLog(log: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // A torn final line from a crash mid-append.
    }
  }
  return entries;
}

/** Reads a registry log without writing to it, for the admin command while the relay is stopped. */
export function readRegistrySnapshot(path: string): MemoryInstallRegistry {
  const snapshot = new RegistrySnapshot();
  if (existsSync(path)) snapshot.load(parseLog(readFileSync(path, 'utf8')));
  return snapshot;
}

class RegistrySnapshot extends MemoryInstallRegistry {
  load(entries: LogEntry[]): void {
    for (const entry of entries) {
      try {
        this.apply(entry);
      } catch {
        // A malformed entry, as the file registry would drop it.
      }
    }
  }
}

/**
 * Appends a revocation to a registry log directly, fsync'd. Only for a relay
 * that is not running (the admin command falls back to it when the relay's
 * socket is unreachable); the relay applies it when it next starts.
 */
export function appendOfflineRevocation(path: string, installId: string, at = Date.now()): void {
  // After a torn final line, start a fresh one rather than extend it.
  const existing = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const separator = existing.length > 0 && existing[existing.length - 1] !== 0x0a ? '\n' : '';
  appendFileSync(path, `${separator}${JSON.stringify({ op: 'revoke', installId, at } satisfies LogEntry)}\n`, { mode: 0o600 });
  fsyncPath(path);
}

export function publicKeyOf(record: InstallRecord): KeyObject {
  return publicKeyFromSpki(record.publicKey);
}
