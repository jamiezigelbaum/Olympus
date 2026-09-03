// Leg B9: the Dropbox FileExtractionSource.
//
// The properties under test are the ones the whole factory design rests on:
// identity is constructor data rather than a constant, the local mount is only
// ever trusted behind a content-hash equality gate, and an item that cannot be
// read surfaces as a bounded categorical outcome instead of provider prose.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DropboxExtractionSource,
  dropboxDownloadArg,
  parseDropboxExtractionLocalRootsFromEnv,
  type DropboxExtractionFetch,
  type DropboxItemLocatorReader,
} from '../src/workers/dropbox-files/extraction-source.ts';
import { computeDropboxContentHash } from '../src/workers/dropbox-files/dropbox-content-hash.ts';
import {
  isFileExtractionSourceError,
  type ExtractionCandidateReader,
  type ExtractionCandidateReaderOptions,
  type ExtractionCandidateReaderPage,
  type ExtractionCandidateRow,
} from '../src/core/file-extraction-source.ts';
import type { ExtractionItemRef } from '../src/workers/file-extraction/types.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';

// Compile-time proof that the locator port this leg declared is satisfied by
// the shared store as it stands today, with nothing added to it. If the store
// changes localContent's shape, this stops compiling rather than failing in
// production against a lane that quietly lost its local mount.
type StoreSatisfiesLocatorPort = LocalConnectorStore extends DropboxItemLocatorReader ? true : never;
const storeSatisfiesLocatorPort: StoreSatisfiesLocatorPort = true;

const CORPUS_ID = 'secure_local.dropbox.files';
const PROVIDER = 'dropbox';
// The live conventions, not invented ones: account scopes are bare
// ('personal'), and the approved scope key that names the lane prefixes the
// provider onto the account — 'dropbox.personal:/2 Areas'.
const ACCOUNT = 'personal';
const SCOPE_KEY = 'dropbox.personal:/2 Areas';

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'olympus-dropbox-extraction-'));
  tempRoots.push(root);
  return root;
}

async function writeAt(root: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function candidateReader(
  page: ExtractionCandidateReaderPage,
  seen?: ExtractionCandidateReaderOptions[],
): ExtractionCandidateReader {
  return {
    extractionCandidates(options) {
      seen?.push(options);
      return page;
    },
  };
}

function locatorReader(paths: Record<string, string>): DropboxItemLocatorReader {
  return {
    localContent(localItemId) {
      const locatorUri = paths[localItemId];
      return locatorUri ? { locatorUri } : undefined;
    },
  };
}

function neverFetch(): DropboxExtractionFetch {
  return () => {
    throw new Error('the provider must not be called in this test');
  };
}

function row(overrides: Partial<ExtractionCandidateRow> = {}): ExtractionCandidateRow {
  return {
    localItemId: `${ACCOUNT}:id:AbC123`,
    mimeType: 'application/pdf',
    locatorUri: '/2 Areas/Health/scan.pdf',
    sourceVersion: '0123456789abcdef',
    contentHash: 'a'.repeat(64),
    name: 'scan.pdf',
    ...overrides,
  };
}

function makeSource(options: {
  candidates?: ExtractionCandidateReader;
  locators?: DropboxItemLocatorReader;
  localRoots?: Array<{ rootPath: string; account?: string; approvedScopeKey?: string; dropboxPathPrefix?: string }>;
  fetch?: DropboxExtractionFetch;
  scopes?: Array<{ approvedScopeKey: string; pathPrefix?: string; account?: string }>;
  id?: string;
  corpusId?: string;
  provider?: string;
} = {}): DropboxExtractionSource {
  return new DropboxExtractionSource({
    id: options.id ?? 'dropbox.personal',
    corpusId: options.corpusId ?? CORPUS_ID,
    provider: options.provider ?? PROVIDER,
    token: 'test-token',
    candidates: options.candidates ?? candidateReader({ candidates: [], done: true }),
    scopes: options.scopes ?? [{ approvedScopeKey: SCOPE_KEY }],
    ...(options.locators ? { locators: options.locators } : {}),
    ...(options.localRoots ? { localRoots: options.localRoots } : {}),
    fetch: options.fetch ?? neverFetch(),
    contentBaseUrl: 'https://content.example.test/2',
  });
}

function refFor(overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: CORPUS_ID,
    provider: PROVIDER,
    accountScope: ACCOUNT,
    approvedScopeKey: SCOPE_KEY,
    providerItemId: 'id:AbC123',
    localItemId: `${ACCOUNT}:id:AbC123`,
    sourceVersion: '0123456789abcdef',
    mimeType: 'application/pdf',
    ...overrides,
  };
}

function streamedResponse(bytes: Uint8Array, init: ResponseInit = {}): Response {
  // A stream body so the response carries no content-length of its own, which
  // is how the post-read byte check is exercised independently of the header
  // pre-check.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, init);
}

describe('Dropbox extraction source: identity is data', () => {
  test('source id, corpus id and provider come from constructor options', () => {
    const source = makeSource({ id: 'dropbox.work', corpusId: 'secure_local.dropbox.archive', provider: 'dropbox' });
    expect(source.id).toBe('dropbox.work');
    expect(source.corpusId).toBe('secure_local.dropbox.archive');
    expect(source.provider).toBe('dropbox');

    // The same class serving a second corpus is a second construction, never a
    // second copy of the module.
    const other = makeSource({ id: 'dropbox.personal', corpusId: CORPUS_ID });
    expect(other.corpusId).toBe(CORPUS_ID);
    expect(other.id).not.toBe(source.id);
  });

  test('the refs a source emits carry its own corpus and provider', async () => {
    const source = makeSource({
      corpusId: 'secure_local.dropbox.archive',
      candidates: candidateReader({ candidates: [row()], done: true }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates[0]?.corpusId).toBe('secure_local.dropbox.archive');
    expect(page.candidates[0]?.provider).toBe(PROVIDER);
  });

  test('an empty id, corpus id or provider is refused at construction', () => {
    expect(() => makeSource({ id: '  ' })).toThrow();
    expect(() => makeSource({ corpusId: '' })).toThrow();
    expect(() => makeSource({ provider: '' })).toThrow();
  });

  test('the store port satisfies the declared locator seam', () => {
    expect(storeSatisfiesLocatorPort).toBe(true);
  });
});

describe('Dropbox extraction source: candidate enumeration', () => {
  test('reads zero-chunk candidates and derives the approved scope key from the path', async () => {
    const seen: ExtractionCandidateReaderOptions[] = [];
    const source = makeSource({
      candidates: candidateReader({ candidates: [row()], nextCursor: 'c2', done: false }, seen),
    });
    const page = await source.listCandidates({ limit: 25, mimeTypes: ['application/pdf'] });

    expect(seen[0]?.withoutChunksOnly).toBe(true);
    expect(seen[0]?.limit).toBe(25);
    expect(seen[0]?.mimeTypes).toEqual(['application/pdf']);
    expect(seen[0]?.accountScope).toBe(ACCOUNT);

    expect(page.done).toBe(false);
    expect(page.nextCursor).toBe('c2');
    expect(page.candidates).toHaveLength(1);
    const ref = page.candidates[0]!;
    expect(ref.approvedScopeKey).toBe(SCOPE_KEY);
    expect(ref.accountScope).toBe(ACCOUNT);
    expect(ref.providerItemId).toBe('id:AbC123');
    expect(ref.localItemId).toBe(`${ACCOUNT}:id:AbC123`);
    expect(ref.sourceVersion).toBe('0123456789abcdef');
    expect(ref.contentHash).toBe('a'.repeat(64));
    expect(ref.mimeType).toBe('application/pdf');
  });

  test('an account scope containing dots is split on the first separator only', async () => {
    const source = makeSource({
      scopes: [{ approvedScopeKey: 'dropbox.personal.archive:/2 Areas' }],
      candidates: candidateReader({
        candidates: [row({ localItemId: 'personal.archive:id:a:b:c' })],
        done: true,
      }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates[0]?.accountScope).toBe('personal.archive');
    expect(page.candidates[0]?.providerItemId).toBe('id:a:b:c');
    expect(page.candidates[0]?.approvedScopeKey).toBe('dropbox.personal.archive:/2 Areas');
  });

  test('an item outside every configured lane is not a candidate', async () => {
    const source = makeSource({
      candidates: candidateReader({
        candidates: [
          row({ locatorUri: '/1 Projects/secret.pdf' }),
          row({ localItemId: `${ACCOUNT}:id:keep`, locatorUri: '/2 Areas/Health/keep.pdf' }),
        ],
        done: true,
      }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]?.providerItemId).toBe('id:keep');
  });

  test('an item with no locator at all is not a candidate', async () => {
    const withoutLocator = row();
    delete withoutLocator.locatorUri;
    const source = makeSource({
      candidates: candidateReader({ candidates: [withoutLocator], done: true }),
    });
    expect((await source.listCandidates({ limit: 10 })).candidates).toEqual([]);
  });

  test('the longest matching path prefix claims the item', async () => {
    const source = makeSource({
      scopes: [
        { approvedScopeKey: 'dropbox.personal:/2 Areas' },
        { approvedScopeKey: 'dropbox.personal:/2 Areas/Health' },
      ],
      candidates: candidateReader({ candidates: [row()], done: true }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates[0]?.approvedScopeKey).toBe('dropbox.personal:/2 Areas/Health');
  });

  test('path matching is case-insensitive, as Dropbox paths are', async () => {
    const source = makeSource({
      candidates: candidateReader({ candidates: [row({ locatorUri: '/2 AREAS/Health/scan.pdf' })], done: true }),
    });
    expect((await source.listCandidates({ limit: 10 })).candidates).toHaveLength(1);
  });

  test('a lane whose account differs from the item never claims it', async () => {
    const source = makeSource({
      scopes: [{ approvedScopeKey: 'dropbox.business:/2 Areas' }],
      candidates: candidateReader({ candidates: [row()], done: true }),
    });
    expect((await source.listCandidates({ limit: 10 })).candidates).toEqual([]);
  });

  test('the caller may narrow enumeration to a subset of configured lanes', async () => {
    const source = makeSource({
      scopes: [
        { approvedScopeKey: 'dropbox.personal:/2 Areas' },
        { approvedScopeKey: 'dropbox.personal:/3 Resources' },
      ],
      candidates: candidateReader({ candidates: [row()], done: true }),
    });
    const narrowed = await source.listCandidates({
      limit: 10,
      approvedScopeKeys: ['dropbox.personal:/3 Resources'],
    });
    expect(narrowed.candidates).toEqual([]);

    const unknown = await source.listCandidates({ limit: 10, approvedScopeKeys: ['dropbox.personal:/9 Nope'] });
    expect(unknown.done).toBe(true);
    expect(unknown.candidates).toEqual([]);
  });

  test('a folder-id scope is refused at construction rather than silently matching nothing', () => {
    expect(() => makeSource({ scopes: [{ approvedScopeKey: 'dropbox.personal:folder_id:id:9' }] }))
      .toThrow(/pathPrefix/);
    expect(() => makeSource({
      scopes: [{ approvedScopeKey: 'dropbox.personal:folder_id:id:9', pathPrefix: '/2 Areas' }],
    })).not.toThrow();
  });

  test('a root-level lane claims files but not the root itself', async () => {
    const source = makeSource({
      scopes: [{ approvedScopeKey: 'dropbox.personal:/' }],
      candidates: candidateReader({
        candidates: [row({ locatorUri: '/anything.pdf' }), row({ localItemId: `${ACCOUNT}:id:root`, locatorUri: '/' })],
        done: true,
      }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]?.name).toBe('scan.pdf');
  });

  test('two lanes on different accounts stop the account filter being pushed down', async () => {
    const seen: ExtractionCandidateReaderOptions[] = [];
    const source = makeSource({
      scopes: [
        { approvedScopeKey: 'dropbox.personal:/2 Areas' },
        { approvedScopeKey: 'dropbox.business:/2 Areas' },
      ],
      candidates: candidateReader({ candidates: [], done: true }, seen),
    });
    await source.listCandidates({ limit: 10 });
    expect(seen[0]?.accountScope).toBeUndefined();
  });
});

describe('Dropbox extraction source: the local mount', () => {
  test('a local hit with a matching hash never touches the provider', async () => {
    const root = await makeRoot();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await writeAt(root, 'Health/scan.pdf', bytes);
    const contentHash = computeDropboxContentHash(bytes);

    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: neverFetch(),
    });

    const fetched = await source.fetch(refFor({ contentHash }), {});
    expect([...fetched.bytes]).toEqual([...bytes]);
    expect(fetched.sizeBytes).toBe(8);
    expect(fetched.mimeType).toBe('application/pdf');
  });

  test('a hash mismatch falls through to the provider instead of handing up the bytes', async () => {
    const root = await makeRoot();
    await writeAt(root, 'Health/scan.pdf', new Uint8Array([9, 9, 9]));
    const apiBytes = new Uint8Array([1, 2, 3]);
    let called = 0;

    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: () => {
        called += 1;
        return Promise.resolve(streamedResponse(apiBytes, { headers: { 'content-type': 'application/pdf' } }));
      },
    });

    const fetched = await source.fetch(refFor({ contentHash: computeDropboxContentHash(new Uint8Array([7])) }), {});
    expect(called).toBe(1);
    expect([...fetched.bytes]).toEqual([...apiBytes]);
  });

  test('a candidate resolving outside its root is refused', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const bytes = new Uint8Array([4, 5, 6]);
    await writeFile(join(outside, 'escaped.pdf'), bytes);
    let called = 0;

    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      // A traversal that would climb out of the configured root.
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: `/2 Areas/../../${join(outside, 'escaped.pdf')}` }),
      fetch: () => {
        called += 1;
        return Promise.resolve(streamedResponse(new Uint8Array([0])));
      },
    });

    await source.fetch(refFor({ contentHash: computeDropboxContentHash(bytes) }), {});
    expect(called).toBe(1);
  });

  test('a symlinked root is canonicalised before the containment check', async () => {
    const real = await makeRoot();
    const linkParent = await makeRoot();
    const link = join(linkParent, 'link');
    await symlink(real, link);
    const bytes = new Uint8Array([2, 4, 6, 8]);
    await writeAt(real, 'Health/scan.pdf', bytes);

    const source = makeSource({
      localRoots: [{ rootPath: link, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: neverFetch(),
    });
    const fetched = await source.fetch(refFor({ contentHash: computeDropboxContentHash(bytes) }), {});
    expect([...fetched.bytes]).toEqual([...bytes]);
  });

  test('a declared size that disagrees with the file on disk is refused', async () => {
    const root = await makeRoot();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await writeAt(root, 'Health/scan.pdf', bytes);
    let called = 0;

    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: () => {
        called += 1;
        return Promise.resolve(streamedResponse(new Uint8Array([0])));
      },
    });

    await source.fetch(refFor({ contentHash: computeDropboxContentHash(bytes), sizeBytes: 999 }), {});
    expect(called).toBe(1);
  });

  test('a local file over maxBytes is refused terminally, not re-downloaded to be refused again', async () => {
    const root = await makeRoot();
    const bytes = new Uint8Array(64).fill(7);
    await writeAt(root, 'Health/scan.pdf', bytes);

    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: neverFetch(),
    });

    const error = await source.fetch(refFor({ contentHash: computeDropboxContentHash(bytes) }), { maxBytes: 8 })
      .then(() => undefined, (caught: unknown) => caught);
    expect(isFileExtractionSourceError(error)).toBe(true);
    expect((error as { errorKind: string }).errorKind).toBe('source_too_large');
    expect((error as { settleAs: string }).settleAs).toBe('skipped_too_large');
  });

  test('a ref with no content hash never reads the mount at all', async () => {
    const root = await makeRoot();
    const bytes = new Uint8Array([1, 2, 3]);
    await writeAt(root, 'Health/scan.pdf', bytes);
    let called = 0;

    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: () => {
        called += 1;
        return Promise.resolve(streamedResponse(new Uint8Array([0])));
      },
    });

    const ref = refFor();
    delete (ref as { contentHash?: string }).contentHash;
    await source.fetch(ref, {});
    expect(called).toBe(1);
  });

  test('a root whose approved scope key differs from the ref is not eligible', async () => {
    const root = await makeRoot();
    const bytes = new Uint8Array([1, 2, 3]);
    await writeAt(root, 'Health/scan.pdf', bytes);
    let called = 0;

    const source = makeSource({
      localRoots: [{
        rootPath: root,
        account: ACCOUNT,
        approvedScopeKey: 'dropbox.personal:/3 Resources',
        dropboxPathPrefix: '/2 Areas',
      }],
      locators: locatorReader({ [`${ACCOUNT}:id:AbC123`]: '/2 Areas/Health/scan.pdf' }),
      fetch: () => {
        called += 1;
        return Promise.resolve(streamedResponse(new Uint8Array([0])));
      },
    });

    await source.fetch(refFor({ contentHash: computeDropboxContentHash(bytes) }), {});
    expect(called).toBe(1);
  });

  test('with no locator reader wired the source simply uses the provider', async () => {
    const root = await makeRoot();
    let called = 0;
    const source = makeSource({
      localRoots: [{ rootPath: root, account: ACCOUNT, dropboxPathPrefix: '/2 Areas' }],
      fetch: () => {
        called += 1;
        return Promise.resolve(streamedResponse(new Uint8Array([1])));
      },
    });
    await source.fetch(refFor({ contentHash: 'a'.repeat(64) }), {});
    expect(called).toBe(1);
  });
});

describe('Dropbox extraction source: the provider download', () => {
  test('the rev argument is chosen when a source version is present', async () => {
    expect(dropboxDownloadArg(refFor({ sourceVersion: 'abc123' }))).toEqual({ path: 'rev:abc123' });
    expect(dropboxDownloadArg(refFor({ sourceVersion: 'rev:abc123' }))).toEqual({ path: 'rev:abc123' });

    const args: string[] = [];
    const source = makeSource({
      fetch: (_url, init) => {
        args.push(init.headers['Dropbox-API-Arg']!);
        return Promise.resolve(streamedResponse(new Uint8Array([1])));
      },
    });
    await source.fetch(refFor({ sourceVersion: 'deadbeef' }), {});
    expect(JSON.parse(args[0]!)).toEqual({ path: 'rev:deadbeef' });
  });

  test('the bare item id is used when no source version is present', async () => {
    const ref = refFor();
    delete (ref as { sourceVersion?: string }).sourceVersion;
    expect(dropboxDownloadArg(ref)).toEqual({ path: 'id:AbC123' });

    const args: string[] = [];
    const source = makeSource({
      fetch: (_url, init) => {
        args.push(init.headers['Dropbox-API-Arg']!);
        return Promise.resolve(streamedResponse(new Uint8Array([1])));
      },
    });
    await source.fetch(ref, {});
    expect(JSON.parse(args[0]!)).toEqual({ path: 'id:AbC123' });
  });

  test('an oversized content-length is refused before the body is read', async () => {
    let bodyRead = false;
    const source = makeSource({
      fetch: () => {
        const response = new Response('xx', { headers: { 'content-length': '999999' } });
        // A body that refuses to be read: if the header pre-check did not
        // short-circuit, this test fails with the wrong error rather than
        // quietly passing on a body that happened to be small.
        Object.defineProperty(response, 'arrayBuffer', {
          value: () => {
            bodyRead = true;
            return Promise.reject(new Error('the body must not be read'));
          },
        });
        return Promise.resolve(response);
      },
    });

    const error = await source.fetch(refFor(), { maxBytes: 16 }).then(() => undefined, (caught: unknown) => caught);
    expect((error as { errorKind: string }).errorKind).toBe('source_too_large');
    expect(bodyRead).toBe(false);
  });

  test('an oversized body is refused even when the provider declared nothing', async () => {
    const source = makeSource({
      fetch: () => Promise.resolve(streamedResponse(new Uint8Array(64).fill(3))),
    });
    const error = await source.fetch(refFor(), { maxBytes: 16 }).then(() => undefined, (caught: unknown) => caught);
    expect((error as { errorKind: string }).errorKind).toBe('source_too_large');
    expect((error as { settleAs: string }).settleAs).toBe('skipped_too_large');
  });

  test('bytes and the declared size come back from the provider response', async () => {
    const source = makeSource({
      fetch: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { 'content-type': 'application/pdf', 'content-length': '4' },
      })),
    });
    const fetched = await source.fetch(refFor(), {});
    expect([...fetched.bytes]).toEqual([1, 2, 3, 4]);
    expect(fetched.sizeBytes).toBe(4);
    expect(fetched.mimeType).toBe('application/pdf');
  });
});

describe('Dropbox extraction source: the unreadable item', () => {
  async function failWith(status: number, body = 'boom'): Promise<{
    errorKind: string;
    settleAs: string;
    retryable: boolean;
    errorHash?: string;
    message: string;
  }> {
    const source = makeSource({
      fetch: () => Promise.resolve(new Response(body, { status })),
    });
    const caught = await source.fetch(refFor(), {}).then(() => undefined, (error: unknown) => error);
    expect(isFileExtractionSourceError(caught)).toBe(true);
    return caught as never;
  }

  test('a deleted-since-enqueue item is terminal', async () => {
    const error = await failWith(409, 'path/not_found/... /2 Areas/Health/scan.pdf');
    expect(error.errorKind).toBe('source_item_not_found');
    expect(error.settleAs).toBe('failed_terminal');
    expect(error.retryable).toBe(false);
  });

  test('a revoked permission is terminal', async () => {
    const error = await failWith(403);
    expect(error.errorKind).toBe('source_permission_denied');
    expect(error.settleAs).toBe('failed_terminal');
  });

  test('a missing item is terminal', async () => {
    expect((await failWith(404)).errorKind).toBe('source_item_not_found');
  });

  test('a rate limit is retryable', async () => {
    const error = await failWith(429);
    expect(error.errorKind).toBe('source_rate_limited');
    expect(error.settleAs).toBe('failed_retryable');
    expect(error.retryable).toBe(true);
  });

  test('a provider outage is retryable', async () => {
    const error = await failWith(503);
    expect(error.errorKind).toBe('source_unavailable');
    expect(error.retryable).toBe(true);
  });

  test('an expired token is retryable', async () => {
    expect((await failWith(401)).errorKind).toBe('source_auth_expired');
  });

  test('a rejected request is terminal rather than retried identically forever', async () => {
    const error = await failWith(400);
    expect(error.errorKind).toBe('source_request_rejected');
    expect(error.settleAs).toBe('failed_terminal');
  });

  test('a transport that never reached the provider is retryable and says nothing about the item', async () => {
    const source = makeSource({
      fetch: () => Promise.reject(new Error('ECONNREFUSED 162.125.0.1:443')),
    });
    const error = await source.fetch(refFor(), {}).then(() => undefined, (caught: unknown) => caught) as {
      errorKind: string;
      retryable: boolean;
      message: string;
    };
    expect(error.errorKind).toBe('network_unreachable');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('162.125');
  });

  test('no provider text, path or filename reaches the error', async () => {
    const error = await failWith(409, 'path/not_found/... /2 Areas/Health/scan.pdf');
    expect(error.message).toBe('source_item_not_found');
    expect(error.message).not.toContain('scan.pdf');
    expect(error.errorHash).toMatch(/^[a-f0-9]{32}$/);
    expect(error.errorHash).not.toContain('scan');
  });
});

describe('Dropbox extraction source: verifyBytes', () => {
  test('true when the bytes hash to the ref content hash', () => {
    const source = makeSource();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(source.verifyBytes(refFor({ contentHash: computeDropboxContentHash(bytes) }), bytes)).toBe(true);
  });

  test('false when they do not', () => {
    const source = makeSource();
    expect(source.verifyBytes(refFor({ contentHash: 'b'.repeat(64) }), new Uint8Array([1, 2, 3]))).toBe(false);
  });

  test('false when the ref carries no hash to verify against', () => {
    const source = makeSource();
    const ref = refFor();
    delete (ref as { contentHash?: string }).contentHash;
    expect(source.verifyBytes(ref, new Uint8Array([1]))).toBe(false);
  });
});

describe('Dropbox extraction source: the deployed local roots env', () => {
  test('parses the shape already deployed, in both spellings', () => {
    const roots = parseDropboxExtractionLocalRootsFromEnv({
      OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON: JSON.stringify([
        { rootPath: '/mnt/a', account: 'dropbox.personal', dropboxPathPrefix: '/2 Areas' },
        { root_path: '/mnt/b', approved_scope_key: 'dropbox.personal:/3 Resources', dropbox_path_prefix: '/3 Resources' },
      ]),
    });
    expect(roots).toHaveLength(2);
    expect(roots[0]?.rootPath).toBe('/mnt/a');
    expect(roots[1]?.approvedScopeKey).toBe('dropbox.personal:/3 Resources');
    expect(roots[1]?.dropboxPathPrefix).toBe('/3 Resources');
  });

  test('an unset or empty variable yields no roots', () => {
    expect(parseDropboxExtractionLocalRootsFromEnv({})).toEqual([]);
    expect(parseDropboxExtractionLocalRootsFromEnv({ OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON: '  ' })).toEqual([]);
  });

  test('malformed configuration fails loudly', () => {
    expect(() => parseDropboxExtractionLocalRootsFromEnv({
      OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON: '{',
    })).toThrow();
    expect(() => parseDropboxExtractionLocalRootsFromEnv({
      OLYMPUS_SOURCE_INDEX_DROPBOX_LOCAL_ROOTS_JSON: '[{"account":"dropbox.personal"}]',
    })).toThrow(/rootPath/);
  });
});
