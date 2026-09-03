import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  createDropboxConnectorStoreEvalShardSource,
  createDropboxEvalShardExportHandler,
  type DropboxEvalShardCandidate,
  type DropboxEvalShardConnectorStore,
  type DropboxEvalShardIndex,
} from '../src/workers/dropbox-files/index.ts';
import type { ExtractionCommandRunner } from '../src/workers/file-extraction/extractors/command-runner.ts';

const SCOPE = 'dropbox.personal:/1 Projects';
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);

describe('connector-store Dropbox eval shard export', () => {
  test('builds and rechecks the protected pool from canonical connector-store rows', () => {
    const reads: unknown[] = [];
    const content = new Map([
      ['local-in', { trustTier: 'S4' as const, chunks: ['stored text'], truncated: false, storedChunks: 1, mimeType: 'application/pdf', locatorUri: '/1 Projects/in.pdf' }],
      ['local-out', { trustTier: 'S3' as const, chunks: ['outside text'], truncated: false, storedChunks: 1, mimeType: 'application/pdf', locatorUri: '/Elsewhere/out.pdf' }],
      ['local-s5', { trustTier: 'S5' as const, chunks: ['never cloud'], truncated: false, storedChunks: 1, mimeType: 'image/png', locatorUri: '/1 Projects/secret.png' }],
    ]);
    const store: DropboxEvalShardConnectorStore = {
      extractionCandidates(options) {
        reads.push(options);
        return {
          done: true,
          candidates: [
            connectorCandidate('local-in', '/1 Projects/in.pdf', 'application/pdf'),
            connectorCandidate('local-out', '/Elsewhere/out.pdf', 'application/pdf'),
            connectorCandidate('local-s5', '/1 Projects/secret.png', 'image/png'),
          ],
        };
      },
      localContent(localItemId) { return content.get(localItemId); },
    };

    const source = createDropboxConnectorStoreEvalShardSource(store);
    const candidates = source.evalShardCandidates({ approved_scope_key: SCOPE });

    expect(reads).toEqual([{
      limit: 5_000,
      accountScope: 'personal',
      mimeTypes: ['application/pdf', 'image/png'],
    }]);
    expect(candidates.map((row) => row.local_entry_id)).toEqual(['local-in', 'local-s5']);
    expect(candidates[0]).toMatchObject({
      provider_file_id: 'provider-local-in',
      artifact_text: 'stored text',
      extractor_kind: 'connector_store_chunks',
      privacy_allowed: true,
      privacy_tier: 'S4',
    });
    expect(candidates[0]!.doc_id_hash).toHaveLength(64);
    expect(candidates[1]).toMatchObject({
      privacy_allowed: false,
      privacy_tier: 'S5',
      privacy_reason: 'privacy_tier_s5_cloud_refused',
    });
    content.delete('local-in');
    expect(source.evalShardPrivacyDecision('local-in')).toEqual({
      allowed: false,
      tier: 'unknown',
      reason: 'connector_store_item_missing',
    });
  });

  test('dry-run no-mutation: lists a stratified shard without downloads or files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-eval-shard-dry-'));
    const out = join(root, 'does-not-exist');
    let downloads = 0;
    try {
      const handler = createDropboxEvalShardExportHandler({
        source: fakeIndex([
          candidate('pdf-small', { mime_type: 'application/pdf', size_bytes: 10, privacy_tier: 'S4' }),
          candidate('png-large', { mime_type: 'image/png', size_bytes: 20_000_000, privacy_tier: 'S2' }),
        ]),
        downloader: { async download() { downloads += 1; throw new Error('must not download'); } },
      });
      const manifest = await handler.export({
        approved_scope_key: SCOPE,
        count: 2,
        out_dir: out,
      });

      expect(manifest).toMatchObject({
        requested_count: 2,
        selected_documents: 2,
        exported_documents: 0,
        dry_run: true,
        counts_by_tier: { S2: 1, S4: 1 },
        counts_by_type: { pdf: 1, png: 1 },
      });
      expect(manifest.items.map((item) => item.outcome)).toEqual(['would_export', 'would_export']);
      expect(downloads).toBe(0);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('S5/blocked excluded with per-doc reasons', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-eval-shard-deny-'));
    try {
      const handler = createDropboxEvalShardExportHandler({
        source: fakeIndex([
          candidate('allowed'),
          candidate('s5', {
            privacy_tier: 'S5',
            privacy_allowed: false,
            privacy_reason: 'privacy_tier_s5_cloud_refused',
          }),
          candidate('blocked', {
            privacy_tier: 'S2',
            privacy_allowed: false,
            privacy_reason: 'classification_blocked_sensitive_cloud_refused',
          }),
        ]),
      });
      const manifest = await handler.export({ approved_scope_key: SCOPE, count: 3, out_dir: root });

      expect(manifest.selected_documents).toBe(1);
      expect(manifest.skipped_documents).toEqual(expect.arrayContaining([
        { doc_id_hash: 's5', reason: 'privacy_tier_s5_cloud_refused' },
        { doc_id_hash: 'blocked', reason: 'classification_blocked_sensitive_cloud_refused' },
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('sidecar shape and manifest counts use two mocked 180-DPI PDF pages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-eval-shard-sidecar-'));
    const commands: Array<{ command: string; args: string[] }> = [];
    try {
      const handler = createDropboxEvalShardExportHandler({
        source: fakeIndex([candidate('doc-hash', {
          artifact_text: 'A'.repeat(4_100),
          extractor_kind: 'local_vlm_pdf',
          privacy_tier: 'S4',
        })]),
        downloader: { async download() { return { bytes: new Uint8Array([1, 2, 3]) }; } },
        renderCommandRunner: mockPdfRunner(commands),
        infoCommandRunner: mockPdfRunner(commands),
      });
      const manifest = await handler.export({
        approved_scope_key: SCOPE,
        count: 1,
        out_dir: root,
        dry_run: false,
      });

      expect(commands.find((command) => command.command === 'pdftoppm')?.args).toEqual(expect.arrayContaining([
        '-f', '1', '-l', '2', '-png', '-r', '180',
      ]));
      const sidecar = JSON.parse(readFileSync(join(root, 'doc-hash-p1.json'), 'utf8')) as Record<string, unknown>;
      expect(sidecar).toEqual({
        schema_version: 1,
        doc_id_hash: 'doc-hash',
        page_number: 1,
        privacy_tier: 'S4',
        doc_type: 'pdf',
        ground_truth_status: 'draft',
        ground_truth_text: 'A'.repeat(4_000),
        text_scope: 'document',
        extractor_kind: 'local_vlm_pdf',
      });
      const pageTwoSidecar = JSON.parse(readFileSync(join(root, 'doc-hash-p2.json'), 'utf8')) as Record<string, unknown>;
      expect(pageTwoSidecar.text_scope).toBe('document');
      expect(existsSync(join(root, 'doc-hash-p2.png'))).toBe(true);
      expect(manifest).toMatchObject({
        selected_documents: 1,
        exported_documents: 1,
        exported_pages: 2,
        counts_by_tier: { S4: 1 },
        counts_by_type: { pdf: 1 },
        dry_run: false,
      });
      expect(JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))).toEqual(manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('single-page documents mark text_scope=page; multi-page mark every page document-scoped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-eval-shard-scope-'));
    try {
      const handler = createDropboxEvalShardExportHandler({
        source: fakeIndex([
          candidate('one-page-pdf', { local_entry_id: 101, mime_type: 'application/pdf' }),
          candidate('single-image', { local_entry_id: 102, mime_type: 'image/png' }),
        ]),
        downloader: {
          async download(request) {
            return { bytes: request.job.provider_file_id === 'provider-single-image' ? PNG : new Uint8Array([1, 2, 3]) };
          },
        },
        renderCommandRunner: mockSinglePagePdfRunner(),
        infoCommandRunner: mockSinglePagePdfRunner(),
      });
      const manifest = await handler.export({ approved_scope_key: SCOPE, count: 2, out_dir: root, dry_run: false });

      expect(manifest).toMatchObject({ exported_documents: 2, exported_pages: 2 });
      const pdfSidecar = JSON.parse(readFileSync(join(root, 'one-page-pdf-p1.json'), 'utf8')) as Record<string, unknown>;
      expect(pdfSidecar.text_scope).toBe('page');
      const imageSidecar = JSON.parse(readFileSync(join(root, 'single-image-p1.json'), 'utf8')) as Record<string, unknown>;
      expect(imageSidecar.text_scope).toBe('page');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('idempotent re-export overwrites sidecars cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-eval-shard-idempotent-'));
    const row = candidate('stable-doc', { mime_type: 'image/png', artifact_text: 'draft one' });
    try {
      const handler = createDropboxEvalShardExportHandler({
        source: fakeIndex([row]),
        downloader: { async download() { return { bytes: PNG }; } },
      });
      const request = { approved_scope_key: SCOPE, count: 1, out_dir: root, dry_run: false } as const;
      await handler.export(request);
      row.artifact_text = 'draft two';
      const second = await handler.export(request);

      const sidecar = JSON.parse(readFileSync(join(root, 'stable-doc-p1.json'), 'utf8')) as Record<string, unknown>;
      expect(sidecar.ground_truth_text).toBe('draft two');
      expect(second).toMatchObject({ exported_documents: 1, exported_pages: 1 });
      expect(existsSync(join(root, 'stable-doc-p2.png'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('worker HTTP route parses and returns the eval shard manifest', async () => {
    let received: unknown;
    const worker = createEmailSourceWorker({
      dropboxEvalShardExport: {
        async export(request) {
          received = request;
          return {
            schema_version: 1,
            kind: 'dropbox_eval_shard_export',
            corpus_id: 'secure_local.dropbox.files',
            account: 'personal',
            scope_key_hash: 'scope-hash',
            out_dir: '/tmp/shard',
            requested_count: 1,
            eligible_pool_documents: 1,
            selected_documents: 1,
            exported_documents: 0,
            exported_pages: 0,
            counts_by_tier: { S4: 1 },
            counts_by_type: { pdf: 1 },
            skipped_documents: [],
            items: [],
            dry_run: true,
            policy: {
              worker_private_surface: true,
              s5_excluded: true,
              blocked_sensitive_excluded: true,
              local_models_allowed: true,
              venice_review_allowed_through_s4: true,
              ground_truth_status: 'draft',
            },
          };
        },
      },
    });
    const response = await worker.fetch(new Request('http://localhost/v1/source/index/dropbox/content/export-eval-shard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved_scope_key: SCOPE, count: 1, out_dir: '/tmp/shard', doc_types: ['pdf'] }),
    }));

    expect(response.status).toBe(200);
    expect(received).toEqual({
      approved_scope_key: SCOPE,
      count: 1,
      out_dir: '/tmp/shard',
      doc_types: ['pdf'],
    });
  });
});

function candidate(
  docIdHash: string,
  overrides: Partial<DropboxEvalShardCandidate> = {},
): DropboxEvalShardCandidate {
  return {
    local_entry_id: Math.max(1, docIdHash.length),
    doc_id_hash: docIdHash,
    provider_file_id: `provider-${docIdHash}`,
    name: `${docIdHash}.pdf`,
    mime_type: 'application/pdf',
    size_bytes: 2_000_000,
    artifact_text: 'Ground truth draft',
    extractor_kind: 'local_text',
    privacy_tier: 'S3',
    privacy_allowed: true,
    privacy_reason: 'privacy_tier_cloud_eligible',
    ...overrides,
  };
}

function connectorCandidate(localItemId: string, locatorUri: string, mimeType: string) {
  return {
    identity: {
      family: 'file' as const,
      provider: 'dropbox',
      accountScope: 'personal',
      providerItemId: `provider-${localItemId}`,
      providerFileId: `provider-${localItemId}`,
      localItemId,
      sourceVersion: `rev-${localItemId}`,
    },
    trustTier: 'S4' as const,
    storedChunks: 1,
    locatorUri,
    mimeType,
    name: locatorUri.split('/').at(-1)!,
  };
}

function fakeIndex(rows: DropboxEvalShardCandidate[]): DropboxEvalShardIndex {
  return {
    evalShardCandidates() { return rows; },
    evalShardPrivacyDecision(localEntryId) {
      const row = rows.find((candidate) => candidate.local_entry_id === localEntryId)!;
      return { allowed: row.privacy_allowed, tier: row.privacy_tier, reason: row.privacy_reason };
    },
  };
}

function mockPdfRunner(commands: Array<{ command: string; args: string[] }>): ExtractionCommandRunner {
  return async (request) => {
    commands.push({ command: request.command, args: request.args });
    if (request.command === 'pdfinfo') return { stdout: 'Pages: 2\n', stderr: '' };
    const outputPrefix = request.args.at(-1)!;
    await writeFile(`${outputPrefix}-1.png`, PNG);
    await writeFile(`${outputPrefix}-2.png`, PNG);
    return { stdout: '', stderr: '' };
  };
}

function mockSinglePagePdfRunner(): ExtractionCommandRunner {
  return async (request) => {
    if (request.command === 'pdfinfo') return { stdout: 'Pages: 1\n', stderr: '' };
    const outputPrefix = request.args.at(-1)!;
    await writeFile(`${outputPrefix}-1.png`, PNG);
    return { stdout: '', stderr: '' };
  };
}
