// Review of PR #76 (critical, 2026-09-23): data loss on approval or narrowing,
// endless re-reads of a dormant mailbox, "always Private" not enforced, label
// skips by id, picker budget isolation, no-op saves and the month-end cutoff.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  approveMailSourceScope,
  compileGmailMailScope,
  defaultMailScopeSelection,
  mailScopeContentAfter,
  readMailSourceScopeApproval,
  type MailScopeSelection,
} from '../src/core/mail-source-scope.ts';
import type { SourceConnectorListPage, RawItem } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GoogleGmailSourceConnector,
  createGmailConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailApiClient,
  GmailConnectorScope,
  GmailGetMessageOptions,
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import {
  createGmailMailScopeBrowser,
  createGmailPickerRequestBudget,
  GMAIL_PICKER_DAILY_REQUEST_BUDGET,
} from '../src/workers/google-connectors/gmail-scope-browser.ts';
import { GoogleDailyRequestBudget } from '../src/workers/google-connectors/request-budget.ts';
import { gmailConnectorScopeFromApproval } from '../src/workers/source-scope-runtime.ts';
import { promotedWatermark } from '../src/workers/google-connectors/gmail.ts';
import { ownerSenderRuleMatches, senderAddress, senderMatchesRule } from '../src/core/sender-rules.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { mailScopeOwnerTierRules } from '../src/core/mail-source-scope.ts';
import { closeSqliteStore } from '../src/core/sqlite-store.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY = 86_400_000;
const tempDirs: string[] = [];
const openStores: LocalConnectorStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-mail-scope-fix-'));
  tempDirs.push(dir);
  return dir;
}

function fileStores(dir: string) {
  const internalStore = new LocalConnectorStore({
    dbPath: join(dir, 'internal.sqlite'), corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: join(dir, 'secure.sqlite'), corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID, family: 'email', trustDomain: 'secure_local',
  });
  openStores.push(internalStore, secureStore);
  return { internalStore, secureStore };
}

/** Fresh random vectors on every call, so any re-embed changes the stored bytes. */
function recordingProvider(backend: 'cloud' | 'local', inputs: string[] = []): SourceEmbeddingProvider {
  return {
    provider: backend === 'cloud' ? 'cloud-test' : 'local-test',
    backend,
    modelId: `${backend}-test-model`,
    dimension: 2,
    configHash: `${backend}-config`,
    epochId: `${backend}-epoch`,
    async embed(batch: readonly unknown[]) {
      inputs.push(...batch.map((entry) => JSON.stringify(entry)));
      return batch.map(() => [Math.random(), Math.random()]);
    },
  } as SourceEmbeddingProvider;
}

function readDb<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    closeSqliteStore(db, { checkpoint: false });
  }
}

const vectors = (path: string) => readDb(path, (db) =>
  (db.query('SELECT chunk_pk, embedding FROM chunk_embeddings ORDER BY chunk_pk').all() as Array<{ chunk_pk: number; embedding: Uint8Array }>)
    .map((row) => ({ chunk_pk: row.chunk_pk, embedding: Buffer.from(row.embedding).toString('hex') })));
const chunkCount = (path: string) => readDb(path, (db) => (db.query('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n);

const identity = (id: string) => ({
  family: 'email' as const, provider: 'gmail', accountScope: 'personal', providerItemId: id, localItemId: `personal:${id}`,
});

function laneFor(
  stores: ReturnType<typeof fileStores>,
  client: FakeClient,
  input: { scope?: GmailConnectorScope; revision?: string; internal: SourceEmbeddingProvider; secure: SourceEmbeddingProvider },
) {
  return createGmailConnectorStoreSyncHandler({
    ...stores,
    account: 'personal',
    apiClient: client,
    env: {},
    internalEmbeddingProvider: input.internal,
    secureEmbeddingProvider: input.secure,
    ...(input.scope ? { scope: input.scope, scopeApproval: { generation: 'g'.repeat(64), revision: input.revision ?? 'rev-1' } } : {}),
  });
}

describe('no existing embeddings are thrown away by a scope', () => {
  test.each([
    ['the first approval of an already-ingested mailbox', undefined, 2],
    ['a 5-year to 2-year narrowing', 5, 2],
  ] as const)('%s keeps chunks and byte-identical vectors of mail now outside the window', async (_name, fromYears, toYears) => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const client = fakeClient([
      message('recent', NOW.getTime() - 10 * DAY),
      message('old', NOW.getTime() - 3 * 365 * DAY),
    ]);
    const internal = recordingProvider('cloud');
    const secure = recordingProvider('local');
    const cutoff = (years: number) => NOW.getTime() - years * 365 * DAY;

    // Before: both messages stored with their bodies and embedded.
    const wide = laneFor(stores, client, {
      ...(fromYears ? { scope: { contentAfterMs: cutoff(fromYears) }, revision: 'rev-wide' } : {}),
      internal, secure,
    });
    const first = await wide.pull({ max_items: 50 });
    if (first.checkpoint) await wide.pull({ max_items: 50, checkpoint: first.checkpoint });
    const internalPath = join(dir, 'internal.sqlite');
    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 1 });
    const chunksBefore = chunkCount(internalPath);
    const before = vectors(internalPath);
    expect(before.length).toBe(chunksBefore);
    expect(chunksBefore).toBeGreaterThan(0);

    // After: the narrower revision's fresh traversal, both legs.
    const getsBefore = client.formats.length;
    const narrow = laneFor(stores, client, { scope: { contentAfterMs: cutoff(toYears) }, revision: 'rev-narrow', internal, secure });
    const contentLeg = await narrow.pull({ max_items: 50 });
    expect(contentLeg.checkpoint).toBeTruthy();
    await narrow.pull({ max_items: 50, checkpoint: contentLeg.checkpoint! });

    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 1 });
    expect(chunkCount(internalPath)).toBe(chunksBefore);
    expect(vectors(internalPath)).toEqual(before);
    // Held mail is not even fetched again: no provider get, no body-less re-observation.
    expect(client.formats.length).toBe(getsBefore);
  });

  test('widening the window still upgrades mail held only as metadata', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const client = fakeClient([message('old', NOW.getTime() - 3 * 365 * DAY)]);
    const internal = recordingProvider('cloud');
    const secure = recordingProvider('local');
    const narrow = laneFor(stores, client, { scope: { contentAfterMs: NOW.getTime() - 2 * 365 * DAY }, revision: 'rev-2y', internal, secure });
    const leg = await narrow.pull({ max_items: 50 });
    await narrow.pull({ max_items: 50, checkpoint: leg.checkpoint! });
    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 0 });

    await laneFor(stores, client, { scope: { contentAfterMs: NOW.getTime() - 5 * 365 * DAY }, revision: 'rev-5y', internal, secure })
      .pull({ max_items: 50 });
    expect(stores.internalStore.itemStoredContent(identity('old'))).toMatchObject({ chunkCount: 1 });
  });
});

describe('a dormant mailbox is not re-read forever', () => {
  test('a traversal with nothing newer than the cutoff completes with a watermark; the next pass fetches nothing', async () => {
    const cutoffMs = Date.parse('2024-09-23T00:00:00.000Z');
    const client = fakeClient([message('old-1', cutoffMs - 10 * DAY), message('old-2', cutoffMs - 20 * DAY)]);
    const connector = () => new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: {}, scope: { contentAfterMs: cutoffMs }, now: () => NOW.getTime(),
    });
    const contentLeg = await collect(connector().listItems({ limit: 50 }));
    expect(contentLeg.items).toHaveLength(0);
    const metadataLeg = await collect(connector().listItems({ limit: 50, cursor: contentLeg.cursor! }));
    expect(metadataLeg.done).toBe(true);
    expect(metadataLeg.cursor).toBeDefined();
    const gets = client.formats.length;
    const second = await collect(connector().listItems({ limit: 50, cursor: metadataLeg.cursor! }));
    expect(second.items).toHaveLength(0);
    // Completed on the traversal's own start less a day (never the whole older mailbox).
    expect(client.queries.at(-1)).toBe(`after:${Math.floor((NOW.getTime() - DAY) / 1_000)}`);
    const third = await collect(connector().listItems({ limit: 50, cursor: second.cursor! }));
    expect(third.items).toHaveLength(0);
    expect(client.formats.length).toBe(gets);
  });
});

describe('"always Private" is enforced', () => {
  test('the sender\'s mail is S4, stored and embedded only in the secure store, never by the cloud embedder', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const clinic: GmailMessage = {
      ...message('clinic', NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Your appointment' }, { name: 'From', value: 'Portal <portal@clinic.example>' }],
        body: { data: Buffer.from('Body of clinic.').toString('base64url') },
      },
    };
    const client = fakeClient([clinic, message('ordinary', NOW.getTime() - 2 * DAY)]);
    const cloudInputs: string[] = [];
    const privateInputs: string[] = [];
    const scope = gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@clinic.example'] }) });
    expect(scope.ownerTierRules).toMatchObject([{ match: { kind: 'sender', value: '@clinic.example' }, tier: 'secure', strength: 'force' }]);
    const ruleId = scope.ownerTierRules![0]!.id;
    const outcome = await laneFor(stores, client, {
      scope, internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local', privateInputs),
    }).pull({ max_items: 50 });

    expect(stores.secureStore.itemPresence(identity('clinic'))).toMatchObject({ active: true });
    expect(stores.internalStore.itemPresence(identity('clinic')).active).toBe(false);
    expect(stores.internalStore.itemPresence(identity('ordinary')).active).toBe(true);
    expect(outcome.receipt.counts.secure_chunks_embedded).toBeGreaterThan(0);
    expect(cloudInputs.join('\n')).not.toContain('Body of clinic');
    expect(privateInputs.join('\n')).toContain('Body of clinic');

    // The four-tier ledger records the owner rule as the reason, Private both layers.
    const recorded = stores.secureStore.tierLedger()?.getCurrent(identity('clinic'));
    expect(recorded).toMatchObject({ metadataTier: 'secure', contentTier: 'secure', decidedBy: 'owner_rule' });
    expect(recorded!.reasons).toContain(`metadata:owner_rule:sender:${ruleId}:force`);
    expect(recorded!.reasons.join(' ')).not.toContain('clinic');
  });
});

describe('skipped labels', () => {
  test('are enforced by label id after the fetch; system labels compile to in:', async () => {
    const tagged = { ...message('tagged', NOW.getTime() - DAY), labelIds: ['INBOX', 'Label_7'] };
    const chat = { ...message('chat', NOW.getTime() - DAY), labelIds: ['CHAT'] };
    const client = fakeClient([tagged, chat, message('plain', NOW.getTime() - 2 * DAY)]);
    const page = await collect(new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: {}, scope: { skippedLabelIds: ['Label_7', 'CHAT'] },
    }).listItems({ limit: 50 }));
    expect(page.items.map((item) => item.identity.providerItemId)).toEqual(['plain']);
    const compiled = compileGmailMailScope(withCutoff({
      skippedCategories: [],
      skippedLabels: [{ id: 'SENT', name: 'SENT' }, { id: 'CHAT', name: 'CHAT' }, { id: 'Label_7', name: 'Renamed Label' }],
    }));
    expect(compiled.baseQuery).toBe('-in:sent -in:chats -label:"Renamed Label"');
    expect(compiled.skippedLabelIds).toEqual(['SENT', 'CHAT', 'Label_7']);
  });
});

describe('saves and cutoffs', () => {
  test('an unchanged save is a no-op; other changes keep the cutoff unless the window changes', () => {
    const statePath = join(tempDir(), 'mail-source-scopes.json');
    const registry = gmailRegistry();
    const pending = readMailSourceScopeApproval({ registry, statePath });
    const first = approveMailSourceScope({
      registry, statePath, accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision,
      scope: defaultMailScopeSelection(), now: NOW,
    });
    const later = new Date(NOW.getTime() + 40 * DAY);
    const same = approveMailSourceScope({
      registry, statePath, accountGeneration: first.accountGeneration!, expectedRevision: first.revision,
      scope: defaultMailScopeSelection(), now: later,
    });
    expect(same.revision).toBe(first.revision);
    expect(same.mailScope?.contentAfter).toBe(first.mailScope?.contentAfter);
    const senders = approveMailSourceScope({
      registry, statePath, accountGeneration: first.accountGeneration!, expectedRevision: first.revision,
      scope: { ...defaultMailScopeSelection(), skipSenders: ['@spam.example'] }, now: later,
    });
    expect(senders.revision).not.toBe(first.revision);
    expect(senders.mailScope?.contentAfter).toBe(first.mailScope?.contentAfter);
    const window = approveMailSourceScope({
      registry, statePath, accountGeneration: first.accountGeneration!, expectedRevision: senders.revision,
      scope: { ...defaultMailScopeSelection(), window: '1y', skipSenders: ['@spam.example'] }, now: later,
    });
    expect(window.mailScope?.contentAfter).toBe(mailScopeContentAfter('1y', later));
  });

  test('the window cutoff clamps to the end of a shorter month', () => {
    expect(mailScopeContentAfter('6m', new Date('2026-08-31T15:00:00.000Z'))).toBe('2026-02-28T00:00:00.000Z');
    expect(mailScopeContentAfter('2y', new Date('2026-02-28T15:00:00.000Z'))).toBe('2024-02-28T00:00:00.000Z');
    expect(mailScopeContentAfter('1y', new Date('2028-02-29T15:00:00.000Z'))).toBe('2027-02-28T00:00:00.000Z');
  });
});

describe('re-review at 537f909b', () => {
  test('a held message with a future Date header cannot stop new mail from being read', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const spam: GmailMessage = {
      ...message('spam', NOW.getTime() - 5 * DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: 'From the future' },
          { name: 'From', value: 'Spam <spam@example.com>' },
          { name: 'Date', value: new Date('2036-01-01T00:00:00.000Z').toUTCString() },
        ],
        body: { data: Buffer.from('Body of spam.').toString('base64url') },
      },
    };
    const mailbox = [spam];
    const client = fakeClient(mailbox);
    const internal = recordingProvider('cloud');
    const secure = recordingProvider('local');
    // Held before the scope was approved, stored with its 2036 Date header.
    await laneFor(stores, client, { internal, secure }).pull({ max_items: 50 });
    expect(stores.internalStore.itemStoredContent(identity('spam'))).toMatchObject({ chunkCount: 1 });

    let clock = NOW.getTime();
    const scoped = createGmailConnectorStoreSyncHandler({
      ...stores, account: 'personal', apiClient: client, env: {}, now: () => clock,
      internalEmbeddingProvider: internal, secureEmbeddingProvider: secure,
      scope: { contentAfterMs: NOW.getTime() - 2 * 365 * DAY },
      scopeApproval: { generation: 'g'.repeat(64), revision: 'rev-1' },
    });
    const contentLeg = await scoped.pull({ max_items: 50 });
    const metadataLeg = await scoped.pull({ max_items: 50, checkpoint: contentLeg.checkpoint! });
    // The completed traversal's bound sits at its own start less a day, never at 2036.
    const bound = Number(/after:(\d+)/.exec(client.queries.at(-1) ?? '')?.[1] ?? '0');
    expect(bound * 1_000).toBeLessThanOrEqual(clock);

    clock += 3_600_000;
    mailbox.push(message('fresh', clock - 60_000));
    await scoped.pull({ max_items: 50, checkpoint: metadataLeg.checkpoint! });
    const next = Number(/after:(\d+)/.exec(client.queries.at(-1) ?? '')?.[1] ?? '0');
    expect(next * 1_000).toBeLessThan(clock);
    expect(stores.internalStore.itemStoredContent(identity('fresh'))).toMatchObject({ chunkCount: 1 });
  });

  test('watermarks are capped at the clock', () => {
    expect(promotedWatermark({ highWaterMs: Date.parse('2036-01-01T00:00:00Z'), nowMs: NOW.getTime() })).toBe(NOW.getTime());
    expect(promotedWatermark({ floorMs: NOW.getTime() - DAY, cutoffMs: NOW.getTime() - 400 * DAY, nowMs: NOW.getTime() }))
      .toBe(NOW.getTime() - DAY);
    expect(promotedWatermark({ nowMs: NOW.getTime() })).toBeUndefined();
  });

  test('an @domain rule covers subdomains on a label boundary', () => {
    expect(senderMatchesRule('Appointments <appointments@mail.therapist.example>', '@therapist.example')).toBe(true);
    expect(senderMatchesRule('dr@therapist.example', '@therapist.example')).toBe(true);
    expect(senderMatchesRule('x@evil-therapist.example', '@therapist.example')).toBe(false);
    expect(senderMatchesRule('x@therapist.example.evil.com', '@therapist.example')).toBe(false);
    expect(senderMatchesRule('Dr <DR@Therapist.Example>', 'dr@therapist.example')).toBe(true);
    expect(senderMatchesRule('evildr@therapist.example', 'dr@therapist.example')).toBe(false);
  });

  test('"always Private" @domain raises subdomain senders and not look-alikes or display-name addresses', () => {
    const rules = mailScopeOwnerTierRules({ alwaysPrivateSenders: ['@therapist.example'] });
    const decide = (sender: string) => classifyItemTiers({ signals: { sender, title: 'Hello' }, provider: 'gmail' }, { rules });
    expect(decide('Appointments <appointments@mail.therapist.example>')).toMatchObject({ metadataTier: 'secure', decidedBy: 'owner_rule' });
    expect(decide('x@evil-therapist.example').decidedBy).not.toBe('owner_rule');
    // An address inside the display name is not the sender.
    expect(decide('"dr@therapist.example" <spam@evil.example>').decidedBy).not.toBe('owner_rule');
    // A bare fragment is honoured by substring only for a raising rule.
    const fragment = (tier: 'secure' | 'public') => classifyItemTiers({ signals: { sender: 'x@clinic.example' }, provider: 'gmail' }, {
      rules: [{ id: 'fragment', match: { kind: 'sender', value: 'clinic' }, tier, strength: 'force' }],
    });
    expect(fragment('secure').decidedBy).toBe('owner_rule');
    expect(fragment('public').decidedBy).not.toBe('owner_rule');
  });

  test('skip and private rules match the actual sender address only', () => {
    expect(senderMatchesRule('"news@shop.example" <spam@evil.example>', '@shop.example')).toBe(false);
    expect(senderMatchesRule('Shop <news@shop.example>', '@shop.example')).toBe(true);
    expect(senderMatchesRule('news@shop.example', '@shop.example')).toBe(true);
  });

  test('"always Private" subdomain mail goes to the secure store, never the cloud embedder', async () => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const sub: GmailMessage = {
      ...message('sub', NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Appointment' }, { name: 'From', value: 'Appointments <appointments@mail.therapist.example>' }],
        body: { data: Buffer.from('Body of sub.').toString('base64url') },
      },
    };
    const cloudInputs: string[] = [];
    await laneFor(stores, fakeClient([sub]), {
      scope: gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@therapist.example'] }) }),
      internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local'),
    }).pull({ max_items: 50 });
    expect(stores.secureStore.itemStoredContent(identity('sub'))).toBeDefined();
    expect(stores.internalStore.itemStoredContent(identity('sub'))).toBeUndefined();
    expect(cloudInputs.join('\n')).not.toContain('Body of sub');
  });

  test('the skip list is re-checked after the fetch with the same domain semantics', async () => {
    const withFrom = (id: string, from: string): GmailMessage => ({
      ...message(id, NOW.getTime() - DAY),
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: id }, { name: 'From', value: from }], body: { data: Buffer.from(`Body of ${id}.`).toString('base64url') } },
    });
    const client = fakeClient([
      withFrom('sub', 'news@mail.shop.example'),
      withFrom('lookalike', 'news@notshop.example'),
    ]);
    const page = await collect(new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: {}, scope: { skipSenders: ['@shop.example'] },
    }).listItems({ limit: 50 }));
    expect(page.items.map((item) => item.identity.providerItemId)).toEqual(['lookalike']);
  });
});

describe('delta review at 15d261cb: sender parsing', () => {
  const COMMENT_FORM = 'dr@therapist.example (Dr T)';
  const UNPARSEABLE = 'appointments@mail.therapist.example via Portal';

  test('common legal From forms parse to the real sender address', () => {
    expect(senderAddress(COMMENT_FORM)).toEqual({ address: 'dr@therapist.example', domain: 'therapist.example' });
    expect(senderAddress('Dr T (clinic) <DR@Therapist.Example>')?.address).toBe('dr@therapist.example');
    expect(senderAddress('"Doe, Jane (Dr)" <jane@therapist.example>')?.address).toBe('jane@therapist.example');
    expect(senderAddress('"jane doe"@therapist.example')?.address).toBe('"jane doe"@therapist.example');
    expect(senderAddress('jane@therapist.example (nested (comment))')?.address).toBe('jane@therapist.example');
    expect(senderAddress(UNPARSEABLE)).toBeUndefined();
  });

  test('a raise rule matches the comment form and falls back to every address when the sender is unparseable', () => {
    expect(ownerSenderRuleMatches(COMMENT_FORM, '@therapist.example', true)).toBe(true);
    expect(ownerSenderRuleMatches(UNPARSEABLE, '@therapist.example', true)).toBe(true);
    // No fallback for a rule that does not raise.
    expect(ownerSenderRuleMatches(UNPARSEABLE, '@therapist.example', false)).toBe(false);
    // A parsed sender is never widened: a display-name address still does not count.
    expect(ownerSenderRuleMatches('"dr@therapist.example" <spam@evil.example>', '@therapist.example', true)).toBe(false);
  });

  test('a skip rule matches the comment form but never skips an unparseable sender', () => {
    expect(senderMatchesRule(COMMENT_FORM, '@therapist.example')).toBe(true);
    expect(senderMatchesRule(UNPARSEABLE, '@therapist.example')).toBe(false);
  });

  test.each([
    ['comment form', COMMENT_FORM, 'comment'],
    ['unparseable header', UNPARSEABLE, 'unparseable'],
  ] as const)('"always Private" %s mail goes to the secure store and the ledger records the owner rule', async (_name, from, id) => {
    const dir = tempDir();
    const stores = fileStores(dir);
    const mail: GmailMessage = {
      ...message(id, NOW.getTime() - DAY),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'Subject', value: 'Appointment' }, { name: 'From', value: from }],
        body: { data: Buffer.from(`Body of ${id}.`).toString('base64url') },
      },
    };
    const cloudInputs: string[] = [];
    const scope = gmailConnectorScopeFromApproval({ mailScope: withCutoff({ alwaysPrivateSenders: ['@therapist.example'] }) });
    await laneFor(stores, fakeClient([mail]), {
      scope, internal: recordingProvider('cloud', cloudInputs), secure: recordingProvider('local'),
    }).pull({ max_items: 50 });
    expect(stores.secureStore.itemStoredContent(identity(id))).toBeDefined();
    expect(stores.internalStore.itemStoredContent(identity(id))).toBeUndefined();
    expect(cloudInputs.join('\n')).not.toContain(`Body of ${id}`);
    const recorded = stores.secureStore.tierLedger()?.getCurrent(identity(id));
    expect(recorded).toMatchObject({ metadataTier: 'secure', decidedBy: 'owner_rule' });
  });

  test.each([
    ['comment form', COMMENT_FORM, true],
    ['unparseable header', UNPARSEABLE, false],
  ] as const)('the skip list on the %s: skipped only when the sender is read', async (_name, from, skipped) => {
    const mail: GmailMessage = {
      ...message('m', NOW.getTime() - DAY),
      payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'x' }, { name: 'From', value: from }], body: { data: Buffer.from('Body.').toString('base64url') } },
    };
    const page = await collect(new GoogleGmailSourceConnector({
      apiClient: fakeClient([mail]), account: 'personal', env: {}, scope: { skipSenders: ['@therapist.example'] },
    }).listItems({ limit: 50 }));
    expect(page.items).toHaveLength(skipped ? 0 : 1);
  });
});

describe('picker budget', () => {
  test('picker requests are charged to their own capped allowance, never to the lane budget', async () => {
    const dir = tempDir();
    const lanePath = join(dir, 'gmail-daily-request-budget.json');
    const laneBudget = new GoogleDailyRequestBudget({ provider: 'Gmail', dailyRequestBudget: 5_000, statePath: lanePath });
    const pickerBudget = createGmailPickerRequestBudget({ laneStatePath: lanePath });
    const client = fakeClient(Array.from({ length: 5 }, (_, index) => message(`m-${index}`, NOW.getTime() - index * DAY)));
    await createGmailMailScopeBrowser({
      credentialHandle: 'gmail.personal', account: 'personal', apiClient: client, env: {}, requestBudget: pickerBudget,
    }).summarize({ scope: defaultMailScopeSelection(), now: NOW });
    expect(pickerBudget.status().requests).toBe(1 + 5 + 2 + 5);
    expect(pickerBudget.status().dailyRequestBudget).toBe(GMAIL_PICKER_DAILY_REQUEST_BUDGET);
    expect(GMAIL_PICKER_DAILY_REQUEST_BUDGET).toBeLessThan(5_000);
    expect(laneBudget.status().requests).toBe(0);
  });
});

function withCutoff(overrides: Partial<MailScopeSelection> = {}): MailScopeSelection {
  return { ...defaultMailScopeSelection(), contentAfter: mailScopeContentAfter('2y', NOW)!, ...overrides };
}

function gmailRegistry() {
  return {
    handles: [{
      handle: 'gmail.personal',
      provider: 'gmail',
      allowedCapabilities: ['gmail.email.sync'],
      connectedAt: '2026-09-23T10:00:00.000Z',
      accountRole: 'personal',
      providerAccountId: 'account-gmail',
    }],
  };
}

interface FakeClient extends GmailApiClient {
  queries: Array<string | undefined>;
  formats: string[];
}

function fakeClient(messages: GmailMessage[]): FakeClient {
  const client: FakeClient = {
    queries: [],
    formats: [],
    async listMessages(request: GmailListMessagesRequest) {
      client.queries.push(request.query);
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const before = /before:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = messages.filter((entry) => {
        const at = Number(entry.internalDate);
        return (!after || at > Number(after) * 1_000) && (!before || at < Number(before) * 1_000);
      });
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.maxResults);
      return {
        messages: slice.map((entry) => ({ id: entry.id })),
        ...(offset + slice.length < eligible.length ? { nextPageToken: String(offset + slice.length) } : {}),
        resultSizeEstimate: eligible.length,
      };
    },
    async getMessage(id: string, request?: GmailGetMessageOptions) {
      client.formats.push(request?.format ?? 'full');
      const found = messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      return request?.format === 'metadata' ? { ...found, payload: { headers: found.payload?.headers ?? [] } } : found;
    },
    async listLabels() {
      return [{ id: 'Label_1', name: 'Family', type: 'user' as const }];
    },
    async getLabel(id: string) {
      return { id, name: id, type: 'system' as const, messagesTotal: 100 };
    },
  };
  return client;
}

function message(id: string, internalDateMs: number): GmailMessage {
  return {
    id,
    threadId: `thread-${id}`,
    historyId: '1000',
    internalDate: String(internalDateMs),
    labelIds: ['INBOX'],
    snippet: `Snippet of ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: `Subject ${id}` },
        { name: 'From', value: 'Alex <alex@example.com>' },
        { name: 'Date', value: new Date(internalDateMs).toUTCString() },
      ],
      body: { data: Buffer.from(`Body of ${id}.`).toString('base64url') },
    },
  };
}

async function collect(pages: AsyncIterable<SourceConnectorListPage>) {
  const items: RawItem[] = [];
  let cursor: string | undefined;
  let done = false;
  for await (const page of pages) {
    items.push(...page.items);
    cursor = page.nextCursor;
    done = page.done;
  }
  return { items, cursor, done };
}
