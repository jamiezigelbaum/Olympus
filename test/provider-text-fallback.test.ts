// Text the provider supplies (RawItem.providerText, contract 2.3.0,
// docs/design/child-items.md): a child whose reader finds nothing is read from
// the source's own reading of it, which is judged like any text, held like any
// imported content, stored and found by search, and marked as the provider's.
// The rule (providerFallback) first, then one child through the real archive
// extraction task, sink, judge and store. Synthetic data only.

import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { getArchiveFormat, type ArchiveConnectorFactory } from '../src/core/archive-formats.ts';
import type { RawItem, RawItemProviderText, SourceConnector } from '../src/core/contracts.ts';
import { defaultConfig } from '../src/core/config.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import type { TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { createArchiveExtractionRuntime } from '../src/workers/archive-import/extraction-runtime.ts';
import { archiveExtractionTaskId, createArchiveImportsSchedulerSource } from '../src/workers/archive-import/scheduler-source.ts';
import { EXTRACTION_PROVIDER_TEXT_MAX_CHARS, createFileExtractionRunner, providerFallback } from '../src/workers/file-extraction/runner.ts';
import { isFileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import { createConnectorFileExtractionSource } from '../src/workers/file-extraction/connector-source.ts';
import { LocalFileExtractionJobStore } from '../src/workers/file-extraction/job-store.ts';
import { buildExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import type { ExtractionSinkRequest, ExtractorOutput, FileExtractionSource } from '../src/workers/file-extraction/types.ts';
import { childProviderItemId, createFixtureChildConnector, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const cleanups: Array<() => void> = [];
afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length) cleanups.pop()!();
});

const RECOGNIZED: RawItemProviderText = { text: 'meet uniquehandwriting\nat noon', form: 'recognized_words', label: 'Evernote', terms: ['rneet', 'moon'] };

const MARKED = '[Recognized by Evernote, approximate words] meet uniquehandwriting\n'
  + '[Recognized by Evernote, approximate words] at noon\n'
  + '[Recognized by Evernote, approximate words] other readings: rneet, moon';
const PROVIDER_DERIVATION = { artifactKind: 'provider_text', structuralRef: { artifact: 'provider_text', label: 'Evernote', form: 'recognized_words' } };

describe('the fallback rule', () => {
  test('a reader that found nothing, settled names only, skipped the type, or was not given an over-limit file: the provider\'s reading, every line marked', () => {
    for (const output of [
      { status: 'empty_output' as const },
      { status: 'metadata_only' as const },
      { status: 'skipped_unsupported' as const },
      { status: 'skipped_too_large' as const },
      { status: 'indexed' as const, text: '   ' },
    ]) {
      const used = providerFallback(output, RECOGNIZED);
      expect(used.status).toBe('indexed');
      if (used.status !== 'indexed') continue;
      expect(used.text).toBe(MARKED);
      expect(used.derivations as unknown).toEqual([{ ...PROVIDER_DERIVATION, chars: used.text.length }]);
    }
    // Prose says whose it is, without the approximation.
    const prose = providerFallback({ status: 'empty_output' }, { text: 'A caption.', form: 'prose', label: 'Example' });
    expect(prose.status === 'indexed' ? prose.text : '').toBe('[Supplied by Example] A caption.');
  });

  test('our reader stays primary, and a failure (retryable, or terminal and perhaps reopened for another reader) is left as it is', () => {
    const read = { status: 'indexed' as const, text: 'What the reader found.' };
    expect(providerFallback(read, RECOGNIZED)).toBe(read);
    const ocr = { status: 'indexed' as const, text: 'Photo\nwhat OCR read', derivations: [
      { artifactKind: 'image_description' as const, chars: 5, structuralRef: { artifact: 'image_media' } },
      { artifactKind: 'image_description' as const, chars: 13, structuralRef: { artifact: 'image_ocr' } },
    ] };
    expect(providerFallback(ocr, RECOGNIZED)).toBe(ocr);
    const retry = { status: 'failed_retryable' as const, errorKind: 'extractor_timeout' };
    expect(providerFallback(retry, RECOGNIZED)).toBe(retry);
    const terminal = { status: 'failed_terminal' as const, errorKind: 'ocr_pdf_rejected' };
    expect(providerFallback(terminal, RECOGNIZED)).toBe(terminal);
    const empty = { status: 'empty_output' as const };
    expect(providerFallback(empty, undefined)).toBe(empty);
    expect(providerFallback(empty, { ...RECOGNIZED, text: ' \n ' })).toBe(empty);
  });

  test('a generated description is no reader\'s text: a prepared photo keeps its media and markers, with the provider\'s reading below "Photo"', () => {
    const media = { path: '/cache/x.jpg', sha256: 'a'.repeat(64), mimeType: 'image/jpeg' as const };
    const photo = {
      status: 'indexed' as const,
      text: 'Photo',
      media,
      derivations: [{ artifactKind: 'image_description' as const, chars: 5, structuralRef: { artifact: 'image_media' }, warnings: ['ocr_unavailable_image'] }],
      warnings: ['ocr_unavailable_image'],
    };
    const used = providerFallback(photo, RECOGNIZED);
    expect(used.status).toBe('indexed');
    if (used.status !== 'indexed') return;
    expect(used.text).toBe(`Photo\n${MARKED}`);
    expect(used.media).toBe(media);
    // The marker that brings OCR back once it is ready is still on the record, so OCR's reading later replaces this.
    expect(used.derivations?.[0]).toEqual(photo.derivations[0]);
    expect(used.derivations?.[1]).toMatchObject(PROVIDER_DERIVATION);
    expect(used.warnings).toEqual(['ocr_unavailable_image']);
  });

  test('what an unread output owed is kept: its derivations and warnings go with the provider\'s text', () => {
    const scan = {
      status: 'metadata_only' as const,
      derivations: [{ artifactKind: 'image_description' as const, chars: 20, structuralRef: { artifact: 'media_descriptor' }, warnings: ['ocr_unavailable_pdf'] }],
      warnings: ['ocr_required', 'ocr_unavailable_pdf'],
    };
    const used = providerFallback(scan, RECOGNIZED);
    expect(used.status === 'indexed' ? used.text : '').toBe(MARKED);
    expect(used.status === 'indexed' ? used.derivations?.[0] : undefined).toEqual(scan.derivations[0]);
    expect(used.status === 'indexed' ? used.warnings : undefined).toEqual(['ocr_required', 'ocr_unavailable_pdf']);
  });

  test('every passage carries its provenance: any 500-character window with a recognized word has a marker in it', () => {
    const words = Array.from({ length: 3_000 }, (_, index) => `w${index}`).join(' ');
    const used = providerFallback({ status: 'empty_output' }, { text: words, form: 'recognized_words', label: 'Evernote' });
    const text = used.status === 'indexed' ? used.text : '';
    expect(text.split('\n').every((line) => line.startsWith('[Recognized by Evernote, approximate words] '))).toBe(true);
    for (let at = 0; at + 500 <= text.length; at += 37) {
      expect(text.slice(at, at + 500)).toContain('[Recognized by Evernote, approximate words]');
    }
  });

  test('bounded by the text reader\'s limit, at a whole line', () => {
    const long = providerFallback({ status: 'empty_output' }, { text: 'word '.repeat(EXTRACTION_PROVIDER_TEXT_MAX_CHARS), form: 'prose', label: 'Example' });
    const text = long.status === 'indexed' ? long.text : '';
    expect(text.length).toBeLessThanOrEqual(EXTRACTION_PROVIDER_TEXT_MAX_CHARS);
    expect(text.split('\n').at(-1)!.startsWith('[Supplied by Example] word')).toBe(true);
  });
});

describe('through the archive extraction task', () => {
  test('a child whose reader finds nothing is judged, stored and found by its recognized words', async () => {
    const judged: TierSnifferRequest[] = [];
    registerInstalledTierClassification({
      forLedger: () => ({ sniffer: { id: 'recording', judge: (request) => { judged.push(request); return { verdict: 'decided', tier: 'private', code: 'ordinary:0.99' }; } } }),
    });
    // A whiteboard photo the text reader finds nothing in (blank text stands in for an unreadable image).
    const parents: FixtureParentSpec[] = [{
      id: 'n1', subject: 'Whiteboard', sender: 'Sam', sentAt: '2024-03-03T10:00:00.000Z', body: 'See the photo.',
      children: [{ key: 'r0', name: 'board.txt', mimeType: 'text/plain', text: '   ' }],
    }];
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, parents);
    // The format's connector hands its reading of the child with the child's bytes, as the Evernote reader does.
    const connectorFactory = (): ArchiveConnectorFactory => (input): SourceConnector => {
      const inner = createFixtureChildConnector({ accountScope: input.accountScope, provider: format.provider, family: format.family, id: input.connectorId, parents, log: h.log });
      const withText = (item: RawItem): RawItem => ({ ...item, providerText: RECOGNIZED });
      const wrapped = Object.create(inner) as SourceConnector & { fetchItemWithin?: (...args: unknown[]) => Promise<RawItem> };
      wrapped.fetchItem = async (...args) => withText(await inner.fetchItem(...args));
      const within = (inner as { fetchItemWithin?: (...args: unknown[]) => Promise<RawItem> }).fetchItemWithin;
      if (within) wrapped.fetchItemWithin = async (...args) => withText(await within.apply(inner, args));
      return wrapped;
    };
    const extraction = createArchiveExtractionRuntime({ runtime: h.runtime, env: h.env, jobsDbPath: join(h.base, 'jobs.sqlite'), warn: () => {}, connectorFactory });
    cleanups.push(() => extraction.close());
    const source = createArchiveImportsSchedulerSource({ runtime: h.runtime, config: defaultConfig(), extraction })!;
    const task = source.tasks.find((candidate) => candidate.id === archiveExtractionTaskId(archiveId))!;
    const child = childProviderItemId('n1', 'r0');
    const landed = () => h.rows(archiveId).filter((row) => row.providerItemId === child && row.chunks > 0);

    expect(landed()).toHaveLength(0);
    await task.run({} as never);
    // Stored with its text, where the judge put it.
    expect(landed().length).toBeGreaterThan(0);
    // Judged like any content: the content pass read the recognized words.
    expect(judged.some((request) => request.pass === 'content' && JSON.stringify(request).includes('uniquehandwriting'))).toBe(true);
    // Found by search, and the text says whose reading it is.
    const stores = h.runtime.lane(format.family).set.openStores();
    const hits = stores.flatMap((store) => store.searchItems('uniquehandwriting', 10, archiveId));
    expect(hits.map((hit) => hit.sourceItem.providerItemId)).toContain(child);
    const text = stores.flatMap((store) => store.localContent(`${archiveId}:${child}`)?.chunks ?? []).join(' ');
    expect(text).toContain('[Recognized by Evernote, approximate words] meet uniquehandwriting');
  });
});

describe('a file over the reader\'s limit, refused by the source', () => {
  const CORPUS_ID = 'secure_local.fake.files';
  const ref = { corpusId: CORPUS_ID, provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/', providerItemId: 'scan-1', localItemId: 'personal:scan-1', mimeType: 'text/plain', name: 'scan.txt' };

  test('the source\'s refusal carries its reading, and the runner uses it without giving the reader the bytes', async () => {
    // The shared connector source refuses an item over the limit, and keeps its reading with the refusal.
    const connector = {
      id: 'fake', family: 'note',
      async authenticate() {}, listItems: async function* () {}, classificationSignals: () => ({}),
      async fetchItem(): Promise<RawItem> {
        return { identity: { family: 'note', provider: 'fake', accountScope: 'personal', providerItemId: 'scan-1', localItemId: 'personal:scan-1' }, mimeType: 'text/plain', content: { kind: 'bytes', mimeType: 'text/plain', bytes: new Uint8Array(64) }, metadata: {}, fetchedAt: '2026-10-26T00:00:00.000Z', providerText: RECOGNIZED };
      },
    } as unknown as SourceConnector;
    const source = createConnectorFileExtractionSource({
      id: 'fake-source', corpusId: CORPUS_ID, provider: 'fake', connector,
      candidates: { extractionCandidates: async () => ({ candidates: [], done: true }) },
      lanes: [{ approvedScopeKey: 'fake.personal:/' }],
    } as never);
    const refused = await source.fetch(ref as never, { maxBytes: 10 }).then(() => undefined, (error: unknown) => error);
    expect(isFileExtractionSourceError(refused) && refused.errorKind).toBe('source_too_large');
    expect(isFileExtractionSourceError(refused) ? refused.providerText : undefined).toEqual(RECOGNIZED);

    // The runner settles that job with the reading as the item's text; the reader is never called.
    const jobs = new LocalFileExtractionJobStore(':memory:');
    try {
      let readerCalls = 0;
      const accepted: ExtractionSinkRequest[] = [];
      const runner = createFileExtractionRunner({
        jobs,
        registry: buildExtractorRegistry([{
          kind: 'fake_text', version: 'fake-v1', input: { kind: 'bytes', maxInputBytes: 10 }, egress: 'local', accepts: () => true,
          async extract(): Promise<ExtractorOutput> { readerCalls += 1; return { status: 'indexed', text: 'never' }; },
        }]),
        corpora: [{
          corpusId: CORPUS_ID,
          trustDomain: 'secure_local',
          source: { ...source, fetch: async () => { throw refused; } } as FileExtractionSource,
          sink: { async accept(request) { accepted.push(request); return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 }; } },
        }],
      });
      jobs.enqueue({ refs: [ref as never], extractorKind: 'fake_text', extractorVersion: 'fake-v1', policyDecision: 'index_allowed' });
      const result = await runner.run({ corpusId: CORPUS_ID, provider: 'fake', accountScope: 'personal', approvedScopeKey: 'fake.personal:/' } as never);
      expect(result.records[0]!.status).toBe('indexed');
      expect(readerCalls).toBe(0);
      expect(accepted[0]!.text).toContain('[Recognized by Evernote, approximate words] meet uniquehandwriting');
      expect(accepted[0]!.derivations?.[0]?.artifactKind).toBe('provider_text');
    } finally {
      jobs.close();
    }
  });
});
