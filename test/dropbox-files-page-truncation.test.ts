import { describe, expect, test } from 'bun:test';
import {
  createDropboxSourceConnector,
  type DropboxMetadataClient,
  type DropboxMetadataContinueRequest,
  type DropboxMetadataEntry,
  type DropboxMetadataListRequest,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';

const APPROVED_SCOPE = 'dropbox.personal:/Root';
const ROOT_FOLDER_PATH = '/Root';

/**
 * Dropbox documents `limit` as approximate, and `/files/list_folder/continue`
 * takes no limit at all. The canonical SourceConnector therefore owns a cursor
 * inside a replayable provider page when a bounded pull stops mid-page.
 */
describe('Dropbox SourceConnector never checkpoints past a page tail it dropped', () => {
  test('replays the pre-page provider cursor and resumes at the exact intra-page offset', async () => {
    const calls: string[] = [];
    const connector = createDropboxSourceConnector({
      account: 'personal',
      approvedScopeKey: APPROVED_SCOPE,
      metadataClient: overLimitCursorClient(calls),
    });

    const first = await collectPages(connector.listItems({ limit: 4 }));
    expect(first.flatMap((page) => page.items.map((item) => item.identity.providerItemId)))
      .toEqual(['id:one', 'id:two', 'id:three', 'id:four']);
    expect(first.at(-1)).toMatchObject({ done: false, truncated: true });
    const checkpoint = first.at(-1)?.nextCursor;
    expect(checkpoint).toStartWith('dbxp1:');

    const resumed = await collectPages(connector.listItems({ cursor: checkpoint!, limit: 4 }));
    expect(resumed.flatMap((page) => page.items.map((item) => item.identity.providerItemId)))
      .toEqual(['id:five']);
    expect(resumed.at(-1)?.done).toBe(true);
    expect(calls).toEqual([
      'list:/Root:4',
      'continue:cursor-page-1:4',
      'continue:cursor-page-1:4',
    ]);
  });

  test('restarts a changed replayed page at zero and emits only the bounded restart signal', async () => {
    let page: DropboxMetadataPage = {
      entries: [fileEntry('one'), fileEntry('two'), fileEntry('three')],
      hasMore: false,
    };
    let restarts = 0;
    const connector = createDropboxSourceConnector({
      account: 'personal',
      approvedScopeKey: APPROVED_SCOPE,
      metadataClient: {
        supportsNativeRecursive: true,
        async listFolder(): Promise<DropboxMetadataPage> {
          return page;
        },
        async listFolderContinue(): Promise<DropboxMetadataPage> {
          throw new Error('unexpected continuation');
        },
      },
      onPageDigestRestart: () => {
        restarts += 1;
      },
    });

    const first = await collectPages(connector.listItems({ limit: 2 }));
    const checkpoint = first[0]?.nextCursor;
    expect(first[0]).toMatchObject({ done: false, truncated: true });

    page = {
      entries: [fileEntry('one'), fileEntry('replacement'), fileEntry('three')],
      hasMore: false,
    };
    const resumed = await collectPages(connector.listItems({ cursor: checkpoint!, limit: 2 }));
    expect(resumed[0]?.items.map((item) => item.identity.providerItemId))
      .toEqual(['id:one', 'id:replacement']);
    expect(restarts).toBe(1);
  });
});

function overLimitCursorClient(calls: string[]): DropboxMetadataClient {
  return {
    supportsNativeRecursive: true,
    async listFolder(request: DropboxMetadataListRequest): Promise<DropboxMetadataPage> {
      calls.push(`list:${request.path}:${request.limit}`);
      return {
        cursor: 'cursor-page-1',
        hasMore: true,
        entries: [fileEntry('one'), fileEntry('two')],
      };
    },
    async listFolderContinue(request: DropboxMetadataContinueRequest): Promise<DropboxMetadataPage> {
      calls.push(`continue:${request.cursor}:${request.limit}`);
      return {
        cursor: 'cursor-page-2',
        hasMore: false,
        entries: [fileEntry('three'), fileEntry('four'), fileEntry('five')],
      };
    },
  };
}

function fileEntry(name: string): DropboxMetadataEntry {
  return {
    tag: 'file',
    id: `id:${name}`,
    name: `${name}.txt`,
    pathDisplay: `${ROOT_FOLDER_PATH}/${name}.txt`,
    pathLower: `/root/${name}.txt`,
    rev: `rev-${name}`,
    contentHash: `hash-${name}`,
    size: 10,
    clientModified: '2026-05-18T09:00:00.000Z',
    serverModified: '2026-05-18T10:00:00.000Z',
    mimeType: 'text/plain',
  };
}

async function collectPages(
  pages: AsyncIterable<import('../src/core/contracts.ts').SourceConnectorListPage>,
): Promise<import('../src/core/contracts.ts').SourceConnectorListPage[]> {
  const collected: import('../src/core/contracts.ts').SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}
