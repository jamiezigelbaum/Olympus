import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileExtractionRuntime, createRefreshableFileExtractionRuntime } from '../src/workers/email-source/file-extraction-runtime.ts';

test('closed extraction cannot open another queue when a source appears after shutdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'extraction-close-'));
  let generation = 0;
  let refreshes = 0;
  const jobsPath = () => join(dir, `jobs-${generation}.sqlite`);
  const runtime = createRefreshableFileExtractionRuntime({
    generation: () => generation,
    beforeCurrent: () => { refreshes += 1; },
    build: () => createFileExtractionRuntime({ enabled: true, allowEmpty: true, connectorStores: [], corpora: [], env: {}, jobsDbPath: jobsPath() }),
  })!;
  try {
    expect(existsSync(jobsPath())).toBe(true);
    expect(runtime.runner.corpusIds()).toEqual([]);
    runtime.close();
    const refreshedBeforeClose = refreshes;
    generation += 1;
    expect(() => runtime.runner.corpusIds()).toThrow(/closed/i);
    expect(existsSync(jobsPath())).toBe(false);
    expect(runtime.corpusIds).toEqual([]);
    expect(refreshes).toBe(refreshedBeforeClose);
    expect(() => runtime.close()).not.toThrow();
  } finally {
    // A failing regression may have opened another real SQLite queue.
    try { runtime.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
