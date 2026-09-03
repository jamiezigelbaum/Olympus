// The dashboard's stored-exclusion debt counts, and the reuse window that
// takes them off the interactive render path.
//
// Both counts walk every locator in a source's stores through the owner's gate
// one row at a time — measured at 270ms per source on a 262k-item store, paid
// on every page load and again on every poll. They are debt figures that move
// at purge and ingestion pace, so a render inside the window reuses the last
// count instead of taking it again. What must NOT be reused is a count taken
// under different rules: this page is where the owner edits those rules, and a
// stale number there would tell them their edit did nothing.

import { describe, expect, test } from 'bun:test';
import {
  createSourceExclusionMatcherFromPrefixes,
  type SourceExclusionCriterion,
} from '../src/core/source-ingestion-exclusions.ts';
import { createSovereigntyEngine, buildEnvBridgeSovereigntyConfig } from '../src/core/sovereignty.ts';
import {
  DASHBOARD_EXCLUSION_DEBT_MAX_AGE_MS,
  createEmailSourceWorker,
} from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const ARCHIVE: SourceExclusionCriterion = {
  ruleId: 'archive-folder',
  reason: 'Owner excluded the archive folder.',
  mode: 'exclude',
  kind: 'path_prefix',
  prefix: '/Archive',
};

const SCANS: SourceExclusionCriterion = {
  ruleId: 'scans-metadata-only',
  reason: 'Owner keeps scans metadata-only.',
  mode: 'metadata_only',
  kind: 'path_prefix',
  prefix: '/Scans',
};

function fixtureStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: '2026-08-24T00:00:00.000Z',
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

/**
 * A picker runtime whose counts are expensive to take, exactly as the real
 * one's are. `criteria` is read fresh on every open so a test can edit the
 * owner's rules between renders.
 */
function countingDispositions(state: {
  criteria: readonly SourceExclusionCriterion[];
  excluded: { items: number; unevaluable: number };
  metadataOnlyContent: { items: number; unevaluable: number };
}) {
  const calls = { excluded: 0, metadataOnly: 0, opens: 0, closes: 0 };
  const open = () => {
    calls.opens += 1;
    return {
      sources: [{
        source_id: 'dropbox',
        label: 'Dropbox',
        corpus_ids: ['secure_local.dropbox.files'],
        enforceable: ['path_prefix' as const],
        matcher: createSourceExclusionMatcherFromPrefixes(state.criteria),
        store_present: true,
        excludedItemsPresent: () => {
          calls.excluded += 1;
          return state.excluded;
        },
        metadataOnlyContentPresent: () => {
          calls.metadataOnly += 1;
          return state.metadataOnlyContent;
        },
      }],
      close: () => {
        calls.closes += 1;
      },
    };
  };
  return { open, calls };
}

function workerFor(dispositions: ReturnType<typeof countingDispositions>) {
  const worker = createEmailSourceWorker({
    sourceIndexStatus: {
      async status() {
        return fixtureStatus();
      },
    },
    sourceDashboard: {
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
        OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
      })),
      registryPath: '/tmp/olympus-dashboard-exclusion-debt-missing-handles.json',
      ingestionDispositions: dispositions.open,
    },
  });
  return withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });
}

async function dashboardBody(fetchImpl: ReturnType<typeof withWorkerBearerAuth>) {
  const response = await fetchImpl(new Request('http://worker.test/dashboard.json', {
    headers: { Authorization: 'Bearer dashboard-secret' },
  }));
  expect(response.status).toBe(200);
  return await response.json() as {
    excluded_by_configuration: {
      items_present: number;
      items_unevaluable: number;
      items_metadata_only_content_present: number;
    };
  };
}

describe('dashboard stored-exclusion debt is counted once per window', () => {
  test('a second render inside the window reuses the counts rather than walking again', async () => {
    const dispositions = countingDispositions({
      criteria: [ARCHIVE, SCANS],
      excluded: { items: 7, unevaluable: 2 },
      metadataOnlyContent: { items: 3, unevaluable: 0 },
    });
    const fetchImpl = workerFor(dispositions);

    const first = await dashboardBody(fetchImpl);
    const second = await dashboardBody(fetchImpl);

    expect(dispositions.calls.excluded).toBe(1);
    expect(dispositions.calls.metadataOnly).toBe(1);
    // The reused answer is the same answer, not a zeroed placeholder.
    expect(second.excluded_by_configuration.items_present).toBe(7);
    expect(second.excluded_by_configuration.items_unevaluable).toBe(2);
    expect(second.excluded_by_configuration.items_metadata_only_content_present).toBe(3);
    expect(second.excluded_by_configuration).toEqual(first.excluded_by_configuration);
    // Reusing a count must not stop the render letting its read-only handles go.
    expect(dispositions.calls.opens).toBe(2);
    expect(dispositions.calls.closes).toBe(2);
  });

  test('editing the rules counts again, because the old count answered a different question', async () => {
    const state = {
      criteria: [ARCHIVE] as readonly SourceExclusionCriterion[],
      excluded: { items: 7, unevaluable: 2 },
      metadataOnlyContent: { items: 3, unevaluable: 0 },
    };
    const dispositions = countingDispositions(state);
    const fetchImpl = workerFor(dispositions);

    const before = await dashboardBody(fetchImpl);
    expect(before.excluded_by_configuration.items_present).toBe(7);

    // The owner adds a rule from this very page, and the purge debt behind the
    // new gate is larger.
    state.criteria = [ARCHIVE, SCANS];
    state.excluded = { items: 11, unevaluable: 2 };
    const after = await dashboardBody(fetchImpl);

    expect(dispositions.calls.excluded).toBe(2);
    expect(after.excluded_by_configuration.items_present).toBe(11);
  });

  test('each worker counts for itself, so one page never serves another install\'s debt', async () => {
    const first = countingDispositions({
      criteria: [ARCHIVE],
      excluded: { items: 7, unevaluable: 0 },
      metadataOnlyContent: { items: 0, unevaluable: 0 },
    });
    const second = countingDispositions({
      criteria: [ARCHIVE],
      excluded: { items: 99, unevaluable: 0 },
      metadataOnlyContent: { items: 0, unevaluable: 0 },
    });

    const firstBody = await dashboardBody(workerFor(first));
    const secondBody = await dashboardBody(workerFor(second));

    expect(firstBody.excluded_by_configuration.items_present).toBe(7);
    expect(secondBody.excluded_by_configuration.items_present).toBe(99);
    expect(second.calls.excluded).toBe(1);
  });

  test('the reuse window is on a human timescale, not a page-load one', () => {
    // The page re-polls itself every few seconds. A window at that scale would
    // reuse nothing; these counts move at purge and ingestion pace.
    expect(DASHBOARD_EXCLUSION_DEBT_MAX_AGE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
