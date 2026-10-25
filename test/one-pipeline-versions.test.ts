// Every version of an item an input brings is accepted, classified and routed on
// its own, and the version boundary the store keeps (what is stored, at which
// version) is never lost: not by a partly written item, a tombstone, a Secret,
// or a repair (contract 2.2.0, docs/design/archive-live-one-dataset.md,
// section 2). Run through the real archive import and a real tiered store set;
// synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { onePipelineHarness, FIXTURE_ACCOUNT_SCOPE, type FxRecord, type OnePipelineHarness } from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const rec = (id: string, version: number, body: string | undefined, extra: Partial<FxRecord> = {}): FxRecord => ({
  id, version, subject: `Subject ${id}`, ...(body !== undefined ? { body } : {}), ...extra,
});

/** A synthetic key header: the content policy treats the text holding one as a Secret. */
const KEY_MARKER = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';

/** The privacy-safe model has judged every item ordinary. */
const judgedOrdinary: TierSniffer = { id: 'scripted', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };

/** Every body any leg holds for the item, active or not, joined: a Secret's text must be in none. */
function everyStoredText(h: OnePipelineHarness): string {
  const found: string[] = [];
  for (const domain of ['internal', 'secure_local'] as const) {
    const db = new Database(h.storePaths[domain], { readonly: true });
    try {
      const rows = db.query(`
        SELECT c.text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?
      `).all(FIXTURE_ACCOUNT_SCOPE) as Array<{ text: string }>;
      found.push(...rows.map((row) => row.text));
    } catch {
      // A store that holds no chunk table yet holds no text.
    } finally {
      db.close();
    }
  }
  return found.join('\n');
}

describe('every accepted version is classified and routed on its own', () => {
  test('a later version of an item in the same listing is judged afresh: a Secret in v2 is never stored readable', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    // The export holds the item twice: the ordinary version, then a later one that carries a key.
    const id = await h.startImport('versions.mbox', [rec('a', 1, 'lunch plan for friday'), rec('a', 2, `lunch plan edited\n${KEY_MARKER}`)]);
    await h.importAll(id);
    expect(everyStoredText(h)).not.toContain('PRIVATE KEY');
    expect(h.textOf('a')).not.toContain('PRIVATE KEY');
    expect(h.set.ledger.itemIsSecret({ provider: 'fixture-source', accountScope: FIXTURE_ACCOUNT_SCOPE, providerItemId: 'a' })).toBe(true);
  });

  test('the two versions of an item that are both ordinary end as the later one, routed by its own verdict', async () => {
    const h = onePipelineHarness(cleanups, { sniffer: judgedOrdinary });
    h.connectLive();
    const id = await h.startImport('ordinary.mbox', [rec('a', 1, 'first words'), rec('a', 2, 'second words')]);
    await h.importAll(id);
    expect(h.textOf('a')).toBe('second words');
    expect(h.duplicates()).toEqual([]);
  });
});
