// The four blocks the sensitivity/scope/needs-review delta adds to the source
// dashboard view model, plus the pins that keep them additive.
//
// Every one of them is a statement about the owner's own configuration, which
// is why most of these tests are about what does NOT cross: the match terms
// behind a category, the paths behind an exclusion rule, and any per-tier item
// count, none of which this page can publish honestly.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEnvBridgeSovereigntyConfig,
  createSovereigntyEngine,
} from '../src/core/sovereignty.ts';
import {
  parseSensitivityMap,
  USER_FACING_TIER_MAPPING,
  type SensitivityMap,
} from '../src/core/sensitivity-map.ts';
import {
  createSourceExclusionMatcherFromPrefixes,
  type SourceExclusionCriterion,
} from '../src/core/source-ingestion-exclusions.ts';
import {
  buildSourceDashboardViewModel,
  DASHBOARD_SENSITIVITY_TIERS,
} from '../src/workers/source-dashboard.ts';
import {
  buildSourceIngestionLedgerSnapshot,
  type SourceIngestionExcludedByConfiguration,
  type SourceIngestionLedgerSnapshot,
} from '../src/workers/source-ingestion-ledger.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const NOW = new Date('2026-08-18T12:00:00.000Z');

// The owner's real addresses and folders. Named here so the privacy assertions
// below read as "these exact strings never appear", not as a vague grep.
const OWNER_KEYWORD = 'escrow-payoff';
const OWNER_SENDER = 'statements@creditunion.example';
const OWNER_PATH = '/Finances/Joint';
const OWNER_NOTE = 'Owner note: the credit union folder, plus anything Dana forwards.';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('dashboard sensitivity section', () => {
  test('no configured map means the section is absent, never an empty category list', () => {
    // The live state on a fresh install: ~/.olympus/sensitivity-map.json does
    // not exist. An empty `categories` here would tell the owner they protect
    // nothing, which is a different claim from "nothing is configured".
    const view = buildView({ status: statusWithCorpora([emailCorpus('internal.email', 'internal', 10, {})]) });

    expect(view.sensitivity).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('"sensitivity"');
  });

  test('the tier table states what each tier permits, matching the code that enforces it', () => {
    const view = buildView({ status: statusWithCorpora([emailCorpus('internal.email', 'internal', 10, {})]) });

    expect(view.sensitivity_tiers).toEqual(DASHBOARD_SENSITIVITY_TIERS);
    expect(view.sensitivity_tiers?.policy_basis).toBe('enforced');
    const byLabel = new Map(view.sensitivity_tiers?.tiers.map((tier) => [tier.tier_label, tier]) ?? []);

    // S5 is refused on the model, embedding AND release paths whatever the
    // provider is, so local is ✕ too. Reading the mockup instead of
    // source-model-policy.ts is how this cell ends up wrongly ticked.
    expect(byLabel.get('S5')).toMatchObject({ local: false, venice: false, frontier: false });
    // secure_local admits local profiles and Venice and refuses cloud query.
    expect(byLabel.get('S4')).toMatchObject({ local: true, venice: true, frontier: false });
    expect(byLabel.get('S1–S3')).toMatchObject({ local: true, venice: true, frontier: true });
    expect(byLabel.get('S0')).toMatchObject({ local: true, venice: true, frontier: true });
  });

  test('no per-tier item count is published anywhere on the page', () => {
    // There is no index on items.trust_tier, no counter on the status path, and
    // the two derivations that exist mean different things. A number here would
    // have to be invented, so the tier rows carry permissions only.
    const view = buildView({
      status: statusWithCorpora([emailCorpus('internal.email', 'internal', 10, {})]),
      sensitivityMap: sensitivityMapFixture(),
    });

    for (const tier of view.sensitivity_tiers?.tiers ?? []) {
      expect(Object.keys(tier).sort()).toEqual(['frontier', 'local', 'meaning', 'name', 'tier_label', 'venice']);
    }
    for (const category of view.sensitivity?.categories ?? []) {
      expect(Object.keys(category)).not.toContain('items');
      expect(Object.keys(category)).not.toContain('indexed_items');
    }
  });

  test('categories cross as the owner\'s own examples and a term COUNT, never the terms', () => {
    const view = buildView({
      status: statusWithCorpora([emailCorpus('internal.email', 'internal', 10, {})]),
      sensitivityMap: sensitivityMapFixture(),
    });

    expect(view.sensitivity).toEqual({
      configured: true,
      editable: false,
      categories: [
        {
          id: 'family-finance',
          label: 'Family finance',
          interpretation: 'the joint account, anything about the house',
          target_tier_name: 'secure',
          target_trust_tier: 'S4',
          target_trust_domain: 'secure_local',
          match_terms: 3,
        },
        {
          id: 'recovery-codes',
          label: 'Recovery codes',
          interpretation: '2FA backup codes',
          target_tier_name: 'secrets',
          target_trust_tier: 'S5',
          target_trust_domain: 'secure_local',
          match_terms: 2,
        },
      ],
    });

    // /dashboard.json is reachable with the weak dash_ query token and its own
    // policy block says no paths and no file names are returned. The match
    // terms are the owner's literal addresses and folders, and `notes` is free
    // text that routinely repeats them.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(OWNER_KEYWORD);
    expect(serialized).not.toContain(OWNER_SENDER);
    expect(serialized).not.toContain(OWNER_PATH);
    expect(serialized).not.toContain(OWNER_NOTE);
    expect(serialized).not.toContain('"notes"');
    // The examples ARE the interpretation line, and they are the owner's words.
    expect(serialized).toContain('the joint account');
  });

  test('the section says it is read-only, because no route writes the map', () => {
    const view = buildView({
      status: statusWithCorpora([emailCorpus('internal.email', 'internal', 10, {})]),
      sensitivityMap: sensitivityMapFixture(),
    });

    // A page that offered add or remove would offer a button that 501s: the
    // worker's whole POST surface is oauth start, api-key, sync-now and the
    // folder-disposition save.
    expect(view.sensitivity?.editable).toBe(false);
  });
});

describe('dashboard exclusion scope', () => {
  test('metadata-only rules are counted apart from excluded ones, with each rule\'s modes and kinds', () => {
    const status = statusWithCorpora([dropboxCorpus(40, 30)]);
    const view = buildView({
      status,
      ledger: buildSourceIngestionLedgerSnapshot(status, {
        now: NOW,
        exclusions: [{
          matcher: createSourceExclusionMatcherFromPrefixes([
            criterion('archive', 'exclude', '/Archive'),
            // Same rule, second criterion, other disposition: `modes` is a list
            // because one rule really can carry both.
            criterion('archive', 'metadata_only', '/Archive/Scans'),
            criterion('big-media', 'exclude', '/Video', 'media'),
          ]),
          present: { items: 12, unevaluable: 3 },
          metadataOnlyContentPresent: { items: 5, unevaluable: 0 },
        }],
      }),
    });

    expect(view.excluded_by_configuration).toMatchObject({
      rules: 2,
      prefixes: 3,
      metadata_only_rules: 1,
      metadata_only_prefixes: 1,
      items_present: 12,
      items_unevaluable: 3,
      items_metadata_only_content_present: 5,
    });
    expect(view.excluded_by_configuration.entries).toEqual([
      { rule_id: 'archive', prefixes: 2, modes: ['exclude', 'metadata_only'], kinds: ['path_prefix'] },
      { rule_id: 'big-media', prefixes: 1, modes: ['exclude'], kinds: ['media'] },
    ]);
  });

  test('no configured prefix, folder name or reason reaches the page', () => {
    const status = statusWithCorpora([dropboxCorpus(40, 30)]);
    const view = buildView({
      status,
      ledger: buildSourceIngestionLedgerSnapshot(status, {
        now: NOW,
        exclusions: [{
          sourceId: 'dropbox.personal',
          corpusIds: ['secure_local.dropbox.files'],
          matcher: createSourceExclusionMatcherFromPrefixes([{
            ruleId: 'archive',
            reason: 'Owner keeps /Archive out; another system curates it.',
            mode: 'exclude',
            kind: 'path_prefix',
            prefix: OWNER_PATH,
          }]),
        }],
      }),
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(OWNER_PATH);
    expect(serialized).not.toContain('another system curates');
    expect(serialized).not.toContain('"prefix"');
    expect(serialized).not.toContain('"reason"');
    // The rule id the owner wrote is what identifies the row instead.
    expect(serialized).toContain('archive');
  });

  test('per-source rows carry corpus ids, and a corpus no card owns keeps its own row', () => {
    const status = statusWithCorpora([dropboxCorpus(40, 30)]);
    const view = buildView({
      status,
      ledger: buildSourceIngestionLedgerSnapshot(status, {
        now: NOW,
        exclusions: [
          {
            sourceId: 'dropbox.personal',
            corpusIds: ['secure_local.dropbox.files'],
            matcher: createSourceExclusionMatcherFromPrefixes([criterion('archive', 'exclude', '/Archive')]),
            present: { items: 9, unevaluable: 1 },
          },
          {
            // secure_local.drive.docs is a real corpus that matches NO card:
            // the Drive card's primary corpus is internal.drive.docs. Forcing
            // it onto that card would file one band's rules under another's.
            sourceId: 'google_drive.personal',
            corpusIds: ['secure_local.drive.docs'],
            matcher: createSourceExclusionMatcherFromPrefixes([criterion('shared-drives', 'metadata_only', '/Shared')]),
            metadataOnlyContentPresent: { items: 4, unevaluable: 0 },
          },
        ],
      }),
    });

    expect(view.excluded_by_configuration.by_source).toEqual([
      {
        corpus_ids: ['secure_local.dropbox.files'],
        source_id: 'dropbox.personal',
        rules: 1,
        prefixes: 1,
        metadata_only_prefixes: 0,
        items_present: 9,
        items_unevaluable: 1,
        items_metadata_only_content_present: 0,
        entries: [{ rule_id: 'archive', prefixes: 1, modes: ['exclude'], kinds: ['path_prefix'] }],
      },
      {
        corpus_ids: ['secure_local.drive.docs'],
        source_id: 'google_drive.personal',
        rules: 1,
        prefixes: 1,
        metadata_only_prefixes: 1,
        items_present: 0,
        items_unevaluable: 0,
        items_metadata_only_content_present: 4,
        entries: [{ rule_id: 'shared-drives', prefixes: 1, modes: ['metadata_only'], kinds: ['path_prefix'] }],
      },
    ]);
    // The data layer does no joining: these source ids are the picker's id
    // space ('dropbox.personal'), not the card's ('dropbox.files'). A reader
    // that matched on them would match nothing.
    expect(view.sources.map((source) => source.source_id)).not.toContain('dropbox.personal');
  });

  test('an exclusion source that names neither a source nor a corpus produces no anonymous row', () => {
    const status = statusWithCorpora([dropboxCorpus(40, 30)]);
    const view = buildView({
      status,
      ledger: buildSourceIngestionLedgerSnapshot(status, {
        now: NOW,
        exclusions: [{
          matcher: createSourceExclusionMatcherFromPrefixes([criterion('archive', 'exclude', '/Archive')]),
        }],
      }),
    });

    // The global section still reports the rule; only the split is absent,
    // because a row keyed by nothing cannot be shown against any source.
    expect(view.excluded_by_configuration.rules).toBe(1);
    expect(view.excluded_by_configuration.by_source).toBeUndefined();
  });

  test('unenforceable blanket rules are named, and the field is absent when there are none', () => {
    const status = statusWithCorpora([dropboxCorpus(40, 30)]);
    const withUnenforceable = buildView({
      status,
      ledger: ledgerWithExcluded({
        rules: 1,
        prefixes: 1,
        metadata_only_rules: 0,
        metadata_only_prefixes: 0,
        items_metadata_only_content_present: 0,
        items_present: 0,
        items_unevaluable: 0,
        unenforceable_rule_ids: ['blanket-rule'],
        entries: [{ rule_id: 'blanket-rule', prefix: OWNER_PATH, mode: 'exclude', kind: 'path_prefix', reason: 'n/a' }],
        by_source: [{
          source_id: 'google_drive.personal',
          corpus_ids: ['internal.drive.docs'],
          rules: 1,
          prefixes: 1,
          metadata_only_rules: 0,
          metadata_only_prefixes: 0,
          items_metadata_only_content_present: 0,
          items_present: 0,
          items_unevaluable: 0,
          unenforceable_rule_ids: ['blanket-rule'],
          entries: [{ rule_id: 'blanket-rule', prefix: OWNER_PATH, mode: 'exclude', kind: 'path_prefix', reason: 'n/a' }],
        }],
      }),
    });

    expect(withUnenforceable.excluded_by_configuration.unenforceable_rule_ids).toEqual(['blanket-rule']);
    expect(withUnenforceable.excluded_by_configuration.by_source?.[0]?.unenforceable_rule_ids)
      .toEqual(['blanket-rule']);
    // Still no path, even on the rule the owner has to go fix.
    expect(JSON.stringify(withUnenforceable)).not.toContain(OWNER_PATH);

    const clean = buildView({ status, ledger: buildSourceIngestionLedgerSnapshot(status, { now: NOW }) });
    expect(clean.excluded_by_configuration.unenforceable_rule_ids).toBeUndefined();
  });
});

describe('dashboard needs-review breakdown', () => {
  test('the breakdown adds up to the coverage count it splits, carrying only non-zero reasons', () => {
    const status = statusWithCorpora([{
      ...dropboxCorpus(40, 30),
      counts: {
        accounts: 1,
        files: 40,
        folders: 0,
        files_with_text: 30,
        secure_local_chunks: 30,
        embedded_chunks: 0,
        // Real verdicts only. `qa_visible_gaps` is a roll-up the store derives
        // from these, so a fixture carrying it alongside its own components
        // describes a corpus the store cannot produce — and asserting on it was
        // how the double count survived.
        qa_raster_ocr_vlm_escalation: 6,
        qa_metadata_only_gap: 3,
        metadata_sync_folders_blocked: 1,
      },
    } as unknown as SourceIndexStatusResult['corpora'][number]]);

    const dropbox = card(buildView({ status }), 'dropbox.files');

    expect(dropbox.coverage.needs_review_items).toBe(10);
    expect(dropbox.needs_review).toEqual({
      total: 10,
      // Nine of the ten are lanes working on their own; the blocked folder is
      // the only part anyone has to touch.
      automatic_total: 9,
      operator_total: 1,
      reasons: [
        {
          key: 'metadata_only',
          label: 'Metadata only',
          count: 3,
          who_acts: 'automatic',
          actor_note: 'queued for the text sweep',
        },
        {
          key: 'scanned_needs_better_reader',
          label: 'Scanned pages need a better reader',
          count: 6,
          who_acts: 'automatic',
          actor_note: 'passed to the local vision reader',
        },
        {
          key: 'folders_blocked',
          label: 'Folders blocked',
          count: 1,
          who_acts: 'needs_you',
          actor_note: 'Dropbox is refusing these folders',
        },
      ],
    });
    // The total is that same field, never a second reading of it.
    expect(dropbox.needs_review?.total).toBe(dropbox.coverage.needs_review_items);
  });

  test('out-of-date text is its own reason, counted once', () => {
    // The store keeps qa_stale_revision out of its qa_visible_gaps roll-up so
    // the two can be published side by side; if it ever lands in both, this
    // total reads 14 for 10 documents.
    const status = statusWithCorpora([{
      ...dropboxCorpus(40, 30),
      counts: {
        accounts: 1,
        files: 40,
        folders: 0,
        files_with_text: 30,
        secure_local_chunks: 30,
        embedded_chunks: 0,
        qa_raster_ocr_vlm_escalation: 6,
        qa_stale_revision: 4,
      },
    } as unknown as SourceIndexStatusResult['corpora'][number]]);

    const dropbox = card(buildView({ status }), 'dropbox.files');

    expect(dropbox.coverage.needs_review_items).toBe(10);
    expect(dropbox.needs_review).toEqual({
      total: 10,
      automatic_total: 10,
      operator_total: 0,
      reasons: [
        {
          key: 'text_out_of_date',
          label: 'Text is from an older version',
          count: 4,
          who_acts: 'automatic',
          actor_note: 'read again on the next pass over the file',
        },
        {
          key: 'scanned_needs_better_reader',
          label: 'Scanned pages need a better reader',
          count: 6,
          who_acts: 'automatic',
          actor_note: 'passed to the local vision reader',
        },
      ],
    });
  });

  test('the published reason ids carry none of the store\'s own count-key jargon', () => {
    const status = statusWithCorpora([{
      ...dropboxCorpus(40, 30),
      counts: { accounts: 1, files: 40, files_with_text: 30, qa_failed_needs_operator: 2 },
    } as unknown as SourceIndexStatusResult['corpora'][number]]);

    const view = buildView({ status });

    expect(card(view, 'dropbox.files').needs_review?.reasons[0]?.key).toBe('extraction_failed');
    expect(JSON.stringify(view)).not.toContain('qa_');
  });

  test('nothing to review is a zero with no reasons, and nothing to open', () => {
    const view = buildView({ status: statusWithCorpora([emailCorpus('internal.email', 'internal', 10, {})]) });
    const gmail = card(view, 'gmail.email');

    expect(gmail.needs_review).toEqual({ total: 0, automatic_total: 0, operator_total: 0, reasons: [] });
    // No item rows and no link: the only item-level review data in the system
    // carries file names and paths, and no route lists review items.
    expect(JSON.stringify(gmail.needs_review)).not.toContain('http');
  });

  test('canonical Gmail stores publish an additive needs-review breakdown', () => {
    const status = statusWithCorpora([
      emailCorpus('secure_local.email.private', 'secure_local', 400, {
        read_authority: 'connector_store',
        counts: {
          accounts: 1,
          indexed_items: 400,
          private_chunks: 400,
          embedded_chunks: 0,
          qa_raster_ocr_vlm_escalation: 6,
          qa_metadata_only_gap: 4,
        },
      }),
      emailCorpus('internal.email', 'internal', 120, {
        counts: {
          accounts: 1,
          indexed_items: 120,
          internal_chunks: 120,
          embedded_chunks: 0,
          qa_raster_ocr_vlm_escalation: 2,
          qa_metadata_only_gap: 6,
        },
      }),
    ]);

    const gmail = card(buildView({ status }), 'gmail.email');

    expect(gmail.coverage.needs_review_items).toBe(18);
    expect(gmail.needs_review?.total).toBe(18);
    expect(gmail.needs_review?.automatic_total).toBe(18);
    expect(gmail.needs_review?.reasons.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: 'metadata_only', count: 10 },
      { key: 'scanned_needs_better_reader', count: 8 },
    ]);
  });
});

describe('the delta stays additive', () => {
  test('every field that predates it serializes exactly as it did', () => {
    const status = statusWithCorpora([dropboxCorpus(40, 30)]);
    const ledger = buildSourceIngestionLedgerSnapshot(status, {
      now: NOW,
      exclusions: [{
        sourceId: 'dropbox.personal',
        corpusIds: ['secure_local.dropbox.files'],
        matcher: createSourceExclusionMatcherFromPrefixes([criterion('archive', 'metadata_only', '/Archive')]),
        present: { items: 9, unevaluable: 1 },
      }],
    });

    const before = withoutDeltaFields(buildView({ status, ledger }));
    const after = withoutDeltaFields(buildView({ status, ledger, sensitivityMap: sensitivityMapFixture() }));

    // Supplying a sensitivity map changes the new block and nothing else.
    expect(after).toEqual(before);
    // The pre-existing exclusion fields keep their pre-existing meanings.
    expect(before.excluded_by_configuration).toMatchObject({
      rules: 1,
      prefixes: 1,
      items_present: 9,
      items_unevaluable: 1,
    });
    expect(before.sources.every((source) => 'coverage' in source)).toBe(true);
  });
});

describe('the /dashboard.json route wires both new inputs', () => {
  test('the route reads the owner\'s configured map and the picker\'s per-source gates', async () => {
    const { withWorkerBearerAuth } = await import('../src/workers/http.ts');
    const { createEmailSourceWorker } = await import('../src/workers/email-source/index.ts');

    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-sensitivity-'));
    tempDirs.push(dir);
    const mapPath = join(dir, 'sensitivity-map.json');
    writeFileSync(mapPath, JSON.stringify(sensitivityMapJson()), 'utf8');
    const previous = process.env.OLYMPUS_SENSITIVITY_MAP_PATH;
    process.env.OLYMPUS_SENSITIVITY_MAP_PATH = mapPath;

    try {
      const worker = createEmailSourceWorker({
        sourceIndexStatus: {
          async status() {
            return statusWithCorpora([dropboxCorpus(40, 30)]);
          },
        },
        sourceDashboard: {
          sovereigntyEngine: fixtureSovereigntyEngine(),
          registryPath: join(dir, 'missing-handles.json'),
          ingestionDispositions: () => ({
            sources: [{
              source_id: 'dropbox.personal',
              label: 'Dropbox',
              corpus_ids: ['secure_local.dropbox.files'],
              enforceable: ['path_prefix' as const],
              matcher: createSourceExclusionMatcherFromPrefixes([criterion('archive', 'exclude', OWNER_PATH)]),
              store_present: true,
              excludedItemsPresent: () => ({ items: 9, unevaluable: 1 }),
            }],
            close: () => {},
          }),
        },
      });
      const fetchImpl = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

      const response = await fetchImpl(new Request('http://worker.test/dashboard.json', {
        headers: { Authorization: 'Bearer dashboard-secret' },
      }));
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as ReturnType<typeof buildSourceDashboardViewModel>;

      // Read off disk by the route, through OLYMPUS_SENSITIVITY_MAP_PATH.
      expect(body.sensitivity?.categories.map((category) => category.id))
        .toEqual(['family-finance', 'recovery-codes']);
      expect(body.sensitivity_tiers?.tiers).toHaveLength(4);
      // Attribution comes from the picker runtime the route already opens.
      expect(body.excluded_by_configuration.by_source).toEqual([{
        corpus_ids: ['secure_local.dropbox.files'],
        source_id: 'dropbox.personal',
        rules: 1,
        prefixes: 1,
        metadata_only_prefixes: 0,
        items_present: 9,
        items_unevaluable: 1,
        items_metadata_only_content_present: 0,
        entries: [{ rule_id: 'archive', prefixes: 1, modes: ['exclude'], kinds: ['path_prefix'] }],
      }]);
      // Still nothing the weak dash_ token must not see.
      expect(raw).not.toContain(OWNER_PATH);
      expect(raw).not.toContain(OWNER_SENDER);
      expect(raw).not.toContain(OWNER_KEYWORD);
    } finally {
      if (previous === undefined) delete process.env.OLYMPUS_SENSITIVITY_MAP_PATH;
      else process.env.OLYMPUS_SENSITIVITY_MAP_PATH = previous;
    }
  });

  test('a missing map leaves the section off without failing the render', async () => {
    const { withWorkerBearerAuth } = await import('../src/workers/http.ts');
    const { createEmailSourceWorker } = await import('../src/workers/email-source/index.ts');

    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-no-sensitivity-'));
    tempDirs.push(dir);
    const previous = process.env.OLYMPUS_SENSITIVITY_MAP_PATH;
    process.env.OLYMPUS_SENSITIVITY_MAP_PATH = join(dir, 'absent.json');

    try {
      const worker = createEmailSourceWorker({
        sourceIndexStatus: {
          async status() {
            return statusWithCorpora([dropboxCorpus(40, 30)]);
          },
        },
        sourceDashboard: {
          sovereigntyEngine: fixtureSovereigntyEngine(),
          registryPath: join(dir, 'missing-handles.json'),
        },
      });
      const fetchImpl = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

      const response = await fetchImpl(new Request('http://worker.test/dashboard.json', {
        headers: { Authorization: 'Bearer dashboard-secret' },
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as ReturnType<typeof buildSourceDashboardViewModel>;

      expect(body.sensitivity).toBeUndefined();
      expect(body.sensitivity_tiers?.tiers).toHaveLength(4);
    } finally {
      if (previous === undefined) delete process.env.OLYMPUS_SENSITIVITY_MAP_PATH;
      else process.env.OLYMPUS_SENSITIVITY_MAP_PATH = previous;
    }
  });

  test('an unparseable map leaves the section off rather than 500ing the page', async () => {
    const { withWorkerBearerAuth } = await import('../src/workers/http.ts');
    const { createEmailSourceWorker } = await import('../src/workers/email-source/index.ts');

    const dir = mkdtempSync(join(tmpdir(), 'olympus-dashboard-bad-sensitivity-'));
    tempDirs.push(dir);
    const mapPath = join(dir, 'sensitivity-map.json');
    writeFileSync(mapPath, '{ not json at all', 'utf8');
    const previous = process.env.OLYMPUS_SENSITIVITY_MAP_PATH;
    process.env.OLYMPUS_SENSITIVITY_MAP_PATH = mapPath;

    try {
      const worker = createEmailSourceWorker({
        sourceIndexStatus: {
          async status() {
            return statusWithCorpora([dropboxCorpus(40, 30)]);
          },
        },
        sourceDashboard: {
          sovereigntyEngine: fixtureSovereigntyEngine(),
          registryPath: join(dir, 'missing-handles.json'),
        },
      });
      const fetchImpl = withWorkerBearerAuth(worker.fetch, { authToken: 'dashboard-secret' });

      const response = await fetchImpl(new Request('http://worker.test/dashboard.json', {
        headers: { Authorization: 'Bearer dashboard-secret' },
      }));

      expect(response.status).toBe(200);
      expect((await response.json() as { sensitivity?: unknown }).sensitivity).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.OLYMPUS_SENSITIVITY_MAP_PATH;
      else process.env.OLYMPUS_SENSITIVITY_MAP_PATH = previous;
    }
  });
});

function buildView(input: {
  status: SourceIndexStatusResult;
  ledger?: SourceIngestionLedgerSnapshot;
  sensitivityMap?: SensitivityMap;
}) {
  return buildSourceDashboardViewModel({
    sourceIndexStatus: input.status,
    ...(input.ledger ? { ingestionLedger: input.ledger } : {}),
    ...(input.sensitivityMap ? { sensitivityMap: input.sensitivityMap } : {}),
    sovereigntyEngine: fixtureSovereigntyEngine(),
    now: NOW,
  });
}

/** The view with the four delta blocks removed, for the additive pin. */
function withoutDeltaFields(view: ReturnType<typeof buildSourceDashboardViewModel>) {
  const copy = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
  delete copy['sensitivity'];
  delete copy['sensitivity_tiers'];
  const excluded = copy['excluded_by_configuration'] as Record<string, unknown>;
  delete excluded['metadata_only_rules'];
  delete excluded['metadata_only_prefixes'];
  delete excluded['items_metadata_only_content_present'];
  delete excluded['unenforceable_rule_ids'];
  delete excluded['by_source'];
  for (const entry of excluded['entries'] as Array<Record<string, unknown>>) {
    delete entry['modes'];
    delete entry['kinds'];
  }
  for (const source of copy['sources'] as Array<Record<string, unknown>>) delete source['needs_review'];
  return copy as unknown as ReturnType<typeof buildSourceDashboardViewModel>;
}

function card(view: ReturnType<typeof buildSourceDashboardViewModel>, sourceId: string) {
  const found = view.sources.find((source) => source.source_id === sourceId);
  if (!found) throw new Error(`fixture is missing the ${sourceId} card`);
  return found;
}

function criterion(
  ruleId: string,
  mode: 'exclude' | 'metadata_only',
  prefix: string,
  kind: 'path_prefix' | 'folder_id' | 'media' = 'path_prefix',
): SourceExclusionCriterion {
  return { ruleId, reason: `fixture rule ${ruleId}`, mode, kind, prefix };
}

function ledgerWithExcluded(excluded: SourceIngestionExcludedByConfiguration): SourceIngestionLedgerSnapshot {
  return {
    kind: 'source_ingestion_ledger',
    generated_at: NOW.toISOString(),
    rows: [],
    unassigned_corpora: { corpus_count: 0, items: 0, content_indexed: 0, entries: [] },
    excluded_by_configuration: excluded,
    attention: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      castor_safe: true,
    },
  };
}

function sensitivityMapFixture(): SensitivityMap {
  return parseSensitivityMap(sensitivityMapJson());
}

function sensitivityMapJson(): unknown {
  return {
    schemaVersion: 1,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: [
      {
        id: 'family-finance',
        label: 'Family finance',
        targetTierName: 'secure',
        targetTrustTier: 'S4',
        targetTrustDomain: 'secure_local',
        examples: ['the joint account', 'anything about the house'],
        notes: OWNER_NOTE,
        match: {
          keywords: [OWNER_KEYWORD],
          senderPatterns: [OWNER_SENDER],
          pathPatterns: [OWNER_PATH],
        },
      },
      {
        id: 'recovery-codes',
        label: 'Recovery codes',
        targetTierName: 'secrets',
        targetTrustTier: 'S5',
        targetTrustDomain: 'secure_local',
        examples: ['2FA backup codes'],
        match: { keywords: ['one-time backup code', 'seed phrase'], senderPatterns: [], pathPatterns: [] },
      },
    ],
  };
}

function fixtureSovereigntyEngine() {
  return createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED: 'true',
    OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL: 'openai/gpt-5.5',
  }));
}

function statusWithCorpora(corpora: SourceIndexStatusResult['corpora']): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: NOW.toISOString(),
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

function emailCorpus(
  corpusId: string,
  trustDomain: 'secure_local' | 'internal',
  indexedItems: number,
  extra: Record<string, unknown>,
): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: corpusId,
    family: 'email',
    trust_domain: trustDomain,
    activation_mode: 'hybrid_primary',
    embedding_policy: trustDomain === 'secure_local' ? 'local_only' : 'cloud_allowed_by_policy',
    configured: true,
    provider: 'gmail',
    counts: {
      accounts: 1,
      indexed_items: indexedItems,
      [trustDomain === 'secure_local' ? 'private_chunks' : 'internal_chunks']: indexedItems,
      embedded_chunks: 0,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'email_item_metadata_not_exposed_to_castor',
    ...extra,
  } as unknown as SourceIndexStatusResult['corpora'][number];
}

function dropboxCorpus(files: number, filesWithText: number): SourceIndexStatusResult['corpora'][number] {
  return {
    corpus_id: 'secure_local.dropbox.files',
    family: 'file',
    trust_domain: 'secure_local',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_only',
    configured: true,
    provider: 'dropbox',
    counts: {
      accounts: 1,
      files,
      folders: 0,
      files_with_text: filesWithText,
      secure_local_chunks: filesWithText,
      embedded_chunks: 0,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'secure_local_item_metadata_not_exposed_to_castor',
  } as unknown as SourceIndexStatusResult['corpora'][number];
}
