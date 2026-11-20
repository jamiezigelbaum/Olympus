import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import { signalTexts } from '../src/core/classification-signals.ts';
import type { SourceConnector, RawItem } from '../src/core/contracts.ts';
import { MEDIA_CACHE_DIR_ENV, mediaCacheDir, releaseMediaCacheFile, writeMediaCacheFile } from '../src/core/media-cache.ts';
import type { LabelProofByProvider } from '../src/core/source-connector-labels.ts';
import { parseReflectNote } from '../src/workers/archive-import/reflect/parse.ts';
import { noteClassificationSignals } from '../src/workers/archive-import/notes/note.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import {
  clearInstalledTierClassification, configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { storedPersonalLoweringLap, TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import {
  classifyItemTiers, contentDigestReason, IMAGE_ORDINARY_REASON, IMAGE_TEXT_DECIDES_REASON_PREFIX,
  OWNER_OVERRIDE_SECRET_CONFIRMED_REASON, splitParentContext, type OwnerTierRule,
  type PersonalContentAuthorityEntry, type TierDecision, type TierSniffer, type TierSnifferRequest,
} from '../src/workers/classification/tier-classifier.ts';
import { TierLedgerGenerationConflictError, tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { writeOwnerTierRules } from '../src/workers/classification/tier-rules.ts';
import { recoverStoredLabelPage } from '../src/workers/connector-store/tier-label-observations.ts';
import { applyMediaJudgments } from '../src/workers/connector-store/tier-media-judgment-sweep.ts';
import type { MoveRuleAuthorityEntry } from '../src/workers/connector-store/tier-move-rule-policy.ts';
import { moveTieredItem, resumeVerifiedTierMove } from '../src/workers/connector-store/tier-move.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent } from '../src/workers/connector-store/tier-rejudge.ts';
import { sweepLabelRuleRaises } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { IMAGE_MEDIA_DESCRIPTOR } from '../src/workers/file-extraction/extractors/text.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { gmailClassificationSignals } from '../src/workers/google-connectors/gmail-mail-record.ts';
import type { SourceEmbeddingImageInput } from '../src/workers/source-index/embeddings.ts';
import { MEDIA_JUDGE_PROMPTS } from '../src/workers/source-index/media-judge.ts';
import { telegramClassificationSignals } from '../src/workers/telegram-messages/record-builder.ts';
import { childProviderItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import {
  CORPORA, FIXTURE_PLACEMENT, JUDGED_PERSONAL_SNIFFER, RecordingProvider, fixtureItem, identityOf,
  openTierFixture, tempDir,
} from './helpers/tier-fixtures.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';
import { childItemsExtraction } from './support/child-items-extraction-harness.ts';

describe('Rule authority for lowerings', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    clearInstalledTierClassification();
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  const body = 'Bring apples and pears to the orchard picnic beside the old mill.';
  const personal = { metadataTier: 'private', contentTier: 'private' } as const;
  const label = 'Orchard notes';
  const labelRule = {
    id: 'orchard-label', match: { kind: 'label', value: 'orchard notes' }, tier: 'secure', strength: 'force',
  } as const;

  function authorityLane(withQueue = false) {
    const tmp = tempDir('olympus-personal-rule-authority-');
    const path = join(tmp.dir, 'tier-rules.json');
    const env = { OLYMPUS_TIER_RULES_PATH: path };
    const installed = configureInstalledTierClassification({ env, ...(withQueue ? { lane: modelLane } : {}) });
    const lane = openTierFixture(tmp.dir, { embed: false });
    cleanups.push(() => { lane.close(); tmp.cleanup(); });
    return { ...lane, installed, path, env, saveRules: (rules: readonly OwnerTierRule[]) => writeOwnerTierRules([...rules], { env }) };
  }

  type AuthorityLane = ReturnType<typeof authorityLane>;

  function sourceItem(provider: string, id: string, metadata: RawItem['metadata'] = {}): RawItem {
    const item = fixtureItem({ id, name: 'Picnic', text: body });
    return {
      ...item,
      identity: { ...item.identity, provider },
      metadata: { ...item.metadata, ...metadata },
    };
  }

  async function syncHeld(
    lane: AuthorityLane,
    items: readonly RawItem[],
    classificationSignals: SourceConnector['classificationSignals'] = () => ({ title: 'Picnic' }),
  ) {
    const connector: SourceConnector = {
      id: 'authority-fixture',
      family: 'file',
      async authenticate() {},
      async *listItems() { yield { items, done: true }; },
      async fetchItem(id) {
        const item = items.find(entry => entry.identity.localItemId === id);
        if (!item) throw new Error('Unknown fixture item');
        return item;
      },
      classificationSignals,
    };
    lane.set.readCurrentLabels = async identity => {
      const item = items.find(entry => entry.identity.localItemId === identity.localItemId);
      return item && (classificationSignals(item).labels ?? []);
    };
    await lane.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
    for (const { identity } of items) {
      expect(lane.ledger.getCurrent(identity)).toMatchObject({ contentRead: true, contentPending: true });
      expect(bodyIn(lane, 'secure_local', identity)).toBe(body);
    }
  }

  function settlePersonal(lane: AuthorityLane, identity: RawItem['identity']) {
    const applied = lane.ledger.applySnifferVerdict(identity, {
      pass: 'content', tier: 'private', reason: 'ordinary', modelId: 'fixture-judge', contentDigest: contentDigestReason(body),
    }, { placementFor: decision => lane.set.placementFor(decision) });
    expect(applied?.outcome).toBe('queued_move');
  }

  function lower(lane: AuthorityLane, identity: RawItem['identity']) {
    return moveTieredItem({ set: lane.set, identity, target: personal });
  }

  function bodyIn(lane: AuthorityLane, domain: 'internal' | 'secure_local' | 'public_safe', identity: RawItem['identity']) {
    return lane.stores[domain]?.localContent(identity.localItemId)?.chunks.join('') ?? '';
  }

  function expectHeld(lane: AuthorityLane, identity: RawItem['identity']) {
    expect(bodyIn(lane, 'internal', identity)).toBe('');
    expect(bodyIn(lane, 'secure_local', identity)).toBe(body);
  }

  test('Reflect retains a protected tag after the first hundred', async () => {
    const lane = authorityLane();
    const tags = [...Array.from({ length: 100 }, (_, i) => `tag-${i}`), label];
    const parsed = parseReflectNote({ content: body, tags });
    if (parsed.kind !== 'note') throw new Error('Expected a note');
    const note = sourceItem('reflect', 'many-tags', { tags: parsed.note.tags });
    await syncHeld(lane, [note], noteClassificationSignals);
    settlePersonal(lane, note.identity);
    lane.saveRules([labelRule]);
    await expect(lower(lane, note.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    expectHeld(lane, note.identity);
  });

  test('a pending Readwise lowering cannot use a listing from before the decision and rule', async () => {
    const lane = authorityLane();
    const item = sourceItem('readwise', 'changed-on-server', { tags: [] });
    await syncHeld(lane, [item], noteClassificationSignals);
    settlePersonal(lane, item.identity);
    lane.saveRules([labelRule]);
    lane.set.readCurrentLabels = async () => [label];
    await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    expectHeld(lane, item.identity);
  });

  test('a legacy case-folded note prefix is held and counted until relisted', async () => {
    const lane = authorityLane(true);
    const folded = 'orchardnotes';
    const prefix = Array.from({ length: 100 }, (_, i) => [...folded]
      .map((c, bit) => (i & (1 << bit)) ? c.toUpperCase() : c).join(''));
    const item = sourceItem('reflect', 'legacy-prefix', { tags: prefix });
    const complete = sourceItem('reflect', 'short-legacy-note', { tags: ['Other'] });
    await syncHeld(lane, [item, complete], noteClassificationSignals);
    for (const store of lane.set.openStores()) {
      using db = new Database(store.dbPath);
      db.query('UPDATE items SET classification_labels_json = ? WHERE provider_item_id = ?')
        .run(JSON.stringify([folded]), item.identity.providerItemId);
      db.query('UPDATE items SET classification_labels_json = ? WHERE provider_item_id = ?')
        .run(JSON.stringify(['other']), complete.identity.providerItemId);
    }
    settlePersonal(lane, item.identity);
    settlePersonal(lane, complete.identity);
    lane.saveRules([labelRule]);
    await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    const queue = lane.installed.snifferStoreForLedger(lane.ledger.dbPath);
    for (const _store of lane.set.openStores()) await recoverStoredLabelPage(lane.set, queue, () => undefined);
    expect(await lower(lane, complete.identity)).toMatchObject({ outcome: 'moved' });
    expect(lane.ledger.unavailableLabelCount()).toBe(1);
  });

  test('a provider answer cannot cross a rule revision or authorize a resumed move', async () => {
    const lane = authorityLane();
    const item = sourceItem('readwise', 'changed-during-read', { tags: [] });
    await syncHeld(lane, [item], noteClassificationSignals);
    settlePersonal(lane, item.identity);
    lane.saveRules([labelRule]);
    lane.set.readCurrentLabels = async () => {
      lane.saveRules([{ ...labelRule, id: 'revised' }]);
      return [];
    };
    await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    lane.set.readCurrentLabels = async () => [];
    await verifyPersonalMove(lane, item.identity);
    lane.set.readCurrentLabels = async () => [label];
    expect(resumeVerifiedTierMove(lane.set, item.identity)).toBe(false);
    await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    expectHeld(lane, item.identity);
  });

  test('a global label rule lets Dropbox repair a stored Personal verdict', async () => {
    const lane = authorityLane();
    const item = sourceItem('dropbox', 'outside');
    await syncHeld(lane, [item]);
    lane.ledger.recordDecision(item.identity, classifyItemTiers({ signals: { title: 'Picnic' }, text: body },
      { sniffer: JUDGED_PERSONAL_SNIFFER }));
    lane.saveRules([labelRule]);
    expect(await storedPersonalLoweringLap(lane.set, undefined, () => undefined)).toMatchObject({ complete: true, changed: true });
    expect(await lower(lane, item.identity)).toMatchObject({ outcome: 'moved' });
  });

  test('a bodyless listing replaces an unknown label observation with its explicit set', async () => {
    const lane = authorityLane();
    const item = sourceItem('reflect', 'old-row', { tags: [label] });
    await syncHeld(lane, [item], noteClassificationSignals);
    for (const store of lane.set.openStores()) {
      using db = new Database(store.dbPath);
      db.run('UPDATE items SET classification_labels_json = NULL');
    }
    const listed = { ...item, content: { kind: 'metadata_only' as const }, metadata: { ...item.metadata, tags: [] } };
    await lane.set.sync({ id: 'authority-fixture', family: 'file', async authenticate() {},
      async *listItems() { yield { items: [listed], done: true }; }, async fetchItem() { return listed; },
      classificationSignals: noteClassificationSignals }, { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
    settlePersonal(lane, item.identity);
    lane.saveRules([labelRule]);
    expect(await lower(lane, item.identity)).toMatchObject({ outcome: 'moved' });
  });

  type LabelCases = {
    [Provider in keyof LabelProofByProvider]:
      LabelProofByProvider[Provider] extends 'stored'
        ? { metadata: RawItem['metadata']; signals: SourceConnector['classificationSignals'] }
        : LabelProofByProvider[Provider] extends 'provider_walk' ? () => void : never;
  };

  const labelCases = {
    mbox: { metadata: { labels: [label] }, signals: (item: RawItem) => ({ labels: signalTexts(item.metadata, 'labels') }) },
    evernote: { metadata: { tags: [label] }, signals: noteClassificationSignals },
    readwise: { metadata: { tags: [label] }, signals: noteClassificationSignals },
    reflect: { metadata: { tags: [label] }, signals: noteClassificationSignals },
    telegram: { metadata: { attachmentNames: [label] }, signals: telegramClassificationSignals },
    gmail: () => test('Gmail waits for its complete provider walk and keeps matching mail Private', async () => {
      const lane = authorityLane();
      const inside = sourceItem('gmail', 'labelled', { labels: [label] });
      const outside = sourceItem('gmail', 'outside', { labels: [] });
      await syncHeld(lane, [inside, outside], gmailClassificationSignals);
      settlePersonal(lane, outside.identity);
      lane.saveRules([labelRule]);
      const listLabelled: Parameters<typeof sweepLabelRuleRaises>[0]['source']['listLabelled'] = async (name, { pageToken }) => {
        expect(name).toBe(labelRule.match.value);
        return pageToken === 'second' ? { ids: [] } : { ids: [inside.identity.providerItemId], nextPageToken: 'second' };
      };
      const walk = () => sweepLabelRuleRaises({
        set: lane.set, provider: 'gmail', accountScope: outside.identity.accountScope, source: { listLabelled }, maxPages: 1,
      });

      await expect(lower(lane, outside.identity)).rejects.toMatchObject({ code: 'rule_authority' });
      expectHeld(lane, outside.identity);
      expect(await walk()).toMatchObject({ pending: 1 });
      await expect(lower(lane, outside.identity)).rejects.toMatchObject({ code: 'rule_authority' });
      expectHeld(lane, outside.identity);
      expect(await walk()).toMatchObject({ pending: 0 });
      await expect(lower(lane, outside.identity)).resolves.toMatchObject({ outcome: 'moved' });
      expect(bodyIn(lane, 'internal', outside.identity)).toBe(body);
      expect(lane.ledger.getCurrent(inside.identity)).toMatchObject({ decidedBy: 'owner_rule', targetContentTier: 'secure' });
      await moveTieredItem({ set: lane.set, identity: inside.identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
      expect(lane.ledger.getCurrent(inside.identity)).toMatchObject({ state: 'current', contentTier: 'secure' });
      expectHeld(lane, inside.identity);
    }),
  } satisfies LabelCases;

  function registerLabelCases() {
    for (const [provider, proof] of Object.entries(labelCases)) {
      if (typeof proof === 'function') {
        proof();
        continue;
      }
      const { metadata, signals } = proof;
      test(`${provider} stored labels allow a nonmatch and block a matching stricter label rule`, async () => {
        const lane = authorityLane();
        const inside = sourceItem(provider, 'labelled', metadata);
        const outside = sourceItem(provider, 'outside');
        await syncHeld(lane, [inside, outside], signals);
        for (const { identity } of [inside, outside]) settlePersonal(lane, identity);
        lane.saveRules([labelRule]);

        await expect(lower(lane, inside.identity)).rejects.toMatchObject({ code: 'rule_authority' });
        expectHeld(lane, inside.identity);
        expect(await lower(lane, outside.identity)).toMatchObject({ outcome: 'moved' });
        expect(bodyIn(lane, 'internal', outside.identity)).toBe(body);
      });
    }
  }

  const ruleCases = {
    override: () => test('a newly saved item override blocks a queued Personal move', async () => {
      const lane = authorityLane();
      const item = sourceItem('fixture', 'override');
      await syncHeld(lane, [item]);
      settlePersonal(lane, item.identity);
      lane.ledger.setOverride(item.identity, { kind: 'tier', tier: 'secure' });

      await expect(lower(lane, item.identity)).rejects.toBeInstanceOf(TierLedgerGenerationConflictError);
      expectHeld(lane, item.identity);
    }),

    policy: () => test('an unavailable owner policy holds a queued Personal move until it can be read', async () => {
      const lane = authorityLane();
      const item = sourceItem('fixture', 'policy');
      await syncHeld(lane, [item]);
      settlePersonal(lane, item.identity);
      writeFileSync(lane.path, '{');

      await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_policy_unavailable' });
      expectHeld(lane, item.identity);
      lane.saveRules([]);
      await expect(lower(lane, item.identity)).resolves.toMatchObject({ outcome: 'moved' });
      expect(bodyIn(lane, 'internal', item.identity)).toBe(body);
    }),

    publicTier: () => test('retiring Public blocks a queued move to its store', async () => {
      const lane = authorityLane();
      const item = sourceItem('fixture', 'retired');
      const rule = {
        id: 'published', match: { kind: 'pathPrefix', value: '/Files' }, tier: 'public', strength: 'force',
      } as const;
      const signals = { title: 'Picnic', path: '/Files/Picnic' };
      await syncHeld(lane, [item]);
      const decision = classifyItemTiers({ signals, text: body }, { rules: [rule], sniffer: JUDGED_PERSONAL_SNIFFER });
      expect(decision).toMatchObject({ metadataTier: 'public', contentTier: 'public', contentPending: false });
      expect(lane.ledger.recordRoutedPlacement(item.identity, decision, lane.set.placementFor(decision)).outcome).toBe('queued_move');
      configureInstalledTierClassification({ env: lane.env, retirePublic: true });

      await expect(moveTieredItem({ set: lane.set, identity: item.identity, target: decision })).rejects.toMatchObject({ code: 'rule_authority' });
      expectHeld(lane, item.identity);
      expect(bodyIn(lane, 'public_safe', item.identity)).toBe('');
    }),

    storedFields: () => test('stored names allow a nonmatch and block a matching stricter field rule', async () => {
      const lane = authorityLane();
      const inside = sourceItem('fixture', 'inside', { pathDisplay: '/Orchard/Picnic' });
      const outside = sourceItem('fixture', 'outside');
      await syncHeld(lane, [inside, outside], item => ({ title: 'Picnic', path: String(item.metadata.pathDisplay) }));
      for (const { identity } of [inside, outside]) settlePersonal(lane, identity);
      lane.saveRules([{
        id: 'orchard-path', match: { kind: 'pathPrefix', value: '/Orchard' }, tier: 'secure', strength: 'force',
      }]);

      await expect(lower(lane, inside.identity)).rejects.toMatchObject({ code: 'rule_authority' });
      expectHeld(lane, inside.identity);
      await expect(lower(lane, outside.identity)).resolves.toMatchObject({ outcome: 'moved' });
      expect(bodyIn(lane, 'internal', outside.identity)).toBe(body);
    }),
    labels: registerLabelCases,
  } satisfies Record<MoveRuleAuthorityEntry, () => void>;

  for (const register of Object.values(ruleCases)) register();

  test('repair queues only the stored nonmatch when a Personal verdict precedes the label rule', async () => {
    const lane = authorityLane();
    const inside = sourceItem('readwise', 'labelled', { tags: [label] });
    const outside = sourceItem('readwise', 'outside');
    await syncHeld(lane, [inside, outside], noteClassificationSignals);
    for (const { identity } of [inside, outside]) {
      const decision = classifyItemTiers({ signals: { title: 'Picnic' }, text: body }, { sniffer: JUDGED_PERSONAL_SNIFFER });
      lane.ledger.recordDecision(identity, decision);
    }
    lane.saveRules([labelRule]);
    expect(await storedPersonalLoweringLap(lane.set, undefined, () => undefined)).toMatchObject({ complete: true, changed: true });
    expect(lane.ledger.listMoving().map(row => row.providerItemId)).toEqual(['outside']);
    await lower(lane, outside.identity);
    expect(bodyIn(lane, 'internal', outside.identity)).toBe(body);
    expectHeld(lane, inside.identity);
  });

  for (const version of ['v1', 'v2']) {
    test(`a bodyless listing at ${version} keeps proof for unchanged names and withdraws changed names`, async () => {
      const lane = authorityLane();
      const unchanged = sourceItem('readwise', 'unchanged', { tags: ['Other'] });
      const changed = sourceItem('readwise', 'changed', { tags: ['Other'] });
      await syncHeld(lane, [unchanged, changed], noteClassificationSignals);
      const items = [unchanged, changed].map(item => ({
        ...item, identity: { ...item.identity, sourceVersion: version }, content: { kind: 'metadata_only' as const },
        metadata: { ...item.metadata, tags: item === changed ? [label] : ['Other'] },
      }));
      const connector: SourceConnector = {
        id: 'authority-fixture', family: 'file', async authenticate() {},
        async *listItems() { yield { items, done: true }; },
        async fetchItem(id) { return items.find(item => item.identity.localItemId === id)!; },
        classificationSignals: noteClassificationSignals,
      };
      await lane.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
      for (const { identity } of items) settlePersonal(lane, identity);
      lane.saveRules([labelRule]);
      await expect(lower(lane, unchanged.identity)).resolves.toMatchObject({ outcome: 'moved' });
      await expect(lower(lane, changed.identity)).rejects.toMatchObject({ code: 'rule_authority' });
      expectHeld(lane, changed.identity);
    });
  }

  test('a writer replacing names without observing labels invalidates an old nonmatch', async () => {
    const lane = authorityLane();
    const item = sourceItem('readwise', 'changed-names');
    await syncHeld(lane, [item], noteClassificationSignals);
    for (const path of [lane.paths.internal, lane.paths.secure_local]) {
      using db = new Database(path);
      db.query("UPDATE items SET title = 'Changed names' WHERE local_item_id = ?").run(item.identity.localItemId);
    }
    settlePersonal(lane, item.identity);
    lane.saveRules([labelRule]);
    await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    expectHeld(lane, item.identity);
  });

  test('a second listing of the same version cannot reuse a plan for different labels', async () => {
    const lane = authorityLane();
    lane.saveRules([labelRule]);
    const outside = sourceItem('readwise', 'same-version');
    const inside = { ...outside, metadata: { ...outside.metadata, tags: [label] } };
    const connector: SourceConnector = {
      id: 'authority-fixture', family: 'file', async authenticate() {},
      async *listItems() { yield { items: [outside, inside], done: true }; },
      async fetchItem() { return inside; },
      classificationSignals: noteClassificationSignals,
    };
    await lane.set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
    const record = lane.ledger.getCurrent(inside.identity)!;
    expect(record.targetContentTier ?? record.contentTier).toBe('secure');
    expect(record.reasons.some(reason => reason.startsWith('metadata:owner_rule:label:'))).toBe(true);
  });

  test('a pre-upgrade stored item without a label observation stays Private', async () => {
    const lane = authorityLane();
    const item = sourceItem('readwise', 'legacy');
    await syncHeld(lane, [item], noteClassificationSignals);
    for (const path of [lane.paths.internal, lane.paths.secure_local]) {
      using db = new Database(path);
      db.query('UPDATE items SET classification_labels_json = NULL').run();
    }
    settlePersonal(lane, item.identity);
    lane.saveRules([labelRule]);

    await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
    expectHeld(lane, item.identity);
  });

  test('archive labels recover from retained names in resumable pages; lost names stay visible until relisted', async () => {
    const lane = authorityLane(true);
    const outside = sourceItem('mbox', 'outside', { labels: ['Picnic mail'] });
    const inside = sourceItem('telegram', 'inside', {
      attachmentNames: [label], forwardedFrom: 'Archive sender',
      searchText: [body, label, 'Forwarded from Archive sender', 'Picnic'].join('\n'),
    });
    const missing = sourceItem('mbox', 'missing', { labels: ['Discarded label'] });
    const mail = labelCases.mbox.signals;
    await syncHeld(lane, [outside, missing], mail);
    await syncHeld(lane, [inside], telegramClassificationSignals);
    const queue = lane.installed.snifferStoreForLedger(lane.ledger.dbPath);
    queue.deleteItemQuestions(missing.identity);
    queue.deleteItemQuestions(inside.identity); // Telegram kept the context on its own row.
    for (const path of [lane.paths.internal, lane.paths.secure_local]) {
      using db = new Database(path);
      db.run('UPDATE items SET classification_labels_json = NULL');
    }
    for (const item of [outside, inside, missing]) settlePersonal(lane, item.identity);
    lane.saveRules([labelRule]);
    const page = () => recoverStoredLabelPage(lane.set, queue, () => undefined, 1);
    const first = lane.set.openStores().find(store => store.exportItemNames(outside.identity))!;
    const cursor = `complete_label_observation_after:${first.corpusId}`;
    expect(await page()).toMatchObject({ changed: true, retired: false });
    expect(lane.ledger.readMeta(cursor)).toBe('1:1');
    const reopened = openTierFixture(lane.dir, { embed: false });
    try {
      expect(await recoverStoredLabelPage(reopened.set, queue, () => undefined, 1)).toMatchObject({ changed: true, retired: false });
      expect(reopened.ledger.readMeta(cursor)).toBe('1:2');
    } finally {
      reopened.close();
    }
    let retired = false;
    for (let i = 0; i < 20 && !retired; i++) retired = (await page()).retired;
    expect(retired).toBe(true);
    expect(lane.ledger.readMeta('labels_unavailable_count')).toBe('1');
    for (const [item, labels] of [[outside, ['picnic mail']], [inside, ['forwarded from archive sender', 'orchard notes']]] as const) {
      expect(lane.stores.secure_local!.exportItemNames(item.identity)?.columns.classification_labels_json).toBe(JSON.stringify(labels));
    }
    await expect(lower(lane, outside.identity)).resolves.toMatchObject({ outcome: 'moved' });
    for (const item of [inside, missing]) {
      await expect(lower(lane, item.identity)).rejects.toMatchObject({ code: 'rule_authority' });
      expectHeld(lane, item.identity);
    }
    const listed = { ...missing, identity: { ...missing.identity, sourceVersion: 'v2' } };
    await lane.set.sync({ id: 'authority-fixture', family: 'file', async authenticate() {},
      async *listItems() { yield { items: [listed], done: true }; }, async fetchItem() { return listed; },
      classificationSignals: mail }, { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
    expect(lane.ledger.readMeta('labels_unavailable_count')).toBe('0');
  });

  test('a stored item older than its tier ledger is counted once across both legs', async () => {
    const lane = authorityLane();
    const item = sourceItem('mbox', 'old-mail', { labels: ['Original'] });
    await syncHeld(lane, [item], labelCases.mbox.signals);
    for (const store of lane.set.openStores()) {
      using db = new Database(store.dbPath);
      db.run('UPDATE items SET classification_labels_json = NULL');
    }
    using db = new Database(lane.ledger.dbPath);
    db.run('DELETE FROM tier_items');
    db.run('DELETE FROM tier_copies');
    const queue = lane.installed.snifferStoreForLedger(lane.ledger.dbPath);
    let retired = false;
    for (let i = 0; i < 10 && !retired; i++) retired = (await recoverStoredLabelPage(lane.set, queue, () => undefined)).retired;
    expect(retired).toBe(true);
    const service = new TierSnifferService({
      installed: lane.installed, lane: modelLane, modelAvailable: () => false,
      model: { async complete() { throw new Error('The observation pass does not need a model.'); } },
      stores: () => lane.set.openStores(), classificationLedgerPath: join(lane.dir, 'classification.jsonl'),
    });
    try {
      await service.runOnce();
      expect(service.backlog().labelsUnavailable).toBe(1);
    } finally {
      await service.stop();
    }
  });

  async function verifyPersonalMove(lane: AuthorityLane, identity: RawItem['identity']) {
    await expect(moveTieredItem({
      set: lane.set, identity, target: personal, afterVerified() { throw new Error('checkpoint'); },
    })).rejects.toThrow('checkpoint');
    expectHeld(lane, identity);
  }

  test('a verified move written before label observations resumes after upgrade', async () => {
    const lane = authorityLane();
    const item = sourceItem('fixture', 'legacy-receipt');
    const { identity } = item;
    await syncHeld(lane, [item]);
    settlePersonal(lane, identity);
    await verifyPersonalMove(lane, identity);

    // v17 move receipts hashed the stored columns without the label observation.
    const copy = lane.stores.internal!.exportItemCopy(identity)!;
    const { classification_labels_json: _labels, ...columns } = copy.columns;
    const oldFingerprint = createHash('sha256').update(JSON.stringify({
      identity: copy.identity, columns, chunks: copy.chunks,
    })).digest('hex');
    const key = `tier-move-verified:${tierLedgerIdentityKey(identity)}`;
    const receipt = JSON.parse(lane.ledger.readMeta(key)!) as { fingerprints: Record<string, string> };
    receipt.fingerprints[CORPORA.internal] = oldFingerprint;
    lane.ledger.writeMeta(key, JSON.stringify(receipt));

    expect(resumeVerifiedTierMove(lane.set, identity)).toBe(true);
    expect(bodyIn(lane, 'internal', identity)).toBe(body);
  });

  test('a verified move cannot publish a destination whose observed labels changed', async () => {
    const lane = authorityLane();
    const item = sourceItem('readwise', 'changed-observation', { tags: ['Other notes'] });
    await syncHeld(lane, [item], noteClassificationSignals);
    settlePersonal(lane, item.identity);
    await verifyPersonalMove(lane, item.identity);

    using db = new Database(lane.paths.internal);
    const changed = db.query('UPDATE items SET classification_labels_json = ? WHERE local_item_id = ? AND classification_labels_json = ?')
      .run(JSON.stringify([label]), item.identity.localItemId, JSON.stringify(['other notes']));
    expect(changed.changes).toBe(1);
    expect(() => resumeVerifiedTierMove(lane.set, item.identity)).toThrow('Verified move destination changed');
    expectHeld(lane, item.identity);
  });
});

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

const BODY = 'The garden committee will trim the orchard and water the seedlings.';
const SYNTHETIC_SECRET = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const SECRET_BODY = `${BODY} The example bucket key is ${SYNTHETIC_SECRET}.`;
const PERSONAL = { metadataTier: 'private', contentTier: 'private' } as const;
const identity = identityOf('notes');

function contentLane(classification: NonNullable<ReturnType<TieredStoreSet['classification']>> = {}) {
  const tmp = tempDir('olympus-personal-authority-');
  const fixture = openTierFixture(tmp.dir, { embed: false });
  cleanups.push(() => { fixture.close(); tmp.cleanup(); });
  const set = new TieredStoreSet({
    setId: 'personal-authority',
    ledger: fixture.ledger,
    secretLocations: fixture.secrets,
    tierClassification: classification,
    contentArrivesLaterFor: item => item.content.kind === 'metadata_only',
    legs: (['internal', 'secure_local'] as const).map(trustDomain => ({
      trustDomain, corpusId: CORPORA[trustDomain], store: fixture.stores[trustDomain]!,
    })),
  });
  const sync = (text: string | undefined = BODY, options: { version?: string; short?: boolean; photo?: boolean; namesOnly?: boolean } = {}) => {
    const item = fixtureItem({ id: 'notes', name: options.photo ? 'notice.jpg' : 'Orchard', ...(text !== undefined ? { text } : {}),
      ...(options.version ? { version: options.version } : {}),
    });
    if (options.namesOnly) item.content = { kind: 'metadata_only' };
    if (options.photo) item.mimeType = 'image/jpeg';
    if (options.short) item.metadata = { ...item.metadata, textComplete: true };
    const connector: SourceConnector = {
      id: 'authority-fixture', family: 'file',
      async authenticate() {},
      async *listItems() { yield { items: [item], done: true }; },
      async fetchItem() { return item; },
      classificationSignals(raw) {
        return options.short ? {} : { title: String(raw.metadata.title), path: '/Files/Orchard' };
      },
    };
    return set.sync(connector, { fetchContent: true, placement: FIXTURE_PLACEMENT });
  };
  const text = (domain: 'internal' | 'secure_local') =>
    fixture.stores[domain]!.exportItemCopy(identity)?.chunks.map(chunk => chunk.boundedText).join('') ?? '';
  const record = () => fixture.ledger.getCurrent(identity)!;
  const move = (target: Pick<TierDecision, 'metadataTier' | 'contentTier'> = PERSONAL) => moveTieredItem({
    set, identity, target, expectedGeneration: record().generation, replaceOwnSupersededCopy: true,
  });
  const settles = (body = BODY) => {
    expect(record()).toMatchObject({ contentTier: 'private', state: 'current', contentRead: true, contentPending: false });
    expect(record().reasons.filter(reason => reason.startsWith('content:sha256:'))).toEqual([contentDigestReason(body)]);
    expect(text('internal')).toBe(body);
  };
  return { ...fixture, set, sync, text, record, move, settles };
}

const modelLane: SnifferLane = {
  kind: 'local', modelId: 'authority-judge', profileId: 'authority-judge',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'authority-judge' },
};

function registerPhotoCase(textDecides: boolean) {
  test(textDecides ? 'photo text judge: a document photo moves on its own OCR verdict'
    : 'ordinary photo: the photo judge authorizes the move', async () => {
    const f = contentLane(textDecides ? { sniffer: JUDGED_PERSONAL_SNIFFER } : {});
    const previous = process.env[MEDIA_CACHE_DIR_ENV];
    process.env[MEDIA_CACHE_DIR_ENV] = join(f.dir, 'media');
    cleanups.push(() => {
      if (previous === undefined) delete process.env[MEDIA_CACHE_DIR_ENV];
      else process.env[MEDIA_CACHE_DIR_ENV] = previous;
    });
    await f.sync(undefined, { photo: true, namesOnly: true });
    const photo = writeMediaCacheFile(mediaCacheDir(), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]), 'image/jpeg');
    cleanups.push(() => releaseMediaCacheFile(photo.path, photo.sha256, photo.stagingHolder));
    const body = textDecides ? `${IMAGE_MEDIA_DESCRIPTOR}\n${BODY}` : IMAGE_MEDIA_DESCRIPTOR;
    const categories = Object.entries(MEDIA_JUDGE_PROMPTS);
    const provider = new class extends RecordingProvider {
      async imageSupport() { return true; }
      override async embed(inputs: Parameters<RecordingProvider['embed']>[0]) {
        return inputs.map(() => categories.map(() => 1));
      }
      async embedImageVectors(images: SourceEmbeddingImageInput[]) {
        return images.map(() => categories.map(([category]) => category === (textDecides ? 'medical_document' : 'ordinary') ? 0.7 : 0.6));
      }
      async embedPromptTexts(prompts: string[]) {
        return prompts.map(prompt => categories.map(([, description]) => Number(prompt.endsWith(description))));
      }
    }('fixture', 'authority-photo-judge', 'local', categories.length);
    const sink = createTieredStoreExtractionSink({
      set: f.set,
      syncConnectorId: 'authority-extraction', ownerConnectorId: 'authority-fixture', ownershipKind: 'observed',
    });
    expect(await sink.accept({
      ref: { ...identity, corpusId: CORPORA.internal, approvedScopeKey: 'fixture.personal:/',
        localItemId: 'personal:notes', sourceVersion: 'v1', name: 'notice.jpg', mimeType: 'image/jpeg' },
      text: body, media: { path: photo.path, sha256: photo.sha256, mimeType: 'image/jpeg' },
      extractorKind: 'local_text', extractorVersion: 'fixture', fetchedAt: '2026-11-20T00:00:00.000Z',
    })).toMatchObject({ accepted: true });
    expect(f.text('internal')).toBe('');
    expect(f.text('secure_local')).toBe(body);
    await f.stores.secure_local!.embedChunks({ provider });
    expect(applyMediaJudgments({ set: f.set, autoMoves: true })).toMatchObject({ movesQueued: 1, applied: 1 });
    await f.move();
    f.settles(body);
    expect(f.record().reasons).toContain(textDecides ? `${IMAGE_TEXT_DECIDES_REASON_PREFIX}medical_document` : IMAGE_ORDINARY_REASON);
    expect(f.stores.internal!.exportItemCopy(identity)?.chunks[0]?.mediaSha256).toBe(photo.sha256);
  });
}

const contentCases = {
  readAndSettled: () => test('read and settled: a pending body stays Private until the live judge answers', async () => {
    const queue = new TierSnifferStore({ dbPath: ':memory:' });
    cleanups.push(() => queue.close());
    const sniffer = new CachedTierSniffer(queue, modelLane);
    const unread = contentLane({ sniffer });
    await unread.sync(undefined, { namesOnly: true });
    expect(unread.record()).toMatchObject({ contentRead: false, contentPending: true });
    expect(unread.text('internal')).toBe('');
    const f = contentLane({ sniffer });
    await f.sync();
    expect(f.record()).toMatchObject({ contentRead: true, contentPending: true });
    expect(f.text('internal')).toBe('');
    expect(f.text('secure_local')).toBe(BODY);
    const report = await runSnifferPass({ lane: modelLane, targets: [{
      ledger: f.ledger, sniffer: queue, placementFor: decision => f.set.placementFor(decision),
    }], model: { async complete(request) {
      expect(request.prompt).toContain(BODY);
      return { modelId: modelLane.modelId,
        text: '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","confidence":0.99,"ownRecord":false,"privateKind":"none"}]}' };
    } } });
    expect(report.calls).toBe(1);
    await f.move();
    f.settles();
  }),

  exactBody: () => test('exact body: a move cannot reuse the prior verdict after an edit', async () => {
    let answer = JUDGED_PERSONAL_SNIFFER.judge;
    const f = contentLane({ sniffer: { id: modelLane.modelId, judge: question => answer(question) } });
    await f.sync();
    const initial = f.record();
    f.settles();
    const edited = `Edited schedule. ${BODY}`;
    answer = () => ({ verdict: 'decided', tier: 'secure', code: 'private' });
    await f.sync(edited, { version: 'v2' });
    const raised = f.record();
    expect(raised).toMatchObject({ state: 'moving', targetContentTier: 'secure' });
    await f.move({ metadataTier: raised.targetMetadataTier!, contentTier: raised.targetContentTier! });
    await f.sync(edited, { version: 'v3' });
    expect(f.text('secure_local')).toBe(edited);
    expect(initial.reasons.some(reason => reason.startsWith('content:judge_verdict:private:'))).toBe(true);
    const decision: TierDecision = { ...initial, ...PERSONAL, state: 'current', decidedBy: 'default', snifferId: modelLane.modelId };
    await expect(moveTieredItem({ set: f.set, identity, decision })).rejects.toMatchObject({ code: 'content_receipt_mismatch' });
    expect(f.stores.internal!.localContent(identity.localItemId)?.chunks ?? []).toEqual([]);
  }),

  'verdicts.textJudge': () => test('text judge: a stored Private item can be re-judged and moved on its own text', async () => {
    const held: TierSniffer = { id: 'first-judge', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'private' }) };
    const f = contentLane({ sniffer: held });
    await f.sync();
    expect(f.record()).toMatchObject({ contentTier: 'secure', contentPending: false });
    const report = emptyTierRejudgeReport();
    rejudgeStoredContent(f.set, f.record(), { sniffer: JUDGED_PERSONAL_SNIFFER, autoMoves: true, report });
    expect(report.movesQueued).toBe(1);
    await f.move();
    f.settles();
    expect(f.record().reasons.some(reason => reason.startsWith('content:judge_verdict:private:'))).toBe(true);
  }),

  'verdicts.shortMessage': () => test('short message: the complete body settles through the short-text rule', async () => {
    const f = contentLane();
    await f.sync('ok', { short: true });
    f.settles('ok');
    expect(f.record().reasons).toContain('content:rule:short_text');
  }),

  'verdicts.ownerNames': () => test('owner names: an explicit matching folder rule authorizes its body', async () => {
    const f = contentLane({ rules: [{ id: 'orchard', match: { kind: 'pathPrefix', value: '/Files' }, tier: 'private', strength: 'force' }] });
    await f.sync();
    f.settles();
    expect(f.record().reasons).toContain('metadata:owner_rule:pathPrefix:orchard:force');
    expect(f.record().reasons.some(reason => reason.startsWith('content:judge_verdict:'))).toBe(false);
  }),

  'verdicts.itemOverride': () => {
    // This set's lowest store is Personal, including for a legacy Public override.
    for (const tier of ['private', 'public'] as const) {
      test(`item override: the owner's ${tier} decision moves a clean body from Private`, async () => {
        const f = contentLane({ sniffer: { id: 'first-judge', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'private' }) } });
        await f.sync();
        expect(f.text('secure_local')).toBe(BODY);
        f.ledger.setOverride(identity, { kind: 'tier', tier });
        expect(applyOwnerOverrides({ set: f.set }).lowered).toBe(1);
        await f.move({ metadataTier: tier, contentTier: tier });
        expect(f.record()).toMatchObject({ state: 'current', contentTier: tier, decidedBy: 'override', contentPending: false });
        expect(f.record().reasons).toContain(`override:item:${tier}`);
        expect(f.text('internal')).toBe(BODY);
      });
    }
  },

  'secretClearance.ownerDigest': () => test('owner digest: a finding in an edited body needs the owner to confirm those bytes', async () => {
    const f = contentLane({ sniffer: JUDGED_PERSONAL_SNIFFER });
    await f.sync();
    f.ledger.setOverride(identity, { kind: 'tier', tier: 'private' });
    applyOwnerOverrides({ set: f.set });
    await f.sync(SECRET_BODY, { version: 'v2' });
    expect(f.text('internal')).toBe('');
    expect(f.text('secure_local')).toBe(SECRET_BODY);
    const review = f.ledger.ownerOverrideReview(identity)!;
    expect(review.digest).toBe(contentDigestReason(SECRET_BODY));
    expect(f.ledger.resolveOwnerOverrideReview(identity, review.digest, 'personal')).toBe(true);
    expect(applyOwnerOverrides({ set: f.set }).lowered).toBe(1);
    await f.move();
    f.settles(SECRET_BODY);
    expect(f.record().reasons).toContain(OWNER_OVERRIDE_SECRET_CONFIRMED_REASON);
  }),

  'secretClearance.notSecret': () => test('not_secret: an owner clears the detected finding and the body still gets its own verdict', async () => {
    const f = contentLane({ sniffer: JUDGED_PERSONAL_SNIFFER });
    await f.sync(SECRET_BODY);
    expect(f.record().contentTier).toBe('secrets');
    expect(f.text('internal')).toBe('');
    f.ledger.setOverride(identity, { kind: 'not_secret' });
    await f.sync(SECRET_BODY, { version: 'v2' });
    f.settles(SECRET_BODY);
    expect(f.record().reasons).toContain('override:item:not_secret');
    expect(f.record().reasons.some(reason => reason.startsWith('content:judge_verdict:private:'))).toBe(true);
  }),

  'secretClearance.cleanScan': () => test('clean scan: an ordinary body with a Personal verdict lands directly in Personal', async () => {
    const f = contentLane({ sniffer: JUDGED_PERSONAL_SNIFFER });
    await f.sync();
    f.settles();
    expect(f.ledger.getOverride(identity)).toBeUndefined();
    expect(f.record().reasons.some(reason => reason.startsWith('content:judge_verdict:private:'))).toBe(true);
    expect(f.text('secure_local')).toBe('');
  }),
  'verdicts.ordinaryPhoto': () => registerPhotoCase(false),
  'verdicts.photoTextJudge': () => registerPhotoCase(true),
} satisfies Record<PersonalContentAuthorityEntry, () => void>;

describe('Personal content authority', () => {
  for (const register of Object.values(contentCases)) register();

  for (const parentNamed of [false, true]) {
    test(parentNamed ? 'text judge: a child verdict binds the body judged with the parent names'
      : 'text judge: a child can settle on its own body', async () => {
      const parents: FixtureParentSpec[] = [{
        id: 'message', subject: parentNamed ? 'Orchard meeting' : `Storage key ${SYNTHETIC_SECRET}`, sender: 'Alex',
        body: 'Please find the notes attached.', sentAt: '2026-11-20T00:00:00.000Z',
        children: [{ key: 'attachment', name: 'notes.txt', mimeType: 'text/plain', text: BODY }],
      }];
      const childId = childProviderItemId('message', 'attachment');
      const questions: TierSnifferRequest[] = [];
      const sniffer: TierSniffer = { id: 'authority-child-judge', judge(question) {
        if (question.subject?.providerItemId === childId && question.pass === 'content') questions.push(question);
        return { verdict: 'decided', tier: 'private', code: 'ordinary:0.99' };
      } };
      registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
      cleanups.push(() => registerInstalledTierClassification(undefined));
      const archive = childItemsArchiveHarness(cleanups);
      const archiveId = archive.start();
      await archive.importAll(archiveId, parents);
      const extraction = childItemsExtraction(archive, cleanups, { parents });
      await extraction.drive(archiveId);
      const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
      const lane = archive.runtime.lane(format.family);
      expect(questions.length).toBeGreaterThan(0);
      for (const question of questions) {
        const { own, context } = splitParentContext(question.material ?? '');
        expect(own).toContain(BODY);
        expect(context).toBe(parentNamed ? 'Orchard meeting | Alex' : undefined);
      }
      expect(lane.ledger.getCurrent({ provider: format.provider, accountScope: archiveId, providerItemId: childId }))
        .toMatchObject({ contentTier: 'private', state: 'current', contentPending: false });
      expect(archive.rows(archiveId).filter(row => row.providerItemId === childId && row.chunks > 0).map(row => row.domain))
        .toEqual(['internal']);
    });
  }
});
