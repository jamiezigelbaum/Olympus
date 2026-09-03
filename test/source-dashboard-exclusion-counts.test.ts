// The dashboard's "excluded by configuration" section, driven through the
// worker route rather than through a hand-built ledger snapshot.
//
// The section shipped reading zero rules on an install that enforced several,
// because the only production caller of buildSourceIngestionLedgerSnapshot
// passed no `exclusions` at all — and every test that covered the mapping fed
// the ledger a fixture that already had them. So this drives /dashboard.json
// with the picker runtime the worker really opens, which is the seam that was
// missing.

import { describe, expect, test } from 'bun:test';
import {
  createSourceExclusionMatcherFromPrefixes,
  type SourceExclusionCriterion,
} from '../src/core/source-ingestion-exclusions.ts';
import { createSovereigntyEngine, buildEnvBridgeSovereigntyConfig } from '../src/core/sovereignty.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const EXCLUDED: SourceExclusionCriterion = {
  ruleId: 'archive-folder',
  reason: 'Owner excluded the archive folder.',
  mode: 'exclude',
  kind: 'path_prefix',
  prefix: '/Archive',
};

const METADATA_ONLY: SourceExclusionCriterion = {
  ruleId: 'scans-metadata-only',
  reason: 'Owner keeps scans metadata-only.',
  mode: 'metadata_only',
  kind: 'path_prefix',
  prefix: '/Scans',
};

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

function fixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-08-01T00:00:00.000Z',
    corpora: [{
      corpus_id: 'secure_local.dropbox.files',
      family: 'file',
      trust_domain: 'secure_local',
      activation_mode: 'hybrid_primary',
      embedding_policy: 'local_only',
      configured: true,
      provider: 'dropbox',
      counts: {
        accounts: 1,
        indexed_items: 10,
        files_with_text: 8,
        secure_local_chunks: 20,
        embedded_chunks: 20,
      },
      item_metadata_returned: false,
      skipped_item_metadata_reason: 'item_metadata_not_requested',
    }],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as unknown as SourceIndexStatusResult;
}

function workerWithDispositions(sources: Parameters<typeof buildRuntime>[0]) {
  const worker = createEmailSourceWorker({
    sourceIndexStatus: {
      async status() {
        return fixtureStatus();
      },
    },
    sourceDashboard: {
      sovereigntyEngine: fixtureSovereigntyEngine(),
      registryPath: '/tmp/olympus-dashboard-exclusions-missing-handles.json',
      ingestionDispositions: () => buildRuntime(sources),
    },
  });
  return withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
}

function buildRuntime(sources: ReadonlyArray<{
  sourceId: string;
  criteria: readonly SourceExclusionCriterion[];
  excluded?: { items: number; unevaluable: number };
  metadataOnlyContent?: { items: number; unevaluable: number };
}>): { sources: ReturnType<typeof runtimeSource>[]; close: () => void } {
  return {
    sources: sources.map(runtimeSource),
    close: () => {
      closed += 1;
    },
  };
}

let closed = 0;

function runtimeSource(source: {
  sourceId: string;
  criteria: readonly SourceExclusionCriterion[];
  excluded?: { items: number; unevaluable: number };
  metadataOnlyContent?: { items: number; unevaluable: number };
}) {
  return {
    source_id: source.sourceId,
    label: source.sourceId,
    corpus_ids: ['secure_local.dropbox.files'],
    enforceable: ['path_prefix' as const],
    matcher: createSourceExclusionMatcherFromPrefixes(source.criteria),
    store_present: source.excluded !== undefined,
    ...(source.excluded ? { excludedItemsPresent: () => source.excluded! } : {}),
    ...(source.metadataOnlyContent
      ? { metadataOnlyContentPresent: () => source.metadataOnlyContent! }
      : {}),
  };
}

async function dashboardBody(fetchImpl: ReturnType<typeof withWorkerBearerAuth>) {
  const response = await fetchImpl(new Request('http://worker.test/dashboard.json', {
    headers: { Authorization: 'Bearer dashboard-secret' },
  }));
  expect(response.status).toBe(200);
  return await response.json() as {
    excluded_by_configuration: {
      rules: number;
      prefixes: number;
      items_present: number;
      items_unevaluable: number;
      entries: Array<{ rule_id: string; prefixes: number }>;
    };
  };
}

describe('dashboard exclusion counts come from the owner\'s live rules', () => {
  test('the page reports the rules the worker actually enforces', async () => {
    closed = 0;
    const fetchImpl = workerWithDispositions([{
      sourceId: 'dropbox',
      criteria: [EXCLUDED, METADATA_ONLY],
      excluded: { items: 7, unevaluable: 2 },
      metadataOnlyContent: { items: 3, unevaluable: 0 },
    }]);

    const body = await dashboardBody(fetchImpl);

    expect(body.excluded_by_configuration.rules).toBe(2);
    expect(body.excluded_by_configuration.prefixes).toBe(2);
    expect(body.excluded_by_configuration.items_present).toBe(7);
    expect(body.excluded_by_configuration.items_unevaluable).toBe(2);
    expect(body.excluded_by_configuration.entries.map((entry) => entry.rule_id).sort())
      .toEqual(['archive-folder', 'scans-metadata-only']);
    // The picker's stores are read-only handles; the render must let them go.
    expect(closed).toBe(1);
  });

  test('a source with no mounted store still reports its rules with no purge debt', async () => {
    closed = 0;
    const fetchImpl = workerWithDispositions([{ sourceId: 'dropbox', criteria: [EXCLUDED] }]);

    const body = await dashboardBody(fetchImpl);

    expect(body.excluded_by_configuration.rules).toBe(1);
    expect(body.excluded_by_configuration.items_present).toBe(0);
    expect(closed).toBe(1);
  });

  test('a worker with no picker configured renders an all-zero section', async () => {
    const worker = createEmailSourceWorker({
      sourceIndexStatus: {
        async status() {
          return fixtureStatus();
        },
      },
      sourceDashboard: {
        sovereigntyEngine: fixtureSovereigntyEngine(),
        registryPath: '/tmp/olympus-dashboard-exclusions-missing-handles.json',
      },
    });
    const fetchImpl = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

    const body = await dashboardBody(fetchImpl);

    expect(body.excluded_by_configuration).toMatchObject({
      rules: 0,
      prefixes: 0,
      items_present: 0,
      entries: [],
    });
  });
});
