import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { count, closeStores, pickLongItems, unseenWindows, WINDOW } from './long-item-selection.ts';
import { batchTimes, releaseCounts } from './release-proof.ts';
import type { ReleaseInput } from '../../src/core/release-manifest.ts';

let dir: string | undefined;
afterEach(() => { closeStores(); if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

test('population matches raw AND normalized conversations and the long read Personal predicate', () => {
  dir = mkdtempSync(join(tmpdir(), 'release-proof-'));
  const ledger = new Database(join(dir, 'secure_local.tier-ledger.sqlite'));
  const db = new Database(join(dir, 'internal.sqlite'));
  try {
    ledger.run('PRAGMA synchronous=OFF'); db.run('PRAGMA synchronous=OFF');
    ledger.run('CREATE TABLE tier_items(provider, account_scope, conversation_key, provider_item_id, content_tier, state, content_read)');
    db.run('CREATE TABLE items(item_pk, provider, account_scope, provider_conversation_id, normalized_conversation, provider_item_id, tombstoned)');
    db.run('CREATE TABLE chunks(item_pk, chunk_index, bounded_text, content_hash)');
    const cases = [
      ['RAW', 'private', 'current', 1, WINDOW + 1, 0],
      ['normalized', 'private', 'current', 1, WINDOW + 1, 0],
      ['RAW', 'private', 'moving', 1, WINDOW + 1, 0],
      ['RAW', 'private', 'current', 0, WINDOW + 1, 0],
      ['RAW', 'private', 'current', 1, WINDOW, 0],
      ['RAW', 'secure', 'current', 1, WINDOW + 1, 0],
      ['RAW', 'private', 'current', 1, WINDOW + 1, 1],
    ] as const;
    ledger.run('BEGIN'); db.run('BEGIN');
    cases.forEach(([conversation, tier, state, read, size, tombstone], i) => {
      ledger.query('INSERT INTO tier_items VALUES(?,?,?,?,?,?,?)').run('fixture', 'scope', conversation, String(i), tier, state, read);
      db.query('INSERT INTO items VALUES(?,?,?,?,?,?,?)').run(i, 'fixture', 'scope', 'RAW', 'normalized', String(i), tombstone);
      db.query('INSERT INTO chunks VALUES(?,?,?,?)').run(i, 0, 'a'.repeat(size), String(i));
    });
    db.run('COMMIT'); ledger.run('COMMIT');
  } finally { ledger.close(); db.close(); }
  const selected = count(dir).long;
  expect(selected.map(item => item.pk)).toEqual([0, 1]);
  expect(selected.map(item => item.identity.providerConversationId)).toEqual(['RAW', 'normalized']);
  // Exact scope is part of the key; a matching id in another account never joins.
  closeStores();
  const update = new Database(join(dir, 'internal.sqlite'));
  update.run('PRAGMA synchronous=OFF');
  update.run("UPDATE items SET account_scope = 'other'"); update.close();
  expect(count(dir).long).toHaveLength(0);
});

test('seed-1 sampling is deterministic, bounded to 200, and leaves population order intact', () => {
  const population = Array.from({ length: 300 }, (_, i) => i);
  const sample = pickLongItems(population);
  expect(sample).toHaveLength(200);
  expect(new Set(sample).size).toBe(200);
  expect(sample).toEqual(pickLongItems(population, 200, 1));
  expect(sample).not.toEqual(pickLongItems(population, 200, 2));
  expect(population).toEqual(Array.from({ length: 300 }, (_, i) => i));
});

test('truth maps a straddling window to both chunk hashes and caps at 25 unseen windows', () => {
  const parts = [{ bounded_text: 'a'.repeat(WINDOW + 100), content_hash: 'first' }, { bounded_text: 'b'.repeat(WINDOW * 30), content_hash: 'second' }];
  const windows = unseenWindows(parts);
  expect(windows).toHaveLength(25);
  expect(windows[0]).toEqual({ text: 'a'.repeat(100) + '\n' + 'b'.repeat(WINDOW - 101), chunkHashes: ['first', 'second'] });
  expect(windows[1]!.chunkHashes).toEqual(['second']);
  expect(unseenWindows([{ bounded_text: 'a'.repeat(WINDOW), content_hash: 'short' }])).toEqual([]);
});

test('counts leakage of a Private chunk and any earlier chunk of its raised item separately', () => {
  const inputs: ReleaseInput[] = [{ corpusId: 'fixture', provider: 'fixture', accountScope: 'scope', providerItemId: 'item', privateAtAnswer: false, chunkHashes: ['opening', 'late', 'late'] }];
  const truth = [new Set(['late'])];
  expect(releaseCounts(inputs, truth, { allowed: [['opening']], withheldPassages: 1, withheldDocuments: 1 })).toEqual({ chunksAllowed: 1, chunksHeld: 1, heldPassages: 1, privateChunksAllowed: 0, itemsWithPrivateWindowAnyAllowed: 1 });
  expect(releaseCounts(inputs, truth, { allowed: [['late']], withheldPassages: 1, withheldDocuments: 1 }).privateChunksAllowed).toBe(1);
  expect(releaseCounts(inputs, truth, { allowed: [[]], withheldPassages: 2, withheldDocuments: 1 }).itemsWithPrivateWindowAnyAllowed).toBe(0);
  expect(() => releaseCounts(inputs, truth, { allowed: [], withheldPassages: 0, withheldDocuments: 0 })).toThrow();
  expect(() => releaseCounts(inputs, truth, { allowed: [['unknown']], withheldPassages: 1, withheldDocuments: 1 })).toThrow();
  expect(batchTimes([8, 1, 4])).toEqual({ firstBatchMs: 8, perBatchMs: [8, 1, 4], medianMs: 4, p90Ms: 8, maxMs: 8 });
});
