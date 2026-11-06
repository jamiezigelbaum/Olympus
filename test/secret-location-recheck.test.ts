import { expect, test } from 'bun:test';
import { SecretLocationsIndex, secretLocationFingerprint } from '../src/workers/classification/secret-locations.ts';

test('rechecks the current screened location under scope and parent visibility', () => {
  const index = new SecretLocationsIndex({ dbPath: ':memory:' });
  const identity = { provider: 'fixture', accountScope: 'a', providerItemId: 'one' };
  try {
    index.record({ identity, locator: '/allowed/keys', title: 'Keys', namesReleasable: true, findingKinds: ['credential_assignment'] });
    const found = index.search('keys', { accountScope: 'a' })[0]!;
    const old = { source: found.source, ref: found.ref, fingerprint: secretLocationFingerprint(found) };
    const scope = { accountScope: 'a', filters: { locatorPathScope: '/allowed' } };
    expect(index.recheck(old, scope)).toBe(true);
    expect(index.recheck(old, { accountScope: 'b' })).toBe(false);
    expect(index.recheck(old, scope, { hide: ids => new Set(ids) })).toBe(false);
    index.record({ identity, locator: '/allowed/keys', title: 'Keys', namesReleasable: false, findingKinds: ['credential_assignment'] });
    expect(index.recheck(old, scope)).toBe(false);
    index.remove(identity);
    expect(index.recheck(old, scope)).toBe(false);
  } finally { index.close(); }
});
