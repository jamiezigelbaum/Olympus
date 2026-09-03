import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_RESUME_REJECTED_WARNING,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  createGmailConnectorStoreSyncHandler,
  type GmailApiClient,
  type GmailConnectorStoreSyncHandler,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const openStores: LocalConnectorStore[] = [];

afterEach(() => {
  while (openStores.length > 0) openStores.pop()!.close();
});

describe('Gmail head cursor rejection scope', () => {
  test('a per-message 404 under a watermark-only resume point never drops the watermark', async () => {
    // The steady state: a completed traversal leaves a cursor holding only the
    // internalDate watermark, so there is no provider page token a 4xx could be
    // rejecting. A message listed and then permanently deleted before its get
    // must fail the run, not retraverse the whole mailbox.
    const client = ghostGmailClient(gmailMessages(3), 'msg-ghost');
    const lane = gmailLane(client, 10);

    const first = await lane.pull({ max_items: 10 });
    expect(first.receipt.counts.items_seen).toBe(3);
    expect(first.receipt.counts.traversal_complete).toBe(1);
    const checkpoint = first.checkpoint!;

    client.ghostListed = true;
    await expect(lane.pull({ max_items: 10, checkpoint })).rejects.toThrow(
      /Gmail API request failed \(404\)/,
    );
    // One list call for the failed pull, and no un-bounded retraversal after it.
    expect(client.queries.slice(1).every((query) => query?.includes('after:'))).toBe(true);
  });

  test('a rejected page token on a mid-traversal resume point still traverses fresh', async () => {
    const client = ghostGmailClient(gmailMessages(4), 'msg-ghost');
    const lane = gmailLane(client, 2);

    const first = await lane.pull({ max_items: 2 });
    expect(first.receipt.counts.traversal_complete).toBe(0);

    client.rejectPageTokenOnce = true;
    const second = await lane.pull({ max_items: 2, checkpoint: first.checkpoint! });

    expect(second.receipt.counts.resume_cursor_rejected).toBe(1);
    expect(second.receipt.warnings).toContain(GMAIL_RESUME_REJECTED_WARNING);
    expect(second.receipt.counts.items_seen).toBe(2);
  });
});

interface GhostGmailApiClient extends GmailApiClient {
  messages: GmailMessage[];
  queries: Array<string | undefined>;
  /** The listed-then-unfetchable id, present in exactly one listing. */
  ghostListed: boolean;
  rejectPageTokenOnce: boolean;
}

function ghostGmailClient(messages: GmailMessage[], ghostId: string): GhostGmailApiClient {
  const client: GhostGmailApiClient = {
    messages,
    queries: [],
    ghostListed: false,
    rejectPageTokenOnce: false,
    async listMessages(request: GmailListMessagesRequest) {
      if (request.pageToken && client.rejectPageTokenOnce) {
        client.rejectPageTokenOnce = false;
        throw new Error('Gmail API request failed (400): invalid page token');
      }
      client.queries.push(request.query);
      const after = /after:(\d+)/.exec(request.query ?? '')?.[1];
      const eligible = client.messages.filter((message) =>
        !after || Number(message.internalDate ?? '0') > Number(after) * 1_000);
      const listed = client.ghostListed ? [{ id: ghostId }, ...eligible.map((message) => ({ id: message.id }))] : eligible.map((message) => ({ id: message.id }));
      // The ghost is listed once and then gone, exactly as a deletion that
      // races the listing behaves.
      client.ghostListed = false;
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = listed.slice(offset, offset + request.maxResults);
      const nextOffset = offset + slice.length;
      return {
        messages: slice,
        ...(nextOffset < listed.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async getMessage(id: string) {
      const found = client.messages.find((message) => message.id === id);
      if (!found) throw new Error(`Gmail API request failed (404): unknown ${id}`);
      return found;
    },
  };
  return client;
}

function gmailLane(client: GmailApiClient, maxMessages: number): GmailConnectorStoreSyncHandler {
  const internalStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'internal',
  });
  const secureStore = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'secure_local',
  });
  openStores.push(internalStore, secureStore);
  const provider = localEmbeddingProvider();
  return createGmailConnectorStoreSyncHandler({
    internalStore,
    secureStore,
    account: 'personal',
    apiClient: client,
    maxMessages,
    internalEmbeddingProvider: provider,
    secureEmbeddingProvider: provider,
    env: {},
  });
}

function messageInternalDateMs(index: number): number {
  return Date.parse('2026-07-01T00:00:00.000Z') + index * 86_400_000;
}

function gmailMessages(count: number): GmailMessage[] {
  return Array.from({ length: count }, (_unused, offset) => {
    const index = offset + 1;
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
  });
}

function localEmbeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'local-gmail-test',
    backend: 'local',
    modelId: 'local-gmail-test-model',
    dimension: 2,
    configHash: 'local-gmail-test-config',
    epochId: 'local-gmail-test:2026-08-18',
    async embed(inputs) {
      return inputs.map(() => [1, 0]);
    },
  };
}
