// Historical store placement has no authority over the per-item judge.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
  createTelegramCaptureSpoolConnector,
  createTelegramConnectorStoreSyncHandler,
  type TelegramConnectorStores,
} from '../src/workers/telegram-messages/index.ts';
import { AMPLE_DISK_SPACE } from './helpers/disk-space.ts';
import {
  parseTelegramTrustReconcileCliArgs,
  runTelegramTrustReconcile,
} from '../scripts/telegram-trust-reconcile.ts';

const ACCOUNT = 'telegram.personal';
// The legacy captures sit in files dated BEFORE the live spool's, so the lane
// cursors the fabrication leaves behind resume cleanly into the live file.
const LEGACY_SPOOL_FILE = '2026-08-25.jsonl';
const LIVE_SPOOL_FILE = '2026-08-26.jsonl';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('capture leaves an existing Personal copy intact when an old secure copy also exists', async () => {
  const fixture = createFixture();
  try {
    await fabricatePreInvariantState(fixture, { duplicated: [['lawyer', '9']] });
    const receipt = await fixture.sync().pull();
    expect(receipt.counts.trust_conflict_evictions).toBe(0);
    expect(fixture.stores.internal.status().counts.items).toBe(1);
    expect(fixture.stores.secureLocal.status().counts.items).toBe(1);
    expect(fixture.stores.internal.lastCompletedSyncRun(TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID)).toBeUndefined();
  } finally { fixture.close(); }
});

describe('store-level trust reconciliation guards', () => {
  // Two handles on one database pass the object-identity check; without the
  // device+inode refusal the sweep would read the store's own rows as the
  // stricter store's claims and tombstone every one of them.
  test('refuses one database presented as both stores', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, { internalOnly: [['porto', '1']] });
    const alias = new LocalConnectorStore({
      dbPath: fixture.internalDbPath,
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
      readOnly: true,
    });
    try {
      expect(() => fixture.stores.internal.reconcileAgainstStricterStore({
        stricter: alias,
        reconcileConnectorId: TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
        evictionSyncConnectorId: 'fixture_trust_eviction',
        ownerConnectorId: 'fixture_owner',
        ownershipKind: 'observed',
      })).toThrow(/one database as both stores/);
      expect(fixture.stores.internal.status().counts.items).toBe(1);
    } finally {
      alias.close();
      fixture.close();
    }
  });

  // The sweep's resume position must follow insertion order, not wall-clock
  // order: a future-dated window row would otherwise shadow every newer
  // cursor and the completion marker after the clock is corrected.
  test('resumes from the newest position row across a wall-clock rollback', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, { secureOnly: [['lawyer', '1'], ['lawyer', '2']] });
    let clock = new Date('2030-01-01T00:00:00.000Z');
    const internal = new LocalConnectorStore({
      dbPath: fixture.internalDbPath,
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
      now: () => clock,
    });
    try {
      const reconcile = (maxWindows: number) => internal.reconcileAgainstStricterStore({
        stricter: fixture.stores.secureLocal,
        reconcileConnectorId: TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
        evictionSyncConnectorId: 'fixture_trust_eviction',
        ownerConnectorId: 'fixture_owner',
        ownershipKind: 'observed',
        maxItems: 1,
        maxWindows,
      });
      expect(reconcile(1).state).toBe('in_progress');
      clock = new Date('2026-09-01T00:00:00.000Z');
      expect(reconcile(2).state).toBe('ready');
      const settled = reconcile(1);
      expect(settled.state).toBe('ready');
      expect(settled.identitiesScanned).toBe(0);
    } finally {
      internal.close();
      fixture.close();
    }
  });
});

describe('telegram trust-reconcile operator script', () => {
  test('rejects malformed flags', () => {
    expect(() => parseTelegramTrustReconcileCliArgs(['--max-items', '0'])).toThrow(/between 1 and 10,000/);
    expect(() => parseTelegramTrustReconcileCliArgs(['--max-windows', '100001'])).toThrow(/between 1 and 100,000/);
    expect(() => parseTelegramTrustReconcileCliArgs(['--unknown'])).toThrow(/Unknown flag/);
    expect(() => parseTelegramTrustReconcileCliArgs(['--internal-db'])).toThrow(/requires a value/);
  });

  test('the retired operator refuses before opening or changing stores', () => {
    for (const flags of [[], ['--execute'], ['--internal-db', '/missing', '--execute']]) {
      expect(() => runTelegramTrustReconcile(flags)).toThrow(/retired.*automatically re-judges/);
    }
  });
});

interface Fixture {
  stores: TelegramConnectorStores;
  internalDbPath: string;
  protectedDbPath: string;
  liveSpoolDir: string;
  root: string;
  sync(): ReturnType<typeof createTelegramConnectorStoreSyncHandler>;
  closeStores(): void;
  close(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-trust-reconciliation-'));
  roots.push(root);
  const liveSpoolDir = join(root, 'live-spool');
  mkdirSync(liveSpoolDir);
  writeFileSync(join(liveSpoolDir, LIVE_SPOOL_FILE), '');
  const internalDbPath = join(root, 'internal.sqlite');
  const protectedDbPath = join(root, 'secure-local.sqlite');
  const stores = {
    internal: new LocalConnectorStore({
      dbPath: internalDbPath,
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
    }),
    secureLocal: new LocalConnectorStore({
      dbPath: protectedDbPath,
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
    }),
  };
  return {
    stores,
    internalDbPath,
    protectedDbPath,
    liveSpoolDir,
    root,
    sync() {
      return createTelegramConnectorStoreSyncHandler({
        stores,
        spoolDir: liveSpoolDir,
        diskSpace: AMPLE_DISK_SPACE,
      });
    },
    closeStores() {
      stores.secureLocal.close();
      stores.internal.close();
    },
    close() {
      this.closeStores();
    },
  };
}

/**
 * Sync each lane alone from its own single-lane spool, which is precisely how
 * the pre-invariant pipeline produced both-lane copies: no shared preflight,
 * no store consultation, each lane admitting whatever its records claimed.
 */
async function fabricatePreInvariantState(
  fixture: Fixture,
  state: {
    duplicated?: Array<[string, string]>;
    internalOnly?: Array<[string, string]>;
    secureOnly?: Array<[string, string]>;
  },
  label = 'legacy',
): Promise<void> {
  const internalLines = [...(state.duplicated ?? []), ...(state.internalOnly ?? [])]
    .map(([conversation, message]) => spoolLine(conversation, message, 'internal'));
  const secureLines = [...(state.duplicated ?? []), ...(state.secureOnly ?? [])]
    .map(([conversation, message]) => spoolLine(conversation, message, 'secure_local'));
  if (internalLines.length > 0) {
    const dir = join(fixture.root, `${label}-internal-spool`);
    mkdirSync(dir);
    writeFileSync(join(dir, LEGACY_SPOOL_FILE), internalLines.join('\n') + '\n');
    await fixture.stores.internal.syncFromConnector(
      createTelegramCaptureSpoolConnector({ spoolDir: dir, trustDomain: 'internal' }),
      { fetchContent: true },
    );
  }
  if (secureLines.length > 0) {
    const dir = join(fixture.root, `${label}-secure-spool`);
    mkdirSync(dir);
    writeFileSync(join(dir, LEGACY_SPOOL_FILE), secureLines.join('\n') + '\n');
    await fixture.stores.secureLocal.syncFromConnector(
      createTelegramCaptureSpoolConnector({ spoolDir: dir, trustDomain: 'secure_local' }),
      { fetchContent: true },
    );
  }
}

function spoolLine(
  conversationId: string,
  messageId: string,
  trustDomain: 'internal' | 'secure_local',
): string {
  const sourceVersion = ACCOUNT + ':' + conversationId + ':' + messageId + ':v1';
  return JSON.stringify({
    schema_version: 1,
    capture_id: createHash('sha256')
      .update([ACCOUNT, conversationId, messageId, sourceVersion].join('\x1f'))
      .digest('hex'),
    captured_at: '2026-08-25T10:01:00.000Z',
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: ACCOUNT + ':chat:' + conversationId,
    conversation_id: conversationId,
    corpus_id: trustDomain === 'secure_local'
      ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID
      : INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: trustDomain,
    classification: { trust_domain: trustDomain, reason: 'fixture' },
    sync_direction: 'forward',
    message: {
      id: messageId,
      conversationId,
      chatTitle: 'Chat ' + conversationId,
      senderId: 'sender-1',
      senderDisplayName: 'Sam',
      senderIsOwner: true,
      chatType: 'group',
      boundedText: 'marker ' + conversationId + ' ' + messageId,
      sentAt: '2026-08-25T10:00:00.000Z',
      sourceVersion,
    },
  });
}
