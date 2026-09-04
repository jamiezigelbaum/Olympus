import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createCanonicalDropboxSchedulerSource,
  createGmailConnectorStoreSchedulerSource,
  createGoogleDriveConnectorStoreSchedulerSource,
  createReadwiseSchedulerSource,
  createSourceSchedulerFromConfig,
  createTelegramSchedulerSource,
  createWhatsAppSchedulerSource,
  createXBookmarksSchedulerSource,
  sourceSchedulerConstructionLogLines,
  SCHEDULER_SOURCE_IDS,
} from '../src/workers/source-scheduler.ts';
import { LocalSourceSchedulerStateStore } from '../src/workers/source-scheduler-state.ts';
import { activeCredentialHandle, sourceIndexLaneEnabled } from '../src/workers/email-source/server.ts';
import { readConnectedHandleRegistry } from '../src/workers/credential-broker/connected-handles.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { OLYMPUS_SOURCE_FAMILY_POSTURES } from '../src/core/source-family.ts';
import { defaultSourceCorpusRegistryConfig } from '../src/core/source-corpus-registry.ts';
import type { OlympusConfig } from '../src/core/config.ts';

/**
 * 2026-07-28 incident. `dropbox.files` was admitted to the worker scheduler
 * allowlist and the activation gate then refused for hours: the worker reported
 * `missing_selected_source_ids: ['dropbox.files']` with four sources, while every
 * gate input reproduced TRUE on the host under the unit's own environment.
 *
 * The gate inputs were never the question. The Dropbox source constructed fine —
 * under the source id `dropbox.personal`, taken from the ingestion policy's
 * `source` field, which is a CREDENTIAL HANDLE name and not a scheduler source
 * id. The allowlist filter then dropped it and reported the id it never saw.
 *
 * These tests bind the two ends the incident proved were unbound: the id a
 * factory stamps on a source, and the id an operator writes in the allowlist.
 */

const LIVE_SELECTED_SOURCE_IDS = [
  'readwise.library',
  'gmail.email',
  'google_drive.docs',
  'dropbox.files',
  'x.bookmarks',
  'telegram.messages',
  'whatsapp.personal.messages',
];

describe('scheduler source id binding', () => {
  let registryDir: string;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'olympus-handles-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  test('the live Dropbox handle produces a source the admitted allowlist can select', () => {
    // The live registry entry, verbatim in shape: provider, the one capability,
    // and a backendState whose status is available rather than reauth_required.
    const registryPath = join(registryDir, 'handles.json');
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      handles: [{
        handle: 'dropbox.personal',
        provider: 'dropbox',
        sessionKind: 'oauth2',
        accountRole: 'personal',
        trustDomain: 'secure_local',
        allowedCapabilities: ['dropbox.files.sync'],
        scopes: ['files.metadata.read', 'files.content.read'],
        backendState: { kind: 'oauth2_refresh', status: 'available' },
        connectedAt: '2026-07-28T20:00:00.000Z',
      }],
    }));

    const handles = readConnectedHandleRegistry(registryPath).handles;
    // The status the host reported as `undefined` survives the parser intact;
    // the reauth refusal in activeCredentialHandle reads a real value.
    expect(handles[0]?.backendState?.status).toBe('available');

    const dropboxHandle = activeCredentialHandle(handles, {
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
    });
    expect(dropboxHandle?.handle).toBe('dropbox.personal');

    const laneEnabled = sourceIndexLaneEnabled(
      { OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED: 'true' },
      'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED',
      dropboxHandle !== undefined,
    );
    expect(laneEnabled).toBe(true);

    const dropbox = createCanonicalDropboxSchedulerSource({
      policy: defaultDropboxIngestionPolicy(),
      config: schedulerConfig(),
      providerSync: stubDropboxProviderStoreSync(),
      store: stubDropboxStore(),
    });
    expect(dropbox).toBeDefined();
    // The assertion the whole hunt lacked: the id the factory stamps is the id
    // the operator admitted, not the credential handle the policy is named for.
    expect(dropbox!.sourceId).toBe('dropbox.files');

    const stateStore = new LocalSourceSchedulerStateStore(':memory:');
    try {
      const scheduler = createSourceSchedulerFromConfig({
        config: schedulerConfig(),
        sources: [dropbox!],
        stateStore,
      });
      const status = scheduler.status();
      expect(status.sources.map((source) => source.source_id)).toContain('dropbox.files');
      expect(status.missing_selected_source_ids ?? []).not.toContain('dropbox.files');
    } finally {
      stateStore.close();
    }
  });

  test('every scheduler factory stamps a source id the corpus registry knows', () => {
    // Class-wide gate. A factory that invents an id — or borrows one from an
    // adjacent identity namespace, as the Dropbox factory borrowed a credential
    // handle name — can never be selected by an allowlist, and the scheduler
    // reports the absence against the id it was told to expect. Nothing in the
    // build caught that, because every unit test built its scheduler without an
    // allowlist, where the filter is a no-op.
    const knownSourceIds = new Set([
      ...OLYMPUS_SOURCE_FAMILY_POSTURES.map((posture) => posture.sourceId),
      ...defaultSourceCorpusRegistryConfig().corpora.map((corpus) => corpus.sourceId),
    ]);
    const constructed = [
      createCanonicalDropboxSchedulerSource({
        policy: defaultDropboxIngestionPolicy(),
        config: schedulerConfig(),
        providerSync: stubDropboxProviderStoreSync(),
        store: stubDropboxStore(),
      }),
      createReadwiseSchedulerSource({
        config: schedulerConfig(),
        liveSync: stubStoreSync(),
      }),
      createXBookmarksSchedulerSource({
        config: schedulerConfig(),
        liveSync: stubStoreSync(),
      }),
      createGmailConnectorStoreSchedulerSource({
        config: schedulerConfig(),
        sync: stubStoreSync(),
      }),
      createGoogleDriveConnectorStoreSchedulerSource({
        config: schedulerConfig(),
        liveSync: stubStoreSync(),
      }),
      createTelegramSchedulerSource({
        config: schedulerConfig(),
        sync: stubStoreSync(),
      }),
      createWhatsAppSchedulerSource({
        config: schedulerConfig(),
        sync: stubStoreSync(),
      }),
    ];

    for (const source of constructed) {
      expect(source).toBeDefined();
      expect(knownSourceIds.has(source!.sourceId)).toBe(true);
    }
    // And every id an operator may admit is reachable from some factory, so the
    // allowlist and the factories cannot drift apart in either direction.
    const constructedIds = new Set(constructed.map((source) => source!.sourceId));
    for (const sourceId of LIVE_SELECTED_SOURCE_IDS) {
      expect(constructedIds.has(sourceId)).toBe(true);
    }
  });
});

describe('scheduler construction boot receipt', () => {
  test('names every lane, its outcome, and a reason token', () => {
    const lines = sourceSchedulerConstructionLogLines({
      decisions: [
        { sourceId: SCHEDULER_SOURCE_IDS.gmail, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.googleDrive, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.dropbox, outcome: 'skipped', reason: 'no_tasks' },
        { sourceId: SCHEDULER_SOURCE_IDS.readwise, outcome: 'skipped', reason: 'lane_disabled' },
        { sourceId: SCHEDULER_SOURCE_IDS.xBookmarks, outcome: 'skipped', reason: 'handle_rebound' },
        { sourceId: SCHEDULER_SOURCE_IDS.telegram, outcome: 'skipped', reason: 'no_handle' },
        { sourceId: SCHEDULER_SOURCE_IDS.whatsapp, outcome: 'skipped', reason: 'no_handle' },
      ],
      selectedSourceIds: LIVE_SELECTED_SOURCE_IDS,
    });

    expect(lines).toEqual([
      '[source-scheduler] source=gmail.email constructed reason=lane_ready',
      '[source-scheduler] source=google_drive.docs constructed reason=lane_ready',
      '[source-scheduler] source=dropbox.files skipped reason=no_tasks',
      '[source-scheduler] source=readwise.library skipped reason=lane_disabled',
      '[source-scheduler] source=x.bookmarks skipped reason=handle_rebound',
      '[source-scheduler] source=telegram.messages skipped reason=no_handle',
      '[source-scheduler] source=whatsapp.personal.messages skipped reason=no_handle',
      '[source-scheduler] constructed=2 skipped=5 selected=7'
      + ' selected_not_constructed=readwise.library,dropbox.files,x.bookmarks,telegram.messages,whatsapp.personal.messages',
    ]);
  });

  test('names the id mismatch the shipped boot count could not show', () => {
    // The 2026-07-28 shape, replayed: five lanes construct, the allowlist holds
    // five ids, and the old log printed "enabled for 5 source(s)". The receipt
    // has to name both halves of the mismatch on the same line.
    const lines = sourceSchedulerConstructionLogLines({
      decisions: [
        { sourceId: SCHEDULER_SOURCE_IDS.gmail, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.googleDrive, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: 'dropbox.personal', outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.readwise, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.xBookmarks, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.telegram, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.whatsapp, outcome: 'constructed', reason: 'lane_ready' },
      ],
      selectedSourceIds: LIVE_SELECTED_SOURCE_IDS,
    });

    const summary = lines.at(-1)!;
    expect(summary).toBe(
      '[source-scheduler] constructed=7 skipped=0 selected=7'
      + ' selected_not_constructed=dropbox.files'
      + ' constructed_not_selected=dropbox.personal',
    );
    // Counts-only: ids and reason tokens, never a handle, path, account, or a
    // count of items behind any of them.
    expect(lines.join('\n')).not.toMatch(/\/|token|secret|@/);
  });

  test('stays silent about drift when the allowlist and the constructions agree', () => {
    const lines = sourceSchedulerConstructionLogLines({
      decisions: Object.values(SCHEDULER_SOURCE_IDS).map((sourceId) => ({
        sourceId,
        outcome: 'constructed' as const,
        reason: 'lane_ready' as const,
      })),
      selectedSourceIds: LIVE_SELECTED_SOURCE_IDS,
    });

    expect(lines.at(-1)).toBe('[source-scheduler] constructed=7 skipped=0 selected=7');
  });

  test('reports no allowlist as every construction selected, not as drift', () => {
    // A fresh install enables the scheduler with no allowlist, and the lanes
    // arrive as the owner connects them through the dashboard. Compared against
    // an empty set, each live lane printed under `constructed_not_selected`
    // beside `selected=0` -- a receipt crying wolf about the ordinary state.
    const lines = sourceSchedulerConstructionLogLines({
      decisions: [
        { sourceId: SCHEDULER_SOURCE_IDS.gmail, outcome: 'constructed', reason: 'lane_ready' },
        { sourceId: SCHEDULER_SOURCE_IDS.googleDrive, outcome: 'skipped', reason: 'no_handle' },
      ],
      selectedSourceIds: [],
    });

    expect(lines.at(-1)).toBe(
      '[source-scheduler] constructed=1 skipped=1 selected=1'
      + ' selection=no_allowlist_all_constructed_selected',
    );
    expect(lines.join('\n')).not.toContain('constructed_not_selected');
    expect(lines.join('\n')).not.toContain('selected_not_constructed');
  });

  test('a worker with no allowlist and nothing connected reports zero of both', () => {
    const lines = sourceSchedulerConstructionLogLines({
      decisions: [
        { sourceId: SCHEDULER_SOURCE_IDS.gmail, outcome: 'skipped', reason: 'no_handle' },
      ],
      selectedSourceIds: [],
    });

    expect(lines.at(-1)).toBe(
      '[source-scheduler] constructed=0 skipped=1 selected=0'
      + ' selection=no_allowlist_all_constructed_selected',
    );
  });
});

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: [...LIVE_SELECTED_SOURCE_IDS],
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}

function stubDropboxProviderStoreSync() {
  return {
    connectorIdForScope() {
      return 'dropbox.files';
    },
    async pull() {
      return { receipt: { status: 'idle', counts: {} }, checkpoint: null };
    },
  } as never;
}

function stubDropboxStore() {
  return {
    lastCompletedSyncRun() {
      return undefined;
    },
  } as never;
}

function stubStoreSync() {
  return {
    async pull() {
      return { counts: {} };
    },
    async reconcile() {
      return { counts: {} };
    },
  } as never;
}
