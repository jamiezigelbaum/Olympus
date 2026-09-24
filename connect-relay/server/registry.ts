/**
 * Registered installs: install id -> Ed25519 public key. Nothing else about the
 * install or its owner is stored (no IP address, no account, no email).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { installIdForPublicKey, publicKeyFromSpki } from '../shared/protocol.ts';

export interface InstallRecord {
  readonly installId: string;
  /** base64url SPKI DER of the Ed25519 install key. */
  readonly publicKey: string;
  readonly registeredAt: string;
}

export interface InstallRegistry {
  get(installId: string): InstallRecord | undefined;
  /** Idempotent for the same key. Returns false when the registry is full. */
  register(record: InstallRecord): boolean;
  size(): number;
}

export class MemoryInstallRegistry implements InstallRegistry {
  protected readonly records = new Map<string, InstallRecord>();
  constructor(private readonly maxInstalls = 100_000) {}

  get(installId: string): InstallRecord | undefined {
    return this.records.get(installId);
  }

  register(record: InstallRecord): boolean {
    if (this.records.has(record.installId)) return true;
    if (this.records.size >= this.maxInstalls) return false;
    this.records.set(record.installId, record);
    this.persist();
    return true;
  }

  size(): number {
    return this.records.size;
  }

  protected persist(): void {}
}

/** JSON file registry with atomic replace; adequate for the single-node relay this slice deploys. */
export class FileInstallRegistry extends MemoryInstallRegistry {
  constructor(private readonly path: string, maxInstalls?: number) {
    super(maxInstalls);
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { installs?: InstallRecord[] };
    for (const record of parsed.installs ?? []) {
      if (installIdForPublicKey(Buffer.from(record.publicKey, 'base64url')) !== record.installId) {
        throw new Error(`registry entry ${record.installId} does not match its key`);
      }
      this.records.set(record.installId, record);
    }
  }

  protected override persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp.${process.pid}`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, installs: [...this.records.values()] }), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export function publicKeyOf(record: InstallRecord): KeyObject {
  return publicKeyFromSpki(record.publicKey);
}
