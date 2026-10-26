import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishLinuxEngineReceipt, resolveLinuxEngineLayout } from '../src/core/linux-engine-layout.ts';
import { defaultSourceSchedulerStateDbPath } from '../src/workers/source-scheduler-state.ts';
import { defaultFileExtractionJobsDbPath } from '../src/workers/file-extraction/job-store.ts';
import { resolveEmbeddingLedgerPath } from '../src/workers/embedding-ledger.ts';
import { resolveClassificationLedgerPath } from '../src/workers/classification-ledger.ts';
import { builtInEmbeddingPaths } from '../src/workers/source-index/built-in-embedding/assets.ts';
import { defaultRemoteConnectionsDbPath } from '../src/core/remote-connections.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';

type Env = Record<string, string | undefined>;
const store = (sourceId: string, tier: string) => (env: Env) => resolvedStorePath(sourceId, tier, env);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// [resolver, the file it has always been, and where a new account of a source with account
// folders puts it (docs/design/source-storage.md, step 4a)].
const paths = [
  [store('dropbox.files', 'secure_local'), 'dropbox-files-connector-store.sqlite', 'sources/dropbox.files/1/stores/secure_local.sqlite'],
  [store('gmail.email', 'internal'), 'gmail-connector-store.sqlite', 'sources/gmail.email/1/stores/internal.sqlite'],
  [store('google_drive.docs', 'internal'), 'google-drive-connector-store.sqlite', 'sources/google_drive.docs/1/stores/internal.sqlite'],
  [store('readwise.library', 'internal'), 'readwise-connector-store.sqlite', 'sources/readwise.library/1/stores/internal.sqlite'],
  [store('x.bookmarks', 'internal'), 'x-bookmarks-connector-store.sqlite', 'sources/x.bookmarks/1/stores/internal.sqlite'],
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
    // A legacy install has its stores at the legacy paths, and an account that has files there stays there.
    // A fresh one (nothing stored yet) places a new account in its folder.
    const where = (file: string, folderFile?: string): string => (legacy ? file : folderFile ?? file);
    if (legacy) {
      mkdirSync(expected, { recursive: true, mode: 0o700 });
      for (const [, file, folderFile] of paths) if (folderFile) writeFileSync(join(expected, file), '');
    }
    const drift = { ...env, XDG_DATA_HOME: join(home, 'different') };
    for (const [resolve, file, folderFile] of paths) expect(resolve(drift)).toBe(join(expected, where(file, folderFile)));
    expect(builtInEmbeddingPaths(drift).root).toBe(join(expected, 'models/built-in-embedding'));
    // A hosted process retains its original namespace even alongside an engine receipt.
    const hosted = { ...env, OPENCLAW_STATE_DIR: join(home, '.openclaw') };
    for (const [resolve, file, folderFile] of paths) expect(resolve(hosted)).toBe(join(env.XDG_DATA_HOME, 'openclaw/olympus', where(file, folderFile)));
  });
}
