// Leg B10: the Drive FileExtractionSource, and the byte path it needed.
//
// The point of this leg is what is absent. There is no local resolver, no root
// configuration and no path mapping, because there is no mounted Drive — and
// the factory consuming this source needs none of them. The optionality tests
// at the bottom assert that absence directly, because "the seam is optional"
// is only a property if something fails when it stops being true.

import { describe, expect, test } from 'bun:test';
import {
  GOOGLE_DRIVE_EXTRACTION_MIME_TYPES,
  GoogleDriveExtractionSource,
  type GoogleDriveFileBytesClient,
} from '../src/workers/google-connectors/drive-extraction-source.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_PROVIDER,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  GoogleDriveApiError,
  GoogleDriveContentTooLargeError,
  budgetedDriveApiClient,
  createRestGoogleDriveApiClient,
  type GoogleDriveApiClient,
  type GoogleDriveFileBytes,
} from '../src/workers/google-connectors/drive.ts';
import { GoogleDailyRequestBudget, GoogleRequestBudgetError } from '../src/workers/google-connectors/request-budget.ts';
import {
  isFileExtractionSourceError,
  type ExtractionCandidateReader,
  type ExtractionCandidateReaderOptions,
  type ExtractionCandidateReaderPage,
  type ExtractionCandidateRow,
} from '../src/core/file-extraction-source.ts';
import type { ExtractionItemRef, FileExtractionSource } from '../src/workers/file-extraction/types.ts';

const SCOPE_KEY = 'google_drive.personal:/';
const BASE_URL = 'https://drive.test/drive/v3';

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

function bytesClient(
  impl: (fileId: string, maxBytes?: number) => Promise<GoogleDriveFileBytes>,
): GoogleDriveFileBytesClient {
  return { downloadFileBytes: impl };
}

function row(overrides: Partial<ExtractionCandidateRow> = {}): ExtractionCandidateRow {
  return {
    localItemId: 'personal:1AbCdEf',
    mimeType: 'application/pdf',
    contentHash: 'd41d8cd98f00b204e9800998ecf8427e',
    name: 'scan.pdf',
    ...overrides,
  };
}

function makeSource(options: {
  candidates?: ExtractionCandidateReader;
  client?: GoogleDriveFileBytesClient;
  corpusId?: string;
  id?: string;
  provider?: string;
  approvedScopeKey?: string;
  mimeTypes?: readonly string[];
  maxBytes?: number;
} = {}): GoogleDriveExtractionSource {
  return new GoogleDriveExtractionSource({
    id: options.id ?? 'google_drive.personal',
    corpusId: options.corpusId ?? GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    provider: options.provider ?? GOOGLE_DRIVE_PROVIDER,
    approvedScopeKey: options.approvedScopeKey ?? SCOPE_KEY,
    candidates: options.candidates ?? candidateReader({ candidates: [], done: true }),
    client: options.client ?? bytesClient(() => Promise.resolve({ bytes: new Uint8Array([1]), sizeBytes: 1 })),
    ...(options.mimeTypes ? { mimeTypes: options.mimeTypes } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });
}

function refFor(overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    provider: GOOGLE_DRIVE_PROVIDER,
    accountScope: 'personal',
    approvedScopeKey: SCOPE_KEY,
    providerItemId: '1AbCdEf',
    localItemId: 'personal:1AbCdEf',
    mimeType: 'application/pdf',
    ...overrides,
  };
}

describe('Drive extraction source: identity and corpus are data', () => {
  test('both Drive corpora are constructor arguments, not constants', () => {
    const internal = makeSource({ corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID });
    const secure = makeSource({ corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID, id: 'google_drive.secure' });
    expect(internal.corpusId).toBe('internal.drive.docs');
    expect(secure.corpusId).toBe('secure_local.drive.docs');
    expect(internal.provider).toBe('google_drive');
    expect(internal.id).not.toBe(secure.id);
  });

  test('an empty identity is refused at construction', () => {
    expect(() => makeSource({ id: '' })).toThrow();
    expect(() => makeSource({ corpusId: '  ' })).toThrow();
    expect(() => makeSource({ provider: '' })).toThrow();
    expect(() => makeSource({ approvedScopeKey: '' })).toThrow();
  });
});

describe('Drive extraction source: candidate enumeration', () => {
  test('asks only for the zero-chunk population in media the factory can read', async () => {
    const seen: ExtractionCandidateReaderOptions[] = [];
    const source = makeSource({ candidates: candidateReader({ candidates: [row()], done: true }, seen) });
    await source.listCandidates({ limit: 50 });

    expect(seen[0]?.withoutChunksOnly).toBe(true);
    expect(seen[0]?.limit).toBe(50);
    expect(seen[0]?.mimeTypes).toEqual(GOOGLE_DRIVE_EXTRACTION_MIME_TYPES);
    expect(seen[0]?.mimeTypes).toContain('application/pdf');
    expect(seen[0]?.mimeTypes).toContain('image/jpeg');
    // Drive's own connector exports Google Docs to text/plain, so they are
    // already indexed and must never be queued here.
    expect(seen[0]?.mimeTypes).not.toContain('application/vnd.google-apps.document');
    expect(seen[0]?.mimeTypes).not.toContain('text/plain');
  });

  test('a caller may narrow the media, and an unknown lane enumerates nothing', async () => {
    const seen: ExtractionCandidateReaderOptions[] = [];
    const source = makeSource({ candidates: candidateReader({ candidates: [row()], done: true }, seen) });
    await source.listCandidates({ limit: 10, mimeTypes: ['application/pdf'] });
    expect(seen[0]?.mimeTypes).toEqual(['application/pdf']);

    const other = await source.listCandidates({ limit: 10, approvedScopeKeys: ['google_drive.other:/'] });
    expect(other).toEqual({ candidates: [], done: true });
  });

  test('candidate rows become refs carrying this source lane', async () => {
    const source = makeSource({
      candidates: candidateReader({ candidates: [row()], nextCursor: 'p2', done: false }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.nextCursor).toBe('p2');
    expect(page.done).toBe(false);
    const ref = page.candidates[0]!;
    expect(ref.corpusId).toBe(GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID);
    expect(ref.provider).toBe('google_drive');
    expect(ref.approvedScopeKey).toBe(SCOPE_KEY);
    expect(ref.accountScope).toBe('personal');
    expect(ref.providerItemId).toBe('1AbCdEf');
    expect(ref.mimeType).toBe('application/pdf');
    expect(ref.name).toBe('scan.pdf');
  });

  test('a row with an unusable local item id is skipped rather than aborting the page', async () => {
    const source = makeSource({
      candidates: candidateReader({
        candidates: [row({ localItemId: 'nocolon' }), row({ localItemId: 'personal:keep' })],
        done: true,
      }),
    });
    const page = await source.listCandidates({ limit: 10 });
    expect(page.candidates.map((ref) => ref.providerItemId)).toEqual(['keep']);
  });
});

describe('Drive extraction source: recovering the file id', () => {
  test('an account scope containing dots splits on the first separator only', async () => {
    const seen: string[] = [];
    const source = makeSource({
      candidates: candidateReader({
        candidates: [row({ localItemId: 'personal.archive.v2:1AbC-dEf_gh' })],
        done: true,
      }),
      client: bytesClient((fileId) => {
        seen.push(fileId);
        return Promise.resolve({ bytes: new Uint8Array([1]), sizeBytes: 1 });
      }),
    });

    const ref = (await source.listCandidates({ limit: 10 })).candidates[0]!;
    expect(ref.accountScope).toBe('personal.archive.v2');
    expect(ref.providerItemId).toBe('1AbC-dEf_gh');

    await source.fetch(ref, {});
    expect(seen).toEqual(['1AbC-dEf_gh']);
  });

  test('the file id is recovered from the local item id when a ref carries none', async () => {
    const seen: string[] = [];
    const source = makeSource({
      client: bytesClient((fileId) => {
        seen.push(fileId);
        return Promise.resolve({ bytes: new Uint8Array([1]), sizeBytes: 1 });
      }),
    });
    const ref = refFor({ localItemId: 'personal.archive:file-9' });
    (ref as { providerItemId: string }).providerItemId = '';
    await source.fetch(ref, {});
    expect(seen).toEqual(['file-9']);
  });
});

describe('Drive extraction source: the unreadable item', () => {
  async function failWith(error: unknown): Promise<{ errorKind: string; settleAs: string; retryable: boolean }> {
    const source = makeSource({ client: bytesClient(() => Promise.reject(error)) });
    const caught = await source.fetch(refFor(), {}).then(() => undefined, (thrown: unknown) => thrown);
    expect(isFileExtractionSourceError(caught)).toBe(true);
    return caught as never;
  }

  test('a file deleted since enqueue is terminal', async () => {
    const error = await failWith(new GoogleDriveApiError('Google Drive content request failed (404): gone', 404));
    expect(error.errorKind).toBe('source_item_not_found');
    expect(error.settleAs).toBe('failed_terminal');
  });

  test('a revoked permission is terminal', async () => {
    expect((await failWith(new GoogleDriveApiError('failed (403)', 403))).errorKind).toBe('source_permission_denied');
  });

  test('a rate limit is retryable', async () => {
    const error = await failWith(new GoogleDriveApiError('failed (429)', 429));
    expect(error.errorKind).toBe('source_rate_limited');
    expect(error.retryable).toBe(true);
  });

  test('a provider outage is retryable', async () => {
    expect((await failWith(new GoogleDriveApiError('failed (503)', 503))).errorKind).toBe('source_unavailable');
  });

  test('a rejected request is terminal rather than retried identically forever', async () => {
    expect((await failWith(new GoogleDriveApiError('failed (400)', 400))).errorKind).toBe('source_request_rejected');
  });

  test('a parked daily budget is retryable: it describes the day, not the file', async () => {
    const error = await failWith(new GoogleRequestBudgetError('google_drive', '2026-07-29T00:00:00.000Z'));
    expect(error.errorKind).toBe('source_budget_exhausted');
    expect(error.retryable).toBe(true);
    expect(error.settleAs).toBe('failed_retryable');
  });

  test('a budget guard that throws synchronously is still classified, not escaped raw', async () => {
    // budgetedDriveApiClient reserves before it returns a promise, so this
    // failure arrives as a synchronous throw rather than a rejection.
    const source = makeSource({
      client: {
        downloadFileBytes() {
          throw new GoogleRequestBudgetError('google_drive', '2026-07-29T00:00:00.000Z');
        },
      },
    });
    const caught = await source.fetch(refFor(), {}).then(() => undefined, (thrown: unknown) => thrown);
    expect(isFileExtractionSourceError(caught)).toBe(true);
    expect((caught as { errorKind: string }).errorKind).toBe('source_budget_exhausted');
  });

  test('an oversized file settles as a skip, not a failure', async () => {
    const error = await failWith(new GoogleDriveContentTooLargeError());
    expect(error.errorKind).toBe('source_too_large');
    expect(error.settleAs).toBe('skipped_too_large');
  });

  test('a transport that never reached Drive is retryable', async () => {
    const error = await failWith(new Error('ECONNRESET 142.250.72.110:443'));
    expect(error.errorKind).toBe('network_unreachable');
    expect(error.retryable).toBe(true);
  });

  test('no provider text reaches the surfaced error', async () => {
    const source = makeSource({
      client: bytesClient(() => Promise.reject(
        new GoogleDriveApiError('Google Drive content request failed (404): "Q3 board deck.pdf" not found', 404),
      )),
    });
    const error = await source.fetch(refFor(), {}).then(() => undefined, (thrown: unknown) => thrown) as Error;
    expect(error.message).toBe('source_item_not_found');
    expect(error.message).not.toContain('board deck');
  });
});

describe('Drive extraction source: the optionality proof', () => {
  test('this source exposes no verifyBytes at all', () => {
    const source: FileExtractionSource = makeSource();
    expect(source.verifyBytes).toBeUndefined();
    expect('verifyBytes' in source).toBe(false);
  });

  test('fetching depends on no verifier and no resolver', async () => {
    // The whole surface is two methods over a client that can only download
    // one file. No root config, no path mapping, no local mount: if this
    // source could not be built without them, the seam would not be optional.
    let downloads = 0;
    const source = makeSource({
      client: bytesClient(() => {
        downloads += 1;
        return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), sizeBytes: 3 });
      }),
    });
    const fetched = await source.fetch(refFor(), {});
    expect(downloads).toBe(1);
    expect([...fetched.bytes]).toEqual([1, 2, 3]);
  });

  test('the constructor takes no root, resolver or mount option', () => {
    const optionKeys = Object.keys({
      id: '',
      corpusId: '',
      provider: '',
      approvedScopeKey: '',
      candidates: undefined,
      client: undefined,
      mimeTypes: undefined,
      maxBytes: undefined,
    });
    expect(optionKeys.filter((key) => /root|resolver|mount|localPath/i.test(key))).toEqual([]);
  });
});

describe('Drive byte path: the transport', () => {
  function restClient(fetchImpl: (url: string) => Promise<Response>, maxRetries = 0): GoogleDriveApiClient {
    return createRestGoogleDriveApiClient({
      token: 'test-token',
      fetch: (input) => fetchImpl(String(input)),
      baseUrl: BASE_URL,
      maxRetries,
      sleep: () => Promise.resolve(),
    });
  }

  test('binary bytes survive the round trip unchanged', async () => {
    // 0xFF is not valid UTF-8. Decoding it through Response.text() replaces it
    // with U+FFFD, and the corruption is invisible until an extractor rejects
    // the file. This is the regression test for that trap.
    const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
    const client = restClient(() => Promise.resolve(new Response(payload, {
      headers: { 'content-type': 'application/pdf' },
    })));

    const result = await client.downloadFileBytes('1AbCdEf');
    expect([...result.bytes]).toEqual([...payload]);
    expect(result.sizeBytes).toBe(payload.byteLength);
    expect(result.mimeType).toBe('application/pdf');

    // The same bytes through the text lane are corrupted, which is why the
    // byte lane had to exist.
    const viaText = new TextEncoder().encode(new TextDecoder().decode(payload));
    expect([...viaText]).not.toEqual([...payload]);
  });

  test('the download uses alt=media and supports shared drives', async () => {
    const urls: string[] = [];
    const client = restClient((url) => {
      urls.push(url);
      return Promise.resolve(new Response(new Uint8Array([1])));
    });
    await client.downloadFileBytes('a b/c');
    expect(urls[0]).toBe(`${BASE_URL}/files/a%20b%2Fc?alt=media&supportsAllDrives=true`);
  });

  test('maxBytes is measured in bytes and refuses rather than truncating', async () => {
    // Four characters, six bytes: a character-counted ceiling would let this
    // through.
    const payload = new TextEncoder().encode('aé😀');
    expect(payload.byteLength).toBeGreaterThan(3);
    const client = restClient(() => Promise.resolve(new Response(payload)));

    await expect(client.downloadFileBytes('f', payload.byteLength - 1))
      .rejects.toBeInstanceOf(GoogleDriveContentTooLargeError);
    const allowed = await client.downloadFileBytes('f', payload.byteLength);
    expect([...allowed.bytes]).toEqual([...payload]);
  });

  test('a declared length over the ceiling is refused before the body is read', async () => {
    let bodyRead = false;
    const client = restClient(() => {
      const response = new Response('xx', { headers: { 'content-length': '999999' } });
      Object.defineProperty(response, 'arrayBuffer', {
        value: () => {
          bodyRead = true;
          return Promise.reject(new Error('the body must not be read'));
        },
      });
      return Promise.resolve(response);
    });
    await expect(client.downloadFileBytes('f', 16)).rejects.toBeInstanceOf(GoogleDriveContentTooLargeError);
    expect(bodyRead).toBe(false);
  });

  test('the retry and Retry-After behaviour of the text lane is kept', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const client = createRestGoogleDriveApiClient({
      token: 'test-token',
      fetch: () => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }));
        }
        return Promise.resolve(new Response(new Uint8Array([7, 8, 9])));
      },
      baseUrl: BASE_URL,
      maxRetries: 2,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    const result = await client.downloadFileBytes('f');
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect([...result.bytes]).toEqual([7, 8, 9]);
  });

  test('an exhausted retry budget throws a status-carrying error, not provider prose', async () => {
    const client = restClient(() => Promise.resolve(new Response('nope', { status: 404 })));
    const error = await client.downloadFileBytes('f').then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GoogleDriveApiError);
    expect((error as GoogleDriveApiError).status).toBe(404);
  });
});

describe('Drive byte path: the daily request budget', () => {
  function countingBudget(): GoogleDailyRequestBudget & { reserved: number } {
    const budget = new GoogleDailyRequestBudget({ provider: 'google_drive', dailyRequestBudget: 1_000 }) as
      GoogleDailyRequestBudget & { reserved: number };
    budget.reserved = 0;
    const inner = budget.reserve.bind(budget);
    budget.reserve = () => {
      budget.reserved += 1;
      inner();
    };
    return budget;
  }

  test('the new method reserves against the day counter like every other request', async () => {
    const budget = countingBudget();
    const inner: GoogleDriveApiClient = {
      listFiles: () => Promise.resolve({ files: [] }),
      exportGoogleDocText: () => Promise.resolve(''),
      downloadTextFile: () => Promise.resolve(''),
      downloadFileBytes: () => Promise.resolve({ bytes: new Uint8Array([1]), sizeBytes: 1 }),
    };
    const wrapped = budgetedDriveApiClient(inner, budget);

    await wrapped.downloadFileBytes('f');
    expect(budget.reserved).toBe(1);
    await wrapped.downloadFileBytes('g', 10);
    expect(budget.reserved).toBe(2);
  });

  test('the wrapper forwards every method the client declares', () => {
    // A method the wrapper does not know about is a silent under-count of the
    // provider quota, so the two surfaces have to agree exactly.
    const inner: GoogleDriveApiClient = {
      listFiles: () => Promise.resolve({ files: [] }),
      exportGoogleDocText: () => Promise.resolve(''),
      downloadTextFile: () => Promise.resolve(''),
      downloadFileBytes: () => Promise.resolve({ bytes: new Uint8Array(), sizeBytes: 0 }),
    };
    const wrapped = budgetedDriveApiClient(inner, countingBudget());
    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(inner).sort());
  });

  test('an exhausted budget surfaces as its own error rather than a download failure', async () => {
    const budget = new GoogleDailyRequestBudget({ provider: 'google_drive', dailyRequestBudget: 1 });
    const inner: GoogleDriveApiClient = {
      listFiles: () => Promise.resolve({ files: [] }),
      exportGoogleDocText: () => Promise.resolve(''),
      downloadTextFile: () => Promise.resolve(''),
      downloadFileBytes: () => Promise.resolve({ bytes: new Uint8Array([1]), sizeBytes: 1 }),
    };
    const wrapped = budgetedDriveApiClient(inner, budget);
    await wrapped.downloadFileBytes('f');
    // The reservation throws synchronously, before any promise exists, exactly
    // as it does for the other methods. The extraction source calls this from
    // inside a try block, so it is still classified rather than escaping raw.
    expect(() => wrapped.downloadFileBytes('g')).toThrow(GoogleRequestBudgetError);
  });
});
