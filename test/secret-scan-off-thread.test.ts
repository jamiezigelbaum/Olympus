// A large text's secret scan made on the second thread must give the same
// kinds the classifier would have found itself, and be what it then reuses.

import { describe, expect, test } from 'bun:test';
import {
  detectSecretFindingKinds,
  scanSecretFindingKinds,
  secretScanRemembered,
} from '../src/workers/classification/engine.ts';
import { scanSecretsAhead } from '../src/workers/classification/secret-scan-off-thread.ts';

// Over the 256 KiB reuse threshold; the filler differs per test so no two share a scan.
function large(tag: string, secret: string): string {
  const filler = `Meeting notes ${tag}: lunch on Friday, the venue, the agenda.\n`.repeat(6_000);
  return `${filler}${secret}\n${filler}`;
}

describe('secret scan ahead, off the worker thread', () => {
  test('a large text with a key is remembered with the kinds the scan finds', async () => {
    const text = large('a', 'my aws key is AKIAABCDEFGHIJKLMNOP');
    expect(text.length).toBeGreaterThan(256 * 1024);
    expect(secretScanRemembered(text)).toBe(false);
    await scanSecretsAhead(text);
    expect(secretScanRemembered(text)).toBe(true);
    // Written expectation: an AWS access key id is a secret kind.
    expect(detectSecretFindingKinds(text)).toContain('aws_access_key_id');
    expect(detectSecretFindingKinds(text)).toEqual(scanSecretFindingKinds(text));
  });

  test('a large clean text is remembered as clean', async () => {
    const text = large('b', 'nothing secret here');
    await scanSecretsAhead(text);
    expect(secretScanRemembered(text)).toBe(true);
    expect(detectSecretFindingKinds(text)).toEqual([]);
  });

  test('a small text is left to the classifier', async () => {
    const text = 'my aws key is AKIAABCDEFGHIJKLMNOP';
    await scanSecretsAhead(text);
    expect(secretScanRemembered(text)).toBe(false);
    expect(detectSecretFindingKinds(text)).toContain('aws_access_key_id');
  });
});
