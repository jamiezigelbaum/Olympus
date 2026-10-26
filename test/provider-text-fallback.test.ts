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
import { EXTRACTION_PROVIDER_TEXT_MAX_CHARS, providerFallback } from '../src/workers/file-extraction/runner.ts';
import { childProviderItemId, createFixtureChildConnector, type FixtureParentSpec } from './helpers/child-items-fixture.ts';
import { childItemsArchiveHarness, FIXTURE_ARCHIVE_FORMAT } from './support/child-items-archive-harness.ts';

const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
const cleanups: Array<() => void> = [];
afterEach(() => {
  registerInstalledTierClassification(undefined);
  while (cleanups.length) cleanups.pop()!();
});

const RECOGNIZED: RawItemProviderText = { text: 'meet uniquehandwriting\nat noon', form: 'recognized_words', label: 'Evernote', terms: ['rneet', 'moon'] };

describe('the fallback rule', () => {
  test('a reader that found nothing, read nothing usable, or was not given an over-limit file: the provider\'s reading, marked', () => {
    for (const output of [
      { status: 'empty_output' as const },
      { status: 'metadata_only' as const },
      { status: 'skipped_unsupported' as const },
      { status: 'skipped_too_large' as const },
      { status: 'failed_terminal' as const, errorKind: 'unreadable' },
      { status: 'indexed' as const, text: '   ' },
    ]) {
      const used = providerFallback(output, RECOGNIZED);
      expect(used.status).toBe('indexed');
      if (used.status !== 'indexed') continue;
      expect(used.text).toBe('Text recognized by Evernote (approximate words, not an exact quote):\nmeet uniquehandwriting\nat noon\nOther readings: rneet, moon');
      expect(used.derivations).toEqual([{ artifactKind: 'provider_text', chars: used.text.length, structuralRef: { label: 'Evernote', form: 'recognized_words' } }]);
    }
    // Prose says whose it is, without the approximation.
    const prose = providerFallback({ status: 'empty_output' }, { text: 'A caption.', form: 'prose', label: 'Example' });
    expect(prose.status === 'indexed' ? prose.text : '').toBe('Text supplied by Example:\nA caption.');
  });

  test('our reader stays primary, a retry is left to retry, and nothing is made of no reading', () => {
    const read = { status: 'indexed' as const, text: 'What the reader found.' };
    expect(providerFallback(read, RECOGNIZED)).toBe(read);
    const retry = { status: 'failed_retryable' as const, errorKind: 'extractor_timeout' };
    expect(providerFallback(retry, RECOGNIZED)).toBe(retry);
    const empty = { status: 'empty_output' as const };
    expect(providerFallback(empty, undefined)).toBe(empty);
    expect(providerFallback(empty, { ...RECOGNIZED, text: ' \n ' })).toBe(empty);
  });

  test('bounded by the text reader\'s limit', () => {
    const long = providerFallback({ status: 'empty_output' }, { text: 'word '.repeat(EXTRACTION_PROVIDER_TEXT_MAX_CHARS), form: 'prose', label: 'Example' });
    expect(long.status === 'indexed' ? long.text.length : 0).toBe(EXTRACTION_PROVIDER_TEXT_MAX_CHARS);
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
    expect(text).toContain('Text recognized by Evernote (approximate words, not an exact quote):');
  });
});
