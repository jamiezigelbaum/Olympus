import { describe, expect, test } from 'bun:test';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  DROPBOX_FILES_CORPUS_ID,
  DropboxSourceExportDestinationError,
  DropboxSourceExportRequestError,
  createDropboxSourceExportHandler,
  type DropboxCopyClient,
  type DropboxCopyOutcome,
  type DropboxCopyRequest,
  type DropboxSourceExportHandler,
  type DropboxSourceExportStore,
} from '../src/workers/dropbox-files/index.ts';

const APPROVED_SCOPE = 'dropbox.personal:/2 Areas/EXPORT_SECRET_SCOPE';
const EXPORT_ENV = { OLYMPUS_SOURCE_EXPORT_DROPBOX_ROOTS: '/Olympus Exports, /Castor Outbox/' };

class FakeDropboxCopyClient implements DropboxCopyClient {
  calls: DropboxCopyRequest[] = [];
  conflictDestinations = new Set<string>();

  async copy(request: DropboxCopyRequest): Promise<DropboxCopyOutcome> {
    this.calls.push(request);
    return this.conflictDestinations.has(request.to_path) ? 'conflict' : 'copied';
  }
}

interface TestDropboxExportItem {
  kind: 'file';
  providerFileId: string;
  account: string;
  approvedScopeKey: string;
  pathDisplay: string;
  pathLower: string;
  name: string;
  revision: string;
  contentHash: string;
  mimeType: string;
  sizeBytes: number;
  extractionStatus: string;
  boundedText?: string;
  deleted?: boolean;
}

class TestDropboxExportStore implements DropboxSourceExportStore {
  private readonly items = new Map<string, { trustTier: 'S3' | 'S5'; locatorUri: string }>();

  sync(items: TestDropboxExportItem[], request: { account: string }): void {
    for (const item of items) {
      const key = item.pathDisplay.toLowerCase();
      if (item.deleted) {
        this.items.delete(key);
        continue;
      }
      this.items.set(key, {
        trustTier: item.boundedText?.includes('PRIVATE KEY') ? 'S5' : 'S3',
        locatorUri: item.pathDisplay,
      });
    }
    void request;
  }

  activeItemForLocator(input: {
    provider: string;
    accountScope: string;
    locatorUri: string;
  }): { trustTier: 'S3' | 'S5'; locatorUri: string } | undefined {
    if (input.provider !== 'dropbox' || input.accountScope !== 'personal') return undefined;
    return this.items.get(input.locatorUri.toLowerCase());
  }
}

describe('connector-store Dropbox source export worker', () => {
  test('copies verified items server-side with subfolder layout and paths-only result', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([
        transcriptFile('file-standup', 'Standup 2026-06-01.txt'),
        transcriptFile('file-retro', 'Retro 2026-06-02.txt'),
      ], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports/Otter',
        items: [
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt', dest_subfolder: 'Standups' },
          { path: '/2 areas/export_secret_scope/otter/Retro 2026-06-02.txt' },
        ],
      });

      expect(copyClient.calls).toEqual([
        {
          from_path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt',
          to_path: '/Olympus Exports/Otter/Standups/Standup 2026-06-01.txt',
        },
        {
          from_path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Retro 2026-06-02.txt',
          to_path: '/Olympus Exports/Otter/Retro 2026-06-02.txt',
        },
      ]);
      expect(result).toMatchObject({
        kind: 'dropbox_source_export',
        corpus_id: DROPBOX_FILES_CORPUS_ID,
        provider: 'dropbox',
        account: 'personal',
        destination_root: '/Olympus Exports/Otter',
        items_requested: 2,
        items_copied: 2,
        items_skipped_unknown: 0,
        items_skipped_s5: 0,
        items_skipped_existing: 0,
        items_failed: 0,
        dry_run: false,
        policy: {
          raw_source_exposed: false,
          content_transited_models: false,
          destination_user_owned: true,
        },
      });
      expect(result.items.map((item) => item.status)).toEqual(['copied', 'copied']);
      expect(result.items[0]?.dest_path).toBe('/Olympus Exports/Otter/Standups/Standup 2026-06-01.txt');
    });
  });

  test('rejects destinations outside the approved export allowlist and fails closed without roots', async () => {
    await withTempDropboxIndex(async (index) => {
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      expect(handler.export({
        destination_root: '/Somewhere Else',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      })).rejects.toThrow(DropboxSourceExportDestinationError);

      // Prefix-shaped but different folder must not pass the boundary check.
      expect(handler.export({
        destination_root: '/Olympus Exports Evil',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      })).rejects.toThrow(DropboxSourceExportDestinationError);

      const unconfigured = createDropboxSourceExportHandler({
        store: index,
        copyClient,
        env: {},
      });
      expect(unconfigured.export({
        destination_root: '/Olympus Exports',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      })).rejects.toThrow(DropboxSourceExportDestinationError);

      expect(copyClient.calls).toHaveLength(0);
    });
  });

  test('rejects malformed requests before touching the provider', async () => {
    await withTempDropboxIndex(async (index) => {
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      expect(handler.export({
        destination_root: '/',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      })).rejects.toThrow(DropboxSourceExportRequestError);

      expect(handler.export({
        destination_root: '/Olympus Exports',
        items: [],
      })).rejects.toThrow(DropboxSourceExportRequestError);

      expect(handler.export({
        destination_root: '/Olympus Exports',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt', dest_subfolder: '../escape' }],
      })).rejects.toThrow(DropboxSourceExportRequestError);

      expect(handler.export({
        destination_root: '/Olympus Exports',
        account: 'business',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      })).rejects.toThrow(DropboxSourceExportRequestError);

      expect(copyClient.calls).toHaveLength(0);
    });
  });

  test('skips unknown paths instead of copying unverified locators', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([transcriptFile('file-standup', 'Standup 2026-06-01.txt')], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports',
        items: [
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' },
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Not Indexed.txt' },
        ],
      });

      expect(result.items_copied).toBe(1);
      expect(result.items_skipped_unknown).toBe(1);
      expect(result.items[1]).toEqual({
        path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Not Indexed.txt',
        status: 'skipped_unknown',
      });
      expect(copyClient.calls).toHaveLength(1);
    });
  });

  test('skips tombstoned entries as unknown', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([
        transcriptFile('file-deleted', 'Deleted Transcript.txt', { deleted: true }),
      ], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Deleted Transcript.txt' }],
      });

      expect(result.items_skipped_unknown).toBe(1);
      expect(copyClient.calls).toHaveLength(0);
    });
  });

  test('always skips S5-classified items', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([
        transcriptFile('file-clean', 'Clean Transcript.txt', {
          boundedText: 'Ordinary meeting transcript about roadmap planning.',
          extractionStatus: 'extracted',
          mimeType: 'text/plain',
        }),
        transcriptFile('file-secret', 'Credential Note.txt', {
          boundedText: 'Credential material\n-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
          extractionStatus: 'extracted',
          mimeType: 'text/plain',
        }),
      ], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports',
        items: [
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Clean Transcript.txt' },
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Credential Note.txt' },
        ],
      });

      expect(result.items_copied).toBe(1);
      expect(result.items_skipped_s5).toBe(1);
      expect(result.items[1]).toEqual({
        path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Credential Note.txt',
        status: 'skipped_s5',
      });
      expect(copyClient.calls.map((call) => call.from_path)).toEqual([
        '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Clean Transcript.txt',
      ]);
    });
  });

  test('treats destination conflicts as skip_existing, not errors', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([
        transcriptFile('file-standup', 'Standup 2026-06-01.txt'),
        transcriptFile('file-retro', 'Retro 2026-06-02.txt'),
      ], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      copyClient.conflictDestinations.add('/Olympus Exports/Standup 2026-06-01.txt');
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports',
        items: [
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' },
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Retro 2026-06-02.txt' },
        ],
      });

      expect(result.items_copied).toBe(1);
      expect(result.items_skipped_existing).toBe(1);
      expect(result.items[0]).toMatchObject({ status: 'skipped_existing' });
      expect(result.items[1]).toMatchObject({ status: 'copied' });
    });
  });

  test('dry_run verifies and plans without performing any copy', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([transcriptFile('file-standup', 'Standup 2026-06-01.txt')], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports/Otter',
        dry_run: true,
        items: [
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt', dest_subfolder: 'Standups' },
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Not Indexed.txt' },
        ],
      });

      expect(copyClient.calls).toHaveLength(0);
      expect(result).toMatchObject({
        dry_run: true,
        items_requested: 2,
        items_copied: 0,
        items_skipped_unknown: 1,
      });
      expect(result.items[0]).toEqual({
        path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt',
        status: 'would_copy',
        dest_path: '/Olympus Exports/Otter/Standups/Standup 2026-06-01.txt',
      });
    });
  });

  test('source export endpoint rejects string dry_run before copying files', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([transcriptFile('file-standup', 'Standup 2026-06-01.txt')], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const worker = createEmailSourceWorker({
        dropboxSourceExport: exportHandler(index, copyClient),
      });

      const response = await worker.fetch(exportRequest({
        destination_root: '/Olympus Exports/Otter',
        dry_run: 'true',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error.code).toBe('invalid_request');
      expect(copyClient.calls).toHaveLength(0);
    });
  });

  test('result is a paths-only membrane: no content, scopes, cursors, or operational fields', async () => {
    await withTempDropboxIndex(async (index) => {
      const secretText = 'EXPORT_SECRET_DO_NOT_LEAK transcript body text.';
      index.sync([
        transcriptFile('file-standup', 'Standup 2026-06-01.txt', {
          boundedText: secretText,
          extractionStatus: 'extracted',
          mimeType: 'text/plain',
        }),
      ], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const handler = exportHandler(index, copyClient);

      const result = await handler.export({
        destination_root: '/Olympus Exports',
        items: [{ path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt' }],
      });
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain('EXPORT_SECRET_DO_NOT_LEAK');
      expect(serialized).not.toContain(APPROVED_SCOPE);
      expect(serialized).not.toContain('cursor');
      for (const forbiddenKey of [
        'bounded_text',
        'approved_scope_key',
        'path_display',
        'path_lower',
        'provider_cursor',
        'token',
        'body',
        'snippet',
        'embedding',
        'vector',
      ]) {
        expect(collectKeys(result)).not.toContain(forbiddenKey);
      }
      expect(result.policy.raw_source_exposed).toBe(false);
      expect(result.policy.content_transited_models).toBe(false);
      expect(result.policy.destination_user_owned).toBe(true);
    });
  });
});

describe('source export worker route', () => {
  test('returns 501 when source export is not configured', async () => {
    const worker = createEmailSourceWorker();

    const response = await worker.fetch(exportRequest({
      destination_root: '/Olympus Exports',
      items: ['/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt'],
    }));
    const requestBody = await response.json();

    expect(response.status).toBe(501);
    expect(requestBody).toMatchObject({
      error: { code: 'source_export_not_supported' },
      policy: { raw_email_exposed: false },
    });
  });

  test('returns 400 for malformed export requests', async () => {
    await withTempDropboxIndex(async (index) => {
      const worker = createEmailSourceWorker({
        dropboxSourceExport: exportHandler(index, new FakeDropboxCopyClient()),
      });

      const missingItems = await worker.fetch(exportRequest({ destination_root: '/Olympus Exports' }));
      expect(missingItems.status).toBe(400);
      expect((await missingItems.json()).error.code).toBe('invalid_request');

      const missingDestination = await worker.fetch(exportRequest({
        items: ['/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt'],
      }));
      expect(missingDestination.status).toBe(400);

      const badItem = await worker.fetch(exportRequest({
        destination_root: '/Olympus Exports',
        items: [{ dest_subfolder: 'Standups' }],
      }));
      expect(badItem.status).toBe(400);

      // Handler-level request validation also maps to 400.
      const rootDestination = await worker.fetch(exportRequest({
        destination_root: '/',
        items: ['/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt'],
      }));
      expect(rootDestination.status).toBe(400);
    });
  });

  test('returns 403 when the destination is outside the export allowlist', async () => {
    await withTempDropboxIndex(async (index) => {
      const worker = createEmailSourceWorker({
        dropboxSourceExport: exportHandler(index, new FakeDropboxCopyClient()),
      });

      const response = await worker.fetch(exportRequest({
        destination_root: '/Somewhere Else',
        items: ['/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt'],
      }));
      const responseBody = await response.json();

      expect(response.status).toBe(403);
      expect(responseBody).toMatchObject({
        error: { code: 'source_export_destination_not_allowed' },
        policy: { raw_email_exposed: false },
      });
    });
  });

  test('returns the Castor-safe export result on the happy path', async () => {
    await withTempDropboxIndex(async (index) => {
      index.sync([transcriptFile('file-standup', 'Standup 2026-06-01.txt')], syncRequest());
      const copyClient = new FakeDropboxCopyClient();
      const worker = createEmailSourceWorker({
        dropboxSourceExport: exportHandler(index, copyClient),
      });

      const response = await worker.fetch(exportRequest({
        destination_root: '/Olympus Exports/Otter',
        items: [
          { path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt', dest_subfolder: 'Standups' },
        ],
      }));
      const responseBody = await response.json();

      expect(response.status).toBe(200);
      expect(responseBody).toMatchObject({
        kind: 'dropbox_source_export',
        destination_root: '/Olympus Exports/Otter',
        items_requested: 1,
        items_copied: 1,
        dry_run: false,
        policy: {
          raw_source_exposed: false,
          content_transited_models: false,
          destination_user_owned: true,
        },
      });
      expect(copyClient.calls).toEqual([{
        from_path: '/2 Areas/EXPORT_SECRET_SCOPE/Otter/Standup 2026-06-01.txt',
        to_path: '/Olympus Exports/Otter/Standups/Standup 2026-06-01.txt',
      }]);
      expect(JSON.stringify(responseBody)).not.toContain(APPROVED_SCOPE);
    });
  });
});

function exportHandler(index: TestDropboxExportStore, copyClient: DropboxCopyClient): DropboxSourceExportHandler {
  return createDropboxSourceExportHandler({
    store: index,
    copyClient,
    env: EXPORT_ENV,
  });
}

function exportRequest(body: Record<string, unknown>): Request {
  return new Request('http://worker.test/v1/source/export', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function syncRequest(): { approved_scope_key: string; account: string; provider_cursor: string } {
  return {
    approved_scope_key: APPROVED_SCOPE,
    account: 'personal',
    provider_cursor: 'cursor-1',
  };
}

function transcriptFile(
  providerFileId: string,
  name: string,
  overrides: Partial<TestDropboxExportItem> = {},
): TestDropboxExportItem {
  return {
    kind: 'file',
    providerFileId,
    account: 'personal',
    approvedScopeKey: APPROVED_SCOPE,
    pathDisplay: `/2 Areas/EXPORT_SECRET_SCOPE/Otter/${name}`,
    pathLower: `/2 areas/export_secret_scope/otter/${name.toLowerCase()}`,
    name,
    revision: `rev-${providerFileId}`,
    contentHash: `hash-${providerFileId}`,
    mimeType: 'text/plain',
    sizeBytes: 2048,
    extractionStatus: 'metadata_only',
    ...overrides,
  };
}

function collectKeys(value: unknown, keys = new Set<string>()): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return [...keys];
}

async function withTempDropboxIndex(run: (index: TestDropboxExportStore) => void | Promise<void>): Promise<void> {
  await run(new TestDropboxExportStore());
}
