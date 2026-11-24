/**
 * #1073: "who said X" in a WhatsApp group must name the right author for the
 * owner, a saved contact and an unsaved member, through the same path an
 * answer reads: the live connector, the connector store, and the citation the
 * Analyst sees.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyst } from '../src/core/analyst.ts';
import { privateEvidencePack } from '../src/core/analyst-built-in.ts';
import { WHATSAPP_ARCHIVE_FORMAT } from '../src/core/archive-formats.ts';
import { LocalPeopleIndex, refreshPeopleIndex } from '../src/core/people-index.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import { privateEvidence } from '../src/workers/chatgpt/private-answer-model.ts';
import { answerToolResult, searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { readDeepReadSet } from '../src/workers/engine/runtime/deep-read-jobs.ts';
import { searchPrivateEvidence, searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { createWhatsAppExportInput } from '../src/workers/whatsapp/archive-input.ts';
import { whatsAppConnectorWithInputs } from '../src/workers/whatsapp/archive-target.ts';
import { whatsAppAddressLabel } from '../src/workers/whatsapp/live-connector.ts';
import { chatText } from './support/archive-fixtures-whatsapp.ts';

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

function lanesFor(store: LocalConnectorStore) {
  const corpus = defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain });
  return () => ({
    registry: buildSourceIndexCorpusRegistry([corpus]),
    adapters: { [store.corpusId]: createConnectorStoreCorpusAdapter({ store }) },
    contentProviders: { [store.corpusId]: createConnectorStoreContentProvider({ store }) },
  });
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
    await store.syncFromConnector(whatsAppConnectorWithInputs({ spoolDir: dir }), { fetchContent: true });
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
    rmSync(dir, { recursive: true, force: true });
  }
}

const DIRECT = '351910000002@s.whatsapp.net';
const OWNER = { sender: 'Jamie Z', label: 'You', jid: '351910000001@s.whatsapp.net', fromMe: true };
const SAVED = { sender: 'Grace Hopper', label: 'Grace Hopper', jid: DIRECT, fromMe: false };
const UNSAVED = { sender: 'Ada', label: 'Ada', jid: '98765432101234@lid', fromMe: false };

describe('WhatsApp authors at the answer surfaces', () => {
  for (const { chat, chatJid, authors } of [
    { chat: 'Grace Hopper', chatJid: DIRECT, authors: [OWNER, SAVED] },
    { chat: 'Lisbon friends', chatJid: GROUP, authors: [OWNER, SAVED, UNSAVED] },
  ]) {
    test(`${chat}: live and export messages keep their authors through storage and the private Analyst`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'whatsapp-answer-authors-'));
      const store = new LocalConnectorStore({
        dbPath: ':memory:', corpusId: 'secure_local.whatsapp.chat', family: 'chat', trustDomain: 'secure_local',
      });
      try {
        const rows = authors.map((author, index) => ({
          ...author,
          id: `live-${index}`,
          at: `2026-11-10T10:0${index}:00`,
          live: `ferry live message ${index}`,
          imported: `ferry imported message ${index}`,
        }));
        writeFileSync(join(dir, '2026-11-10.jsonl'), rows.map(row => line({
          id: row.id, chat_jid: chatJid, chat_name: chat, timestamp: `${row.at}Z`, text: row.live,
          from_me: row.fromMe, sender_jid: row.jid,
          sender_name: row.label === SAVED.label ? 'gh' : row.sender,
          ...(row.label === SAVED.label ? { sender_contact_name: row.label } : {}),
        })).join(''));
        const connector = whatsAppConnectorWithInputs({ spoolDir: dir });
        await store.syncFromConnector(connector, { fetchContent: true });

        const name = `WhatsApp Chat with ${chat}.txt`;
        const exportRows = [
          ...rows.map(row => ({ at: row.at, sender: row.sender, text: row.live })),
          ...rows.map((row, index) => ({ at: `2026-11-10T11:0${index}:00`, sender: row.sender, text: row.imported })),
        ];
        writeFileSync(join(dir, name), chatText(exportRows, { style: 'android-24-dmy' }));
        const root = ScopeRoot.open(dir);
        try {
          const manifest = buildArchiveManifest(root, [name]);
          const input = createWhatsAppExportInput({
            archive: {
              archiveId: 'whatsapp-authors', connectorId: 'archive.whatsapp-authors', accountScope: 'whatsapp-authors',
              format: WHATSAPP_ARCHIVE_FORMAT, root, files: archiveFileEntries(manifest),
              manifestSha256: archiveManifestSha256(manifest), report: () => undefined, shouldContinue: () => true,
            },
            spoolDir: dir, zones: ['UTC'],
          });
          await store.syncFromConnector(connector.forInput!(input), { fetchContent: true });
        } finally {
          root.close();
        }

        const question = 'ferry';
        const stored = store.searchItems(question, 20);
        expect(stored).toHaveLength(rows.length * 2);
        for (const row of rows) {
          for (const hour of ['10', '11']) {
            const storedRow = stored.find(item => item.authoredAt === `${row.at.replace('T10:', `T${hour}:`)}.000Z`);
            expect(storedRow).toMatchObject({
              title: chat, conversationLabel: chat, authorLabel: row.sender, senderIsOwner: row.fromMe,
            });
          }
        }

        const result = await searchPrivateEvidence({ lanes: lanesFor(store), question });
        const byText = new Map(result.candidates.map(item => [item.chunks.join(''), item.provenance.citation]));
        const anchor = stored[0]!.sourceItem;
        const deepRead = await readDeepReadSet({
          whole: 'conversation',
          selected_item: {
            corpus_id: store.corpusId, provider: anchor.provider, account_scope: anchor.accountScope,
            local_item_id: anchor.localItemId, provider_conversation_id: chatJid, conversation_label: chat,
          },
        }, () => [store], lanesFor(store));
        const deepByText = new Map(deepRead.candidates.map(item => [item.chunks.join(''), item.provenance.citation]));
        for (const row of rows) {
          for (const message of [row.live, row.imported]) {
            const citation = { title: chat, conversationLabel: chat, authorLabel: row.label };
            expect(byText.get(message)).toMatchObject(citation);
            expect(deepByText.get(message)).toMatchObject(citation);
          }
        }
        const pack = privateEvidencePack(question, privateEvidence(result.candidates.map(candidate => ({ ...candidate }))).items);
        const analyst = createAnalyst({
          async complete({ system, prompt }) {
            expect(system).toContain('"You" as the author means the person asking.');
            for (const row of rows) {
              for (const message of [row.live, row.imported]) {
                const section = prompt.split(/(?=^\[\d+\] )/m).find(candidate => candidate.includes(JSON.stringify([message])));
                expect(section).toContain(`Conversation: ${chat}`);
                expect(section).toContain(`from: ${row.label}`);
              }
            }
            return { modelId: 'fixture', text: '{"answer":"","citations":[],"unanswered":[],"sufficient":false}' };
          },
        }, { evidenceFormat: 'compact' });
        await analyst.analyze(pack, { localOnly: true });
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('released MCP search keeps the owner label paired with the excerpt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-answer-mcp-'));
    const store = new LocalConnectorStore({
      dbPath: ':memory:', corpusId: 'internal.whatsapp.chat', family: 'chat', trustDomain: 'internal',
    });
    try {
      writeFileSync(join(dir, '2026-11-10.jsonl'), line({
        id: 'owner', chat_jid: DIRECT, chat_name: SAVED.sender, sender_name: OWNER.sender,
        from_me: true, text: 'ferry is booked',
      }));
      await store.syncFromConnector(whatsAppConnectorWithInputs({ spoolDir: dir }), { fetchContent: true });
      const released = await searchReleasedEvidence({
        lanes: lanesFor(store), question: 'ferry',
        releaseCheck: {
          inputs: inputs => inputs.map(() => ({ tier: 'public_or_personal', gone: false })),
          chunks: async inputs => ({ allowed: inputs.map(input => input.chunkHashes ?? []), withheldPassages: 0, withheldDocuments: 0 }),
          secureDerivativeDefault: () => 'approval',
        },
      });
      expect(released.evidence).toMatchObject([{
        title: SAVED.sender, conversation_label: SAVED.sender, author_label: 'You', excerpt: 'ferry is booked',
      }]);
      expect(searchToolResult(released).structuredContent?.evidence).toMatchObject([{
        title: `From You · Conversation: ${SAVED.sender}`, excerpt: 'ferry is booked',
      }]);
      const answer = { answer: 'You said the ferry is booked.', evidence: released.evidence };
      const citation = [{ title: `From You · Conversation: ${SAVED.sender}` }];
      expect(answerToolResult(answer).structuredContent?.citations).toMatchObject(citation);
      expect(remoteOperationOutput('source_answer', answer).citations).toMatchObject(citation);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a later saved name resolves earlier messages by sender id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-late-sender-name-'));
    const store = new LocalConnectorStore({
      dbPath: ':memory:', corpusId: 'internal.whatsapp.chat', family: 'chat', trustDomain: 'internal',
    });
    const people = new LocalPeopleIndex({ dbPath: ':memory:' });
    try {
      writeFileSync(join(dir, '2026-11-10.jsonl'), [
        line({ id: 'earlier', sender_jid: SAVED.jid, text: 'ferry heading out' }),
        line({ id: 'later', sender_jid: SAVED.jid, sender_contact_name: SAVED.sender, text: 'ferry arriving' }),
      ].join(''));
      await store.syncFromConnector(whatsAppConnectorWithInputs({ spoolDir: dir }), { fetchContent: true });
      expect(store.searchItems('heading', 10)[0]?.authorLabel).toBe('+351910000002');
      await refreshPeopleIndex(people, [store]);
      const lanes = lanesFor(store)();
      const [hit] = (await lanes.adapters[store.corpusId]!({
        query: 'heading', maxResults: 10, corpus: lanes.registry.get(store.corpusId)!,
        context: { allowedTrustDomains: [store.trustDomain] },
      })).hits;
      expect(hit?.provenance?.citation?.authorLabel).toBe(SAVED.sender);
    } finally {
      people.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
      line({ id: 'phone', sender_jid: '351910000004@s.whatsapp.net', sender_name: '351910000004@s.whatsapp.net', text: 'ferry from Cais do Sodre' }),
      line({ id: 'hidden', sender_jid: '98765432101234@lid', sender_name: '', text: 'ferry back at six' }),
    ].join(''));
    expect(authors.size).toBe(5);
    const byId = (suffix: string) => [...authors].find(([id]) => id.endsWith(suffix))?.[1];
    expect(byId('owner')).toBe('You');
    expect(byId('saved')).toBe('Grace Hopper');
    expect(byId('profile')).toBe('Ada');
    expect(byId('phone')).toBe('+351910000004');
    expect(byId('hidden')).toBe('Unsaved WhatsApp contact ·1234');
    for (const author of authors.values()) expect(author).not.toMatch(/@(s\.whatsapp\.net|lid)$/);
  });

  test('a person address is shown as a number or an unsaved contact, never a raw id', () => {
    expect(whatsAppAddressLabel('351910000004@s.whatsapp.net')).toBe('+351910000004');
    expect(whatsAppAddressLabel('351910000004:12@s.whatsapp.net')).toBe('+351910000004');
    expect(whatsAppAddressLabel('98765432101234@lid')).toBe('Unsaved WhatsApp contact ·1234');
    // Two unsaved members of one group never share a label, so the people
    // index can't link them by name (Codex review on #1152).
    expect(whatsAppAddressLabel('11111111115678@lid')).not.toBe(whatsAppAddressLabel('22222222229999@lid'));
    expect(whatsAppAddressLabel(GROUP)).toBeUndefined();
    expect(whatsAppAddressLabel('status@broadcast')).toBeUndefined();
    expect(whatsAppAddressLabel(undefined)).toBeUndefined();
  });
});
