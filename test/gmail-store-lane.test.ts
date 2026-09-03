import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_ATTACHMENTS_NOT_INGESTED_WARNING,
  GMAIL_INGEST_FILTERED_WARNING,
  GMAIL_RESUME_REJECTED_WARNING,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GoogleDailyRequestBudget,
  GoogleGmailSourceConnector,
  GoogleRequestBudgetError,
  createGmailConnectorStoreSyncHandler,
  createGmailDailyRequestBudget,
  gmailReceiptDigest,
  isGmailConnectorCursor,
  type GmailApiClient,
  type GmailConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const openStores: LocalConnectorStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('Gmail connector-store lane', () => {
  test('a bounded slice resumes mid-traversal and promotes a watermark when it completes', async () => {
    const client = fakeGmailClient(gmailMessages(5));
    const lane = gmailLane({ client, maxMessages: 2 });

    const first = await lane.handler.pull({ max_items: 2 });
    expect(first.receipt.counts.items_seen).toBe(2);
    expect(first.receipt.counts.traversal_complete).toBe(0);
    expect(first.receipt.counts.resumed_from_checkpoint).toBe(0);
    expect(first.checkpoint).toBeTruthy();
    // The bound truncated the traversal, so the resume point is the provider's
    // own page token and the watermark stays where it was.
    expect(client.queries).toEqual([undefined]);

    const second = await lane.handler.pull({ max_items: 2, checkpoint: first.checkpoint! });
    expect(second.receipt.counts.items_seen).toBe(2);
    expect(second.receipt.counts.resumed_from_checkpoint).toBe(1);
    expect(second.receipt.counts.traversal_complete).toBe(0);
    // Same traversal, same provider query: a mid-flight watermark change would
    // silently skip every message the remaining pages still owe.
    expect(client.queries).toEqual([undefined, undefined]);
    expect(client.listCalls).toBe(2);

    const third = await lane.handler.pull({ max_items: 2, checkpoint: second.checkpoint! });
    expect(third.receipt.counts.items_seen).toBe(1);
    expect(third.receipt.counts.traversal_complete).toBe(1);

    // The completed traversal promoted its high-water internalDate, so the next
    // run asks Gmail for new mail instead of for the whole mailbox.
    const fourth = await lane.handler.pull({ max_items: 2, checkpoint: third.checkpoint! });
    expect(fourth.receipt.counts.items_seen).toBe(0);
    // `after:` takes whole epoch seconds, so the watermark is floored.
    expect(client.queries.at(-1)).toBe(`after:${Math.floor(messageInternalDateMs(5) / 1_000)}`);
    expect(fourth.receipt.counts.traversal_complete).toBe(1);
  });

  test('an unbounded traversal that fits inside the bound is reported complete', async () => {
    const client = fakeGmailClient(gmailMessages(2));
    const lane = gmailLane({ client, maxMessages: 10 });

    const outcome = await lane.handler.pull({ max_items: 10 });

    // The shipped connector called every bounded slice done, which told the
    // spine that a partial window was a full traversal.
    expect(outcome.receipt.counts.items_seen).toBe(2);
    expect(outcome.receipt.counts.traversal_complete).toBe(1);
  });

  test('one provider traversal fills both stores, embeds in-run, and never re-gets a message', async () => {
    const client = fakeGmailClient(gmailMessages(3));
    const lane = gmailLane({ client, maxMessages: 10 });

    const outcome = await lane.handler.pull({ max_items: 10 });

    expect(outcome.receipt.counts.provider_traversals).toBe(1);
    expect(client.listCalls).toBe(1);
    // Exactly one messages.get per message. fetchItem used to be a real
    // provider call, doubling the get cost inside a bounded slice.
    expect(client.getCalls).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(outcome.receipt.counts.internal_items_indexed).toBe(3);
    // Baseline classification is S3/internal, so the secure store rejects every
    // item; the spine's trust-domain check is what routes between the two.
    expect(outcome.receipt.counts.secure_items_indexed).toBe(0);
    expect(outcome.receipt.counts.secure_items_rejected).toBe(3);
    // Load-bearing: without in-run embedding the store fills with chunks and
    // zero embeddings, so the corpus can never become servable.
    expect(outcome.receipt.counts.internal_chunks_indexed).toBeGreaterThan(0);
    expect(outcome.receipt.counts.internal_chunks_embedded)
      .toBe(outcome.receipt.counts.internal_chunks_indexed);
    expect(lane.internalStore.hasEmbeddings(lane.provider.modelId)).toBe(true);

    // The digest is recomputable from the receipt alone; nothing private is
    // needed to verify it.
    expect(outcome.receipt.receipt_sha256).toBe(gmailReceiptDigest({
      kind: outcome.receipt.kind,
      status: outcome.receipt.status,
      counts: outcome.receipt.counts,
      api_usage: outcome.receipt.api_usage,
      ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
      policy: outcome.receipt.policy,
    }));
    expect(JSON.stringify(outcome.receipt)).not.toContain('Apollo');
  });

  test('keeps OTP and Promotions mail out of both canonical stores and counts the gap', async () => {
    const otp = gmailMessage(1);
    otp.payload!.headers = [
      { name: 'Subject', value: 'Your verification code is 482910' },
      { name: 'From', value: 'security@example.test' },
    ];
    const promotion = gmailMessage(2);
    promotion.labelIds = ['INBOX', 'CATEGORY_PROMOTIONS'];
    promotion.payload!.headers = [{ name: 'Subject', value: 'Summer sale' }];
    const personal = gmailMessage(3);
    personal.payload!.headers = [{ name: 'Subject', value: 'Dinner Thursday?' }];
    const lane = gmailLane({ client: fakeGmailClient([otp, promotion, personal]), maxMessages: 10 });

    const outcome = await lane.handler.pull({ max_items: 10 });

    expect(outcome.receipt.counts).toMatchObject({
      items_skipped_otp: 1,
      items_skipped_category: 1,
      internal_items_indexed: 1,
    });
    expect(outcome.receipt.warnings).toContain(GMAIL_INGEST_FILTERED_WARNING);
    expect(lane.internalStore.searchItems('482910', 5)).toEqual([]);
    expect(lane.internalStore.searchItems('Dinner', 5)).toHaveLength(1);
  });

  test('fetchItem is an in-run cache, not a second messages.get', async () => {
    // A message with no headers, no snippet and no body lists as
    // metadata_only, which is exactly when the spine calls fetchItem.
    const client = fakeGmailClient([
      { id: 'msg-bare', threadId: 'thread-bare', historyId: '900001', internalDate: String(messageInternalDateMs(1)) },
    ]);
    const lane = gmailLane({ client, maxMessages: 10 });

    const outcome = await lane.handler.pull({ max_items: 10 });

    expect(outcome.receipt.counts.fetch_item_cache_hits).toBeGreaterThan(0);
    // One get, not two: the shipped connector re-fetched every metadata_only
    // item, doubling messages.get inside a bounded slice.
    expect(client.getCalls).toEqual(['msg-bare']);
  });

  test('attachment omissions are counted without exposing filenames or fetching bytes', async () => {
    const message = gmailMessage(1);
    message.payload = {
      mimeType: 'multipart/mixed',
      ...(message.payload?.headers ? { headers: message.payload.headers } : {}),
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('Body remains indexed.').toString('base64url') },
        },
        {
          mimeType: 'application/pdf',
          filename: 'private-contract.pdf',
          body: { attachmentId: 'opaque-a', size: 12_345 },
        },
        {
          mimeType: 'image/png',
          filename: 'private-scan.png',
          body: { attachmentId: 'opaque-b', size: 678 },
        },
        {
          mimeType: 'text/plain',
          filename: 'inline-secret.txt',
          body: {
            data: Buffer.from('attachment-only-secret-marker').toString('base64url'),
            size: 42,
          },
        },
      ],
    };
    const client = fakeGmailClient([message]);
    const lane = gmailLane({ client, maxMessages: 10 });

    const outcome = await lane.handler.pull({ max_items: 10 });

    expect(outcome.receipt.counts).toMatchObject({
      attachments_declared: 3,
      attachment_bytes_declared: 13_065,
      attachments_not_ingested: 3,
    });
    expect(outcome.receipt.warnings).toContain(GMAIL_ATTACHMENTS_NOT_INGESTED_WARNING);
    expect(client.getCalls).toEqual(['msg-1']);
    expect(JSON.stringify(outcome.receipt)).not.toContain('private-contract');
    expect(JSON.stringify(outcome.receipt)).not.toContain('opaque-a');
    expect(lane.internalStore.searchItems('attachment-only-secret-marker', 5)).toEqual([]);
  });

  test('a nested attachment subtree never supplies the message body', async () => {
    const message = gmailMessage(1);
    message.payload = {
      mimeType: 'multipart/mixed',
      ...(message.payload?.headers ? { headers: message.payload.headers } : {}),
      parts: [
        {
          mimeType: 'text/html',
          body: { data: Buffer.from('<p>Apollo roadmap notes 1.</p>').toString('base64url') },
        },
        {
          // A forwarded message is an attachment whose bytes are a whole MIME
          // subtree. Its unnamed text/plain child is the ATTACHMENT's body, and
          // extraction prefers text/plain over text/html — so descending into
          // it replaced the real body with the attachment's.
          mimeType: 'message/rfc822',
          filename: 'ATT00001.eml',
          body: { attachmentId: 'opaque-eml', size: 2_048 },
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('attachment-subtree-secret-marker').toString('base64url') },
            },
            {
              mimeType: 'text/html',
              body: { data: Buffer.from('<p>attachment-subtree-html-marker</p>').toString('base64url') },
            },
          ],
        },
      ],
    };
    const connector = new GoogleGmailSourceConnector({
      account: 'personal',
      apiClient: fakeGmailClient([message]),
      maxMessages: 10,
    });

    const pages = [];
    for await (const page of connector.listItems({ limit: 10 })) pages.push(page);
    const item = pages[0]?.items[0];
    const text = item?.content.kind === 'text' ? item.content.text : '';

    expect(text).toContain('Apollo roadmap notes 1.');
    expect(text).not.toContain('attachment-subtree-secret-marker');
    expect(text).not.toContain('attachment-subtree-html-marker');
    // Counting and text collection must agree on what an attachment subtree is:
    // one attachment, none of it ingested.
    expect(item?.metadata.attachmentCount).toBe(1);
    expect(item?.metadata.attachmentsNotIngested).toBe(1);
  });

  test('the daily request guard parks at the next UTC day and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-gmail-budget-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'gmail-daily-request-budget.json');
    const clock = { now: new Date('2026-07-27T09:00:00.000Z') };
    const budget = createGmailDailyRequestBudget({
      env: { OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET: '1' },
      statePath,
      now: () => clock.now,
    });
    const client = fakeGmailClient(gmailMessages(3));
    const lane = gmailLane({ client, maxMessages: 10, budget });

    await expect(lane.handler.pull({ max_items: 10 })).rejects.toThrow(GoogleRequestBudgetError);
    let parked: GoogleRequestBudgetError | undefined;
    try {
      await lane.handler.pull({ max_items: 10 });
    } catch (error) {
      parked = error as GoogleRequestBudgetError;
    }
    expect(parked?.retryAt).toBe('2026-07-28T00:00:00.000Z');

    // A restart on the same UTC day inherits the spent counter from disk rather
    // than handing Gmail a fresh budget.
    const restored = createGmailDailyRequestBudget({
      env: { OLYMPUS_SOURCE_INDEX_GMAIL_DAILY_API_REQUEST_BUDGET: '1' },
      statePath,
      now: () => clock.now,
    });
    expect(() => restored.reserve()).toThrow('daily_api_request_guard');
    expect(restored.status()).toMatchObject({
      utcDay: '2026-07-27',
      requests: 1,
    });

    // The rollover releases it.
    clock.now = new Date('2026-07-28T00:00:01.000Z');
    expect(() => restored.reserve()).not.toThrow();
  });

  test('a corrupt budget state file is refused rather than reissuing a spent day', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-gmail-budget-corrupt-'));
    tempDirs.push(dir);
    const statePath = join(dir, 'budget.json');
    writeFileSync(statePath, '{"version":1,"utcDay":"nope","requests":-4}\n');
    expect(() => new GoogleDailyRequestBudget({
      provider: 'Gmail',
      dailyRequestBudget: 10,
      statePath,
    })).toThrow('invalid');
  });

  test('a rate-limited request is retried honoring Retry-After', async () => {
    const delays: number[] = [];
    const responses = [
      new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      new Response(JSON.stringify({ messages: [{ id: 'msg-1', threadId: 'thread-1' }] }), { status: 200 }),
      new Response(JSON.stringify(gmailMessage(1)), { status: 200 }),
    ];
    const connector = new GoogleGmailSourceConnector({
      account: 'personal',
      apiBaseUrl: 'https://gmail.test/v1',
      credentialBroker: fakeBroker(),
      fetch: async () => responses.shift()!,
      sleep: async (ms: number) => {
        delays.push(ms);
      },
    });

    const pages = [];
    for await (const page of connector.listItems({ limit: 5 })) pages.push(page);

    // Without this the first 429 surfaced as a task failure and the scheduler
    // fail-looped the lane at its error backoff.
    expect(delays).toEqual([2_000]);
    expect(pages[0]?.items).toHaveLength(1);
    expect(pages[0]?.done).toBe(true);
  });

  test('every retry attempt reserves budget immediately before fetch', async () => {
    let fetchAttempts = 0;
    const budget = new GoogleDailyRequestBudget({
      provider: 'Gmail',
      dailyRequestBudget: 1,
      now: () => new Date('2026-07-29T10:00:00.000Z'),
    });
    const connector = new GoogleGmailSourceConnector({
      account: 'personal',
      apiBaseUrl: 'https://gmail.test/v1',
      credentialBroker: fakeBroker(),
      requestBudget: budget,
      fetch: async () => {
        fetchAttempts += 1;
        return fetchAttempts === 1
          ? new Response('slow down', { status: 429 })
          : new Response(JSON.stringify({ messages: [] }), { status: 200 });
      },
      maxRetries: 2,
      sleep: async () => {},
    });

    const traversal = async () => {
      for await (const _page of connector.listItems({ limit: 5 })) {
        // Exhaust the traversal.
      }
    };

    await expect(traversal()).rejects.toThrow(GoogleRequestBudgetError);
    expect(fetchAttempts).toBe(1);
    expect(budget.status().requests).toBe(1);
  });

  test('an unusable checkpoint traverses fresh and says so in counts', async () => {
    const client = fakeGmailClient(gmailMessages(2));
    const lane = gmailLane({ client, maxMessages: 10 });

    // A checkpoint from another store generation, or a hand-edited one. It must
    // cost a fresh traversal and a legible count, never a failed run.
    const outcome = await lane.handler.pull({ max_items: 10, checkpoint: 'not-a-gmail-cursor' });

    expect(outcome.receipt.counts.resume_cursor_rejected).toBe(1);
    expect(outcome.receipt.warnings).toContain(GMAIL_RESUME_REJECTED_WARNING);
    expect(outcome.receipt.counts.resumed_from_checkpoint).toBe(0);
    expect(outcome.receipt.counts.items_seen).toBe(2);
  });

  test('a bare pre-envelope head cursor is still honored as a head resume point', async () => {
    const client = fakeGmailClient(gmailMessages(4));
    const lane = gmailLane({ client, maxMessages: 2 });

    const first = await lane.handler.pull({ max_items: 2 });
    const bareHead = JSON.parse(
      Buffer.from(first.checkpoint!.slice('gmp1:'.length), 'base64url').toString('utf8'),
    ).head as string;
    expect(isGmailConnectorCursor(bareHead)).toBe(true);

    const second = await lane.handler.pull({ max_items: 2, checkpoint: bareHead });

    expect(second.receipt.counts.resumed_from_checkpoint).toBe(1);
    expect(second.receipt.counts.resume_cursor_rejected).toBe(0);
  });

  test('reconcile keeps absence non-authoritative and tombstones nothing', async () => {
    const client = fakeGmailClient(gmailMessages(3));
    const lane = gmailLane({ client, maxMessages: 10 });
    await lane.handler.pull({ max_items: 10 });

    client.messages = gmailMessages(3).slice(0, 1);
    const outcome = await lane.handler.reconcile();

    // Gmail deletion semantics are unproven on this path, so absence is never
    // evidence of removal.
    expect(outcome.receipt.counts.internal_items_tombstoned).toBe(0);
    expect(outcome.receipt.counts.absence_authoritative).toBe(0);
    expect(outcome.receipt.policy.absence_authority).toBe('partial_window');
    expect(outcome.receipt.policy.tombstones_applied).toBe(false);
    expect(lane.internalStore.status().counts.items).toBe(3);
    expect(lane.internalStore.status().counts.tombstonedItems).toBe(0);
    // The listing ran out inside the ceiling, so this pass really did cover the
    // mailbox and the receipt may say so.
    expect(outcome.receipt.counts.traversal_complete).toBe(1);
  });

  test('a reconcile stopped by its message ceiling reports an incomplete traversal', async () => {
    // The shape seen against a 73k mailbox: the reconcile runs under the
    // connector's own 1,000-message ceiling, stops with a live page token, and
    // the partial_window arm then clears the checkpoint by policy. Deriving
    // completion from that cleared checkpoint made every such pass claim a full
    // traversal of a mailbox it had seen ~1.4% of — and receipts are the audit
    // trail every coverage number downstream is built on.
    const client = fakeGmailClient(gmailMessages(1_001));
    const lane = gmailLane({ client, maxMessages: 10 });

    const outcome = await lane.handler.reconcile();

    expect(outcome.receipt.counts.items_seen).toBe(1_000);
    expect(outcome.receipt.counts.traversal_complete).toBe(0);
    // The checkpoint policy is untouched: a reconcile still hands back nothing.
    expect(outcome.checkpoint).toBeNull();
  });
});

interface CountingGmailApiClient extends GmailApiClient {
  messages: GmailMessage[];
  listCalls: number;
  getCalls: string[];
  queries: Array<string | undefined>;
}

function gmailLane(input: {
  client: CountingGmailApiClient;
  maxMessages: number;
  budget?: GoogleDailyRequestBudget;
  env?: Record<string, string | undefined>;
  /** Inject a store to model divergence (a wiped or shared store). */
  stores?: { internalStore?: LocalConnectorStore; secureStore?: LocalConnectorStore };
}): {
  handler: GmailConnectorStoreSyncHandler;
  internalStore: LocalConnectorStore;
  secureStore: LocalConnectorStore;
  provider: SourceEmbeddingProvider;
} {
  const internalStore = input.stores?.internalStore ?? new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'internal',
  });
  const secureStore = input.stores?.secureStore ?? new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'secure_local',
  });
  if (!input.stores?.internalStore) openStores.push(internalStore);
  if (!input.stores?.secureStore) openStores.push(secureStore);
  const provider = localEmbeddingProvider();
  return {
    internalStore,
    secureStore,
    provider,
    handler: createGmailConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      apiClient: input.client,
      maxMessages: input.maxMessages,
      internalEmbeddingProvider: provider,
      secureEmbeddingProvider: provider,
      ...(input.budget ? { requestBudget: input.budget } : {}),
      env: input.env ?? {},
    }),
  };
}

function messageInternalDateMs(index: number): number {
  return Date.parse('2026-07-01T00:00:00.000Z') + index * 86_400_000;
}

function gmailMessage(index: number): GmailMessage {
  return {
    id: `msg-${index}`,
    threadId: `thread-${index}`,
    historyId: `${900_000 + index}`,
    internalDate: String(messageInternalDateMs(index)),
    labelIds: ['INBOX'],
    snippet: `Apollo status ${index}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: `Apollo status ${index}` },
        { name: 'From', value: 'Alex <alex@example.com>' },
        { name: 'To', value: 'Team <team@example.com>' },
        { name: 'Date', value: new Date(messageInternalDateMs(index)).toUTCString() },
      ],
      body: { data: Buffer.from(`Apollo roadmap notes ${index}.`).toString('base64url') },
    },
  };
}

function gmailMessages(count: number): GmailMessage[] {
  return Array.from({ length: count }, (_, offset) => gmailMessage(offset + 1));
}

function fakeGmailClient(messages: GmailMessage[]): CountingGmailApiClient {
  const client: CountingGmailApiClient = {
    messages,
    listCalls: 0,
    getCalls: [],
    queries: [],
    async listMessages(request: GmailListMessagesRequest) {
      client.listCalls += 1;
      client.queries.push(request.query);
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = client.messages.filter((message) =>
        !after || Number(message.internalDate ?? '0') > Number(after) * 1_000);
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.maxResults);
      const nextOffset = offset + slice.length;
      return {
        messages: slice.map((message) => ({
          id: message.id,
          ...(message.threadId ? { threadId: message.threadId } : {}),
        })),
        ...(nextOffset < eligible.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async getMessage(id: string) {
      client.getCalls.push(id);
      const found = client.messages.find((message) => message.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      return found;
    },
  };
  return client;
}

function fakeBroker(): CredentialBroker {
  return {
    async issueSession() {
      return {
        kind: 'bearer_token',
        handle: 'gmail.personal',
        provider: 'gmail',
        capability: 'gmail.email.sync',
        token: 'gmail-test-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        audit: {
          handle: 'gmail.personal',
          provider: 'gmail',
          capability: 'gmail.email.sync',
          trustDomain: 'secure_local',
          scopes: ['gmail.email.sync'],
          outcome: 'issued',
          issuedAt: '2026-07-27T00:00:00.000Z',
          rawCredentialExposed: false,
        },
      };
    },
  };
}

function localEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'local-gmail-test',
    backend: 'local',
    modelId: 'local-gmail-test-model',
    dimension: 2,
    configHash: 'local-gmail-test-config',
    epochId: 'local-gmail-test:2026-07-27',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}
