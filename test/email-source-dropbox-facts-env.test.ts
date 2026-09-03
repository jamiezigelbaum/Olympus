import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FILE_EXTRACTION_CORPORA_ENV,
  createFileExtractionRuntime,
  fileExtractionCorporaRoster,
  parseFileExtractionCorporaEnv,
} from '../src/workers/email-source/file-extraction-runtime.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID } from '../src/workers/dropbox-files/connector-store.ts';
import {
  GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_STATE_PATH_ENV,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
} from '../src/workers/google-connectors/drive.ts';
import { createCanonicalDropboxSchedulerSource } from '../src/workers/source-scheduler.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PRODUCT_CONNECTOR_ID,
} from '../src/workers/whatsapp/store-sync.ts';
import type {
  CredentialBroker,
  CredentialSessionRequest,
} from '../src/workers/credential-broker/index.ts';
import type { DropboxProviderStoreSyncHandler } from '../src/workers/dropbox-files/provider-store-sync.ts';
import type { SourceIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import type { OlympusConfig } from '../src/core/config.ts';

const DROPBOX_ROSTER = JSON.stringify([{
  corpus_id: 'secure_local.dropbox.files',
  provider: 'dropbox',
  scopes: ['dropbox.personal:/Approved'],
}]);

const DROPBOX_EXTRACTION_SCOPE = 'dropbox.personal:/Approved';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-file-extraction-'));
  roots.push(root);
  return root;
}

/**
 * A broker that records the handle each family asked for, so a test can prove
 * WHEN the credential was resolved rather than only that a run happened.
 */
function recordingBroker(asked: string[]): CredentialBroker {
  return {
    async issueSession(request: CredentialSessionRequest) {
      asked.push(request.handle);
      const provider = request.provider ?? 'dropbox';
      return {
        kind: 'bearer_token' as const,
        handle: request.handle,
        provider,
        capability: request.capability,
        token: `${request.handle}-token`,
        audit: {
          handle: request.handle,
          provider,
          capability: request.capability,
          scopes: [],
          outcome: 'issued' as const,
          issuedAt: '2026-08-31T00:00:00.000Z',
          rawCredentialExposed: false as const,
        },
      };
    },
  };
}

function dropboxExtractionPolicy(): SourceIngestionPolicy {
  return {
    schemaVersion: 1,
    source: 'dropbox.personal',
    corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
    roots: [{
      path: '/Approved',
      approved_scope_key: DROPBOX_EXTRACTION_SCOPE,
      default_action: 'full_extract',
    }],
    rules: [],
    sync: { max_entries_per_pass: 10 },
    content: { plan_limit: 5, batch_size: 5 },
  } as unknown as SourceIngestionPolicy;
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: ['dropbox.files'],
        tickSeconds: 1,
        syncIntervalSeconds: 60,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}

describe('email source shared file-extraction env', () => {
  test('stays disabled even when a Dropbox corpus roster is configured', () => {
    const runtime = createFileExtractionRuntime({
      env: {
        OLYMPUS_FILE_EXTRACTION_ENABLED: 'false',
        [FILE_EXTRACTION_CORPORA_ENV]: DROPBOX_ROSTER,
      },
      connectorStores: [],
    });

    expect(runtime).toBeUndefined();
  });

  test('parses the canonical source-neutral roster and keeps remote egress opt-in', () => {
    expect(parseFileExtractionCorporaEnv(DROPBOX_ROSTER)).toEqual([{
      corpusId: 'secure_local.dropbox.files',
      provider: 'dropbox',
      scopes: ['dropbox.personal:/Approved'],
    }]);

    expect(parseFileExtractionCorporaEnv(JSON.stringify([{
      corpus_id: 'secure_local.dropbox.files',
      provider: 'dropbox',
      scopes: ['dropbox.personal:/Approved'],
      max_trust_tier_for_remote: 'S4',
      allow_default_deferred: true,
    }]))).toEqual([{
      corpusId: 'secure_local.dropbox.files',
      provider: 'dropbox',
      scopes: ['dropbox.personal:/Approved'],
      maxTrustTierForRemote: 'S4',
      allowDefaultDeferred: true,
    }]);
  });

  test('fails closed for malformed, unscoped, or over-broad remote-tier entries', () => {
    expect(() => parseFileExtractionCorporaEnv('{')).toThrow(FILE_EXTRACTION_CORPORA_ENV);
    expect(() => parseFileExtractionCorporaEnv(JSON.stringify([{
      corpus_id: 'secure_local.dropbox.files',
      provider: 'dropbox',
      scopes: [],
    }]))).toThrow('at least one approved scope key');
    expect(() => parseFileExtractionCorporaEnv(JSON.stringify([{
      corpus_id: 'secure_local.dropbox.files',
      provider: 'dropbox',
      scopes: ['dropbox.personal:/Approved'],
      max_trust_tier_for_remote: 'S5',
    }]))).toThrow('must be S3 or S4');
  });
});

/**
 * 2026-08-31 review finding. A Dropbox account connected through the dashboard
 * after boot synced metadata for ever and extracted nothing: the roster was
 * built from the handle that existed at BOOT, so `refreshSchedulerSources`
 * rebuilt the Dropbox lane around a runtime that had already decided Dropbox
 * was not served. Only a process restart recovered it, which is exactly the
 * step the pilot connect flow does not have.
 */
describe('file-extraction roster follows the live handle registry', () => {
  test('registers the canonical Dropbox corpus before any account is connected', () => {
    const roster = fileExtractionCorporaRoster({
      configured: [],
      dropbox: {
        extractionScopes: [DROPBOX_EXTRACTION_SCOPE],
        resolveCredentialHandle: () => undefined,
      },
    });

    expect(roster.map((corpus) => corpus.corpusId))
      .toEqual([DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID]);
    // No boot pin: the handle is whatever the registry holds when a run starts.
    expect(roster[0]!.credentialHandle).toBeUndefined();
    expect(roster[0]!.resolveCredentialHandle).toBeInstanceOf(Function);
  });

  test('keeps the canonical corpora ahead of a colliding configured entry', () => {
    const roster = fileExtractionCorporaRoster({
      configured: parseFileExtractionCorporaEnv(JSON.stringify([
        {
          corpus_id: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
          provider: 'dropbox',
          scopes: ['dropbox.personal:/Ignored'],
          max_trust_tier_for_remote: 'S3',
        },
        {
          corpus_id: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
          provider: 'google_drive',
          scopes: ['google_drive.personal'],
        },
      ])),
      dropbox: {
        extractionScopes: [DROPBOX_EXTRACTION_SCOPE],
        resolveCredentialHandle: () => 'dropbox.personal',
      },
      whatsapp: true,
    });

    expect(roster.map((corpus) => corpus.corpusId)).toEqual([
      GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      WHATSAPP_LIVE_CORPUS_ID,
    ]);
    const dropbox = roster.find((corpus) => corpus.corpusId === DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID)!;
    expect(dropbox.scopes).toEqual([DROPBOX_EXTRACTION_SCOPE]);
    // The operator's egress opt-in survives; the scopes come from the policy.
    expect(dropbox.maxTrustTierForRemote).toBe('S3');
    const whatsapp = roster.find((corpus) => corpus.corpusId === WHATSAPP_LIVE_CORPUS_ID)!;
    expect(whatsapp.ownerConnectorId).toBe(WHATSAPP_PRODUCT_CONNECTOR_ID);
  });

  test('emits Dropbox extraction tasks for a handle that appears after boot', async () => {
    const root = fixtureRoot();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'dropbox-connector-store.db'),
      corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const asked: string[] = [];
    // Nothing is connected yet — the state the pilot boots in.
    let connectedHandle: string | undefined;

    try {
      const runtime = createFileExtractionRuntime({
        env: {},
        enabled: true,
        connectorStores: [store],
        corpora: fileExtractionCorporaRoster({
          configured: [],
          dropbox: {
            extractionScopes: [DROPBOX_EXTRACTION_SCOPE],
            resolveCredentialHandle: () => connectedHandle,
          },
        }),
        credentialBroker: recordingBroker(asked),
        jobsDbPath: join(root, 'file-extraction-jobs.sqlite'),
      });

      // The crux: the lane exists with no Dropbox credential in sight.
      expect(runtime).toBeDefined();
      expect(runtime!.corpusIds).toEqual([DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID]);

      // The owner connects Dropbox; the dashboard rebuilds the scheduler source.
      connectedHandle = 'dropbox.personal.connected';
      const source = createCanonicalDropboxSchedulerSource({
        policy: dropboxExtractionPolicy(),
        config: schedulerConfig(),
        providerSync: {
          pull: async () => ({ receipt: { status: 'idle', counts: {} }, checkpoint: null }),
        } as unknown as DropboxProviderStoreSyncHandler,
        store,
        fileExtraction: runtime!.runner,
      });
      const extract = source!.tasks.find((task) => task.id.startsWith('dropbox.files_extract.'));
      expect(extract).toBeDefined();

      const result = await extract!.run();
      expect(result.status).toBe('idle');
      // Resolved from the registry at RUN time, not from boot state.
      expect(asked).toEqual(['dropbox.personal.connected']);
    } finally {
      store.close();
    }
  });

  test('builds a Google Drive source for a configured google_drive corpus', async () => {
    const root = fixtureRoot();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'drive-connector-store.db'),
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    const asked: string[] = [];

    try {
      const runtime = createFileExtractionRuntime({
        env: {
          [GOOGLE_DRIVE_DAILY_REQUEST_BUDGET_STATE_PATH_ENV]: join(root, 'drive-budget.sqlite'),
        },
        enabled: true,
        connectorStores: [store],
        corpora: parseFileExtractionCorporaEnv(JSON.stringify([{
          corpus_id: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
          provider: 'google_drive',
          scopes: ['google_drive.personal'],
          credential_handle: 'google_drive.personal.delegated',
        }])),
        credentialBroker: recordingBroker(asked),
        jobsDbPath: join(root, 'file-extraction-jobs.sqlite'),
      });

      expect(runtime).toBeDefined();
      expect(runtime!.corpusIds).toEqual([GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID]);

      const plan = await runtime!.runner.plan({
        corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
        provider: 'google_drive',
        accountScope: 'personal',
        approvedScopeKey: 'google_drive.personal',
        limit: 5,
        policyDecision: 'index_allowed',
      });

      expect(plan.candidates).toBe(0);
      expect(asked).toEqual(['google_drive.personal.delegated']);
    } finally {
      store.close();
    }
  });

  test('warns rather than silently dropping a corpus it cannot serve', () => {
    const root = fixtureRoot();
    const store = new LocalConnectorStore({
      dbPath: join(root, 'drive-connector-store.db'),
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    const warnings: string[] = [];

    try {
      const runtime = createFileExtractionRuntime({
        env: {},
        enabled: true,
        connectorStores: [store],
        corpora: parseFileExtractionCorporaEnv(JSON.stringify([
          {
            corpus_id: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
            provider: 'roam',
            scopes: ['roam.personal'],
          },
          {
            corpus_id: 'secure_local.box.files',
            provider: 'dropbox',
            scopes: ['dropbox.personal:/Approved'],
          },
        ])),
        warn: (message) => warnings.push(message),
        jobsDbPath: join(root, 'file-extraction-jobs.sqlite'),
      });

      expect(runtime).toBeUndefined();
      expect(warnings).toEqual([
        `[file-extraction] corpus=${GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID} provider=roam dropped `
        + 'reason=no_source_factory',
        '[file-extraction] corpus=secure_local.box.files provider=dropbox dropped '
        + 'reason=no_connector_store',
      ]);
    } finally {
      store.close();
    }
  });
});
