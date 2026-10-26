/**
 * WhatsApp's thin side of the shared file-extraction seam.
 *
 * Capture has already downloaded media onto this host. This adapter enumerates
 * unrepresented audio from the connector store and reads the local bytes; the
 * shared registry, queue, runner and sink own every step after that boundary.
 *
 * A child (a picture or video live capture saved, or a file an imported export
 * carries) is listed with the others and read by the locator the store keeps
 * for it, through the account's child reader (child-media.ts).
 *
 * Every piece of media is kept, whatever its size (owner, 2026-10-26), so a
 * reader that takes a file is handed one (`fetchFile`): the media is copied
 * from the descriptor the confinement check opened into the runner's spool,
 * a chunk at a time, never held whole in memory.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { closeSync, constants, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { DeferredBytesAnswer } from '../file-extraction/connector-source.ts';
import {
  discardExtractionSpoolFile,
  extractionSpoolFileName,
  extractionSpoolOwnerDir,
  makeExtractionSpoolOwnerDir,
  pruneExtractionSpoolOwner,
} from '../file-extraction/spool.ts';
import { withConfinedFile, type WhatsAppChildReader } from './child-media.ts';
import { CHILD_ITEM_ID_SEPARATOR } from '../../core/child-item-id.ts';
import {
  FileExtractionSourceError,
  type ExtractionCandidateReader,
  type ExtractionCandidateRow,
} from '../../core/file-extraction-source.ts';
import type {
  ExtractionCandidateListOptions,
  ExtractionCandidatePage,
  ExtractionFetchFileOptions,
  ExtractionFetchOptions,
  ExtractionItemRef,
  FetchedBytes,
  FetchedFile,
  FileExtractionSource,
} from '../file-extraction/types.ts';

const MEDIA_MIME_FILTERS: readonly string[] = ['audio/*', 'video/*', 'image/*', 'application/pdf'];

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
  /**
   * Maps a locator that names the account's old state folder to the same file
   * in its account folder, for an account the boot migration moved
   * (core/source-placement.ts, `whatsappMovedPathMapper`). The stored locator stays.
   */
  relocateLocator?: (path: string) => string;
  /** What the store keeps of a child's bytes (`deferredBytesAnswerFor` of the store's state). */
  deferredBytes?: (ref: ExtractionItemRef) => DeferredBytesAnswer;
  /** Reads a child's bytes by its locator. Without it, children are not offered. */
  readChild?: WhatsAppChildReader;
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
  private readonly relocateLocator: (path: string) => string;
  private readonly deferredBytes: ((ref: ExtractionItemRef) => DeferredBytesAnswer) | undefined;
  private readonly readChild: WhatsAppChildReader | undefined;

  constructor(options: WhatsAppExtractionSourceOptions) {
    this.deferredBytes = options.deferredBytes;
    this.readChild = options.readChild;
    this.relocateLocator = options.relocateLocator ?? ((path) => path);
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
    if (ref.providerItemId?.includes(CHILD_ITEM_ID_SEPARATOR) === true) return this.fetchChild(ref, options);
    const located = await this.locators.localContent(ref.localItemId, 1);
    const locator = located?.locatorUri?.trim();
    if (!locator) throw new FileExtractionSourceError('source_item_not_found');

    try {
      const path = await realpath(this.relocateLocator(locator));
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

  /**
   * The item as a file in the runner's spool, copied a chunk at a time from
   * the descriptor the confinement check opened: a child through the child
   * reader, a voice note under the media folders. Removed by `dispose`.
   */
  async fetchFile(ref: ExtractionItemRef, options: ExtractionFetchFileOptions): Promise<FetchedFile> {
    const child = ref.providerItemId?.includes(CHILD_ITEM_ID_SEPARATOR) === true;
    let copy: (dest: string) => number;
    if (child) {
      if (!this.deferredBytes || !this.readChild) throw new FileExtractionSourceError('source_item_not_found');
      const answer = this.deferredBytes(ref);
      if (answer === undefined) throw new FileExtractionSourceError('source_item_not_found');
      if ('refusal' in answer) throw new FileExtractionSourceError(answer.refusal);
      if (options.maxBytes !== undefined && answer.sizeBytes !== undefined && answer.sizeBytes > options.maxBytes) {
        throw new FileExtractionSourceError('source_too_large');
      }
      const readChild = this.readChild;
      copy = (dest) => readChild.toFile(answer.locator, options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}, dest);
    } else {
      const located = await this.locators.localContent(ref.localItemId, 1);
      const locator = located?.locatorUri?.trim();
      if (!locator) throw new FileExtractionSourceError('source_item_not_found');
      const path = this.relocateLocator(locator);
      copy = (dest) => withConfinedFile(path, this.mediaRoots, options.maxBytes, (fd, size) => copyDescriptor(fd, size, dest));
    }
    const owner = { corpusId: this.corpusId, accountScope: ref.accountScope };
    const ownerDir = extractionSpoolOwnerDir(options.spoolDir, owner);
    makeExtractionSpoolOwnerDir(ownerDir, options.spoolAnchor);
    const dest = join(ownerDir, extractionSpoolFileName());
    let sizeBytes: number;
    try {
      sizeBytes = copy(dest);
    } catch (error) {
      discardExtractionSpoolFile(dest, ownerDir);
      throw error;
    }
    return {
      path: dest,
      ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
      sizeBytes,
      dispose: async () => {
        rmSync(dest, { force: true });
        pruneExtractionSpoolOwner(options.spoolDir, owner);
      },
    };
  }

  /** A child's bytes, by the locator the store keeps for it at this version. */
  private fetchChild(ref: ExtractionItemRef, options: ExtractionFetchOptions): FetchedBytes {
    if (!this.deferredBytes || !this.readChild) throw new FileExtractionSourceError('source_item_not_found');
    const answer = this.deferredBytes(ref);
    if (answer === undefined) throw new FileExtractionSourceError('source_item_not_found');
    if ('refusal' in answer) throw new FileExtractionSourceError(answer.refusal);
    if (options.maxBytes !== undefined && answer.sizeBytes !== undefined && answer.sizeBytes > options.maxBytes) {
      throw new FileExtractionSourceError('source_too_large');
    }
    const bytes = this.readChild(answer.locator, { ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
    return { bytes, ...(ref.mimeType ? { mimeType: ref.mimeType } : {}), sizeBytes: bytes.byteLength };
  }

  private refFromRow(row: ExtractionCandidateRow): ExtractionItemRef | undefined {
    const child = row.providerItemId?.includes(CHILD_ITEM_ID_SEPARATOR) === true;
    if (
      row.provider !== this.provider
      || row.accountScope !== this.accountScope
      || !row.providerItemId
      || (child ? !this.readChild || !this.deferredBytes : !row.locatorUri)
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
      name: row.locatorUri ? basename(row.locatorUri) : row.name ?? 'media',
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

/** Copies `size` bytes of an open file to a new file at `dest`, a chunk at a time. */
function copyDescriptor(fd: number, size: number, dest: string): number {
  const out = openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  let total = 0;
  try {
    while (total < size) {
      const read = readSync(fd, chunk, 0, Math.min(chunk.length, size - total), total);
      if (read === 0) break;
      writeSync(out, chunk, 0, read);
      total += read;
    }
  } finally {
    closeSync(out);
  }
  return total;
}

