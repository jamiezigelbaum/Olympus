// An always-Private (or Secrets) Gmail label saved AFTER mail was stored
// (launch-blocking privacy review, 2026-10-13). A store keeps no labels and
// Gmail never lists mail it already holds again, so the label rule used to be
// recorded as swept without ever matching: mail under the label stayed
// Personal and kept reaching ChatGPT. Now the Gmail lane asks Gmail which
// messages carry the label and raises the stored ones (hidden first), and the
// rule counts as applied only after Gmail answered every page.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { writePrivacyProfile } from '../src/workers/classification/privacy-profile.ts';
import { classifyItemTiers, type OwnerTierRule, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { writeOwnerTierRules } from '../src/workers/classification/tier-rules.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { sweepOwnerRuleRaises, sweepLabelRuleRaises, LabelPageRejectedError } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_LABEL_RULES_PENDING_WARNING,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  createGmailConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailApiClient,
  GmailLabel,
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';

const ACCOUNT = 'personal';
const NOW = new Date('2026-10-13T12:00:00.000Z');
const DAY = 86_400_000;
const LABEL_STATE_KEY = `owner_rules_label_sweep:gmail:${ACCOUNT}`;

let root: string;
let env: Record<string, string>;
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-gmail-label-sweep-'));
  mkdirSync(join(root, 'olympus'), { recursive: true });
  env = {
    OLYMPUS_TIER_RULES_PATH: join(root, 'olympus', 'tier-rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'olympus', 'privacy.json'),
  };
  // The worker's installed inputs: the owner's rules file, re-read when edited.
  configureInstalledTierClassification({ env });
});

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  clearInstalledTierClassification();
  rmSync(root, { recursive: true, force: true });
});

function message(id: string, input: { subject: string; body: string; labels: string[]; from?: string; ageDays?: number }): GmailMessage {
  const at = NOW.getTime() - (input.ageDays ?? 1) * DAY;
  return {
    id,
    threadId: `thread-${id}`,
    historyId: '1000',
    internalDate: String(at),
    labelIds: input.labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: input.subject },
        { name: 'From', value: input.from ?? 'Alex <alex@example.com>' },
        { name: 'Date', value: new Date(at).toUTCString() },
      ],
      body: { data: Buffer.from(input.body).toString('base64url') },
    },
  };
}

interface FakeGmail extends GmailApiClient {
  messages: GmailMessage[];
  labels: GmailLabel[];
  /** Every listing that asked for a label. */
  labelListings: GmailListMessagesRequest[];
  failLabelListing: boolean;
  failLabelsList: boolean;
  pageSize: number;
}

/** A mailbox that, like Gmail, hides Spam and Trash from a listing unless asked. */
function fakeGmail(messages: GmailMessage[]): FakeGmail {
  const client: FakeGmail = {
    messages,
    labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' },
      { id: 'TRASH', name: 'TRASH', type: 'system' },
      { id: 'Label_7', name: 'Orchard', type: 'user' },
    ],
    labelListings: [],
    failLabelListing: false,
    failLabelsList: false,
    pageSize: 500,
    async listMessages(request: GmailListMessagesRequest) {
      if (request.labelIds?.length) {
        client.labelListings.push(request);
        if (client.failLabelListing) throw new Error('Gmail API request failed (503): backend unavailable');
      }
      const eligible = client.messages.filter((entry) => {
        const labels = entry.labelIds ?? [];
        if (!request.includeSpamTrash && (labels.includes('TRASH') || labels.includes('SPAM'))) return false;
        return (request.labelIds ?? []).every((id) => labels.includes(id));
      });
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const size = Math.min(request.maxResults, client.pageSize);
      const slice = eligible.slice(offset, offset + size);
      return {
        messages: slice.map((entry) => ({ id: entry.id })),
        ...(offset + slice.length < eligible.length ? { nextPageToken: String(offset + slice.length) } : {}),
      };
    },
    async getMessage(id: string) {
      const found = client.messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      return found;
    },
    async listLabels() {
      if (client.failLabelsList) throw new Error('Gmail API request failed (401): invalid token');
      return client.labels;
    },
  };
  return client;
}

const identity = (id: string) => ({ provider: 'gmail', accountScope: ACCOUNT, providerItemId: id });
const itemIdentity = (id: string) => ({ family: 'email' as const, ...identity(id), localItemId: `${ACCOUNT}:${id}` });

function openLane(client: FakeGmail, options: { ownerRules?: OwnerTierRule[] } = {}) {
  const internalStore = new LocalConnectorStore({
    dbPath: join(root, 'internal.sqlite'), corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: join(root, 'secure.sqlite'), corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'secure_local',
  });
  closers.push(() => internalStore.close(), () => secureStore.close());
  const ownerRules = options.ownerRules ?? [];
  const tierSet = createLaneTieredStoreSet({
    setId: 'gmail.label-sweep-test',
    internalStore,
    secureStore,
    tierClassification: { ...(ownerRules.length > 0 ? { rules: ownerRules } : {}) },
  });
  const handler = createGmailConnectorStoreSyncHandler({
    internalStore,
    secureStore,
    tierSet,
    account: ACCOUNT,
    apiClient: client,
    env: {},
    // The runtime lane always runs under an approved scope: held mail is never listed again.
    scope: { ...(ownerRules.length > 0 ? { ownerTierRules: ownerRules } : {}) },
    scopeApproval: { generation: 'g'.repeat(64), revision: 'rev-1' },
  });
  return { handler, tierSet, ledger: tierSet.ledger, internalStore, secureStore };
}

type Lane = ReturnType<typeof openLane>;

/** What a remote agent's olympus_search would release for a question. */
async function olympusSearch(lane: Lane, question: string): Promise<string> {
  const stores = lane.tierSet.openStores();
  const raw = await searchReleasedEvidence({
    question,
    lanes: () => ({
      registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
        corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
      }))),
      adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
      contentProviders: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreContentProvider({ store })])),
      visibilityGate: createTierVisibilityGate(() => [{ ledger: lane.ledger, corpusIds: new Set(stores.map((store) => store.corpusId)) }]),
      classificationCoverage: (searched: readonly string[]) => searched.map((corpusId) => ({
        corpusId, pendingClassificationItems: lane.ledger.corpusCopyCounts(corpusId).held,
      })),
    }),
  });
  return JSON.stringify(searchToolResult(raw));
}

const saveLabelRule = (key = 'Label_7') => writePrivacyProfile(
  { rules: [{ kind: 'label', source_id: 'gmail.email', key, value: 'Orchard' }] },
  { env },
);

/** Two stored messages, one under Label_7, both Personal and findable. */
async function ingestTwo(client = fakeGmail([
  message('pruning', { subject: 'Apple pruning plan', body: 'Pruning the apple trees in winter, notes for the cellar.', labels: ['INBOX', 'Label_7'] }),
  message('rota', { subject: 'Watering rota', body: 'Watering the roses on Tuesdays, notes for the shed.', labels: ['INBOX'] }),
]), options: { ownerRules?: OwnerTierRule[] } = {}) {
  const lane = openLane(client, options);
  await lane.handler.pull({ max_items: 50 });
  expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'private' });
  expect(lane.ledger.getCurrent(identity('rota'))).toMatchObject({ state: 'current', contentTier: 'private' });
  expect(await olympusSearch(lane, 'apple pruning cellar')).toContain('Pruning the apple trees');
  return { client, lane };
}

describe('a Gmail label saved as always Private after the mail was stored', () => {
  test('raises the stored mail under the label, hidden at once, and leaves unlabelled mail alone', async () => {
    const { client, lane } = await ingestTwo();
    saveLabelRule();

    const outcome = await lane.handler.pull({ max_items: 50 });

    expect(outcome.receipt.warnings ?? []).not.toContain(GMAIL_LABEL_RULES_PENDING_WARNING);
    const raised = lane.ledger.getCurrent(identity('pruning'))!;
    expect(raised).toMatchObject({ state: 'moving', targetMetadataTier: 'secure', targetContentTier: 'secure', decidedBy: 'owner_rule' });
    expect(raised.reasons.some((reason) => reason.startsWith('metadata:owner_rule:label:'))).toBe(true);
    // Hidden first: no later answer can release it from the Personal store.
    expect(await olympusSearch(lane, 'apple pruning cellar')).not.toContain('Pruning the apple trees');
    // The unlabelled message is untouched.
    expect(lane.ledger.getCurrent(identity('rota'))).toMatchObject({ state: 'current', contentTier: 'private' });
    expect(lane.ledger.getCurrent(identity('rota'))!.decidedBy).not.toBe('owner_rule');
    expect(await olympusSearch(lane, 'roses watering shed')).toContain('Watering the roses');
    // Asked of Gmail by the label's id, spam and trash included.
    expect(client.labelListings).toHaveLength(1);
    expect(client.labelListings[0]).toMatchObject({ labelIds: ['Label_7'], includeSpamTrash: true });
  });

  test('is applied once: a rule that has been applied asks Gmail nothing further', async () => {
    const { client, lane } = await ingestTwo();
    saveLabelRule();
    await lane.handler.pull({ max_items: 50 });
    await lane.handler.pull({ max_items: 50 });
    await lane.handler.pull({ max_items: 50 });
    expect(client.labelListings).toHaveLength(1);
  });

  test('the stored-names pass never records a label rule as done', async () => {
    const { lane } = await ingestTwo();
    saveLabelRule();
    // The pass that used to complete the rule without ever matching a label.
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ scanned: 0, raised: 0, complete: true });
    expect(lane.ledger.readMeta('owner_rules_sweep') ?? '').not.toContain('"done":["');
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'current' });
    // The label pass still has the rule to apply.
    await lane.handler.pull({ max_items: 50 });
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
  });

  test.each([
    ['the label listing fails (offline, quota)', (client: FakeGmail) => { client.failLabelListing = true; }, (client: FakeGmail) => { client.failLabelListing = false; }],
    ['the label list fails (token error)', (client: FakeGmail) => { client.failLabelsList = true; }, (client: FakeGmail) => { client.failLabelsList = false; }],
  ] as const)('%s: the rule stays pending, the pull still runs, and the next pull applies it', async (_name, breakGmail, fixGmail) => {
    const { client, lane } = await ingestTwo();
    saveLabelRule();
    breakGmail(client);

    const failed = await lane.handler.pull({ max_items: 50 });

    expect(failed.receipt.warnings).toContain(GMAIL_LABEL_RULES_PENDING_WARNING);
    // Not recorded as done, and nothing silently raised or hidden.
    expect(lane.ledger.readMeta(LABEL_STATE_KEY) ?? '').not.toContain('"done":["');
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'current' });
    expect(await olympusSearch(lane, 'apple pruning cellar')).toContain('Pruning the apple trees');

    fixGmail(client);
    const retried = await lane.handler.pull({ max_items: 50 });

    expect(retried.receipt.warnings ?? []).not.toContain(GMAIL_LABEL_RULES_PENDING_WARNING);
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
    expect(await olympusSearch(lane, 'apple pruning cellar')).not.toContain('Pruning the apple trees');
  });

  test('matches the label id without regard to case, as the classifier does', async () => {
    const { client, lane } = await ingestTwo();
    saveLabelRule('label_7');
    await lane.handler.pull({ max_items: 50 });
    expect(client.labelListings[0]).toMatchObject({ labelIds: ['Label_7'] });
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
  });

  test('reaches stored mail that was moved to Trash since (Gmail hides it from a plain listing)', async () => {
    const { client, lane } = await ingestTwo();
    client.messages[0]!.labelIds = ['TRASH', 'Label_7'];
    saveLabelRule();
    await lane.handler.pull({ max_items: 50 });
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
  });

  test('a label Gmail does not have carries no mail: the rule is applied and nothing changes', async () => {
    const { client, lane } = await ingestTwo();
    saveLabelRule('Label_404');
    const outcome = await lane.handler.pull({ max_items: 50 });
    expect(outcome.receipt.warnings ?? []).not.toContain(GMAIL_LABEL_RULES_PENDING_WARNING);
    expect(client.labelListings).toHaveLength(0);
    expect(JSON.parse(lane.ledger.readMeta(LABEL_STATE_KEY)!).done).toHaveLength(1);
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'current' });
  });

  test('never lowers: mail already Private by its sender is left exactly as it was', async () => {
    const senderRule: OwnerTierRule = {
      id: 'privacy-sender-orchard', source: 'gmail', match: { kind: 'sender', value: '@orchard.example' }, tier: 'secure', strength: 'force',
    };
    const client = fakeGmail([
      message('private-already', {
        subject: 'Orchard invoice', body: 'Invoice for the orchard fence, due in March.', labels: ['INBOX', 'Label_7'], from: 'Pat <pat@orchard.example>',
      }),
    ]);
    const lane = openLane(client, { ownerRules: [senderRule] });
    await lane.handler.pull({ max_items: 50 });
    const before = lane.ledger.getCurrent(identity('private-already'))!;
    expect(before).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });

    saveLabelRule();
    await lane.handler.pull({ max_items: 50 });

    // Asked about, found, and left alone: same row, same generation.
    expect(client.labelListings).toHaveLength(1);
    expect(lane.ledger.getCurrent(identity('private-already'))).toEqual(before);
  });

  test('a Secrets label rule hides the stored mail and hands it to the Secrets policy', async () => {
    const { lane } = await ingestTwo();
    // A hand-written owner rule to Secrets (the privacy profile only writes Private).
    writeOwnerTierRules([{ id: 'owner-secret-label', source: 'gmail', match: { kind: 'label', value: 'Label_7' }, tier: 'secrets', strength: 'force' }], { env });
    const report = await sweepLabelRuleRaises({
      set: lane.tierSet,
      provider: 'gmail',
      accountScope: ACCOUNT,
      source: { listLabelled: async () => ({ ids: ['pruning', 'never-stored'] }) },
    });
    expect(report).toMatchObject({ scanned: 2, secrets: 1, raised: 0, pending: 0 });
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ contentTier: 'secrets' });
    expect(await olympusSearch(lane, 'apple pruning cellar')).not.toContain('Pruning the apple trees');
  });
});

describe('mail labelled after the rule was applied', () => {
  test('the daily reconcile asks again and raises it', async () => {
    const { client, lane } = await ingestTwo();
    saveLabelRule();
    await lane.handler.pull({ max_items: 50 });
    expect(client.labelListings).toHaveLength(1);

    // The owner later puts the label on the watering rota too.
    client.messages[1]!.labelIds = ['INBOX', 'Label_7'];
    await lane.handler.pull({ max_items: 50 });
    expect(lane.ledger.getCurrent(identity('rota'))).toMatchObject({ state: 'current' });

    await lane.handler.reconcile();

    expect(client.labelListings).toHaveLength(2);
    expect(lane.ledger.getCurrent(identity('rota'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
    expect(await olympusSearch(lane, 'roses watering shed')).not.toContain('Watering the roses');
  });
});

describe('the label pass itself', () => {
  async function pagedLane(ids: string[]) {
    const messages = ids.map((id) => message(id, { subject: `Note ${id}`, body: `Body of note ${id}.`, labels: ['INBOX'] }));
    const lane = openLane(fakeGmail(messages));
    await lane.handler.pull({ max_items: 50 });
    return lane;
  }

  const rule: OwnerTierRule = { id: 'owner-label-seven', source: 'gmail', match: { kind: 'label', value: 'Label_7' }, tier: 'secure', strength: 'force' };
  /** The owner's rules file, as the worker re-reads it. */
  const setRules = (rules: OwnerTierRule[]) => { writeOwnerTierRules(rules, { env }); };

  test('resumes at the last page read, and finishes the rule only when the last page is answered', async () => {
    const lane = await pagedLane(['a', 'b', 'c']);
    setRules([rule]);
    const set = lane.tierSet;
    const pages: Array<string | undefined> = [];
    const source = {
      async listLabelled(_label: string, page: { pageToken?: string }) {
        pages.push(page.pageToken);
        const order = ['a', 'b', 'c'];
        const at = page.pageToken ? Number(page.pageToken) : 0;
        return { ids: [order[at]!], ...(at + 1 < order.length ? { nextPageToken: String(at + 1) } : {}) };
      },
    };
    const sweep = (maxPages: number) => sweepLabelRuleRaises({ set, provider: 'gmail', accountScope: ACCOUNT, source, maxPages });

    expect(await sweep(1)).toMatchObject({ raised: 1, pending: 1 });
    expect(lane.ledger.getCurrent(identity('a'))).toMatchObject({ state: 'moving' });
    expect(lane.ledger.getCurrent(identity('b'))).toMatchObject({ state: 'current' });
    expect(await sweep(1)).toMatchObject({ raised: 1, pending: 1 });
    expect(await sweep(1)).toMatchObject({ raised: 1, pending: 0 });
    expect(pages).toEqual([undefined, '1', '2']);
    expect(lane.ledger.getCurrent(identity('c'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
    // Applied: nothing more is asked.
    expect(await sweep(1)).toMatchObject({ rules: 0, scanned: 0, pending: 0 });
    expect(pages).toHaveLength(3);
  });

  test('a provider that refuses the saved page makes the walk start over, not stall', async () => {
    const lane = await pagedLane(['a', 'b']);
    setRules([rule]);
    const set = lane.tierSet;
    const pages: Array<string | undefined> = [];
    let refuse = true;
    const source = {
      async listLabelled(_label: string, page: { pageToken?: string }) {
        pages.push(page.pageToken);
        if (page.pageToken === 'stale' && refuse) throw new LabelPageRejectedError();
        if (page.pageToken === 'stale') return { ids: ['b'] };
        return { ids: ['a'], nextPageToken: 'stale' };
      },
    };
    const sweep = () => sweepLabelRuleRaises({ set, provider: 'gmail', accountScope: ACCOUNT, source, maxPages: 1 });

    expect(await sweep()).toMatchObject({ pending: 1 });
    // Resumes with the saved page; Gmail refuses it; the walk is forgotten.
    expect(await sweep()).toMatchObject({ pending: 1 });
    refuse = false;
    expect(await sweep()).toMatchObject({ pending: 1 });
    expect(pages).toEqual([undefined, 'stale', undefined]);
    expect(await sweep()).toMatchObject({ pending: 0 });
    expect(lane.ledger.getCurrent(identity('b'))).toMatchObject({ state: 'moving' });
  });

  test('a fresh database with no mail and no saved state applies the rule cleanly, and bad saved state starts over', async () => {
    const lane = openLane(fakeGmail([]));
    setRules([rule]);
    const set = lane.tierSet;
    expect(lane.ledger.readMeta(LABEL_STATE_KEY)).toBeUndefined();
    const source = { listLabelled: async () => ({ ids: [] as string[] }) };

    expect(await sweepLabelRuleRaises({ set, provider: 'gmail', accountScope: ACCOUNT, source })).toMatchObject({ rules: 1, scanned: 0, pending: 0 });
    expect(JSON.parse(lane.ledger.readMeta(LABEL_STATE_KEY)!).done).toHaveLength(1);

    lane.ledger.writeMeta(LABEL_STATE_KEY, '{not json');
    expect(await sweepLabelRuleRaises({ set, provider: 'gmail', accountScope: ACCOUNT, source })).toMatchObject({ rules: 1, pending: 0 });
    expect(JSON.parse(lane.ledger.readMeta(LABEL_STATE_KEY)!).done).toHaveLength(1);
  });

  test('a removed rule is forgotten, so adding it back applies it again', async () => {
    const lane = await pagedLane(['a']);
    let listings = 0;
    const source = { listLabelled: async () => { listings += 1; return { ids: ['a'] }; } };
    const apply = (rules: OwnerTierRule[]) => {
      setRules(rules);
      return sweepLabelRuleRaises({ set: lane.tierSet, provider: 'gmail', accountScope: ACCOUNT, source });
    };

    await apply([rule]);
    expect(listings).toBe(1);
    await apply([]);
    expect(JSON.parse(lane.ledger.readMeta(LABEL_STATE_KEY)!).done).toEqual([]);
    await apply([rule]);
    expect(listings).toBe(2);
  });
});

/** The decision a sniffer or migration would record for an item, to queue a move without a listing. */
function movingTo(tier: 'private' | 'secure'): TierDecision {
  return {
    ...classifyItemTiers({ signals: { title: 'x' }, text: 'x' }),
    metadataTier: tier,
    contentTier: tier,
    decidedBy: 'sniffer',
    reasons: ['metadata:default:personal', 'content:sniffer'],
    state: 'current',
    contentPending: false,
    metadataPending: false,
  };
}

const orchardSender: OwnerTierRule = {
  id: 'owner-sender-orchard', source: 'gmail', match: { kind: 'sender', value: '@orchard.example' }, tier: 'secure', strength: 'force',
};

const orchardMail = (id: string, subject: string, body: string, labels = ['INBOX']) =>
  message(id, { subject, body, labels, from: 'Pat <pat@orchard.example>' });

describe('a move in flight does not exempt an item from a rule', () => {
  test('a raise queued without hiding is hidden by the label rule, not left served', async () => {
    const { lane } = await ingestTwo();
    // A re-judge on an install whose moves wait for the migration: heading to Private, the Personal copy still served.
    const queued = lane.ledger.recordRoutedPlacement(identity('pruning'), movingTo('secure'), lane.tierSet.placementFor(movingTo('secure')), { queueWithoutHiding: true });
    expect(queued.outcome).toBe('queued_move');
    expect(await olympusSearch(lane, 'apple pruning cellar')).toContain('Pruning the apple trees');

    saveLabelRule();
    await lane.handler.pull({ max_items: 50 });

    expect(lane.ledger.copies(identity('pruning')).filter((copy) => copy.state === 'current')).toEqual([]);
    expect(await olympusSearch(lane, 'apple pruning cellar')).not.toContain('Pruning the apple trees');
    expect(lane.ledger.getCurrent(identity('pruning'))).toMatchObject({ state: 'moving', targetMetadataTier: 'secure' });
  });

  test('a lowering move queued for Private mail is retargeted to the rule\'s tier', async () => {
    const client = fakeGmail([orchardMail('fence', 'Orchard fence', 'Fence quote for the orchard.', ['INBOX', 'Label_7'])]);
    const lane = openLane(client, { ownerRules: [orchardSender] });
    await lane.handler.pull({ max_items: 50 });
    expect(lane.ledger.getCurrent(identity('fence'))).toMatchObject({ state: 'current', metadataTier: 'secure' });
    // A migration queues the mail to move down to Personal; it is still Private today.
    const queued = lane.ledger.recordRoutedPlacement(identity('fence'), movingTo('private'), lane.tierSet.placementFor(movingTo('private')));
    expect(queued.outcome).toBe('queued_move');
    expect(lane.ledger.getCurrent(identity('fence'))).toMatchObject({ state: 'moving', targetMetadataTier: 'private' });

    saveLabelRule();
    await lane.handler.pull({ max_items: 50 });

    expect(lane.ledger.getCurrent(identity('fence'))).toMatchObject({ state: 'moving', targetMetadataTier: 'secure', targetContentTier: 'secure', decidedBy: 'owner_rule' });
  });

  test('a stored-names rule reads the names of a hidden item, so a Secrets rule still reaches mail on its way to Private', async () => {
    const client = fakeGmail([orchardMail('fence', 'Orchard fence', 'Fence quote for the orchard cellar.')]);
    const lane = openLane(client);
    await lane.handler.pull({ max_items: 50 });
    writeOwnerTierRules([orchardSender], { env });
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ raised: 1, complete: true });
    // Hidden first, on its way to Private: no copy is served, so its names cannot be read from one.
    expect(lane.ledger.getCurrent(identity('fence'))).toMatchObject({ state: 'moving', targetMetadataTier: 'secure' });
    expect(lane.ledger.copies(identity('fence')).filter((copy) => copy.state === 'current')).toEqual([]);

    writeOwnerTierRules([orchardSender, { ...orchardSender, id: 'owner-sender-orchard-secrets', tier: 'secrets' }], { env });
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ secrets: 1, complete: true });
    expect(lane.ledger.getCurrent(identity('fence'))).toMatchObject({ contentTier: 'secrets' });
    expect(await olympusSearch(lane, 'orchard fence cellar')).not.toContain('Fence quote');
  });
});

describe('the stored-names pass is honest about what it skipped', () => {
  test('an item the rule could not be judged on keeps the rule pending (only it is retried) until it can be', async () => {
    const client = fakeGmail([
      orchardMail('first', 'Orchard fence', 'Fence quote for the orchard.'),
      orchardMail('second', 'Orchard gate', 'Gate quote for the orchard.'),
      message('other', { subject: 'Watering rota', body: 'Watering the roses.', labels: ['INBOX'], from: 'Sam <sam@example.com>' }),
    ]);
    const lane = openLane(client);
    await lane.handler.pull({ max_items: 50 });
    // A routed item whose copy the store no longer holds: its names cannot be read, so no rule can be judged on it.
    const ghost = { provider: 'gmail', accountScope: ACCOUNT, providerItemId: 'ghost', family: 'email' as const };
    lane.ledger.recordRoutedPlacement(ghost, movingTo('private'), lane.tierSet.placementFor(movingTo('private')));
    writeOwnerTierRules([orchardSender], { env });

    // The matches are raised; the unreadable one is not, and the rule is not done.
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ scanned: 4, raised: 2, complete: false });
    expect(JSON.parse(lane.ledger.readMeta('owner_rules_sweep')!).done).toEqual([]);
    // Retried alone, and still held.
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ scanned: 1, raised: 0, complete: false });

    // Once it has no copy at all it is no longer searchable, and the rule can be recorded.
    lane.ledger.removeCopies(ghost);
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ scanned: 1, complete: true });
    expect(JSON.parse(lane.ledger.readMeta('owner_rules_sweep')!).done).toHaveLength(1);
    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ scanned: 0, complete: true });
    expect(lane.ledger.getCurrent(identity('other'))).toMatchObject({ state: 'current' });
  });

  test.each([
    ['a malformed held identity', { rules: 'KEYS', retry: true, held: [{ provider: 7 }] }],
    ['a retry with nothing to retry', { rules: 'KEYS', retry: true }],
    ['a retry with an empty list', { rules: 'KEYS', retry: true, held: [] }],
  ] as const)('saved progress with %s starts the pass over instead of finishing it unscanned', async (_name, saved) => {
    const client = fakeGmail([orchardMail('first', 'Orchard fence', 'Fence quote for the orchard.')]);
    const lane = openLane(client);
    await lane.handler.pull({ max_items: 50 });
    writeOwnerTierRules([orchardSender], { env });
    const key = createHash('sha256')
      .update(JSON.stringify([orchardSender.id, orchardSender.source ?? '', orchardSender.match.kind, orchardSender.match.value, orchardSender.tier, orchardSender.strength]))
      .digest('hex')
      .slice(0, 24);
    lane.ledger.writeMeta('owner_rules_sweep', JSON.stringify({ done: [], pending: { ...saved, rules: [key] } }));

    expect(sweepOwnerRuleRaises({ set: lane.tierSet })).toMatchObject({ scanned: 1, raised: 1, complete: true });
    expect(lane.ledger.getCurrent(identity('first'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
  });
});

describe('rechecking a rule that was already applied', () => {
  const rule: OwnerTierRule = { id: 'owner-label-seven', source: 'gmail', match: { kind: 'label', value: 'Label_7' }, tier: 'secure', strength: 'force' };

  /** A label of one id per page, whose members can change between runs. */
  function pagedLabel(members: () => string[], requested: Array<string | undefined>) {
    return {
      async listLabelled(_label: string, page: { pageToken?: string }) {
        requested.push(page.pageToken);
        const ids = members();
        const at = page.pageToken ? Number(page.pageToken) : 0;
        return { ids: [ids[at]!], ...(at + 1 < ids.length ? { nextPageToken: String(at + 1) } : {}) };
      },
    };
  }

  test('a large label is covered over successive rechecks, not its first pages every time', async () => {
    const messages = ['a', 'b', 'c'].map((id) => message(id, { subject: `Note ${id}`, body: `Body of note ${id}.`, labels: ['INBOX'] }));
    const lane = openLane(fakeGmail(messages));
    await lane.handler.pull({ max_items: 50 });
    writeOwnerTierRules([rule], { env });
    let members = ['a'];
    const requested: Array<string | undefined> = [];
    const source = pagedLabel(() => members, requested);
    const sweep = (recheck: boolean) => sweepLabelRuleRaises({ set: lane.tierSet, provider: 'gmail', accountScope: ACCOUNT, source, recheck, maxPages: 1 });

    expect(await sweep(false)).toMatchObject({ raised: 1, pending: 0 });
    // The owner later labels two more messages, past what one recheck reads.
    members = ['a', 'b', 'c'];
    expect(await sweep(true)).toMatchObject({ raised: 0, pending: 1 });
    expect(await sweep(true)).toMatchObject({ raised: 1, pending: 1 });
    expect(await sweep(true)).toMatchObject({ raised: 1, pending: 0 });

    expect(requested).toEqual([undefined, undefined, '1', '2']);
    expect(lane.ledger.getCurrent(identity('c'))).toMatchObject({ state: 'moving', decidedBy: 'owner_rule' });
  });

  test('a failed recheck makes the rule pending and reported again until a recheck succeeds', async () => {
    const { client, lane } = await ingestTwo();
    saveLabelRule();
    const applied = await lane.handler.pull({ max_items: 50 });
    expect(applied.receipt.warnings ?? []).not.toContain(GMAIL_LABEL_RULES_PENDING_WARNING);

    client.failLabelListing = true;
    const failed = await lane.handler.reconcile();
    expect(failed.receipt.warnings).toContain(GMAIL_LABEL_RULES_PENDING_WARNING);
    expect(JSON.parse(lane.ledger.readMeta(LABEL_STATE_KEY)!).done).toEqual([]);

    // The pull retries it too, and keeps reporting while Gmail cannot answer.
    expect((await lane.handler.pull({ max_items: 50 })).receipt.warnings).toContain(GMAIL_LABEL_RULES_PENDING_WARNING);

    client.failLabelListing = false;
    const recovered = await lane.handler.reconcile();
    expect(recovered.receipt.warnings ?? []).not.toContain(GMAIL_LABEL_RULES_PENDING_WARNING);
    expect(JSON.parse(lane.ledger.readMeta(LABEL_STATE_KEY)!).done).toHaveLength(1);
  });
});
