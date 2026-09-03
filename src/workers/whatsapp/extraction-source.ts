/**
 * WhatsApp's thin side of the shared file-extraction seam.
 *
 * Capture has already downloaded media onto this host. This adapter enumerates
 * unrepresented audio from the connector store and reads the local bytes; the
 * shared registry, queue, runner and sink own every step after that boundary.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import {
  FileExtractionSourceError,
  type ExtractionCandidateReader,
  type ExtractionCandidateRow,
} from '../../core/file-extraction-source.ts';
import type {
  ExtractionCandidateListOptions,
  ExtractionCandidatePage,
  ExtractionFetchOptions,
  ExtractionItemRef,
  FetchedBytes,
  FileExtractionSource,
} from '../file-extraction/types.ts';

const MEDIA_MIME_FILTERS: readonly string[] = ['audio/*', 'video/*'];

export interface WhatsAppExtractionLocatorReader {
  localContent(
    localItemId: string,
    maxChars?: number,
  ): { locatorUri?: string } | undefined | Promise<{ locatorUri?: string } | undefined>;
}

export interface WhatsAppExtractionSourceOptions {
  id: string;
  corpusId: string;
  provider: string;
  accountScope: string;
  approvedScopeKey: string;
  candidates: ExtractionCandidateReader;
  locators: WhatsAppExtractionLocatorReader;
  mediaRoots: readonly string[];
}

export class WhatsAppExtractionSource implements FileExtractionSource {
  readonly id: string;
  readonly corpusId: string;
  readonly provider: string;

  private readonly accountScope: string;
  private readonly approvedScopeKey: string;
  private readonly candidates: ExtractionCandidateReader;
  private readonly locators: WhatsAppExtractionLocatorReader;
  private readonly mediaRoots: readonly string[];

  constructor(options: WhatsAppExtractionSourceOptions) {
    this.id = requireNonEmpty(options.id, 'WhatsApp extraction source id');
    this.corpusId = requireNonEmpty(options.corpusId, 'WhatsApp extraction corpus id');
    this.provider = requireNonEmpty(options.provider, 'WhatsApp extraction provider');
    this.accountScope = requireNonEmpty(options.accountScope, 'WhatsApp extraction account scope');
    this.approvedScopeKey = requireNonEmpty(options.approvedScopeKey, 'WhatsApp extraction scope key');
    this.candidates = options.candidates;
    this.locators = options.locators;
    this.mediaRoots = options.mediaRoots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => resolve(root));
    if (this.mediaRoots.length === 0) {
      throw new Error('WhatsApp extraction needs at least one local media root.');
    }
  }

  async listCandidates(options: ExtractionCandidateListOptions): Promise<ExtractionCandidatePage> {
    if (
      options.approvedScopeKeys
      && !options.approvedScopeKeys.includes(this.approvedScopeKey)
    ) return { candidates: [], done: true };

    const page = await this.candidates.extractionCandidates({
      limit: options.limit,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      mimeTypes: options.mimeTypes ?? MEDIA_MIME_FILTERS,
      accountScope: this.accountScope,
      withoutChunksOnly: true,
    });
    return {
      candidates: page.candidates
        .map((row) => this.refFromRow(row))
        .filter((ref): ref is ExtractionItemRef => ref !== undefined),
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      done: page.done,
    };
  }

  async fetch(ref: ExtractionItemRef, options: ExtractionFetchOptions): Promise<FetchedBytes> {
    const located = await this.locators.localContent(ref.localItemId, 1);
    const locator = located?.locatorUri?.trim();
    if (!locator) throw new FileExtractionSourceError('source_item_not_found');

    try {
      const path = await realpath(locator);
      if (!(await this.pathIsInsideMediaRoot(path))) {
        throw new FileExtractionSourceError('source_permission_denied');
      }
      const file = await stat(path);
      if (!file.isFile()) throw new FileExtractionSourceError('source_content_unavailable');
      if (options.maxBytes !== undefined && file.size > options.maxBytes) {
        throw new FileExtractionSourceError('source_too_large');
      }
      return {
        bytes: await readFile(path),
        ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
        sizeBytes: file.size,
      };
    } catch (error) {
      if (error instanceof FileExtractionSourceError) throw error;
      const code = nodeErrorCode(error);
      if (code === 'ENOENT') throw new FileExtractionSourceError('source_item_not_found');
      if (code === 'EACCES' || code === 'EPERM') {
        throw new FileExtractionSourceError('source_permission_denied');
      }
      throw new FileExtractionSourceError('source_unavailable');
    }
  }

  private refFromRow(row: ExtractionCandidateRow): ExtractionItemRef | undefined {
    if (
      row.provider !== this.provider
      || row.accountScope !== this.accountScope
      || !row.providerItemId
      || !row.locatorUri
    ) return undefined;
    return {
      corpusId: this.corpusId,
      provider: this.provider,
      accountScope: this.accountScope,
      approvedScopeKey: this.approvedScopeKey,
      providerItemId: row.providerItemId,
      localItemId: row.localItemId,
      ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
      ...(row.mimeType ? { mimeType: row.mimeType } : {}),
      name: basename(row.locatorUri),
    };
  }

  private async pathIsInsideMediaRoot(path: string): Promise<boolean> {
    for (const configuredRoot of this.mediaRoots) {
      let root: string;
      try {
        root = await realpath(configuredRoot);
      } catch {
        continue;
      }
      const fromRoot = relative(root, path);
      if (fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..')) return true;
    }
    return false;
  }
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be non-empty.`);
  return normalized;
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
