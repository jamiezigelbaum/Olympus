/**
 * Registered installs: install id -> Ed25519 public key, plus the timestamps
 * the relay needs to expire unused registrations. Nothing else about the
 * install or its owner is stored (no IP address, no account, no email).
 *
 * A registration that never starts certificate issuance is dropped after
 * `unactivatedTtlMs`; one with no session for `inactiveTtlMs` is dropped with
 * its address record. That keeps a registration flood from filling the
 * registry or the DNS zone permanently.
 *
 * The operator can revoke an install (`server/admin.ts revoke`): its record
 * goes, its address record is queued for removal, and its id is refused at
 * registration from then on, since an install otherwise re-registers itself
 * automatically. `restore` lifts that.
 */
import { appendFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { installIdForPublicKey, publicKeyFromSpki } from '../shared/protocol.ts';

export interface InstallRecord {
  readonly installId: string;
  /** base64url SPKI DER of the Ed25519 install key. */
  readonly publicKey: string;
  readonly registeredAt: number;
  lastSeenAt: number;
  /** Set once the install starts certificate issuance (its first ACME TXT publish). */
  activatedAt?: number;
  /** The relay created an explicit address record for this install. */
  hasAddressRecord?: boolean;
}

export interface InstallRegistry {
  get(installId: string): InstallRecord | undefined;
  /** Idempotent for the same key. Returns false when the registry is full. */
  register(installId: string, publicKey: string): boolean;
  /** Records a session start. */
  seen(installId: string): void;
  activate(installId: string): void;
  markAddressRecord(installId: string): void;
  addressRecordCount(): number;
  /**
   * Removes expired registrations and returns them. An install with a live
   * session (`isLive`) is never expired as unactivated.
   */
  expire(now: number, ttl: { unactivatedMs: number; inactiveMs: number }, isLive?: (installId: string) => boolean): InstallRecord[];
  /** Address records of removed installs that still exist in DNS (still counted against the cap). */
  pendingAddressRemovals(): string[];
  /** The address record for `installId` is gone from DNS. */
  addressRemoved(installId: string): void;
  /** A live install's address record was deleted from DNS; the next publish re-creates it. */
  addressLost(installId: string): void;
  /** Removes the install (if registered) and refuses its id from now on. False if already revoked. */
  revoke(installId: string): boolean;
  /** Lets a revoked id register again. False if it was not revoked. */
  restore(installId: string): boolean;
  isRevoked(installId: string): boolean;
  counts(): RegistryCounts;
  size(): number;
  /** Resolves when every accepted change is durable. */
  flush(): Promise<void>;
}

/** Aggregate numbers only: safe to print, names no install. */
export interface RegistryCounts {
  readonly registered: number;
  readonly activated: number;
  readonly addressRecords: number;
  readonly pendingAddressRemovals: number;
  readonly revoked: number;
}

type LogEntry =
  | { op: 'register'; installId: string; publicKey: string; at: number }
  | {
      op: 'seen' | 'activate' | 'address' | 'remove' | 'address-removed' | 'orphan-address' | 'address-lost' | 'revoke' | 'restore';
      installId: string;
      at: number;
    };

/** Rewrites of `seen` are throttled: a daily resolution is enough for a 90-day expiry. */
const SEEN_RESOLUTION_MS = 24 * 60 * 60_000;

export class MemoryInstallRegistry implements InstallRegistry {
  protected readonly records = new Map<string, InstallRecord>();
  private addressRecords = 0;
  protected readonly orphanAddresses = new Set<string>();
  protected readonly revoked = new Set<string>();

  constructor(
    private readonly maxInstalls = 100_000,
    protected readonly now: () => number = Date.now,
  ) {}

  get(installId: string): InstallRecord | undefined {
    return this.records.get(installId);
  }

  register(installId: string, publicKey: string): boolean {
    if (this.revoked.has(installId)) return false;
    if (this.records.has(installId)) return true;
    if (this.records.size >= this.maxInstalls) return false;
    const at = this.now();
    this.apply({ op: 'register', installId, publicKey, at });
    this.append({ op: 'register', installId, publicKey, at });
    return true;
  }

  seen(installId: string): void {
    const record = this.records.get(installId);
    if (!record) return;
    const at = this.now();
    const stale = at - record.lastSeenAt >= SEEN_RESOLUTION_MS;
    record.lastSeenAt = at;
    if (stale) this.append({ op: 'seen', installId, at });
  }

  activate(installId: string): void {
    const record = this.records.get(installId);
    if (!record || record.activatedAt !== undefined) return;
    const entry: LogEntry = { op: 'activate', installId, at: this.now() };
    this.apply(entry);
    this.append(entry);
  }

  markAddressRecord(installId: string): void {
    const record = this.records.get(installId);
    if (!record || record.hasAddressRecord) return;
    const entry: LogEntry = { op: 'address', installId, at: this.now() };
    this.apply(entry);
    this.append(entry);
  }

  addressRecordCount(): number {
    return this.addressRecords;
  }

  expire(now: number, ttl: { unactivatedMs: number; inactiveMs: number }, isLive: (installId: string) => boolean = () => false): InstallRecord[] {
    const expired: InstallRecord[] = [];
    for (const record of this.records.values()) {
      const unactivated =
        record.activatedAt === undefined && now - record.registeredAt > ttl.unactivatedMs && !isLive(record.installId);
      const inactive = now - record.lastSeenAt > ttl.inactiveMs;
      if (unactivated || inactive) expired.push(record);
    }
    for (const record of expired) {
      const entry: LogEntry = { op: 'remove', installId: record.installId, at: now };
      this.apply(entry);
      this.append(entry);
    }
    return expired;
  }

  pendingAddressRemovals(): string[] {
    return [...this.orphanAddresses];
  }

  addressRemoved(installId: string): void {
    if (!this.orphanAddresses.has(installId)) return;
    const entry: LogEntry = { op: 'address-removed', installId, at: this.now() };
    this.apply(entry);
    this.append(entry);
  }

  addressLost(installId: string): void {
    if (!this.records.get(installId)?.hasAddressRecord) return;
    const entry: LogEntry = { op: 'address-lost', installId, at: this.now() };
    this.apply(entry);
    this.append(entry);
  }

  revoke(installId: string): boolean {
    if (this.revoked.has(installId)) return false;
    const entry: LogEntry = { op: 'revoke', installId, at: this.now() };
    this.apply(entry);
    this.append(entry);
    return true;
  }

  restore(installId: string): boolean {
    if (!this.revoked.has(installId)) return false;
    const entry: LogEntry = { op: 'restore', installId, at: this.now() };
    this.apply(entry);
    this.append(entry);
    return true;
  }

  isRevoked(installId: string): boolean {
    return this.revoked.has(installId);
  }

  counts(): RegistryCounts {
    let activated = 0;
    for (const record of this.records.values()) if (record.activatedAt !== undefined) activated += 1;
    return {
      registered: this.records.size,
      activated,
      addressRecords: this.addressRecords,
      pendingAddressRemovals: this.orphanAddresses.size,
      revoked: this.revoked.size,
    };
  }

  size(): number {
    return this.records.size;
  }

  async flush(): Promise<void> {}

  protected apply(entry: LogEntry): void {
    const record = this.records.get(entry.installId);
    switch (entry.op) {
      case 'register':
        if (installIdForPublicKey(Buffer.from(entry.publicKey, 'base64url')) !== entry.installId) {
          throw new Error(`registry entry ${entry.installId} does not match its key`);
        }
        this.records.set(entry.installId, {
          installId: entry.installId,
          publicKey: entry.publicKey,
          registeredAt: entry.at,
          lastSeenAt: entry.at,
          // A returning install reclaims its not-yet-removed address record.
          ...(this.orphanAddresses.delete(entry.installId) ? { hasAddressRecord: true } : {}),
        });
        return;
      case 'seen':
        if (record) record.lastSeenAt = Math.max(record.lastSeenAt, entry.at);
        return;
      case 'activate':
        if (record) record.activatedAt = entry.at;
        return;
      case 'address':
        if (record && !record.hasAddressRecord) {
          record.hasAddressRecord = true;
          this.addressRecords += 1;
        }
        return;
      case 'remove':
      case 'revoke':
        // The address record stays counted until DNS confirms its removal.
        if (record?.hasAddressRecord) this.orphanAddresses.add(entry.installId);
        this.records.delete(entry.installId);
        if (entry.op === 'revoke') this.revoked.add(entry.installId);
        return;
      case 'restore':
        this.revoked.delete(entry.installId);
        return;
      case 'orphan-address':
        if (!this.orphanAddresses.has(entry.installId)) {
          this.orphanAddresses.add(entry.installId);
          this.addressRecords += 1;
        }
        return;
      case 'address-lost':
        if (record?.hasAddressRecord) {
          delete record.hasAddressRecord;
          this.addressRecords -= 1;
        }
        return;
      case 'address-removed':
        if (this.orphanAddresses.delete(entry.installId)) this.addressRecords -= 1;
        return;
    }
  }

  protected append(_entry: LogEntry): void {}
}

/**
 * Append-only JSON-lines registry. Each change appends one line asynchronously
 * (serialized, so order is preserved); nothing rewrites the whole file on the
 * request path. On start the log is replayed and compacted once.
 */
export class FileInstallRegistry extends MemoryInstallRegistry {
  private writes: Promise<void> = Promise.resolve();
  private failed: Error | undefined;

  constructor(
    private readonly path: string,
    maxInstalls?: number,
    now?: () => number,
  ) {
    super(maxInstalls, now);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let entry: LogEntry;
        try {
          entry = JSON.parse(line) as LogEntry;
        } catch {
          continue; // A torn final line from a crash mid-append.
        }
        this.apply(entry);
      }
    }
    this.compact();
  }

  private compact(): void {
    const lines: string[] = [];
    for (const record of this.records.values()) {
      lines.push(JSON.stringify({ op: 'register', installId: record.installId, publicKey: record.publicKey, at: record.registeredAt }));
      if (record.lastSeenAt !== record.registeredAt) lines.push(JSON.stringify({ op: 'seen', installId: record.installId, at: record.lastSeenAt }));
      if (record.activatedAt !== undefined) lines.push(JSON.stringify({ op: 'activate', installId: record.installId, at: record.activatedAt }));
      if (record.hasAddressRecord) lines.push(JSON.stringify({ op: 'address', installId: record.installId, at: record.registeredAt }));
    }
    for (const installId of this.orphanAddresses) lines.push(JSON.stringify({ op: 'orphan-address', installId, at: 0 }));
    for (const installId of this.revoked) lines.push(JSON.stringify({ op: 'revoke', installId, at: 0 }));
    const temporary = `${this.path}.tmp.${process.pid}`;
    writeFileSync(temporary, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  protected override append(entry: LogEntry): void {
    this.writes = this.writes.then(() =>
      appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 }).catch((error: Error) => {
        this.failed = error;
      }),
    );
  }

  override async flush(): Promise<void> {
    await this.writes;
    if (this.failed) throw this.failed;
  }
}

/**
 * Reads a registry log without writing to it (no compaction), for the admin
 * command's offline status while the relay is stopped.
 */
export function readRegistrySnapshot(path: string): MemoryInstallRegistry {
  return new RegistrySnapshot(existsSync(path) ? readFileSync(path, 'utf8') : '');
}

class RegistrySnapshot extends MemoryInstallRegistry {
  constructor(log: string) {
    super();
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.apply(JSON.parse(line) as LogEntry);
      } catch {
        // A torn line, as the file registry tolerates.
      }
    }
  }
}

/**
 * Appends a revocation to a registry log directly. Only for a relay that is
 * not running (the admin command falls back to it when the relay's socket is
 * unreachable); the relay applies it when it next starts, and its sweep then
 * removes the address record within the DNS budget.
 */
export function appendOfflineRevocation(path: string, installId: string, at = Date.now()): void {
  // After a torn final line, start a fresh one rather than extend it.
  const existing = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const separator = existing.length > 0 && existing[existing.length - 1] !== 0x0a ? '\n' : '';
  appendFileSync(path, `${separator}${JSON.stringify({ op: 'revoke', installId, at } satisfies LogEntry)}\n`, { mode: 0o600 });
}

export function publicKeyOf(record: InstallRecord): KeyObject {
  return publicKeyFromSpki(record.publicKey);
}
