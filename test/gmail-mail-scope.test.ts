import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  approveMailSourceScope,
  compileGmailMailScope,
  defaultMailScopeSelection,
  estimateMailScope,
  mailScopeContentAfter,
  mailScopeDraftView,
  parseMailScopeDraft,
  readMailSourceScopeApproval,
  type MailScopeSelection,
} from '../src/core/mail-source-scope.ts';
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
import { createGmailMailScopeBrowser, senderAddress } from '../src/workers/google-connectors/gmail-scope-browser.ts';
import {
  FileSourceScopeAuthority,
  gmailConnectorScopeFromApproval,
  scopeBoundSchedulerSource,
} from '../src/workers/source-scope-runtime.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { SourceScheduler } from '../src/workers/source-scheduler.ts';
import { parseDashboardControlParams } from '../src/core/control-ui-gateway.ts';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const tempDirs: string[] = [];
const openStores: LocalConnectorStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-mail-scope-'));
  tempDirs.push(dir);
  return dir;
}

function gmailRegistry(connectedAt = '2026-09-23T10:00:00.000Z', handles = ['gmail.personal']) {
  return {
    version: 1 as const,
    handles: handles.map((handle) => ({
      handle,
      provider: 'gmail' as const,
      allowedCapabilities: ['gmail.email.sync'],
      scopes: [],
      connectedAt,
      accountRole: 'personal',
      providerAccountId: `account-${handle}`,
    })),
  };
}

function scope(overrides: Partial<MailScopeSelection> = {}): MailScopeSelection {
  return {
    ...defaultMailScopeSelection(),
    contentAfter: mailScopeContentAfter('2y', NOW)!,
    ...overrides,
  };
}

describe('mail scope defaults', () => {
  test('the picker opens on 2 years in full with Promotions and Social skipped', () => {
    const defaults = defaultMailScopeSelection();
    expect(defaults.window).toBe('2y');
    expect(defaults.skippedCategories).toEqual(['promotions', 'social']);
    expect(defaults.skippedLabels).toEqual([]);
    expect(mailScopeDraftView(undefined)).toEqual({
      window: '2y',
      skipped_categories: ['promotions', 'social'],
      skipped_labels: [],
      always_private_senders: [],
      skip_senders: [],
    });
    // Two calendar years back, at UTC midnight.
    expect(mailScopeContentAfter('2y', NOW)).toBe('2024-09-23T00:00:00.000Z');
    expect(mailScopeContentAfter('all', NOW)).toBeUndefined();
  });
});

describe('mail scope approval', () => {
  test('pending until approved; each save is a new revision; a reconnect invalidates it', () => {
    const statePath = join(tempDir(), 'mail-source-scopes.json');
    expect(readMailSourceScopeApproval({ registry: { handles: [] }, statePath }))
      .toMatchObject({ status: 'scope_pending', reason: 'not_connected' });
    const pending = readMailSourceScopeApproval({ registry: gmailRegistry(), statePath });
    expect(pending).toMatchObject({ status: 'scope_pending', reason: 'missing' });
    expect(pending.accountGeneration).toMatch(/^[a-f0-9]{64}$/);

    const first = approveMailSourceScope({
      registry: gmailRegistry(), statePath, accountGeneration: pending.accountGeneration!,
      expectedRevision: pending.revision,
      scope: { ...defaultMailScopeSelection(), alwaysPrivateSenders: ['Doctor@Clinic.example', '@bank.example'] },
      now: NOW,
    });
    expect(first.status).toBe('approved');
    expect(first.mailScope?.contentAfter).toBe('2024-09-23T00:00:00.000Z');
    // "Always Private" is stored as owner tier rules in the design's §2.4 shape.
    expect(first.ownerTierRules).toEqual([
      { source: 'gmail.email', match: { sender: '@bank.example' }, tier: 'secure', strength: 'force', origin: 'mail_scope_picker' },
      { source: 'gmail.email', match: { sender: 'doctor@clinic.example' }, tier: 'secure', strength: 'force', origin: 'mail_scope_picker' },
    ]);
    expect(readMailSourceScopeApproval({ registry: gmailRegistry(), statePath })).toMatchObject({
      status: 'approved', revision: first.revision,
    });

    // A save against a stale revision is refused (compare-and-swap).
    expect(() => approveMailSourceScope({
      registry: gmailRegistry(), statePath, accountGeneration: pending.accountGeneration!,
      expectedRevision: pending.revision, scope: defaultMailScopeSelection(), now: NOW,
    })).toThrow('mail scope changed');

    const second = approveMailSourceScope({
      registry: gmailRegistry(), statePath, accountGeneration: first.accountGeneration!,
      expectedRevision: first.revision, scope: { ...defaultMailScopeSelection(), window: '1y' }, now: NOW,
    });
    expect(second.revision).not.toBe(first.revision);

    // Reconnecting the same mailbox is a new grant: approval and work reset.
    expect(readMailSourceScopeApproval({ registry: gmailRegistry('2026-09-24T10:00:00.000Z'), statePath }))
      .toMatchObject({ status: 'scope_pending', reason: 'account_changed' });
  });

  test('two registered mailboxes need the lane pin, and the pin chooses which one the scope binds to', () => {
    const statePath = join(tempDir(), 'mail-source-scopes.json');
    const registry = gmailRegistry(undefined, ['gmail.personal', 'gmail.work']);
    expect(readMailSourceScopeApproval({ registry, statePath }).reason).toBe('not_connected');
    const personal = readMailSourceScopeApproval({ registry, statePath, pinnedHandle: 'gmail.personal' });
    const work = readMailSourceScopeApproval({ registry, statePath, pinnedHandle: 'gmail.work' });
    expect(personal.accountGeneration).toBeDefined();
    expect(personal.accountGeneration).not.toBe(work.accountGeneration);
  });

  test('sender rules must be an address or an @domain', () => {
    const statePath = join(tempDir(), 'mail-source-scopes.json');
    const pending = readMailSourceScopeApproval({ registry: gmailRegistry(), statePath });
    expect(() => approveMailSourceScope({
      registry: gmailRegistry(), statePath, accountGeneration: pending.accountGeneration!,
      expectedRevision: pending.revision,
      scope: { ...defaultMailScopeSelection(), skipSenders: ['not a sender'] },
    })).toThrow('not an email address or @domain');
    expect(() => parseMailScopeDraft({ ...mailScopeDraftView(undefined), window: '3y' })).toThrow('time window');
  });
});

describe('Gmail query compilation', () => {
  test('window, categories, labels and skipped senders compile into two partitioned queries', () => {
    const cutoffSeconds = Date.parse('2024-09-23T00:00:00.000Z') / 1_000;
    const compiled = compileGmailMailScope(scope({
      skippedCategories: ['social', 'promotions'],
      skippedLabels: [{ id: 'Label_7', name: 'Newsletters' }, { id: 'Label_9', name: 'Work/Old Stuff' }],
      skipSenders: ['noreply@shop.example', '@spam.example'],
      alwaysPrivateSenders: ['doctor@clinic.example'],
    }), { operatorQuery: 'has:attachment OR from:boss@example.com' });
    const base = '-category:social -category:promotions -label:Newsletters -label:"Work/Old Stuff"'
      + ' -from:noreply@shop.example -from:spam.example (has:attachment OR from:boss@example.com)';
    expect(compiled.baseQuery).toBe(base);
    expect(compiled.contentAfterMs).toBe(cutoffSeconds * 1_000);
    expect(compiled.contentQuery).toBe(`after:${cutoffSeconds - 1} ${base}`);
    expect(compiled.metadataQuery).toBe(`before:${cutoffSeconds} ${base}`);
    // "Always Private" never narrows what is read; it only raises the tier.
    expect(compiled.baseQuery).not.toContain('clinic');
    expect(compiled.skippedCategoryLabelIds).toEqual(['CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS']);
  });

  test('Everything has no cutoff and no metadata-only leg', () => {
    const compiled = compileGmailMailScope({ ...defaultMailScopeSelection(), window: 'all' });
    expect(compiled.contentAfterMs).toBeUndefined();
    expect(compiled.metadataQuery).toBeUndefined();
    expect(compiled.contentQuery).toBe('-category:promotions -category:social');
  });
});

describe('mail scope estimate', () => {
  test('counts and the embedding cost upper bound follow the stated assumptions; no sync-time figure', () => {
    const estimate = estimateMailScope({ contentMessages: 20_000, metadataMessages: 30_000 });
    expect(estimate).toEqual({
      estimate: true,
      content_messages: 20_000,
      metadata_messages: 30_000,
      total_messages: 50_000,
      // Only full-content mail embeds: 20,000 x 750 tokens at $0.15 per million.
      embedding_tokens: 15_000_000,
      embedding_cost_usd: 2.25,
    });
    expect(estimateMailScope({ contentMessages: -3, metadataMessages: Number.NaN }).total_messages).toBe(0);
  });
});

describe('scoped Gmail traversal', () => {
  const cutoffMs = Date.parse('2024-09-23T00:00:00.000Z');
  const connectorScope: GmailConnectorScope = {
    baseQuery: '-category:promotions -category:social',
    contentAfterMs: cutoffMs,
    skippedCategoryLabelIds: ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'],
  };

  test('recent mail is read in full, older mail metadata-only with no body, and the leg hand-off holds the watermark', async () => {
    const client = fakeClient([
      message('new-1', cutoffMs + 10 * 86_400_000),
      message('new-2', cutoffMs + 5 * 86_400_000),
      message('old-1', cutoffMs - 5 * 86_400_000),
      message('old-2', cutoffMs - 400 * 86_400_000),
    ]);
    const connector = new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: { OLYMPUS_SOURCE_INDEX_GMAIL_QUERY: 'in:anywhere' }, scope: connectorScope, now: () => NOW.getTime(),
    });
    const contentLeg = await collect(connector.listItems({ limit: 50 }));
    expect(client.queries[0]).toBe(`after:${cutoffMs / 1_000 - 1} -category:promotions -category:social (in:anywhere)`);
    expect(contentLeg.items.map((item) => item.identity.providerItemId)).toEqual(['new-1', 'new-2']);
    for (const item of contentLeg.items) {
      expect(item.content.kind).toBe('text');
      expect(item.content.kind === 'text' && item.content.text).toContain('Body of');
    }
    expect(client.formats).toEqual(['full', 'full']);
    // Not done: the metadata-only leg is still owed.
    expect(contentLeg.done).toBe(false);

    const metadataLeg = await collect(new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: { OLYMPUS_SOURCE_INDEX_GMAIL_QUERY: 'in:anywhere' }, scope: connectorScope, now: () => NOW.getTime(),
    }).listItems({ limit: 50, cursor: contentLeg.cursor! }));
    expect(client.queries[1]).toBe(`before:${cutoffMs / 1_000} -category:promotions -category:social (in:anywhere)`);
    expect(metadataLeg.items.map((item) => item.identity.providerItemId)).toEqual(['old-1', 'old-2']);
    // The metadata leg never asks Gmail for a body.
    expect(client.formats.slice(2)).toEqual(['metadata', 'metadata']);
    for (const item of metadataLeg.items) {
      expect(item.content).toEqual({ kind: 'metadata_only' });
      expect(item.metadata.snippet).toBeUndefined();
      expect(item.metadata.mailScopeContent).toBe('metadata_only');
      expect(item.metadata.subject).toBe(`Subject ${item.identity.providerItemId}`);
      expect(item.metadata.from).toBe('Alex <alex@example.com>');
      expect(JSON.stringify(item)).not.toContain('Body of');
    }
    expect(metadataLeg.done).toBe(true);

    // The next pass is incremental. Its bound is the newest fetched
    // internalDate or the traversal's own start less a day, whichever is
    // later (here the start: the newest message is older than a day).
    await collect(new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: {}, scope: connectorScope, now: () => NOW.getTime(),
    }).listItems({ limit: 50, cursor: metadataLeg.cursor! }));
    expect(client.queries[2]).toBe(`after:${Math.floor((NOW.getTime() - 86_400_000) / 1_000)} -category:promotions -category:social`);
  });

  test('a message older than the cutoff that the content query still returns is kept metadata-only', async () => {
    const client = fakeClient([message('boundary', cutoffMs - 1)], { ignoreDates: true });
    const connector = new GoogleGmailSourceConnector({ apiClient: client, account: 'personal', env: {}, scope: connectorScope });
    const page = await collect(connector.listItems({ limit: 50 }));
    expect(page.items[0]?.content).toEqual({ kind: 'metadata_only' });
  });

  test('the scope replaces the built-in Promotions skip, so an included category is read', async () => {
    const promo = { ...message('promo', cutoffMs + 1_000), labelIds: ['CATEGORY_PROMOTIONS'] };
    const client = fakeClient([promo]);
    const included = await collect(new GoogleGmailSourceConnector({
      apiClient: client, account: 'personal', env: {}, scope: { baseQuery: '-category:social', skippedCategoryLabelIds: ['CATEGORY_SOCIAL'] },
    }).listItems({ limit: 50 }));
    expect(included.items).toHaveLength(1);
    const unscoped = await collect(new GoogleGmailSourceConnector({ apiClient: client, account: 'personal', env: {} }).listItems({ limit: 50 }));
    expect(unscoped.items).toHaveLength(0);
  });
});

describe('Gmail lane bound to the approval revision', () => {
  test('a new revision does not resume the previous revision\'s cursor', async () => {
    const cutoffMs = Date.parse('2024-09-23T00:00:00.000Z');
    const client = fakeClient([
      message('a', cutoffMs + 3 * 86_400_000),
      message('b', cutoffMs + 2 * 86_400_000),
      message('c', cutoffMs + 1 * 86_400_000),
    ]);
    const internalStore = store(GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, 'internal');
    const secureStore = store(GMAIL_SECURE_CONNECTOR_CORPUS_ID, 'secure_local');
    const lane = (revision: string) => createGmailConnectorStoreSyncHandler({
      internalStore, secureStore, account: 'personal', apiClient: client, env: {},
      scope: { contentAfterMs: cutoffMs }, scopeApproval: { generation: 'g'.repeat(64), revision },
    });
    const first = await lane('rev-1').pull({ max_items: 2 });
    expect(first.checkpoint).toBeTruthy();
    const resumed = await lane('rev-1').pull({ max_items: 2, checkpoint: first.checkpoint! });
    expect(resumed.receipt.counts.resumed_from_checkpoint).toBe(1);

    const listsBefore = client.pageTokens.length;
    const rebound = await lane('rev-2').pull({ max_items: 2, checkpoint: resumed.checkpoint! });
    // Fresh traversal: no carried page token, no carried watermark, no warning.
    expect(rebound.receipt.counts.resumed_from_checkpoint).toBe(0);
    expect(rebound.receipt.counts.resume_cursor_rejected).toBe(0);
    expect(client.pageTokens[listsBefore]).toBeUndefined();
    expect(client.queries.at(-1)).toBe(`after:${cutoffMs / 1_000 - 1}`);
  });

  test('scheduler tasks are keyed to the mail revision and refuse to run once it changes', async () => {
    const dir = tempDir();
    let registry = gmailRegistry();
    const authority = new FileSourceScopeAuthority({
      registryPath: join(dir, 'handles.json'), readRegistry: () => registry,
    });
    expect(authority.mailPolicyRef()).toBeUndefined();
    const pending = authority.mailSnapshot();
    const approved = authority.approveMail({
      accountGeneration: pending.accountGeneration!, expectedRevision: pending.revision, scope: defaultMailScopeSelection(),
    });
    const ref = authority.mailPolicyRef()!;
    expect(gmailConnectorScopeFromApproval(authority.assertCurrentMail(ref)).baseQuery)
      .toBe('-category:social -category:promotions');
    let runs = 0;
    const source = scopeBoundSchedulerSource({
      authority, ref,
      source: {
        sourceId: 'gmail.email', corpusId: 'internal.email', cadence: 'manual', intervalMs: 1_000, freshnessThresholdHours: 1,
        tasks: [{ id: 'gmail.store.pull', kind: 'sync', writer: true, async run() { runs += 1; return { status: 'idle' }; } }],
      },
    });
    expect(source.tasks[0]!.id).toContain(approved.revision.replaceAll('-', '').slice(0, 16));
    await source.tasks[0]!.run({} as never);
    expect(runs).toBe(1);
    authority.approveMail({ accountGeneration: ref.accountGeneration, expectedRevision: ref.revision, scope: { ...defaultMailScopeSelection(), window: '5y' } });
    await expect(source.tasks[0]!.run({} as never)).rejects.toThrow('Mail scope approval is required');
    registry = gmailRegistry('2026-09-25T00:00:00.000Z');
    expect(authority.mailPolicyRef()).toBeUndefined();
    expect(runs).toBe(1);
  });
});

describe('no Gmail ingestion before approval', () => {
  test.each(['pending', 'approved'] as const)('manual Gmail sync is refused until the mail scope is approved: %s', async (state) => {
    let runs = 0;
    const scheduler = new SourceScheduler({
      enabled: true, tickMs: 1_000, errorBackoffMs: 1_000, maxTransientRetries: 1,
      sources: [{
        sourceId: 'gmail.email', corpusId: 'internal.email', cadence: 'manual', intervalMs: 60_000, freshnessThresholdHours: 1,
        tasks: [{ id: 'unsafe-existing-task', kind: 'sync', writer: true, async run() { runs += 1; return { status: 'progress' }; } }],
      }],
    });
    const worker = createEmailSourceWorker({
      sourceScheduler: scheduler,
      sourceDashboard: {
        sovereigntyEngine: {} as never,
        registryAdoptionIntervalMs: 0,
        fileSourceScopes: {
          summaries: () => [{
            kind: 'mail', source_id: 'gmail.email', disposition_source_id: 'gmail.email', label: 'Gmail',
            connected: true, status: state === 'pending' ? 'scope_pending' : 'approved', scope_revision: 'revision',
            ingestion_enabled: state === 'approved',
          }],
          async browse() { throw new Error('not used'); },
          async approveAndStart() { throw new Error('not used'); },
        },
      },
    });
    const response = await worker.fetch(new Request('http://worker.test/dashboard/sync-now', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'gmail' }),
    }));
    expect(response.status).toBe(state === 'approved' ? 200 : 403);
    expect(runs).toBe(state === 'approved' ? 1 : 0);
    worker.close();
  });
});

describe('native gateway mail scope actions', () => {
  test('browse and approve parse strictly and carry only the draft', () => {
    const draft = mailScopeDraftView(undefined);
    expect(parseDashboardControlParams({ action: 'browse_mail_scope', source_id: 'gmail.email', draft }))
      .toEqual({ action: 'browse_mail_scope', source_id: 'gmail.email', draft });
    expect(parseDashboardControlParams({
      action: 'approve_mail_scope_and_start', source_id: 'gmail.email',
      account_generation: 'a'.repeat(64), expected_scope_revision: 'missing:x', scope: draft,
    })).toMatchObject({ action: 'approve_mail_scope_and_start', scope: draft });
    expect(() => parseDashboardControlParams({ action: 'browse_mail_scope', source_id: 'dropbox.files', draft })).toThrow();
    expect(() => parseDashboardControlParams({
      action: 'browse_mail_scope', source_id: 'gmail.email', draft: { ...draft, extra: true },
    })).toThrow('unknown field');
    expect(() => parseDashboardControlParams({
      action: 'browse_mail_scope', source_id: 'gmail.email', draft: { ...draft, skipped_categories: ['spam'] },
    })).toThrow();
  });
});

describe('mail picker summary', () => {
  test('labels, category counts, sender sample and estimate within the stated request bound', async () => {
    const client = fakeClient(Array.from({ length: 120 }, (_, index) => ({
      ...message(`m-${index}`, NOW.getTime() - index * 3_600_000),
      payload: { headers: [{ name: 'From', value: index % 3 === 0 ? 'Bank <no-reply@bank.example>' : `person${index}@example.com` }] },
    })), { estimates: { content: 20_000, metadata: 30_000 } });
    const browser = createGmailMailScopeBrowser({ credentialHandle: 'gmail.personal', account: 'personal', apiClient: client, env: {} });
    const summary = await browser.summarize({
      scope: defaultMailScopeSelection(), now: NOW,
    });
    expect(summary.labels.map((label) => label.name)).toEqual(['Family', 'SENT']);
    expect(summary.categories.find((category) => category.category === 'promotions')?.messages_total).toBe(900);
    expect(summary.sample_size).toBe(100);
    expect(summary.sender_suggestions[0]).toEqual({ sender: 'no-reply@bank.example', sample_messages: 34 });
    expect(summary.estimate).toMatchObject({ estimate: true, content_messages: 20_000, metadata_messages: 30_000 });
    expect(summary.provider_requests).toBe(1 + 5 + 2 + 100);
    // The sample reads headers only.
    expect(new Set(client.formats)).toEqual(new Set(['metadata']));
    expect(senderAddress('"Doe, Jane" <Jane.Doe@Example.com>')).toBe('jane.doe@example.com');
  });
});

interface FakeClient extends GmailApiClient {
  queries: Array<string | undefined>;
  pageTokens: Array<string | undefined>;
  formats: string[];
}

function fakeClient(
  messages: GmailMessage[],
  options: { ignoreDates?: boolean; estimates?: { content: number; metadata: number } } = {},
): FakeClient {
  const client: FakeClient = {
    queries: [],
    pageTokens: [],
    formats: [],
    async listMessages(request: GmailListMessagesRequest) {
      client.queries.push(request.query);
      client.pageTokens.push(request.pageToken);
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const before = /before:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = messages.filter((entry) => {
        if (options.ignoreDates) return true;
        const at = Number(entry.internalDate);
        return (!after || at > Number(after) * 1_000) && (!before || at < Number(before) * 1_000);
      });
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.maxResults);
      return {
        messages: slice.map((entry) => ({ id: entry.id })),
        ...(offset + slice.length < eligible.length ? { nextPageToken: String(offset + slice.length) } : {}),
        resultSizeEstimate: options.estimates
          ? before ? options.estimates.metadata : options.estimates.content
          : eligible.length,
      };
    },
    async getMessage(id: string, request?: GmailGetMessageOptions) {
      client.formats.push(request?.format ?? 'full');
      const found = messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      if (request?.format !== 'metadata') return found;
      // What Gmail returns for format=metadata: headers, labels, snippet; no body parts.
      return { ...found, payload: { headers: found.payload?.headers ?? [] } };
    },
    async listLabels() {
      return [
        { id: 'INBOX', name: 'INBOX', type: 'system' as const },
        { id: 'SENT', name: 'SENT', type: 'system' as const },
        { id: 'SPAM', name: 'SPAM', type: 'system' as const },
        { id: 'Label_1', name: 'Family', type: 'user' as const },
      ];
    },
    async getLabel(id: string) {
      return { id, name: id, type: 'system' as const, messagesTotal: id === 'CATEGORY_PROMOTIONS' ? 900 : 100 };
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

function store(corpusId: string, trustDomain: 'internal' | 'secure_local'): LocalConnectorStore {
  const created = new LocalConnectorStore({ dbPath: ':memory:', corpusId, family: 'email', trustDomain });
  openStores.push(created);
  return created;
}
