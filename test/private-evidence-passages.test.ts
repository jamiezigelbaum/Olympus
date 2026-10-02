// Private evidence passages: the private answer panel reads what a report
// says, not its page headers.
//
// 2026-10-02 live: "What did my June 2026 blood work show?" ranked the two
// right Private reports first, but each arrived as three ~550-character
// slivers around the dates in its page headers (the file names carry the same
// date, so every header "matched"), padded with layout spaces. The panel read
// headers, found no values, and answered from another report. These tests pin
// the generic repair on synthetic scanned-report fixtures: a term the item's
// own name carries does not choose its passages, layout padding is dropped,
// and with no discriminating term the passage is contiguous text from the top.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { privateEvidence } from '../src/workers/chatgpt/private-answer-model.ts';
import type { PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { searchPrivateEvidence } from '../src/workers/source-index/analyst-answer.ts';
import type { AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';

const ACCOUNT = 'personal';
const CORPUS_ID = 'secure_local.fixture.files';
const QUESTION = 'What did my June 2026 blood work show?';
// The live per-item share: 20,000 evidence bytes over 12 Private candidates.
const LIVE_ITEM_SHARE = Math.floor(20_000 / 12);

// A scanned page (about one stored chunk): a dated header, the column padding
// OCR keeps, then values.
function page(date: string, pageNumber: number, values: readonly string[]): string {
  const header = `Patient: Sample Person      Collected: ${date}      Reported: ${date}      Page ${pageNumber}\n`
    + `Requesting clinic: Example Clinic${' '.repeat(700)}Accreditation EX-0001${' '.repeat(700)}\n`;
  const body = values.map((line) => `${line}${' '.repeat(300)}\n`).join('');
  return `${header}${body}`;
}

function report(date: string, values: readonly string[], pages: number): string {
  return Array.from({ length: pages }, (_, index) => page(date, index + 1, values.map((line) => `${line} p${index + 1}`)))
    .join('\n');
}

const FIXTURES = [
  {
    id: 'bw-1',
    name: '2026-06-29 blood work 1.pdf',
    text: report('29/06/2026', [
      'Ferritin 84 ng/mL (30-400)',
      'Haemoglobin 14.6 g/dL (13.0-17.0)',
      'Vitamin B12 512 pg/mL (200-900)',
      'TSH 2.1 mIU/L (0.4-4.0)',
      'HbA1c 5.3 % (4.0-5.6)',
      'Creatinine 0.94 mg/dL (0.7-1.3)',
    ], 3),
  },
  {
    id: 'bw-2',
    name: '2026-06-29 blood work 2.pdf',
    text: report('29/06/2026', [
      'Total cholesterol 182 mg/dL (<200)',
      'LDL cholesterol 104 mg/dL (<130)',
      'HDL cholesterol 61 mg/dL (>40)',
      'Triglycerides 88 mg/dL (<150)',
      'C-reactive protein 0.6 mg/L (<5)',
      'Vitamin D 38 ng/mL (30-100)',
    ], 3),
  },
  {
    id: 'other',
    name: '2026-06-13 MYCOTOX.pdf',
    text: report('13/06/2026', ['Ochratoxin A 2.1 ng/g', 'Aflatoxin M1 0.3 ng/g'], 2),
  },
];

describe('private evidence passages', () => {
  test('a dated report contributes its values, not slivers of its dated page headers', async () => {
    await withStore(async (store) => {
      const found = await searchPrivateEvidence({ lanes: lanesFor(store), question: QUESTION, maxCharsPerCandidate: LIVE_ITEM_SHARE });
      const titles = found.candidates.map((candidate) => candidate.provenance.citation?.title);
      // The two reports the question names lead the Private evidence.
      expect(titles.slice(0, 2).sort()).toEqual(['2026-06-29 blood work 1.pdf', '2026-06-29 blood work 2.pdf']);

      const items = privateEvidence(found.candidates as unknown as PrivateEvidenceItem[]).items;
      const text = (title: string) => items.find((item) => item.title === title)?.text ?? '';
      // Each report's passage carries its whole page of values (live, before
      // the repair: two dated header slivers and two values)...
      for (const value of ['Ferritin 84', 'Haemoglobin 14.6', 'Vitamin B12 512', 'TSH 2.1', 'HbA1c 5.3', 'Creatinine 0.94']) {
        expect(text('2026-06-29 blood work 1.pdf')).toContain(value);
      }
      for (const value of ['Total cholesterol 182', 'LDL cholesterol 104', 'HDL cholesterol 61', 'Triglycerides 88', 'C-reactive protein 0.6', 'Vitamin D 38']) {
        expect(text('2026-06-29 blood work 2.pdf')).toContain(value);
      }
      // ...as text, not layout padding.
      for (const item of items) expect(item.text).not.toMatch(/ {2,}/);
    });
  });

  test('a passage still centres on a query term the item name does not carry', async () => {
    await withStore(async (store) => {
      const found = await searchPrivateEvidence({
        lanes: lanesFor(store),
        question: 'What was my triglycerides result in the June 2026 blood work?',
        maxCharsPerCandidate: LIVE_ITEM_SHARE,
      });
      const report2 = found.candidates.find((candidate) => candidate.provenance.citation?.title === '2026-06-29 blood work 2.pdf');
      expect(report2?.chunks.join(' ')).toContain('Triglycerides 88 mg/dL');
    });
  });
});

function lanesFor(store: LocalConnectorStore): () => AnalystAnswerLanes {
  return () => ({
    registry: buildSourceIndexCorpusRegistry([
      defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' }),
    ]),
    adapters: { [CORPUS_ID]: createConnectorStoreCorpusAdapter({ store, retrievalMode: 'keyword' }) },
    contentProviders: { [CORPUS_ID]: createConnectorStoreContentProvider({ store }) },
  }) as unknown as AnalystAnswerLanes;
}

async function withStore(run: (store: LocalConnectorStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-private-passages-'));
  const store = new LocalConnectorStore({
    dbPath: join(dir, 'files.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await store.syncFromConnector(fixtureConnector(), { fetchContent: true });
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function fixtureConnector(): SourceConnector {
  const rawItems = FIXTURES.map((item): RawItem => ({
    identity: {
      family: 'file',
      provider: 'fixture_files',
      accountScope: ACCOUNT,
      providerItemId: item.id,
      providerFileId: item.id,
      localItemId: `${ACCOUNT}:${item.id}`,
      sourceVersion: `${item.id}:v1`,
    },
    mimeType: 'application/pdf',
    content: { kind: 'text', text: item.text },
    metadata: Object.freeze({
      name: item.name,
      locatorUri: `/health/${item.name}`,
      pathDisplay: `/health/${item.name}`,
      updatedAt: '2026-07-01T10:00:00.000Z',
    }),
    fetchedAt: '2026-07-01T10:00:00.000Z',
  }));
  const byId = new Map(rawItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'fixture-private-passages',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: rawItems, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing fixture ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  } as unknown as SourceConnector;
}
