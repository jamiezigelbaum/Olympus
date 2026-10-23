// The archive hold (docs/design/archive-import.md, "Privacy while an import
// is judged"): in a lane that sets `holdContentUntilJudged`, read content
// stays Private until the privacy-safe model judges it. It is held exactly as
// an own record is (pending, never Personal-first, embedding held), also with
// no model at all; its questions queue behind live ones; cleared names stay
// discoverable; Secrets, structured identifiers, owner rules, force rules and
// overrides keep their precedence; and every later pass reads the hold back
// from the stored decision. Synthetic data only.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import {
  HELD_RECORD_PRIORITY,
  HELD_UNTIL_JUDGED_PRIORITY,
  HELD_UNTIL_JUDGED_REASON,
  PERSONAL_FIRST_REASON,
  UNDECIDED_TIER_SNIFFER,
  classifyContentTier,
  classifyItemTiers,
  heldUntilJudged,
  type OwnerTierRule,
  type TierSniffer,
  type TierSnifferRequest,
} from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import { decideItemTiers, resolveStoreTierClassification, type ConnectorStoreTierClassification } from '../src/workers/connector-store/tier-placement.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { sweepOwnerRuleRaises } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { createTieredLaneSet, TieredStoreSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import type { ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import {
  ACCOUNT,
  CORPORA,
  FIXTURE_PLACEMENT,
  PROVIDER,
  cloudProvider,
  fixtureConnector,
  fixtureItem,
  identityOf,
  localId,
  localProvider,
  openLegStore,
  storePaths,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const requests: TierSnifferRequest[] = [];
/** A model that has been asked but has not answered yet: every question waits, durably queued. */
const waiting: TierSniffer = { id: 'fixture-waiting', judge(request) { requests.push(request); return { verdict: 'undecided', queued: true }; } };
const HOLD = { holdContentUntilJudged: true } as const;
const ORDINARY = 'Please remember the bananas and the oranges for the picnic on Saturday.';
const BODY_MARKER = 'Quietorchardmarker';

const cleanups: Array<() => void> = [];
afterEach(() => { requests.length = 0; for (const close of cleanups.splice(0)) close(); });

/** A lane with separate Personal and Private stores, cloud and local embedders, and the given inputs. */
function lane(tierClassification: ConnectorStoreTierClassification) {
  const tmp = tempDir('olympus-tier-held-');
  const paths = storePaths(tmp.dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(tmp.dir, 'secret-locations.sqlite') });
  const stores = {
    internal: openLegStore(paths, 'internal', ledger),
    secure_local: openLegStore(paths, 'secure_local', ledger),
  };
  const cloud = cloudProvider();
  const local = localProvider();
  const setWith = (classification: ConnectorStoreTierClassification) => new TieredStoreSet({
    setId: 'held-until-judged', ledger, secretLocations: secrets, tierClassification: classification,
    legs: [
      { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal, embeddingProvider: cloud },
      { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, embeddingProvider: local },
    ],
  });
  cleanups.push(() => { stores.internal.close(); stores.secure_local.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  return { ledger, stores, cloud, local, set: setWith(tierClassification), setWith };
}

async function syncOne(f: ReturnType<typeof lane>, spec: FixtureSpec, set = f.set): Promise<void> {
  await set.sync(fixtureConnector(() => [spec]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
}

const contentQuestions = () => requests.filter((request) => request.pass === 'content');

// --- The classifier ----------------------------------------------------------

for (const [title, sniffer] of [['a model that has not answered yet', waiting], ['no model at all', UNDECIDED_TIER_SNIFFER]] as const) {
  test(`with ${title}, ordinary read content is held, never Personal-first`, () => {
    const decision = classifyItemTiers({ signals: { title: 'Picnic list' }, text: ORDINARY, holdUntilJudged: true }, { sniffer });
    expect(decision).toMatchObject({ metadataTier: 'private', contentTier: 'private', state: 'pending', contentPending: true, metadataPending: false });
    expect(decision.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(decision.reasons).not.toContain(PERSONAL_FIRST_REASON);
    expect(decision.reasons).toContain(`content:sniffer:${sniffer.id}:undecided`);
    // The same item outside a held lane is usable at once.
    const live = classifyItemTiers({ signals: { title: 'Picnic list' }, text: ORDINARY }, { sniffer });
    expect(live.reasons).not.toContain(HELD_UNTIL_JUDGED_REASON);
    if (sniffer === waiting) expect(live.reasons).toContain(PERSONAL_FIRST_REASON);
    else expect(live.contentPending).toBe(false);
  });
}

test('held questions queue behind every live question, own records included', () => {
  classifyItemTiers({ signals: { title: 'Picnic list' }, text: ORDINARY, holdUntilJudged: true }, { sniffer: waiting });
  classifyItemTiers({ signals: { title: 'Lab report' }, text: 'Patient: Morgan Example\nGlucose 93 mg/dL.', holdUntilJudged: true }, { sniffer: waiting });
  expect(contentQuestions().map((request) => request.priority)).toEqual([HELD_UNTIL_JUDGED_PRIORITY, HELD_UNTIL_JUDGED_PRIORITY]);
  expect(contentQuestions()[0]!.flags).toContain(HELD_UNTIL_JUDGED_REASON);
  requests.length = 0;
  // A names question of a held item (a structured value in its name) waits behind live ones too.
  classifyItemTiers({ signals: { title: 'Scan SSN 123-45-6789' }, text: ORDINARY, holdUntilJudged: true }, { sniffer: waiting });
  expect(requests.find((request) => request.pass === 'metadata')?.priority).toBe(HELD_UNTIL_JUDGED_PRIORITY);
  requests.length = 0;
  classifyItemTiers({ signals: { title: 'Lab report' }, text: 'Patient: Morgan Example\nGlucose 93 mg/dL.' }, { sniffer: waiting });
  expect(contentQuestions()[0]!.priority).toBe(HELD_RECORD_PRIORITY);
  expect(HELD_UNTIL_JUDGED_PRIORITY).toBeLessThan(0);
});

test('a verdict settles a held item: Personal and Private alike, the hold reason stays', () => {
  const personal: TierSniffer = { id: 'fixture-model', judge: () => ({ verdict: 'decided', tier: 'private', code: 'personal' }) };
  const privately: TierSniffer = { id: 'fixture-model', judge: () => ({ verdict: 'decided', tier: 'secure', code: 'private' }) };
  const judgedPersonal = classifyItemTiers({ signals: { title: 'Picnic list' }, text: ORDINARY, holdUntilJudged: true }, { sniffer: personal });
  expect(judgedPersonal).toMatchObject({ contentTier: 'private', state: 'current', contentPending: false });
  expect(judgedPersonal.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  const judgedPrivate = classifyItemTiers({ signals: { title: 'Picnic list' }, text: ORDINARY, holdUntilJudged: true }, { sniffer: privately });
  expect(judgedPrivate).toMatchObject({ contentTier: 'secure', state: 'current', decidedBy: 'sniffer' });
});

test('Secrets, structured identifiers, owner rules, force rules, floors and overrides keep their precedence', () => {
  const held = (input: Parameters<typeof classifyItemTiers>[0], options: Parameters<typeof classifyItemTiers>[1] = {}) =>
    classifyItemTiers({ ...input, holdUntilJudged: true }, { sniffer: waiting, ...options });
  // A secret in the text: Secrets at once, no question, no hold reason.
  const secret = held({ signals: { title: 'Router notes' }, text: `Router login ${['pass', 'word', ' = ', 'heldfixture', 'battery42'].join('')}` });
  expect(secret).toMatchObject({ contentTier: 'secrets', state: 'current', contentPending: false });
  expect(secret.reasons).not.toContain(HELD_UNTIL_JUDGED_REASON);
  expect(contentQuestions()).toEqual([]);
  // A structured identifier: Private at once, nothing waits.
  const identifier = held({ signals: { title: 'Scan notes' }, text: 'Recorded for SSN 123-45-6789; follow up next week.' });
  expect(identifier).toMatchObject({ contentTier: 'secure', decidedBy: 'sensitive_detector', contentPending: false });
  expect(identifier.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  // An owner prior rule settled the names: the owner said where it belongs.
  const prior: OwnerTierRule = { id: 'owner-prior', match: { kind: 'pathPrefix', value: '/Shared/' }, tier: 'private', strength: 'prior' };
  const ownerDecided = held({ signals: { title: 'Picnic list', path: '/Shared/picnic.txt' }, text: ORDINARY }, { rules: [prior] });
  expect(ownerDecided).toMatchObject({ contentTier: 'private', contentPending: false, state: 'current' });
  expect(ownerDecided.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  // The same owner prior, but the body raises a question the model has not
  // answered yet: the content waits Private, never Personal-first.
  const priorPersonal: OwnerTierRule = { id: 'owner-prior-personal', match: { kind: 'pathPrefix', value: '/Shared/' }, tier: 'private', strength: 'prior' };
  const borderline = held(
    { signals: { title: 'Notes', path: '/Shared/notes.txt' }, text: 'We discussed my medical treatment and therapy at length.' },
    { rules: [priorPersonal] },
  );
  expect(borderline.contentPending).toBe(true);
  expect(borderline.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(heldUntilJudged(borderline.reasons)).toBe(true);
  // A force rule fixes the tier.
  const force: OwnerTierRule = { id: 'owner-force', match: { kind: 'pathPrefix', value: '/Public/' }, tier: 'private', strength: 'force' };
  expect(held({ signals: { title: 'Picnic list', path: '/Public/picnic.txt' }, text: ORDINARY }, { rules: [force] }))
    .toMatchObject({ contentTier: 'private', contentPending: false, metadataForced: true });
  // A raising owner rule makes it Private at once.
  const raise: OwnerTierRule = { id: 'owner-raise', match: { kind: 'pathPrefix', value: '/Family/' }, tier: 'secure', strength: 'prior' };
  expect(held({ signals: { title: 'Picnic list', path: '/Family/picnic.txt' }, text: ORDINARY }, { rules: [raise] }))
    .toMatchObject({ contentTier: 'secure', contentPending: false });
  // A source floor raises.
  expect(held({ signals: { title: 'Picnic list', floor: { tier: 'secure', basis: 'fixture_floor' } }, text: ORDINARY }))
    .toMatchObject({ contentTier: 'secure', contentPending: false });
  // The owner's per-item override is final; the hold reason travels with it.
  const override = held({ signals: { title: 'Picnic list' }, text: ORDINARY }, { override: { kind: 'tier', tier: 'private' } });
  expect(override).toMatchObject({ decidedBy: 'override', contentTier: 'private', contentPending: false });
  expect(override.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(held({ signals: { title: 'Picnic list' }, text: ORDINARY }, { override: { kind: 'tier', tier: 'secrets' } }).reasons)
    .not.toContain(HELD_UNTIL_JUDGED_REASON);
  // An unjudged picture rests Private as everywhere.
  expect(held({ signals: { title: 'IMG_0001.jpg' }, text: 'beach', mimeType: 'image/jpeg' }))
    .toMatchObject({ contentTier: 'secure', contentPending: false });
});

test('late text, unread and names-only decisions carry the hold the same way', () => {
  const base = { metadataTier: 'private' as const, metadataForced: false, metadataFlagged: false };
  const late = classifyContentTier({ ...base, text: ORDINARY, holdUntilJudged: true }, { sniffer: waiting });
  expect(late).toMatchObject({ contentPending: true });
  expect(late.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(late.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(classifyContentTier({ ...base, text: ORDINARY }, { sniffer: waiting }).reasons).toContain(PERSONAL_FIRST_REASON);
  expect(classifyContentTier({ ...base, text: ORDINARY, holdUntilJudged: true }, { sniffer: waiting, override: { kind: 'tier', tier: 'private' } }).reasons)
    .toContain(HELD_UNTIL_JUDGED_REASON);
  const unread = classifyItemTiers({ signals: { title: 'Picnic list' }, holdUntilJudged: true }, { sniffer: waiting });
  expect(unread).toMatchObject({ contentRead: false, contentPending: true });
  expect(unread.reasons).toEqual(expect.arrayContaining(['content:unread', HELD_UNTIL_JUDGED_REASON]));
  expect(classifyItemTiers({ signals: { title: 'Picnic list' }, namesOnly: true, holdUntilJudged: true }).reasons)
    .toEqual(expect.arrayContaining(['content:names_only', HELD_UNTIL_JUDGED_REASON]));
  expect(heldUntilJudged(unread.reasons)).toBe(true);
  expect(heldUntilJudged(['content:unread'])).toBe(false);
});

// --- The lane option ----------------------------------------------------------

test('the lane option is the lane\'s own: merged inputs keep it, and only an explicit option sets it', () => {
  expect(resolveStoreTierClassification({ ...HOLD, sniffer: waiting }, '/nonexistent/ledger.sqlite')).toMatchObject(HOLD);
  expect(resolveStoreTierClassification({ sniffer: waiting }, '/nonexistent/ledger.sqlite')?.holdContentUntilJudged).toBeUndefined();
});

test('a store call site reads the hold back from the stored decision', () => {
  const tmp = tempDir('olympus-tier-held-ledger-');
  const ledger = new TierLedger({ dbPath: join(tmp.dir, 'ledger.sqlite') });
  cleanups.push(() => { ledger.close(); tmp.cleanup(); });
  const spec = { id: 'readback', name: 'Picnic list', text: ORDINARY };
  const item = fixtureItem(spec);
  const connector = fixtureConnector(() => [spec]);
  ledger.recordDecision(item.identity, classifyItemTiers({ signals: { title: spec.name }, holdUntilJudged: true }));
  // The recording brings no lane option; the stored decision carries the hold.
  const decision = decideItemTiers(connector, item, ORDINARY, { sniffer: waiting }, ledger);
  expect(decision).toMatchObject({ contentPending: true });
  expect(decision.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(decision.reasons).not.toContain(PERSONAL_FIRST_REASON);
  const other = fixtureItem({ id: 'other', name: 'Picnic list', text: ORDINARY });
  expect(decideItemTiers(connector, other, ORDINARY, { sniffer: waiting }, ledger).reasons).toContain(PERSONAL_FIRST_REASON);
});

// --- Placement in a lane -------------------------------------------------------

test('held content rests in Private with its embedding held; cleared names stay Personal and searchable', async () => {
  const f = lane({ ...HOLD, sniffer: waiting });
  await syncOne(f, { id: 'picnic', name: 'Orchard picnic list', text: `${ORDINARY} ${BODY_MARKER}` });
  const identity = identityOf('picnic');
  const copies = f.ledger.copies(identity);
  expect(copies).toHaveLength(2);
  expect(copies).toContainEqual(expect.objectContaining({ corpusId: CORPORA.internal, layers: 'metadata', state: 'current' }));
  expect(copies).toContainEqual(expect.objectContaining({ corpusId: CORPORA.secure_local, layers: 'content', state: 'current', embedHold: true }));
  expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'pending', contentPending: true, contentTier: 'private' });
  expect(f.ledger.getCurrent(identity)?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(f.stores.internal.searchItems('Orchard', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['picnic']);
  expect(f.stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
  expect(f.stores.internal.localContent(localId('picnic'))?.chunks ?? []).toEqual([]);
  expect(f.stores.secure_local.localContent(localId('picnic'))?.chunks.join(' ')).toContain(BODY_MARKER);
  // Nothing of the body reaches the cloud embedder.
  await f.stores.internal.embedChunks({ provider: f.cloud });
  expect(f.cloud.inputs.some((input) => input.includes(BODY_MARKER) || input.includes('bananas'))).toBe(false);
  expect(contentQuestions()[0]).toMatchObject({ priority: HELD_UNTIL_JUDGED_PRIORITY });
});

test('an owner Personal rule on the names does not release content whose question waits', async () => {
  const personalPrior: OwnerTierRule = { id: 'owner-files-personal', match: { kind: 'pathPrefix', value: '/Files/' }, tier: 'private', strength: 'prior' };
  const f = lane({ ...HOLD, sniffer: waiting, rules: [personalPrior] });
  const text = `We discussed my medical treatment and therapy at length. ${BODY_MARKER}`;
  await syncOne(f, { id: 'therapy', name: 'Session notes', text });
  const identity = identityOf('therapy');
  expect(f.ledger.getCurrent(identity)).toMatchObject({ contentPending: true });
  expect(f.ledger.getCurrent(identity)?.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(f.ledger.copies(identity)).toContainEqual(expect.objectContaining({ trustDomain: 'secure_local', layers: 'content', embedHold: true }));
  expect(f.stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
  expect(f.stores.internal.localContent(localId('therapy'))?.chunks ?? []).toEqual([]);
  await f.stores.internal.embedChunks({ provider: f.cloud });
  expect(f.cloud.inputs.some((input) => input.includes(BODY_MARKER) || input.includes('therapy'))).toBe(false);
});

test('with no private model at all, a held item stays held', async () => {
  const f = lane({ ...HOLD });
  await syncOne(f, { id: 'nomodel', name: 'Orchard picnic list', text: `${ORDINARY} ${BODY_MARKER}` });
  const record = f.ledger.getCurrent(identityOf('nomodel'))!;
  expect(record).toMatchObject({ state: 'pending', contentPending: true });
  expect(record.reasons).toContain('content:sniffer:undecided:undecided');
  expect(record.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(f.stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
  expect(f.ledger.copies(identityOf('nomodel'))).toContainEqual(expect.objectContaining({ trustDomain: 'secure_local', embedHold: true }));
});

test('a Personal verdict moves the content down; a Private verdict keeps it in Private', async () => {
  const f = lane({ ...HOLD, sniffer: waiting });
  await f.set.sync(fixtureConnector(() => [
    { id: 'down', name: 'Orchard picnic list', text: `${ORDINARY} ${BODY_MARKER}` },
    { id: 'kept', name: 'Orchard family note', text: 'Quietkeptmarker from the family.' },
  ]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const placementFor = (decision: Parameters<TieredStoreSet['placementFor']>[0]) => f.set.placementFor(decision);

  const personal = f.ledger.applySnifferVerdict(identityOf('down'), { pass: 'content', tier: 'private', reason: 'content:sniffer:fixture-waiting:personal', modelId: 'fixture' }, { placementFor });
  expect(personal?.outcome).toBe('queued_move');
  // Until the move lands, the body is still only in Private.
  expect(f.stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
  await moveTieredItem({ set: f.set, identity: identityOf('down'), target: { metadataTier: 'private', contentTier: 'private' } });
  expect(f.stores.internal.searchItems(BODY_MARKER, 10).map((row) => row.sourceItem.providerItemId)).toEqual(['down']);
  expect(f.ledger.getCurrent(identityOf('down'))?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);

  const kept = f.ledger.applySnifferVerdict(identityOf('kept'), { pass: 'content', tier: 'secure', reason: 'content:sniffer:fixture-waiting:private', modelId: 'fixture' }, { placementFor });
  expect(kept?.outcome).not.toBe('queued_move');
  expect(f.ledger.getCurrent(identityOf('kept'))).toMatchObject({ contentTier: 'secure', contentPending: false });
  expect(f.stores.internal.searchItems('Quietkeptmarker', 10)).toEqual([]);
  expect(f.ledger.copies(identityOf('kept'))).toContainEqual(expect.objectContaining({ trustDomain: 'secure_local', layers: 'content', embedHold: false }));
});

test('a re-judge asks again once a model appears, from the stored hold alone, and keeps the item held', async () => {
  const f = lane({ ...HOLD });
  await syncOne(f, { id: 'later', name: 'Orchard picnic list', text: `${ORDINARY} ${BODY_MARKER}` });
  expect(requests).toEqual([]);
  // The model arrives; this set does not even bring the lane option.
  const withModel = f.setWith({ sniffer: waiting });
  expect(rejudgeRoutedItems({ set: withModel, autoMoves: true }).report).toMatchObject({ asked: 1, failed: 0 });
  expect(contentQuestions()).toEqual([expect.objectContaining({ priority: HELD_UNTIL_JUDGED_PRIORITY, flags: expect.arrayContaining([HELD_UNTIL_JUDGED_REASON]) })]);
  const record = f.ledger.getCurrent(identityOf('later'))!;
  expect(record).toMatchObject({ state: 'pending', contentPending: true });
  expect(record.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(record.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(f.stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
});

test('an owner override settles a held item and keeps the hold reason for the passes after it', async () => {
  const f = lane({ ...HOLD, sniffer: waiting });
  await syncOne(f, { id: 'owner', name: 'Orchard picnic list', text: `${ORDINARY} ${BODY_MARKER}` });
  f.ledger.setOverride(identityOf('owner'), { kind: 'tier', tier: 'secure' });
  expect(applyOwnerOverrides({ set: f.set })).toMatchObject({ raised: 1 });
  // The owner's raise is queued with the owner's decision, which keeps the hold.
  const record = f.ledger.getCurrent(identityOf('owner'))!;
  expect(record).toMatchObject({ decidedBy: 'override', state: 'moving', targetContentTier: 'secure', contentPending: false });
  expect(record.reasons).toContain('override:item:secure');
  expect(record.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
});

test('an owner rule saved later raises a held item, and the hold stays with its content', async () => {
  const f = lane({ ...HOLD, sniffer: waiting });
  await syncOne(f, { id: 'swept', name: 'Orchard picnic list', text: `${ORDINARY} ${BODY_MARKER}` });
  const rule: OwnerTierRule = { id: 'owner-raise', match: { kind: 'pathPrefix', value: '/Files/' }, tier: 'secure', strength: 'prior' };
  expect(sweepOwnerRuleRaises({ set: f.setWith({ ...HOLD, sniffer: waiting, rules: [rule] }) })).toMatchObject({ raised: 1 });
  const record = f.ledger.getCurrent(identityOf('swept'))!;
  expect(record.decidedBy).toBe('owner_rule');
  expect(record.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(record.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(f.stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
});

test('text that lands after listing is held from the listing\'s stored hold', async () => {
  const tmp = tempDir('olympus-tier-held-deferred-');
  const paths = storePaths(tmp.dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(tmp.dir, 'secret-locations.sqlite') });
  const stores: Record<'internal' | 'secure_local', LocalConnectorStore> = {
    internal: openLegStore(paths, 'internal', ledger),
    secure_local: openLegStore(paths, 'secure_local', ledger),
  };
  cleanups.push(() => { stores.internal.close(); stores.secure_local.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  const deferredSet = (tierClassification: ConnectorStoreTierClassification) => createTieredLaneSet({
    setId: 'held-deferred', ledger, secretLocations: secrets, contentArrivesLater: true, tierClassification,
    legs: {
      internal: { store: stores.internal },
      secure_local: { store: stores.secure_local, legacy: true },
    },
  });
  // Listed by names only in the held lane.
  await deferredSet({ ...HOLD, sniffer: waiting }).sync(fixtureConnector(() => [{ id: 'late', name: 'Orchard picnic list' }]),
    { fetchContent: false, placement: { trustTier: 'S4', trustDomain: 'secure_local' } });
  expect(ledger.getCurrent(identityOf('late'))?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  // The extraction landing runs from a set without the lane option.
  const sink = createTieredStoreExtractionSink({ set: deferredSet({ sniffer: waiting }), syncConnectorId: 'extraction', ownerConnectorId: 'fixture-connector', ownershipKind: 'observed' });
  const request: ExtractionSinkRequest = {
    ref: { corpusId: CORPORA.secure_local, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: `${PROVIDER}.${ACCOUNT}:/`,
      providerItemId: 'late', localItemId: localId('late'), sourceVersion: 'v1' },
    text: `${ORDINARY} ${BODY_MARKER}`, extractorKind: 'local_text', extractorVersion: 'test', fetchedAt: '2026-10-23T00:00:00.000Z',
  };
  expect((await sink.accept(request)).accepted).toBe(true);
  const record = ledger.getCurrent(identityOf('late'))!;
  expect(record).toMatchObject({ contentRead: true, contentPending: true });
  expect(record.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
  expect(record.reasons).not.toContain(PERSONAL_FIRST_REASON);
  expect(stores.internal.searchItems(BODY_MARKER, 10)).toEqual([]);
  expect(stores.secure_local.localContent(localId('late'))?.chunks.join(' ')).toContain(BODY_MARKER);
});

// --- The queue -------------------------------------------------------------------

test('the queue keeps the held priority and orders it after every live question', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:', now: () => new Date('2026-10-23T00:00:00Z') });
  cleanups.push(() => store.close());
  const subject = (providerItemId: string) => ({ provider: 'fixture', accountScope: 'synthetic', providerItemId });
  store.enqueue({ subject: subject('archive-old'), pass: 'content', material: 'held one', mapRevision: 'none', flags: [HELD_UNTIL_JUDGED_REASON], priority: HELD_UNTIL_JUDGED_PRIORITY });
  store.enqueue({ subject: subject('live-ordinary'), pass: 'content', material: 'live one', mapRevision: 'none', flags: ['content:read'], priority: 0 });
  store.enqueue({ subject: subject('live-record'), pass: 'content', material: 'live record', mapRevision: 'none', flags: ['content:own_record:measurement'], priority: HELD_RECORD_PRIORITY });
  store.enqueue({ subject: subject('below-floor'), pass: 'content', material: 'clamped', mapRevision: 'none', flags: [], priority: -50 });
  // Three by priority, then the oldest question, which aging always reserves.
  expect(store.listQuestions({ limit: 3 }).map((question) => question.providerItemId))
    .toEqual(['live-record', 'live-ordinary', 'below-floor', 'archive-old']);
  expect(store.questionFor(subject('archive-old'), 'content')?.priority).toBe(HELD_UNTIL_JUDGED_PRIORITY);
  expect(store.questionFor(subject('below-floor'), 'content')?.priority).toBe(HELD_UNTIL_JUDGED_PRIORITY);
  expect(store.questionFor(subject('live-ordinary'), 'content')?.priority).toBe(0);
});
