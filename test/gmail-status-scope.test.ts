// Mail older than the approved window is kept as names only on purpose, so
// neither Gmail store may count it as owed reading. These tests drive the real
// mail approval and the real status handler; expected counts come from the
// fixture's own dates, never from running the code under test.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { defaultMailScopeSelection } from '../src/core/mail-source-scope.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { gmailInternalStoreStatusScope, gmailPrivateStoreStatusScope } from '../src/workers/email-source/gmail-status-scope.ts';
import { defineInternalEmailCorpus, gmailCursorConnectorId } from '../src/workers/google-connectors/index.ts';
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
    expect(gmailInternalStoreStatusScope(subject)).toEqual({ contentNotBefore: cutoff! });
  });

  test('"everything" has no window, so the Personal store is counted exactly as before', () => {
    const subject = authority();
    approve(subject, 'all');
    expect(subject.mailSnapshot().mailScope?.contentAfter).toBeUndefined();
    expect(gmailInternalStoreStatusScope(subject)).toBeUndefined();
  });

  test('no approved mail scope means no window and no authority means none either', () => {
    expect(gmailInternalStoreStatusScope(authority())).toBeUndefined();
    expect(gmailInternalStoreStatusScope(undefined)).toBeUndefined();
  });

  test('the Private store keeps its approved-observation scope and adds the same window', () => {
    const subject = authority();
    approve(subject, '6m');
    const ref = subject.mailPolicyRef()!;
    const cutoff = subject.mailSnapshot().mailScope?.contentAfter;
    const observed = {
      provider: 'gmail',
      observedConnectorId: gmailCursorConnectorId('personal', { generation: ref.accountGeneration, revision: ref.revision }),
      // Mail an import brought into the account is in the approved scope too.
      observedConnectorIdPrefix: 'archive.',
    };
    expect(gmailPrivateStoreStatusScope({ authority: subject, handle: { accountRole: 'personal' } })).toEqual({
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
    const scope = gmailPrivateStoreStatusScope({ authority: subject, handle: { accountRole: 'personal' } });
    expect(scope.contentAllowed).toBe(true);
    expect(scope.scopeRevision).toBe(subject.mailPolicyRef()!.revision);
    expect('contentNotBefore' in scope).toBe(false);
  });

  test('the Private store counts nothing without an approval or a connected account', () => {
    const pending = authority();
    expect(gmailPrivateStoreStatusScope({ authority: pending, handle: { accountRole: 'personal' } }))
      .toEqual({ itemsAllowed: false, contentAllowed: false });
    const approved = authority();
    approve(approved, '2y');
    expect(gmailPrivateStoreStatusScope({ authority: approved, handle: undefined }))
      .toEqual({ itemsAllowed: false, contentAllowed: false });
    expect(gmailPrivateStoreStatusScope({ authority: undefined, handle: { accountRole: 'personal' } }))
      .toEqual({ itemsAllowed: false, contentAllowed: false });
  });
});

describe('Gmail store status scope: what the status handler publishes', () => {
  function mailConnector(): SourceConnector {
    const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
    const mail: Array<{ id: string; authoredAt: string; text?: string }> = [
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
      id: 'gmail-status-scope-fixture',
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
    await store.syncFromConnector(mailConnector(), { fetchContent: true });
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: () => [defineInternalEmailCorpus()],
      connectorStores: [store],
      connectorStoreStatusScope: () => gmailInternalStoreStatusScope(subject),
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
});
