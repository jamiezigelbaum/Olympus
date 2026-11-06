import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { messageContext } from './message-context.ts';

function store(rows: Array<[pk: number, id: string, at: string, text: string, tombstoned?: number, chat?: string]>) {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE items (item_pk INTEGER, provider TEXT, account_scope TEXT, normalized_conversation TEXT,
    provider_item_id TEXT, authored_at TEXT, sender_label TEXT, sender_id TEXT, tombstoned INTEGER, parent_local_item_id TEXT)`);
  db.run('CREATE TABLE chunks (item_pk INTEGER, chunk_index INTEGER, bounded_text TEXT)');
  for (const [pk, id, at, text, tombstoned = 0, chat = 'c'] of rows) {
    db.run('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)', [pk, 'tg', 'a', chat, id, at, 'Ann', null, tombstoned]);
    if (text) db.run('INSERT INTO chunks VALUES (?, 0, ?)', [pk, text]);
  }
  return db;
}

const anchor = { provider: 'tg', account_scope: 'a', normalized_conversation: 'c', provider_item_id: 'm5', authored_at: '2026-01-05' };
const texts = (messages: Array<{ text: string }>) => messages.map((message) => message.text);

describe('messageContext', () => {
  test('takes the nearest messages on each side, oldest first, across both tier stores', () => {
    const personal = store([[1, 'm1', '2026-01-01', 'one'], [3, 'm3', '2026-01-03', 'three'], [6, 'm6', '2026-01-06', 'six']]);
    const secure = store([[2, 'm2', '2026-01-02', 'two'], [4, 'm4', '2026-01-04', 'four'], [7, 'm7', '2026-01-07', 'seven'], [8, 'm8', '2026-01-08', 'eight']]);
    const context = messageContext([secure, personal], anchor, 2);
    expect(texts(context.before)).toEqual(['three', 'four']);
    expect(texts(context.after)).toEqual(['six', 'seven']);
  });

  test('leaves out the item itself, deleted, empty and other-chat messages', () => {
    const db = store([
      [1, 'm1', '2026-01-01', 'kept'],
      [2, 'm2', '2026-01-02', 'deleted', 1],
      [3, 'm3', '2026-01-03', ''],
      [4, 'm4', '2026-01-04', 'other chat', 0, 'elsewhere'],
      [5, 'm5', '2026-01-05', 'the item'],
    ]);
    const context = messageContext([db], anchor, 2);
    expect(texts(context.before)).toEqual(['kept']);
    expect(context.after).toEqual([]);
  });

  test('orders messages sent in the same instant by id and counts a copy in two stores once', () => {
    const first = store([[1, 'm4', '2026-01-05', 'same instant before'], [2, 'm6', '2026-01-05', 'same instant after']]);
    const second = store([[1, 'm4', '2026-01-05', 'same instant before']]);
    const context = messageContext([first, second], anchor, 2);
    expect(texts(context.before)).toEqual(['same instant before']);
    expect(texts(context.after)).toEqual(['same instant after']);
  });
});
