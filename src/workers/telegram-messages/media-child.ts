// A Telegram message's media as its child item (docs/design/child-items.md;
// docs/design/archive-live-one-dataset.md, section 5): one per message, keyed
// `media`, whichever input brought it. An export's child names the file the
// export's folder holds; a live child names the file the capture helper kept
// beside its spool. Both are listed by name with the means to read the bytes
// later, and each child is judged on its own.

import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CHILD_ITEM_ID_SEPARATOR, childProviderItemId } from '../../core/child-item-id.ts';
import type { RawItem } from '../../core/contracts.ts';
import type { SourceItemIdentity } from '../../core/source-index/types.ts';

// The child's key within its message: Telegram's `media`; its id comes from the one builder (child-item-id.ts).
const TELEGRAM_CHILD_KEY = 'media';
export const TELEGRAM_MEDIA_CHILD_SUFFIX = `${CHILD_ITEM_ID_SEPARATOR}${TELEGRAM_CHILD_KEY}`;

/** The live capture's locator of a kept media file: the file's path under the spool. */
export const TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX = 'telegram-live-media:v1:';
/** The largest kept file the connector hands to a reader at once. */
const LIVE_MEDIA_MAX_READ_BYTES = 64 * 1024 * 1024;
const CAPTURE_MARK = '~at:';

export interface TelegramMediaDescription {
  name: string;
  mimeType?: string;
  /** The field that named it in the export (`photo`, `file`), or the live attachment's kind. */
  kind: string;
}

/** The child of `parent` that its media is. */
export function telegramMediaChild(
  parent: RawItem,
  media: TelegramMediaDescription,
  deferredBytes: RawItem['deferredBytes'],
  options: { version?: string } = {},
): RawItem {
  const providerItemId = childProviderItemId(parent.identity.providerItemId, TELEGRAM_CHILD_KEY);
  const version = options.version ?? parent.identity.sourceVersion;
  const identity: SourceItemIdentity = {
    family: parent.identity.family,
    provider: parent.identity.provider,
    accountScope: parent.identity.accountScope,
    providerItemId,
    ...(parent.identity.providerConversationId ? { providerConversationId: parent.identity.providerConversationId } : {}),
    ...(parent.identity.providerThreadId ? { providerThreadId: parent.identity.providerThreadId } : {}),
    localItemId: `${parent.identity.accountScope}:${parent.identity.providerConversationId}:${providerItemId}`,
    ...(version ? { sourceVersion: version } : {}),
    parent: { providerItemId: parent.identity.providerItemId, localItemId: parent.identity.localItemId },
  };
  const meta = parent.metadata;
  return {
    identity,
    mimeType: media.mimeType ?? 'application/octet-stream',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({
      title: media.name,
      name: media.name,
      chat: meta['title'],
      ...(typeof meta['sentAt'] === 'string' ? { sentAt: meta['sentAt'], authoredAt: meta['sentAt'] } : {}),
      ...(typeof meta['senderId'] === 'string' ? { senderId: meta['senderId'] } : {}),
      ...(typeof meta['senderDisplayName'] === 'string' ? { senderDisplayName: meta['senderDisplayName'], senderLabel: meta['senderDisplayName'] } : {}),
      ...(typeof meta['chatType'] === 'string' ? { chatType: meta['chatType'] } : {}),
      trustDomain: meta['trustDomain'],
      corpusId: meta['corpusId'],
      mediaKind: media.kind,
    }),
    fetchedAt: parent.fetchedAt,
    ...(deferredBytes ? { deferredBytes } : {}),
  };
}

/** The kept file a live locator names, when it is a regular file under the spool's media folder. */
function liveMediaPath(spoolDir: string, locator: string): string | undefined {
  if (!locator.startsWith(TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX)) return undefined;
  const relative = locator.slice(TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX.length);
  if (!/^media\/-?[A-Za-z0-9_]{1,40}\/-?\d{1,20}\.[a-z0-9]{1,5}$/.test(relative)) return undefined;
  const root = resolve(spoolDir, 'media');
  const path = resolve(spoolDir, relative);
  if (!path.startsWith(`${root}${sep}`)) return undefined;
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The child a live message's first attachment is, or none when it has no
 * attachment. A file the helper kept is readable; one it did not keep (too
 * large, a kind it does not keep, a download that failed) is named only, at
 * the version without the capture's mark, so it never takes the place of a
 * readable child an export brought at the same edit time.
 */
export function telegramLiveMediaChild(parent: RawItem, spoolDir: string): RawItem | undefined {
  const attachments = parent.metadata['attachments'];
  const attachment = Array.isArray(attachments) && attachments[0] && typeof attachments[0] === 'object' ? attachments[0] as Record<string, unknown> : undefined;
  if (!attachment) return undefined;
  const kind = typeof attachment.attachmentId === 'string' ? attachment.attachmentId.split(':')[0] ?? 'media' : 'media';
  const name = typeof attachment.name === 'string' && attachment.name.trim()
    ? attachment.name.trim()
    : attachment.type === 'image' ? 'Photo' : 'File';
  const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : attachment.type === 'image' ? 'image/jpeg' : undefined;
  const relative = typeof attachment.mediaFile === 'string' ? attachment.mediaFile : undefined;
  const locator = relative ? `${TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX}${relative}` : undefined;
  const kept = locator ? liveMediaPath(spoolDir, locator) : undefined;
  const size = typeof attachment.sizeBytes === 'number' && Number.isSafeInteger(attachment.sizeBytes) ? attachment.sizeBytes : undefined;
  const description = { name, kind, ...(mimeType ? { mimeType } : {}) };
  if (kept && locator) return telegramMediaChild(parent, description, { locator, available: true, ...(size !== undefined ? { sizeBytes: size } : {}) });
  const unmarked = parent.identity.sourceVersion?.split(CAPTURE_MARK)[0];
  return telegramMediaChild(parent, description, { locator: '', available: false }, unmarked ? { version: unmarked } : {});
}

/** The bytes of a live child, read from its kept file (bounded), with the child itself. */
export function telegramLiveMediaBytes(child: RawItem, spoolDir: string, locator: string): RawItem {
  const path = liveMediaPath(spoolDir, locator);
  if (!path) throw new Error('Telegram no longer has this media file.');
  const size = lstatSync(path).size;
  if (size > LIVE_MEDIA_MAX_READ_BYTES) throw new Error('Telegram media file is larger than one read.');
  const bytes = readFileSync(path);
  return { ...child, content: { kind: 'bytes', mimeType: child.mimeType, bytes: new Uint8Array(bytes) } };
}

/** The kept file of each live child in `localItemIds`' messages, for a Secret to take with it. */
export function telegramLiveMediaFile(spoolDir: string, conversationId: string, messageId: string): string[] {
  const folder = join(spoolDir, 'media', conversationId);
  const found: string[] = [];
  for (const extension of ['.jpg', '.png', '.webp', '.gif', '.pdf', '.ogg', '.mp3', '.mp4', '.txt', '.bin']) {
    const path = join(folder, `${messageId}${extension}`);
    try {
      if (lstatSync(path).isFile()) found.push(path);
    } catch {
      // Not kept under this name.
    }
  }
  return found;
}
