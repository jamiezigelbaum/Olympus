// In-window mail with nothing to read (attachment-only, no envelope, wholly
// empty) must not stay owed reading forever, and mail older than the window
// still leaves the owed population by the window. Real connector, real store,
// real status handler and real dashboard view model; every expected number
// comes from the fixture's own message list, never from the code under test.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { engineBriefFromViewModel } from '../src/core/engine-brief.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import { defineInternalEmailCorpus, GoogleGmailSourceConnector } from '../src/workers/google-connectors/index.ts';
import type {
  GmailApiClient,
  GmailGetMessageOptions,
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import { createSourceIndexStatusHandler, type SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import { buildSourceDashboardViewModel, SqliteSourceDashboardHistory } from '../src/workers/source-dashboard.ts';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-10-16T07:10:00.000Z');
const CUTOFF_MS = Date.parse('2026-04-16T00:00:00.000Z');
const OFFLINE_BROKER = { async issueSession() { throw new Error('Unexpected credential request in offline Gmail fixture'); } } as unknown as CredentialBroker;

const roots: string[] = [];
const stores: LocalConnectorStore[] = [];
afterEach(() => {
  while (stores.length > 0) stores.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function mail(id: string, daysAgo: number, shape: {
  headers?: Array<{ name: string; value: string }>;
  snippet?: string;
  body?: string;
  attachment?: string;
}): GmailMessage {
  const internalDate = NOW.getTime() - daysAgo * DAY_MS;
  const parts = [
    ...(shape.body !== undefined
      ? [{ mimeType: 'text/plain', body: { data: Buffer.from(shape.body).toString('base64url') } }]
      : []),
    ...(shape.attachment !== undefined
      ? [{ mimeType: 'application/pdf', filename: shape.attachment, partId: '1', body: { attachmentId: `att-${id}`, size: 2_048 } }]
      : []),
  ];
  return {
    id,
    threadId: `thread-${id}`,
    historyId: `${1_000 + id.length}`,
    internalDate: String(internalDate),
    labelIds: ['INBOX'],
    snippet: shape.snippet ?? '',
    payload: { mimeType: 'multipart/mixed', headers: shape.headers ?? [], parts },
  };
}

function envelope(subject: string, date: number): Array<{ name: string; value: string }> {
  return [
    { name: 'Subject', value: subject },
    { name: 'From', value: 'Sender <sender@example.com>' },
    { name: 'Date', value: new Date(date).toUTCString() },
  ];
}

const WINDOW_START_DAYS = 20;
const IN_WINDOW_IDS = ['normal', 'attachment-only', 'no-envelope-attachment', 'nothing-at-all'] as const;
const OLD_IDS = ['old-with-body', 'old-attachment-only'] as const;

/** Four messages inside the window, two older than it; one of each kind the window cares about. */
function mailbox(): GmailMessage[] {
  const at = (daysAgo: number) => NOW.getTime() - daysAgo * DAY_MS;
  return [
    mail('normal', WINDOW_START_DAYS, {
      headers: envelope('Dinner on Saturday', at(WINDOW_START_DAYS)), snippet: 'Dinner on Saturday?', body: 'Dinner on Saturday?',
    }),
    // Subject and sender, no body, no snippet: a scanned statement.
    mail('attachment-only', WINDOW_START_DAYS + 1, {
      headers: envelope('Scan', at(WINDOW_START_DAYS + 1)), attachment: 'statement.pdf',
    }),
    // No Subject, From, To or Date at all, no body: only an attachment.
    mail('no-envelope-attachment', WINDOW_START_DAYS + 2, { attachment: 'receipt.pdf' }),
    // Nothing whatever.
    mail('nothing-at-all', WINDOW_START_DAYS + 3, {}),
    mail('old-with-body', 400, {
      headers: envelope('Last year', at(400)), snippet: 'Old news', body: 'Old news that stays names only.',
    }),
    mail('old-attachment-only', 401, { headers: envelope('Old scan', at(401)), attachment: 'old.pdf' }),
  ];
}

function fakeClient(messages: GmailMessage[]): GmailApiClient {
  return {
    async listMessages(request: GmailListMessagesRequest) {
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
      };
    },
    async getMessage(id: string, request?: GmailGetMessageOptions) {
      const found = messages.find((entry) => entry.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      if (request?.format !== 'metadata') return found;
      return { ...found, payload: { headers: found.payload?.headers ?? [] } };
    },
  };
}

async function readMailbox(messages: GmailMessage[]): Promise<{ store: LocalConnectorStore; result: SourceIndexStatusResult }> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-gmail-no-text-'));
  roots.push(dir);
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'gmail-connector-store.sqlite'),
    corpusId: 'internal.email',
    family: 'email',
    trustDomain: 'internal',
  });
  stores.push(store);
  const connector = new GoogleGmailSourceConnector({
    account: 'personal',
    credentialBroker: OFFLINE_BROKER,
    apiClient: fakeClient(messages),
    maxMessages: 100,
    now: () => NOW.getTime(),
    scope: { contentAfterMs: CUTOFF_MS },
  });
  await store.syncFromConnector(connector, { fetchContent: true });
  const handler = createSourceIndexStatusHandler({
    corpusDefinitions: () => [defineInternalEmailCorpus()],
    connectorStores: [store],
    connectorStoreStatusScope: () => ({ contentNotBefore: new Date(CUTOFF_MS).toISOString() }),
  });
  return { store, result: await handler.status({ corpus_id: 'internal.email' }) };
}

function corpusCounts(result: SourceIndexStatusResult): Record<string, number> {
  const corpus = result.corpora.find((entry) => entry.corpus_id === 'internal.email');
  if (!corpus || !corpus.configured) throw new Error('internal.email status missing');
  return corpus.counts as Record<string, number>;
}

describe('mail with nothing to read', () => {
  test('every in-window message is read, and the two older ones leave the owed population by the window', async () => {
    const { store, result } = await readMailbox(mailbox());
    const counts = corpusCounts(result);
    expect(counts['indexed_items']).toBe(IN_WINDOW_IDS.length + OLD_IDS.length);
    // All four in-window messages hold text, including the three with no body.
    expect(counts['items_with_text']).toBe(IN_WINDOW_IDS.length);
    // The two older ones are names only, by the window.
    expect(counts['qa_out_of_content_scope']).toBe(OLD_IDS.length);
    // Nothing is left over: stored minus out of scope is exactly what is read.
    expect(counts['indexed_items']! - counts['qa_out_of_content_scope']! - counts['items_with_text']!).toBe(0);
    for (const id of IN_WINDOW_IDS) expect(store.localContent(`personal:${id}`)?.chunks.length).toBeGreaterThan(0);
    for (const id of OLD_IDS) expect(store.localContent(`personal:${id}`)?.chunks ?? []).toEqual([]);
  });

  test('a message with no body still reads as its attachment names, else as its subject line', async () => {
    const { store } = await readMailbox(mailbox());
    expect(store.localContent('personal:attachment-only')?.chunks.join('\n')).toContain('Subject: Scan');
    expect(store.localContent('personal:no-envelope-attachment')?.chunks.join('\n')).toContain('Attachment: receipt.pdf');
    expect(store.localContent('personal:nothing-at-all')?.chunks.join('\n')).toContain('Subject: (no subject)');
  });

  test('mail older than the window keeps no body and no snippet, only its subject and sender', async () => {
    const { store } = await readMailbox(mailbox());
    expect(store.searchItems('Last year', 10)).toHaveLength(1);
    expect(store.searchItems('Old scan', 10)).toHaveLength(1);
    expect(store.searchItems('Old news', 10)).toEqual([]);
  });

  test('the card is done and not stalled long after the last message was read', async () => {
    const { result } = await readMailbox(mailbox());
    const counts = corpusCounts(result);
    const status = structuredClone(result) as SourceIndexStatusResult;
    const corpus = status.corpora[0]!;
    if (!corpus.configured) throw new Error('fixture');
    // Embedding is not under test here: the readable messages are embedded.
    const embeddedAll = (read: number) => ({
      ...corpus.counts, items_with_text: read, items_embedded: read, embedded_chunks: counts['chunks']!,
    });
    const embedding = { required: true, chunks: counts['chunks']!, embedded_chunks: counts['chunks']!, missing_chunks: 0, refresh_needed: false };
    const settledAt = new Date('2026-10-13T19:32:34.000Z');
    const withRead = (read: number): SourceIndexStatusResult => ({
      ...status,
      corpora: [{
        ...corpus, counts: embeddedAll(read), embedding_parity: embedding,
        last_refresh: { sync_run_id: 'window', status: 'completed', completed_at: NOW.toISOString(), items_seen: 1, items_indexed: 1 },
      } as never],
    });
    const history = new SqliteSourceDashboardHistory(':memory:');
    try {
      const build = (read: number, now: Date) => buildSourceDashboardViewModel({
        sourceIndexStatus: withRead(read),
        sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
          OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
          OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
        })),
        connectedHandleRegistry: {
          version: 1,
          handles: [{
            handle: 'gmail.personal', provider: 'gmail', accountRole: 'personal', trustDomain: 'secure_local',
            allowedCapabilities: ['gmail.email.sync'], scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            connectedAt: '2026-10-01T10:00:00.000Z',
          }],
        },
        history,
        now,
      });
      // The counter last rose when the final message was read; the view under
      // test is two and a half days later, far past the one-hour quiet period
      // after which an unfinished phase is called stalled.
      build(counts['items_with_text']! - 1, new Date(settledAt.getTime() - 30 * 60_000));
      build(counts['items_with_text']!, settledAt);
      const view = build(counts['items_with_text']!, NOW);
      const panel = buildChatGptDashboardViewModel(view, { now: NOW });
      const gmail = panel.sources.find((source) => source.id === 'gmail.email')!;
      expect(gmail.progress).toMatchObject({ stage: 'done', percent: 100, stalled: false });
      expect(gmail.progress?.stall).toBeUndefined();
      expect(engineBriefFromViewModel(panel).progress).toBeNull();
    } finally {
      history.close();
    }
  });
});
