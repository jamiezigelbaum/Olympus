import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// How each tool opens the store: scripts/ goes through the storage service
// (test/store-open-guard.test.ts); eval/ is outside that guard.
const READ_ONLY_TOOLS = {
  'eval/run-real.ts': 'new LocalConnectorStore({',
  'scripts/source-eval-pack-inspect.ts': 'openConnectorStore({ sourceId: DROPBOX_FILES_SOURCE_ID }, {',
} as const;

describe('private eval store access', () => {
  for (const [relativePath, opener] of Object.entries(READ_ONLY_TOOLS)) {
    test(`${relativePath} opens only the canonical connector store query-only`, () => {
      const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');

      expect(source).toContain(opener);
      expect(source).toContain('readOnly: true');
      expect(source).toContain('createConnectorStoreCorpusAdapter({');
      expect(source).toContain('createConnectorStoreContentProvider({');
      // The store Olympus places for the Dropbox account, or the copy OLYMPUS_EVAL_DROPBOX_STORE names; never a retired override.
      expect(source).toContain("resolvedStorePath('dropbox.files', 'secure_local')");
      expect(source).toContain('OLYMPUS_EVAL_DROPBOX_STORE');
      expect(source).not.toContain('OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH');
      expect(source).not.toContain('LocalDropboxFilesIndex');
      expect(source).not.toContain('OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_DB_PATH');
    });
  }
});
