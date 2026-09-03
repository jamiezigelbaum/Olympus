// Drive folder exclusions: the criterion, the ancestry walk, and the direction
// fail-closed points in each operation.
//
// The defect these pin down is not "Drive exclusions were missing". It is that
// Drive exclusions SILENTLY MATCHED NOTHING: the connector published a
// synthetic `parentFolderId/Title` string under `pathDisplay`, the gate read it
// as a path, no human-written prefix could ever match it, and every Drive item
// came back "admitted". Nothing failed, nothing was reported, and the folders
// the owner marked kept being ingested.
//
// So the assertions below are mostly about the NEGATIVE space — what the gate
// does when it cannot answer — because that is where the silence lived.

import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  createSourceExclusionMatcher,
  parseSourceIngestionExclusions,
  sourceExclusionDescendantPrefixes,
} from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
  GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GoogleDriveFolderAncestry,
  type GoogleDriveApiClient,
  type GoogleDriveFolder,
} from '../src/workers/google-connectors/index.ts';

const ACCOUNT = 'personal';
const EXPERT_FOLDER_ID = 'folder-expert-corpus';
const EXPERT_FOLDER_NAME = 'Expert Agents/Governance Library';

/**
 * A Drive folder graph as parent-id lists, which is all an ancestry walk reads.
 * `bookshelf` is deliberately a SIBLING of the excluded folder with a
 * confusable name: the identity criterion must not care about names at all, and
 * this is what proves it does not.
 */
const FOLDER_GRAPH: Record<string, GoogleDriveFolder> = {
  root: { id: 'root' },
  [EXPERT_FOLDER_ID]: { id: EXPERT_FOLDER_ID, name: 'Governance Library', parents: ['root'] },
  'folder-nested': { id: 'folder-nested', name: 'Statutes', parents: [EXPERT_FOLDER_ID] },
  'folder-deep': { id: 'folder-deep', name: '1996', parents: ['folder-nested'] },
  'folder-bookshelf': { id: 'folder-bookshelf', name: 'Governance Libraries', parents: ['root'] },
  'folder-shared': { id: 'folder-shared', name: 'Shared Drafts', parents: ['root'] },
};

function folderClient(overrides: Partial<GoogleDriveApiClient> = {}): GoogleDriveApiClient {
  return {
    async listFiles() {
      return { files: [] };
    },
    async exportGoogleDocText() {
      return '';
    },
    async downloadTextFile() {
      return '';
    },
    async downloadFileBytes() {
      return { bytes: new Uint8Array(), sizeBytes: 0 };
    },
    async getFolder(folderId: string) {
      const folder = FOLDER_GRAPH[folderId];
      if (!folder) throw new Error(`no such folder ${folderId}`);
      return folder;
    },
    ...overrides,
  };
}

function driveExclusions(rules: unknown[]) {
  return createSourceExclusionMatcher(
    parseSourceIngestionExclusions({ schemaVersion: 1, rules }),
    GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
    { enforceable: GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA },
  );
}

function expertCorpusRule() {
  return {
    id: 'expert-agent-corpora',
    sources: [GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE],
    reason: 'curated for the Vertex expert agents',
    folder_ids: [{ id: EXPERT_FOLDER_ID, name: EXPERT_FOLDER_NAME }],
  };
}

/**
 * A Drive item as the connector now publishes it: a locator URL, no path, and
 * an ancestry array present exactly when the walk succeeded.
 */
function driveItem(
  id: string,
  options: { ancestry?: string[]; unresolved?: boolean } = {},
): RawItem {
  return {
    identity: {
      family: 'file',
      provider: 'google_drive',
      accountScope: ACCOUNT,
      providerItemId: id,
      providerFileId: id,
      localItemId: `${ACCOUNT}:${id}`,
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: 'body text' },
    metadata: Object.freeze({
      title: `${id}.txt`,
      name: `${id}.txt`,
      locatorUri: `https://drive.google.com/file/d/${id}/view`,
      ...(options.unresolved ? {} : { folderAncestorIds: options.ancestry ?? [] }),
    }),
    fetchedAt: '2026-07-28T12:00:00.000Z',
  };
}

function driveConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'google_drive',
    family: 'file',
    async authenticate() {},
    async *listItems(): AsyncIterable<SourceConnectorListPage> {
      yield { items: [...items], done: true };
    },
    async fetchItem(localItemId: string) {
      const item = items.find((candidate) => candidate.identity.localItemId === localItemId);
      if (!item) throw new Error('unknown item');
      return item;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S3', trustDomain: 'internal' });
    },
  };
}

function driveStore(exclusions: ReturnType<typeof driveExclusions>): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    family: 'file',
    trustDomain: 'internal',
    exclusions,
  });
}

describe('Drive folder-identity exclusions', () => {
  test('an item beneath an excluded folder is never admitted, at any depth', async () => {
    const store = driveStore(driveExclusions([expertCorpusRule()]));
    try {
      const result = await store.syncFromConnector(driveConnector([
        driveItem('direct-child', { ancestry: [EXPERT_FOLDER_ID, 'root'] }),
        driveItem('two-deep', { ancestry: ['folder-nested', EXPERT_FOLDER_ID, 'root'] }),
        driveItem('three-deep', { ancestry: ['folder-deep', 'folder-nested', EXPERT_FOLDER_ID, 'root'] }),
      ]), { fetchContent: false });

      expect(result.itemsIndexed).toBe(0);
      expect(result.exclusions?.items_excluded).toBe(3);
      expect(store.searchItems('body', 10)).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('a sibling folder with a confusable name is not caught', async () => {
    // The identity criterion never reads a name, so "Governance Libraries"
    // beside "Governance Library" is simply a different id. This is the
    // property a prefix match has to work for and an id match gets for free.
    const store = driveStore(driveExclusions([expertCorpusRule()]));
    try {
      const result = await store.syncFromConnector(driveConnector([
        driveItem('sibling-file', { ancestry: ['folder-bookshelf', 'root'] }),
      ]), { fetchContent: false });

      expect(result.itemsIndexed).toBe(1);
      expect(result.exclusions?.items_excluded).toBe(0);
    } finally {
      store.close();
    }
  });

  test('unresolvable ancestry is EXCLUDED at ingestion and reported, never admitted', async () => {
    // The whole point. An item whose ancestry could not be walked is refused,
    // and it lands in a DISTINCT counter so the owner can tell "your rule
    // matched three files" from "three files could not be judged".
    const store = driveStore(driveExclusions([expertCorpusRule()]));
    try {
      const result = await store.syncFromConnector(driveConnector([
        driveItem('walk-failed', { unresolved: true }),
        driveItem('ordinary', { ancestry: ['folder-shared', 'root'] }),
      ]), { fetchContent: false });

      expect(result.itemsIndexed).toBe(1);
      expect(result.exclusions?.items_excluded).toBe(1);
      expect(result.exclusions?.items_excluded_unevaluable).toBe(1);
    } finally {
      store.close();
    }
  });

  test('a file reachable through an excluded folder is excluded even when another parent is ordinary', async () => {
    // Multi-parent Drive files: reachability is sufficient. Requiring EVERY
    // path to be excluded would let one extra parent anywhere in the graph
    // re-admit the file, which is an override channel by another name.
    const store = driveStore(driveExclusions([expertCorpusRule()]));
    try {
      const result = await store.syncFromConnector(driveConnector([
        driveItem('two-parents', { ancestry: ['folder-shared', EXPERT_FOLDER_ID, 'root'] }),
      ]), { fetchContent: false });

      expect(result.itemsIndexed).toBe(0);
      expect(result.exclusions?.items_excluded).toBe(1);
    } finally {
      store.close();
    }
  });

  test('the purge keeps Drive rows it cannot judge, reports them, and lists every rule', () => {
    // Direction flips here. A stored row keeps its locator, not its ancestry,
    // so the gate genuinely cannot say whether it sat under an excluded
    // folder — and deleting on that is destroying data on a guess. The dry run
    // reports the rule at zero rather than omitting it, because "spelled
    // wrong" and "matched nothing" must not look the same.
    const store = driveStore(driveExclusions([expertCorpusRule()]));
    try {
      const summary = store.purgeExcludedItems({ dryRun: true });

      expect(summary.dry_run).toBe(true);
      expect(summary.corpus_id).toBe(GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID);
      expect(summary.counts.items_would_remove).toBe(0);
      expect(summary.by_prefix).toEqual([{
        rule_id: 'expert-agent-corpora',
        prefix: `folder:${EXPERT_FOLDER_NAME} (${EXPERT_FOLDER_ID})`,
        reason: 'curated for the Vertex expert agents',
        items: 0,
      }]);
    } finally {
      store.close();
    }
  });

  test('a stored row is kept rather than deleted when only identity rules are configured', async () => {
    const permissive = driveStore(driveExclusions([expertCorpusRule()]));
    try {
      // Land one ordinary row, then re-read it through the purge. Its locator
      // is a webViewLink, which can answer nothing about folder ancestry.
      await permissive.syncFromConnector(driveConnector([
        driveItem('ordinary', { ancestry: ['folder-shared', 'root'] }),
      ]), { fetchContent: false });

      const summary = permissive.purgeExcludedItems({ dryRun: true });
      expect(summary.counts.items_scanned).toBe(1);
      expect(summary.counts.items_would_remove).toBe(0);
      expect(summary.counts.items_unevaluable_kept).toBe(1);
    } finally {
      permissive.close();
    }
  });

  test('a rule that names Drive but carries only path prefixes is refused, not ignored', () => {
    // The anti-silence gate. Drive publishes no folder path, so this rule could
    // only ever match nothing. It is rejected when the matcher is built —
    // before any file is read — with a message that says what to write instead.
    expect(() => driveExclusions([{
      id: 'expert-agent-corpora',
      sources: [GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE],
      path_prefixes: ['/Expert Agents/Governance Library'],
      reason: 'curated elsewhere',
    }])).toThrow(/cannot enforce path prefixes/);
  });

  test('one rule may serve a path source and an identity source at once', () => {
    // One config concept: the owner writes the decision once, with one rule id
    // and one reason, and names it the way each provider can answer.
    const shared = [{
      id: 'expert-agent-corpora',
      sources: ['dropbox.personal', GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE],
      reason: 'curated for the Vertex expert agents',
      path_prefixes: ['/3 Resources/Books'],
      folder_ids: [{ id: EXPERT_FOLDER_ID, name: EXPERT_FOLDER_NAME }],
    }];
    const parsed = parseSourceIngestionExclusions({ schemaVersion: 1, rules: shared });

    const drive = createSourceExclusionMatcher(parsed, GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE, {
      enforceable: GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
    });
    const dropbox = createSourceExclusionMatcher(parsed, 'dropbox.personal', {
      enforceable: ['path_prefix'],
    });

    expect(drive.identityActive).toBe(true);
    expect(dropbox.pathActive).toBe(true);
    expect(dropbox.evaluatePath('/3 Resources/Books/x.pdf').excluded).toBe(true);
    // The Dropbox fence handed to older LIKE-matching lanes never grows a
    // fabricated prefix for the identity half.
    expect(sourceExclusionDescendantPrefixes(dropbox)).toEqual(['/3 resources/books/']);
    expect(sourceExclusionDescendantPrefixes(drive)).toEqual([]);
  });

  test('a blanket rule Drive cannot enforce is reported by id rather than silently ignored', () => {
    // The remaining silent-admission route, closed by reporting rather than by
    // refusal. A rule naming NO source was never asserted to fit Drive, so
    // taking the lane down over it would be disproportionate — but the owner
    // still believes that folder is excluded everywhere, and it is not. The
    // rule id reaches the ledger so they can scope it.
    const matcher = driveExclusions([{
      id: 'blanket-books',
      path_prefixes: ['/3 Resources/Books'],
      reason: 'curated elsewhere',
    }]);

    expect(matcher.active).toBe(false);
    expect(matcher.unenforceableRuleIds).toEqual(['blanket-books']);
    // Critically, it does NOT compile the prefix into Drive's gate: doing that
    // would make every Drive item unevaluable and exclude the entire corpus on
    // the strength of a line written for Dropbox.
    expect(matcher.criteria).toEqual([]);
  });

  test('an unscoped rule cannot carry folder ids', () => {
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'expert-agent-corpora',
        reason: 'curated elsewhere',
        folder_ids: [{ id: EXPERT_FOLDER_ID, name: EXPERT_FOLDER_NAME }],
      }],
    })).toThrow(/requires/);
  });

  test('a folder id without a name is refused, so the file stays reviewable', () => {
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{
        id: 'expert-agent-corpora',
        sources: [GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE],
        folder_ids: [{ id: EXPERT_FOLDER_ID }],
      }],
    })).toThrow(/name must be a non-empty string/);
  });

  test('a rule that names no folder at all is refused', () => {
    expect(() => parseSourceIngestionExclusions({
      schemaVersion: 1,
      rules: [{ id: 'empty-rule', sources: ['dropbox.personal'], reason: 'nothing' }],
    })).toThrow(/at least one folder/);
  });
});

describe('Drive folder ancestry walk', () => {
  test('collects every ancestor to the root, not just the immediate parent', async () => {
    const ancestry = new GoogleDriveFolderAncestry(folderClient());
    const resolved = await ancestry.resolve({ parents: ['folder-deep'] });

    expect(resolved?.sort()).toEqual(['folder-deep', 'folder-nested', EXPERT_FOLDER_ID, 'root'].sort());
    expect(ancestry.unresolvedCount).toBe(0);
  });

  test('unions all parents of a multi-parent file', async () => {
    const ancestry = new GoogleDriveFolderAncestry(folderClient());
    const resolved = await ancestry.resolve({ parents: ['folder-nested', 'folder-shared'] });

    expect(new Set(resolved)).toEqual(new Set([
      'folder-nested', EXPERT_FOLDER_ID, 'root', 'folder-shared',
    ]));
  });

  test('a failed lookup yields undefined, never a partial ancestry', async () => {
    // A partial ancestry that stops short of the excluded folder is
    // indistinguishable from a clean one. Returning it would be the silent
    // admission this whole change removes.
    const ancestry = new GoogleDriveFolderAncestry(folderClient({
      async getFolder(folderId: string) {
        if (folderId === EXPERT_FOLDER_ID) throw new Error('403');
        const folder = FOLDER_GRAPH[folderId];
        if (!folder) throw new Error('404');
        return folder;
      },
    }));

    expect(await ancestry.resolve({ parents: ['folder-nested'] })).toBeUndefined();
    expect(ancestry.unresolvedCount).toBe(1);
  });

  test('a client that cannot walk folders resolves nothing rather than everything', async () => {
    const client = folderClient();
    delete (client as { getFolder?: unknown }).getFolder;
    const ancestry = new GoogleDriveFolderAncestry(client);

    expect(await ancestry.resolve({ parents: ['folder-nested'] })).toBeUndefined();
  });

  test('a file the provider reports with no parents resolves to an empty ancestry', async () => {
    // Resolved-and-empty, not unresolved. The provider answered; the answer was
    // "under none of your folders". That is the shared-with-me case, and
    // excluding every such file would be over-exclusion on no evidence.
    const ancestry = new GoogleDriveFolderAncestry(folderClient());

    expect(await ancestry.resolve({})).toEqual([]);
    expect(ancestry.unresolvedCount).toBe(0);
  });

  test('a parent cycle terminates instead of walking forever', async () => {
    const ancestry = new GoogleDriveFolderAncestry(folderClient({
      async getFolder(folderId: string) {
        return folderId === 'a'
          ? { id: 'a', parents: ['b'] }
          : { id: 'b', parents: ['a'] };
      },
    }));

    expect(new Set(await ancestry.resolve({ parents: ['a'] }))).toEqual(new Set(['a', 'b']));
  });

  test('one folder is fetched once however many files sit under it', async () => {
    let lookups = 0;
    const ancestry = new GoogleDriveFolderAncestry(folderClient({
      async getFolder(folderId: string) {
        lookups += 1;
        const folder = FOLDER_GRAPH[folderId];
        if (!folder) throw new Error('404');
        return folder;
      },
    }));

    await ancestry.resolve({ parents: ['folder-deep'] });
    const afterFirst = lookups;
    await ancestry.resolve({ parents: ['folder-deep'] });

    expect(afterFirst).toBe(4);
    expect(lookups).toBe(afterFirst);
  });
});
