/**
 * Registered installs: install id -> Ed25519 public key, plus the timestamps
 * the relay needs to expire unused registrations. Nothing else about the
 * install or its owner is stored (no IP address, no account, no email).
 *
 * A registration that never starts certificate issuance is dropped after
 * `unactivatedTtlMs`; one with no session for `inactiveTtlMs` is dropped with
 * its address record. That keeps a registration flood from filling the
 * registry or the DNS zone permanently.
 */
import { appendFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /** Removes expired registrations and returns them. */
  expire(now: number, ttl: { unactivatedMs: number; inactiveMs: number }): InstallRecord[];
  size(): number;
  /** Resolves when every accepted change is durable. */
  flush(): Promise<void>;
}

type LogEntry =
  | { op: 'register'; installId: string; publicKey: string; at: number }
  | { op: 'seen' | 'activate' | 'address' | 'remove'; installId: string; at: number };

/** Rewrites of `seen` are throttled: a daily resolution is enough for a 90-day expiry. */
const SEEN_RESOLUTION_MS = 24 * 60 * 60_000;

export class MemoryInstallRegistry implements InstallRegistry {
  protected readonly records = new Map<string, InstallRecord>();
  private addressRecords = 0;

  constructor(
    private readonly maxInstalls = 100_000,
    protected readonly now: () => number = Date.now,
  ) {}

  get(installId: string): InstallRecord | undefined {
    return this.records.get(installId);
  }

  register(installId: string, publicKey: string): boolean {
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

  expire(now: number, ttl: { unactivatedMs: number; inactiveMs: number }): InstallRecord[] {
    const expired: InstallRecord[] = [];
    for (const record of this.records.values()) {
      const unactivated = record.activatedAt === undefined && now - record.registeredAt > ttl.unactivatedMs;
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
        if (record?.hasAddressRecord) this.addressRecords -= 1;
        this.records.delete(entry.installId);
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

export function publicKeyOf(record: InstallRecord): KeyObject {
  return publicKeyFromSpki(record.publicKey);
}
