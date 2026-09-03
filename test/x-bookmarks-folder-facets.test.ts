import { describe, expect, test } from 'bun:test';
import {
  createXBookmarksSourceConnector,
  xBookmarkFolderNameFacet,
  xBookmarkProviderFolderNameFacet,
} from '../src/workers/x-bookmarks/index.ts';

describe('X bookmark folder-name facet codec', () => {
  test('is injective for well-formed Unicode and rejects ill-formed UTF-16', () => {
    const values = [
      '\ufffd',
      '\ud7ff',
      '\ue000',
      '\ud83d\ude80',
      'Climate',
      'climate',
    ];
    expect(new Set(values.map(xBookmarkFolderNameFacet)).size).toBe(values.length);
    for (const value of ['\ud800', '\ud801', '\udc00']) {
      expect(() => xBookmarkFolderNameFacet(value)).toThrow('well-formed UTF-16');
    }
  });

  test('normalizes unpaired provider surrogates explicitly without folding well-formed text', () => {
    expect(xBookmarkProviderFolderNameFacet('\ud800'))
      .toBe(xBookmarkFolderNameFacet('\ufffd'));
    expect(xBookmarkProviderFolderNameFacet('\ud800\ud801'))
      .toBe(xBookmarkFolderNameFacet('\ufffd\ufffd'));
    expect(xBookmarkProviderFolderNameFacet('e\u0301'))
      .not.toBe(xBookmarkProviderFolderNameFacet('\u00e9'));
  });

  test('normalizes provider folder names before aliases, metadata, hashes, and facets', async () => {
    const connector = createXBookmarksSourceConnector({
      account: 'personal',
      posts: [{ id: '2076846914813788163', text: 'Provider normalization marker.' }],
      foldersByPostId: new Map([[
        '2076846914813788163',
        [{ id: 'folder-provider', name: 'Climate \ud800 watch' }],
      ]]),
      fetchedAt: '2026-07-30T12:00:00.000Z',
    });
    const pages = [];
    for await (const page of connector.listItems()) pages.push(page);
    const item = pages[0]?.items[0];
    expect(item).toBeDefined();
    expect(item!.metadata).toMatchObject({
      aliases: expect.arrayContaining(['Climate \ufffd watch']),
      folderNames: ['Climate \ufffd watch'],
      folders: [{ id: 'folder-provider', name: 'Climate \ufffd watch' }],
    });
    expect(item!.metadata.searchText).toContain(
      xBookmarkFolderNameFacet('Climate \ufffd watch'),
    );
  });
});
