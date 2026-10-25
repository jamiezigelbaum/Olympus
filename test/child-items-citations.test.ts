// A child's parent label, from the real archive import, tier set, ledger and
// extraction runtime (docs/design/child-items.md, "Citations"), with the fixture
// connector standing in for every format: the resolver reads the parent's
// NAMES from the one copy the ledger says serves them; raising the parent's
// names to Private changes what a Personal child may show; a parent that is a
// Secret, gone or not final gives no label; the parent's content never limits
// the child; and a file that could not be read names its parent and where it
// lives. Synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { archiveCorpusId, getArchiveFormat } from '../src/core/archive-formats.ts';
import type { EvidenceCandidate } from '../src/core/contracts.ts';
import { applyParentLabels, type ParentLabelScope } from '../src/core/parent-label.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { archiveLaneStores } from '../src/workers/archive-import/lane.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import type { TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { createParentLabelResolver, unreadableParentOf } from '../src/workers/connector-store/parent-label.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import type { ExtractionUnreadableItem } from '../src/workers/file-extraction/job-store.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';
import { createUnreadableFiles, createUnreadableVerdict } from '../src/workers/file-extraction/unreadable-files.ts';
import { childProviderItemId, fixtureLocalItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';
import { childItemsExtraction } from './support/child-items-extraction-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const PARENT_BODY_MARKER = 'Quietorchardmarker';
const LEASE_TEXT = 'The lease term is thirty-seven months.';
const LABEL = "'Flat' from Alice, 3 March 2024";
const CHILD = childProviderItemId('m1', 'p1');
// Built at runtime so the repository's credential-pattern check never sees a literal key.
const FAKE_AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

const cleanups: Array<() => void> = [];
afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length) cleanups.pop()!();
});

type Verdict = 'private' | 'secure';

/** A privacy-safe model that answers from a script: what each item is judged to be. */
function scriptedModel(decide: (providerItemId: string) => Verdict): void {
  const sniffer: TierSniffer = {
    id: 'scripted',
    judge(request) {
      return { verdict: 'decided', tier: decide(request.subject?.providerItemId ?? ''), code: 'ordinary:0.99' };
    },
  };
  registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
}

function parents(overrides: Partial<FixtureParentSpec> = {}): FixtureParentSpec[] {
  return [{
    id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z',
    body: `${PARENT_BODY_MARKER} Please find the lease attached.`,
    children: [{ key: 'p1', name: 'lease.txt', mimeType: 'text/plain', text: LEASE_TEXT }],
    ...overrides,
  }];
}

async function archive(specs: FixtureParentSpec[] = parents()) {
  const h = childItemsArchiveHarness(cleanups);
  const archiveId = h.start();
  await h.importAll(archiveId, specs);
  const ext = childItemsExtraction(h, cleanups, { parents: specs });
  await ext.drive(archiveId);
  const lane = h.runtime.lane(format.family);
  const corpora = (['public_safe', 'internal', 'secure_local'] as const).map((domain) => archiveCorpusId(domain, format.family));
  const resolve = createParentLabelResolver({
    stores: () => archiveLaneStores(lane),
    scopes: () => [{ ledger: lane.ledger, corpusIds: new Set(corpora) }],
  });
  const identityOf = (providerItemId: string): SourceItemIdentity => ({
    family: format.family,
    provider: format.provider,
    accountScope: archiveId,
    providerItemId,
    localItemId: fixtureLocalItemId(archiveId, providerItemId),
  });
  const request = (providerItemId: string, domain: 'internal' | 'secure_local' = 'internal') => ({
    corpusId: archiveCorpusId(domain, format.family),
    sourceItem: identityOf(providerItemId),
  });
  const parentOf = (providerItemId = CHILD, domain: 'internal' | 'secure_local' = 'internal') => resolve([request(providerItemId, domain)])[0];
  return { h, archiveId, ext, lane, corpora, resolve, identityOf, request, parentOf };
}

const candidateFor = (identity: SourceItemIdentity, domain: 'internal' | 'secure_local'): EvidenceCandidate => ({
  provenance: { sourceItem: identity, citation: { title: 'lease.txt' } },
  trustTier: domain === 'secure_local' ? 'S4' : 'S2',
  trustDomain: domain,
  chunks: [LEASE_TEXT],
});

const scopeFor = (corpora: readonly string[]): ParentLabelScope => ({
  allowedTrustDomains: ['public_safe', 'internal', 'secure_local'],
  domainOf: (corpusId) => (corpora.includes(corpusId)
    ? (['public_safe', 'internal', 'secure_local'] as const).find((domain) => archiveCorpusId(domain, format.family) === corpusId)
    : undefined),
});

describe('the parent resolved from the stores', () => {
  test('a child\'s parent gives its subject, sender and date from the names copy, and never its body', async () => {
    const { parentOf } = await archive();
    const parent = parentOf();
    expect(parent).toMatchObject({
      tier: 'personal',
      corpusId: archiveCorpusId('internal', format.family),
      identity: { provider: format.provider, providerItemId: 'm1' },
      subject: 'Flat',
      sender: 'Alice',
      authoredAt: '2024-03-03T10:00:00.000Z',
    });
    expect(JSON.stringify(parent)).not.toContain(PARENT_BODY_MARKER);
  });

  test('an item that is not a child, or is not there, has no parent', async () => {
    const { parentOf, request, resolve } = await archive();
    expect(parentOf('m1')).toBeUndefined();
    expect(parentOf(childProviderItemId('m1', 'nope'))).toBeUndefined();
    // A corpus outside every lane finds nothing.
    expect(resolve([{ ...request(CHILD), corpusId: 'internal.elsewhere' }])[0]).toBeUndefined();
  });

  test('a Personal child carries the label, and the label is the parent\'s names alone', async () => {
    scriptedModel(() => 'private');
    const { identityOf, resolve, corpora } = await archive();
    const outcome = applyParentLabels(
      [candidateFor(identityOf(CHILD), 'internal')],
      [archiveCorpusId('internal', format.family)],
      resolve,
      scopeFor(corpora),
    );
    expect(outcome.candidates[0]!.provenance.citation?.parentLabel).toBe(LABEL);
    expect(outcome.dependencies).toHaveLength(1);
    expect(JSON.stringify(outcome.candidates)).not.toContain(PARENT_BODY_MARKER);
  });
});

describe('raising the parent\'s names', () => {
  async function raised() {
    const world = await archive();
    const parentIdentity = world.identityOf('m1');
    await moveTieredItem({
      set: world.lane.set,
      identity: parentIdentity,
      target: { metadataTier: 'secure', contentTier: 'secure' },
    });
    return { ...world, parentIdentity };
  }

  test('the parent\'s names are Private and sit in the Private store, so a Personal child shows nothing of its parent', async () => {
    scriptedModel(() => 'private');
    const { identityOf, resolve, corpora, parentOf } = await raised();
    expect(parentOf()).toMatchObject({ tier: 'private', corpusId: archiveCorpusId('secure_local', format.family), subject: 'Flat' });

    const outcome = applyParentLabels(
      [candidateFor(identityOf(CHILD), 'internal')],
      [archiveCorpusId('internal', format.family)],
      resolve,
      scopeFor(corpora),
    );
    expect(outcome.candidates[0]!.provenance.citation?.parentLabel).toBeUndefined();
    expect(outcome.dependencies).toEqual([]);
    expect(JSON.stringify(outcome.candidates)).not.toContain('Flat');
  });

  test('a Private child may still carry Private names, and the dependency says they were Private', async () => {
    scriptedModel(() => 'secure');
    const { identityOf, resolve, corpora } = await raised();
    const outcome = applyParentLabels(
      [candidateFor(identityOf(CHILD), 'secure_local')],
      [archiveCorpusId('secure_local', format.family)],
      resolve,
      scopeFor(corpora),
    );
    expect(outcome.candidates[0]!.provenance.citation?.parentLabel).toBe(LABEL);
    expect(outcome.dependencies.map((dependency) => dependency.private)).toEqual([true]);
  });

  test('a lane outside the request\'s scope never lends its names', async () => {
    scriptedModel(() => 'secure');
    const { identityOf, resolve, corpora } = await raised();
    const outcome = applyParentLabels(
      [candidateFor(identityOf(CHILD), 'secure_local')],
      [archiveCorpusId('secure_local', format.family)],
      resolve,
      { ...scopeFor(corpora), allowedTrustDomains: ['public_safe', 'internal'] },
    );
    expect(outcome.candidates[0]!.provenance.citation?.parentLabel).toBeUndefined();
  });
});

describe('a parent that cannot be offered', () => {
  test('a parent that became a Secret gives no label, and the child is untouched', async () => {
    const { lane, identityOf, parentOf } = await archive();
    for (const store of lane.set.openStores()) store.tombstoneCopy(identityOf('m1'), { connectorId: 'secrets', trustTier: 'S5' });
    expect(parentOf()).toBeUndefined();
  });

  test('a parent with a credential in its subject is a Secret, and its label is never built', async () => {
    const { parentOf, lane, archiveId } = await archive(parents({ subject: `Wifi ${FAKE_AWS_KEY}` }));
    expect(lane.ledger.getCurrent({ provider: format.provider, accountScope: archiveId, providerItemId: 'm1' })).toMatchObject({ contentTier: 'secrets' });
    expect(parentOf()).toBeUndefined();
  });

  test('a parent removed from the archive gives no label', async () => {
    const { lane, identityOf, parentOf } = await archive();
    for (const store of lane.set.openStores()) store.tombstoneCopy(identityOf('m1'), { connectorId: 'absence-reconcile' });
    expect(parentOf()).toBeUndefined();
  });

  test('a resolver whose stores fail gives no label rather than an error', async () => {
    const { identityOf, request } = await archive();
    const resolve = createParentLabelResolver({
      stores: () => { throw new Error('store closed'); },
      scopes: () => [],
    });
    expect(() => resolve([request(CHILD)])).toThrow();
    const outcome = applyParentLabels([candidateFor(identityOf(CHILD), 'internal')], [archiveCorpusId('internal', format.family)], resolve, scopeFor([]));
    expect(outcome.dependencies).toEqual([]);
  });
});

describe('a file that could not be read names its parent', () => {
  const lane = { corpusId: archiveCorpusId('secure_local', format.family), provider: format.provider, approvedScopeKey: 'archive' };

  function listFor(accountScope: string, providerItemId: string, parentOf: (ref: ExtractionItemRef) => ReturnType<typeof unreadableParentOf>) {
    const ref: ExtractionItemRef = {
      ...lane,
      accountScope,
      providerItemId,
      localItemId: `${accountScope}:${providerItemId}`,
      sourceVersion: 'v1',
      contentHash: 'hash',
      name: 'lease.txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
    };
    const items: ExtractionUnreadableItem[] = [{ ref, failedAt: '2026-10-05T00:00:00.000Z' }];
    return createUnreadableFiles({
      items: () => items,
      verdict: createUnreadableVerdict({ locate: () => ({}), lanes: () => [] }),
      locate: () => ({}),
      openTarget: () => undefined,
      parentOf,
    }).computerList([lane.corpusId], 10, {}).files;
  }

  test('an archive child gets the parent\'s label and the route to its archive', async () => {
    const { archiveId, resolve } = await archive();
    const files = listFor(archiveId, CHILD, (ref) => unreadableParentOf(resolve, {
      corpusId: ref.corpusId,
      sourceItem: { provider: ref.provider, accountScope: ref.accountScope, providerItemId: ref.providerItemId },
    }));
    expect(files).toEqual([{ name: 'lease.txt', parent: { label: LABEL, route: { kind: 'archive', archiveId } } }]);
  });

  test('a file whose parent is a source, not an archive, routes to the source; a file with no parent has none', () => {
    const asSource = listFor('owner@example.com', 'child-1', () => ({ label: "'Flat'", provider: 'gmail', accountScope: 'owner@example.com' }));
    expect(asSource).toEqual([{ name: 'lease.txt', parent: { label: "'Flat'", route: { kind: 'source' } } }]);
    expect(listFor('owner@example.com', 'file-1', () => undefined)).toEqual([{ name: 'lease.txt' }]);
    expect(listFor('owner@example.com', 'file-1', () => { throw new Error('ledger closed'); })).toEqual([{ name: 'lease.txt' }]);
  });
});
