import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  collectLocalSourceIngestionLedger,
  SqliteSourceIngestionLedgerStore,
  buildSourceIngestionLedgerSnapshot,
  formatSourceIngestionLedger,
} from '../src/workers/source-ingestion-ledger.ts';
import {
  createSourceCorpusRegistry,
  defaultSourceCorpusRegistryConfig,
} from '../src/core/source-corpus-registry.ts';
import { createSourceExclusionMatcherFromPrefixes } from '../src/core/source-ingestion-exclusions.ts';
import { assessContentExtractionThroughput } from '../src/core/ingestion-throughput.ts';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';
import {
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  defaultProtectedTelegramConnectorStoreDbPath,
} from '../src/workers/telegram-messages/index.ts';

describe('source ingestion ledger', () => {
  test('normalizes source status into the seven-source ingestion census', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(fixtureStatus(), {
      now: new Date('2026-07-08T20:00:00.000Z'),
      schedulerStatus: {
        kind: 'source_scheduler_status',
        enabled: true,
        running: true,
        generated_at: '2026-07-08T20:00:00.000Z',
        sources: [{
          source_id: 'gmail.email',
          corpus_id: 'secure_local.email.private',
          sync_cadence: 'continuous',
          sync_interval_seconds: 600,
          freshness_threshold_hours: 24,
          freshness_hours: 72,
          stale_sync_anomaly: true,
          tasks: [],
        }],
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_scope_keys_exposed: false,
          counts_only: true,
        },
      },
      dropboxFailureBreakdown: [
        {
          status: 'failed_terminal',
          extractor_kind: 'local_ocr_tesseract',
          error_class: 'image_pdf',
          count: 2,
          oldest_created_at: '2026-07-07T20:00:00.000Z',
          newest_updated_at: '2026-07-08T18:00:00.000Z',
        },
        {
          status: 'queued',
          extractor_kind: 'vlm_pdf',
          count: 3,
          oldest_created_at: '2026-07-07T14:00:00.000Z',
          newest_updated_at: '2026-07-08T19:30:00.000Z',
        },
      ],
      unreadableContent: [{
        name: 'PT COMPANY | Pat Example.pdf',
        path_display: '/2 Areas/Legal/Lexidy/PT COMPANY | Pat Example.pdf',
        status: 'failed_retryable',
        extractor_kind: 'local_ocr_tesseract',
        error_class: 'image_pdf',
        updated_at: '2026-07-08T19:00:00.000Z',
      }],
    });

    expect(snapshot.rows).toHaveLength(7);
    expect(snapshot.rows.find((row) => row.source_id === 'email')).toMatchObject({
      items: 10,
      content_indexed: 8,
      metadata_only: 2,
      freshness_hours: 72,
      attention: [expect.stringContaining('stale sync')],
    });
    expect(snapshot.rows.find((row) => row.source_id === 'dropbox')).toMatchObject({
      items: 20,
      content_indexed: 4,
      coverage_percent: 20,
      metadata_only: 16,
      failed: 2,
      stuck: { queued: 3, active: 1, held_paused: 3, broken: 2 },
      ingestion_health: {
        coverage_percent: 20,
        stuck_work: {
          queued: 3,
          failed_terminal: 2,
          oldest_age_hours: 30,
        },
        drain: {
          state: 'held',
          unit: 'olympus-source-processing-supervisor-vlm-pdf.timer',
          last_activity_hours: 0.5,
        },
      },
      failure_breakdown: expect.arrayContaining([
        expect.objectContaining({ extractor_kind: 'local_ocr_tesseract', error_class: 'image_pdf', count: 2 }),
      ]),
    });
    expect(snapshot.rows.find((row) => row.source_id === 'whatsapp')?.attention).toContain('secure_local.whatsapp.messages not initialized');
    expect(snapshot.unreadable_content?.[0]).toMatchObject({
      name: 'PT COMPANY | Pat Example.pdf',
      path_display: expect.stringContaining('/2 Areas/Legal/Lexidy/'),
    });
  });

  test('omits unreadable file metadata from Castor-safe status ledger payload', async () => {
    const status = await createSourceIndexStatusHandler({
      corpusDefinitions: [defineSourceIndexCorpus({
        corpusId: 'secure_local.email.private',
        family: 'email',
        trustDomain: 'secure_local',
        description: 'fixture',
      })],
    }).status({ include_ingestion_ledger: true });

    expect(status.ingestion_ledger).toMatchObject({
      kind: 'source_ingestion_ledger',
      policy: { castor_safe: true, raw_source_exposed: false },
    });
    expect(JSON.stringify(status.ingestion_ledger)).not.toContain('path_display');
  });

  test('records latest ledger rows and dashboard samples in source-dashboard.sqlite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-'));
    const dbPath = join(dir, 'source-dashboard.sqlite');
    const store = new SqliteSourceIngestionLedgerStore(dbPath);
    try {
      store.record(buildSourceIngestionLedgerSnapshot(fixtureStatus(), {
        now: new Date('2026-07-08T20:00:00.000Z'),
      }));
    } finally {
      store.close();
    }
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        expect((db.query('SELECT COUNT(*) AS count FROM source_ingestion_ledger').get() as { count: number }).count).toBe(7);
        expect((db.query('SELECT COUNT(*) AS count FROM source_dashboard_samples').get() as { count: number }).count).toBe(7);
        expect(db.query('SELECT items, content_indexed, coverage_percent, ingestion_health_json FROM source_ingestion_ledger WHERE source_id = ?').get('dropbox')).toMatchObject({
          items: 20,
          content_indexed: 4,
          coverage_percent: 20,
          ingestion_health_json: expect.stringContaining('coverage_percent'),
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('collects WhatsApp ingestion from mounted connector-store path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-whatsapp-'));
    const dbPath = join(dir, 'whatsapp-live', 'connector-store.db');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      const item = whatsappItem({
        id: 'wamid-ledger-1',
        text: 'WhatsApp connector-store ledger fixture.',
        updatedAt: '2026-07-08T19:02:00.000Z',
      });
      await store.syncFromConnector(whatsappConnector([item]), { fetchContent: true });
    } finally {
      store.close();
    }

    try {
      const snapshot = await collectLocalSourceIngestionLedger({
        env: {
          XDG_DATA_HOME: join(dir, 'empty-data-home'),
          OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([{
            dbPath,
            corpusId: 'secure_local.whatsapp.messages',
            family: 'chat',
            trustDomain: 'secure_local',
          }]),
        },
        dashboardDbPath: join(dir, 'source-dashboard.sqlite'),
        now: new Date('2026-07-08T20:00:00.000Z'),
      });
      const whatsapp = snapshot.rows.find((row) => row.source_id === 'whatsapp');

      expect(whatsapp).toMatchObject({
        configured: true,
        items: 1,
        content_indexed: 1,
        metadata_only: 0,
        primary_corpus_id: 'secure_local.whatsapp.messages',
        corpus_ids: ['secure_local.whatsapp.messages'],
      });
      expect(whatsapp?.attention).not.toContain('secure_local.whatsapp.messages not initialized');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normal collection does not read a seeded Telegram legacy index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-telegram-legacy-'));
    const legacyPath = join(dir, 'telegram-legacy.sqlite');
    // This path is deliberately not a database. If collection still consulted
    // the retired environment variable it would fail instead of returning the
    // connector-store-only census below.
    writeFileSync(legacyPath, 'retired Telegram index sentinel');

    try {
      const snapshot = await collectLocalSourceIngestionLedger({
        env: {
          XDG_DATA_HOME: join(dir, 'empty-data-home'),
          OLYMPUS_SOURCE_INDEX_TELEGRAM_MESSAGES_DB_PATH: legacyPath,
        },
        dashboardDbPath: join(dir, 'source-dashboard.sqlite'),
        now: new Date('2026-07-08T20:00:00.000Z'),
      });
      expect(snapshot.rows.find((row) => row.source_id === 'telegram')).toMatchObject({
        items: 0,
        configured: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normal collection includes the canonical protected Telegram connector store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-telegram-store-'));
    const env = { HOME: join(dir, 'home'), XDG_DATA_HOME: join(dir, 'data') };
    const dbPath = defaultProtectedTelegramConnectorStoreDbPath(env);
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(whatsappConnector([whatsappItem({
        id: 'telegram-ledger-1',
        text: 'Protected Telegram ledger fixture.',
        updatedAt: '2026-07-08T19:02:00.000Z',
      })]), { fetchContent: true });
    } finally {
      store.close();
    }

    try {
      const snapshot = await collectLocalSourceIngestionLedger({
        env,
        dashboardDbPath: join(dir, 'source-dashboard.sqlite'),
        now: new Date('2026-07-08T20:00:00.000Z'),
      });
      expect(snapshot.rows.find((row) => row.source_id === 'telegram')).toMatchObject({
        configured: true,
        items: 1,
        corpus_ids: expect.arrayContaining([PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID]),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('normal collection does not read a seeded Dropbox legacy index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-dropbox-legacy-'));
    const legacyPath = join(dir, 'dropbox-legacy.sqlite');
    // As above, a non-SQLite sentinel makes accidental legacy-path reads fail
    // loudly while keeping the test independent of the deleted store class.
    writeFileSync(legacyPath, 'retired Dropbox index sentinel');

    try {
      const snapshot = await collectLocalSourceIngestionLedger({
        env: {
          XDG_DATA_HOME: join(dir, 'empty-data-home'),
          OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_DB_PATH: legacyPath,
        },
        dashboardDbPath: join(dir, 'source-dashboard.sqlite'),
        now: new Date('2026-07-08T20:00:00.000Z'),
      });
      expect(snapshot.rows.find((row) => row.source_id === 'dropbox')).toMatchObject({
        items: 0,
        configured: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A subject-named internal band carried on a provider's row. Its id contains no
// provider token, which is exactly what the old id-sniffing assignment dropped.
const BAND_CORPUS_ID = 'internal.retired.library';
// An indexed corpus the registry does not carry at all — a retired id is the
// most realistic way that arises, and it must still be counted rather than
// silently vanish from the totals.
const UNCLAIMED_CORPUS_ID = 'internal.retired.agent-library';

// Row assignment used to substring-scan corpus ids for a provider token and
// `continue` past whatever carried none. These pin the reproduction and the
// class-level property: nothing leaves the status result without a home.
describe('ledger corpus assignment', () => {
  const NOW = new Date('2026-07-28T12:00:00.000Z');

  test('a subject-named band on a provider row is assigned by the registry, not by id-sniffing', () => {
    // The original defect: row assignment substring-scanned corpus ids for a
    // provider token and `continue`d past whatever carried none, silently
    // vanishing a band whose id names its SUBJECT rather than its provider.
    // The corpus that first exposed this has since been retired, so the case is
    // reconstructed through the injectable registry — the property is about how
    // assignment works, not about which corpora happen to ship today.
    const registry = createSourceCorpusRegistry({
      schemaVersion: 1,
      corpora: [
        ...defaultSourceCorpusRegistryConfig().corpora,
        {
          corpusId: BAND_CORPUS_ID,
          sourceId: 'dropbox.files',
          provider: 'dropbox',
          family: 'file',
          trustDomain: 'internal',
          capabilities: ['answer', 'status', 'search'],
        },
      ],
    });
    const snapshot = buildSourceIngestionLedgerSnapshot(statusWithCorpora([
      dropboxFilesCorpus(4000, 4000),
      corpusFixture(BAND_CORPUS_ID, 'file', 'internal', 900, 900),
    ]), { now: NOW, sourceCorpusRegistry: registry });

    const dropbox = snapshot.rows.find((row) => row.source_id === 'dropbox');
    expect(dropbox?.items).toBe(4900);
    expect(dropbox?.content_indexed).toBe(4900);
    expect(dropbox?.corpus_ids).toEqual(expect.arrayContaining([
      'secure_local.dropbox.files',
      BAND_CORPUS_ID,
    ]));
    expect(dropbox?.trust_domains).toEqual(expect.arrayContaining(['secure_local', 'internal']));
    expect(snapshot.unassigned_corpora.corpus_count).toBe(0);
  });

  test('aggregates throughput without letting an idle sibling corpus hide a stall', () => {
    const internal = corpusFixture('internal.drive.docs', 'file', 'internal', 10, 10);
    internal.content_extraction_throughput = {
      actionable_queued: 7,
      actionable_retryable_due: 2,
      oldest_actionable_at: '2026-07-27T00:00:00.000Z',
      newest_terminal_progress_at: '2026-07-27T01:00:00.000Z',
    };
    const secure = corpusFixture('secure_local.drive.docs', 'file', 'secure_local', 5, 5);
    secure.content_extraction_throughput = {
      actionable_queued: 0,
      actionable_retryable_due: 0,
      newest_terminal_progress_at: '2026-07-28T11:59:00.000Z',
    };

    const snapshot = buildSourceIngestionLedgerSnapshot(statusWithCorpora([internal, secure]), { now: NOW });
    expect(snapshot.rows.find((row) => row.source_id === 'google_drive')?.ingestion_health)
      .toMatchObject({
        content_extraction_throughput: {
          actionable_queued: 7,
          actionable_retryable_due: 2,
          oldest_actionable_at: '2026-07-27T00:00:00.000Z',
          newest_terminal_progress_at: '2026-07-27T01:00:00.000Z',
        },
        stuck_work: {
          queued: 7,
          failed_retryable: 2,
          oldest_item_at: '2026-07-27T00:00:00.000Z',
        },
      });
  });

  test('keeps aggregate throughput timing unknown when an actionable corpus has no clock', () => {
    const internal = corpusFixture('internal.drive.docs', 'file', 'internal', 10, 10);
    internal.content_extraction_throughput = {
      actionable_queued: 1,
      actionable_retryable_due: 0,
    };
    const secure = corpusFixture('secure_local.drive.docs', 'file', 'secure_local', 5, 5);
    secure.content_extraction_throughput = {
      actionable_queued: 1,
      actionable_retryable_due: 0,
      oldest_actionable_at: '2026-07-28T11:00:00.000Z',
      newest_terminal_progress_at: '2026-07-28T11:30:00.000Z',
    };

    const row = buildSourceIngestionLedgerSnapshot(statusWithCorpora([internal, secure]), { now: NOW })
      .rows.find((candidate) => candidate.source_id === 'google_drive');
    expect(row?.ingestion_health.content_extraction_throughput).toEqual({
      actionable_queued: 2,
      actionable_retryable_due: 0,
    });
    expect(row?.ingestion_health.stuck_work).not.toHaveProperty('oldest_item_at');
  });

  test('preserves paired corpus clocks before selecting the source stall bound', () => {
    const internal = corpusFixture('internal.drive.docs', 'file', 'internal', 10, 10);
    internal.content_extraction_throughput = {
      actionable_queued: 1,
      actionable_retryable_due: 0,
      oldest_actionable_at: '2026-07-27T00:00:00.000Z',
      newest_terminal_progress_at: '2026-07-28T11:00:00.000Z',
    };
    const secure = corpusFixture('secure_local.drive.docs', 'file', 'secure_local', 5, 5);
    secure.content_extraction_throughput = {
      actionable_queued: 1,
      actionable_retryable_due: 0,
      oldest_actionable_at: '2026-07-28T10:00:00.000Z',
      newest_terminal_progress_at: '2026-07-27T01:00:00.000Z',
    };

    const throughput = buildSourceIngestionLedgerSnapshot(statusWithCorpora([internal, secure]), { now: NOW })
      .rows.find((candidate) => candidate.source_id === 'google_drive')
      ?.ingestion_health.content_extraction_throughput;
    expect(throughput).toMatchObject({
      oldest_actionable_at: '2026-07-27T00:00:00.000Z',
      newest_terminal_progress_at: '2026-07-28T10:00:00.000Z',
    });
    expect(assessContentExtractionThroughput(throughput!, { now: NOW, thresholdHours: 6 }).state)
      .toBe('healthy');
  });

  // After the Dropbox family flips read authority the same corpus id is served
  // by the connector-store status projection, whose counts are a different key
  // space. Reading only the legacy content keys reported 0% coverage on the
  // largest corpus at exactly the moment an operator was validating the flip.
  test('counts Dropbox content under the connector-store key space after a read-authority flip', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(
      statusWithCorpora([dropboxFilesConnectorStoreCorpus(4000, 3600)]),
      { now: NOW },
    );

    expect(snapshot.rows.find((row) => row.source_id === 'dropbox')).toMatchObject({
      items: 4000,
      content_indexed: 3600,
      metadata_only: 400,
      coverage_percent: 90,
    });
  });

  // Owner ruling, 2026-08-21: files the system is never asked to read are not
  // files it failed to read, so they leave the denominator. The raw indexed
  // count stays exactly where it was.
  test('coverage divides by the files this source is meant to read', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(
      statusWithCorpora([dropboxFilesCorpus(1000, 400, { qa_metadata_only_expected: 600 })]),
      { now: NOW },
    );

    const dropbox = snapshot.rows.find((row) => row.source_id === 'dropbox');
    expect(dropbox?.items).toBe(1000);
    expect(dropbox?.content_indexed).toBe(400);
    // 400 of the 400 eligible files, not 400 of 1000.
    expect(dropbox?.coverage_percent).toBe(100);
    expect(dropbox?.ingestion_health.coverage_percent).toBe(100);
    expect(dropbox?.ingestion_health.not_read_by_policy_items).toBe(600);
  });

  test('both policy verdicts leave the denominator together', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(
      statusWithCorpora([dropboxFilesCorpus(100, 30, {
        qa_metadata_only_expected: 30,
        qa_blocked_policy: 10,
      })]),
      { now: NOW },
    );

    const dropbox = snapshot.rows.find((row) => row.source_id === 'dropbox');
    expect(dropbox?.ingestion_health.not_read_by_policy_items).toBe(40);
    expect(dropbox?.ingestion_health.metadata_only_by_policy_items).toBe(30);
    expect(dropbox?.coverage_percent).toBe(50);
  });

  test('a source whose every file is deferred divides by nothing rather than by zero', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(
      statusWithCorpora([dropboxFilesCorpus(500, 0, { qa_metadata_only_expected: 500 })]),
      { now: NOW },
    );

    const dropbox = snapshot.rows.find((row) => row.source_id === 'dropbox');
    expect(dropbox?.coverage_percent).toBe(100);
    expect(Number.isFinite(dropbox?.coverage_percent ?? Number.NaN)).toBe(true);
    // The raw count is still the honest half of the pair.
    expect(dropbox?.items).toBe(500);
    expect(dropbox?.ingestion_health.not_read_by_policy_items).toBe(500);
  });

  test('a source reporting no policy verdict keeps the ratio it always had', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(
      statusWithCorpora([corpusFixture('internal.email', 'email', 'internal', 200, 50)]),
      { now: NOW },
    );

    const email = snapshot.rows.find((row) => row.source_id === 'email');
    expect(email?.coverage_percent).toBe(25);
    expect(email?.ingestion_health.not_read_by_policy_items).toBeUndefined();
    expect(email?.ingestion_health.metadata_only_by_policy_items).toBeUndefined();
  });

  test('a corpus no ledger row owns is listed and counted rather than skipped in silence', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(statusWithCorpora([
      dropboxFilesCorpus(4000, 4000),
      corpusFixture(UNCLAIMED_CORPUS_ID, 'file', 'internal', 42, 42),
    ]), { now: NOW });

    expect(snapshot.unassigned_corpora).toMatchObject({
      corpus_count: 1,
      items: 42,
      content_indexed: 42,
      entries: [{
        corpus_id: UNCLAIMED_CORPUS_ID,
        trust_domain: 'internal',
        items: 42,
        content_indexed: 42,
      }],
    });
    // Visible on the text surface too, which reads `attention` and not the
    // structured section.
    expect(snapshot.attention).toEqual(expect.arrayContaining([
      expect.stringContaining(UNCLAIMED_CORPUS_ID),
    ]));
    expect(formatSourceIngestionLedger(snapshot)).toContain(UNCLAIMED_CORPUS_ID);
  });

  test('every registry corpus is counted into a row or reported as unassigned, never dropped', () => {
    const registryCorpora = createSourceCorpusRegistry().list('status');
    const status = statusWithCorpora(registryCorpora.map((corpus, index) =>
      corpusFixture(corpus.corpusId, corpus.family, corpus.trustDomain, index + 1, index + 1)));
    const expectedItems = registryCorpora.reduce((sum, _corpus, index) => sum + index + 1, 0);

    const snapshot = buildSourceIngestionLedgerSnapshot(status, { now: NOW });

    const accountedFor = snapshot.rows.reduce((sum, row) => sum + row.items, 0)
      + snapshot.unassigned_corpora.items;
    expect(accountedFor).toBe(expectedItems);
    // Every shipped registry corpus is declared by some ledger row today. The
    // assertion that matters is the one above: whatever the roster becomes,
    // items land in a row or in `unassigned`, and never nowhere.
    expect(snapshot.unassigned_corpora.entries.map((entry) => entry.corpus_id)).toEqual([]);
  });

  test('every registry source id a ledger row declares exists in the registry', () => {
    // Guards the whatsapp_personal/whatsapp class of defect from the other
    // side: a mistyped declaration would own nothing and drop its corpora.
    const registrySourceIds = new Set(createSourceCorpusRegistry().list().map((corpus) => corpus.sourceId));
    const status = statusWithCorpora(createSourceCorpusRegistry().list('status')
      .map((corpus) => corpusFixture(corpus.corpusId, corpus.family, corpus.trustDomain, 1, 1)));
    const snapshot = buildSourceIngestionLedgerSnapshot(status, { now: NOW });

    const ownsNothing = snapshot.rows
      .filter((row) => row.corpus_ids.length === 0)
      .map((row) => row.source_id);
    expect(ownsNothing).toEqual([]);
    expect(registrySourceIds.has('whatsapp.personal.messages')).toBe(true);
  });
});

// "Excluded by configuration" is an omission the owner CHOSE, and the whole
// point of this section is that a chosen omission still has to be said out
// loud — the same failure class as the unassigned corpora above, arrived at
// from the other direction.
describe('ledger folders excluded by configuration', () => {
  const NOW = new Date('2026-07-28T12:00:00.000Z');
  const AGENT_CORPUS_EXCLUSION = createSourceExclusionMatcherFromPrefixes([
    { ruleId: 'agent-corpus', mode: 'exclude' as const, kind: 'path_prefix' as const, prefix: '/3 Resources/Books', reason: 'another system curates this' },
    { ruleId: 'agent-corpus', mode: 'exclude' as const, kind: 'path_prefix' as const, prefix: '/3 Resources/Papers', reason: 'another system curates this' },
  ]);

  test('reports the configured exclusion folders and the items still stored under them', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(statusWithCorpora([dropboxFilesCorpus(4000, 4000)]), {
      now: NOW,
      exclusions: [{ matcher: AGENT_CORPUS_EXCLUSION, present: { items: 120, unevaluable: 4 } }],
    });

    expect(snapshot.excluded_by_configuration).toEqual({
      rules: 1,
      prefixes: 2,
      metadata_only_rules: 0,
      metadata_only_prefixes: 0,
      items_metadata_only_content_present: 0,
      items_present: 120,
      items_unevaluable: 4,
      entries: [
        { rule_id: 'agent-corpus', prefix: '/3 resources/books', mode: 'exclude', kind: 'path_prefix', reason: 'another system curates this' },
        { rule_id: 'agent-corpus', prefix: '/3 resources/papers', mode: 'exclude', kind: 'path_prefix', reason: 'another system curates this' },
      ],
    });
    // Text surfaces read `attention` and not the structured section.
    expect(snapshot.attention).toEqual(expect.arrayContaining([
      expect.stringContaining('Excluded by configuration: 120 stored item(s)'),
    ]));
    const rendered = formatSourceIngestionLedger(snapshot);
    expect(rendered).toContain('Excluded by configuration — never ingested (1 rule, 2 folders):');
    expect(rendered).toContain('/3 resources/books');
    expect(rendered).toContain('120 item(s) indexed before these folders were excluded are still stored');
    expect(rendered).toContain('4 with a path the gate cannot read');
  });

  test('says a purged store is clean instead of printing a bare zero', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(statusWithCorpora([dropboxFilesCorpus(4000, 4000)]), {
      now: NOW,
      exclusions: [{ matcher: AGENT_CORPUS_EXCLUSION, present: { items: 0, unevaluable: 0 } }],
    });

    expect(snapshot.excluded_by_configuration).toMatchObject({ prefixes: 2, items_present: 0 });
    // The rules are still listed: a list that failed to load and a list that
    // matched nothing must not look the same.
    expect(formatSourceIngestionLedger(snapshot))
      .toContain('No stored items fall under these folders — nothing left to purge.');
    expect(snapshot.attention.filter((item) => item.startsWith('Excluded by configuration'))).toEqual([]);
  });

  test('excluded folders are counted apart from unassigned corpora, never folded into them', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(statusWithCorpora([
      dropboxFilesCorpus(4000, 4000),
      corpusFixture(UNCLAIMED_CORPUS_ID, 'file', 'internal', 42, 42),
    ]), {
      now: NOW,
      exclusions: [{ matcher: AGENT_CORPUS_EXCLUSION, present: { items: 7, unevaluable: 0 } }],
    });

    expect(snapshot.unassigned_corpora).toMatchObject({ corpus_count: 1, items: 42 });
    expect(snapshot.excluded_by_configuration).toMatchObject({ prefixes: 2, items_present: 7 });
    // Two separate sentences on the text surface, because they mean opposite
    // things: unassigned items ARE in the totals, excluded folders are not
    // ingested at all.
    expect(snapshot.attention.filter((item) => item.startsWith('Unassigned corpora:'))).toHaveLength(1);
    expect(snapshot.attention.filter((item) => item.startsWith('Excluded by configuration:'))).toHaveLength(1);
  });

  test('collects outstanding purge debt from a mounted file-family store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-exclusions-'));
    const dbPath = join(dir, 'drive-files', 'connector-store.db');
    const exclusionsPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(exclusionsPath, JSON.stringify({
      schemaVersion: 1,
      rules: [{
        id: 'agent-corpus',
        // Empty sources means every source, which is the only scope a generic
        // connector-store definition can honestly be matched against.
        sources: [],
        path_prefixes: ['/private/agent-corpus'],
        reason: 'another system curates this',
      }],
    }));
    // Written with no gate attached, which is exactly how purge debt arises:
    // these items were indexed before the owner wrote the exclusion.
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.google_drive.files',
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(fileConnector([
        fileItem({
          id: 'file-excluded-1',
          text: 'Document stored under an excluded folder.',
          updatedAt: '2026-07-28T11:00:00.000Z',
          locatorUri: '/Private/Agent-Corpus/brief.txt',
        }),
        fileItem({
          id: 'file-kept-1',
          text: 'Document the exclusion does not touch.',
          updatedAt: '2026-07-28T11:01:00.000Z',
          locatorUri: '/Personal/Notes/plan.txt',
        }),
      ]), { fetchContent: true });
    } finally {
      store.close();
    }

    try {
      const snapshot = await collectLocalSourceIngestionLedger({
        env: {
          XDG_DATA_HOME: join(dir, 'empty-data-home'),
          OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: exclusionsPath,
          OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([{
            dbPath,
            corpusId: 'secure_local.google_drive.files',
            family: 'file',
            trustDomain: 'secure_local',
          }]),
        },
        dashboardDbPath: join(dir, 'source-dashboard.sqlite'),
        now: NOW,
      });

      expect(snapshot.excluded_by_configuration).toMatchObject({
        rules: 1,
        prefixes: 1,
        items_present: 1,
        items_unevaluable: 0,
        entries: [{ rule_id: 'agent-corpus', prefix: '/private/agent-corpus' }],
      });
      expect(snapshot.attention).toEqual(expect.arrayContaining([
        expect.stringContaining('Excluded by configuration: 1 stored item(s)'),
      ]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a message family is not measured against folder exclusions at all', async () => {
    // Folder exclusions are a claim about file storage. Evaluating a chat
    // corpus against them would report every message as "path unevaluable"
    // purge debt the owner can do nothing about, burying the real number.
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ingestion-ledger-chat-exclusions-'));
    const dbPath = join(dir, 'whatsapp-live', 'connector-store.db');
    const exclusionsPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(exclusionsPath, JSON.stringify({
      schemaVersion: 1,
      rules: [{
        id: 'agent-corpus',
        sources: [],
        path_prefixes: ['/private/agent-corpus'],
        reason: 'another system curates this',
      }],
    }));
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.whatsapp.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    try {
      await store.syncFromConnector(whatsappConnector([
        whatsappItem({
          id: 'wamid-1',
          text: 'A message, which lives in no folder.',
          updatedAt: '2026-07-28T11:00:00.000Z',
        }),
      ]), { fetchContent: true });
    } finally {
      store.close();
    }

    try {
      const snapshot = await collectLocalSourceIngestionLedger({
        env: {
          XDG_DATA_HOME: join(dir, 'empty-data-home'),
          OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: exclusionsPath,
          OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON: JSON.stringify([{
            dbPath,
            corpusId: 'secure_local.whatsapp.messages',
            family: 'chat',
            trustDomain: 'secure_local',
          }]),
        },
        dashboardDbPath: join(dir, 'source-dashboard.sqlite'),
        now: NOW,
      });

      // The rule is still reported — the owner configured it — but the chat
      // corpus contributes nothing to the debt, evaluable or otherwise.
      expect(snapshot.excluded_by_configuration?.rules).toBe(1);
      expect(snapshot.excluded_by_configuration?.items_present).toBe(0);
      expect(snapshot.excluded_by_configuration?.items_unevaluable).toBe(0);
      expect(snapshot.rows.find((row) => row.source_id === 'whatsapp')?.items).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fileItem(input: {
  id: string;
  text: string;
  updatedAt: string;
  locatorUri: string;
}): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'google_drive',
      accountScope: 'personal',
      providerItemId: input.id,
      providerFileId: input.id,
      localItemId: `google_drive:personal:${input.id}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: input.text },
    metadata: {
      title: 'Document',
      authoredAt: input.updatedAt,
      updatedAt: input.updatedAt,
      // The store reads the folder-exclusion gate off locator_uri.
      locatorUri: input.locatorUri,
    },
    fetchedAt: input.updatedAt,
  };
}

function fileConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'google_drive',
    family: 'file',
    async authenticate() {},
    async *listItems() {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string) {
      const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!item) throw new Error(`Missing fixture item ${localItemId}`);
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function statusWithCorpora(corpora: SourceIndexStatusResult['corpora']): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-28T12:00:00.000Z',
    corpora,
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function corpusFixture(
  corpus_id: string,
  family: string,
  trust_domain: string,
  items: number,
  contentIndexed: number,
): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id,
    family,
    trust_domain,
    activation_mode: 'lexical_only',
    embedding_policy: 'local_private',
    configured: true,
    provider: 'fixture',
    read_authority: 'connector_store',
    counts: {
      indexed_items: items,
      tombstoned_items: 0,
      chunks: contentIndexed,
      // The store's own per-item ready count, which is what the census reads.
      // A chunk count never stood for it: an item yields many chunks.
      items_with_text: Math.min(items, contentIndexed),
      embedded_chunks: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}

function dropboxFilesCorpus(
  files: number,
  qaPass: number,
  extraCounts: Record<string, number> = {},
): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_private',
    configured: true,
    provider: 'dropbox',
    read_authority: 'connector_store',
    counts: {
      indexed_items: files,
      tombstoned_items: 0,
      chunks: qaPass,
      embedded_chunks: 0,
      qa_pass: qaPass,
      qa_total_items: files,
      sync_runs: 1,
      ...extraCounts,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}

/** The same corpus id served by `connectorStoreStatus` after the flip. */
function dropboxFilesConnectorStoreCorpus(
  indexedItems: number,
  chunks: number,
): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_private',
    configured: true,
    provider: 'dropbox',
    read_authority: 'connector_store',
    counts: {
      indexed_items: indexedItems,
      tombstoned_items: 0,
      chunks,
      items_with_text: Math.min(indexedItems, chunks),
      embedded_chunks: chunks,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}

function fixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-07-08T20:00:00.000Z',
    corpora: [
      {
        corpus_id: 'secure_local.email.private',
        family: 'email',
        trust_domain: 'secure_local',
        activation_mode: 'lexical_only',
        embedding_policy: 'local_private',
        configured: true,
        provider: 'gmail',
        read_authority: 'connector_store',
        counts: {
          accounts: 1,
          indexed_items: 10,
          tombstoned_items: 0,
          threads: 9,
          private_chunks: 8,
          chunks: 8,
          items_with_text: 8,
          sync_runs: 1,
          retrieval_audits: 0,
          semantic_runs: 0,
          embedding_models: 0,
          embedded_chunks: 0,
        },
        last_refresh: {
          sync_run_id: 'email-sync',
          status: 'completed',
          completed_at: '2026-07-05T20:00:00.000Z',
          items_seen: 10,
          items_indexed: 10,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      },
      {
        corpus_id: 'secure_local.dropbox.files',
        family: 'file',
        trust_domain: 'secure_local',
        activation_mode: 'lexical_only',
        embedding_policy: 'local_private',
        configured: true,
        provider: 'dropbox',
        read_authority: 'connector_store',
        counts: {
          accounts: 1,
          indexed_items: 20,
          tombstoned_items: 0,
          folders: 2,
          secure_local_chunks: 12,
          chunks: 4,
          extraction_artifacts: 4,
          extraction_jobs: 6,
          extraction_jobs_queued: 3,
          extraction_jobs_leased: 1,
          extraction_jobs_leased_current: 1,
          extraction_jobs_blocked: 0,
          extraction_jobs_skipped: 0,
          extraction_jobs_failed: 2,
          metadata_sync_folders_total: 0,
          metadata_sync_folders_visited: 0,
          metadata_sync_folders_pending: 0,
          metadata_sync_folders_retryable_failed: 0,
          metadata_sync_folders_exhausted_retry: 0,
          metadata_sync_folders_blocked: 0,
          metadata_sync_folders_failed: 0,
          sync_runs: 1,
          retrieval_audits: 0,
          semantic_runs: 0,
          embedding_models: 0,
          embedded_chunks: 0,
          qa_total_items: 20,
          qa_pass: 4,
          qa_stale_revision: 0,
          qa_partial_pages_gap: 0,
          qa_metadata_only_expected: 0,
          qa_metadata_only_gap: 14,
          qa_raster_ocr_vlm_escalation: 3,
          qa_low_confidence_retry_local: 0,
          qa_low_confidence_candidate_for_venice: 0,
          qa_blocked_policy: 0,
          qa_out_of_content_scope: 0,
          qa_failed_needs_operator: 2,
          qa_pending: 0,
          qa_visible_gaps: 16,
          qa_low_confidence: 0,
          qa_eligible_items: 20,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      },
      configured('internal.drive.docs', 'file', 'internal'),
      configured('internal.telegram.messages', 'chat', 'internal'),
      configured('internal.readwise.library', 'readwise', 'internal'),
      configured('internal.x.bookmarks', 'x', 'internal'),
      unconfigured('secure_local.whatsapp.messages', 'chat', 'secure_local'),
    ],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

function configured(corpus_id: string, family: string, trust_domain: string): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id,
    family,
    trust_domain,
    activation_mode: 'lexical_only',
    embedding_policy: 'local_private',
    configured: true,
    provider: corpus_id.split('.')[1] ?? 'fixture',
    read_authority: 'connector_store',
    counts: {
      indexed_items: 1,
      tombstoned_items: 0,
      chunks: 1,
      embedded_chunks: 0,
      sync_runs: 1,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}

function unconfigured(corpus_id: string, family: string, trust_domain: string): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id,
    family,
    trust_domain,
    activation_mode: 'lexical_only',
    embedding_policy: 'local_private',
    configured: false,
    provider: corpus_id.split('.')[1] ?? 'fixture',
    read_authority: 'connector_store',
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'source_index_not_configured',
  };
}

function whatsappItem(input: {
  id: string;
  text: string;
  updatedAt: string;
  locatorUri?: string;
}): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: 'whatsapp',
      accountScope: 'personal',
      providerItemId: input.id,
      providerConversationId: 'chat-ledger',
      localItemId: `whatsapp:personal:${input.id}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: input.text },
    metadata: {
      title: 'WhatsApp chat',
      authoredAt: input.updatedAt,
      updatedAt: input.updatedAt,
      // The store reads the folder-exclusion gate off locator_uri, so a
      // fixture that exercises exclusions has to carry one.
      ...(input.locatorUri ? { locatorUri: input.locatorUri } : {}),
    },
    fetchedAt: input.updatedAt,
  };
}

function whatsappConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'whatsapp',
    family: 'chat',
    async authenticate() {},
    async *listItems() {
      yield { items, done: true };
    },
    async fetchItem(localItemId: string) {
      const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!item) throw new Error(`Missing fixture item ${localItemId}`);
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}
