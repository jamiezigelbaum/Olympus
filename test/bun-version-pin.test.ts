import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '..');
const EXPECTED_BUN_VERSION = '1.3.14';

describe('Bun version pin', () => {
  test('keeps local development and CI on the dist-producing Bun version', () => {
    const localVersion = readFileSync(join(ROOT, '.bun-version'), 'utf8').trim();
    const verifyWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'verify.yml'), 'utf8');

    expect(localVersion).toBe(EXPECTED_BUN_VERSION);
    expect(verifyWorkflow).toContain(`bun-version: ${EXPECTED_BUN_VERSION}`);
    expect(verifyWorkflow).not.toContain('bun-version: latest');
  });
});
