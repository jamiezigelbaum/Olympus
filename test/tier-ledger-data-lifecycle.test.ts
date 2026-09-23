// The four-tier ledger holds item identities, account scopes and reason codes,
// so data deletion has to reach it. Every store's ledger is co-located with the
// store (`<store>.tier-ledger.sqlite`), and the lifecycle inventory enumerates
// it beside each connector store: `delete --source X` takes exactly that
// source's ledgers, and `delete --all` finds every ledger wherever its store
// was relocated (a *_DB_PATH override, XDG_DATA_HOME, the WhatsApp state dir).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger, tierLedgerPathForStore } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defaultGmailConnectorStoreDbPath } from '../src/workers/google-connectors/index.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/index.ts';
import { defaultWhatsAppConnectorStoreDbPath } from '../src/workers/whatsapp/store-sync.ts';

function seedLedger(storePath: string, provider: string): string {
  const ledgerPath = tierLedgerPathForStore(storePath);
  const ledger = new TierLedger({ dbPath: ledgerPath });
  try {
    ledger.recordDecision(
      { provider, accountScope: 'personal', providerItemId: `${provider}-1` },
      classifyItemTiers({ signals: { title: 'x' }, text: 'weekly notes' }),
    );
  } finally {
    ledger.close();
  }
  return ledgerPath;
}

function fixture(): { dir: string; homeDir: string; env: Record<string, string>; paths: { gmail: string; readwise: string; whatsapp: string } } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-ledger-lifecycle-'));
  const homeDir = join(dir, 'home');
  const env = {
    HOME: homeDir,
    XDG_DATA_HOME: join(dir, 'xdg-data'),
    // Relocated outside every Olympus root.
    OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_DB_PATH: join(dir, 'elsewhere', 'readwise.sqlite'),
    OLYMPUS_WHATSAPP_STATE_DIR: join(homeDir, '.local', 'state', 'olympus', 'whatsapp-moved'),
  };
  const paths = {
    gmail: defaultGmailConnectorStoreDbPath(env),
    readwise: defaultReadwiseConnectorStoreDbPath(env),
    whatsapp: defaultWhatsAppConnectorStoreDbPath(env),
  };
  return { dir, homeDir, env, paths };
}

describe('tier ledgers are covered by data deletion', () => {
  test('each store has its own co-located ledger', () => {
    expect(tierLedgerPathForStore('/data/gmail-connector-store.sqlite')).toBe('/data/gmail-connector-store.tier-ledger.sqlite');
    expect(tierLedgerPathForStore('/state/whatsapp/connector-store.db')).toBe('/state/whatsapp/connector-store.db.tier-ledger.sqlite');
    expect(tierLedgerPathForStore(':memory:')).toBe(':memory:');
  });

  test('a store opens its ledger beside itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-ledger-colocated-'));
    try {
      const storePath = join(dir, 'moved', 'store.sqlite');
      const store = new LocalConnectorStore({ dbPath: storePath, corpusId: 'secure_local.fixture.files', family: 'file', trustDomain: 'secure_local' });
      try {
        expect(store.tierLedger()?.dbPath).toBe(join(dir, 'moved', 'store.tier-ledger.sqlite'));
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --source takes that source ledger rows, including a relocated store, and nothing else', () => {
    const { dir, homeDir, env, paths } = fixture();
    try {
      const gmailLedger = seedLedger(paths.gmail, 'gmail');
      const readwiseLedger = seedLedger(paths.readwise, 'readwise');

      deleteOlympusData({ sourceId: 'readwise.library', homeDir, env });
      expect(existsSync(readwiseLedger)).toBe(false);
      expect(existsSync(gmailLedger)).toBe(true);

      deleteOlympusData({ sourceId: 'gmail.email', homeDir, env });
      expect(existsSync(gmailLedger)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('delete --all finds every ledger: XDG, a *_DB_PATH override and the WhatsApp state dir', () => {
    const { dir, homeDir, env, paths } = fixture();
    try {
      const ledgers = Object.entries(paths).map(([name, storePath]) => [name, seedLedger(storePath, name)] as const);
      for (const [, ledgerPath] of ledgers) expect(existsSync(ledgerPath)).toBe(true);

      deleteOlympusData({ all: true, homeDir, env });

      for (const [name, ledgerPath] of ledgers) {
        expect(`${name}:${existsSync(ledgerPath)}`).toBe(`${name}:false`);
        expect(existsSync(`${ledgerPath}-wal`)).toBe(false);
        expect(existsSync(`${ledgerPath}-shm`)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
