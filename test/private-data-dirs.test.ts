import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { writeEmbeddingOperatorOverride } from '../src/workers/dashboard/embedding-runtime.ts';

// A host whose services run under umask 002 (the olympus-test demo box,
// 2026-10-10) created ~/.local/share/olympus group-writable through the
// WhatsApp connector store, and `olympus zkapi install-tools` then refused the
// folder. Olympus's data folders are owner-only whatever the umask says.
const roots: string[] = [];
let previousUmask: number | undefined;

afterEach(() => {
  if (previousUmask !== undefined) process.umask(previousUmask);
  previousUmask = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function permissiveRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-private-dirs-'));
  roots.push(root);
  previousUmask = process.umask(0o002);
  return root;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('Olympus data folders under a group-writable umask', () => {
  test('the connector store creates every missing folder owner-only', () => {
    const root = permissiveRoot();
    const olympus = join(root, 'share', 'olympus');
    const store = new LocalConnectorStore({
      dbPath: join(olympus, 'whatsapp-live', 'connector-store.db'),
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    store.close();

    expect(mode(join(root, 'share'))).toBe(0o700);
    expect(mode(olympus)).toBe(0o700);
    expect(mode(join(olympus, 'whatsapp-live'))).toBe(0o700);
  });

  test('the embedding operator override creates its folder owner-only', () => {
    const root = permissiveRoot();
    const dir = join(root, 'state', 'olympus');
    writeEmbeddingOperatorOverride(join(dir, 'override'), true);

    expect(mode(dir)).toBe(0o700);
  });
});
