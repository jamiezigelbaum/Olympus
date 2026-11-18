#!/usr/bin/env bun
// Pins each gold item to its conversation where its provider id is not unique
// in its store (Telegram numbers messages per chat, so one id can name a
// message in many chats). The gold is the one candidate whose text holds the
// question's quote. Reads an eval copy only, never the live stores, and prints
// counts and question ids only, never text or source ids.
//
//   bun eval/fill-gold-conversations.ts --data-root <copy> --dataset <in.json> --write <out.json>
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { openEvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { passageContainsQuote } from './passage-match.ts';
import { validatePassageDataset, type EvalDataset } from './types.ts';

export type GoldResolution = 'unique' | 'resolved' | 'ambiguous' | 'no_quote_match' | 'missing';

/** Which of an id's items is the gold: the only one, or the only one whose text holds the quote. */
export function resolveGold(candidates: readonly { conversationId: string | null; text: string }[], quote: string | undefined): { resolution: GoldResolution; conversationId?: string } {
  if (candidates.length === 0) return { resolution: 'missing' };
  if (candidates.length === 1) return { resolution: 'unique' };
  const holding = quote ? candidates.filter(candidate => passageContainsQuote(candidate.text, quote)) : [];
  const conversations = [...new Set(holding.map(candidate => candidate.conversationId))];
  if (holding.length === 0) return { resolution: 'no_quote_match' };
  if (conversations.length !== 1 || conversations[0] === null) return { resolution: 'ambiguous' };
  return { resolution: 'resolved', conversationId: conversations[0]! };
}

if (import.meta.main) {
  const { isolation, rest } = parseDataRootArgs(process.argv.slice(2));
  if (!isolation) throw new Error('--data-root is required.');
  const arg = (name: string) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest[at + 1]; };
  const datasetPath = arg('--dataset'); const outPath = arg('--write');
  if (!datasetPath || !outPath) throw new Error('Usage: bun eval/fill-gold-conversations.ts --data-root <copy> --dataset <in.json> --write <out.json>');
  const dataset: unknown = JSON.parse(readFileSync(datasetPath, 'utf8'));
  validatePassageDataset(dataset);
  const opened = openEvalDataRoot(isolation);
  const dbs = new Map<string, Database>();
  const db = (corpusId: string) => {
    if (!dbs.has(corpusId)) {
      const store = opened.stores.find(candidate => candidate.corpusId === corpusId);
      if (!store) return undefined;
      const handle = new Database(store.dbPath, { readonly: true, create: false });
      handle.exec('PRAGMA query_only = ON;');
      dbs.set(corpusId, handle);
    }
    return dbs.get(corpusId);
  };
  const candidatesOf = (corpusId: string, providerItemId: string) => {
    const handle = db(corpusId);
    if (!handle) return [];
    const items = handle.query(`SELECT item_pk, provider_conversation_id FROM items WHERE provider_item_id = ? AND tombstoned = 0`).all(providerItemId) as { item_pk: number; provider_conversation_id: string | null }[];
    return items.map(item => ({
      conversationId: item.provider_conversation_id,
      text: (handle.query(`SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index`).all(item.item_pk) as { bounded_text: string }[]).map(row => row.bounded_text).join('\n'),
    }));
  };
  const counts: Record<string, Record<GoldResolution, number>> = {};
  const byResolution: Record<GoldResolution, string[]> = { unique: [], resolved: [], ambiguous: [], no_quote_match: [], missing: [] };
  const filled = (dataset as EvalDataset).questions.map(question => ({
    ...question,
    ...(question.expectedEvidence ? { expectedEvidence: question.expectedEvidence.map(expected => {
      const pin = <T extends { corpusId: string; providerItemId?: string; providerConversationId?: string }>(gold: T): T => {
        if (!gold.providerItemId) return gold;
        const { resolution, conversationId } = resolveGold(candidatesOf(gold.corpusId, gold.providerItemId), expected.quote);
        const family = gold.corpusId.split('.').slice(1, -1).join('.') || gold.corpusId;
        counts[family] ??= { unique: 0, resolved: 0, ambiguous: 0, no_quote_match: 0, missing: 0 };
        counts[family]![resolution] += 1;
        if (!byResolution[resolution].includes(question.id)) byResolution[resolution].push(question.id);
        return conversationId === undefined ? gold : { ...gold, providerConversationId: conversationId };
      };
      return { ...pin(expected), ...(expected.alternates ? { alternates: expected.alternates.map(pin) } : {}) };
    }) } : {}),
  }));
  writeFileSync(outPath, `${JSON.stringify({ ...(dataset as EvalDataset), questions: filled }, null, 2)}\n`, { mode: 0o600 });
  for (const handle of dbs.values()) handle.close();
  opened.close();
  // Counts per store kind, and question ids per outcome other than unique. No text, no source ids.
  console.log(JSON.stringify({ goldIdentities: counts }));
  for (const resolution of ['resolved', 'ambiguous', 'no_quote_match', 'missing'] as const) console.log(JSON.stringify({ resolution, questions: byResolution[resolution] }));
}
