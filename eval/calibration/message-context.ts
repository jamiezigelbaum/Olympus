// The messages around a sampled message, shown greyed out on the labeling page
// so a bare link or a short reply can be read. Context is for the owner only:
// it never reaches a judge, and the owner labels the middle message alone.

import type { Database } from 'bun:sqlite';
import type { CalibrationContextMessage } from './files.ts';

const MAX_CONTEXT_CHARS = 1_000;

export interface ContextAnchor {
  provider: string;
  account_scope: string;
  normalized_conversation: string;
  provider_item_id: string;
  authored_at: string;
}

interface Neighbour {
  provider_item_id: string;
  authored_at: string;
  sender: string;
  text: string;
}

const order = (a: Neighbour, b: Neighbour) =>
  a.authored_at.localeCompare(b.authored_at) || a.provider_item_id.localeCompare(b.provider_item_id);

function side(dbs: readonly Database[], anchor: ContextAnchor, count: number, direction: 'before' | 'after'): Neighbour[] {
  const [compare, sort] = direction === 'before' ? ['<', 'DESC'] : ['>', 'ASC'];
  const found = new Map<string, Neighbour>();
  for (const db of dbs) {
    // Each copy of a conversation holds only its own tier's messages, so every store is asked.
    const rows = db.query(
      `SELECT item_pk, provider_item_id, authored_at, sender_label, sender_id FROM items
        WHERE provider = ? AND account_scope = ? AND normalized_conversation = ? AND tombstoned = 0
          AND parent_local_item_id IS NULL AND authored_at IS NOT NULL
          AND (authored_at, provider_item_id) ${compare} (?, ?)
        ORDER BY authored_at ${sort}, provider_item_id ${sort} LIMIT ?`,
    ).all(
      anchor.provider, anchor.account_scope, anchor.normalized_conversation,
      anchor.authored_at, anchor.provider_item_id, count * 4,
    ) as Array<{ item_pk: number; provider_item_id: string; authored_at: string; sender_label: string | null; sender_id: string | null }>;
    const chunks = db.query('SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index');
    for (const row of rows) {
      const parts = chunks.all(row.item_pk) as Array<{ bounded_text: string }>;
      const text = parts.map((part) => part.bounded_text).join('\n').trim();
      if (!text || found.has(row.provider_item_id)) continue;
      found.set(row.provider_item_id, {
        provider_item_id: row.provider_item_id,
        authored_at: row.authored_at,
        sender: row.sender_label ?? row.sender_id ?? '',
        text: text.slice(0, MAX_CONTEXT_CHARS),
      });
    }
  }
  const sorted = [...found.values()].sort(order);
  return direction === 'before' ? sorted.slice(-count) : sorted.slice(0, count);
}

/** Up to `count` messages on each side of `anchor`, oldest first, across every store. */
export function messageContext(dbs: readonly Database[], anchor: ContextAnchor, count: number) {
  const shape = (message: Neighbour): CalibrationContextMessage => ({
    at: message.authored_at,
    sender: message.sender,
    text: message.text,
  });
  return {
    before: side(dbs, anchor, count, 'before').map(shape),
    after: side(dbs, anchor, count, 'after').map(shape),
  };
}
