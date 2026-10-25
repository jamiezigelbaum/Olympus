// A Dropbox file that is edited after it was read is read again.
//
// The metadata pull of an edited file advances the item's revision and content
// hash and leaves the chunks of the revision it replaced in place. The
// extraction source used to ask only for items with no chunks, so the edit was
// never read and every search kept answering from the old text.
//
// Three properties are under test, and each has a negative control beside it:
//   - an edited file becomes a candidate, an unchanged one does not (a re-list
//     of the same revision rewrites the item's content hash and must not count
//     as an edit);
//   - the new text replaces the old through the normal sink, and the file is
//     settled once its current revision has been read;
//   - the job for the edit is a new job keyed by revision, beside the settled
//     one for the revision it replaced, so a settled job never has to reopen.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { computeDropboxContentHash } from '../src/workers/dropbox-files/dropbox-content-hash.ts';
import {
  DropboxExtractionSource,
  type DropboxExtractionFetch,
} from '../src/workers/dropbox-files/extraction-source.ts';
import { connectorStoreExtractionCandidateReader } from '../src/workers/email-source/file-extraction-runtime.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import { createFileExtractionRunner } from '../src/workers/file-extraction/runner.ts';
import { createConnectorStoreExtractionSink } from '../src/workers/file-extraction/store-sink.ts';
import type { Extractor, ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const PROVIDER = 'dropbox';
const ACCOUNT = 'personal';
const SCOPE_KEY = 'dropbox.personal:/Files';
const EXTRACTOR_KIND = 'plain_text_fixture';
const LANE = {
  corpusId: CORPUS_ID,
  provider: PROVIDER,
  accountScope: ACCOUNT,
  approvedScopeKey: SCOPE_KEY,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function openStore(dbPath = ':memory:', readOnly = false): LocalConnectorStore {
  const store = new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    ...(readOnly ? { readOnly: true } : {}),
  });
  cleanups.push(() => store.close());
  return store;
}

interface Doc {
  id: string;
  /** Dropbox's revision id: it changes with the bytes. */
  rev: string;
  /** What the file reads as at that revision. */
  text: string;
}

const localItemId = (doc: Pick<Doc, 'id'>): string => `${ACCOUNT}:id:${doc.id}`;

/** The metadata-sync view of a Dropbox file: names, revision and digest, no text. */
function dropboxItem(doc: Doc, options: { text?: boolean } = {}): RawItem {
  const bytes = new TextEncoder().encode(doc.text);
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: `id:${doc.id}`,
      providerFileId: `id:${doc.id}`,
      localItemId: localItemId(doc),
      sourceVersion: doc.rev,
    },
    mimeType: 'text/plain',
    content: options.text ? { kind: 'text', text: doc.text } : { kind: 'metadata_only' },
    metadata: Object.freeze({
      entryKind: 'file',
      deleted: false,
      name: `${doc.id}.txt`,
      mimeType: 'text/plain',
      pathDisplay: `/Files/${doc.id}.txt`,
      pathLower: `/files/${doc.id}.txt`,
      sizeBytes: bytes.byteLength,
      ...(options.text ? {} : { contentHash: computeDropboxContentHash(bytes) }),
    }),
    fetchedAt: '2026-10-13T00:00:00.000Z',
  };
}

function listing(docs: () => readonly Doc[], options: { text?: boolean } = {}): SourceConnector {
  return {
    id: 'dropbox-fixture-sync',
    family: 'file',
    async authenticate() {},
    async *listItems(): AsyncIterable<SourceConnectorListPage> {
      yield { items: docs().map((doc) => dropboxItem(doc, options)), done: true };
    },
    async fetchItem(id: string): Promise<RawItem> {
      const found = docs().find((doc) => localItemId(doc) === id);
      if (!found) throw new Error(`no such item: ${id}`);
      return dropboxItem(found, options);
    },
    classificationSignals: () => ({}),
  };
}

const PLACEMENT = { trustTier: 'S2', trustDomain: 'secure_local' } as const;

/** The pull: metadata only, as the Dropbox lane runs it. */
async function pull(store: LocalConnectorStore, docs: readonly Doc[]): Promise<void> {
  await store.syncFromConnector(listing(() => docs), { fetchContent: false, placement: PLACEMENT });
}

/** The text was read in the same pass that listed the file (a lane that fetches content). */
async function pullWithText(store: LocalConnectorStore, docs: readonly Doc[]): Promise<void> {
  await store.syncFromConnector(listing(() => docs, { text: true }), { fetchContent: true, placement: PLACEMENT });
}

function ids(page: { candidates: readonly { identity: { providerItemId: string } }[] }): string[] {
  return page.candidates.map((candidate) => candidate.identity.providerItemId).sort();
}

const extractionCandidates = (store: LocalConnectorStore, includeStaleChunks: boolean): string[] => ids(
  store.extractionCandidates({ limit: 50, withoutChunksOnly: true, ...(includeStaleChunks ? { includeStaleChunks } : {}) }),
);

function sinkFor(store: LocalConnectorStore) {
  return createConnectorStoreExtractionSink({
    store,
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
    syncConnectorId: 'file-extraction-factory',
    ownerConnectorId: 'dropbox-fixture-sync',
    ownershipKind: 'observed',
  });
}

function sinkRequest(doc: Doc, text = doc.text): ExtractionSinkRequest {
  return {
    ref: {
      corpusId: CORPUS_ID,
      provider: PROVIDER,
      accountScope: ACCOUNT,
      approvedScopeKey: SCOPE_KEY,
      providerItemId: `id:${doc.id}`,
      localItemId: localItemId(doc),
      sourceVersion: doc.rev,
      mimeType: 'text/plain',
      name: `${doc.id}.txt`,
    },
    text,
    extractorKind: EXTRACTOR_KIND,
    extractorVersion: 'test',
    fetchedAt: '2026-10-13T01:00:00.000Z',
  };
}

const storedText = (store: LocalConnectorStore, doc: Pick<Doc, 'id'>): string[] =>
  [...(store.localContent(localItemId(doc))?.chunks ?? [])];

describe('the store tells an edited file from an unchanged one', () => {
  test('an edit leaves the file listable as stale; unchanged and never-read files stay out', async () => {
    const store = openStore();
    const a: Doc = { id: 'A', rev: 'a-r1', text: 'alpha first draft' };
    const b: Doc = { id: 'B', rev: 'b-r1', text: 'bravo stays as it was' };
    const c: Doc = { id: 'C', rev: 'c-r1', text: 'charlie was never read' };
    await pullWithText(store, [a, b]);
    await pull(store, [c]);
    expect(extractionCandidates(store, true)).toEqual(['id:C']);

    // The next pull: A was edited, B is listed again at the same revision.
    await pull(store, [{ ...a, rev: 'a-r2', text: 'alpha second draft with new words' }, b, c]);

    // Without the flag nothing changed for anyone: the edit is invisible.
    expect(extractionCandidates(store, false)).toEqual(['id:C']);
    expect(extractionCandidates(store, true)).toEqual(['id:A', 'id:C']);
    // The old text is still what the store holds for A until it is read again.
    expect(storedText(store, a)).toEqual(['alpha first draft']);
    const listed = store.extractionCandidates({ limit: 50, withoutChunksOnly: true, includeStaleChunks: true });
    const staleA = listed.candidates.find((candidate) => candidate.identity.providerItemId === 'id:A')!;
    expect(staleA.storedChunks).toBe(1);
    expect(staleA.identity.sourceVersion).toBe('a-r2');
    expect(store.itemTextIsStale(localItemId(a))).toBe(true);
    expect(store.itemTextIsStale(localItemId(b))).toBe(false);
    expect(store.itemTextIsStale(localItemId(c))).toBe(false);
  });

  test('two edits before a re-read stay stale, and a return to the revision that was read settles it', async () => {
    const store = openStore();
    const a: Doc = { id: 'A', rev: 'a-r1', text: 'alpha first draft' };
    await pullWithText(store, [a]);
    await pull(store, [{ ...a, rev: 'a-r2', text: 'second' }]);
    await pull(store, [{ ...a, rev: 'a-r3', text: 'third' }]);
    expect(extractionCandidates(store, true)).toEqual(['id:A']);

    await pull(store, [a]);
    expect(extractionCandidates(store, true)).toEqual([]);
    expect(store.itemTextIsStale(localItemId(a))).toBe(false);
  });

  test('new text for the current revision replaces the old and settles the file', async () => {
    const store = openStore();
    const a: Doc = { id: 'A', rev: 'a-r1', text: 'alpha first draft' };
    const edited: Doc = { id: 'A', rev: 'a-r2', text: 'alpha second draft with new words' };
    await pull(store, [a]);
    expect((await sinkFor(store).accept(sinkRequest(a))).accepted).toBe(true);
    expect(extractionCandidates(store, true)).toEqual([]);

    await pull(store, [edited]);
    expect(extractionCandidates(store, true)).toEqual(['id:A']);

    const result = await sinkFor(store).accept(sinkRequest(edited));
    expect(result.accepted).toBe(true);
    expect(storedText(store, edited)).toEqual(['alpha second draft with new words']);
    expect(store.searchItems('first', 10)).toEqual([]);
    expect(store.searchItems('second', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:A']);
    expect(extractionCandidates(store, true)).toEqual([]);
    expect(store.itemTextIsStale(localItemId(edited))).toBe(false);
  });

  test('an edit that left the words alone is settled by reading it, not listed forever', async () => {
    const store = openStore();
    const a: Doc = { id: 'A', rev: 'a-r1', text: 'the words do not change' };
    await pull(store, [a]);
    await sinkFor(store).accept(sinkRequest(a));

    const touched: Doc = { ...a, rev: 'a-r2' };
    await pull(store, [touched]);
    expect(extractionCandidates(store, true)).toEqual(['id:A']);

    expect((await sinkFor(store).accept(sinkRequest(touched))).accepted).toBe(true);
    expect(storedText(store, touched)).toEqual(['the words do not change']);
    expect(extractionCandidates(store, true)).toEqual([]);
  });

  test('re-listing an unchanged file after it was read is not an edit', async () => {
    const store = openStore();
    const a: Doc = { id: 'A', rev: 'a-r1', text: 'alpha first draft' };
    await pull(store, [a]);
    await sinkFor(store).accept(sinkRequest(a));
    // The listing writes the provider's digest back over the content hash the
    // read left on the item; the revision is the same, so nothing is stale.
    await pull(store, [a]);
    await pull(store, [a]);
    expect(extractionCandidates(store, true)).toEqual([]);
    expect(store.itemTextIsStale(localItemId(a))).toBe(false);
  });

  test('a store opened without the record still lists, and gains the record when opened for writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-text-versions-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'store.sqlite');
    const a: Doc = { id: 'A', rev: 'a-r1', text: 'alpha first draft' };
    const writable = openStore(path);
    await pullWithText(writable, [a]);
    writable.close();

    // A store from before the record: no table, no trigger. Schema version is
    // left as it was, because the record is added idempotently on open.
    const raw = new Database(path);
    raw.exec('DROP TRIGGER connector_store_item_text_version_capture; DROP TABLE item_text_versions;');
    const version = raw.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get() as { version: number };
    raw.close();

    const readOnly = openStore(path, true);
    expect(extractionCandidates(readOnly, true)).toEqual([]);
    expect(readOnly.itemTextIsStale(localItemId(a))).toBe(false);
    readOnly.close();

    const reopened = openStore(path);
    await pull(reopened, [{ ...a, rev: 'a-r2' }]);
    expect(extractionCandidates(reopened, true)).toEqual(['id:A']);
    reopened.close();

    const after = new Database(path);
    const names = (after.query("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')").all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(['item_text_versions', 'connector_store_item_text_version_capture']));
    expect((after.query("SELECT version FROM schema_version WHERE store_id = 'connector-store'").get() as { version: number }).version)
      .toBe(version.version);
    after.close();
  });
});

describe('the Dropbox extraction lane reads an edited file again', () => {
  function lane() {
    const store = openStore();
    const jobs = new LocalFileExtractionJobStore(':memory:');
    cleanups.push(() => jobs.close());
    const revisionText = new Map<string, string>();
    const downloads: string[] = [];
    const fetchImpl: DropboxExtractionFetch = async (_url, init) => {
      const argument = JSON.parse(init.headers['Dropbox-API-Arg']!) as { path: string };
      downloads.push(argument.path);
      const text = revisionText.get(argument.path.replace(/^rev:/, ''));
      if (text === undefined) return new Response('{}', { status: 409 });
      return new Response(new TextEncoder().encode(text), { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    const source = new DropboxExtractionSource({
      id: `${CORPUS_ID}:extraction`,
      corpusId: CORPUS_ID,
      provider: PROVIDER,
      token: 'test-token',
      candidates: connectorStoreExtractionCandidateReader(store),
      locators: store,
      scopes: [{ approvedScopeKey: SCOPE_KEY }],
      fetch: fetchImpl,
    });
    const extractor: Extractor = {
      kind: EXTRACTOR_KIND,
      version: 'test',
      input: { kind: 'bytes', maxInputBytes: Number.MAX_SAFE_INTEGER },
      egress: 'local',
      accepts: () => true,
      async extract(input) {
        const text = new TextDecoder().decode(input.bytes);
        return { status: 'indexed', text, derivations: [{ artifactKind: 'document', chars: text.length }] };
      },
    };
    const runner = createFileExtractionRunner({
      jobs,
      registry: buildExtractorRegistry([extractor], [EXTRACTOR_KIND]),
      corpora: [{
        corpusId: CORPUS_ID,
        trustDomain: 'secure_local',
        source,
        sink: createConnectorStoreExtractionSink({
          store,
          classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
          syncConnectorId: 'file-extraction-factory',
          ownerConnectorId: 'dropbox-fixture-sync',
          ownershipKind: 'observed',
          claims: jobs,
        }),
      }],
    });
    return {
      store,
      jobs,
      runner,
      downloads,
      /** The provider's bytes for one revision. */
      publish(doc: Doc) {
        revisionText.set(doc.rev, doc.text);
      },
    };
  }

  test('an edited file is planned, read at its new revision, and its new text replaces the old; an unchanged file is never touched', async () => {
    const { store, jobs, runner, downloads, publish } = lane();
    const a1: Doc = { id: 'A', rev: 'a-r1', text: 'alpha first draft about harbours' };
    const b1: Doc = { id: 'B', rev: 'b-r1', text: 'bravo notes that never change' };
    publish(a1);
    publish(b1);

    // First read of both.
    await pull(store, [a1, b1]);
    expect((await runner.plan({ ...LANE, limit: 20 })).jobsQueued).toBe(2);
    expect((await runner.run({ ...LANE })).counts.indexed).toBe(2);
    expect(storedText(store, a1)).toEqual([a1.text]);
    downloads.length = 0;

    // Nothing changed: the next plan has nothing to say.
    const idle = await runner.plan({ ...LANE, limit: 20 });
    expect(idle.candidates).toBe(0);
    expect(idle.jobsQueued).toBe(0);

    // A is edited. The pull moves its revision and digest; its chunks stay.
    const a2: Doc = { id: 'A', rev: 'a-r2', text: 'alpha second draft about lighthouses' };
    publish(a2);
    await pull(store, [a2, b1]);
    expect(storedText(store, a2)).toEqual([a1.text]);

    const edited = await runner.plan({ ...LANE, limit: 20 });
    expect(edited.candidates).toBe(1);
    expect(edited.jobsQueued).toBe(1);
    expect(edited.jobsExisting).toBe(0);
    const reread = await runner.run({ ...LANE });
    expect(reread.counts.indexed).toBe(1);

    // Only the edited file was fetched, and at the new revision.
    expect(downloads).toEqual(['rev:a-r2']);
    expect(storedText(store, a2)).toEqual([a2.text]);
    expect(storedText(store, b1)).toEqual([b1.text]);
    expect(store.searchItems('harbours', 10)).toEqual([]);
    expect(store.searchItems('lighthouses', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:A']);

    // The file is settled: another plan, and a re-list of the same revisions,
    // queue nothing.
    expect((await runner.plan({ ...LANE, limit: 20 })).candidates).toBe(0);
    await pull(store, [a2, b1]);
    const settled = await runner.plan({ ...LANE, limit: 20 });
    expect(settled.candidates).toBe(0);
    expect(settled.jobsQueued).toBe(0);
    expect(downloads).toEqual(['rev:a-r2']);

    // The edit got its own job beside the settled one for the old revision.
    expect(jobs.counts(LANE).find((entry) => entry.status === 'indexed')?.jobs).toBe(3);
  });

  test('a second edit is read again too, and an edit made while the first is still unread is read once, at the latest revision', async () => {
    const { store, runner, downloads, publish } = lane();
    const v1: Doc = { id: 'A', rev: 'a-r1', text: 'version one text' };
    const v2: Doc = { id: 'A', rev: 'a-r2', text: 'version two text' };
    const v3: Doc = { id: 'A', rev: 'a-r3', text: 'version three text' };
    for (const doc of [v1, v2, v3]) publish(doc);

    await pull(store, [v1]);
    await runner.plan({ ...LANE, limit: 20 });
    await runner.run({ ...LANE });
    downloads.length = 0;

    // Two edits land before anything reads the first of them.
    await pull(store, [v2]);
    await pull(store, [v3]);
    expect((await runner.plan({ ...LANE, limit: 20 })).jobsQueued).toBe(1);
    await runner.run({ ...LANE });
    expect(downloads).toEqual(['rev:a-r3']);
    expect(storedText(store, v3)).toEqual([v3.text]);

    // And a later edit still gets its turn.
    const v4: Doc = { id: 'A', rev: 'a-r4', text: 'version four text' };
    publish(v4);
    await pull(store, [v4]);
    expect((await runner.plan({ ...LANE, limit: 20 })).jobsQueued).toBe(1);
    await runner.run({ ...LANE });
    expect(storedText(store, v4)).toEqual([v4.text]);
  });
});
