// Ingestion dispositions: three answers, not two.
//
// The exclusion primitive that shipped earlier today is binary — an item is
// admitted whole or refused whole. The owner's vocabulary is richer than that,
// and the gap between the two is where silent wrong answers live:
//
//   - Some folders should be FINDABLE but not READ. Their titles, paths and
//     dates are the whole value; their contents are private, enormous, or both.
//     Excluding them loses the index; admitting them spends extraction on
//     material nobody asked to have read. `metadata_only` is the third answer.
//   - Some items should be refused for what they ARE rather than where they
//     live. A 4 GB video is not excluded because of its folder; it is excluded
//     because extracting it costs more than it can ever return. That is a
//     media criterion, and it needs facts a path does not carry.
//
// These fixtures run real stores and a real in-memory connector, because every
// property here is an interaction: whether a metadata-only item is stored but
// left unread, whether the gap that admits it is reported rather than assumed,
// whether a media rule that CANNOT be answered says so instead of guessing.
//
// The negative space matters most, same as the Drive fixtures: a rule that
// matches nothing looks exactly like a folder that happens to be empty, and
// this whole file exists so that the two can never be confused again.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import {
  createSourceExclusionMatcher,
  parseSourceIngestionExclusions,
  sourceExclusionDescendantPrefixes,
  sourceExclusionOutcomeIsUnevaluable,
} from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  connectorStoreCoverageGaps,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import {
  buildSourceIngestionLedgerSnapshot,
  formatSourceIngestionLedger,
} from '../src/workers/source-ingestion-ledger.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const ACCOUNT = 'personal';
const SOURCE = 'dropbox.personal';
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.mts'] as const;
const HUNDRED_MB = 100 * 1024 * 1024;

function matcherFor(rules: readonly unknown[], source: string | undefined = SOURCE) {
  return createSourceExclusionMatcher(
    parseSourceIngestionExclusions({ schemaVersion: 1, rules: [...rules] }),
    source,
    { enforceable: ['path_prefix', 'media'] },
  );
}

function metadataOnlyRule(id: string, ...prefixes: string[]): Record<string, unknown> {
  return {
    id,
    mode: 'metadata_only',
    sources: [SOURCE],
    path_prefixes: prefixes,
    reason: 'indexed_by_metadata_only',
  };
}

function bigVideoRule(id = 'big-videos'): Record<string, unknown> {
  return {
    id,
    sources: [SOURCE],
    media: {
      min_bytes: HUNDRED_MB,
      extensions: [...VIDEO_EXTENSIONS],
    },
    reason: 'oversized_media',
  };
}

function fileItem(
  path: string,
  id: string,
  extra: Record<string, unknown> = {},
): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'dropbox',
      accountScope: ACCOUNT,
      providerItemId: id,
      providerFileId: id,
      localItemId: `${ACCOUNT}:${id}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: `body text for ${id}` },
    metadata: Object.freeze({
      entryKind: 'file',
      deleted: false,
      name: path.split('/').pop() ?? id,
      pathDisplay: path,
      pathLower: path.toLowerCase(),
      locatorUri: path,
      ...extra,
    }),
    fetchedAt: '2026-07-28T00:00:00.000Z',
  };
}

function connectorOver(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'dropbox',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error('unknown item');
      return found;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

async function withStore<T>(
  exclusions: ReturnType<typeof createSourceExclusionMatcher> | undefined,
  run: (store: LocalConnectorStore) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-dispositions-'));
  const store = new LocalConnectorStore({
    dbPath: join(root, 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    ...(exclusions ? { exclusions } : {}),
  });
  try {
    return await run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('rule modes', () => {
  test('a rule with no mode is an exclusion, so every existing rule is unchanged', () => {
    const parsed = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'legacy', path_prefixes: ['/4 Archive/4 Archived Backups'], reason: 'r' }],
    });
    expect(parsed.rules[0]?.mode).toBe('exclude');
    const matcher = matcherFor([{ id: 'legacy', path_prefixes: ['/a'], reason: 'r' }]);
    const decision = matcher.evaluatePath('/a/file.pdf');
    expect(decision.excluded).toBe(true);
    expect(decision.disposition).toBe('exclude');
  });

  test('an unrecognized mode is refused at parse rather than defaulted', () => {
    // The whole point of a third disposition is that a typo must not quietly
    // become one of the other two. Defaulting a misspelled `metadta_only` to
    // `exclude` would delete a folder the owner asked to keep indexed.
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'typo', mode: 'metadta_only', path_prefixes: ['/a'], reason: 'r' }],
    })).toThrow();
  });

  test('a metadata-only item is stored, findable, and never read', async () => {
    const matcher = matcherFor([metadataOnlyRule('spirituality', '/3 Resources/Spirituality')]);
    const summary = await withStore(matcher, async (store) => {
      const result = await store.syncFromConnector(
        connectorOver([
          fileItem('/3 Resources/Spirituality/retreat notes.md', 'meta-1'),
          fileItem('/3 Resources/Spirituality/deep/koans.md', 'meta-2'),
          fileItem('/1 Projects/plan.md', 'full-1'),
        ]),
        { fetchContent: true },
      );
      // Every item is INDEXED — that is the difference from an exclusion.
      expect(store.status().counts.items).toBe(3);
      // Only the admitted one has chunks. Metadata-only means no content
      // extraction, no chunks, and therefore nothing to embed.
      expect(store.status().counts.chunks).toBe(1);
      return result;
    });
    expect(summary.itemsIndexed).toBe(3);
    expect(summary.itemsExcluded).toBe(0);
    expect(summary.itemsMetadataOnly).toBe(2);
  });

  test('the coverage gap for a metadata-only rule names the rule and counts, nothing else', async () => {
    const matcher = matcherFor([metadataOnlyRule('spirituality', '/3 Resources/Spirituality')]);
    const summary = await withStore(matcher, (store) => store.syncFromConnector(
      connectorOver([
        fileItem('/3 Resources/Spirituality/retreat notes.md', 'meta-1'),
        fileItem('/3 Resources/Spirituality/deep/koans.md', 'meta-2'),
      ]),
      { fetchContent: true },
    ));
    expect(summary.coverageGaps).toContainEqual({
      kind: 'metadata_only_by_rule',
      ruleId: 'spirituality',
      items: 2,
    });
    const gapLine = summary.gaps.find((gap) => gap.includes('metadata_only_by_rule'));
    expect(gapLine).toBeDefined();
    expect(gapLine).toContain('spirituality');
    // Counts-only. A gap that leaked a path would put the owner's folder names
    // into every receipt this summary reaches.
    expect(gapLine).not.toContain('Spirituality/');
    expect(gapLine).not.toContain('retreat');
  });

  test('a sync with no metadata-only rule reports no metadata-only gap', async () => {
    const matcher = matcherFor([{ id: 'plain', path_prefixes: ['/nowhere'], reason: 'r' }]);
    const summary = await withStore(matcher, (store) => store.syncFromConnector(
      connectorOver([fileItem('/1 Projects/plan.md', 'full-1')]),
      { fetchContent: true },
    ));
    expect(summary.itemsMetadataOnly).toBe(0);
    expect((summary.coverageGaps ?? []).some((gap) => gap.kind === 'metadata_only_by_rule')).toBe(false);
    expect(summary.gaps.some((gap) => gap.includes('metadata_only_by_rule'))).toBe(false);
  });

  test('an exclusion beats a metadata-only rule over the same item', () => {
    // Strictest disposition wins, and it must not depend on rule order: the
    // alternative is an owner whose "never ingest this" is silently downgraded
    // to "index its titles" because they wrote the softer rule first.
    const softFirst = matcherFor([
      metadataOnlyRule('soft', '/2 Areas/Family'),
      { id: 'hard', sources: [SOURCE], path_prefixes: ['/2 Areas/Family/Media Archive'], reason: 'r' },
    ]);
    const decision = softFirst.evaluatePath('/2 Areas/Family/Media Archive/clip.mov');
    expect(decision.disposition).toBe('exclude');
    expect(decision.excluded).toBe(true);
    expect(decision.ruleId).toBe('hard');
  });

  test('a path the gate cannot read is excluded, not downgraded to metadata-only', () => {
    // Fail-closed is unchanged by the new mode. An unreadable path proves
    // nothing, and the cheapest wrong answer stays "one missing file".
    const matcher = matcherFor([metadataOnlyRule('soft', '/3 Resources/Spirituality')]);
    const decision = matcher.evaluatePath(undefined);
    expect(decision.disposition).toBe('exclude');
    expect(decision.outcome).toBe('excluded_path_unevaluable');
  });

  test('content cannot enter a metadata-only item through the restore door', async () => {
    // Restore is the extraction factory's write path: it re-admits chunks after
    // an extractor has read a file. A metadata-only item must be refused there
    // too, or the disposition holds only until the extraction fleet runs.
    const matcher = matcherFor([metadataOnlyRule('spirituality', '/3 Resources/Spirituality')]);
    await withStore(matcher, async (store) => {
      const item = fileItem('/3 Resources/Spirituality/retreat notes.md', 'meta-1');
      await store.syncFromConnector(connectorOver([item]), { fetchContent: true });
      const summary = store.restoreItemRepresentations({
        items: [{
          item,
          expectation: {
            sourceItem: item.identity,
            contentHash: 'unused',
            chunkContentHashes: ['unused'],
          },
        }],
        syncConnectorId: 'file-extraction',
        ownerConnectorId: 'dropbox',
        ownershipKind: 'observed',
        classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
      });
      expect(summary.counts.itemsRestored).toBe(0);
      expect(summary.counts.itemsMetadataOnly).toBe(1);
      expect(store.status().counts.chunks).toBe(0);
    });
  });
});

describe('media rules', () => {
  test('a configured size threshold refuses an oversized video and admits an ordinary one', async () => {
    const matcher = matcherFor([bigVideoRule()]);
    const summary = await withStore(matcher, async (store) => {
      const result = await store.syncFromConnector(
        connectorOver([
          fileItem('/2 Areas/Family/wedding.mov', 'big-1', { sizeBytes: 4_000_000_000 }),
          fileItem('/2 Areas/Family/clip.mp4', 'small-1', { sizeBytes: 2_000_000 }),
          // A 4 GB document is not this rule's business: it is a video rule,
          // and both halves have to match.
          fileItem('/2 Areas/Family/notes.md', 'doc-1', { sizeBytes: 4_000_000_000 }),
        ]),
        { fetchContent: true },
      );
      expect(store.status().counts.items).toBe(2);
      return result;
    });
    expect(summary.itemsExcluded).toBe(1);
    expect(summary.exclusions.by_prefix.find((row) => row.rule_id === 'big-videos')?.items).toBe(1);
  });

  test('the extension test is case-insensitive and cannot swallow a lookalike name', () => {
    const matcher = matcherFor([bigVideoRule()]);
    const over = { sizeBytes: HUNDRED_MB + 1 };
    expect(matcher.evaluateItem({ path: '/a/HOLIDAY.MP4', ...over }).excluded).toBe(true);
    expect(matcher.evaluateItem({ path: '/a/holiday.MoV', ...over }).excluded).toBe(true);
    // Below the size threshold, a lookalike name is not enough on its own.
    const under = { sizeBytes: HUNDRED_MB - 1 };
    expect(matcher.evaluateItem({ path: '/a/notesmp4', ...under }).excluded).toBe(false);
    expect(matcher.evaluateItem({ path: '/a/holiday.mp4.txt', ...under }).excluded).toBe(false);
  });

  test('exactly at the threshold is not over it', () => {
    const matcher = matcherFor([bigVideoRule()]);
    expect(matcher.evaluateItem({ path: '/a/x.mp4', sizeBytes: HUNDRED_MB - 1 }).excluded).toBe(false);
    expect(matcher.evaluateItem({ path: '/a/x.mp4', sizeBytes: HUNDRED_MB }).excluded).toBe(true);
  });

  test('a video whose size the provider never published fails closed and says which half failed', () => {
    // The item IS the media type the rule names; only the size is missing. A
    // gate that admitted it would be guessing that a file it cannot measure is
    // small, and 731 GB of the owner's video is the cost of guessing wrong.
    const matcher = matcherFor([bigVideoRule()]);
    const decision = matcher.evaluateItem({ path: '/a/holiday.mp4' });
    expect(decision.excluded).toBe(true);
    expect(decision.outcome).toBe('excluded_media_unevaluable');
    expect(sourceExclusionOutcomeIsUnevaluable(decision.outcome)).toBe(true);
  });

  test('an item that is not the media type never becomes media-unevaluable', () => {
    // Folders and documents carry no size on most providers. If a missing size
    // alone were unevaluable, configuring one video rule would fail the whole
    // corpus closed — the loudest possible way to lose an owner's data.
    const matcher = matcherFor([bigVideoRule()]);
    expect(matcher.evaluateItem({ path: '/2 Areas/Family' }).excluded).toBe(false);
    expect(matcher.evaluateItem({ path: '/2 Areas/Family/notes.md' }).excluded).toBe(false);
    expect(matcher.evaluateItem({ path: '/2 Areas/Family/notes.md' }).disposition).toBe('admit');
  });

  test('a media type can be named by mime when the provider publishes no extension', () => {
    const matcher = matcherFor([{
      id: 'big-videos',
      sources: [SOURCE],
      media: { min_bytes: HUNDRED_MB, mime_prefixes: ['video/'] },
      reason: 'oversized_media',
    }]);
    expect(matcher.evaluateItem({ path: '/a/opaque', mimeType: 'video/quicktime', sizeBytes: HUNDRED_MB + 1 }).excluded)
      .toBe(true);
    // A published MIME that is not the named type is an answer, not an absent
    // one, so the size half cannot excuse it.
    expect(matcher.evaluateItem({ path: '/a/opaque', mimeType: 'text/plain', sizeBytes: HUNDRED_MB + 1 }).excluded)
      .toBe(false);
  });

  test('a configured size threshold is sufficient evidence for an opaque oversized item', () => {
    const matcher = matcherFor([bigVideoRule()]);
    const decision = matcher.evaluateItem({
      name: 'opaque-provider-id',
      mimeType: 'application/octet-stream',
      sizeBytes: 999_999_999,
    });
    expect(decision.excluded).toBe(true);
    expect(decision.outcome).toBe('excluded_media');
    expect(decision.ruleId).toBe('big-videos');
  });

  test('a media rule may be metadata-only as well as excluding', () => {
    const matcher = matcherFor([{
      id: 'big-videos-indexed',
      mode: 'metadata_only',
      sources: [SOURCE],
      media: { min_bytes: HUNDRED_MB, extensions: [...VIDEO_EXTENSIONS] },
      reason: 'oversized_media',
    }]);
    const decision = matcher.evaluateItem({ path: '/a/x.mov', sizeBytes: HUNDRED_MB + 1 });
    expect(decision.disposition).toBe('metadata_only');
    expect(decision.excluded).toBe(false);
  });

  test('a media rule a source cannot enforce is named, never silently ignored', () => {
    const blanket = { id: 'big-videos', media: { min_bytes: HUNDRED_MB, extensions: ['.mp4'] }, reason: 'r' };
    // Blanket rule, source that cannot evaluate media: reported, lane stays up.
    const identityOnly = createSourceExclusionMatcher(
      parseSourceIngestionExclusions({ schemaVersion: 1, rules: [blanket] }),
      'google_drive.personal',
      { enforceable: ['folder_id'] },
    );
    expect(identityOnly.unenforceableRuleIds).toEqual(['big-videos']);
    expect(identityOnly.mediaActive).toBe(false);

    // The same rule NAMING that source is a mistake in the owner's file, and it
    // is refused when the gate is built rather than discovered as a folder that
    // filled up anyway.
    expect(() => createSourceExclusionMatcher(
      parseSourceIngestionExclusions({
        schemaVersion: 1,
        rules: [{ ...blanket, sources: ['google_drive.personal'] }],
      }),
      'google_drive.personal',
      { enforceable: ['folder_id'] },
    )).toThrow();
  });

  test('a media rule cannot be silently conjoined with a folder rule', () => {
    // One rule, one question. "Videos over 100 MB" and "everything under /X"
    // read as AND to one person and OR to the next, and the reading nobody
    // checked is the one that under-matches.
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'mixed',
        sources: [SOURCE],
        path_prefixes: ['/2 Areas'],
        media: { min_bytes: HUNDRED_MB, extensions: ['.mp4'] },
        reason: 'r',
      }],
    })).toThrow();
  });

  test('a media rule must say what kind of media it means', () => {
    // A size-only rule cannot be answered for any item whose size is missing,
    // so it would fail the corpus closed rather than match a video.
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'size-only', sources: [SOURCE], media: { min_bytes: HUNDRED_MB }, reason: 'r' }],
    })).toThrow();
  });
});

describe('stored-item dispositions', () => {
  test('the metadata-only strip removes chunks and vectors but keeps the item rows', async () => {
    // The rows this operation exists for can only be created one way: indexed
    // BEFORE the rule existed. The ingestion gate makes them impossible going
    // forward, so the store is filled with no gate and then reopened with one.
    const root = mkdtempSync(join(tmpdir(), 'olympus-strip-'));
    const dbPath = join(root, 'store.sqlite');
    const openStore = (exclusions?: ReturnType<typeof createSourceExclusionMatcher>) =>
      new LocalConnectorStore({
        dbPath,
        corpusId: CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        ...(exclusions ? { exclusions } : {}),
      });
    try {
      const permissive = openStore();
      try {
        await permissive.syncFromConnector(
          connectorOver([
            fileItem('/4 Archive/1 Archived Projects/spec.md', 'old-1'),
            fileItem('/4 Archive/1 Archived Projects/deep/notes.md', 'old-2'),
            fileItem('/1 Projects/live.md', 'live-1'),
          ]),
          { fetchContent: true },
        );
        expect(permissive.status().counts.items).toBe(3);
        expect(permissive.status().counts.chunks).toBe(3);
      } finally {
        permissive.close();
      }

      const gated = openStore(matcherFor([metadataOnlyRule('archived-projects', '/4 Archive/1 Archived Projects')]));
      try {
        const preview = gated.stripMetadataOnlyRepresentations({ dryRun: true });
        expect(preview.kind).toBe('connector_store_metadata_only_strip');
        expect(preview.dry_run).toBe(true);
        expect(preview.counts.items_would_strip).toBe(2);
        expect(preview.counts.chunks_would_remove).toBe(2);
        // A dry run removes nothing. Same rows, same matcher, one transaction.
        expect(preview.counts.chunks_removed).toBe(0);
        expect(preview.counts.items_stripped).toBe(0);
        expect(gated.status().counts.chunks).toBe(3);

        const applied = gated.stripMetadataOnlyRepresentations({ dryRun: false });
        expect(applied.counts.items_stripped).toBe(preview.counts.items_would_strip);
        expect(applied.counts.chunks_removed).toBe(preview.counts.chunks_would_remove);
        // The whole difference from a purge: the ITEM ROWS SURVIVE. Three items
        // still indexed, one chunk left, and it belongs to the admitted file.
        expect(gated.status().counts.items).toBe(3);
        expect(gated.status().counts.chunks).toBe(1);
        // Re-running is a no-op rather than an error, so an operator can settle
        // the debt without first checking whether they already did.
        expect(gated.stripMetadataOnlyRepresentations({ dryRun: true }).counts.items_would_strip).toBe(0);
        expect(gated.metadataOnlyContentPresent().items).toBe(0);
      } finally {
        gated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('both debts come back from one walk, and say what the two separate walks said', async () => {
    // The ledger asks for purge debt and strip debt side by side, and each
    // question used to scan the whole table and re-evaluate every locator for
    // its own half — 380ms per source on a 262k-item store. One walk answers
    // both because the gate's decision for a row already answers both: an item
    // is excluded or metadata-only, never both.
    const root = mkdtempSync(join(tmpdir(), 'olympus-debt-'));
    const dbPath = join(root, 'store.sqlite');
    const openStore = (exclusions?: ReturnType<typeof createSourceExclusionMatcher>) =>
      new LocalConnectorStore({
        dbPath,
        corpusId: CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        ...(exclusions ? { exclusions } : {}),
      });
    try {
      const permissive = openStore();
      try {
        await permissive.syncFromConnector(
          connectorOver([
            fileItem('/4 Archive/gone.md', 'archived-1'),
            fileItem('/4 Archive/deep/also-gone.md', 'archived-2'),
            fileItem('/Scans/receipt.md', 'scan-1'),
            fileItem('/1 Projects/live.md', 'live-1'),
          ]),
          { fetchContent: true },
        );
      } finally {
        permissive.close();
      }

      const gated = openStore(matcherFor([
        { id: 'archive', sources: [SOURCE], path_prefixes: ['/4 Archive'], reason: 'excluded' },
        metadataOnlyRule('scans', '/Scans'),
      ]));
      try {
        const debt = gated.exclusionDebtPresent();
        expect(debt.excluded).toEqual({ items: 2, unevaluable: 0 });
        expect(debt.metadataOnlyContent).toEqual({ items: 1, unevaluable: 0 });
        // The single-fact readers are the same answer, so no caller had to
        // change its question to get the cheaper walk.
        expect(gated.excludedItemsPresent()).toEqual(debt.excluded);
        expect(gated.metadataOnlyContentPresent()).toEqual(debt.metadataOnlyContent);

        // Strip debt is CONTENT a metadata-only rule refuses, so settling it
        // clears that half and leaves the purge debt exactly where it was.
        gated.stripMetadataOnlyRepresentations({ dryRun: false });
        const settled = gated.exclusionDebtPresent();
        expect(settled.metadataOnlyContent).toEqual({ items: 0, unevaluable: 0 });
        expect(settled.excluded).toEqual({ items: 2, unevaluable: 0 });
      } finally {
        gated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a store with no gate reports no debt of either kind', () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    try {
      expect(store.exclusionDebtPresent()).toEqual({
        excluded: { items: 0, unevaluable: 0 },
        metadataOnlyContent: { items: 0, unevaluable: 0 },
      });
    } finally {
      store.close();
    }
  });

  test('a metadata-only item stays findable by its metadata after the strip', async () => {
    // Metadata-only must not silently become invisible. This is the assertion
    // that keeps the strip from degrading into a slower, sneakier purge.
    const root = mkdtempSync(join(tmpdir(), 'olympus-strip-fts-'));
    const dbPath = join(root, 'store.sqlite');
    try {
      const permissive = new LocalConnectorStore({
        dbPath,
        corpusId: CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
      });
      try {
        await permissive.syncFromConnector(
          connectorOver([fileItem('/4 Archive/1 Archived Projects/pergamon spec.md', 'old-1')]),
          { fetchContent: true },
        );
      } finally {
        permissive.close();
      }
      const gated = new LocalConnectorStore({
        dbPath,
        corpusId: CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        exclusions: matcherFor([metadataOnlyRule('archived-projects', '/4 Archive/1 Archived Projects')]),
      });
      try {
        gated.stripMetadataOnlyRepresentations({ dryRun: false });
        expect(gated.searchItems('pergamon', 10).length).toBeGreaterThan(0);
        // ...and its body text is gone from the index.
        expect(gated.searchItems('body', 10).length).toBe(0);
      } finally {
        gated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the exclusion purge leaves metadata-only rows alone', async () => {
    const matcher = matcherFor([
      metadataOnlyRule('archived-projects', '/4 Archive/1 Archived Projects'),
      { id: 'backups', sources: [SOURCE], path_prefixes: ['/4 Archive/4 Archived Backups'], reason: 'r' },
    ]);
    await withStore(matcher, async (store) => {
      const summary = store.purgeExcludedItems({ dryRun: true });
      // The metadata-only prefix is a row in the receipt, at zero, so an owner
      // can tell "this rule matched nothing" from "this rule is not a purge
      // rule at all".
      expect(summary.by_prefix.some((row) => row.rule_id === 'archived-projects')).toBe(false);
      expect(summary.by_prefix.some((row) => row.rule_id === 'backups')).toBe(true);
    });
  });

  test('a stored row cannot answer a size question, so the purge keeps it and says so', () => {
    // A store keeps a locator, not a byte count. Deleting on the extension
    // alone would destroy every small video the rule was never about.
    const matcher = matcherFor([bigVideoRule()]);
    const decision = matcher.evaluatePath('/2 Areas/Family/wedding.mov');
    expect(sourceExclusionOutcomeIsUnevaluable(decision.outcome)).toBe(true);
  });
});

describe('retrieval says why the text is missing', () => {
  test('a metadata-only item reports the rule, not a pending extraction', async () => {
    // An item with no chunks has two explanations and the Analyst acts
    // differently on each. "Extraction is pending" invites a retry and reads
    // as a stalled lane; the owner's configuration is a settled end state.
    const matcher = matcherFor([metadataOnlyRule('spirituality', '/3 Resources/Spirituality')]);
    await withStore(matcher, async (store) => {
      await store.syncFromConnector(
        connectorOver([fileItem('/3 Resources/Spirituality/retreat notes.md', 'meta-1')]),
        { fetchContent: true },
      );
      const content = store.localContent(`${ACCOUNT}:meta-1`, 4000);
      expect(content?.storedChunks).toBe(0);
      const ruleId = store.metadataOnlyRuleForLocator(content?.locatorUri);
      expect(ruleId).toBe('spirituality');
      const gaps = connectorStoreCoverageGaps(content!, ruleId);
      expect(gaps.join(' ')).toContain('rule spirituality');
      expect(gaps.join(' ')).not.toContain('pending');
    });
  });

  test('an ordinary item with no text keeps the extraction-pending statement', async () => {
    const matcher = matcherFor([metadataOnlyRule('spirituality', '/3 Resources/Spirituality')]);
    await withStore(matcher, async (store) => {
      await store.syncFromConnector(
        connectorOver([fileItem('/1 Projects/plan.md', 'full-1')]),
        { fetchContent: false },
      );
      const content = store.localContent(`${ACCOUNT}:full-1`, 4000);
      expect(store.metadataOnlyRuleForLocator(content?.locatorUri)).toBeUndefined();
      expect(connectorStoreCoverageGaps(content!).join(' ')).toContain('without extracted text');
    });
  });
});

describe('the extraction lane never proposes to read a metadata-only item', () => {
  test('candidate selection skips them and says how many', async () => {
    // The cheapest place to refuse is before the job exists. A candidate is a
    // proposal to spend a download and often a VLM call, and the owner's 64k
    // metadata-only files are exactly the population that must never become
    // one.
    const root = mkdtempSync(join(tmpdir(), 'olympus-candidates-'));
    const dbPath = join(root, 'store.sqlite');
    try {
      const permissive = new LocalConnectorStore({
        dbPath,
        corpusId: CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
      });
      try {
        await permissive.syncFromConnector(
          connectorOver([
            fileItem('/4 Archive/1 Archived Projects/spec.md', 'meta-1'),
            fileItem('/1 Projects/live.md', 'live-1'),
          ]),
          { fetchContent: false },
        );
        expect(permissive.extractionCandidates({ limit: 10 }).candidates.length).toBe(2);
      } finally {
        permissive.close();
      }
      const gated = new LocalConnectorStore({
        dbPath,
        corpusId: CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        exclusions: matcherFor([metadataOnlyRule('archived-projects', '/4 Archive/1 Archived Projects')]),
      });
      try {
        const page = gated.extractionCandidates({ limit: 10 });
        expect(page.candidates.length).toBe(1);
        expect(page.candidates[0]?.identity.localItemId).toBe(`${ACCOUNT}:live-1`);
        // Counted, not merely absent: a shorter page is indistinguishable from
        // running out of rows unless the skip says so.
        expect(page.skippedByDisposition).toBe(1);
      } finally {
        gated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the ledger tells the two dispositions apart', () => {
  test('metadata-only rules get their own block and their own debt line', () => {
    const matcher = matcherFor([
      metadataOnlyRule('archived-projects', '/4 Archive/1 Archived Projects'),
      { id: 'backups', sources: [SOURCE], path_prefixes: ['/4 Archive/4 Archived Backups'], reason: 'r' },
    ]);
    const snapshot = buildSourceIngestionLedgerSnapshot(
      {
        kind: 'source_index_status',
        generated_at: '2026-07-28T12:00:00.000Z',
        corpora: [],
      } as unknown as Parameters<typeof buildSourceIngestionLedgerSnapshot>[0],
      {
        now: new Date('2026-07-28T12:00:00.000Z'),
        exclusions: [{
          matcher,
          present: { items: 0, unevaluable: 0 },
          metadataOnlyContentPresent: { items: 41, unevaluable: 0 },
        }],
      },
    );
    const excluded = snapshot.excluded_by_configuration!;
    expect(excluded.metadata_only_rules).toBe(1);
    expect(excluded.metadata_only_prefixes).toBe(1);
    expect(excluded.items_metadata_only_content_present).toBe(41);
    const rendered = formatSourceIngestionLedger(snapshot);
    // The excluded folder must NOT be described as metadata-only, and the
    // metadata-only folder must NOT be described as never ingested. Getting
    // this backwards is the one way this section can lie to its only reader.
    expect(rendered).toContain('Excluded by configuration — never ingested (1 rule, 1 folder):');
    expect(rendered).toContain('Metadata-only by configuration — indexed, content never read (1 rule, 1 folder):');
    expect(rendered).toContain('41 item(s) indexed before these folders became metadata-only still carry content');
    expect(snapshot.attention).toEqual(expect.arrayContaining([
      expect.stringContaining('run the metadata-only strip'),
    ]));
  });

  test('a media criterion is never counted as a folder', () => {
    const snapshot = buildSourceIngestionLedgerSnapshot(
      {
        kind: 'source_index_status',
        generated_at: '2026-07-28T12:00:00.000Z',
        corpora: [],
      } as unknown as Parameters<typeof buildSourceIngestionLedgerSnapshot>[0],
      {
        now: new Date('2026-07-28T12:00:00.000Z'),
        exclusions: [{ matcher: matcherFor([bigVideoRule()]), present: { items: 0, unevaluable: 0 } }],
      },
    );
    const rendered = formatSourceIngestionLedger(snapshot);
    expect(rendered).toContain('1 rule criterion');
    expect(rendered).not.toContain('1 folder)');
  });
});

describe('content-lane fences', () => {
  test('metadata-only prefixes fence the content lanes, exactly like exclusions', () => {
    // These prefixes fence content extraction and transcription, not indexing.
    // A metadata-only folder must appear here: keeping its contents out of the
    // content lanes IS the disposition.
    const matcher = matcherFor([
      metadataOnlyRule('archived-projects', '/4 Archive/1 Archived Projects'),
      { id: 'backups', sources: [SOURCE], path_prefixes: ['/4 Archive/4 Archived Backups'], reason: 'r' },
    ]);
    expect(sourceExclusionDescendantPrefixes(matcher).sort()).toEqual([
      '/4 archive/1 archived projects/',
      '/4 archive/4 archived backups/',
    ]);
  });
});
