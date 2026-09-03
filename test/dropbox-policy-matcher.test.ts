import { describe, expect, test } from 'bun:test';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { dropboxCanonicalIngestionMatcher } from '../src/workers/dropbox-files/connector-store.ts';

describe('Dropbox canonical policy matcher', () => {
  test('registers and attributes every path_contains criterion', () => {
    const policy = defaultDropboxIngestionPolicy();
    const matcher = dropboxCanonicalIngestionMatcher(policy, {});
    const contains = matcher.criteria.filter((criterion) => criterion.prefix.startsWith('contains:'));
    expect(contains.map((criterion) => criterion.prefix)).toContain('contains:books');
    expect(matcher.evaluatePath('/3 Resources/Books/notes.pdf')).toMatchObject({
      disposition: 'metadata_only',
      ruleId: 'dropbox-policy-2',
      prefix: 'contains:books',
    });
  });

  test('enforces an explicit root prefix instead of advertising a dead rule', () => {
    const policy = defaultDropboxIngestionPolicy();
    policy.rules = [{
      match: { path_prefixes: ['/'] },
      action: 'metadata_only',
      reason: 'root_metadata_only',
    }];
    const matcher = dropboxCanonicalIngestionMatcher(policy, {});
    expect(matcher.criteria).toContainEqual(expect.objectContaining({ prefix: '/' }));
    expect(matcher.evaluatePath('/anything/private.pdf')).toMatchObject({
      disposition: 'metadata_only',
      ruleId: 'dropbox-policy-1',
      prefix: '/',
    });
  });
});
