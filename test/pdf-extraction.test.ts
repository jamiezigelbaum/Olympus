// PDF extraction end to end, on real PDF files.
//
// Three live defects are pinned here: a download label the text lane did not
// know replaced the catalogued PDF type (every Dropbox job settled
// `skipped_unsupported`, and no PDF was ever read); a scan with no text layer
// dead-ended as `ocr_required` because nothing ever requested the OCR lane;
// and a job whose lease expired on every attempt was re-leased for ever.

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPdfOcr } from '../src/workers/file-extraction/extractors/ocr.ts';
import { createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import {
  EXTRACTION_LEASE_EXHAUSTED_ERROR_KIND,
  LocalFileExtractionJobStore,
} from '../src/workers/file-extraction/job-store.ts';
import { createDefaultExtractorRegistry } from '../src/workers/file-extraction/registry.ts';
import {
  createFileExtractionRunner,
  drainPdfExtraction,
  type ExtractionRunnerCorpus,
} from '../src/workers/file-extraction/runner.ts';
import type { ExtractionItemRef, ExtractionSinkRequest } from '../src/workers/file-extraction/types.ts';
import { extractorInput } from './fixtures/file-extraction-extractor-fixtures.ts';
import {
  fileExtractionCorporaRoster,
  pdfExtractionLanes,
} from '../src/workers/email-source/file-extraction-runtime.ts';
import { GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY } from '../src/workers/google-connectors/drive-extraction-source.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
} from '../src/workers/google-connectors/drive.ts';
import { createGoogleDriveConnectorStoreSchedulerSource } from '../src/workers/source-scheduler.ts';
import { defaultConfig } from '../src/core/config.ts';

const TEXT_PDF = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/pdf/text-layer.pdf')));
const SCANNED_PDF = new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures/pdf/scanned-receipt.pdf')));
const PDF = 'application/pdf';
const LANE = {
  corpusId: 'secure_local.fake.files',
  provider: 'fake',
  accountScope: 'personal',
  approvedScopeKey: 'fake.personal:/',
};

function pdfRef(index: number, overrides: Partial<ExtractionItemRef> = {}): ExtractionItemRef {
  return {
    ...LANE,
    providerItemId: `id:${index}`,
    localItemId: `personal:id:${index}`,
    mimeType: PDF,
    name: `file-${index}.pdf`,
    ...overrides,
  };
}

function corpus(input: {
  refs: readonly ExtractionItemRef[];
  bytes: Uint8Array;
  label?: string;
  written: ExtractionSinkRequest[];
}): ExtractionRunnerCorpus {
  return {
    corpusId: LANE.corpusId,
    trustDomain: 'secure_local',
    source: {
      id: 'fake',
      corpusId: LANE.corpusId,
      provider: LANE.provider,
      async listCandidates(options) {
        const refs = input.refs.filter((ref) => !options.mimeTypes || options.mimeTypes.includes(ref.mimeType ?? ''));
        return { candidates: refs, done: true };
      },
      async fetch() {
        return { bytes: input.bytes, ...(input.label ? { mimeType: input.label } : {}) };
      },
    },
    sink: {
      async accept(request) {
        input.written.push(request);
        return { accepted: true, chunksIndexed: 1, chunksAwaitingEmbedding: 1 };
      },
    },
  };
}

const ENOENT = () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

describe('PDF extraction: text layer', () => {
  test('a real PDF is read whatever label its download carried', async () => {
    for (const label of [undefined, 'application/octet-stream', 'application/binary', 'text/plain']) {
      const jobs = new LocalFileExtractionJobStore(':memory:');
      const written: ExtractionSinkRequest[] = [];
      try {
        const runner = createFileExtractionRunner({
          jobs,
          registry: createDefaultExtractorRegistry(),
          corpora: [corpus({ refs: [pdfRef(1)], bytes: TEXT_PDF, ...(label ? { label } : {}), written })],
        });
        await runner.plan({ ...LANE, limit: 10, policyDecision: 'index_allowed' });
        const result = await runner.run({ ...LANE });
        expect(result.counts.indexed).toBe(1);
        expect(written[0]?.text).toContain('Olympus invoice number 4471 due October');
      } finally {
        jobs.close();
      }
    }
  });

  test('a PDF catalogued under a generic type is recognised by its signature', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: TEXT_PDF,
      mimeType: 'application/octet-stream',
    }));
    expect(result.status).toBe('indexed');
    if (result.status === 'indexed') expect(result.text).toContain('invoice number 4471');
  });

  test('without poppler installed the inline decoder reads the text layer', async () => {
    const result = await createTextExtractor({
      pdfTextCommand: 'pdftotext',
      pdfTextCommandRunner: ENOENT,
    }).extract(extractorInput({ bytes: TEXT_PDF, mimeType: PDF }));
    expect(result.status).toBe('indexed');
    if (result.status === 'indexed') expect(result.text).toContain('invoice number 4471');
  });

  test.skipIf(!Bun.which('pdftotext'))('poppler reads the real PDF when installed', async () => {
    const result = await createTextExtractor({ pdfTextCommand: 'pdftotext' })
      .extract(extractorInput({ bytes: TEXT_PDF, mimeType: PDF }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('invoice number 4471');
    expect(result.derivations?.[0]?.warnings).toContain('pdf_text_poppler');
  });
});

describe('PDF extraction: scans', () => {
  test('a scan is left visibly ocr_required when OCR is not installed', async () => {
    const result = await createTextExtractor({ pdfOcr: createPdfOcr({ commandRunner: ENOENT }) })
      .extract(extractorInput({ bytes: SCANNED_PDF, mimeType: PDF }));
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.warnings).toContain('ocr_required');
  });

  test('a scan is read by OCR through the text lane', async () => {
    const calls: string[] = [];
    const result = await createTextExtractor({
      pdfOcr: createPdfOcr({
        commandRunner: async (request) => {
          calls.push(request.command);
          const sidecar = request.args[request.args.indexOf('--sidecar') + 1]!;
          await writeFile(sidecar, 'SCANNED RECEIPT 7731\nHarbor Supply Company\n');
          return { stdout: '', stderr: '' };
        },
      }),
    }).extract(extractorInput({ bytes: SCANNED_PDF, mimeType: PDF }));
    expect(calls).toEqual(['ocrmypdf']);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('SCANNED RECEIPT 7731');
    expect(result.derivations?.[0]?.warnings).toContain('ocr_text');
  });

  test('a PDF the OCR command must refuse settles terminally, not as a retry', async () => {
    const { ExtractionCommandError } = await import('../src/workers/file-extraction/extractors/command-runner.ts');
    const result = await createTextExtractor({
      pdfOcr: createPdfOcr({
        commandRunner: async (request) => {
          throw new ExtractionCommandError({ command: request.command, exitCode: 8, stdout: '', stderr: 'encrypted' });
        },
      }),
    }).extract(extractorInput({ bytes: SCANNED_PDF, mimeType: PDF }));
    expect(result).toEqual({ status: 'failed_terminal', errorKind: 'ocrmypdf_pdf_encrypted' });
  });

  test.skipIf(!Bun.which('ocrmypdf') || !Bun.which('tesseract') || !Bun.which('unpaper'))(
    'the default registry reads the real scan with ocrmypdf when installed',
    async () => {
      const jobs = new LocalFileExtractionJobStore(':memory:');
      const written: ExtractionSinkRequest[] = [];
      try {
        const runner = createFileExtractionRunner({
          jobs,
          registry: createDefaultExtractorRegistry(),
          corpora: [corpus({ refs: [pdfRef(1)], bytes: SCANNED_PDF, label: 'application/octet-stream', written })],
        });
        await runner.plan({ ...LANE, limit: 10, policyDecision: 'index_allowed' });
        const result = await runner.run({ ...LANE, leaseSeconds: 600 });
        expect(result.counts.indexed).toBe(1);
        expect(written[0]?.text).toContain('7731');
      } finally {
        jobs.close();
      }
    },
    120_000,
  );
});

describe('PDF extraction: queue recovery', () => {
  test('a job whose lease expired on every attempt comes to rest instead of re-leasing for ever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-pdf-lease-'));
    const dbPath = join(dir, 'jobs.sqlite');
    const jobs = new LocalFileExtractionJobStore(dbPath);
    try {
      jobs.enqueue({ refs: [pdfRef(1)], extractorKind: 'local_text', extractorVersion: 'v', policyDecision: 'index_allowed' });
      const expire = () => {
        const db = new Database(dbPath);
        db.query("UPDATE extraction_jobs SET leased_until = '2000-01-01T00:00:00.000Z' WHERE status = 'leased'").run();
        db.close();
      };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect(jobs.lease({ ...LANE, workerId: 'w' }).leasedJobs).toHaveLength(1);
        expire();
      }
      expect(jobs.lease({ ...LANE, workerId: 'w' }).leasedJobs).toHaveLength(0);
      const settled = jobs.counts(LANE);
      expect(settled).toEqual([{ status: 'failed_terminal', extractorKind: 'local_text', jobs: 1 }]);
      const db = new Database(dbPath);
      const row = db.query('SELECT last_error_kind FROM extraction_jobs').get() as { last_error_kind: string };
      db.close();
      expect(row.last_error_kind).toBe(EXTRACTION_LEASE_EXHAUSTED_ERROR_KIND);
    } finally {
      jobs.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the owner-triggered drain re-queues PDFs an earlier pass skipped and extracts them', async () => {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    const written: ExtractionSinkRequest[] = [];
    try {
      const refs = [pdfRef(1), pdfRef(2), pdfRef(3, { mimeType: 'text/plain', name: 'notes.txt' })];
      const registry = createDefaultExtractorRegistry();
      const runner = createFileExtractionRunner({
        jobs,
        registry,
        corpora: [corpus({ refs, bytes: TEXT_PDF, label: 'application/binary', written })],
      });
      // The state the live queue is in: PDFs settled without being read.
      jobs.enqueue({ refs: refs.slice(0, 2), extractorKind: 'local_text', extractorVersion: registry.get('local_text')!.version, policyDecision: 'index_allowed' });
      const lease = jobs.lease({ ...LANE, workerId: 'old' });
      for (const job of lease.leasedJobs) {
        jobs.record({ jobId: job.jobId, workerId: 'old', leaseToken: job.leaseToken, status: 'skipped_unsupported' });
      }

      const [result] = await drainPdfExtraction({
        runner,
        lanes: [LANE],
        requeue: true,
        deadlineMs: Date.now() + 60_000,
        extractorKind: 'local_text',
      });

      expect(result).toMatchObject({ candidatesRequeued: 2, jobsIndexed: 2, jobsRemaining: 0, paused: false });
      expect(written.map((request) => request.ref.providerItemId).sort()).toEqual(['id:1', 'id:2']);
    } finally {
      jobs.close();
    }
  });
});

describe('PDF extraction: Google Drive', () => {
  test('Drive PDFs are served by the extraction roster and drained on the owner lane', () => {
    const roster = fileExtractionCorporaRoster({
      configured: [],
      googleDrive: {
        corpusIds: [GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID],
        resolveCredentialHandle: () => 'google_drive.personal',
        resolveAccountScope: () => 'personal',
      },
    });
    expect(roster.map((entry) => [entry.corpusId, entry.provider, entry.scopes])).toEqual([
      [GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID, 'google_drive', [GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY]],
      [GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID, 'google_drive', [GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY]],
    ]);
    expect(pdfExtractionLanes(roster, [GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID])).toEqual([{
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      provider: 'google_drive',
      accountScope: 'personal',
      approvedScopeKey: GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY,
    }]);
  });

  test('the Drive lane schedules a PDF extraction pass that reads a real PDF', async () => {
    const jobs = new LocalFileExtractionJobStore(':memory:');
    const written: ExtractionSinkRequest[] = [];
    const lane = {
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      provider: 'google_drive',
      accountScope: 'personal',
      approvedScopeKey: GOOGLE_DRIVE_EXTRACTION_SCOPE_KEY,
    };
    try {
      const base = corpus({ refs: [{ ...pdfRef(1), ...lane }], bytes: TEXT_PDF, label: 'application/pdf', written });
      const runner = createFileExtractionRunner({
        jobs,
        registry: createDefaultExtractorRegistry(),
        corpora: [{ ...base, corpusId: lane.corpusId }],
      });
      const source = createGoogleDriveConnectorStoreSchedulerSource({
        config: defaultConfig(),
        liveSync: {} as never,
        fileExtraction: runner,
        extractionAccountScope: 'personal',
      })!;
      const task = source.tasks.find((candidate) => candidate.id.startsWith('google_drive.docs_extract.'))!;
      expect(source.tasks.filter((candidate) => candidate.kind === 'extract')).toHaveLength(2);
      const outcome = await task.run();
      expect(outcome.counts).toMatchObject({ jobs_queued: 1, jobs_indexed: 1 });
      expect(written[0]?.text).toContain('invoice number 4471');
    } finally {
      jobs.close();
    }
  });
});

describe('PDF extraction: backlog report', () => {
  test('a store reports its PDFs without text and the volume of those extracted', async () => {
    const { LocalConnectorStore } = await import('../src/workers/connector-store/index.ts');
    const dir = mkdtempSync(join(tmpdir(), 'olympus-pdf-backlog-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'files.sqlite'),
      corpusId: 'secure_local.fake.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    const items = [
      { id: 'read', mimeType: PDF, text: 'Extracted contract text. '.repeat(40) },
      { id: 'scan-a', mimeType: PDF },
      { id: 'scan-b', mimeType: PDF },
      { id: 'notes', mimeType: 'text/plain' },
    ].map((item) => ({
      identity: {
        family: 'file' as const,
        provider: 'fake',
        accountScope: 'personal',
        providerItemId: item.id,
        providerFileId: item.id,
        localItemId: `personal:${item.id}`,
        sourceVersion: `${item.id}:v1`,
      },
      mimeType: item.mimeType,
      content: item.text === undefined ? { kind: 'metadata_only' as const } : { kind: 'text' as const, text: item.text },
      metadata: Object.freeze({ name: `${item.id}.pdf`, locatorUri: `/${item.id}.pdf` }),
      fetchedAt: '2026-09-30T10:00:00.000Z',
    }));
    try {
      await store.syncFromConnector({
        id: 'fake-files',
        family: 'file',
        async authenticate() {},
        listItems() {
          return (async function* () { yield { items, done: true }; })();
        },
        async fetchItem(localItemId: string) {
          return items.find((item) => item.identity.localItemId === localItemId)!;
        },
        classificationSignals() { return {}; },
      }, { fetchContent: true });
      const backlog = store.pdfExtractionBacklog();
      expect(backlog.pendingPdfs).toBe(2);
      expect(backlog.extractedPdfs).toBe(1);
      expect(backlog.extractedChars).toBeGreaterThan(900);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
