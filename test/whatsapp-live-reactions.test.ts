// WhatsApp reaction capture (R1): the connector half of the owner ruling that
// a reaction confirms a message and is therefore evidence carried BY that
// message.
//
// What these pin, in the order the failures would actually hurt:
// - reaction lines stop producing junk items of their own;
// - the aggregate is a function of the whole spool, so the drain's deliberate
//   full rescan reproduces it exactly instead of double-counting;
// - a reacted message is re-emitted with its ORIGINAL text, because an empty
//   or metadata_only emit would delete its chunks or drive the store into
//   fetchItem;
// - a target that cannot be resolved to a message in the same chat is skipped
//   and counted, never emitted content-less;
// - a pathological aggregate lands truncated rather than aborting the run;
// - records written by the new daemon stay readable to an older connector.

import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import type { SourceReaction } from '../src/core/source-index/reactions.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  createWhatsAppLiveSourceConnector,
  readWhatsAppLiveSpoolStatus,
} from '../src/workers/whatsapp/index.ts';

const ACCOUNT = 'personal';
const CHAT = '12036303990000000000@g.us';

interface MessageInput {
  id: string;
  chat_jid?: string;
  chat_name?: string;
  sender_jid?: string;
  sender_name?: string;
  from_me?: boolean;
  timestamp?: string;
  text?: string;
  media_type?: string;
}

interface ReactionInput {
  id: string;
  target: string;
  key?: string;
  removed?: boolean;
  chat_jid?: string;
  target_chat_jid?: string;
  sender_jid?: string;
  sender_name?: string;
  from_me?: boolean;
  timestamp?: string;
}

function messageLine(input: MessageInput): string {
  return `${JSON.stringify({
    chat_jid: CHAT,
    chat_name: 'Family',
    sender_jid: 'ada@s.whatsapp.net',
    sender_name: 'Ada',
    from_me: false,
    timestamp: '2026-07-26T09:00:00Z',
    text: `message ${input.id}`,
    ...input,
  })}\n`;
}

function reactionLine(input: ReactionInput): string {
  const { target, key, removed, target_chat_jid: targetChatJid, ...rest } = input;
  return `${JSON.stringify({
    chat_jid: CHAT,
    chat_name: 'Family',
    sender_jid: 'jane@s.whatsapp.net',
    sender_name: 'Jane',
    from_me: false,
    timestamp: '2026-07-26T09:05:00Z',
    text: '',
    media_type: 'reaction',
    reaction_target_id: target,
    reaction_target_chat_jid: targetChatJid ?? CHAT,
    ...(removed === true ? { reaction_removed: true } : { reaction_key: key ?? '👍' }),
    reaction_sender_timestamp_ms: 1769000000000,
    ...rest,
  })}\n`;
}

function makeSpoolDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'whatsapp-reactions-spool-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function connectorFor(spoolDir: string): SourceConnector {
  return createWhatsAppLiveSourceConnector({ spoolDir, account: ACCOUNT });
}

async function drainItems(connector: SourceConnector, options?: { cursor?: string; limit?: number }): Promise<RawItem[]> {
  const pages: SourceConnectorListPage[] = [];
  for await (const page of connector.listItems(options)) pages.push(page);
  return pages.flatMap((page) => [...page.items]);
}

function reactionsOf(item: RawItem | undefined): readonly SourceReaction[] | undefined {
  return item?.metadata['reactions'] as readonly SourceReaction[] | undefined;
}

function storeFor(dbPath: string): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: 'secure_local.whatsapp.messages',
    family: 'chat',
    trustDomain: 'secure_local',
  });
}

describe('WhatsApp live reaction capture', () => {
  test('a reaction emits no item of its own and re-emits its target with the full original text', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1', text: 'flight lands tuesday at noon' })
        + reactionLine({ id: 'react-1', target: 'msg-1' }),
    });

    const items = await drainItems(connectorFor(dir));
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['msg-1']);
    const item = items[0];
    // The upsert trap: an empty-text emit deletes the stored chunks and a
    // metadata_only emit drives the store into fetchItem.
    expect(item?.content).toEqual({ kind: 'text', text: 'flight lands tuesday at noon' });
    expect(reactionsOf(item)).toEqual([
      { key: '👍', count: 1, actors: [{ providerActorId: 'jane@s.whatsapp.net', label: 'Jane' }] },
    ]);
    expect(readWhatsAppLiveSpoolStatus(dir)).toMatchObject({
      reactionLines: 1,
      unresolvedReactionTargets: 0,
    });
  });

  test('a reaction to an already-drained message re-emits that message alone', async () => {
    const dir = makeSpoolDir({ '2026-07-26.jsonl': messageLine({ id: 'msg-1', text: 'bring the charger' }) });
    const connector = connectorFor(dir);
    const first = await drainItems(connector);
    expect(first).toHaveLength(1);
    expect(reactionsOf(first[0])).toBeUndefined();

    appendFileSync(join(dir, '2026-07-26.jsonl'), reactionLine({ id: 'react-1', target: 'msg-1', key: '❤️' }));
    const resumed = await drainItems(connector, { cursor: '2026-07-26.jsonl:1' });
    expect(resumed.map((item) => item.identity.providerItemId)).toEqual(['msg-1']);
    expect(resumed[0]?.content).toEqual({ kind: 'text', text: 'bring the charger' });
    expect(resumed[0]?.identity.sourceVersion).toBe('2026-07-26T09:00:00Z');
    expect(reactionsOf(resumed[0])).toEqual([
      { key: '❤️', count: 1, actors: [{ providerActorId: 'jane@s.whatsapp.net', label: 'Jane' }] },
    ]);
  });

  test('the aggregate is a function of the whole spool, so a full rescan reproduces it exactly', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + reactionLine({ id: 'react-1', target: 'msg-1', key: '👍' })
        + reactionLine({ id: 'react-2', target: 'msg-1', key: '👍', sender_jid: 'cass@s.whatsapp.net', sender_name: 'Cass' })
        + reactionLine({ id: 'react-3', target: 'msg-1', key: '🎉', sender_jid: 'dov@s.whatsapp.net', sender_name: 'Dov' }),
    });

    const first = await drainItems(connectorFor(dir));
    const replay = await drainItems(connectorFor(dir));
    // Replay is what the drain actually does when it meets a foreign cursor;
    // an accumulate-a-delta scheme would double every count here.
    expect(reactionsOf(replay[0])).toEqual(reactionsOf(first[0]) ?? []);
    expect(reactionsOf(first[0])).toEqual([
      {
        key: '👍',
        count: 2,
        actors: [
          { providerActorId: 'cass@s.whatsapp.net', label: 'Cass' },
          { providerActorId: 'jane@s.whatsapp.net', label: 'Jane' },
        ],
      },
      { key: '🎉', count: 1, actors: [{ providerActorId: 'dov@s.whatsapp.net', label: 'Dov' }] },
    ]);
  });

  test('one actor holds one live reaction per message: a later token replaces the earlier one', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + reactionLine({ id: 'react-1', target: 'msg-1', key: '👍' })
        + reactionLine({ id: 'react-2', target: 'msg-1', key: '🎉' }),
    });
    const items = await drainItems(connectorFor(dir));
    expect(reactionsOf(items[0])).toEqual([
      { key: '🎉', count: 1, actors: [{ providerActorId: 'jane@s.whatsapp.net', label: 'Jane' }] },
    ]);
  });

  test('removal ordering is decided by spool order, not by which line looks like a removal', async () => {
    const removedLast = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + reactionLine({ id: 'react-1', target: 'msg-1', key: '👍' })
        + reactionLine({ id: 'react-2', target: 'msg-1', removed: true }),
    });
    // Empty array, not absent: the store preserves what it holds on an absent
    // aggregate, so a taken-back reaction has to say "there are none now".
    expect(reactionsOf((await drainItems(connectorFor(removedLast)))[0])).toEqual([]);

    const removedFirst = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + reactionLine({ id: 'react-1', target: 'msg-1', removed: true })
        + reactionLine({ id: 'react-2', target: 'msg-1', key: '👍' }),
    });
    expect(reactionsOf((await drainItems(connectorFor(removedFirst)))[0])).toEqual([
      { key: '👍', count: 1, actors: [{ providerActorId: 'jane@s.whatsapp.net', label: 'Jane' }] },
    ]);
  });

  test('a 40-reactor token is truncated to a listable aggregate with the true count', async () => {
    const reactors = Array.from({ length: 40 }, (_, index) => ({
      jid: `reactor-${String(index).padStart(2, '0')}@s.whatsapp.net`,
      name: `Reactor ${index}`,
    }));
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + reactors
          .map((reactor, index) => reactionLine({
            id: `react-${index}`,
            target: 'msg-1',
            key: '👍',
            sender_jid: reactor.jid,
            sender_name: reactor.name,
          }))
          .join(''),
    });

    const items = await drainItems(connectorFor(dir));
    const aggregate = reactionsOf(items[0]);
    expect(aggregate).toHaveLength(1);
    // The count is the truth about how many people reacted; the actor list is
    // explicitly allowed to be partial.
    expect(aggregate?.[0]?.count).toBe(40);
    expect(aggregate?.[0]?.actors).toHaveLength(32);

    // The store must accept it without a run-aborting refusal.
    const store = storeFor(':memory:');
    try {
      const summary = await store.syncFromConnector(connectorFor(dir), { fetchContent: true });
      expect(summary.itemsRejected).toBe(0);
      expect(store.itemReactions(`${ACCOUNT}:${CHAT}:msg-1`)[0]?.count).toBe(40);
    } finally {
      store.close();
    }
  });

  test('more tokens than the cap keeps the 32 busiest, with their true counts', async () => {
    // 48 distinct tokens with distinct actor counts, so the ranking is ordered.
    const tokens = Array.from({ length: 48 }, (_, index) => String.fromCodePoint(0x1f600 + index));
    const lines = tokens.flatMap((token, tokenIndex) =>
      Array.from({ length: tokenIndex + 1 }, (_, actorIndex) => reactionLine({
        id: `react-${tokenIndex}-${actorIndex}`,
        target: 'msg-1',
        key: token,
        sender_jid: `reactor-${tokenIndex}-${actorIndex}@s.whatsapp.net`,
        sender_name: `Reactor ${tokenIndex}-${actorIndex}`,
      })));
    const dir = makeSpoolDir({ '2026-07-26.jsonl': messageLine({ id: 'msg-1' }) + lines.join('') });

    const aggregate = reactionsOf((await drainItems(connectorFor(dir)))[0]);
    // The token cap is the only thing that drops tokens here: all 32 survive
    // with true counts, and the actor lists absorb the size limit.
    expect(aggregate).toHaveLength(32);
    expect(JSON.stringify(aggregate).length).toBeLessThanOrEqual(4_000);
    expect(aggregate?.[0]?.key).toBe(tokens[47]);
    expect(aggregate?.[0]?.count).toBe(48);
    expect(aggregate?.at(-1)?.count).toBe(17);

    const store = storeFor(':memory:');
    try {
      const summary = await store.syncFromConnector(connectorFor(dir), { fetchContent: true });
      expect(summary.itemsRejected).toBe(0);
      expect(summary.itemsIndexed).toBe(1);
    } finally {
      store.close();
    }
  });

  test('an actor-heavy message keeps every token and count, and sheds actor lists instead', async () => {
    // Three tokens with a different 32 people behind each, realistic JIDs: the
    // full aggregate is far past the store's size limit. "Confirmed by 👍 ×32"
    // is the claim the owner ruling cares about, so no token and no count may
    // be sacrificed to make room — the actor lists are what gives way. (One
    // person cannot hold two live reactions on one message, so the reactors
    // have to differ per token for all three to survive at all.)
    const tokens = ['👍', '🎉', '❤️'];
    const lines = tokens.flatMap((token, tokenIndex) =>
      Array.from({ length: 32 }, (_, actorIndex) => reactionLine({
        id: `react-${tokenIndex}-${actorIndex}`,
        target: 'msg-1',
        key: token,
        sender_jid: `15551231${tokenIndex}${String(actorIndex).padStart(2, '0')}@s.whatsapp.net`,
        sender_name: `Reactor ${tokenIndex}-${actorIndex}`,
      })));
    const dir = makeSpoolDir({ '2026-07-26.jsonl': messageLine({ id: 'msg-1' }) + lines.join('') });

    const aggregate = reactionsOf((await drainItems(connectorFor(dir)))[0]) ?? [];
    expect(aggregate).toHaveLength(3);
    expect([...aggregate].map((reaction) => reaction.key).sort()).toEqual([...tokens].sort());
    for (const reaction of aggregate) expect(reaction.count).toBe(32);
    expect(JSON.stringify(aggregate).length).toBeLessThanOrEqual(4_000);

    // Actor lists are shed from the lowest-ranked token upward, so whatever
    // fits sits at the top and no listed token ever follows an unlisted one.
    const listed = aggregate.map((reaction) => (reaction.actors?.length ?? 0) > 0);
    expect(listed[0]).toBe(true);
    expect(listed).toEqual([...listed].sort((left, right) => Number(right) - Number(left)));
    expect(aggregate[0]?.actors).toHaveLength(32);

    const store = storeFor(':memory:');
    try {
      const summary = await store.syncFromConnector(connectorFor(dir), { fetchContent: true });
      expect(summary.itemsRejected).toBe(0);
      const stored = store.itemReactions(`${ACCOUNT}:${CHAT}:msg-1`);
      expect(stored).toHaveLength(3);
      for (const reaction of stored) expect(reaction.count).toBe(32);
    } finally {
      store.close();
    }
  });

  test('an unresolvable target is a counted gap, never a content-less emit', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1', text: 'unrelated message' })
        + reactionLine({ id: 'react-1', target: 'missing-msg' }),
    });

    const items = await drainItems(connectorFor(dir));
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['msg-1']);
    expect(reactionsOf(items[0])).toBeUndefined();
    expect(readWhatsAppLiveSpoolStatus(dir)).toMatchObject({
      reactionLines: 1,
      unresolvedReactionTargets: 1,
    });
  });

  test('a target resolved from another chat is skipped: WhatsApp ids are only unique per chat', async () => {
    const otherChat = 'other-chat@g.us';
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'shared-id', chat_jid: otherChat, chat_name: 'Other', text: 'a different conversation' })
        + reactionLine({ id: 'react-1', target: 'shared-id' }),
    });

    const items = await drainItems(connectorFor(dir));
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['shared-id']);
    expect(reactionsOf(items[0])).toBeUndefined();
    expect(readWhatsAppLiveSpoolStatus(dir).unresolvedReactionTargets).toBe(1);
  });

  test('the same id in two chats attaches the reaction only to the message from the reacting chat', async () => {
    const dir = makeSpoolDir({
      '2026-07-25.jsonl': messageLine({ id: 'shared-id', text: 'reacted message' }),
      // A later line re-uses the id in another chat; resolving by id alone
      // would attach the reaction to this one.
      '2026-07-26.jsonl':
        messageLine({ id: 'shared-id', chat_jid: 'other-chat@g.us', chat_name: 'Other', text: 'unrelated message' })
        + reactionLine({ id: 'react-1', target: 'shared-id' }),
    });

    const items = await drainItems(connectorFor(dir));
    expect(items).toHaveLength(2);
    for (const item of items) expect(reactionsOf(item)).toBeUndefined();
    expect(readWhatsAppLiveSpoolStatus(dir).unresolvedReactionTargets).toBe(1);
  });

  test('a reaction line from an older daemon build carries no target and yields nothing', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + `${JSON.stringify({
          id: 'legacy-reaction',
          chat_jid: CHAT,
          chat_name: 'Family',
          sender_jid: 'jane@s.whatsapp.net',
          sender_name: 'Jane',
          from_me: false,
          timestamp: '2026-07-26T09:05:00Z',
          text: '',
          media_type: 'reaction',
        })}\n`,
    });

    const items = await drainItems(connectorFor(dir));
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['msg-1']);
    const status = readWhatsAppLiveSpoolStatus(dir);
    expect(status).toMatchObject({ reactionLines: 1, unresolvedReactionTargets: 0, malformedLines: 0 });
  });

  test('a page never grows past its limit just because it re-emits targets', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'old-1' })
        + messageLine({ id: 'old-2' })
        + messageLine({ id: 'fresh-1' })
        + reactionLine({ id: 'react-1', target: 'old-1' })
        + reactionLine({ id: 'react-2', target: 'old-2' }),
    });

    const pages: SourceConnectorListPage[] = [];
    for await (const page of connectorFor(dir).listItems({ limit: 2 })) pages.push(page);
    for (const page of pages) {
      // A page longer than the caller's limit is abandoned mid-page by the
      // store, which pins the cursor and replays the same page forever.
      expect(page.items.length).toBeLessThanOrEqual(2);
      // One item per message per page: a re-emit attaches to the page's own
      // copy of a message rather than appending a second one.
      const ids = page.items.map((item) => item.identity.providerItemId);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const seen = pages.flatMap((page) => page.items.map((item) => item.identity.providerItemId));
    expect(new Set(seen)).toEqual(new Set(['old-1', 'old-2', 'fresh-1']));
    // The reacted messages are re-emitted with their aggregate once their
    // reaction lines are reached, in a later page than their own line.
    const reEmitted = pages.flatMap((page) => page.items.filter((item) => reactionsOf(item) !== undefined));
    expect(reEmitted.map((item) => item.identity.providerItemId).sort()).toEqual(['old-1', 'old-2']);
  });

  test('fetchItem restates the reactions, so a reacted voice note keeps them through a re-fetch', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'voice-1', text: '', media_type: 'audio' })
        + reactionLine({ id: 'react-1', target: 'voice-1' }),
    });
    const fetched = await connectorFor(dir).fetchItem(`${ACCOUNT}:voice-1`);
    expect(fetched.content).toEqual({ kind: 'metadata_only' });
    expect(reactionsOf(fetched)).toEqual([
      { key: '👍', count: 1, actors: [{ providerActorId: 'jane@s.whatsapp.net', label: 'Jane' }] },
    ]);
    // A reaction is never a message: fetching the reaction's own id fails.
    await expect(connectorFor(dir).fetchItem(`${ACCOUNT}:react-1`)).rejects.toThrow(/was not found/);
  });

  test('the owner reacting is an actor like any other', async () => {
    const dir = makeSpoolDir({
      '2026-07-26.jsonl':
        messageLine({ id: 'msg-1' })
        + reactionLine({
          id: 'react-1',
          target: 'msg-1',
          sender_jid: 'owner@s.whatsapp.net',
          sender_name: 'Sam',
          from_me: true,
        }),
    });
    expect(reactionsOf((await drainItems(connectorFor(dir)))[0])).toEqual([
      { key: '👍', count: 1, actors: [{ providerActorId: 'owner@s.whatsapp.net', label: 'Sam' }] },
    ]);
  });

  test('an older connector build still reads the new reaction records as valid', () => {
    // The required-field contract as it stood before R1: a build that knows
    // nothing about reactions must not start counting these lines malformed.
    const legacyParse = (line: string): boolean => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return false;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
      return nonEmpty(record['id'])
        && nonEmpty(record['chat_jid'])
        && nonEmpty(record['timestamp'])
        && typeof record['from_me'] === 'boolean'
        && typeof record['text'] === 'string';
    };

    for (const line of [
      reactionLine({ id: 'react-1', target: 'msg-1' }),
      reactionLine({ id: 'react-2', target: 'msg-1', removed: true }),
    ]) {
      expect(legacyParse(line.trimEnd())).toBe(true);
    }
    const dir = makeSpoolDir({
      '2026-07-26.jsonl': reactionLine({ id: 'react-1', target: 'msg-1' }) + reactionLine({ id: 'react-2', target: 'msg-1', removed: true }),
    });
    expect(readWhatsAppLiveSpoolStatus(dir).malformedLines).toBe(0);
  });

  test('end to end: a reaction refreshes search and evidence while the stored chunks stay byte-identical', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'whatsapp-reactions-store-')), 'connector-store.db');
    const text = 'the falafel place on Allenby closes at four';
    const dir = makeSpoolDir({ '2026-07-26.jsonl': messageLine({ id: 'msg-1', text }) });
    const localItemId = `${ACCOUNT}:${CHAT}:msg-1`;

    interface ChunkRow {
      chunk_index: number;
      bounded_text: string;
      content_hash: string;
      embedding_input_hash: string | null;
    }
    const chunkRows = (): ChunkRow[] => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db.query(`
          SELECT c.chunk_index, c.bounded_text, c.content_hash, c.embedding_input_hash
          FROM chunks c JOIN items i ON i.item_pk = c.item_pk
          WHERE i.local_item_id = ? ORDER BY c.chunk_index
        `).all(localItemId) as ChunkRow[];
      } finally {
        db.close();
      }
    };
    const chunkContent = (rows: ChunkRow[]): Array<Omit<ChunkRow, 'embedding_input_hash'>> =>
      rows.map(({ embedding_input_hash: _ignored, ...rest }) => rest);

    let store = storeFor(dbPath);
    let cursor: string | undefined;
    try {
      const first = await store.syncFromConnector(connectorFor(dir), { fetchContent: true });
      expect(first.itemsIndexed).toBe(1);
      cursor = first.cursor;
      expect(store.itemReactions(localItemId)).toEqual([]);
    } finally {
      store.close();
    }
    const before = chunkRows();
    expect(before).toHaveLength(1);

    // The reaction arrives after the message was already drained.
    appendFileSync(join(dir, '2026-07-26.jsonl'), reactionLine({ id: 'react-1', target: 'msg-1', key: '👍' }));
    appendFileSync(join(dir, '2026-07-26.jsonl'), reactionLine({
      id: 'react-2',
      target: 'msg-1',
      key: '👍',
      sender_jid: 'cass@s.whatsapp.net',
      sender_name: 'Cass',
    }));

    store = storeFor(dbPath);
    try {
      const second = await store.syncFromConnector(connectorFor(dir), {
        ...(cursor ? { cursor } : {}),
        fetchContent: true,
      });
      expect(second.itemsSeen).toBe(1);
      expect(second.itemsIndexed).toBe(1);
      expect(second.itemsRejected).toBe(0);

      expect(store.itemReactions(localItemId)).toEqual([
        {
          key: '👍',
          count: 2,
          actors: [
            { providerActorId: 'cass@s.whatsapp.net', label: 'Cass' },
            { providerActorId: 'jane@s.whatsapp.net', label: 'Jane' },
          ],
        },
      ]);
      // The Analyst reads the reaction beside the message it confirms.
      expect(store.localContent(localItemId)?.chunks[0]).toBe('Reactions: 👍 ×2 (Cass, Jane)');
      // The message itself is still findable, and so is the reaction line.
      expect(store.searchItems('falafel', 5)).toHaveLength(1);
      expect(store.searchItems('Reactions', 5).map((row) => row.sourceItem.localItemId)).toContain(localItemId);
    } finally {
      store.close();
    }

    const after = chunkRows();
    // A reaction never rewrites what was said...
    expect(chunkContent(after)).toEqual(chunkContent(before));
    // ...but the embedding input is seasoned from the stored row, so the
    // reaction leaves the chunk due for a re-embed instead of stale.
    expect(after[0]?.embedding_input_hash).not.toBe(before[0]?.embedding_input_hash);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query('SELECT search_text FROM items WHERE local_item_id = ?').get(localItemId) as
        | { search_text: string }
        | null;
      // The reaction line seasons the item's private search context; the
      // message text itself stays in the chunks it was already indexed from.
      expect(row?.search_text).toContain('Reactions: 👍 ×2 (Cass, Jane)');
      expect(row?.search_text).not.toContain(text);
    } finally {
      db.close();
    }
  });
});
