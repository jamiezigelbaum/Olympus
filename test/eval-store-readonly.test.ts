import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const READ_ONLY_TOOLS = [
  'eval/run-real.ts',
  'scripts/source-eval-pack-inspect.ts',
] as const;

describe('private eval store access', () => {
  for (const relativePath of READ_ONLY_TOOLS) {
    test(`${relativePath} opens only the canonical connector store query-only`, () => {
      const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

      expect(source).toContain('new LocalConnectorStore({');
      expect(source).toContain('readOnly: true');
      expect(source).toContain('createConnectorStoreCorpusAdapter({');
      expect(source).toContain('createConnectorStoreContentProvider({');
      expect(source).toContain('OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH');
      expect(source).not.toContain('LocalDropboxFilesIndex');
      expect(source).not.toContain('OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_DB_PATH');
    });
  }
});
