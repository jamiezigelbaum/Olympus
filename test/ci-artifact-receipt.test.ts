import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  createArtifactReceipt,
  verifyArtifactReceipt,
} from '../scripts/ci-artifact-receipt.ts';

// The imported receipt helper invokes Bun.spawnSync for Git identity; keep this
// test in the deploy lane even though the process call is encapsulated.

const ROOT = join(import.meta.dir, '..');

describe('CI artifact receipt', () => {
  test('binds an artifact to its digest and the exact source tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ci-receipt-'));
    const artifact = join(dir, 'olympus.tgz');
    try {
      writeFileSync(artifact, 'artifact bytes');
      const receipt = createArtifactReceipt(ROOT, artifact);
      expect(receipt.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
      expect(receipt.sourceTree).toMatch(/^[a-f0-9]{40}$/);
      expect(receipt.dependencyLockSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() => verifyArtifactReceipt(ROOT, artifact, receipt, { requireCurrentTree: true }))
        .not.toThrow();

      writeFileSync(artifact, 'tampered artifact bytes');
      expect(() => verifyArtifactReceipt(ROOT, artifact, receipt)).toThrow(/Artifact (size|digest) mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('serialized receipts verify without hidden state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ci-receipt-'));
    const artifact = join(dir, 'olympus.tgz');
    const receiptPath = join(dir, 'receipt.json');
    try {
      writeFileSync(artifact, 'artifact bytes');
      writeFileSync(receiptPath, JSON.stringify(createArtifactReceipt(ROOT, artifact)));
      const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
      expect(() => verifyArtifactReceipt(ROOT, artifact, parsed)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
