/**
 * #1073: "who said X" in a WhatsApp group must name the right author for the
 * owner, a saved contact and an unsaved member, through the same path an
 * answer reads: the live connector, the connector store, and the citation the
 * Analyst sees.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { createWhatsAppLiveSourceConnector } from '../src/workers/whatsapp/index.ts';
import { whatsAppAddressLabel } from '../src/workers/whatsapp/live-connector.ts';

const GROUP = '120363000000000001@g.us';

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({
    chat_jid: GROUP,
    chat_name: 'Lisbon friends',
    from_me: false,
    timestamp: '2026-11-10T10:00:00Z',
    ...record,
  })}\n`;
}

async function citationAuthors(spool: string): Promise<Map<string, string | undefined>> {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-group-authors-'));
  writeFileSync(join(dir, '2026-11-10.jsonl'), spool);
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'secure_local.whatsapp.chat',
    family: 'chat',
    trustDomain: 'secure_local',
  });
  try {
    await store.syncFromConnector(createWhatsAppLiveSourceConnector({ spoolDir: dir, account: 'personal' }), { fetchContent: true });
    const adapter = createConnectorStoreCorpusAdapter({ store });
    const response = await adapter({
      query: 'ferry',
      maxResults: 10,
      corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
      context: { allowedTrustDomains: [store.trustDomain] },
    });
    return new Map(response.hits.map((hit) => [hit.provenance!.sourceItem.providerItemId, hit.provenance!.citation?.authorLabel]));
  } finally {
    store.close();
  }
}

describe('WhatsApp group authors (#1073)', () => {
  test('the owner, a saved contact and unsaved members are each named right', async () => {
    const authors = await citationAuthors([
      // The owner: the bridge records the owner's own profile name.
      line({ id: 'owner', sender_jid: '351910000001@s.whatsapp.net', sender_name: 'Jamie Z', from_me: true, text: 'ferry leaves at nine' }),
      // A saved contact: the phone's saved name wins over the profile name.
      line({ id: 'saved', sender_jid: '351910000002@s.whatsapp.net', sender_name: 'gh', sender_contact_name: 'Grace Hopper', text: 'ferry tickets bought' }),
      // An unsaved member with a profile name.
      line({ id: 'profile', sender_jid: '351910000003@s.whatsapp.net', sender_name: 'Ada', text: 'ferry is late' }),
      // Unsaved members WhatsApp sent no name for: a phone id and a hidden id.
      line({ id: 'phone', sender_jid: '351910000004@s.whatsapp.net', sender_name: '', text: 'ferry from Cais do Sodre' }),
      line({ id: 'hidden', sender_jid: '98765432101234@lid', sender_name: '', text: 'ferry back at six' }),
    ].join(''));
    expect(authors.size).toBe(5);
    const byId = (suffix: string) => [...authors].find(([id]) => id.endsWith(suffix))?.[1];
    expect(byId('owner')).toBe('You');
    expect(byId('saved')).toBe('Grace Hopper');
    expect(byId('profile')).toBe('Ada');
    expect(byId('phone')).toBe('+351910000004');
    expect(byId('hidden')).toBe('Unsaved WhatsApp contact');
    for (const author of authors.values()) expect(author).not.toMatch(/@(s\.whatsapp\.net|lid)$/);
  });

  test('a person address is shown as a number or an unsaved contact, never a raw id', () => {
    expect(whatsAppAddressLabel('351910000004@s.whatsapp.net')).toBe('+351910000004');
    expect(whatsAppAddressLabel('351910000004:12@s.whatsapp.net')).toBe('+351910000004');
    expect(whatsAppAddressLabel('98765432101234@lid')).toBe('Unsaved WhatsApp contact');
    expect(whatsAppAddressLabel(GROUP)).toBeUndefined();
    expect(whatsAppAddressLabel('status@broadcast')).toBeUndefined();
    expect(whatsAppAddressLabel(undefined)).toBeUndefined();
  });
});
