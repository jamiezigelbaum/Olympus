import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TierLedger, RETIRED_EMBEDDING_CLEARANCE_REASON, type TierLedgerIdentity } from '../src/workers/classification/tier-ledger.ts';
import { classifyItemTiers, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { retiredEmbeddingPrefilterPaths } from '../src/workers/classification/tier-ledger-path.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { rejudgeStoredContent, emptyTierRejudgeReport } from '../src/workers/connector-store/tier-rejudge.ts';
import { fixtureConnector, FIXTURE_PLACEMENT, identityOf, openTierFixture } from './helpers/tier-fixtures.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const subject = (id: string): TierLedgerIdentity => ({ provider: 'fixture', accountScope: 'personal', providerItemId: id });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-retired-prefilter-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'items.tier-ledger.sqlite');
  const ledger = new TierLedger({ dbPath: path });
  const decision = (changes: Partial<TierDecision> = {}): TierDecision => ({
    ...classifyItemTiers({ signals: { title: 'Garden' }, text: 'Garden notes' }),
    metadataTier: 'private', contentTier: 'private', state: 'current', contentPending: false,
    reasons: ['content:embedding_prefilter:old-model:0.001'], ...changes,
  });
  return { dir, path, ledger, decision };
}
function oldSchema(path: string) {
  const db = new Database(path);
  try { db.query("UPDATE schema_version SET version = 13 WHERE store_id = 'olympus_tier_ledger'").run(); }
  finally { db.close(); }
}

test('upgrade requeues only current clearance reasons once, retaining every tier and fencing a lowering', async () => {
  const f = fixture();
  for (const tier of ['public', 'private', 'secure', 'secrets'] as const) {
    f.ledger.recordDecision(subject(tier), f.decision({ contentTier: tier, metadataTier: tier }));
  }
  f.ledger.recordRoutedPlacement(subject('moving'), f.decision({ contentTier: 'secure' }), {
    copies: [{ corpusId: 'secure.fixture', trustDomain: 'secure_local', layers: 'both' }], embedHold: false,
  });
  const destination = [{ corpusId: 'personal.fixture', trustDomain: 'internal' as const, layers: 'both' as const }];
  const moving = f.ledger.stageMove(subject('moving'), { expectedGeneration: 1,
    target: { metadataTier: 'private', contentTier: 'private' }, destination, hideSource: false });
  f.ledger.recordDecision(subject('history-only'), f.decision());
  f.ledger.recordDecision(subject('history-only'), f.decision({ reasons: ['content:sniffer:real-judge:ordinary:1.00'] }));
  const unchanged = f.ledger.getCurrent(subject('history-only'));
  f.ledger.writeMeta('embedding-prefilter:training-scan-v1', 'obsolete');
  f.ledger.close(); oldSchema(f.path);
  let ledger = new TierLedger({ dbPath: f.path });
  for (const tier of ['public', 'private', 'secure', 'secrets'] as const) {
    expect(ledger.getCurrent(subject(tier))).toMatchObject({
      state: 'pending', metadataTier: tier, contentTier: tier, contentPending: true, metadataPending: false,
    });
  }
  expect(ledger.getCurrent(subject('history-only'))).toEqual(unchanged);
  expect(ledger.getCurrent(subject('moving'))).toMatchObject({ state: 'pending', contentTier: 'secure',
    contentPending: true, generation: moving.generation + 1, targetContentTier: null });
  expect(() => ledger.completeMove(subject('moving'), { expectedGeneration: moving.generation, destination })).toThrow();
  expect(ledger.copies(subject('moving'))).toEqual(expect.arrayContaining([
    expect.objectContaining({ corpusId: 'secure.fixture', state: 'current' }),
    expect.objectContaining({ corpusId: 'personal.fixture', state: 'superseded' }),
  ]));
  expect(ledger.readMeta('embedding-prefilter:training-scan-v1')).toBeUndefined();
  const pending = ledger.getCurrent(subject('private'));
  ledger.close(); ledger = new TierLedger({ dbPath: f.path });
  expect(ledger.getCurrent(subject('private'))).toEqual(pending);
  // The ordinary resolver dispatches the reopened question and settles it.
  const sniffer = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    sniffer.enqueue({ subject: subject('private'), pass: 'content', material: 'Garden notes',
      mapRevision: pending!.mapRevision, flags: [] });
    const report = await runSnifferPass({ targets: [{ ledger, sniffer }], lane: BUILT_IN_SNIFFER_LANE,
      model: { async complete() { return { text: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal',
        ownRecord: false, privateKind: 'none', category: 'ordinary', confidence: 1 }] }), modelId: BUILT_IN_SNIFFER_LANE.modelId }; } } });
    expect(report.calls).toBe(1);
    expect(ledger.getCurrent(subject('private'))).toMatchObject({ state: 'current', contentPending: false, contentTier: 'private' });
    ledger.close(); ledger = new TierLedger({ dbPath: f.path });
    expect(ledger.getCurrent(subject('private'))?.contentPending).toBe(false);
  } finally { sniffer.close(); ledger.close(); }
});

test('worker removes both retired model locations and SQLite sidecars once after the requeue, even without a model', async () => {
  const f = fixture();
  f.ledger.recordDecision(subject('cleared'), f.decision());
  f.ledger.close(); oldSchema(f.path);
  const classificationLedgerPath = join(f.dir, 'classification.jsonl');
  const retired = [f.path, classificationLedgerPath].map(retiredEmbeddingPrefilterPaths);
  for (const paths of retired) {
    for (const directory of paths.directories) {
      mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'weights.json'), 'old weights');
    }
    for (const suffix of ['', '-wal', '-shm']) writeFileSync(`${paths.ledger}${suffix}`, 'old state');
  }
  const installed = new InstalledTierClassification({ env: {} });
  const service = new TierSnifferService({ installed, classificationLedgerPath, lane: BUILT_IN_SNIFFER_LANE,
    stores: () => [{ dbPath: join(f.dir, 'items.sqlite') }], modelAvailable: () => false,
    model: { async complete() { throw new Error('Unavailable'); } } });
  try {
    expect((await service.runOnce()).state).toBe('model_unavailable');
    const migrated = new TierLedger({ dbPath: f.path });
    try { expect(migrated.getCurrent(subject('cleared'))).toMatchObject({ state: 'pending', contentTier: 'private', contentPending: true }); }
    finally { migrated.close(); }
    for (const paths of retired) {
      for (const path of [...paths.directories, ...['', '-wal', '-shm'].map(suffix => `${paths.ledger}${suffix}`)]) {
        expect(existsSync(path)).toBe(false);
      }
    }
    // Startup cleanup is not a recurring filesystem sweep.
    mkdirSync(retired[0]!.directories[0]!);
    await service.runOnce();
    expect(existsSync(retired[0]!.directories[0]!)).toBe(true);
  } finally { service.stop(); installed.close(); }
});

for (const contentTier of ['private', 'secure'] as const) test(`rebuilding a missing question keeps migrated ${contentTier} until its judge answers`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-retired-question-'));
  const f = openTierFixture(dir, { embed: false });
  try {
    await f.set.sync(fixtureConnector(() => [{ id: 'held', name: 'Garden', text: 'Garden notes' }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const identity = identityOf('held');
    const current = f.ledger.getCurrent(identity)!;
    f.ledger.recordRoutedPlacement(identity, {
      ...classifyItemTiers({ signals: { title: 'Garden' }, text: 'Garden notes' }),
      metadataTier: current.metadataTier, contentTier, reasons: [...current.reasons, RETIRED_EMBEDDING_CLEARANCE_REASON],
      contentPending: true, state: 'pending', snifferId: 'test-judge',
    }, { copies: f.ledger.copies(identity), embedHold: false });
    const row = f.ledger.getCurrent(identity)!;
    expect(row).toMatchObject({ contentTier, contentPending: true });
    const report = emptyTierRejudgeReport();
    let asked = 0;
    rejudgeStoredContent(f.set, row, { autoMoves: true, report,
      sniffer: { id: 'test-judge', judge() { asked++; return { verdict: 'undecided', code: 'undecided', queued: true }; } } });
    expect(asked).toBeGreaterThan(0);
    expect(report.asked).toBe(1);
    expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'pending', contentTier, contentPending: true });
    expect(f.ledger.getCurrent(identity)?.reasons).toContain(RETIRED_EMBEDDING_CLEARANCE_REASON);
    expect(f.ledger.listMoving()).toHaveLength(0);
  } finally { f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('upgrade holds the current copy of a requeued clearance until the judge answers (#1318)', () => {
  const f = fixture();
  const copy = { corpusId: 'personal.fixture', trustDomain: 'internal' as const, layers: 'both' as const };
  f.ledger.recordRoutedPlacement(subject('cleared'), f.decision(), { copies: [copy], embedHold: false });
  f.ledger.recordRoutedPlacement(subject('judged'), f.decision({ reasons: ['content:sniffer:real-judge:ordinary:1.00'] }),
    { copies: [copy], embedHold: false });
  expect(f.ledger.copies(subject('cleared'))).toEqual([expect.objectContaining({ state: 'current', embedHold: false })]);
  f.ledger.close(); oldSchema(f.path);
  const ledger = new TierLedger({ dbPath: f.path });
  try {
    expect(ledger.getCurrent(subject('cleared'))).toMatchObject({ state: 'pending', contentTier: 'private', contentPending: true });
    expect(ledger.copies(subject('cleared'))).toEqual([expect.objectContaining({ corpusId: 'personal.fixture', state: 'current', embedHold: true })]);
    // A judge-decided item keeps its released copy.
    expect(ledger.copies(subject('judged'))).toEqual([expect.objectContaining({ state: 'current', embedHold: false })]);
  } finally { ledger.close(); }
});
