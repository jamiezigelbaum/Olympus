import { expect, test } from 'bun:test';
import { FIXTURE_ITEMS, SUITE_QUESTIONS } from '../scripts/release-check/fixture.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { createConnectorStoreCorpusAdapter, createConnectorStoreContentProvider, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { searchPrivateEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { fixtureConnector, identityOf, openTierFixture, tempDir, FIXTURE_PLACEMENT } from './helpers/tier-fixtures.ts';

test('release-check medical and Personal questions never surface the router Secret', async () => {
  const { dir, cleanup } = tempDir('release-retrieval-');
  const fixture = openTierFixture(dir, { embed: false });
  try {
    for (const item of FIXTURE_ITEMS) {
      fixture.ledger.setOverride(identityOf(item.key), { kind: 'tier', tier: item.tier === 'personal' ? 'private' : item.tier === 'private' ? 'secure' : 'secrets' });
    }
    await fixture.set.sync(fixtureConnector(() => FIXTURE_ITEMS.map(item => ({
      id: item.key, name: item.document.title, text: item.document.summary,
    }))), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const stores = fixture.set.openStores();
    const lanes = () => ({
      registry: buildSourceIndexCorpusRegistry(stores.map(store => defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }))),
      adapters: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
      contentProviders: Object.fromEntries(stores.map(store => [store.corpusId, createConnectorStoreContentProvider({ store })])),
      secretLocations: (query: string, searched: readonly string[]) => searched.includes(fixture.stores.secure_local!.corpusId) ? fixture.secrets.search(query, {}) : [],
    });
    for (const locator of [undefined, '/backup/Olympus/records/vault']) {
      // Exercise a Secret whose harmless name was judged Personal separately.
      // A whole-item Secret override above withholds the name too, which would
      // make a negative relevance assertion pass without testing the matcher.
      const identity = identityOf('router-password');
      const router = fixture.secrets.get(identity)!;
      const effectiveLocator = locator ?? router.locator;
      fixture.secrets.record({ identity, ...(effectiveLocator ? { locator: effectiveLocator } : {}),
        title: FIXTURE_ITEMS.find(item => item.key === 'router-password')!.document.title,
        namesReleasable: true, findingKinds: router.findingKinds });
      for (const question of SUITE_QUESTIONS.filter(question => question.kind !== 'secret')) {
        const found = await searchPrivateEvidence({ question: question.text, lanes });
        expect({ question: question.id, secretMatch: found.secretMatch ?? false }).toEqual({ question: question.id, secretMatch: false });
        if (question.kind === 'private') expect(found.candidates.map(item => item.provenance.sourceItem.providerItemId)).toContain('cardiology');
      }
      const direct = await searchPrivateEvidence({ question: 'Home network credentials', lanes });
      expect(direct.secretMatch).toBe(true);
    }
  } finally { fixture.close(); cleanup(); }
});

// The fixture's router item, with safe names and a locator under an ordinary
// backup directory. Paths are searchable, but shared request words or the
// substring "up" in "backup" must not announce an unrelated Secret.
test('Secret locations require topic overlap on complete words', () => {
  const index = new SecretLocationsIndex({ dbPath: ':memory:' });
  const item = FIXTURE_ITEMS.find(item => item.key === 'router-password')!;
  try {
    index.record({
      identity: { provider: 'fixture', accountScope: 'personal', providerItemId: item.document.id },
      title: item.document.title, namesReleasable: true,
      locator: '/backup/Olympus/records/vault', findingKinds: ['owner_marked_secret'],
    });
    const medical = SUITE_QUESTIONS.find(question => question.kind === 'private')!;
    expect(index.search(medical.text, {})).toEqual([]);
    for (const question of SUITE_QUESTIONS.filter(question => question.kind !== 'secret')) {
      expect({ question: question.id, matches: index.search(question.text, {}) }).toEqual({ question: question.id, matches: [] });
    }
    expect(index.search(item.document.title, {})).toHaveLength(1);
    expect(index.search('vault', {})).toHaveLength(1);
    expect(index.search('home network', {})).toHaveLength(1);
    expect(index.search('home network credentials archive', {})).toHaveLength(1);
    expect(index.search('home inspection contractor appointment', {})).toEqual([]);
    expect(index.search('record', {})).toEqual([]);
    expect(index.search('Use my Olympus records', {})).toEqual([]);
    expect(index.search('up', {})).toEqual([]);
  } finally { index.close(); }
});

// #1321: the release check's Wi-Fi question missed a Secret file named
// home-wifi.txt. Spelling ("Wi-Fi") and the kind of Secret ("password" for a
// credential) now count; unrelated Secrets still stay quiet.
test('a Secret is found by its spelling variants and by the everyday word for its kind', () => {
  const index = new SecretLocationsIndex({ dbPath: ':memory:' });
  try {
    index.record({
      identity: { provider: 'fixture', accountScope: 'personal', providerItemId: 'wifi' },
      title: 'home-wifi.txt', namesReleasable: true,
      locator: '/Documents/home-wifi.txt', findingKinds: ['credential_assignment'],
    });
    index.record({
      identity: { provider: 'fixture', accountScope: 'personal', providerItemId: 'deploy' },
      title: 'deploy.env', namesReleasable: true,
      locator: '/Code/deploy.env', findingKinds: ['api_secret_token'],
    });
    const found = (query: string) => index.search(query, {}).map((match) => match.locator);
    for (const query of ['what is my home Wi-Fi password?', 'Search Olympus: what is my home Wi-Fi password?', 'wifi password', 'home Wi-Fi password', 'home-wifi', 'Wi‑Fi']) {
      expect({ query, found: found(query) }).toEqual({ query, found: ['/Documents/home-wifi.txt'] });
    }
    expect(found('deploy api key')).toEqual(['/Code/deploy.env']);
    // A hyphen the name or kind spells as two words still matches them split.
    index.record({
      identity: { provider: 'fixture', accountScope: 'personal', providerItemId: 'aws' },
      title: 'cloud notes.txt', namesReleasable: true,
      locator: '/Documents/cloud notes.txt', findingKinds: ['aws_access_key_id'],
    });
    expect(found('AWS access-key')).toEqual(['/Documents/cloud notes.txt']);
    expect(found('my cloud-notes')).toEqual(['/Documents/cloud notes.txt']);
    // Still a whole-word overlap on the topic: these name neither Secret.
    for (const query of ['my bank password', 'garden hose length', 'wi', 'office printer password reset']) {
      expect({ query, found: found(query) }).toEqual({ query, found: [] });
    }
  } finally { index.close(); }
});

test('a withheld name stays unsearchable, joined or split', () => {
  const index = new SecretLocationsIndex({ dbPath: ':memory:' });
  try {
    index.record({
      identity: { provider: 'fixture', accountScope: 'personal', providerItemId: 'hidden' },
      title: 'Note', namesReleasable: false,
      locator: '/Private/home-wifi.txt', findingKinds: ['credential_assignment'],
    });
    expect(index.search('home wifi', {})).toEqual([]);
    expect(index.search('home-wifi', {})).toEqual([]);
  } finally { index.close(); }
});
