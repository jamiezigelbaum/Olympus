import { describe, expect, test } from 'bun:test';
import type { RawItem } from '../src/core/contracts.ts';
import {
  GoogleDriveSourceConnector,
  type GoogleDriveApiClient,
  type GoogleDriveFile,
} from '../src/workers/google-connectors/drive.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';

/**
 * Downstream reads `authoredAt` as the item's date: citations show it and
 * versions of one document order by it. For a Drive file that date is the last
 * edit, as Dropbox's client_modified is, so an original edited after someone
 * made a "Copy of" it reads as the newer of the two.
 */
describe('Google Drive item date is the last edit', () => {
  test('an original edited after it was copied dates newer than the stale copy', async () => {
    const items = await listAll([
      {
        id: 'original',
        name: 'Budget',
        mimeType: 'text/plain',
        createdTime: '2026-01-10T09:00:00.000Z',
        modifiedTime: '2026-09-20T15:30:00.000Z',
      },
      {
        id: 'copy',
        name: 'Copy of Budget',
        mimeType: 'text/plain',
        createdTime: '2026-03-02T11:00:00.000Z',
        modifiedTime: '2026-03-02T11:00:00.000Z',
      },
    ]);
    const original = metadataOf(items, 'original');
    const copy = metadataOf(items, 'copy');

    expect(original.authoredAt).toBe('2026-09-20T15:30:00.000Z');
    expect(original.createdAt).toBe('2026-01-10T09:00:00.000Z');
    expect(String(original.authoredAt) > String(copy.authoredAt)).toBe(true);
  });

  test('creation time stands in only when Drive sends no edit time', async () => {
    const items = await listAll([
      { id: 'undated-edit', name: 'Notes', mimeType: 'text/plain', createdTime: '2026-02-01T00:00:00.000Z' },
    ]);
    const metadata = metadataOf(items, 'undated-edit');

    expect(metadata.authoredAt).toBe('2026-02-01T00:00:00.000Z');
    expect(metadata.updatedAt).toBeUndefined();
  });
});

async function listAll(files: GoogleDriveFile[]): Promise<RawItem[]> {
  const connector = new GoogleDriveSourceConnector({
    apiClient: staticClient(files),
    credentialBroker: { async issueSession() { return {}; } } as unknown as CredentialBroker,
    env: {},
    maxFiles: 10,
  });
  const items: RawItem[] = [];
  for await (const page of connector.listItems()) items.push(...page.items);
  return items;
}

function metadataOf(items: RawItem[], fileId: string): Record<string, unknown> {
  const item = items.find((candidate) => candidate.identity.providerFileId === fileId);
  if (!item) throw new Error(`no listed item for ${fileId}`);
  return item.metadata as Record<string, unknown>;
}

function staticClient(files: GoogleDriveFile[]): GoogleDriveApiClient {
  return {
    async listFiles() {
      return { files };
    },
    async exportGoogleDocText(fileId: string) {
      return `text of ${fileId}`;
    },
    async downloadTextFile(fileId: string) {
      return `text of ${fileId}`;
    },
    async downloadFileBytes(fileId: string) {
      const bytes = new TextEncoder().encode(`text of ${fileId}`);
      return { bytes, sizeBytes: bytes.byteLength };
    },
  };
}
