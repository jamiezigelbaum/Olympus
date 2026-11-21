import { expect, test } from 'bun:test';
import { SecretLocationsIndex, secretLocationFingerprint } from '../src/workers/classification/secret-locations.ts';

import { standaloneSecretParents } from './helpers/tier-fixtures.ts';

test('rechecks the current screened location under scope and parent visibility', () => {
  const parents = standaloneSecretParents();
  const index = new SecretLocationsIndex({ dbPath: ':memory:' });
  const identity = { provider: 'fixture', accountScope: 'a', providerItemId: 'one' };
  try {
    index.record({ identity, locator: '/allowed/keys', title: 'Keys', namesReleasable: true, findingKinds: ['credential_assignment'] });
    expect(index.get(identity)).not.toHaveProperty('locator');
    const found = index.search('keys', { accountScope: 'a' }, parents)[0]!;
    const old = { source: found.source, ref: found.ref, fingerprint: secretLocationFingerprint(found) };
    const scope = { accountScope: 'a', filters: { locatorPathScope: '/allowed' } };
    expect(index.recheck(old, scope, parents)).toBe(true);
    expect(index.recheck(old, { accountScope: 'b' }, parents)).toBe(false);
    expect(index.recheck(old, scope, { ...parents, plans: [] })).toBe(false);
    index.record({ identity, locator: '/allowed/keys', title: 'Keys', namesReleasable: false, findingKinds: ['credential_assignment'] });
    expect(index.recheck(old, scope, parents)).toBe(false);
    index.remove(identity);
    expect(index.recheck(old, scope, parents)).toBe(false);
  } finally { parents.close(); index.close(); }
});
