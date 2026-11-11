// #1295: the owner's Dropbox folder choice decides which paths are names-only.
// Synthetic approval only.
import { expect, test } from 'bun:test';
import { dropboxNamesOnlyByOwner } from '../src/workers/source-scope-runtime.ts';

function authority(approval: Record<string, unknown> | undefined) {
  let reads = 0;
  const fake = {
    policyRef: () => (approval ? { sourceId: 'dropbox.files', accountGeneration: 'g1', revision: 'r1' } : undefined),
    assertCurrent: () => { reads += 1; return approval; },
  };
  return { fake: fake as never, reads: () => reads };
}

const approved = {
  sourceId: 'dropbox.files', status: 'approved', revision: 'r1', wholeAccount: false,
  selections: [
    { key: '/Projects', state: 'ingest' },
    { key: '/Archive', state: 'metadata_only' },
    { key: '/Private', state: 'exclude' },
  ],
};

test('only a path under a names-only folder is names-only; ingest, excluded and unselected paths are not', () => {
  const namesOnly = dropboxNamesOnlyByOwner(authority(approved).fake);
  expect(namesOnly('/Archive/2019/scan.pdf')).toBe(true);
  expect(namesOnly('/archive/2019/scan.pdf')).toBe(true);
  expect(namesOnly('/Projects/plan.pdf')).toBe(false);
  expect(namesOnly('/Private/key.txt')).toBe(false);
  expect(namesOnly('/Elsewhere/note.txt')).toBe(false);
});

test('no approval: nothing is names-only', () => {
  expect(dropboxNamesOnlyByOwner(authority(undefined).fake)('/Archive/scan.pdf')).toBe(false);
});

test('the approval is read once for many items, and again after a few seconds', () => {
  let clock = 0;
  const source = authority(approved);
  const namesOnly = dropboxNamesOnlyByOwner(source.fake, () => clock);
  for (let i = 0; i < 1000; i += 1) namesOnly(`/Archive/${i}.pdf`);
  expect(source.reads()).toBe(1);
  clock = 5_000;
  namesOnly('/Archive/again.pdf');
  expect(source.reads()).toBe(2);
});
