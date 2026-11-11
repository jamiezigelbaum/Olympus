import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { LocalPeopleIndex, refreshPeopleIndex } from '../src/core/people-index.ts';
import type { SourceIndexCorpusSearchRequest } from '../src/core/source-index/router.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { gmailMessageItem } from '../src/workers/google-connectors/gmail-mail-record.ts';
import { connectorStoreAnswerScope } from '../src/workers/engine/server.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';

// One person, Brianna, in three sources: Gmail (by her address), WhatsApp (by
// her phone number) and Telegram (by an opaque user id). The owner's contacts
// hold one card for her with the address, the number and the Telegram entry.

function chatItem(provider: string, conversation: string, id: string, metadata: Record<string, unknown>, text: string): RawItem {
  return {
    identity: {
      family: 'chat',
      provider,
      accountScope: 'personal',
      providerItemId: id,
      providerConversationId: conversation,
      localItemId: `personal:${conversation}:${id}`,
      sourceVersion: '1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: { title: conversation, authoredAt: '2026-11-01T10:00:00.000Z', ...metadata },
    fetchedAt: '2026-11-02T00:00:00.000Z',
  };
}

function connector(id: string, family: 'chat' | 'email', items: RawItem[]): SourceConnector {
  return {
    id,
    family,
    async authenticate() {},
    listItems() {
      return (async function* () {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string) {
      const found = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing item ${localItemId}`);
      return found;
    },
    classificationSignals() {
      return {};
    },
  };
}

function request(store: LocalConnectorStore, query: string): SourceIndexCorpusSearchRequest {
  return {
    query,
    maxResults: 10,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
    context: { allowedTrustDomains: [store.trustDomain] },
  };
}

describe('one person across sources (#1076)', () => {
  test('a filter naming a person finds her in email, WhatsApp and Telegram, each cited with one name', async () => {
    const mail = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.gmail.email', family: 'email', trustDomain: 'internal' });
    const whatsapp = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.whatsapp.messages', family: 'chat', trustDomain: 'internal' });
    const telegram = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.telegram.messages', family: 'chat', trustDomain: 'internal' });
    const people = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      await mail.syncFromConnector(connector('gmail-test', 'email', [
        gmailMessageItem({
          id: 'm1',
          labelIds: ['INBOX'],
          headers: { subject: 'Trip', from: 'Brianna Reyes <Brianna@Example.com>', date: 'Sun, 01 Nov 2026 10:00:00 +0000' },
          body: 'The lisbon trip is booked for March.',
          metadataOnly: false,
          attachments: [],
        }, 'owner@example.com', '2026-11-02T00:00:00.000Z'),
        gmailMessageItem({
          id: 'm2',
          labelIds: ['SENT'],
          headers: { subject: 'Re: Trip', from: 'Jamie <owner@example.com>', date: 'Sun, 01 Nov 2026 11:00:00 +0000' },
          body: 'Great, the lisbon flights are mine to book.',
          metadataOnly: false,
          attachments: [],
        }, 'owner@example.com', '2026-11-02T00:00:00.000Z'),
      ]), { fetchContent: true });
      await whatsapp.syncFromConnector(connector('whatsapp-test', 'chat', [
        chatItem('whatsapp', 'dm-bri', 'w1', {
          senderId: '14155550123@s.whatsapp.net', senderLabel: 'Bri', senderIsOwner: false,
        }, 'Lisbon hotel is near the river.'),
        chatItem('whatsapp', 'dm-bri', 'w2', {
          senderId: '351910000000@s.whatsapp.net', senderLabel: 'Jamie', senderIsOwner: true,
        }, 'Lisbon sounds good.'),
      ]), { fetchContent: true });
      await telegram.syncFromConnector(connector('telegram-test', 'chat', [
        chatItem('telegram', 'crew', 't1', { senderId: '777', senderLabel: 'B.', senderIsOwner: false }, 'Lisbon dinner on Friday?'),
        chatItem('telegram', 'crew', 't2', { senderId: '888', senderLabel: 'Theo Lindqvist' }, 'Lisbon works for me.'),
      ]), { fetchContent: true });

      people.putContactCard({
        cardId: 'contacts:brianna',
        name: 'Brianna Reyes',
        keys: ['email:brianna@example.com', 'phone:+1 415 555 0123', 'sender:telegram:777'],
      });
      const stores = [mail, whatsapp, telegram];
      const everyone = refreshPeopleIndex(people, stores);

      const brianna = everyone.find((person) => person.displayName === 'Brianna Reyes')!;
      expect(brianna.identities.map((identity) => identity.provider).sort()).toEqual(['gmail', 'telegram', 'whatsapp']);
      expect(brianna.linkedBy).toEqual(['Linked by your contacts']);
      // One "me": the owner's Gmail (sent mail) and WhatsApp identities.
      const me = everyone.find((person) => person.isOwner)!;
      expect(me.displayName).toBe('You');
      expect(me.identities.map((identity) => identity.provider).sort()).toEqual(['gmail', 'whatsapp']);

      // "What did Brianna say about Lisbon": the label filter expands to her on every source.
      const cited: Array<{ provider: string; author: string | undefined }> = [];
      for (const store of stores) {
        const scope = connectorStoreAnswerScope({
          store,
          request: { question: 'What did Brianna say about Lisbon?', sender_label: 'Brianna' },
          people,
        });
        expect(scope.kind).toBe('search');
        if (scope.kind !== 'search') continue;
        const adapter = createConnectorStoreCorpusAdapter({ store, ...(scope.filters ? { filters: scope.filters } : {}) });
        const response = await adapter(request(store, 'lisbon'));
        for (const hit of response.hits) {
          cited.push({ provider: hit.sourceItem.provider, author: hit.provenance?.citation?.authorLabel });
        }
      }
      expect(cited.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
        { provider: 'gmail', author: 'Brianna Reyes' },
        { provider: 'telegram', author: 'Brianna Reyes' },
        { provider: 'whatsapp', author: 'Brianna Reyes' },
      ]);

      // Without a person filter, other people keep their own labels and the
      // owner's messages are not renamed by the people index.
      const all = await createConnectorStoreCorpusAdapter({ store: telegram })(request(telegram, 'lisbon'));
      expect(all.hits.map((hit) => hit.provenance?.citation?.authorLabel).sort()).toEqual(['Brianna Reyes', 'Theo Lindqvist']);
      const own = await createConnectorStoreCorpusAdapter({ store: whatsapp })(request(whatsapp, 'lisbon sounds'));
      const ownHit = own.hits.find((hit) => hit.sourceItem.providerItemId === 'w2');
      expect(ownHit?.provenance?.citation?.authorLabel).not.toBe('Brianna Reyes');
    } finally {
      people.close();
      mail.close();
      whatsapp.close();
      telegram.close();
    }
  });

  test('status reports items with no author for chat and email stores', async () => {
    const telegram = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'internal.telegram.messages', family: 'chat', trustDomain: 'internal' });
    try {
      await telegram.syncFromConnector(connector('telegram-test', 'chat', [
        chatItem('telegram', 'crew', 't1', { senderId: '777', senderLabel: 'B.' }, 'hello'),
        chatItem('telegram', 'crew', 't2', {}, 'a message nobody signed'),
      ]), { fetchContent: true });
      const status = await createSourceIndexStatusHandler({
        corpusDefinitions: [defineConnectorCorpus({ corpusId: telegram.corpusId, family: 'chat', trustDomain: 'internal' })],
        connectorStores: [telegram],
      }).status({ corpus_id: telegram.corpusId });
      expect(status.corpora[0]).toMatchObject({
        author_coverage: {
          items: 2,
          items_without_author: 1,
          by_provider: [{ provider: 'telegram', items: 2, items_without_author: 1 }],
        },
      });
    } finally {
      telegram.close();
    }
  });
});
