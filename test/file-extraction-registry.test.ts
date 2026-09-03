// The explicit extractor registry.
//
// What replaced substring dispatch has to be checked for the two things
// substring dispatch got wrong: that a kind resolves to exactly one lane, and
// that a kind nobody registered resolves to NOTHING rather than to whichever
// lane its spelling happened to match.
//
// The egress declarations are asserted here rather than only at the gate. The
// gate keys off `Extractor.egress` and nothing else, so a lane that mislabels
// itself local would walk straight through a boundary that is working
// perfectly.

import { describe, expect, test } from 'bun:test';
import { OCR_EXTRACTOR_KIND } from '../src/workers/file-extraction/extractors/ocr.ts';
import { REMOTE_VLM_EXTRACTOR_KINDS } from '../src/workers/file-extraction/extractors/remote-vlm.ts';
import { TEXT_EXTRACTOR_KIND } from '../src/workers/file-extraction/extractors/text.ts';
import { TRANSCRIPTION_EXTRACTOR_KIND } from '../src/workers/file-extraction/extractors/transcription.ts';
import {
  VLM_LAYOUT_EXTRACTOR_KIND,
  VLM_PDF_EXTRACTOR_KIND,
} from '../src/workers/file-extraction/extractors/vlm.ts';
import {
  buildExtractorRegistry,
  createDefaultExtractorRegistry,
  defaultTerminalReclassificationRules,
  extractorHealthProbes,
} from '../src/workers/file-extraction/registry.ts';
import type {
  ExtractionItemRef,
  Extractor,
  ExtractorOutput,
  VlmProbeRequest,
} from '../src/workers/file-extraction/types.ts';

function ref(overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    corpusId: 'secure_local.fake.files',
    provider: 'fake',
    accountScope: 'personal',
    approvedScopeKey: 'fake.personal:/Projects',
    providerItemId: 'item-1',
    localItemId: 'personal:item-1',
    ...overrides,
  };
}

function stubExtractor(kind: string, accepts: boolean): Extractor {
  return {
    kind,
    version: 'stub-v1',
    needsBytes: false,
    egress: 'local',
    accepts: () => accepts,
    async extract(): Promise<ExtractorOutput> {
      return { status: 'indexed', text: kind };
    },
  };
}

describe('extractor registry: the kinds in flight keep their names', () => {
  test('every lane the design names is registered exactly once', () => {
    const registry = createDefaultExtractorRegistry({});
    const kinds = registry.list().map((extractor) => extractor.kind);
    expect(kinds.sort()).toEqual([
      OCR_EXTRACTOR_KIND,
      TEXT_EXTRACTOR_KIND,
      TRANSCRIPTION_EXTRACTOR_KIND,
      VLM_LAYOUT_EXTRACTOR_KIND,
      VLM_PDF_EXTRACTOR_KIND,
      ...REMOTE_VLM_EXTRACTOR_KINDS,
    ].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  test('the transcription lane is whisper_transcription', () => {
    // The design table calls this `transcribe_whisper`. The constant the live
    // queue holds is the other way round, and the queue is what jobs were
    // enqueued against, so the code is right and the table is wrong.
    expect(TRANSCRIPTION_EXTRACTOR_KIND).toBe('whisper_transcription');
    expect(createDefaultExtractorRegistry({}).get('transcribe_whisper')).toBeUndefined();
  });

  test('exactly one lane declares remote egress, and it is the remote one', () => {
    const registry = createDefaultExtractorRegistry({});
    const remote = registry.list()
      .filter((extractor) => extractor.egress === 'approved_remote')
      .map((extractor) => extractor.kind);
    expect(remote.sort()).toEqual([...REMOTE_VLM_EXTRACTOR_KINDS].sort());
  });

  test('registering one kind twice is refused rather than silently shadowed', () => {
    expect(() => buildExtractorRegistry([
      stubExtractor('duplicate_kind', true),
      stubExtractor('duplicate_kind', true),
    ])).toThrow('registered twice');
  });
});

describe('extractor registry: selection is explicit', () => {
  test('a requested kind is honoured exactly, even when it accepts nothing here', () => {
    // The old dispatch would have re-routed this by spelling. The job was
    // enqueued for this lane on purpose, and the lane answers for itself.
    const registry = buildExtractorRegistry([
      stubExtractor('narrow_lane', false),
      stubExtractor('broad_lane', true),
    ], ['broad_lane']);
    expect(registry.select(ref(), 'narrow_lane')?.kind).toBe('narrow_lane');
  });

  test('a kind nobody registered resolves to nothing at all', () => {
    const registry = createDefaultExtractorRegistry({});
    expect(registry.select(ref({ mimeType: 'application/pdf' }), 'local_ocr_v2')).toBeUndefined();
    expect(registry.get('anything_with_vlm_in_the_name')).toBeUndefined();
  });

  test('with no requested kind, audio reaches the transcription lane and text the text lane', () => {
    const registry = createDefaultExtractorRegistry({});
    expect(registry.select(ref({ mimeType: 'audio/mpeg', name: 'memo.mp3' }))?.kind)
      .toBe(TRANSCRIPTION_EXTRACTOR_KIND);
    expect(registry.select(ref({ mimeType: 'application/pdf', name: 'report.pdf' }))?.kind)
      .toBe(TEXT_EXTRACTOR_KIND);
    expect(registry.select(ref({ mimeType: 'text/plain', name: 'notes.txt' }))?.kind)
      .toBe(TEXT_EXTRACTOR_KIND);
  });

  test('the expensive lanes are never selected implicitly', () => {
    const registry = createDefaultExtractorRegistry({});
    const implicit = [
      registry.select(ref({ mimeType: 'application/pdf' }))?.kind,
      registry.select(ref({ mimeType: 'image/png' }))?.kind,
      registry.select(ref({ mimeType: 'audio/mpeg', name: 'memo.mp3' }))?.kind,
    ];
    for (const kind of implicit) {
      expect(REMOTE_VLM_EXTRACTOR_KINDS).not.toContain(kind as never);
      expect(kind).not.toBe(VLM_PDF_EXTRACTOR_KIND);
      expect(kind).not.toBe(OCR_EXTRACTOR_KIND);
    }
  });

  test('an unroutable media type selects nothing rather than the broadest lane', () => {
    const registry = createDefaultExtractorRegistry({});
    expect(registry.select(ref({ mimeType: 'application/x-sqlite3' }))).toBeUndefined();
    expect(registry.select(ref({}))).toBeUndefined();
  });
});

describe('extractor registry: health probes', () => {
  test('only kinds whose client offers a probe appear, and the timeout is carried', () => {
    const seen: (VlmProbeRequest | undefined)[] = [];
    const probes = extractorHealthProbes({
      vlmPdf: {
        healthcheckTimeoutMs: 4_321,
        client: {
          async describe() { return { text: '' }; },
          async probe(request) { seen.push(request); },
        },
      },
      vlm: { client: { async describe() { return { text: '' }; } } },
    });

    expect([...probes.keys()]).toEqual([VLM_PDF_EXTRACTOR_KIND]);
    return probes.get(VLM_PDF_EXTRACTOR_KIND)!().then(() => {
      expect(seen).toEqual([{ timeoutMs: 4_321 }]);
    });
  });

  test('a configured remote client probes every remote kind', () => {
    const probes = extractorHealthProbes({
      remote: {
        client: {
          async describe() { return { text: '' }; },
          async probe() {},
        },
      },
    });
    expect([...probes.keys()].sort()).toEqual([...REMOTE_VLM_EXTRACTOR_KINDS].sort());
  });

  test('an unconfigured registry has nothing to probe', () => {
    expect(extractorHealthProbes({}).size).toBe(0);
  });
});

describe('extractor registry: the shipped reopening rules', () => {
  test('the rules carry the target lane version from the registry, not a literal', () => {
    const registry = createDefaultExtractorRegistry({});
    const version = registry.get(VLM_PDF_EXTRACTOR_KIND)!.version;
    for (const rule of defaultTerminalReclassificationRules(registry)) {
      expect(rule.toExtractorVersion).toBe(version);
    }
  });

  test('a rule pointing at a lane this process cannot run is dropped, not enqueued', () => {
    // Queueing work for a lane nothing will ever lease is worse than not
    // reopening the job: it looks like progress and produces none.
    const withoutVision = buildExtractorRegistry([stubExtractor(OCR_EXTRACTOR_KIND, true)]);
    expect(defaultTerminalReclassificationRules(withoutVision)).toEqual([]);
  });
});
