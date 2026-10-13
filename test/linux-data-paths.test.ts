import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishLinuxEngineReceipt, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { defaultDropboxConnectorStoreDbPath } from '../src/workers/dropbox-files/connector-store.ts';
import { defaultGmailConnectorStoreDbPath } from '../src/workers/google-connectors/gmail.ts';
import { defaultGoogleDriveConnectorStoreDbPath } from '../src/workers/google-connectors/drive.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/connector.ts';
import { defaultXBookmarksConnectorStoreDbPath } from '../src/workers/x-bookmarks/connector.ts';
import { defaultSourceSchedulerStateDbPath } from '../src/workers/source-scheduler-state.ts';
import { defaultFileExtractionJobsDbPath } from '../src/workers/file-extraction/job-store.ts';
import { resolveEmbeddingLedgerPath } from '../src/workers/embedding-ledger.ts';
import { resolveClassificationLedgerPath } from '../src/workers/classification-ledger.ts';
import { builtInEmbeddingPaths } from '../src/workers/source-index/built-in-embedding/assets.ts';
import { defaultRemoteConnectionsDbPath } from '../src/core/remote-connections.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const paths = [
  [defaultDropboxConnectorStoreDbPath, 'dropbox-files-connector-store.sqlite'],
  [defaultGmailConnectorStoreDbPath, 'gmail-connector-store.sqlite'],
  [defaultGoogleDriveConnectorStoreDbPath, 'google-drive-connector-store.sqlite'],
  [defaultReadwiseConnectorStoreDbPath, 'readwise-connector-store.sqlite'],
  [defaultXBookmarksConnectorStoreDbPath, 'x-bookmarks-connector-store.sqlite'],
  [defaultSourceSchedulerStateDbPath, 'source-scheduler.sqlite'],
  [defaultFileExtractionJobsDbPath, 'file-extraction-jobs.sqlite'],
  [resolveEmbeddingLedgerPath, 'embedding-ledger.jsonl'],
  [resolveClassificationLedgerPath, 'classification-ledger.jsonl'],
  [defaultRemoteConnectionsDbPath, 'remote-connections.sqlite'],
] as const;
for (const legacy of [false, true]) {
  test.skipIf(process.platform !== 'linux')(`standalone ${legacy ? 'legacy' : 'fresh'} stores and models follow receipt across shell XDG drift`, () => {
    const home = mkdtempSync(join(tmpdir(), 'linux-data-')); roots.push(home);
    const env = { HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_RUNTIME_DIR: join(home, 'run') };
    mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    const layout = resolveLinuxEngineLayout(env);
    const receipt = publishLinuxEngineReceipt(layout);
    const expected = join(env.XDG_DATA_HOME, legacy ? 'openclaw/olympus' : 'olympus');
    if (legacy) writeFileSync(layout.receiptPath, JSON.stringify({ ...receipt, layout: { ...layout, dataDir: expected, packageDir: join(env.XDG_DATA_HOME, 'olympus/engine') } }), { mode: 0o600 });
    const drift = { ...env, XDG_DATA_HOME: join(home, 'different') };
    for (const [resolve, file] of paths) expect(resolve(drift)).toBe(join(expected, file));
    expect(builtInEmbeddingPaths(drift).root).toBe(join(expected, 'models/built-in-embedding'));
    // A hosted process retains its original namespace even alongside an engine receipt.
    const hosted = { ...env, OPENCLAW_STATE_DIR: join(home, '.openclaw') };
    for (const [resolve, file] of paths) expect(resolve(hosted)).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus', file));
  });
}
