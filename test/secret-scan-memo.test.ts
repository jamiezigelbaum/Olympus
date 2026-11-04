// A large text screened by several steps in a row is scanned once.

import { describe, expect, spyOn, test } from 'bun:test';
import * as contentPolicy from '../src/workers/dropbox-files/content-policy.ts';
import { detectSecretFindingKinds } from '../src/workers/classification/engine.ts';

describe('secret scan of a large text', () => {
  test('repeated screening of the same large text reuses the first scan, and the result is unchanged', () => {
    const body = 'ordinary chat line about lunch\n'.repeat(12_000);
    const secret = `${body}aws key ${['AKIA', 'IOSFODNN7EXAMPLQ'].join('')} in the middle\n${body}`;
    const spy = spyOn(contentPolicy, 'scanDropboxContentPolicyText');
    try {
      const first = detectSecretFindingKinds(secret);
      const again = detectSecretFindingKinds(secret);
      const clean = detectSecretFindingKinds(`${body}${body}`);
      expect(first.length).toBeGreaterThan(0);
      expect(again).toEqual(first);
      expect(clean).toEqual([]);
      // Two distinct texts, two scans: the repeat of the first was reused.
      expect(spy).toHaveBeenCalledTimes(2);
      again.push('mutated');
      expect(detectSecretFindingKinds(secret)).toEqual(first);
    } finally {
      spy.mockRestore();
    }
  });

  test('short texts are always scanned afresh', () => {
    const spy = spyOn(contentPolicy, 'scanDropboxContentPolicyText');
    try {
      detectSecretFindingKinds('short note');
      detectSecretFindingKinds('short note');
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
