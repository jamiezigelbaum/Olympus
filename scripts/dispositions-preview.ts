// Local design-iteration harness for the ingestion-dispositions folder picker.
//
// Builds a throwaway connector store from a fixture folder layout, points the
// real gate at a fixture rules document, and renders the real page — so the
// picker can be audited in a browser, or captured as a snapshot, without a live
// worker, a real store, or any of the owner's folders.
//
//   bun scripts/dispositions-preview.ts                    # http://127.0.0.1:8931
//   bun scripts/dispositions-preview.ts --out picker.html  # write a snapshot and exit
//
// Never used in production; carries no secrets and reads nothing of the
// owner's. The fixture paths below are invented.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  createSourceExclusionMatcher,
  parseSourceIngestionExclusions,
} from '../src/core/source-ingestion-exclusions.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  buildSourceDispositionsView,
  renderSourceDispositionsHtml,
} from '../src/workers/source-dispositions.ts';

const SOURCE = 'files.personal';
const CORPUS_ID = 'secure_local.files.preview';
const ENFORCEABLE = ['path_prefix', 'media'] as const;

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
      id: 'family-media-archive',
      sources: [SOURCE],
      path_prefixes: ['/2 Areas/Family & Friends/Family Media Archive'],
      reason: 'large media set, not for personal search',
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
      id: 'archived-projects',
      mode: 'metadata_only',
      sources: [SOURCE],
      path_prefixes: ['/4 Archive/1 Archived Projects'],
      reason: 'index titles and dates, never read the contents',
    },
    {
      id: 'oversized-video',
      media: {
        extensions: ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.mts'],
        min_bytes: 104857600,
      },
      reason: 'video over 100 MiB is never worth extracting',
    },
  ],
};

// Enough shape to exercise every state the page can render: explicit exclude,
// inherited exclude, explicit metadata-only, inherited metadata-only, a mixed
// parent, and folders no rule touches.
const FIXTURE_PATHS: ReadonlyArray<{ path: string; text?: string }> = [
  { path: '/1 Projects/Website Rebuild/brief.md', text: 'project brief' },
  { path: '/1 Projects/Website Rebuild/notes/kickoff.md', text: 'kickoff notes' },
  { path: '/1 Projects/Moving House/checklist.md', text: 'checklist' },
  { path: '/2 Areas/Castor Workfiles/handbook.md', text: 'another system owns this' },
  { path: '/2 Areas/Castor Workfiles/decisions/2026.md', text: 'nested under the exclusion' },
  { path: '/2 Areas/Finances/2026/taxes.pdf', text: 'kept in full' },
  { path: '/2 Areas/Finances/receipts.csv', text: 'kept in full' },
  { path: '/2 Areas/Family & Friends/Family Media Archive/reunion.mp4' },
  { path: '/2 Areas/Family & Friends/Family Media Archive/2019/beach.mov' },
  { path: '/2 Areas/Family & Friends/Letters/grandmother.md', text: 'kept in full' },
  { path: '/2 Areas/Health/labs 2026.pdf', text: 'kept in full' },
  { path: '/3 Resources/Spirituality/retreat notes.md', text: 'content a rule forbids' },
  { path: '/3 Resources/Spirituality/Readings/psalms.md', text: 'nested content a rule forbids' },
  { path: '/3 Resources/Books/reading list.md', text: 'no rule covers this' },
  { path: '/3 Resources/Books/Technical/distributed systems.md', text: 'no rule covers this' },
  { path: '/4 Archive/1 Archived Projects/2021 rebrand.md', text: 'archived project' },
  { path: '/4 Archive/2 Inactive Areas/old lease.pdf', text: 'inactive area' },
  { path: '/4 Archive/4 Archived Backups/disk-2020.img' },
  { path: '/4 Archive/4 Archived Backups/disk-2021.img' },
];

function fixtureConnector(): SourceConnector {
  const items: RawItem[] = FIXTURE_PATHS.map((spec, index) => ({
    identity: {
      family: 'file' as const,
      provider: 'preview',
      accountScope: 'personal',
      providerItemId: `item-${index}`,
      providerFileId: `item-${index}`,
      localItemId: `personal:item-${index}`,
      sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    // An empty body is how a fixture item ends up with an item row and no
    // chunks — the state a store is in for a file whose content was never
    // extracted, which is exactly what the picker's "still holding content"
    // counts have to distinguish.
    content: { kind: 'text' as const, text: spec.text ?? '' },
    metadata: Object.freeze({
      title: spec.path.split('/').pop() ?? spec.path,
      pathDisplay: spec.path,
      locatorUri: spec.path,
    }),
    fetchedAt: '2026-07-29T12:00:00.000Z',
  }));
  return {
    id: 'preview',
    family: 'file',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(identity: { localItemId: string }) {
      const item = items.find((candidate) => candidate.identity.localItemId === identity.localItemId);
      if (!item) throw new Error('preview fixture item missing');
      return item;
    },
    classify: () => ({ trustDomain: 'secure_local' as const, trustTier: 'S3' as const }),
  } as unknown as SourceConnector;
}

async function renderPreview(): Promise<{ html: string; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-dispositions-preview-'));
  const dbPath = join(dir, 'preview-store.sqlite');
  // Filled with NO gate, exactly like a store that was synced before the owner
  // wrote any rules. That is the state the picker exists for.
  const seed = new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
  });
  try {
    await seed.syncFromConnector(fixtureConnector(), { fetchContent: true });
  } finally {
    seed.close();
  }
  const document = parseSourceIngestionExclusions(FIXTURE_RULES, 'preview fixture');
  const matcher = createSourceExclusionMatcher(document, SOURCE, { enforceable: ENFORCEABLE });
  const store = new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    exclusions: matcher,
    readOnly: true,
  });
  try {
    const view = buildSourceDispositionsView({
      sources: [{
        source_id: SOURCE,
        label: 'Fixture file source',
        corpus_ids: [CORPUS_ID],
        enforceable: ENFORCEABLE,
        matcher: store.exclusions,
        store_present: true,
        items: () => store.itemLocatorCensus(),
      }],
      document,
      rulesPath: '~/.olympus/sources/ingestion-exclusions.json',
      rulesPresent: true,
      now: new Date('2026-07-29T12:00:00.000Z'),
    });
    return {
      html: renderSourceDispositionsHtml(view),
      dispose: () => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const outFlag = process.argv.indexOf('--out');
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;
if (outFlag >= 0 && !outPath) throw new Error('--out requires a path.');

const preview = await renderPreview();
if (outPath) {
  writeFileSync(outPath, preview.html, 'utf8');
  preview.dispose();
  console.log(`wrote ${preview.html.length} bytes to ${outPath}`);
} else {
  const port = Number(process.env.DISPOSITIONS_PREVIEW_PORT ?? 8931);
  Bun.serve({
    port,
    fetch: () => new Response(preview.html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });
  console.log(`dispositions picker preview listening on http://127.0.0.1:${port}`);
}
