// Gmail content reaches EvidencePack through the shared connector store.
// This test deliberately exercises the canonical connector -> store -> generic
// LocalContentProvider path: Gmail owns only the source adapter.

import { describe, expect, test } from 'bun:test';
import type { SourceIndexProvenance } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
} from '../src/workers/connector-store/index.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GoogleGmailSourceConnector,
  type GmailApiClient,
} from '../src/workers/google-connectors/index.ts';
import type {
  GmailListMessagesRequest,
  GmailMessage,
} from '../src/workers/google-connectors/gmail.ts';

const ACCOUNT = 'personal';
const LOCAL_ITEM_ID = ACCOUNT + ':msg-1';

describe('Gmail connector-store content provider', () => {
  test('returns Gmail text through the source-neutral content provider', async () => {
    await withGmailStore(async (store) => {
      const provider = createConnectorStoreContentProvider({ store });
      const block = await provider.fetchLocalContent({
        provenance: provenance(),
        trustDomain: 'internal',
      });

      expect(block).toBeDefined();
      expect(block!.chunks.join('')).toContain('school visit is confirmed for May 8');
      expect(block!.sensitivity).toMatchObject({
        trustDomain: 'internal',
        trustTier: 'S3',
      });
      expect(block!.locatorUri).toBe('https://mail.google.com/mail/u/0/#all/msg-1');
      expect(block!.truncated).toBeUndefined();
    });
  });

  test('applies the shared max-character bound without a Gmail-specific path', async () => {
    await withGmailStore(async (store) => {
      const block = await createConnectorStoreContentProvider({ store }).fetchLocalContent({
        provenance: provenance(),
        trustDomain: 'internal',
        maxChars: 24,
      });

      expect(block).toBeDefined();
      expect(block!.chunks.join('')).toHaveLength(24);
      expect(block!.truncated).toBe(true);
      expect(block!.coverageGaps).toContain('stored text was truncated to fit the evidence budget.');
    }, 'x'.repeat(500));
  });

  test('returns undefined for unknown identities and refuses trust-domain crossover', async () => {
    await withGmailStore(async (store) => {
      const provider = createConnectorStoreContentProvider({ store });
      const missing = await provider.fetchLocalContent({
        provenance: provenance(ACCOUNT + ':missing'),
        trustDomain: 'internal',
      });
      expect(missing).toBeUndefined();

      await expect(provider.fetchLocalContent({
        provenance: provenance(),
        trustDomain: 'secure_local',
      })).rejects.toThrow('refused a secure_local content request');
    });
  });
});

async function withGmailStore(
  run: (store: LocalConnectorStore) => void | Promise<void>,
  body = 'The school visit is confirmed for May 8 at 9:30 AM at the Lisbon campus.',
): Promise<void> {
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'email',
    trustDomain: 'internal',
  });
  try {
    await store.syncFromConnector(gmailConnector(body), { fetchContent: true });
    await run(store);
  } finally {
    store.close();
  }
}

function gmailConnector(body: string): GoogleGmailSourceConnector {
  const message: GmailMessage = {
    id: 'msg-1',
    threadId: 'thread-1',
    historyId: '9001',
    internalDate: String(Date.parse('2026-05-02T08:00:00.000Z')),
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: 'School visit' },
        { name: 'From', value: 'admissions@example-school.test' },
        { name: 'To', value: 'jamie@example.com' },
        { name: 'Date', value: 'Sat, 02 May 2026 08:00:00 +0000' },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
  const apiClient: GmailApiClient = {
    async listMessages(_request: GmailListMessagesRequest) {
      return { messages: [{ id: message.id, threadId: 'thread-1' }] };
    },
    async getMessage(id: string) {
      if (id !== message.id) throw new Error('unexpected Gmail message id');
      return message;
    },
  };
  return new GoogleGmailSourceConnector({
    account: ACCOUNT,
    apiClient,
    maxMessages: 10,
  });
}

function provenance(localItemId = LOCAL_ITEM_ID): SourceIndexProvenance {
  return {
    sourceItem: {
      family: 'email',
      provider: 'gmail',
      accountScope: ACCOUNT,
      providerItemId: localItemId.slice((ACCOUNT + ':').length),
      providerThreadId: 'thread-1',
      localItemId,
    },
  };
}
