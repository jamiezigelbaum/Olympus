// Coverage-gap parity for the shared connector-store spine.
//
// Before this leg an item that reached the store with no extractable text was
// simply silent: the content provider returned zero chunks and the evidence
// pack said only "no extractable content was available". That reads to the
// Analyst as "nothing relevant", when the truth is "the file is indexed and its
// contents were never extracted". These tests pin the honest wording and prove
// it survives all the way to the Analyst prompt.
//
// Everything here is source-agnostic on purpose. The gaps are derived from two
// things the spine persists for every family — the number of stored chunk rows
// and the item's IANA media type — so no connector, no family and no schema
// column beyond v9 is involved.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildEvidencePack } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreCoverageGaps,
  createConnectorStoreContentProvider,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';

const CORPUS_ID = 'secure_local.fake.files';
const PROVIDER = 'fake_files';
const ACCOUNT = 'personal';
const CONNECTOR_ID = 'fake_files_connector';

interface ItemSpec {
  id: string;
  name: string;
  mimeType: string;
  text?: string;
}

const READABLE_NOTE: ItemSpec = {
  id: 'note-1',
  name: 'retro-notes.md',
  mimeType: 'text/markdown',
  text: 'The retro decided to adopt LanceDB for unified search.',
};
const SCANNED_PDF: ItemSpec = {
  id: 'pdf-1',
  name: '2024-lease-agreement.pdf',
  mimeType: 'application/pdf',
};
const PHOTO: ItemSpec = { id: 'img-1', name: 'whiteboard.png', mimeType: 'image/png' };
const SPREADSHEET: ItemSpec = {
  id: 'xls-1',
  name: 'budget.xlsx',
  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const RECORDING: ItemSpec = { id: 'aud-1', name: 'standup.m4a', mimeType: 'audio/mp4' };
const FOLDER: ItemSpec = { id: 'dir-1', name: 'Projects', mimeType: 'inode/directory' };
const OPAQUE: ItemSpec = { id: 'bin-1', name: 'archive.bin', mimeType: 'application/octet-stream' };

describe('connector-store coverage gaps are derived source-agnostically', () => {
  test('an item stored without text names its media type instead of going silent', async () => {
    const store = newStore();
    await store.syncFromConnector(fakeConnector([
      READABLE_NOTE,
      SCANNED_PDF,
      PHOTO,
      SPREADSHEET,
      RECORDING,
      FOLDER,
      OPAQUE,
    ]), { fetchContent: true });
    const provider = createConnectorStoreContentProvider({ store });

    // An item that carries text has nothing to confess.
    expect((await block(provider, READABLE_NOTE))?.coverageGaps).toBeUndefined();

    expect((await block(provider, SCANNED_PDF))?.coverageGaps).toEqual([
      'the PDF is stored without extracted text; it may be scanned or image-only, or extraction is still pending.',
    ]);
    expect((await block(provider, PHOTO))?.coverageGaps).toEqual([
      'the image is stored without extracted text and needs optical or vision extraction.',
    ]);
    expect((await block(provider, SPREADSHEET))?.coverageGaps).toEqual([
      'the table-like document is stored without extracted text; table extraction is incomplete or pending.',
    ]);
    expect((await block(provider, RECORDING))?.coverageGaps).toEqual([
      'the recording is stored without a transcript.',
    ]);
    // A folder legitimately has no text of its own. Saying so is honest without
    // implying a failed extraction that never should have run.
    expect((await block(provider, FOLDER))?.coverageGaps).toEqual([
      'the item is a container entry and carries no text of its own.',
    ]);
    expect((await block(provider, OPAQUE))?.coverageGaps).toEqual([
      'the item is stored without extracted text yet.',
    ]);

    store.close();
  });

  test('the evidence budget is reported separately from a missing extraction', async () => {
    const store = newStore();
    await store.syncFromConnector(fakeConnector([{
      ...READABLE_NOTE,
      text: 'a'.repeat(200),
    }]), { fetchContent: true });
    const provider = createConnectorStoreContentProvider({ store });

    const full = await block(provider, READABLE_NOTE);
    expect(full?.truncated).toBeUndefined();
    expect(full?.coverageGaps).toBeUndefined();

    const clipped = await block(provider, READABLE_NOTE, 20);
    expect(clipped?.truncated).toBe(true);
    // Budget truncation is NOT an extraction gap: the text exists and was
    // trimmed to fit. Conflating the two would tell the owner their document
    // was never read when in fact only this answer's slice was bounded.
    expect(clipped?.coverageGaps).toEqual(['stored text was truncated to fit the evidence budget.']);

    store.close();
  });

  test('a stored-chunk count of zero, not an empty budget slice, is what makes a gap', () => {
    // Direct unit proof of the discriminator, independent of any store: an item
    // whose chunks were all trimmed away by a tiny budget still has stored text.
    expect(connectorStoreCoverageGaps({
      storedChunks: 3,
      truncated: true,
      mimeType: 'application/pdf',
    })).toEqual(['stored text was truncated to fit the evidence budget.']);
    expect(connectorStoreCoverageGaps({
      storedChunks: 0,
      truncated: false,
      mimeType: 'application/pdf',
    })).toEqual([
      'the PDF is stored without extracted text; it may be scanned or image-only, or extraction is still pending.',
    ]);
    // Media type matching is case- and padding-insensitive; connectors normalize
    // differently and the gap must not silently fall through to the generic arm.
    expect(connectorStoreCoverageGaps({
      storedChunks: 0,
      truncated: false,
      mimeType: '  IMAGE/JPEG ',
    })).toEqual(['the image is stored without extracted text and needs optical or vision extraction.']);
  });

  test('the gap reaches the Analyst prompt for a metadata-only item', async () => {
    const store = newStore();
    await store.syncFromConnector(fakeConnector([SCANNED_PDF]), { fetchContent: true });
    const registry = buildSourceIndexCorpusRegistry([
      defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' }),
    ]);

    const pack = await buildEvidencePack({
      question: 'What rent does the lease agreement specify?',
      maxResults: 5,
      searchContext: { allowedTrustDomains: ['secure_local'] },
      registry,
      adapters: {},
      contentProviders: { [CORPUS_ID]: createConnectorStoreContentProvider({ store }) },
      selectedItems: [{
        corpusId: CORPUS_ID,
        sourceItem: {
          family: 'file',
          provider: PROVIDER,
          accountScope: ACCOUNT,
          providerItemId: SCANNED_PDF.id,
          localItemId: localItemId(SCANNED_PDF),
        },
        citation: { title: SCANNED_PDF.name },
      }],
    });

    expect(pack.candidates).toHaveLength(1);
    expect(pack.candidates[0]!.chunks).toEqual([]);
    // The honest sentence replaces the old generic "no extractable content"
    // line, and it is attributed to the item the owner asked about.
    expect(pack.coverage.extractionGaps).toEqual([
      `${SCANNED_PDF.name} (${CORPUS_ID}) the PDF is stored without extracted text; `
      + 'it may be scanned or image-only, or extraction is still pending.',
    ]);
    expect(pack.coverage.extractionGaps.join(' ')).not.toContain('no extractable content was available');

    let sawGap = false;
    const model: AnalystModel = {
      async complete(request) {
        sawGap = request.prompt.includes('the PDF is stored without extracted text');
        return {
          text: JSON.stringify({
            answer: 'unsupported',
            citations: [],
            unanswered: ['The lease PDF is indexed but its text was never extracted.'],
            sufficient: false,
          }),
          modelId: 'scripted-local',
        };
      },
    };
    const result = await createAnalyst(model).analyze(pack, { localOnly: true });

    expect(sawGap).toBe(true);
    // Coverage is folded into unanswered regardless of what the model said, so
    // the owner is told the file exists and was never extracted.
    expect(result.unanswered.join(' ')).toContain('the PDF is stored without extracted text');
    store.close();
  });
});

function newStore(): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'connector-store-gaps-')), 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
}

function localItemId(spec: ItemSpec): string {
  return `${ACCOUNT}:${spec.id}`;
}

async function block(
  provider: ReturnType<typeof createConnectorStoreContentProvider>,
  spec: ItemSpec,
  maxChars?: number,
) {
  return provider.fetchLocalContent({
    provenance: {
      sourceItem: {
        family: 'file',
        provider: PROVIDER,
        accountScope: ACCOUNT,
        providerItemId: spec.id,
        localItemId: localItemId(spec),
      },
    },
    trustDomain: 'secure_local',
    ...(maxChars !== undefined ? { maxChars } : {}),
  });
}

function rawItem(spec: ItemSpec): RawItem {
  return {
    identity: {
      family: 'file',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: spec.id,
      providerFileId: spec.id,
      localItemId: localItemId(spec),
    },
    mimeType: spec.mimeType,
    content: spec.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: spec.text },
    metadata: { name: spec.name, locatorUri: `/fixtures/${spec.name}` },
    fetchedAt: '2026-07-27T12:00:00.000Z',
  };
}

/**
 * Minimal Contract 1 connector. `fetchItem` deliberately returns the same
 * metadata-only item it listed: that is exactly what a real connector does for
 * a file whose bytes are unreadable, and it is the state this leg is about.
 */
function fakeConnector(specs: readonly ItemSpec[]): SourceConnector {
  return {
    id: CONNECTOR_ID,
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: specs.map(rawItem), done: true };
      })();
    },
    async fetchItem(id: string): Promise<RawItem> {
      const spec = specs.find((candidate) => localItemId(candidate) === id);
      if (!spec) throw new Error('unknown item');
      return rawItem(spec);
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}
