// Mail (or any item) the owner's scope keeps names-only has no content to
// judge. Its content layer settles at ingest as "no content"
// (`content:names_only`), without a privacy-check question and without the
// fail-safe Private label; its names keep their ordinary judgment.
//
// Expected values here come from the product rules, not from the code under
// test: Personal is the stored tier key `private`, Private is `secure`; an
// item with no readable content is never "pending" on that account; a body
// that later arrives is judged exactly as a new message's body is.

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { namesOnlyContentScopeMetadata } from '../src/core/classification-signals.ts';
import { createSourceExclusionMatcher } from '../src/core/source-ingestion-exclusions.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers, type OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createLaneTieredStoreSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  createGmailConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailApiClient,
  GmailConnectorScope,
  GmailGetMessageOptions,
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import { FIXTURE_PLACEMENT, fixtureItem, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const OFFLINE_BROKER = { async issueSession() { throw new Error('Unexpected credential request in offline Gmail fixture'); } } as unknown as CredentialBroker;
const CUTOFF_MS = Date.parse('2026-04-13T00:00:00.000Z');
const DAY_MS = 86_400_000;
const ACCOUNT = 'personal';
// The owner's "always Private" sender, as the mail scope writes it.
const PRIVATE_SENDER_RULE: OwnerTierRule = {
  id: 'privacy-sender-clinic', match: { kind: 'sender', value: 'records@clinic.example' }, tier: 'secure', strength: 'force',
};

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

// --- Gmail, end to end through the real lane ------------------------------------

interface MailSpec {
  id: string;
  ageDays: number;
  subject: string;
  from?: string;
  body?: string;
}

function gmailMessage(spec: MailSpec): GmailMessage {
  const internalDate = CUTOFF_MS - spec.ageDays * DAY_MS;
  return {
    id: spec.id,
    threadId: `thread-${spec.id}`,
    historyId: '1000',
    internalDate: String(internalDate),
    labelIds: ['INBOX'],
    snippet: `Snippet of ${spec.id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: spec.subject },
        { name: 'From', value: spec.from ?? 'Club <club@example.com>' },
        { name: 'Date', value: new Date(internalDate).toUTCString() },
      ],
      body: { data: Buffer.from(spec.body ?? '').toString('base64url') },
    },
  };
}

function gmailClient(messages: readonly GmailMessage[]): GmailApiClient {
  return {
    async listMessages(request: GmailListMessagesRequest) {
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const before = /before:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = messages.filter((entry) => {
        const at = Number(entry.internalDate);
        return (!after || at > Number(after) * 1_000) && (!before || at < Number(before) * 1_000);
      });
      return { messages: eligible.map((entry) => ({ id: entry.id })), resultSizeEstimate: eligible.length };
    },
    async getMessage(id: string, request?: GmailGetMessageOptions) {
      const found = messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      // What Gmail returns for format=metadata: headers and labels, no body part.
      return request?.format === 'metadata' ? { ...found, payload: { headers: found.payload?.headers ?? [] } } : found;
    },
  };
}

interface MailLane {
  dir: string;
  internal: LocalConnectorStore;
  secure: LocalConnectorStore;
  ledger: TierLedger;
  installed: InstalledTierClassification;
  /** One pull over `messages` under a window whose full-content cutoff is `contentAfterMs`. */
  pull(messages: readonly GmailMessage[], contentAfterMs?: number, revision?: string): Promise<void>;
  identity(id: string): SourceItemIdentity;
}

function mailLane(): MailLane {
  const tmp = tempDir('olympus-names-only-tier-');
  const internal = new LocalConnectorStore({
    dbPath: join(tmp.dir, 'gmail-connector-store.sqlite'), corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'internal',
  });
  const secure = new LocalConnectorStore({
    dbPath: join(tmp.dir, 'gmail-secure-connector-store.sqlite'), corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'secure_local',
  });
  const ledgerPath = tieredStoreSetLedgerPath(secure.dbPath);
  const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
  // The worker wires the installed rules, sniffer and queue into the lane;
  // the lane's own owner rule rides beside them, as in createGmailConnectorStoreSyncHandler.
  const tierClassification = { ...installed.forLedger(ledgerPath), rules: [PRIVATE_SENDER_RULE] };
  const set = createLaneTieredStoreSet({
    setId: 'gmail-names-only-test', internalStore: internal, secureStore: secure, tierClassification,
  });
  const ledger = secure.tierLedger()!;
  // The worker registers the installed inputs for every lane's stores; so does this lane.
  registerInstalledTierClassification(installed);
  cleanup.push(() => { registerInstalledTierClassification(undefined); installed.close(); internal.close(); secure.close(); tmp.cleanup(); });
  return {
    dir: tmp.dir,
    internal,
    secure,
    ledger,
    installed,
    identity: (id) => ({ family: 'email', provider: 'gmail', accountScope: ACCOUNT, providerItemId: id, localItemId: `${ACCOUNT}:${id}` }),
    async pull(messages, contentAfterMs = CUTOFF_MS, revision = 'rev-1') {
      const scope: GmailConnectorScope = {
        baseQuery: '-category:promotions -category:social',
        contentAfterMs,
        ownerTierRules: [PRIVATE_SENDER_RULE],
      };
      const handler = createGmailConnectorStoreSyncHandler({
        internalStore: internal, secureStore: secure, account: ACCOUNT, credentialBroker: OFFLINE_BROKER,
        apiClient: gmailClient(messages), env: {}, scope, tierSet: set,
        scopeApproval: { generation: 'g'.repeat(64), revision },
      });
      let result = await handler.pull({ max_items: 50 });
      for (let i = 0; i < 4 && result.receipt.counts.traversal_complete === 0; i++) {
        result = await handler.pull({ max_items: 50, checkpoint: result.checkpoint! });
      }
      expect(result.receipt.counts.traversal_complete).toBe(1);
    },
  };
}

/** Every state a ledger row was ever written in, oldest first: "settles at ingest" means no `pending` ever appears. */
function statesEverWritten(ledgerPath: string, providerItemId: string): string[] {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    return (db.query('SELECT state FROM tier_history WHERE provider_item_id = ? ORDER BY history_pk').all(providerItemId) as Array<{ state: string }>)
      .map((row) => row.state);
  } finally {
    db.close();
  }
}

const RECENT: MailSpec = { id: 'recent', ageDays: -10, subject: 'Dinner at the lake', body: 'Dinner at the lake on Saturday, bring the grill.' };
const OLD: MailSpec[] = [
  { id: 'old-1', ageDays: 30, subject: 'Garden club newsletter' },
  { id: 'old-2', ageDays: 31, subject: 'Garden club minutes' },
  { id: 'old-3', ageDays: 32, subject: 'Garden club picnic' },
];

describe('Gmail mail older than the approved window', () => {
  test('settles at ingest as no content: current, Personal like its names, never pending, never the fail-safe label', async () => {
    const lane = mailLane();
    await lane.pull([gmailMessage(RECENT), ...OLD.map(gmailMessage)]);
    for (const old of OLD) {
      const row = lane.ledger.getCurrent(lane.identity(old.id))!;
      expect(row).toMatchObject({
        state: 'current', metadataTier: 'private', contentTier: 'private',
        contentRead: false, contentPending: false, metadataPending: false,
      });
      expect(row.reasons).toContain('content:names_only');
      expect(row.reasons).not.toContain('content:unread');
      expect(row.reasons.some((reason) => reason.includes('fail_safe'))).toBe(false);
      // At ingest: no write of this row, from any leg or any call, was ever pending.
      expect(statesEverWritten(lane.ledger.dbPath, old.id)).not.toContain('pending');
    }
    // The message read in full is untouched by any of this.
    expect(lane.ledger.getCurrent(lane.identity('recent'))).toMatchObject({ contentRead: true });
    expect(lane.ledger.getCurrent(lane.identity('recent'))!.reasons).not.toContain('content:names_only');
  });

  test('the privacy-check backlog and the engine log no longer count it', async () => {
    const lane = mailLane();
    // Only older mail here: a message read in full legitimately waits for its content judge.
    await lane.pull(OLD.map(gmailMessage));
    const logged: string[] = [];
    const service = new TierSnifferService({
      installed: lane.installed, lane: BUILT_IN_SNIFFER_LANE, stores: () => [lane.internal, lane.secure],
      classificationLedgerPath: join(lane.dir, 'classification.jsonl'),
      model: { async complete() { throw new Error('nothing here may be asked of a model'); } },
      modelAvailable: () => false, rejudgePerPass: 0, log: (line) => logged.push(line),
    });
    cleanup.push(() => service.stop());
    expect(lane.ledger.counts().byState.pending).toBe(0);
    expect(service.backlog()).toMatchObject({ checkingItems: 0, pendingItems: 0, pendingWithoutQuestion: 0 });
    await service.runOnce();
    expect(logged.filter((line) => line.includes('pending='))).toEqual([]);
    expect(logged.filter((line) => line.includes('fail-safe'))).toEqual([]);
  });

  test('never becomes readable content: no chunks in either store, no copies in the ledger', async () => {
    const lane = mailLane();
    await lane.pull([gmailMessage({ ...OLD[0]!, body: 'SECRET-BODY-TEXT the metadata fetch must never carry' })]);
    for (const store of [lane.internal, lane.secure]) {
      expect(store.itemStoredContent(lane.identity('old-1'))?.chunkCount ?? 0).toBe(0);
      expect(JSON.stringify(store.localContent(`${ACCOUNT}:old-1`) ?? null)).not.toContain('SECRET-BODY-TEXT');
    }
    expect(lane.internal.itemStoredContent(lane.identity('old-1'))).toBeDefined();
    expect(lane.ledger.copies(lane.identity('old-1'))).toEqual([]);
    expect(lane.ledger.getCurrent(lane.identity('old-1'))).toMatchObject({ contentRead: false, routed: false });
  });

  test('an answer that names this mail is judged by its names: Personal, not Private for content that was never read', async () => {
    const lane = mailLane();
    await lane.pull([
      gmailMessage(OLD[0]!),
      gmailMessage({ id: 'old-clinic', ageDays: 40, subject: 'Appointment reminder', from: 'Dr Reyes <records@clinic.example>' }),
    ]);
    const check = createReleaseTierCheck(
      () => [{ ledger: lane.ledger, corpusIds: new Set([GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, GMAIL_SECURE_CONNECTOR_CORPUS_ID]) }],
      () => 'approval',
    );
    const input = (providerItemId: string, corpusId: string) => ({
      corpusId, provider: 'gmail', accountScope: ACCOUNT, providerItemId, privateAtAnswer: false,
    });
    expect(check.inputs([
      input('old-1', GMAIL_INTERNAL_CONNECTOR_CORPUS_ID),
      input('old-clinic', GMAIL_SECURE_CONNECTOR_CORPUS_ID),
    ])).toEqual([
      { tier: 'public_or_personal', gone: false },
      { tier: 'private', gone: false },
    ]);
  });

  test('an always-Private sender and a structured identifier in the subject still land in the Private store', async () => {
    const lane = mailLane();
    const sender = { id: 'old-clinic', ageDays: 40, subject: 'Appointment reminder', from: 'Dr Reyes <records@clinic.example>' };
    const account = { id: 'old-account', ageDays: 41, subject: 'Your account number: 12345678' };
    await lane.pull([gmailMessage(sender), gmailMessage(account), gmailMessage(OLD[0]!)]);
    // Where the names row lives: Private for both, Personal for the ordinary one.
    for (const id of ['old-clinic', 'old-account']) {
      expect(lane.secure.itemStoredContent(lane.identity(id))).toBeDefined();
      expect(lane.internal.itemStoredContent(lane.identity(id))).toBeUndefined();
    }
    expect(lane.internal.itemStoredContent(lane.identity('old-1'))).toBeDefined();
    expect(lane.secure.itemStoredContent(lane.identity('old-1'))).toBeUndefined();
    // The owner's rule decides the names Private, and the content layer follows with nothing left to wait for.
    expect(lane.ledger.getCurrent(lane.identity('old-clinic'))).toMatchObject({
      state: 'current', metadataTier: 'secure', contentTier: 'secure', contentRead: false, contentPending: false,
    });
    expect(lane.ledger.getCurrent(lane.identity('old-clinic'))!.reasons).toContain('content:names_only');
    // The identifier in the subject is a real names question; the content layer still has none.
    const asked = lane.ledger.getCurrent(lane.identity('old-account'))!;
    expect(asked).toMatchObject({ state: 'pending', metadataPending: true, contentPending: false, contentRead: false });
    const queue = lane.installed.snifferStoreForLedger(lane.ledger.dbPath);
    expect(queue.questionFor(lane.identity('old-account'), 'metadata')).toBeDefined();
    expect(queue.questionFor(lane.identity('old-account'), 'content')).toBeUndefined();
  });

  test('when the owner widens the window the body is judged exactly as a new message\'s body is', async () => {
    const lane = mailLane();
    const body = 'Minutes of the garden club: we agreed the picnic is on the first Saturday of June.';
    await lane.pull([gmailMessage({ ...OLD[0]!, body })]);
    expect(lane.ledger.getCurrent(lane.identity('old-1'))).toMatchObject({ state: 'current', contentRead: false, contentPending: false });
    expect(lane.internal.itemStoredContent(lane.identity('old-1'))?.chunkCount).toBe(0);

    // The new window reaches back past the old message; a brand-new message with the same body arrives with it.
    const widened = CUTOFF_MS - 400 * DAY_MS;
    await lane.pull(
      [gmailMessage({ ...OLD[0]!, body }), gmailMessage({ id: 'fresh', ageDays: -1, subject: OLD[0]!.subject, body })],
      widened, 'rev-2',
    );
    const upgraded = lane.ledger.getCurrent(lane.identity('old-1'))!;
    const fresh = lane.ledger.getCurrent(lane.identity('fresh'))!;
    // Read now, and held for the content judge: the same state a new message's body gets.
    expect(upgraded).toMatchObject({ state: 'pending', contentRead: true, contentPending: true });
    expect(fresh).toMatchObject({ state: 'pending', contentRead: true, contentPending: true });
    expect(upgraded.contentTier).toBe(fresh.contentTier);
    expect(upgraded.reasons).not.toContain('content:names_only');
    const queue = lane.installed.snifferStoreForLedger(lane.ledger.dbPath);
    for (const id of ['old-1', 'fresh']) {
      const question = queue.questionFor(lane.identity(id), 'content');
      expect(question).toBeDefined();
      expect(question!.material).toContain('first Saturday of June');
    }
    // And the body is stored now (it was never readable before).
    expect(lane.internal.itemStoredContent(lane.identity('old-1'))?.chunkCount).toBeGreaterThan(0);
  });
});

// --- Existing ledgers, and lanes other than Gmail ---------------------------------------

function markedSpec(spec: FixtureSpec): RawItem {
  const item = fixtureItem(spec);
  return { ...item, metadata: Object.freeze({ ...item.metadata, ...namesOnlyContentScopeMetadata() }) };
}

function listing(items: () => readonly RawItem[]): SourceConnector {
  const base = {
    id: 'fixture_names_only_lane',
    family: 'file' as const,
    async authenticate() {},
    listItems() {
      const page = items();
      return (async function* () { await Promise.resolve(); yield { items: page, done: true as const }; })();
    },
    async fetchItem(localItemId: string) {
      const item = items().find((entry) => entry.identity.localItemId === localItemId);
      if (!item) throw new Error('unknown fixture item');
      return item;
    },
    classificationSignals(item: RawItem) {
      return { title: String(item.metadata['name'] ?? ''), path: String(item.metadata['pathDisplay'] ?? '') };
    },
  };
  return base;
}

describe('rows already settled, and other lanes', () => {
  test('a settled fail-safe row stays Private, and re-seeing the item names-only neither downgrades nor re-opens it', async () => {
    const tmp = tempDir();
    const fixture = openTierFixture(tmp.dir, { embed: false });
    cleanup.push(() => { fixture.close(); tmp.cleanup(); });
    const id = identityOf('settled');
    // The shape the unfixed code left: unread, pending, then settled by the missing-question recovery.
    const unread = classifyItemTiers({ signals: { title: 'settled' } });
    fixture.ledger.recordDecision(id, unread);
    fixture.ledger.settleMissingQuestions(fixture.ledger.getCurrent(id)!, {
      missingMetadata: false, missingContent: true, snifferId: 'local:test', stillMissing: () => true,
    });
    const settled = fixture.ledger.getCurrent(id)!;
    expect(settled).toMatchObject({ state: 'current', contentTier: 'secure', contentRead: false });
    expect(settled.reasons.some((reason) => reason.endsWith(':fail_safe:missing_question'))).toBe(true);

    // The next background pass finds nothing to do for it: no storm, no model call.
    let calls = 0;
    const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
    const service = new TierSnifferService({
      installed, lane: BUILT_IN_SNIFFER_LANE, stores: () => fixture.set.openStores(),
      classificationLedgerPath: join(tmp.dir, 'classification.jsonl'),
      model: { async complete() { calls += 1; throw new Error('must not ask'); } },
      modelAvailable: () => false, rejudgePerPass: 0,
    });
    cleanup.push(() => { service.stop(); installed.close(); });
    await service.runOnce();
    expect(fixture.ledger.getCurrent(id)).toEqual(settled);
    expect(calls).toBe(0);

    // The same item, listed again names-only (e.g. a lane that re-lists it): still Private, nothing pending.
    await fixture.set.sync(listing(() => [markedSpec({ id: 'settled', name: 'settled' })]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fixture.ledger.getCurrent(id)).toMatchObject({ state: 'current', contentTier: 'secure', contentPending: false, contentRead: false });
    expect(fixture.ledger.counts().byState.pending).toBe(0);
  });

  test('a content tier decided from text is never lowered by a later names-only sighting', async () => {
    const tmp = tempDir();
    const fixture = openTierFixture(tmp.dir, { embed: false });
    cleanup.push(() => { fixture.close(); tmp.cleanup(); });
    const id = identityOf('had-text');
    const read = { ...classifyItemTiers({ signals: { title: 'had-text' }, text: 'Please use account number: 12345678 for the transfer.' }) };
    expect(read).toMatchObject({ contentTier: 'secure', contentRead: true });
    fixture.ledger.recordDecision(id, read);
    await fixture.set.sync(listing(() => [markedSpec({ id: 'had-text', name: 'had-text' })]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fixture.ledger.getCurrent(id)).toMatchObject({ contentTier: 'secure', contentRead: true });
  });

  test('another lane\'s connector gets the same: a marked item settles at ingest, an unmarked text-less one waits', async () => {
    const tmp = tempDir();
    const fixture = openTierFixture(tmp.dir, { embed: false });
    cleanup.push(() => { fixture.close(); tmp.cleanup(); });
    await fixture.set.sync(listing(() => [markedSpec({ id: 'kept', name: 'kept' }), fixtureItem({ id: 'plain', name: 'plain' })]), {
      fetchContent: true, placement: FIXTURE_PLACEMENT,
    });
    expect(fixture.ledger.getCurrent(identityOf('kept'))).toMatchObject({ state: 'current', contentTier: 'private', contentPending: false });
    expect(fixture.ledger.getCurrent(identityOf('kept'))!.reasons).toContain('content:names_only');
    expect(fixture.ledger.getCurrent(identityOf('plain'))).toMatchObject({ state: 'pending', contentPending: true });
  });

  test('an owner Names-only folder in a lane whose text is read at listing settles the same way', async () => {
    const tmp = tempDir();
    const fixture = openTierFixture(tmp.dir, { embed: false, exclusions: createSourceExclusionMatcher({
      schemaVersion: 1,
      rules: [{ id: 'taxes-names-only', mode: 'metadata_only', sources: ['fixture'], path_prefixes: ['/Files/Taxes'], folder_ids: [], reason: 'names only' }],
    }, 'fixture') });
    cleanup.push(() => { fixture.close(); tmp.cleanup(); });
    await fixture.set.sync(listing(() => [
      fixtureItem({ id: 'return', name: 'Taxes/return.pdf' }),
      fixtureItem({ id: 'elsewhere', name: 'Notes/other.pdf' }),
    ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(fixture.ledger.getCurrent(identityOf('return'))).toMatchObject({
      state: 'current', contentPending: false, contentRead: false, contentTier: 'private',
    });
    expect(fixture.ledger.getCurrent(identityOf('return'))!.reasons).toContain('content:names_only');
    // A text-less item outside the folder still waits for text that may arrive.
    expect(fixture.ledger.getCurrent(identityOf('elsewhere'))).toMatchObject({ state: 'pending', contentPending: true });
  });
});
