// #599: a legacy record's trust domain never outranks content or an owner rule.
import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TierSniffer, OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import { TIER_CLASSIFIER_VERSION } from '../src/workers/classification/tier-classifier.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTelegramCaptureSpoolConnector, createTelegramConnectorStoreSyncHandler,
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID } from '../src/workers/telegram-messages/index.ts';
import { liveSpoolLine } from './support/telegram-spool-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const identity = { provider: 'telegram', accountScope: 'telegram.personal', providerConversationId: 'tiago', providerItemId: '8' };
const localId = 'telegram.personal:tiago:8';
const personal: TierSniffer = { id: 'personal-content', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }) };

function fixture(rules: OwnerTierRule[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-599-'));
  const spoolDir = join(dir, 'spool'); mkdirSync(spoolDir);
  const path = join(spoolDir, '2026-10-28.jsonl');
  writeFileSync(path, liveSpoolLine({ chat: 'tiago', id: '8', text: 'Duque is the name of the café.',
    chatTitle: 'Tiago', sentAt: '2026-10-28T09:00:00Z', trust: 'secure_local' }));
  const internal = new LocalConnectorStore({ dbPath: join(dir, 'internal.sqlite'), corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'internal' });
  const secureLocal = new LocalConnectorStore({ dbPath: join(dir, 'secure.sqlite'), corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const classification = { sniffer: personal, rules };
  const set = createLaneTieredStoreSet({ setId: 'telegram.messages', internalStore: internal, secureStore: secureLocal, splitLayers: false, tierClassification: classification });
  const handler = createTelegramConnectorStoreSyncHandler({ stores: { internal, secureLocal }, spoolDir, tierSet: set });
  cleanup.push(() => { internal.close(); secureLocal.close(); set.ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return { set, handler, internal, secureLocal, path, spoolDir, classification };
}

for (const ownerRule of [false, true]) test(`a Personal-judged legacy secure record survives re-judge and replay (owner chat rule=${ownerRule})`, async () => {
  const f = fixture(ownerRule ? [{ id: 'owner.tiago', match: { kind: 'chat', value: 'tiago' }, tier: 'secure', strength: 'prior' }] : []);
  const expected = ownerRule ? 'secure' : 'private';
  await f.handler.pull();
  expect(f.set.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: expected, contentTier: expected });
  expect(f.set.ledger.getCurrent(identity)!.reasons.some(reason => reason.startsWith('metadata:prior:'))).toBe(false);
  // Change the model identity so a real automatic re-judge is due.
  f.classification.sniffer = { ...personal, id: 'personal-content-next' };
  const report = rejudgeRoutedItems({ set: f.set, autoMoves: true }).report;
  expect(report).toMatchObject({ seen: ownerRule ? 0 : 1, failed: 0, movesQueued: 0 });
  expect(f.set.ledger.getCurrent(identity)!.contentTier).toBe(expected);
  // Replay from the beginning, with no stored-item filter, as a rebuilt spool does.
  const connector = createTelegramCaptureSpoolConnector({ spoolDir: f.spoolDir, trustDomain: 'secure_local' });
  await f.set.sync(connector, { fetchContent: true, placement: { trustTier: 'S3', trustDomain: 'internal' } });
  expect(f.set.ledger.getCurrent(identity)!.contentTier).toBe(expected);
  const serving = ownerRule ? f.secureLocal : f.internal;
  const other = ownerRule ? f.internal : f.secureLocal;
  expect(serving.localContent(localId)?.chunks.join(' ')).toContain('Duque');
  expect(other.localContent(localId)).toBeUndefined();
  expect(f.set.ledger.rejudgeCandidatePage({ engineVersion: TIER_CLASSIFIER_VERSION, snifferId: 'personal-content-next' }).records).toEqual([]);
});

test('the newest content wins across historical domains in one spool window', async () => {
  const f = fixture();
  appendFileSync(f.path, liveSpoolLine({ chat: 'tiago', id: '8', text: 'Duque now opens at seven.',
    chatTitle: 'Tiago', sentAt: '2026-10-28T09:00:00Z', editedAt: '2026-10-29T09:00:00Z', trust: 'internal' }, '2026-10-29T10:00:00Z'));
  await f.handler.pull();
  expect(f.internal.localContent(localId)?.chunks.join(' ')).toBe('Duque now opens at seven.');
  expect(f.secureLocal.localContent(localId)).toBeUndefined();
});
