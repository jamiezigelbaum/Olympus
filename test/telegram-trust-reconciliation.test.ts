// The one-lane trust invariant enforced at the store boundary deliberately
// heals nothing that predates it: an identity indexed in BOTH lane stores
// before the invariant shipped has both spool records behind both cursors, so
// no scan window ever surfaces the disagreement again. These tests fabricate
// exactly that legacy state — each lane synced alone from its own spool, the
// way the pre-invariant code left real stores — and prove the one-time
// reconciliation sweep retires it: bounded, resumable, idempotent, and visible
// in the same receipt counts as the running invariant's evictions.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_TRUST_CONFLICT_WARNING,
  TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID,
  createTelegramCaptureSpoolConnector,
  createTelegramConnectorStoreSyncHandler,
  type TelegramConnectorStores,
} from '../src/workers/telegram-messages/index.ts';
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

describe('Telegram trust reconciliation sweep', () => {
  test('heals pre-invariant duplication on the next pull and reports it in the receipt', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, {
      duplicated: [['lawyer', '9']],
      internalOnly: [['porto', '1']],
      secureOnly: [['lawyer', '11']],
    });

    expect(fixture.stores.internal.status().counts.items).toBe(2);
    expect(fixture.stores.secureLocal.status().counts.items).toBe(2);

    const receipt = await fixture.sync().pull();
    expect(receipt.counts.trust_conflict_evictions).toBe(1);
    expect(receipt.counts.trust_conflict_items).toBe(1);
    expect(receipt.counts.items_tombstoned).toBe(1);
    expect(receipt.warnings).toContain(TELEGRAM_TRUST_CONFLICT_WARNING);

    // Only the duplicated identity moved: the ordinary internal item and both
    // secure items are untouched, and the internal copy is a tombstone.
    expect(fixture.stores.internal.status().counts.items).toBe(1);
    expect(fixture.stores.internal.status().counts.tombstonedItems).toBe(1);
    expect(fixture.stores.secureLocal.status().counts.items).toBe(2);
    expect(reconciliationState(fixture.stores)).toBe('ready');

    // Complete means complete: the next pull re-evicts nothing and rewrites
    // no sweep position.
    const markerRun = reconciliationMarkerRunId(fixture.stores);
    const idle = await fixture.sync().pull();
    expect(idle.counts.trust_conflict_evictions).toBe(0);
    expect(idle.counts.trust_conflict_items).toBe(0);
    expect(idle).not.toHaveProperty('warnings');
    expect(reconciliationMarkerRunId(fixture.stores)).toBe(markerRun);
    fixture.close();
  });

  test('completes immediately against an empty secure store', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, { internalOnly: [['porto', '1']] });

    const receipt = await fixture.sync().pull();
    expect(receipt.counts.trust_conflict_evictions).toBe(0);
    expect(reconciliationState(fixture.stores)).toBe('ready');
    fixture.close();
  });

  test('advances in bounded windows and resumes across pulls', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, {
      duplicated: [['lawyer', '1'], ['lawyer', '2'], ['lawyer', '3']],
    });

    // One single-identity window per pull: the sweep must cross pulls on its
    // durable cursor alone.
    const sync = fixture.sync({ maxItems: 1, maxWindows: 1 });
    let evictions = 0;
    for (let pull = 0; pull < 3; pull += 1) {
      const receipt = await sync.pull();
      evictions += receipt.counts.trust_conflict_evictions;
      expect(reconciliationState(fixture.stores)).toBe('in_progress');
    }
    expect(evictions).toBe(3);
    expect(fixture.stores.internal.status().counts.items).toBe(0);

    // The walk only proves exhaustion by coming up short, so the final window
    // scans nothing and writes the completion marker.
    const final = await sync.pull();
    expect(final.counts.trust_conflict_evictions).toBe(0);
    expect(reconciliationState(fixture.stores)).toBe('ready');
    fixture.close();
  });

  test('stays one-time: duplication fabricated after completion is left to the running invariant', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, { secureOnly: [['lawyer', '1']] });
    await fixture.sync().pull();
    expect(reconciliationState(fixture.stores)).toBe('ready');

    // New corruption after the marker cannot exist on a host running the
    // invariant; the sweep proves it does not quietly become a standing scan.
    await fabricatePreInvariantState(fixture, { duplicated: [['lawyer', '2']] }, 'post');
    const receipt = await fixture.sync().pull();
    expect(receipt.counts.trust_conflict_evictions).toBe(0);
    expect(fixture.stores.internal.status().counts.items).toBe(1);
    fixture.close();
  });
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

  test('refuses the same database file for both stores before opening anything', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, { internalOnly: [['porto', '1']] });
    fixture.closeStores();
    expect(() => runTelegramTrustReconcile([
      '--internal-db', fixture.internalDbPath,
      '--protected-db', fixture.internalDbPath,
      '--execute',
    ])).toThrow(/one database as both stores/);
  });

  // Swapped flags would invert the sweep: the protected store's copies would
  // be the ones evicted. The lane-suffixed capture lineage inside each store
  // is the evidence the guard reads.
  test('refuses swapped lane paths by the stores\' own run history', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, {
      internalOnly: [['porto', '1']],
      secureOnly: [['lawyer', '2']],
    });
    fixture.closeStores();
    expect(() => runTelegramTrustReconcile([
      '--internal-db', fixture.protectedDbPath,
      '--protected-db', fixture.internalDbPath,
      '--execute',
    ])).toThrow(/other lane/);
  });

  test('dry-runs the exact walk without moving the cursor, and execute drains it', async () => {
    const fixture = createFixture();
    await fabricatePreInvariantState(fixture, {
      duplicated: [['lawyer', '9']],
      secureOnly: [['lawyer', '11']],
    });
    fixture.closeStores();
    const flags = ['--internal-db', fixture.internalDbPath, '--protected-db', fixture.protectedDbPath];

    const dry = runTelegramTrustReconcile(flags);
    expect(dry).toMatchObject({
      kind: 'telegram_trust_reconciliation',
      execute: false,
      before: { state: 'in_progress', cursorItemPk: 0 },
      after: { state: 'in_progress', cursorItemPk: 0 },
      counts: {
        internal_active_items: 1,
        secure_local_active_items: 2,
        identities_scanned: 2,
        items_relinquished: 0,
        items_would_relinquish: 1,
      },
      policy: { countsOnly: true, sourceIdentifiersExposed: false, sourceTextExposed: false },
    });

    const executed = runTelegramTrustReconcile([...flags, '--execute']);
    expect(executed.after.state).toBe('ready');
    expect(executed.counts.items_relinquished).toBe(1);
    expect(executed.counts.internal_active_items).toBe(0);
    expect(executed.counts.internal_tombstoned_items).toBe(1);

    // Idempotent: a repeat execute scans nothing and relinquishes nothing.
    const repeat = runTelegramTrustReconcile([...flags, '--execute']);
    expect(repeat.before.state).toBe('ready');
    expect(repeat.counts.identities_scanned).toBe(0);
    expect(repeat.counts.items_relinquished).toBe(0);

    const dryAfter = runTelegramTrustReconcile(flags);
    expect(dryAfter.before.state).toBe('ready');
    expect(dryAfter.counts.items_would_relinquish).toBe(0);
  });
});

interface Fixture {
  stores: TelegramConnectorStores;
  internalDbPath: string;
  protectedDbPath: string;
  liveSpoolDir: string;
  root: string;
  sync(reconciliation?: { maxItems?: number; maxWindows?: number }): ReturnType<typeof createTelegramConnectorStoreSyncHandler>;
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
    sync(reconciliation) {
      return createTelegramConnectorStoreSyncHandler({
        stores,
        spoolDir: liveSpoolDir,
        ...(reconciliation ? { reconciliation } : {}),
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

function reconciliationState(stores: TelegramConnectorStores): 'ready' | 'in_progress' {
  return stores.internal.trustReconciliationStatus(TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID).state;
}

function reconciliationMarkerRunId(stores: TelegramConnectorStores): string | undefined {
  return stores.internal.lastCompletedSyncRun(TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID)?.syncRunId;
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
