// Mail older than the approved window is kept as names only on purpose, so
// no Gmail store may count it as owed reading. These tests drive the real
// mail approval and the real status handler; expected counts come from the
// fixture's own dates, never from running the code under test.

import { createStoreEmbeddingScopeFor, createStoreScopes } from '../src/workers/engine/runtime/store-scope-policies.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { defaultMailScopeSelection } from '../src/core/mail-source-scope.ts';
import { embedPendingChunks, LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { planStoreEmbedding, scopedEmbeddingOptions } from '../src/workers/connector-store/embedding-plan.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';
import { gmailRetainedAccountMatches } from '../src/workers/email-source/gmail-status-scope.ts';
import { defineInternalEmailCorpus, gmailCursorConnectorIds } from '../src/workers/google-connectors/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';

const DAY_MS = 86_400_000;
const roots: string[] = [];
const stores: LocalConnectorStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-gmail-status-scope-'));
  roots.push(dir);
  return dir;
}

function registry(connectedAt = '2026-10-01T10:00:00.000Z') {
  return {
    version: 1 as const,
    handles: [{
      handle: 'gmail.personal',
      provider: 'gmail' as const,
      allowedCapabilities: ['gmail.email.sync'],
      scopes: [],
      connectedAt,
      accountRole: 'personal',
      providerAccountId: 'account-gmail.personal',
    }],
  };
}

/** An authority with the mail scope not yet approved. */
function authority(): FileSourceScopeAuthority {
  const dir = tempDir();
  return new FileSourceScopeAuthority({ registryPath: join(dir, 'handles.json'), readRegistry: () => registry() });
}

function approve(subject: FileSourceScopeAuthority, window: '6m' | '1y' | '2y' | '5y' | 'all'): void {
  const current = subject.mailSnapshot();
  subject.approveMail({
    accountGeneration: current.accountGeneration!,
    expectedRevision: current.revision,
    scope: { ...defaultMailScopeSelection(), window },
  });
}

test('a verified rename of an address-only grant can use its own retained account', () => {
  const connectedAt = '2026-10-01T10:00:00.000Z';
  const account = {
    handle: { connectedAt, providerAccountId: 'google:oldaddress' },
    binding: { bound_grant: connectedAt, provider_account_id: 'google-sub:owner.google:newaddress' },
    historyAccountId: 'google-sub:owner.google:newaddress',
  };
  expect(gmailRetainedAccountMatches({ ...account, currentGrantVerified: () => true })).toBe(true);
  expect(gmailRetainedAccountMatches({ ...account, currentGrantVerified: () => false })).toBe(false);
  expect(gmailRetainedAccountMatches({ ...account, handle: { ...account.handle, connectedAt: 'another grant' }, currentGrantVerified: () => true })).toBe(false);
});

test('disconnecting a refused mailbox leaves the retained library available locally', () => {
  const binding = { provider_account_id: 'google-sub:owner', purge_required: { reason: 'account_changed' as const, detected_at: '2026-10-01' } };
  const handle = { providerAccountId: 'google-sub:other', connectedAt: '2026-10-01' };
  expect(gmailRetainedAccountMatches({ binding, historyAccountId: binding.provider_account_id, handle })).toBe(false);
  expect(gmailRetainedAccountMatches({ binding, historyAccountId: binding.provider_account_id, handle: undefined })).toBe(true);
});

function statusScope(authority: FileSourceScopeAuthority | undefined, domain: 'internal' | 'secure_local', account?: string) {
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: domain + '.email', trustDomain: domain, family: 'email', tierLedger: null });
  stores.push(store);
  return createStoreScopes({
    authority, sourceIdForStore: () => 'gmail.email', readScope: () => ({ allowed: true, contentAllowed: true }),
    gmailRetainedAccountScope: () => account,
  }).statusScopeFor(store, undefined);
}

describe('Gmail store status scope: the approved window', () => {
  test('a 2-year window passes the approval\'s own cutoff to the Personal store', () => {
    const subject = authority();
    approve(subject, '2y');
    const cutoff = subject.mailSnapshot().mailScope?.contentAfter;
    expect(cutoff).toBeDefined();
    // Independent of the approval code: a cutoff about two years back.
    const ageDays = (Date.now() - Date.parse(cutoff!)) / DAY_MS;
    expect(ageDays).toBeGreaterThan(728);
    expect(ageDays).toBeLessThan(733);
    expect(statusScope(subject, 'internal', 'personal').contentNotBefore).toBe(cutoff);
  });

  test('"everything" has no window, so the Personal store is counted exactly as before', () => {
    const subject = authority();
    approve(subject, 'all');
    expect(subject.mailSnapshot().mailScope?.contentAfter).toBeUndefined();
    expect(statusScope(subject, 'internal', 'personal').contentNotBefore).toBeUndefined();
  });

  test('no approved mail scope means no window and no authority means none either', () => {
    expect(statusScope(authority(), 'internal').contentNotBefore).toBeUndefined();
    expect(statusScope(undefined, 'internal').contentNotBefore).toBeUndefined();
  });

  test('the Private store keeps its approved-observation scope and adds the same window', () => {
    const subject = authority();
    approve(subject, '6m');
    const ref = subject.mailPolicyRef()!;
    const cutoff = subject.mailSnapshot().mailScope?.contentAfter;
    const ids = gmailCursorConnectorIds('personal', { generation: ref.accountGeneration, revision: ref.revision });
    const observed = {
      provider: 'gmail',
      observedConnectorId: ids.connectorId, previousObservedConnectorId: ids.previousId,
      // Mail an import brought into the account is in the approved scope too.
      observedConnectorIdPrefix: 'archive.',
    };
    expect(statusScope(subject, 'secure_local', 'personal')).toMatchObject({
      accountScope: 'personal',
      scopeRevision: ref.revision,
      itemFilters: observed,
      contentAllowed: true,
      contentFilters: observed,
      contentNotBefore: cutoff!,
    });
  });

  test('the Private store under "everything" is exactly its approved-observation scope, with no window', () => {
    const subject = authority();
    approve(subject, 'all');
    const scope = statusScope(subject, 'secure_local', 'personal');
    expect(scope.contentAllowed).toBe(true);
    expect(scope.scopeRevision).toBe(subject.mailPolicyRef()!.revision);
    expect('contentNotBefore' in scope).toBe(false);
  });

  test('the Private store counts nothing for an unverified mail account', () => {
    const pending = authority();
    expect(statusScope(pending, 'secure_local', undefined))
      .toMatchObject({ itemsAllowed: false, contentAllowed: false, embedding: { contentAllowed: false } });
    const approved = authority();
    approve(approved, '2y');
    expect(statusScope(approved, 'secure_local', undefined))
      .toMatchObject({ itemsAllowed: false, contentAllowed: false, embedding: { contentAllowed: false } });
    expect(statusScope(undefined, 'secure_local', undefined))
      .toMatchObject({ itemsAllowed: false, contentAllowed: false, embedding: { contentAllowed: false } });
  });
});

describe('Gmail store status scope: what the status handler publishes', () => {
  function mailConnector(connectorId: string, sample?: { id: string; text: string }): SourceConnector {
    const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    const mail: Array<{ id: string; authoredAt: string; text?: string }> = sample ? [{ ...sample, authoredAt: daysAgo(1) }] : [
      { id: 'recent', authoredAt: daysAgo(20), text: 'Dinner on Saturday?' },
      { id: 'three-years-old-names-only', authoredAt: daysAgo(3 * 365) },
      { id: 'four-years-old-names-only', authoredAt: daysAgo(4 * 365) },
      { id: 'three-years-old-with-text', authoredAt: daysAgo(3 * 365 + 30), text: 'Kept in full from an earlier window.' },
    ];
    const items = mail.map((entry): RawItem => ({
      identity: {
        family: 'email',
        provider: 'gmail',
        accountScope: 'personal',
        providerItemId: entry.id,
        localItemId: `personal:${entry.id}`,
        sourceVersion: '1',
      },
      mimeType: 'message/rfc822',
      content: entry.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: entry.text },
      metadata: Object.freeze({
        title: `Subject ${entry.id}`,
        subject: `Subject ${entry.id}`,
        from: 'sender@example.com',
        authoredAt: entry.authoredAt,
        locatorUri: `https://mail.google.com/mail/u/0/#all/${entry.id}`,
      }),
      fetchedAt: new Date().toISOString(),
    }));
    return {
      id: connectorId,
      family: 'email',
      async authenticate(): Promise<void> {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items, done: true };
        })();
      },
      async fetchItem(localItemId: string): Promise<RawItem> {
        const found = items.find((item) => item.identity.localItemId === localItemId);
        if (!found) throw new Error(`missing fixture ${localItemId}`);
        return found;
      },
      classificationSignals() {
        return {};
      },
    };
  }

  async function internalCounts(subject: FileSourceScopeAuthority): Promise<Record<string, number>> {
    const store = new LocalConnectorStore({
      dbPath: join(tempDir(), 'gmail-connector-store.sqlite'),
      corpusId: 'internal.email',
      family: 'email',
      trustDomain: 'internal',
    });
    stores.push(store);
    const ref = subject.mailPolicyRef()!;
    const ids = gmailCursorConnectorIds('personal', { generation: ref.accountGeneration, revision: ref.revision });
    await store.syncFromConnector(mailConnector(ids.connectorId), { fetchContent: true });
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: () => [defineInternalEmailCorpus()],
      connectorStores: [store],
      connectorStoreStatusScope: (leg) => createStoreScopes({
        authority: subject, sourceIdForStore: () => 'gmail.email', readScope: () => ({ allowed: true }),
        gmailRetainedAccountScope: () => 'personal',
      }).statusScopeFor(leg, undefined),
    });
    const result = await handler.status({ corpus_id: 'internal.email' });
    const corpus = result.corpora.find((entry) => entry.corpus_id === 'internal.email');
    if (!corpus || !corpus.configured) throw new Error('internal.email status missing');
    return corpus.counts as Record<string, number>;
  }

  test('a 2-year window takes the two older names-only rows out of the owed population', async () => {
    const subject = authority();
    approve(subject, '2y');
    const counts = await internalCounts(subject);
    // Four rows are stored. Two are older than the window and hold no text.
    expect(counts['indexed_items']).toBe(4);
    expect(counts['items_with_text']).toBe(2);
    expect(counts['qa_out_of_content_scope']).toBe(2);
    // The scope narrows nothing else: no file-scope vocabulary appears for mail.
    for (const key of ['qa_eligible_items', 'qa_metadata_only_expected', 'scope_metadata_only_files', 'scope_full_ingestion_files']) {
      expect(key in counts).toBe(false);
    }
  });

  test('"everything" publishes no exemption', async () => {
    const subject = authority();
    approve(subject, 'all');
    const counts = await internalCounts(subject);
    expect(counts['indexed_items']).toBe(4);
    expect(counts['items_with_text']).toBe(2);
    expect('qa_out_of_content_scope' in counts).toBe(false);
  });

  test.each(['internal', 'public_safe', 'secure_local'] as const)(
    '%s Gmail sweep, manual embed and backlog agree on mail held from a previous approval', async domain => {
      const subject = authority();
      const local = domain === 'secure_local';
      const corpusId = local ? 'secure_local.email.private' : domain + '.email';
      const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId, trustDomain: domain, family: 'email', tierLedger: null });
      stores.push(store);
      const seed = (connector: string, id: string) =>
        store.syncFromConnector(mailConnector(connector, { id, text: id + ' message body' }), { fetchContent: true });
      const observed = () => {
        const ref = subject.mailPolicyRef()!;
        return gmailCursorConnectorIds('personal', { generation: ref.accountGeneration, revision: ref.revision });
      };
      approve(subject, 'all');
      await seed(observed().connectorId, 'held');
      approve(subject, '6m');
      const recording = new RecordingProvider(local ? 'built-in' : 'venice', 'fixture', local ? 'local' : 'cloud');
      const provider = Object.assign(recording, { runsOnThisComputer: () => local });
      const deps = {
        authority: subject, sourceIdForStore: () => 'gmail.email', readScope: () => ({ allowed: true } as const),
        gmailRetainedAccountScope: () => 'personal', gmailLiveProcessorVerified: () => true,
      };
      const scopes = createStoreScopes(deps);
      const status = () => store.status(scopes.statusScopeFor(store, provider)).counts;
      expect(status()).toMatchObject({ items: local ? 1 : 0, chunks: local ? 1 : 0, embeddedChunks: 0 });
      await seed(observed().connectorId, 'current');
      await seed(observed().previousId, 'legacy');
      await seed('archive.fixture', 'import');
      const expected = local ? ['current', 'held', 'import', 'legacy'] : ['current', 'import', 'legacy'];
      expect(status()).toMatchObject({ items: expected.length, chunks: expected.length, embeddedChunks: 0 });
      // Give the held row a queue entry as well as a missing vector.
      store.queueEmbedding(['personal:held'], provider);
      const target = planStoreEmbedding({ store, provider, servedByMeaning: true, scope: scopes.embeddingScopeFor(store, provider) })!;
      expect(await embedPendingChunks([target], { maxItems: 10 })).toMatchObject([{ chunksEmbedded: expected.length }]);
      expect(recording.inputs.sort()).toEqual(expected.map(id => expect.stringContaining(id + ' message body')));
      expect(status()).toMatchObject({ chunks: expected.length, embeddedChunks: expected.length });
      const manual = createStoreEmbeddingScopeFor(deps)(store, provider);
      if (!manual.allowed) throw new Error('expected approved mail scope');
      await seed(gmailCursorConnectorIds('personal', undefined).connectorId, 'unscoped');
      await seed('archive.manual', 'second import');
      recording.inputs.length = 0;
      const result = await store.embedChunks(scopedEmbeddingOptions(manual, provider));
      const manualIds = local ? ['second import', 'unscoped'] : ['second import'];
      expect(result.chunksEmbedded).toBe(manualIds.length);
      expect(recording.inputs.sort()).toEqual(manualIds.map(id => expect.stringContaining(id + ' message body')));
    },
  );
});
