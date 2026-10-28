// Every store gets its vectors one way, whatever source filled it. A store
// that per-item routing, an import, or a later read fills has no sync of its
// own that could queue it; per-source embed wiring is how such a store once
// stayed keyword-only for good (Evernote's Personal store, test-mac
// 2026-10-28). So: no source declares its own embed task, and the one
// store-level plan gives every store served by meaning a store-wide catch-up.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import { archiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { QUEUE_ONLY_METERED_EMBEDDING, planStoreEmbedding } from '../src/workers/connector-store/embedding-plan.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { RecordingProvider } from './helpers/tier-fixtures.ts';

const SRC = new URL('../src/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('embedding paths', () => {
  test('the shared sweep is the only embed task: no source wires its own', () => {
    const declaring = sourceFiles(SRC)
      .filter((path) => /kind:\s*'embed'/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path));
    expect(declaring).toEqual(['workers/source-scheduler.ts']);
    const scheduler = readFileSync(join(SRC, 'workers/source-scheduler.ts'), 'utf8');
    expect(scheduler.match(/kind:\s*'embed'/g)).toHaveLength(1);
    expect(scheduler).toMatch(/function embeddingSweepTask\([\s\S]*?kind: 'embed'/);
  });

  test('every store served by meaning catches up store-wide, whether or not a sync of its own fills it', () => {
    const corpora = [...defaultSourceCorpusRegistryConfig().corpora, ...archiveImportCorpora()]
      .filter((corpus) => corpus.activationMode !== 'lexical_only');
    // The stores per-item routing or an import fills are among them.
    expect(corpora.some((corpus) => !(corpus.capabilities ?? []).includes('sync'))).toBe(true);
    const missing = corpora.filter((corpus) => {
      const provider = corpus.trustDomain === 'secure_local'
        ? new RecordingProvider('built-in', 'embeddinggemma', 'local')
        : new RecordingProvider('google-gemini', 'gemini-embedding-2', 'cloud');
      const store = { corpusId: corpus.corpusId, trustDomain: corpus.trustDomain } as unknown as LocalConnectorStore;
      const target = planStoreEmbedding({ store, provider, servedByMeaning: true, scope: { allowed: true } });
      return target?.wholeStore !== true && QUEUE_ONLY_METERED_EMBEDDING[corpus.corpusId] === undefined;
    }).map((corpus) => corpus.corpusId);
    expect(missing).toEqual([]);
  });
});
