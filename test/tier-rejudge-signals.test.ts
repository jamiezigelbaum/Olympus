import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { classifyItemTiers, tierSnifferInputHash, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent, settleRoutedSecrets } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, localId, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const identity = identityOf('record');
const text = 'Ordinary orchard notes.';

async function storedPrivate() {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  await f.set.sync(fixtureConnector(() => [{ id: 'record', name: 'Notes', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const,
    reasons: ['metadata:sniffer:old-prompt:private', 'content:no_raise'],
  };
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  return f;
}

test('rejudging includes stored folder keys in the metadata question and its cache key', async () => {
  const f = await storedPrivate();
  const db = new Database(f.paths.secure_local);
  db.query('UPDATE items SET source_scope_folder_keys_json = ?').run(JSON.stringify(['Medical records']));
  db.close();
  const requests: TierSnifferRequest[] = [];
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(),
    sniffer: { id: 'new-prompt', judge(request) { requests.push(request); return { verdict: 'decided', tier: 'private', code: 'ordinary' }; } },
  });
  const question = requests.find(request => request.pass === 'metadata')!;
  expect(question.material).toContain('Medical records');
  expect(question.materialHash).toBe(tierSnifferInputHash('metadata', { title: 'Notes', path: '/Files/Notes', folderKeys: ['Medical records'] }));
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
});

test('a Personal answer cannot lower an old names verdict when labels were not stored; a relist can reassess it', async () => {
  const f = await storedPrivate();
  rejudgeStoredContent(f.set, f.ledger.getCurrent(identity)!, { autoMoves: true, report: emptyTierRejudgeReport(),
    sniffer: { id: 'new-prompt', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) },
  });
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
  await f.set.sync(fixtureConnector(() => [{ id: 'record', name: 'Notes', text, version: 'v2' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'private', contentTier: 'private' } });
  expect(f.stores.internal!.localContent(localId('record'))?.chunks.join('')).toBe(text);
});

for (const locator of [
  'ftp://reader:synthetic-password@example.test/report',
  'ftp://example.test/report?access_token=synthetic-url-credential',
  'https://reader:synthetic-password@example.test/report',
  "https://reader:p'ass@example.test/report",
  'https://reader:p ass@example.test/report',
  'https://example.test/report?access_token=synthetic-url-credential',
  'https://example.test/report',
]) test(`shared Secrets settlement filters locator ${locator}`, async () => {
  const f = await storedPrivate();
  const stored = f.stores.secure_local!.exportItemCopy(identity)!;
  const exported = { ...stored, columns: { ...stored.columns, locator_uri: locator } };
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text }), contentTier: 'secrets' as const };
  expect(settleRoutedSecrets(f.set, identity, decision, exported, { findingKinds: ['sniffer_secret_refusal'] })).toBe(true);
  expect(f.secrets.get(identity)?.locator).toBe(locator === 'https://example.test/report' ? locator : null);
  expect(f.ledger.copies(identity)).toEqual([]);
  expect(f.stores.secure_local!.exportItemCopy(identity)).toBeUndefined();
  expect(f.stores.internal!.localContent(localId('record'))).toBeUndefined();
});
