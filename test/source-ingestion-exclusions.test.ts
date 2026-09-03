// Folder exclusions: the gate, the store enforcement, and the purge.
//
// These fixtures run real connector stores and a real in-memory connector
// rather than mocking the gate, because every property worth testing here is
// an interaction: whether an exclusion beats an overlapping approved scope,
// whether a casing difference can slip past, whether a preview describes the
// same rows the purge deletes, and whether chunks and vectors actually leave
// with their item.
//
// The asymmetry these tests pin down: at ingestion, a path that cannot be
// evaluated is EXCLUDED (cost: one missing file). At purge, the same path is
// KEPT (cost of the alternative: deleting data on a guess).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  loadSourceIngestionExclusions,
  normalizeSourceExclusionPath,
  parseSourceIngestionExclusions,
  SOURCE_INGESTION_EXCLUSIONS_PATH_ENV,
  sourceExclusionDescendantPrefixes,
} from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  ConnectorStoreExclusionViolationError,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import {
  formatSourceExclusionPurgeReport,
  parseSourceExclusionPurgeArgs,
} from '../scripts/source-exclusion-purge.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const ACCOUNT = 'personal';

function exclusionsFor(prefixes: readonly string[], source?: string) {
  return createSourceExclusionMatcher(
    parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'external-corpora',
        ...(source ? { sources: [source] } : {}),
        path_prefixes: [...prefixes],
        reason: 'external_agent_corpus',
      }],
    }),
    source,
  );
}

function fileItem(path: string, id: string, text = 'body text'): RawItem {
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
    content: { kind: 'text', text },
    metadata: Object.freeze({
      entryKind: 'file',
      deleted: false,
      name: id,
      pathDisplay: path,
      pathLower: path.toLowerCase(),
      locatorUri: path,
    }),
    fetchedAt: '2026-07-28T00:00:00.000Z',
  };
}

/** A file whose provider gave back no path at all — the unevaluable case. */
function pathlessItem(id: string): RawItem {
  const item = fileItem('/placeholder', id);
  return { ...item, metadata: Object.freeze({ entryKind: 'file', deleted: false, name: id }) };
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
  const root = mkdtempSync(join(tmpdir(), 'olympus-exclusions-'));
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

describe('exclusion matching', () => {
  test('matches on whole path segments, so a sibling folder is not swallowed', () => {
    const matcher = exclusionsFor(['/3 Resources/Books']);
    expect(matcher.evaluatePath('/3 Resources/Books').excluded).toBe(true);
    expect(matcher.evaluatePath('/3 Resources/Books/deep/file.pdf').excluded).toBe(true);
    // The trap a bare startsWith would fall into. Over-exclusion is the cheaper
    // error but it is still wrong, and it would make a purge preview overstate
    // what a prefix accounts for.
    expect(matcher.evaluatePath('/3 Resources/Bookshelf.pdf').excluded).toBe(false);
    expect(matcher.evaluatePath('/3 Resources/Bookshelf/notes.md').excluded).toBe(false);
  });

  test('casing cannot leak, in either direction', () => {
    // Provider paths are case-insensitive, which is why providers publish a
    // casefolded path at all. An exclusion that misses on casing is a silent
    // leak of exactly the material the user asked to keep out.
    const matcher = exclusionsFor(['/2 Areas/Castor Workfiles/EXAMPLE']);
    expect(matcher.evaluatePath('/2 areas/castor workfiles/example/notes.md').excluded).toBe(true);
    expect(matcher.evaluatePath('/2 AREAS/CASTOR WORKFILES/EXAMPLE').excluded).toBe(true);
    expect(exclusionsFor(['/a/books']).evaluatePath('/A/BOOKS/x.epub').excluded).toBe(true);
  });

  test('composed and decomposed accents name the same folder', () => {
    // Desktop clients hand back decomposed (NFD) accents while provider APIs
    // publish composed (NFC) ones. Raw string comparison would treat these as
    // different folders and admit the material.
    const composed = '/Archive/Résumés';
    const decomposed = '/Archive/Résumés';
    expect(exclusionsFor([composed]).evaluatePath(decomposed).excluded).toBe(true);
    expect(exclusionsFor([decomposed]).evaluatePath(composed).excluded).toBe(true);
  });

  test('normalization is insensitive to separators, trailing slashes, and case', () => {
    expect(normalizeSourceExclusionPath('3 Resources//Books/')).toBe('/3 resources/books');
    expect(normalizeSourceExclusionPath('\\3 Resources\\Books')).toBe('/3 resources/books');
    expect(normalizeSourceExclusionPath('/')).toBeUndefined();
    // A traversal segment could walk out from under an excluded prefix.
    expect(normalizeSourceExclusionPath('/a/../b')).toBeUndefined();
    // An embedded NUL truncates in some consumers, which would make two
    // different paths compare equal. Written as an escape so this file stays
    // text: a literal NUL makes git treat the whole file as binary.
    expect(normalizeSourceExclusionPath('/a\u0000/b')).toBeUndefined();
  });

  test('fails closed on a path it cannot evaluate, and says which case it hit', () => {
    const matcher = exclusionsFor(['/3 Resources/Books']);
    for (const value of [undefined, null, 42, '', '   ', '/a/../b']) {
      const decision = matcher.evaluatePath(value);
      expect(decision.excluded).toBe(true);
      expect(decision.outcome).toBe('excluded_path_unevaluable');
    }
  });

  test('an unconfigured source has nothing to fail closed about', () => {
    // Fail-closed applies to ambiguity WITHIN a configured exclusion, never to
    // the absence of configuration. Otherwise installing the feature would
    // silently stop all ingestion.
    const matcher = createSourceExclusionMatcher({ schemaVersion: 1, rules: [] }, 'dropbox.personal');
    expect(matcher.active).toBe(false);
    expect(matcher.evaluatePath(undefined).excluded).toBe(false);
    expect(matcher.evaluatePath('/3 Resources/Books').excluded).toBe(false);
  });

  test('rules apply per source, and a rule with no sources applies to all of them', () => {
    const parsed = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [
        { id: 'one-source', sources: ['dropbox.personal'], path_prefixes: ['/a'], reason: 'r' },
        { id: 'every-source', sources: [], path_prefixes: ['/b'], reason: 'r' },
      ],
    });
    expect(createSourceExclusionMatcher(parsed, 'dropbox.personal').evaluatePath('/a/x').excluded).toBe(true);
    expect(createSourceExclusionMatcher(parsed, 'other.source').evaluatePath('/a/x').excluded).toBe(false);
    expect(createSourceExclusionMatcher(parsed, 'other.source').evaluatePath('/b/x').excluded).toBe(true);
  });

  test('the first matching prefix wins, so per-prefix counts cannot double-count', () => {
    const matcher = createSourceExclusionMatcher(parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [
        { id: 'outer', sources: [], path_prefixes: ['/a'], reason: 'outer' },
        { id: 'inner', sources: [], path_prefixes: ['/a/b'], reason: 'inner' },
      ],
    }));
    expect(matcher.evaluatePath('/a/b/c').ruleId).toBe('outer');
  });

  test('older string-prefix fences get a form that agrees with the gate', () => {
    // Some lanes fence with a plain `prefix%` match instead of calling the
    // matcher. Handed the bare prefix they would also swallow the sibling; the
    // descendant form makes those lanes mean the same thing this gate means.
    const matcher = exclusionsFor(['/3 Resources/Books', '/Archive']);
    expect(sourceExclusionDescendantPrefixes(matcher)).toEqual(['/3 resources/books/', '/archive/']);
    expect('/3 resources/bookshelf.pdf'.startsWith('/3 resources/books/')).toBe(false);
    expect('/3 resources/books/atlas.epub'.startsWith('/3 resources/books/')).toBe(true);
  });

  test('a configuration that cannot be normalized is refused, never silently dropped', () => {
    // Dropping it would leave the user believing a folder is excluded while
    // ingestion happily admits it.
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'bad', path_prefixes: ['/'], reason: 'r' }],
    })).toThrow();
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'bad', path_prefixes: [], reason: 'r' }],
    })).toThrow();
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'has spaces', path_prefixes: ['/a'], reason: 'r' }],
    })).toThrow();
    expect(() => parseSourceIngestionExclusions({ schemaVersion: 2, rules: [] })).toThrow();
  });

  test('a malformed scalar rules field is refused instead of disabling every exclusion', () => {
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: 'not-an-array',
    })).toThrow(/rules must be an array/i);
  });

  test('a malformed scalar sources field is refused instead of widening the rule to every source', () => {
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'scalar-source',
        sources: 'dropbox.personal',
        path_prefixes: ['/a'],
        reason: 'r',
      }],
    })).toThrow(/sources must be an array/i);
  });

  test('loads from a file, and a missing file means nothing is excluded', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-exclusions-load-'));
    try {
      const path = join(root, 'exclusions.json');
      expect(loadSourceIngestionExclusions({ env: { [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: path } }).rules)
        .toEqual([]);
      writeFileSync(path, JSON.stringify({
        schemaVersion: 1,
        rules: [{ id: 'books', sources: ['dropbox.personal'], path_prefixes: ['/3 Resources/Books'] }],
      }), 'utf8');
      const loaded = loadSourceIngestionExclusions({ env: { [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: path } });
      expect(loaded.rules).toHaveLength(1);
      expect(loaded.rules[0]?.path_prefixes).toEqual(['/3 resources/books']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a file that exists but cannot be parsed throws rather than degrading to no exclusions', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-exclusions-broken-'));
    try {
      const path = join(root, 'exclusions.json');
      writeFileSync(path, '{ not json', 'utf8');
      expect(() => loadSourceIngestionExclusions({ env: { [SOURCE_INGESTION_EXCLUSIONS_PATH_ENV]: path } }))
        .toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ingestion enforcement', () => {
  test('an excluded prefix is never admitted: no item, no chunk, no vector', async () => {
    const matcher = exclusionsFor(['/3 Resources/Books'], 'dropbox.personal');
    await withStore(matcher, async (store) => {
      const summary = await store.syncFromConnector(
        connectorOver([
          fileItem('/1 Projects/plan.md', 'keep-1'),
          fileItem('/3 Resources/Books/atlas.epub', 'drop-1'),
          fileItem('/3 Resources/Books/deep/nested.pdf', 'drop-2'),
        ]),
        { fetchContent: true },
      );
      expect(summary.itemsSeen).toBe(3);
      expect(summary.itemsIndexed).toBe(1);
      expect(summary.itemsExcluded).toBe(2);
      expect(summary.exclusions.by_prefix).toEqual([
        { rule_id: 'external-corpora', prefix: '/3 resources/books', reason: 'external_agent_corpus', items: 2 },
      ]);
      const status = store.status();
      expect(status.counts.items).toBe(1);
      expect(store.excludedItemsPresent()).toEqual({ items: 0, unevaluable: 0 });
    });
  });

  test('exclusion beats an overlapping approved scope', async () => {
    // The approved scope covers the whole subtree; the exclusion sits inside
    // it. Inclusion never wins: there is no path that reinstates the item.
    const matcher = exclusionsFor(['/2 Areas/Castor Workfiles/Example'], 'dropbox.personal');
    await withStore(matcher, async (store) => {
      const summary = await store.syncFromConnector(
        connectorOver([
          fileItem('/2 Areas/notes.md', 'keep-1'),
          fileItem('/2 Areas/Castor Workfiles/Example/ruling.md', 'drop-1'),
        ]),
        { fetchContent: true },
      );
      expect(summary.itemsIndexed).toBe(1);
      expect(summary.itemsExcluded).toBe(1);
    });
  });

  test('an item with no evaluable path is excluded and reported separately', async () => {
    const matcher = exclusionsFor(['/3 Resources/Books'], 'dropbox.personal');
    await withStore(matcher, async (store) => {
      const summary = await store.syncFromConnector(
        connectorOver([fileItem('/1 Projects/plan.md', 'keep-1'), pathlessItem('unknown-1')]),
        { fetchContent: true },
      );
      expect(summary.itemsIndexed).toBe(1);
      expect(summary.itemsExcluded).toBe(1);
      expect(summary.exclusions.items_excluded_unevaluable).toBe(1);
    });
  });

  test('the store itself refuses an excluded write, so a new caller cannot bypass the gate', async () => {
    // The structural half of "exclusion beats inclusion": the check lives on
    // the one private upsert every write funnels through, not only on the
    // enumerating loops that are expected to have checked already.
    const matcher = exclusionsFor(['/3 Resources/Books'], 'dropbox.personal');
    await withStore(matcher, async (store) => {
      expect(() => store.restoreItemRepresentations({
        syncConnectorId: 'dropbox',
        ownerConnectorId: 'dropbox',
        ownershipKind: 'observed',
        classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
        items: [],
      })).not.toThrow();

      const item = fileItem('/3 Resources/Books/atlas.epub', 'drop-1');
      const summary = store.restoreItemRepresentations({
        syncConnectorId: 'dropbox',
        ownerConnectorId: 'dropbox',
        ownershipKind: 'observed',
        classify: () => buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
        items: [{
          item,
          expectation: {
            sourceItem: item.identity,
            contentHash: 'unused',
            chunkContentHashes: [],
          },
        }],
      });
      // Restore counts and skips rather than raising, because a "missing item"
      // error here would read as corruption instead of policy.
      expect(summary.counts.itemsExcluded).toBe(1);
      expect(summary.counts.itemsRestored).toBe(0);
      expect(store.status().counts.items).toBe(0);
    });
  });

  test('the refusal error is typed, so a gate bypass is distinguishable from a data fault', () => {
    const error = new ConnectorStoreExclusionViolationError('external-corpora');
    expect(error).toBeInstanceOf(Error);
    expect(error.ruleId).toBe('external-corpora');
    // No path, name, or text in the message.
    expect(error.message).not.toContain('/');
  });
});

describe('purging what is already stored', () => {
  test('a dry run reports per prefix and deletes nothing; the purge removes items, chunks and vectors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-exclusions-purge-'));
    const dbPath = join(root, 'store.sqlite');
    const storeOptions = {
      dbPath,
      corpusId: CORPUS_ID,
      family: 'file' as const,
      trustDomain: 'secure_local' as const,
    };
    try {
      // Seed with NO gate attached: this is the real situation the purge
      // exists for — material ingested before the folder was excluded.
      const ungated = new LocalConnectorStore(storeOptions);
      try {
        await ungated.syncFromConnector(
          connectorOver([
            fileItem('/1 Projects/plan.md', 'keep-1'),
            fileItem('/3 Resources/Books/atlas.epub', 'drop-1'),
            fileItem('/3 Resources/Books/deep/nested.pdf', 'drop-2'),
          ]),
          { fetchContent: true },
        );
        expect(ungated.status().counts.items).toBe(3);
      } finally {
        ungated.close();
      }

      const gated = new LocalConnectorStore({
        ...storeOptions,
        exclusions: exclusionsFor(['/3 Resources/Books'], 'dropbox.personal'),
      });
      try {
        expect(gated.excludedItemsPresent()).toEqual({ items: 2, unevaluable: 0 });
        const chunksBefore = gated.status().counts.chunks;

        const preview = gated.purgeExcludedItems({ dryRun: true });
        expect(preview.dry_run).toBe(true);
        expect(preview.counts.items_would_remove).toBe(2);
        expect(preview.counts.items_removed).toBe(0);
        expect(preview.counts.chunks_would_remove).toBeGreaterThan(0);
        expect(preview.by_prefix).toEqual([
          { rule_id: 'external-corpora', prefix: '/3 resources/books', reason: 'external_agent_corpus', items: 2 },
        ]);
        // Nothing moved.
        expect(gated.status().counts.items).toBe(3);

        const purged = gated.purgeExcludedItems({ dryRun: false });
        expect(purged.dry_run).toBe(false);
        // The preview described exactly the set the purge acted on.
        expect(purged.counts.items_removed).toBe(preview.counts.items_would_remove);
        expect(purged.counts.chunks_removed).toBe(preview.counts.chunks_would_remove);
        expect(purged.counts.embeddings_removed).toBe(preview.counts.embeddings_would_remove);
        expect(gated.excludedItemsPresent()).toEqual({ items: 0, unevaluable: 0 });

        // Items, chunks and vectors left together. An orphaned chunk would keep
        // the excluded text searchable behind an item that no longer exists,
        // which is the failure this purge exists to prevent.
        const after = gated.status().counts;
        expect(after.items).toBe(1);
        expect(after.chunks).toBe(chunksBefore - purged.counts.chunks_removed);
        expect(after.chunks).toBeGreaterThan(0);
        expect(after.embeddedChunks).toBe(0);
      } finally {
        gated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('purge keeps what it cannot evaluate, and reports it rather than guessing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-exclusions-purge-unknown-'));
    const dbPath = join(root, 'store.sqlite');
    const storeOptions = {
      dbPath,
      corpusId: CORPUS_ID,
      family: 'file' as const,
      trustDomain: 'secure_local' as const,
    };
    try {
      const ungated = new LocalConnectorStore(storeOptions);
      try {
        await ungated.syncFromConnector(
          connectorOver([fileItem('/1 Projects/plan.md', 'keep-1'), pathlessItem('unknown-1')]),
          { fetchContent: true },
        );
      } finally {
        ungated.close();
      }

      const gated = new LocalConnectorStore({
        ...storeOptions,
        exclusions: exclusionsFor(['/3 Resources/Books'], 'dropbox.personal'),
      });
      try {
        const preview = gated.purgeExcludedItems({ dryRun: true });
        // Deleting a row this gate cannot read would be destroying data on a
        // guess — the opposite of the ingestion direction, and deliberate.
        expect(preview.counts.items_matched).toBe(1);
        expect(preview.counts.items_would_remove).toBe(0);
        expect(preview.counts.items_unevaluable_kept).toBe(1);

        gated.purgeExcludedItems({ dryRun: false });
        expect(gated.status().counts.items).toBe(2);

        // The operator can opt in once they have seen the count.
        const opted = gated.purgeExcludedItems({ dryRun: false, purgeUnevaluable: true });
        expect(opted.counts.items_removed).toBe(1);
        expect(gated.status().counts.items).toBe(1);
      } finally {
        gated.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the operator command previews by default and deletes only when asked', () => {
    // The safety property of the whole leg: there is no way to reach a deletion
    // by forgetting a flag.
    const preview = { purge: false, purgeUnevaluable: false, stripMetadataOnly: false };
    expect(parseSourceExclusionPurgeArgs([])).toEqual(preview);
    expect(parseSourceExclusionPurgeArgs(['--dry-run'])).toEqual(preview);
    expect(parseSourceExclusionPurgeArgs(['--purge']).purge).toBe(true);
    expect(parseSourceExclusionPurgeArgs(['--purge', '--purge-unevaluable']))
      .toEqual({ purge: true, purgeUnevaluable: true, stripMetadataOnly: false });
    // The metadata-only strip is its own verb: asking for a purge never
    // strips, and asking for a strip never deletes a row.
    expect(parseSourceExclusionPurgeArgs(['--strip-metadata-only']))
      .toEqual({ purge: false, purgeUnevaluable: false, stripMetadataOnly: true });
    // Accepting this without --purge would make the preview describe a
    // different set than the flag implies.
    expect(() => parseSourceExclusionPurgeArgs(['--purge-unevaluable'])).toThrow();
    expect(() => parseSourceExclusionPurgeArgs(['--wipe'])).toThrow();
  });

  test('the preview report names counts and configured prefixes, never an item path', async () => {
    const summary = await withStore(exclusionsFor(['/3 Resources/Books'], 'dropbox.personal'), (store) =>
      store.purgeExcludedItems({ dryRun: true }));
    const report = formatSourceExclusionPurgeReport(summary);
    expect(report).toContain('DRY RUN');
    expect(report).toContain('/3 resources/books');
    expect(report).toContain('external-corpora');
    expect(report).not.toContain('atlas');
  });

  test('a store with no exclusions configured purges nothing', async () => {
    await withStore(undefined, (store) => {
      const summary = store.purgeExcludedItems({ dryRun: false });
      expect(summary.counts.items_removed).toBe(0);
      expect(summary.by_prefix).toEqual([]);
    });
  });
});
