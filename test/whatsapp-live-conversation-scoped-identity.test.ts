// WhatsApp message ids are unique only inside their chat, so the live
// connector's local item id has to carry the chat too: the store's
// localItemId lanes (localContent, itemReactions) read with .get() and would
// otherwise serve whichever colliding row SQLite reached first.
//
// Also covers the empty transcript sidecar: an authoritative empty text emit
// is exactly what this connector's header says must never happen.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createWhatsAppLiveSourceConnector } from '../src/workers/whatsapp/index.ts';

const ACCOUNT = 'personal';

function spoolLine(input: Record<string, unknown> & { id: string }): string {
  return `${JSON.stringify({
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Ada',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Ada',
    from_me: false,
    timestamp: '2026-06-11T10:00:00Z',
    text: `message ${input.id}`,
    ...input,
  })}\n`;
}

function makeSpoolDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-live-identity-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function connectorFor(spoolDir: string): SourceConnector {
  return createWhatsAppLiveSourceConnector({ spoolDir, account: ACCOUNT });
}

async function drainItems(connector: SourceConnector): Promise<RawItem[]> {
  const pages: SourceConnectorListPage[] = [];
  for await (const page of connector.listItems()) pages.push(page);
  return pages.flatMap((page) => [...page.items]);
}

describe('WhatsApp live connector identity is chat-scoped', () => {
  test('the same message id in two chats yields two distinct local item ids', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl':
        spoolLine({ id: 'shared-id', chat_jid: 'chat-a@s.whatsapp.net', text: 'kestrel from chat A' })
        + spoolLine({ id: 'shared-id', chat_jid: 'chat-b@g.us', text: 'petrel from chat B' }),
    });
    const items = await drainItems(connectorFor(dir));

    const localItemIds = items.map((item) => item.identity.localItemId);
    expect(new Set(localItemIds).size).toBe(2);
    expect(localItemIds[0]).toContain('chat-a@s.whatsapp.net');
    expect(localItemIds[1]).toContain('chat-b@g.us');
  });

  test('stored colliding messages resolve their own chat content, not the first row scanned', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl':
        spoolLine({ id: 'shared-id', chat_jid: 'chat-a@s.whatsapp.net', text: 'kestrel from chat A' })
        + spoolLine({ id: 'shared-id', chat_jid: 'chat-b@g.us', text: 'petrel from chat B' }),
    });
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(connectorFor(dir), { fetchContent: true });

      const hits = store.searchItems('petrel', 5);
      expect(hits).toHaveLength(1);
      const chatBLocalItemId = hits[0]?.sourceItem.localItemId ?? '';
      expect(store.localContent(chatBLocalItemId)?.chunks.join(' ')).toContain('petrel');
    } finally {
      store.close();
    }
  });

  test('fetchItem answers from the chat named by the local item id', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl':
        spoolLine({ id: 'shared-id', chat_jid: 'chat-a@s.whatsapp.net', text: 'kestrel from chat A' })
        + spoolLine({ id: 'shared-id', chat_jid: 'chat-b@g.us', text: 'petrel from chat B' }),
    });
    const connector = connectorFor(dir);
    const items = await drainItems(connector);
    const chatA = items[0]?.identity.localItemId ?? '';

    const fetched = await connector.fetchItem(chatA);
    expect(fetched.content).toEqual({ kind: 'text', text: 'kestrel from chat A' });
    expect(fetched.identity.providerConversationId).toBe('chat-a@s.whatsapp.net');
  });

  test('a pre-existing bare local item id still fetches', async () => {
    const dir = makeSpoolDir({
      '2026-06-11.jsonl': spoolLine({ id: 'legacy-1', text: 'stored before the id carried its chat' }),
    });

    const fetched = await connectorFor(dir).fetchItem(`${ACCOUNT}:legacy-1`);
    expect(fetched.content).toEqual({ kind: 'text', text: 'stored before the id carried its chat' });
  });
});

describe('WhatsApp live transcript sidecar', () => {
  test('an empty sidecar leaves the voice note metadata_only instead of emitting empty text', async () => {
    const dir = makeSpoolDir({});
    const mediaPath = join(dir, 'voice-1.ogg');
    writeFileSync(mediaPath, 'fixture audio');
    // A crash mid-write (or a read inside the drain's O_TRUNC window) leaves
    // the sidecar present but empty.
    writeFileSync(`${mediaPath}.transcript.txt`, '   \n');
    writeFileSync(join(dir, '2026-06-11.jsonl'), spoolLine({
      id: 'voice-1',
      text: '',
      media_type: 'audio',
      media_path: mediaPath,
    }));

    const [item] = await drainItems(connectorFor(dir));
    expect(item?.content).toEqual({ kind: 'metadata_only' });
    expect(item?.metadata).not.toHaveProperty('transcript_source');
    expect(item?.metadata).not.toHaveProperty('extractor_kind');
  });
});
