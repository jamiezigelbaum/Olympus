// The ingestion-dispositions folder picker: the tree engine, the edit that
// writes the owner's rules back, the two worker routes, and the rendered page.
//
// The thing every test here is really defending: the picker and the ingestion
// gate must never disagree. So the round-trip tests do not assert on the JSON
// the edit produced — they feed that JSON to the REAL matcher and ask it what
// an item's disposition is. A picker that wrote a plausible-looking rule the
// gate reads differently is the failure this file exists to catch.

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  applySourceDispositionEdits,
  buildSourceDispositionTree,
  sourceDispositionNonFolderRules,
  sourceDispositionRuleId,
  type SourceDispositionNode,
  type SourceDispositionTree,
} from '../src/core/source-disposition-tree.ts';
import {
  createSourceExclusionMatcher,
  parseSourceIngestionExclusions,
  type SourceExclusionMatcher,
  type SourceIngestionExclusions,
} from '../src/core/source-ingestion-exclusions.ts';
import {
  buildSourceDispositionsView,
  readSourceIngestionExclusionsFile,
  saveSourceDispositions,
  writeSourceIngestionExclusionsFile,
  type SourceDispositionsSource,
} from '../src/workers/source-dispositions.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';

const SOURCE = 'files.personal';
const CORPUS_ID = 'secure_local.files.fixture';
const ENFORCEABLE = ['path_prefix', 'media'] as const;

// The live shape, trimmed: exclude-mode folders, metadata-only folders, and one
// blanket media rule naming no source.
const FIXTURE_RULES = {
  schemaVersion: 1,
  rules: [
    {
      id: 'castor-workfiles',
      sources: [SOURCE],
      path_prefixes: ['/2 Areas/Castor Workfiles'],
      reason: 'another system curates this',
    },
    {
      id: 'archived-backups',
      sources: [SOURCE],
      path_prefixes: ['/4 Archive/4 Archived Backups'],
      reason: 'backup images, not documents',
    },
    {
      id: 'spirituality',
      mode: 'metadata_only',
      sources: [SOURCE],
      path_prefixes: ['/3 Resources/Spirituality'],
      reason: 'index titles and dates, never read the contents',
    },
    {
      id: 'oversized-video',
      media: { extensions: ['.mp4', '.mov'], min_bytes: 104857600 },
      reason: 'video over 100 MiB is never worth extracting',
    },
  ],
};

// Every fixture path, with whether the fixture store holds content for it.
const FIXTURE_ITEMS: ReadonlyArray<{ path: string; text?: string }> = [
  { path: '/2 Areas/Castor Workfiles/brief.md', text: 'another system owns this' },
  { path: '/2 Areas/Castor Workfiles/deep/plan.md', text: 'nested under the exclusion' },
  { path: '/2 Areas/Finances/2026/taxes.pdf', text: 'kept in full' },
  { path: '/2 Areas/Finances/receipts.csv', text: 'kept in full' },
  { path: '/3 Resources/Spirituality/notes.md', text: 'content a metadata-only rule forbids' },
  { path: '/3 Resources/Spirituality/retreat/agenda.md', text: 'nested metadata-only content' },
  { path: '/3 Resources/Books/reading list.md', text: 'no rule covers this' },
  { path: '/4 Archive/4 Archived Backups/disk.img' },
  { path: '/4 Archive/1 Archived Projects/old.md', text: 'no rule covers this either' },
];

function fixtureDocument(): SourceIngestionExclusions {
  return parseSourceIngestionExclusions(structuredClone(FIXTURE_RULES), 'fixture');
}

function fixtureMatcher(document = fixtureDocument()): SourceExclusionMatcher {
  return createSourceExclusionMatcher(document, SOURCE, { enforceable: ENFORCEABLE });
}

function fixtureItems(): Array<{ locator: string; hasContent: boolean }> {
  return FIXTURE_ITEMS.map((item) => ({ locator: item.path, hasContent: item.text !== undefined }));
}

function fixtureTree(document = fixtureDocument()): SourceDispositionTree {
  return buildSourceDispositionTree({ matcher: fixtureMatcher(document), items: fixtureItems() });
}

function nodeAt(tree: SourceDispositionTree, path: string): SourceDispositionNode {
  const wanted = path.toLowerCase();
  const stack = [...tree.roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.path === wanted) return node;
    stack.push(...node.children);
  }
  throw new Error(`fixture tree has no node at ${path}`);
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- The tree ---------------------------------------------------------------

describe('disposition tree effective state', () => {
  test('effective-state inheritance: a child with no rule reports its ancestor\'s state and says so', () => {
    const tree = fixtureTree();
    const parent = nodeAt(tree, '/2 areas/castor workfiles');
    const child = nodeAt(tree, '/2 areas/castor workfiles/deep');

    expect(parent).toMatchObject({ state: 'exclude', origin: 'explicit', rule_id: 'castor-workfiles' });
    expect(child).toMatchObject({
      state: 'exclude',
      origin: 'inherited',
      inherited_from: '/2 areas/castor workfiles',
      rule_id: 'castor-workfiles',
    });
    // A folder no rule reaches is the default, not an inherited anything.
    expect(nodeAt(tree, '/2 areas/finances')).toMatchObject({ state: 'ingest', origin: 'default' });
    expect(nodeAt(tree, '/2 areas/finances').inherited_from).toBeUndefined();
  });

  test('effective-state inheritance carries the metadata-only disposition too', () => {
    const tree = fixtureTree();
    expect(nodeAt(tree, '/3 resources/spirituality')).toMatchObject({
      state: 'metadata_only',
      origin: 'explicit',
    });
    expect(nodeAt(tree, '/3 resources/spirituality/retreat')).toMatchObject({
      state: 'metadata_only',
      origin: 'inherited',
      inherited_from: '/3 resources/spirituality',
    });
  });

  test('segment-boundary containment: a sibling sharing a prefix is not swallowed', () => {
    // `/3 Resources/Books` must not be dragged under `/3 Resources/Book` style
    // string prefixes, and the tree must ask the gate rather than compare text.
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'book', sources: [SOURCE], path_prefixes: ['/3 Resources/Book'], reason: 'x' }],
    }, 'fixture');
    const tree = fixtureTree(document);
    expect(nodeAt(tree, '/3 resources/books').state).toBe('ingest');
  });

  test('per-node counts match what each cleanup verb would actually do', () => {
    const tree = fixtureTree();
    const castor = nodeAt(tree, '/2 areas/castor workfiles');
    expect(castor.counts).toMatchObject({
      items: 2,
      excluded_items: 2,
      excluded_items_would_purge: 2,
      metadata_only_items: 0,
    });
    const spirituality = nodeAt(tree, '/3 resources/spirituality');
    expect(spirituality.counts).toMatchObject({
      items: 2,
      metadata_only_items: 2,
      metadata_only_items_with_content: 2,
      metadata_only_content_would_strip: 2,
      excluded_items: 0,
    });
    // Totals cover every fixture item, including the one with no content.
    expect(tree.counts.items).toBe(FIXTURE_ITEMS.length);
    expect(tree.counts.items_with_content).toBe(FIXTURE_ITEMS.filter((item) => item.text).length);
  });

  test('mixed_below marks a subtree whose descendants carry a different state', () => {
    const tree = fixtureTree();
    expect(nodeAt(tree, '/3 resources').mixed_below).toBe(true);
    expect(nodeAt(tree, '/2 areas/castor workfiles').mixed_below).toBe(false);
  });

  test('a folder a rule names is in the tree even with nothing stored under it', () => {
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'empty-folder', sources: [SOURCE], path_prefixes: ['/9 Nothing/Here'], reason: 'x' }],
    }, 'fixture');
    const tree = buildSourceDispositionTree({ matcher: fixtureMatcher(document), items: [] });
    expect(nodeAt(tree, '/9 nothing/here')).toMatchObject({ state: 'exclude', origin: 'explicit', counts: { items: 0 } });
  });

  test('a rule deeper than the depth bound is still rendered', () => {
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'deep', sources: [SOURCE], path_prefixes: ['/a/b/c/d/e/f/g'], reason: 'x' }],
    }, 'fixture');
    const tree = buildSourceDispositionTree({
      matcher: fixtureMatcher(document),
      items: [{ locator: '/a/b/c/d/e/f/g/h/i.md', hasContent: true }],
      maxDepth: 2,
    });
    expect(nodeAt(tree, '/a/b/c/d/e/f/g').origin).toBe('explicit');
    // The folders under it are counted into their ancestors and reported, never
    // dropped from the totals.
    expect(tree.counts.items).toBe(1);
    expect(tree.truncated_nodes).toBeGreaterThan(0);
  });

  test('an item whose locator cannot be normalized is counted and reported, never dropped', () => {
    const tree = buildSourceDispositionTree({
      matcher: fixtureMatcher(),
      items: [{ locator: '/2 Areas/Finances/ok.md' }, { locator: '../escape.md' }, { locator: null }],
    });
    expect(tree.counts.items).toBe(3);
    expect(tree.unplaced_items).toBe(2);
    expect(tree.counts.unevaluable_items).toBe(2);
  });

  test('display casing is the owner\'s, while every comparison key is normalized', () => {
    const tree = fixtureTree();
    const node = nodeAt(tree, '/2 areas/castor workfiles');
    expect(node.name).toBe('Castor Workfiles');
    expect(node.display_path).toBe('/2 Areas/Castor Workfiles');
    expect(node.path).toBe('/2 areas/castor workfiles');
  });
});

describe('strictest-wins conflicts', () => {
  test('an exclusion beats a metadata-only rule over the same folder, in either order', () => {
    const softFirst = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [
        { id: 'soft', mode: 'metadata_only', sources: [SOURCE], path_prefixes: ['/4 Archive'], reason: 'soft' },
        { id: 'hard', sources: [SOURCE], path_prefixes: ['/4 Archive/4 Archived Backups'], reason: 'hard' },
      ],
    }, 'fixture');
    const hardFirst = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [
        { id: 'hard', sources: [SOURCE], path_prefixes: ['/4 Archive/4 Archived Backups'], reason: 'hard' },
        { id: 'soft', mode: 'metadata_only', sources: [SOURCE], path_prefixes: ['/4 Archive'], reason: 'soft' },
      ],
    }, 'fixture');
    for (const document of [softFirst, hardFirst]) {
      const tree = fixtureTree(document);
      expect(nodeAt(tree, '/4 archive').state).toBe('metadata_only');
      expect(nodeAt(tree, '/4 archive/4 archived backups')).toMatchObject({
        state: 'exclude',
        origin: 'explicit',
        rule_id: 'hard',
      });
      expect(nodeAt(tree, '/4 archive/1 archived projects').state).toBe('metadata_only');
    }
  });

  test('metadata-only under an excluded ancestor is refused, because the gate would ignore it', () => {
    const document = fixtureDocument();
    const result = applySourceDispositionEdits(
      document,
      [{ path: '/2 Areas/Castor Workfiles/deep', state: 'metadata_only' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.changed).toBe(false);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ code: 'inherited_state_not_editable' });
    expect(result.refused[0]?.message).toContain('outranks metadata-only');
  });

  test('a stricter choice under a metadata-only ancestor IS expressible and takes effect', () => {
    const document = fixtureDocument();
    const result = applySourceDispositionEdits(
      document,
      [{ path: '/3 Resources/Spirituality/retreat', state: 'exclude' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.refused).toHaveLength(0);
    // The real gate, over the produced document, is the assertion that matters.
    const matcher = createSourceExclusionMatcher(result.rules, SOURCE, { enforceable: ENFORCEABLE });
    expect(matcher.evaluatePath('/3 Resources/Spirituality/retreat/agenda.md').disposition).toBe('exclude');
    expect(matcher.evaluatePath('/3 Resources/Spirituality/notes.md').disposition).toBe('metadata_only');
  });
});

describe('edits round-trip through the real gate', () => {
  test('excluding a folder makes the gate exclude everything under it, and nothing beside it', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/3 Resources/Books', state: 'exclude', reason: 'another system curates this' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.applied[0]).toMatchObject({ action: 'added', state: 'exclude' });
    const document = parseSourceIngestionExclusions(
      JSON.parse(JSON.stringify(result.rules)) as unknown,
      'round trip',
    );
    const matcher = createSourceExclusionMatcher(document, SOURCE, { enforceable: ENFORCEABLE });
    expect(matcher.evaluatePath('/3 Resources/Books/reading list.md').disposition).toBe('exclude');
    expect(matcher.evaluatePath('/3 Resources/Bookshelf.pdf').disposition).toBe('admit');
    expect(matcher.evaluatePath('/2 Areas/Finances/receipts.csv').disposition).toBe('admit');
  });

  test('setting a folder to metadata only produces a mode the gate reads back', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/4 Archive/1 Archived Projects', state: 'metadata_only' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    const matcher = createSourceExclusionMatcher(result.rules, SOURCE, { enforceable: ENFORCEABLE });
    const decision = matcher.evaluatePath('/4 Archive/1 Archived Projects/old.md');
    expect(decision.disposition).toBe('metadata_only');
    expect(decision.excluded).toBe(false);
  });

  test('setting an explicitly excluded folder back to ingest removes only that prefix', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/2 Areas/Castor Workfiles', state: 'ingest' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.applied[0]).toMatchObject({ action: 'removed', rule_id: 'castor-workfiles' });
    const matcher = createSourceExclusionMatcher(result.rules, SOURCE, { enforceable: ENFORCEABLE });
    expect(matcher.evaluatePath('/2 Areas/Castor Workfiles/brief.md').disposition).toBe('admit');
    // The other rules are untouched.
    expect(matcher.evaluatePath('/4 Archive/4 Archived Backups/disk.img').disposition).toBe('exclude');
    expect(matcher.evaluatePath('/3 Resources/Spirituality/notes.md').disposition).toBe('metadata_only');
  });

  test('ingest under an excluded ancestor is refused rather than approximated', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/2 Areas/Castor Workfiles/deep', state: 'ingest' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.changed).toBe(false);
    expect(result.rules.rules).toHaveLength(FIXTURE_RULES.rules.length);
    expect(result.refused[0]).toMatchObject({ code: 'inherited_state_not_editable' });
    expect(result.refused[0]?.message).toContain('/2 areas/castor workfiles');
  });

  test('a redundant edit that repeats an inherited state writes nothing', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/3 Resources/Spirituality/retreat', state: 'metadata_only' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.changed).toBe(false);
    expect(result.applied[0]?.action).toBe('unchanged');
    expect(result.rules.rules).toHaveLength(FIXTURE_RULES.rules.length);
  });

  test('a source that cannot enforce path prefixes refuses every folder edit', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/3 Resources/Books', state: 'exclude' }],
      { source: SOURCE, enforceable: ['folder_id', 'media'] },
    );
    expect(result.changed).toBe(false);
    expect(result.refused[0]?.code).toBe('criterion_not_editable_by_path');
  });

  test('batched edits are each decided against the document the previous one produced', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [
        { path: '/3 Resources/Books', state: 'exclude' },
        // Now inherits the exclusion just written, so it is refused rather than
        // producing a second rule that the gate would ignore.
        { path: '/3 Resources/Books/technical', state: 'metadata_only' },
      ],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.applied.filter((entry) => entry.action === 'added')).toHaveLength(1);
    expect(result.refused).toHaveLength(1);
  });
});

describe('rule id stability', () => {
  test('id stability on edit: every untouched rule keeps its exact id', () => {
    const before = fixtureDocument();
    const result = applySourceDispositionEdits(
      before,
      [{ path: '/3 Resources/Books', state: 'exclude' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    for (const rule of before.rules) {
      expect(result.rules.rules.some((next) => next.id === rule.id)).toBe(true);
    }
    expect(result.untouched_rule_ids).toEqual(
      ['archived-backups', 'castor-workfiles', 'oversized-video', 'spirituality'],
    );
  });

  test('removing one folder from a multi-folder rule keeps the rule and its id', () => {
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'library',
        sources: [SOURCE],
        path_prefixes: ['/3 Resources/Books', '/3 Resources/Papers'],
        reason: 'another system curates these',
      }],
    }, 'fixture');
    const result = applySourceDispositionEdits(
      document,
      [{ path: '/3 Resources/Books', state: 'ingest' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    const library = result.rules.rules.find((rule) => rule.id === 'library');
    expect(library?.path_prefixes).toEqual(['/3 resources/papers']);
    expect(result.rules.rules).toHaveLength(1);
  });

  test('a source-scoped edit splits a multi-source rule without changing the other source', () => {
    const otherSource = 'google_drive.personal';
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'shared-library',
        sources: [SOURCE, otherSource],
        path_prefixes: ['/3 Resources/Books'],
        reason: 'shared exclusion',
      }],
    }, 'fixture');
    const result = applySourceDispositionEdits(
      document,
      [{ path: '/3 Resources/Books', state: 'ingest' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(createSourceExclusionMatcher(result.rules, SOURCE, { enforceable: ENFORCEABLE })
      .evaluatePath('/3 Resources/Books/title.pdf').disposition).toBe('admit');
    expect(createSourceExclusionMatcher(result.rules, otherSource, { enforceable: ENFORCEABLE })
      .evaluatePath('/3 Resources/Books/title.pdf').disposition).toBe('exclude');
    expect(result.rules.rules[0]?.sources).toEqual([otherSource]);
  });

  test('a source-scoped edit splits a blanket rule away from every remaining source', () => {
    const otherSource = 'google_drive.personal';
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'blanket-library',
        sources: [],
        path_prefixes: ['/3 Resources/Books'],
        reason: 'blanket exclusion',
      }],
    }, 'fixture');
    const result = applySourceDispositionEdits(
      document,
      [{ path: '/3 Resources/Books', state: 'ingest' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(createSourceExclusionMatcher(result.rules, SOURCE, { enforceable: ENFORCEABLE })
      .evaluatePath('/3 Resources/Books/title.pdf').disposition).toBe('admit');
    expect(createSourceExclusionMatcher(result.rules, otherSource, { enforceable: ENFORCEABLE })
      .evaluatePath('/3 Resources/Books/title.pdf').disposition).toBe('exclude');
    const roundTrip = parseSourceIngestionExclusions(
      JSON.parse(JSON.stringify(result.rules)) as unknown,
      'round trip',
    );
    expect(roundTrip.rules[0]?.sources).toEqual(['*', `!${SOURCE}`]);
  });

  test('a rule whose last folder is removed is dropped rather than left criterion-free', () => {
    const result = applySourceDispositionEdits(
      fixtureDocument(),
      [{ path: '/2 Areas/Castor Workfiles', state: 'ingest' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    expect(result.rules.rules.some((rule) => rule.id === 'castor-workfiles')).toBe(false);
    // And the document still parses: a rule with no criterion at all is refused
    // by the parser, so a leftover empty rule would break the next boot.
    expect(() => parseSourceIngestionExclusions(JSON.parse(JSON.stringify(result.rules)) as unknown, 'x'))
      .not.toThrow();
  });

  test('a minted id is a legal receipt key and collides with nothing', () => {
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: '3-resources-books', sources: [SOURCE], path_prefixes: ['/elsewhere'], reason: 'x' }],
    }, 'fixture');
    const result = applySourceDispositionEdits(
      document,
      [{ path: '/3 Resources/Books', state: 'exclude' }],
      { source: SOURCE, enforceable: ENFORCEABLE },
    );
    const minted = result.applied[0]?.rule_id;
    expect(minted).toBe('3-resources-books-2');
    expect(() => parseSourceIngestionExclusions(JSON.parse(JSON.stringify(result.rules)) as unknown, 'x'))
      .not.toThrow();
  });

  test('a very long path keeps its distinguishing tail rather than its shared head', () => {
    const shared = '/a very long shared ancestor folder name that repeats everywhere/second level also long';
    const left = sourceDispositionRuleId(`${shared}/alpha`);
    const right = sourceDispositionRuleId(`${shared}/beta`);
    expect(left).not.toBe(right);
    expect(left.length).toBeLessThanOrEqual(64);
    expect(left.endsWith('alpha')).toBe(true);
  });
});

// --- Media rules ------------------------------------------------------------

describe('media rules are read-only beside the tree', () => {
  test('a media rule is listed as a non-folder rule and owns no node', () => {
    const rules = sourceDispositionNonFolderRules(fixtureDocument(), SOURCE);
    expect(rules).toEqual([
      expect.objectContaining({
        rule_id: 'oversized-video',
        kind: 'media',
        state: 'exclude',
        criterion: '.mp4, .mov · at least 100 MiB',
      }),
    ]);
    // No folder in the tree claims it.
    const tree = fixtureTree();
    const stack = [...tree.roots];
    while (stack.length > 0) {
      const node = stack.pop()!;
      expect(node.rule_id).not.toBe('oversized-video');
      stack.push(...node.children);
    }
  });

  test('a folder-identity rule is listed read-only too, not silently hidden', () => {
    const document = parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'by-identity',
        sources: [SOURCE],
        folder_ids: [{ id: 'abc123', name: 'Shared Drive' }],
        reason: 'named by identity',
      }],
    }, 'fixture');
    expect(sourceDispositionNonFolderRules(document, SOURCE)).toEqual([
      expect.objectContaining({ rule_id: 'by-identity', kind: 'folder_id', criterion: 'folder identity: Shared Drive' }),
    ]);
  });

});

// --- The config write -------------------------------------------------------

describe('atomic write and backup', () => {
  test('a save writes the file at 0600 and leaves a timestamped backup of the previous one', () => {
    const dir = tempDir('olympus-dispositions-write-');
    const path = join(dir, 'ingestion-exclusions.json');
    writeFileSync(path, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const before = readFileSync(path, 'utf8');

    const save = saveSourceDispositions(path, {
      source: SOURCE,
      enforceable: ENFORCEABLE,
      edits: [{ path: '/3 Resources/Books', state: 'exclude' }],
    });

    expect(save.noop).toBe(false);
    expect(save.write?.backup_path).toBeDefined();
    expect(readFileSync(save.write!.backup_path!, 'utf8')).toBe(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(save.write!.backup_path!).mode & 0o777).toBe(0o600);
    // The written file parses, which is what keeps the next boot from failing
    // closed on something a button produced.
    const reread = readSourceIngestionExclusionsFile(path);
    expect(reread.document.rules).toHaveLength(FIXTURE_RULES.rules.length + 1);
    expect(reread.document.schemaVersion).toBe(1);
  });

  test('untouched rules come back byte-identical, including fields this build ignores', () => {
    const dir = tempDir('olympus-dispositions-preserve-');
    const path = join(dir, 'ingestion-exclusions.json');
    const withExtra = structuredClone(FIXTURE_RULES) as {
      rules: Array<Record<string, unknown>>;
    };
    withExtra.rules[0]!.note_from_the_owner = 'do not lose this';
    writeFileSync(path, `${JSON.stringify(withExtra, null, 2)}\n`, { mode: 0o600 });

    saveSourceDispositions(path, {
      source: SOURCE,
      enforceable: ENFORCEABLE,
      edits: [{ path: '/3 Resources/Books', state: 'exclude' }],
    });

    const written = JSON.parse(readFileSync(path, 'utf8')) as { rules: Array<Record<string, unknown>> };
    const castor = written.rules.find((rule) => rule.id === 'castor-workfiles');
    expect(castor).toEqual(withExtra.rules[0]!);
  });

  test('a rule the edit changed is re-emitted rather than resurrected from the old bytes', () => {
    const dir = tempDir('olympus-dispositions-changed-');
    const path = join(dir, 'ingestion-exclusions.json');
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      rules: [{
        id: 'library',
        sources: [SOURCE],
        path_prefixes: ['/3 Resources/Books', '/3 Resources/Papers'],
        reason: 'another system curates these',
      }],
    }, null, 2)}\n`, { mode: 0o600 });

    saveSourceDispositions(path, {
      source: SOURCE,
      enforceable: ENFORCEABLE,
      edits: [{ path: '/3 Resources/Books', state: 'ingest' }],
    });

    const written = JSON.parse(readFileSync(path, 'utf8')) as { rules: Array<Record<string, unknown>> };
    expect(written.rules[0]?.path_prefixes).toEqual(['/3 resources/papers']);
    expect(written.rules[0]?.id).toBe('library');
  });

  test('a save that changes nothing writes nothing and leaves no backup behind', () => {
    const dir = tempDir('olympus-dispositions-noop-');
    const path = join(dir, 'ingestion-exclusions.json');
    writeFileSync(path, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const before = readFileSync(path, 'utf8');

    const save = saveSourceDispositions(path, {
      source: SOURCE,
      enforceable: ENFORCEABLE,
      edits: [{ path: '/2 Areas/Castor Workfiles/deep', state: 'exclude' }],
    });

    expect(save.noop).toBe(true);
    expect(save.write).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['ingestion-exclusions.json']);
  });

  test('a first save with no file yet creates one and makes no backup', () => {
    const dir = tempDir('olympus-dispositions-first-');
    const path = join(dir, 'nested', 'ingestion-exclusions.json');
    const save = saveSourceDispositions(path, {
      source: SOURCE,
      enforceable: ENFORCEABLE,
      edits: [{ path: '/3 Resources/Books', state: 'exclude' }],
    });
    expect(save.write?.backup_path).toBeUndefined();
    expect(existsSync(path)).toBe(true);
    expect(readSourceIngestionExclusionsFile(path).document.rules).toHaveLength(1);
  });

  test('a symlink at the rules path is refused rather than followed', () => {
    const dir = tempDir('olympus-dispositions-symlink-');
    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    writeFileSync(real, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    symlinkSync(real, link);
    expect(() => writeSourceIngestionExclusionsFile({ path: link, document: fixtureDocument() }))
      .toThrow('not a regular file');
  });

  test('schemaVersion stays 1 through a whole save', () => {
    const dir = tempDir('olympus-dispositions-schema-');
    const path = join(dir, 'ingestion-exclusions.json');
    writeFileSync(path, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    saveSourceDispositions(path, {
      source: SOURCE,
      enforceable: ENFORCEABLE,
      edits: [{ path: '/3 Resources/Books', state: 'exclude' }],
    });
    expect((JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number }).schemaVersion).toBe(1);
  });

  test('a submitted whole document is parsed before it can reach disk', () => {
    const dir = tempDir('olympus-dispositions-document-');
    const path = join(dir, 'ingestion-exclusions.json');
    writeFileSync(path, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    expect(() => saveSourceDispositions(path, { document: { schemaVersion: 2, rules: [] } }))
      .toThrow('schemaVersion must be 1');
    expect(() => saveSourceDispositions(path, {
      document: { schemaVersion: 1, rules: [{ id: 'bad', mode: 'nonsense', path_prefixes: ['/x'] }] },
    })).toThrow('mode must be one of');
    // The file is exactly as it was.
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FIXTURE_RULES);
  });
});

// --- The picker's controls --------------------------------------------------

// --- The rendered page ------------------------------------------------------

function fixtureSource(overrides: Partial<SourceDispositionsSource> = {}): SourceDispositionsSource {
  return {
    source_id: SOURCE,
    label: 'Fixture files',
    corpus_ids: [CORPUS_ID],
    enforceable: ENFORCEABLE,
    matcher: fixtureMatcher(),
    store_present: true,
    items: () => fixtureItems(),
    ...overrides,
  };
}

function fixtureView() {
  return buildSourceDispositionsView({
    sources: [fixtureSource()],
    document: fixtureDocument(),
    rulesPath: '/fixture/ingestion-exclusions.json',
    rulesPresent: true,
    now: new Date('2026-07-29T12:00:00.000Z'),
  });
}

// --- Over a real fixture store ---------------------------------------------

async function buildFixtureStore(dbPath: string): Promise<void> {
  // Built with NO gate, exactly like a store filled before the owner wrote any
  // rules. That is the state the picker is for.
  const store = new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await store.syncFromConnector(fixtureConnector(), { fetchContent: true });
  } finally {
    store.close();
  }
}

function fixtureConnector(): SourceConnector {
  const items: RawItem[] = FIXTURE_ITEMS.map((spec, index) => ({
    identity: {
      family: 'file' as const,
      provider: 'fixture',
      accountScope: 'personal',
      providerItemId: `item-${index}`,
      providerFileId: `item-${index}`,
      localItemId: `personal:item-${index}`,
      sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: spec.text === undefined
      ? { kind: 'metadata_only' as const }
      : { kind: 'text' as const, text: spec.text },
    metadata: Object.freeze({
      title: spec.path.split('/').pop() ?? spec.path,
      pathDisplay: spec.path,
      locatorUri: spec.path,
    }),
    fetchedAt: '2026-07-29T12:00:00.000Z',
  }));
  return {
    id: 'fixture',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(identity: { localItemId: string }) {
      const item = items.find((candidate) => candidate.identity.localItemId === identity.localItemId);
      if (!item) throw new Error('fixture item missing');
      return item;
    },
    classify: () => ({ trustDomain: 'secure_local' as const, trustTier: 'S3' as const }),
  } as unknown as SourceConnector;
}

describe('over a real connector store', () => {
  test('the tree the picker builds agrees with the store\'s own purge and strip counts', async () => {
    const dir = tempDir('olympus-dispositions-store-');
    const dbPath = join(dir, 'fixture-store.sqlite');
    await buildFixtureStore(dbPath);

    const store = new LocalConnectorStore({
      dbPath,
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      exclusions: fixtureMatcher(),
      readOnly: true,
    });
    try {
      const tree = buildSourceDispositionTree({
        matcher: store.exclusions,
        items: store.itemLocatorCensus(),
      });
      const purge = store.purgeExcludedItems({ dryRun: true });
      const strip = store.stripMetadataOnlyRepresentations({ dryRun: true });

      expect(tree.counts.items).toBe(purge.counts.items_scanned);
      expect(tree.counts.excluded_items_would_purge).toBe(purge.counts.items_would_remove);
      expect(tree.counts.metadata_only_content_would_strip).toBe(strip.counts.items_would_strip);
      expect(nodeAt(tree, '/2 areas/castor workfiles').counts.excluded_items).toBe(2);
    } finally {
      store.close();
    }
  });

});

// --- The way in from the dashboard and the walkthrough ----------------------

describe('the dashboard entry point', () => {
  const dashboardOptions = (available: boolean, rules = 0) => ({
    sourceIndexStatus: {
      kind: 'source_index_status' as const,
      generated_at: '2026-07-29T12:00:00.000Z',
      corpora: [],
      policy: {
        read_only: true,
        raw_source_exposed: false,
        source_packets_exposed: false,
        source_text_returned: false,
        secure_local_item_metadata_exposed: false,
        castor_visible: true,
      },
    } as never,
    sovereigntyEngine: { config: { routes: {} } } as never,
    ingestionDispositionsAvailable: available,
    ...(rules > 0
      ? {
        ingestionLedger: {
          rows: [],
          excluded_by_configuration: {
            rules,
            prefixes: rules,
            metadata_only_rules: 0,
            metadata_only_prefixes: 0,
            items_metadata_only_content_present: 0,
            items_present: 0,
            items_unevaluable: 0,
            entries: [],
          },
        } as never,
      }
      : {}),
    now: new Date('2026-07-29T12:00:00.000Z'),
  });

  test('the walkthrough carries a folder step, and the view model offers a way in', async () => {
    const { buildSourceDashboardViewModel } = await import('../src/workers/source-dashboard.ts');
    const view = buildSourceDashboardViewModel(dashboardOptions(true));
    expect(view.folder_picker).toEqual({
      available: true,
      label: 'Choose what gets ingested',
      path: '/dashboard/dispositions',
      rules: 0,
    });
    expect(view.onboarding.steps.map((step) => step.id)).toEqual([
      'security_preset',
      'dependencies',
      'credential_or_pairing',
      'scope',
      'initial_sync',
      'source_health',
      'cited_answer_readiness',
    ]);
    // Exactly one step is active, still.
    expect(view.onboarding.steps.filter((step) => step.state === 'active')).toHaveLength(1);
  });

  test('the folder step reads complete once the owner has written a rule', async () => {
    const { buildSourceDashboardViewModel } = await import('../src/workers/source-dashboard.ts');
    const view = buildSourceDashboardViewModel(dashboardOptions(true, 4));
    expect(view.folder_picker.rules).toBe(4);
    expect(view.onboarding.steps.find((step) => step.id === 'scope')?.state).toBe('complete');
  });

  test('a worker without the picker says so rather than offering a button that 501s', async () => {
    const { buildSourceDashboardViewModel } = await import('../src/workers/source-dashboard.ts');
    const view = buildSourceDashboardViewModel(dashboardOptions(false));
    expect(view.folder_picker.available).toBe(false);
  });

  test('the counts-only dashboard view model still carries no folder path', async () => {
    const { buildSourceDashboardViewModel } = await import('../src/workers/source-dashboard.ts');
    const view = buildSourceDashboardViewModel(dashboardOptions(true, 4));
    expect(view.policy.file_paths_returned).toBe(false);
    expect(JSON.stringify(view)).not.toContain('/2 Areas');
    expect(JSON.stringify(view)).not.toContain('/2 areas');
  });
});

// --- The worker routes ------------------------------------------------------

function dispositionsWorker(rulesPath: string) {
  return createEmailSourceWorker({
    sourceIndexStatus: {
      async status() {
        return {
          kind: 'source_index_status',
          generated_at: '2026-07-29T12:00:00.000Z',
          corpora: [],
          policy: {
            read_only: true,
            raw_source_exposed: false,
            source_packets_exposed: false,
            source_text_returned: false,
            secure_local_item_metadata_exposed: false,
            castor_visible: true,
          },
        } as never;
      },
    },
    sourceDashboard: {
      sovereigntyEngine: { config: { routes: {} } } as never,
      registryPath: join(tempDir('olympus-dispositions-registry-'), 'handles.json'),
      ingestionDispositions: () => ({
        rulesPath,
        sources: [fixtureSource()],
      }),
    },
  });
}

describe('worker routes', () => {
  test('the picker routes need the worker bearer token, not the dashboard URL token', async () => {
    const dir = tempDir('olympus-dispositions-route-');
    const rulesPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(rulesPath, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const fetch = withWorkerBearerAuth(dispositionsWorker(rulesPath).fetch, { authToken: 'worker-secret' });

    expect((await fetch(new Request('http://worker.test/dashboard/dispositions'))).status).toBe(401);
    // The dash_ query token opens the counts-only dashboard and nothing else.
    const { dashboardQueryTokenFromWorkerAuthToken } = await import('../src/core/worker-auth.ts');
    const dashToken = dashboardQueryTokenFromWorkerAuthToken('worker-secret');
    expect((await fetch(new Request(`http://worker.test/dashboard/dispositions?token=${dashToken}`))).status)
      .toBe(401);
  });

  test('the old picker page and its JSON read are gone', async () => {
    const dir = tempDir('olympus-dispositions-read-');
    const rulesPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(rulesPath, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const fetch = withWorkerBearerAuth(dispositionsWorker(rulesPath).fetch, { authToken: 'worker-secret' });
    const headers = { Authorization: 'Bearer worker-secret' };

    // Unified dashboard phase 4: folders are chosen in the panel; no page renders here.
    const page = await fetch(new Request('http://worker.test/dashboard/dispositions', { headers }));
    expect(page.status).toBe(404);

    // Nor does the picker's old JSON read: the panel's pickers read in process.
    const model = await fetch(new Request('http://worker.test/dashboard/dispositions.json', { headers }));
    expect(model.status).toBe(404);
  });

  test('the dashboard control session saves without persisting the bearer', async () => {
    const dir = tempDir('olympus-dispositions-session-route-');
    const rulesPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(rulesPath, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const fetch = withWorkerBearerAuth(dispositionsWorker(rulesPath).fetch, { authToken: 'worker-secret' });
    const origin = 'http://worker.test';

    const mint = await fetch(new Request(`${origin}/dashboard/control/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', Origin: origin },
    }));
    expect(mint.status).toBe(200);
    const cookie = mint.headers.get('Set-Cookie')!.split(';')[0]!;
    const control = await mint.json() as { csrf_token: string };

    const saved = await fetch(new Request(`${origin}/dashboard/dispositions`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-Olympus-CSRF': control.csrf_token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: SOURCE, edits: [{ path: '/3 Resources/Books', state: 'exclude' }] }),
    }));
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({ ok: true, result: { changed: true } });
  });

  test('write applies the edit, backs the old file up, and reports refusals', async () => {
    const dir = tempDir('olympus-dispositions-write-route-');
    const rulesPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(rulesPath, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const fetch = withWorkerBearerAuth(dispositionsWorker(rulesPath).fetch, { authToken: 'worker-secret' });
    const headers = { Authorization: 'Bearer worker-secret', 'Content-Type': 'application/json' };

    const applied = await fetch(new Request('http://worker.test/dashboard/dispositions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ source: SOURCE, edits: [{ path: '/3 Resources/Books', state: 'exclude' }] }),
    }));
    const body = await applied.json() as {
      ok: boolean;
      result: { changed: boolean; write: { backup_path?: string }; untouched_rule_ids: string[] };
      policy: Record<string, boolean>;
    };
    expect(applied.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.result.changed).toBe(true);
    expect(body.result.write.backup_path).toBeDefined();
    expect(body.result.untouched_rule_ids).toContain('castor-workfiles');
    expect(body.policy).toEqual({
      writes_config_only: true,
      deletes_store_content: false,
      runs_purge_or_strip: false,
    });
    const written = readSourceIngestionExclusionsFile(rulesPath);
    expect(written.document.rules).toHaveLength(FIXTURE_RULES.rules.length + 1);

    const refusedResponse = await fetch(new Request('http://worker.test/dashboard/dispositions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: SOURCE,
        edits: [{ path: '/2 Areas/Castor Workfiles/deep', state: 'ingest' }],
      }),
    }));
    const refusedBody = await refusedResponse.json() as { result: { refused: Array<{ code: string }> } };
    expect(refusedResponse.status).toBe(200);
    expect(refusedBody.result.refused[0]?.code).toBe('inherited_state_not_editable');
  });

  test('a save naming a source this worker does not serve is refused', async () => {
    const dir = tempDir('olympus-dispositions-unknown-source-');
    const rulesPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(rulesPath, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const fetch = withWorkerBearerAuth(dispositionsWorker(rulesPath).fetch, { authToken: 'worker-secret' });

    const response = await fetch(new Request('http://worker.test/dashboard/dispositions', {
      method: 'POST',
      headers: { Authorization: 'Bearer worker-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'not.a.source', edits: [{ path: '/x', state: 'exclude' }] }),
    }));
    expect(response.status).toBe(400);
    expect(JSON.parse(readFileSync(rulesPath, 'utf8'))).toEqual(FIXTURE_RULES);
  });

  test('a malformed edit is refused before anything is written', async () => {
    const dir = tempDir('olympus-dispositions-malformed-');
    const rulesPath = join(dir, 'ingestion-exclusions.json');
    writeFileSync(rulesPath, `${JSON.stringify(FIXTURE_RULES, null, 2)}\n`, { mode: 0o600 });
    const fetch = withWorkerBearerAuth(dispositionsWorker(rulesPath).fetch, { authToken: 'worker-secret' });

    for (const body of [
      { source: SOURCE, edits: [{ path: '/x', state: 'delete_everything' }] },
      { source: SOURCE, edits: [{ state: 'exclude' }] },
      { source: SOURCE, edits: 'not an array' },
      { source: SOURCE },
    ]) {
      const response = await fetch(new Request('http://worker.test/dashboard/dispositions', {
        method: 'POST',
        headers: { Authorization: 'Bearer worker-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(400);
    }
    expect(JSON.parse(readFileSync(rulesPath, 'utf8'))).toEqual(FIXTURE_RULES);
  });
});
