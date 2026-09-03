import { describe, expect, test } from 'bun:test';
import type {
  RawItem,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import {
  GoogleDriveApiError,
  GoogleDriveSourceConnector,
  type GoogleDriveApiClient,
  type GoogleDriveFile,
  type GoogleDriveListFilesRequest,
} from '../src/workers/google-connectors/drive.ts';
import type { CredentialBroker } from '../src/workers/credential-broker/index.ts';

/**
 * A completed Drive traversal promotes its high-water `modifiedTime` into the
 * next pass's `modifiedTime > ...` query, so anything at or below the promoted
 * value is never listed again. These cases pin the rule that follows from
 * that: a file whose text this run did not read must stay listable.
 */
describe('Google Drive never promotes a watermark past text it did not read', () => {
  test('the per-run content cap bounds the traversal instead of downgrading files', async () => {
    const client = fakeDriveClient(driveFiles(3));

    // Production builds a fresh connector per bounded pull, so the cap resets
    // every pull while the traversal continues from its checkpoint.
    const first = await collectPages(driveConnector(client, { maxContentFiles: 1 }).listItems());
    const second = await collectPages(
      driveConnector(client, { maxContentFiles: 1 }).listItems(resumeAt(first.cursor)),
    );
    const third = await collectPages(
      driveConnector(client, { maxContentFiles: 1 }).listItems(resumeAt(second.cursor)),
    );

    expect(first.done).toBe(false);
    expect(second.done).toBe(false);
    expect(third.done).toBe(true);
    // Every file was read exactly once, and none was indexed text-less while
    // the watermark moved past it.
    expect([...first.items, ...second.items, ...third.items].map((item) => item.content.kind))
      .toEqual(['text', 'text', 'text']);
    expect(client.contentCalls).toEqual(['file-1', 'file-2', 'file-3']);
  });

  test('a rate-limited content read holds the watermark below the file it owes', async () => {
    const client = fakeDriveClient(driveFiles(2), { readFailure: { fileId: 'file-1', status: 429 } });
    const connector = driveConnector(client, { maxContentFiles: 10 });

    const traversal = await collectPages(connector.listItems());
    expect(traversal.done).toBe(true);
    await collectPages(driveConnector(client, { maxContentFiles: 10 }).listItems(
      resumeAt(traversal.cursor),
    ));

    // file-1 (2026-07-01) failed transiently and file-2 (2026-07-02) read fine.
    // Promoting the newest modifiedTime would put file-1 permanently behind the
    // query, and nothing in the product re-reads a Drive file.
    expect(client.queries.at(-1)).toBe(
      "modifiedTime > '2026-06-30T23:59:59.999Z' and (trashed = false)",
    );
  });

  test('a refusal that recurs every run costs one retry cycle, not the lane', async () => {
    const client = fakeDriveClient(driveFiles(2), { readFailure: { fileId: 'file-1', status: 500 } });

    const first = await collectPages(driveConnector(client, { maxContentFiles: 10 }).listItems());
    const second = await collectPages(
      driveConnector(client, { maxContentFiles: 10 }).listItems(resumeAt(first.cursor)),
    );
    await collectPages(
      driveConnector(client, { maxContentFiles: 10 }).listItems(resumeAt(second.cursor)),
    );

    // The first completed traversal clamps one millisecond below file-1 so the
    // refusal gets a retry. The second traversal arrives at that exact clamp as
    // its own watermark, which is the proof the refusal is not transient, so it
    // promotes past the file instead of reproducing the clamp forever.
    expect(client.queries).toEqual([
      'trashed = false',
      "modifiedTime > '2026-06-30T23:59:59.999Z' and (trashed = false)",
      "modifiedTime > '2026-07-02T00:00:00.000Z' and (trashed = false)",
    ]);
  });

  test('a settled content refusal still lets the traversal move on', async () => {
    const client = fakeDriveClient(driveFiles(2), { readFailure: { fileId: 'file-1', status: 404 } });
    const connector = driveConnector(client, { maxContentFiles: 10 });

    const traversal = await collectPages(connector.listItems());
    await collectPages(driveConnector(client, { maxContentFiles: 10 }).listItems(
      resumeAt(traversal.cursor),
    ));

    // A 404 is an answer, not owed work. Holding the watermark for it would
    // stall the lane on that file forever.
    expect(client.queries.at(-1)).toBe(
      "modifiedTime > '2026-07-02T00:00:00.000Z' and (trashed = false)",
    );
  });
});

function driveConnector(
  client: GoogleDriveApiClient,
  options: { maxContentFiles: number },
): GoogleDriveSourceConnector {
  return new GoogleDriveSourceConnector({
    apiClient: client,
    credentialBroker: fakeBroker(),
    env: {},
    maxFiles: 10,
    maxContentFiles: options.maxContentFiles,
  });
}

function resumeAt(cursor: string | undefined): SourceConnectorListOptions {
  return cursor ? { cursor } : {};
}

async function collectPages(pages: AsyncIterable<SourceConnectorListPage>): Promise<{
  items: RawItem[];
  cursor: string | undefined;
  done: boolean;
}> {
  const items: RawItem[] = [];
  let cursor: string | undefined;
  let done = false;
  for await (const page of pages) {
    items.push(...page.items);
    cursor = page.nextCursor;
    done = page.done;
  }
  return { items, cursor, done };
}

interface CountingDriveApiClient extends GoogleDriveApiClient {
  queries: string[];
  contentCalls: string[];
}

function fakeDriveClient(
  files: GoogleDriveFile[],
  options: { readFailure?: { fileId: string; status: number } } = {},
): CountingDriveApiClient {
  const readText = (fileId: string, contentCalls: string[]): string => {
    if (options.readFailure?.fileId === fileId) {
      throw new GoogleDriveApiError(
        `Google Drive read refused (${options.readFailure.status}).`,
        options.readFailure.status,
      );
    }
    contentCalls.push(fileId);
    return `Roadmap notes for ${fileId}.`;
  };
  return {
    queries: [],
    contentCalls: [],
    async listFiles(request: GoogleDriveListFilesRequest) {
      const query = request.query ?? '';
      this.queries.push(query);
      const after = /modifiedTime > '([^']+)'/.exec(query)?.[1];
      const eligible = files.filter((file) =>
        !after || (file.modifiedTime ?? '').localeCompare(after) > 0);
      const offset = request.pageToken ? Number(request.pageToken) : 0;
      const slice = eligible.slice(offset, offset + request.pageSize);
      const nextOffset = offset + slice.length;
      return {
        files: slice,
        ...(nextOffset < eligible.length ? { nextPageToken: String(nextOffset) } : {}),
      };
    },
    async exportGoogleDocText(fileId: string) {
      return readText(fileId, this.contentCalls);
    },
    async downloadTextFile(fileId: string) {
      return readText(fileId, this.contentCalls);
    },
    async downloadFileBytes(fileId: string) {
      const bytes = new TextEncoder().encode(readText(fileId, this.contentCalls));
      return { bytes, sizeBytes: bytes.byteLength };
    },
  };
}

function driveFiles(count: number): GoogleDriveFile[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `file-${index + 1}`,
    name: `roadmap-${index + 1}.txt`,
    mimeType: 'text/plain',
    modifiedTime: `2026-07-0${index + 1}T00:00:00.000Z`,
    version: String(index + 1),
    size: '48',
    webViewLink: `https://drive.google.com/file/d/file-${index + 1}/view`,
  }));
}

function fakeBroker(): CredentialBroker {
  return {
    async issueSession() {
      return {
        kind: 'bearer_token',
        handle: 'google_drive.personal',
        provider: 'google_drive',
        capability: 'google_drive.docs.sync',
        trustDomain: 'internal',
        token: 'drive-token-fixture',
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        issuedAt: '2026-07-01T00:00:00.000Z',
        expiresAt: '2026-07-01T01:00:00.000Z',
      };
    },
    async status() {
      return {
        handle: 'google_drive.personal',
        provider: 'google_drive',
        state: 'ready',
        trustDomain: 'internal',
        allowedCapabilities: ['google_drive.docs.sync'],
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      };
    },
  } as unknown as CredentialBroker;
}
