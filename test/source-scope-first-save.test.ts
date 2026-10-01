// Owner live test, 2026-10-01: the first Dropbox folder save from ChatGPT
// failed with "The source scope changed. Reload it before saving." The save
// itself had succeeded; its response waited on the whole first sync, outlived
// the ChatGPT tool call, and the retry carried the revision that save had just
// replaced. Connect → browse → save must succeed the first time, and the
// approval must not wait for the sync it starts.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApprovedSourceRun } from '../src/workers/email-source/server.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function connectDropbox(): FileSourceScopeAuthority {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-first-save-'));
  dirs.push(dir);
  const registryPath = join(dir, 'handles.json');
  // What a completed relay sign-in writes: one Dropbox handle with the sync capability.
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox',
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: [],
      connectedAt: '2026-10-01T13:55:46.105Z',
      accountRole: 'personal',
    }],
  }));
  return new FileSourceScopeAuthority({ registryPath });
}

test('connect → browse → save succeeds the first time, and a stale retry is a conflict', () => {
  const authority = connectDropbox();
  const browsed = authority.snapshot('dropbox.files');
  expect(browsed.status).toBe('scope_pending');
  expect(browsed.accountGeneration).toBeString();
  // A second browse (expanding a folder) sees the same revision.
  expect(authority.snapshot('dropbox.files').revision).toBe(browsed.revision);
  const saved = authority.approve({
    sourceId: 'dropbox.files',
    accountGeneration: browsed.accountGeneration!,
    expectedRevision: browsed.revision,
    selections: [{ key: '/projects', state: 'ingest' }, { key: '/archive', state: 'metadata_only' }],
    wholeAccount: false,
    explicitWholeAccountConfirmation: false,
  });
  expect(saved.status).toBe('approved');
  expect(authority.snapshot('dropbox.files').revision).toBe(saved.revision);
  // The same save sent again with the pre-save revision is the conflict the
  // ChatGPT surface answers with the fresh list (setup-tools.ts scopeSet).
  expect(() => authority.approve({
    sourceId: 'dropbox.files',
    accountGeneration: browsed.accountGeneration!,
    expectedRevision: browsed.revision,
    selections: [{ key: '/projects', state: 'ingest' }],
    wholeAccount: false,
    explicitWholeAccountConfirmation: false,
  })).toThrow('The source scope changed');
});

test('the same save delivered twice answers with the approval it made; a different stale save is still a conflict', () => {
  // Owner fresh-install test, 2026-10-01 (second report): connect → browse →
  // save still failed "the first time" although the approval was on disk.
  // Nothing but a save writes this state, so the revision a browse returned
  // moves only when a save lands; the failing request was the second delivery
  // of the save that had just landed.
  const authority = connectDropbox();
  const browsed = authority.snapshot('dropbox.files');
  const request = {
    sourceId: 'dropbox.files' as const,
    accountGeneration: browsed.accountGeneration!,
    expectedRevision: browsed.revision,
    selections: [
      { key: '/projects', state: 'ingest' as const, ancestorKeys: [] },
      { key: '/projects/old', state: 'exclude' as const, ancestorKeys: ['/projects'] },
    ],
    wholeAccount: false,
    explicitWholeAccountConfirmation: false,
  };
  const first = authority.approve(request);
  expect(first.replayed).toBeUndefined();
  const onDisk = readFileSync(authority.statePath, 'utf8');
  const again = authority.approve(request);
  expect(again).toMatchObject({ status: 'approved', revision: first.revision, replayed: true });
  // Nothing was written by the replay.
  expect(readFileSync(authority.statePath, 'utf8')).toBe(onDisk);
  // A different decision on the old revision is a real conflict.
  expect(() => authority.approve({ ...request, selections: [{ key: '/projects', state: 'metadata_only', ancestorKeys: [] }] }))
    .toThrow('The source scope changed');
  expect(() => authority.approve({ ...request, wholeAccount: true, explicitWholeAccountConfirmation: true, selections: [] }))
    .toThrow('The source scope changed');
  // A save on the current revision still works, and the first request replayed
  // after it is now stale.
  const next = authority.approve({ ...request, expectedRevision: first.revision, selections: [{ key: '/archive', state: 'ingest', ancestorKeys: [] }] });
  expect(next.revision).not.toBe(first.revision);
  expect(() => authority.approve(request)).toThrow('The source scope changed');
  // A reconnect (new grant generation) never inherits a replay.
  expect(() => authority.approve({ ...request, expectedRevision: first.revision, accountGeneration: 'f'.repeat(64) }))
    .toThrow('The connected account changed');
});

test('the first sync after a scope approval runs in the background, not inside the save', async () => {
  let started = 0;
  let finish!: () => void;
  const scheduler = {
    runSource: () => {
      started++;
      return new Promise<never>((_resolve, reject) => { finish = () => reject(new Error('provider down')); });
    },
  };
  const returned = startApprovedSourceRun(scheduler as never, 'dropbox.files');
  expect(returned).toBeUndefined();
  expect(started).toBe(1);
  // A failing run is logged, never an unhandled rejection.
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (message: string) => { warnings.push(message); };
  try {
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    console.warn = warn;
  }
  expect(warnings.join('\n')).toContain('source=dropbox.files');
});
