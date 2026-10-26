// A Telegram message's media as its child item (docs/design/child-items.md;
// docs/design/archive-live-one-dataset.md, section 5): one per message, keyed
// `media`, whichever input brought it. An export's child names the file the
// export's folder holds; a live child names the file the capture helper kept
// beside its spool. Both are listed by name with the means to read the bytes
// later, and each child is judged on its own.

import { lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  /** Why the capture helper kept no file for it: over the size limit, or the media quota was full. */
  leftOut?: TelegramMediaLeftOut;
}

export type TelegramMediaLeftOut = 'too_large' | 'storage_full';

/** The helper's account of the media it keeps (`.capture-media.json` beside the spool). */
export interface TelegramMediaState {
  storedBytes: number;
  quotaBytes: number;
  /** New media is named only, never kept, until room is made or the quota is raised; nothing is evicted. */
  storageFull: boolean;
  /** Media named only for want of room since the store was last not full. */
  leftOutItems: number;
  /** What was kept and reserved when the last download was refused; fewer bytes kept now means room was made. */
  refusedWithBytes?: number;
}

const MEDIA_STATE_FILE = '.capture-media.json';
const MAX_MEDIA_STATE_BYTES = 4096;
// A download in progress: `.<final name>.tmp.<pid>` (telegram-telethon-reader.py).
const TEMPORARY_MARK = '.tmp.';

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
      ...(media.leftOut ? { mediaLeftOut: media.leftOut } : {}),
    }),
    fetchedAt: parent.fetchedAt,
    ...(deferredBytes ? { deferredBytes } : {}),
  };
}

/** The kept file a live locator names, when it is a regular file under the spool's media folder. */
function liveMediaPath(spoolDir: string, locator: string): string | undefined {
  if (!locator.startsWith(TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX)) return undefined;
  const relative = locator.slice(TELEGRAM_LIVE_MEDIA_LOCATOR_PREFIX.length);
  // `<message>.<tag><ext>`: the tag says which file the message carried (Telegram's id, access hash, size, date).
  if (!/^media\/-?[A-Za-z0-9_]{1,40}\/-?\d{1,20}\.[0-9a-f]{12}\.[a-z0-9]{1,5}$/.test(relative)) return undefined;
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
  const leftOut: TelegramMediaLeftOut | undefined = attachment.mediaLeftOut === 'too_large' || attachment.mediaLeftOut === 'storage_full' ? attachment.mediaLeftOut : undefined;
  const description = { name, kind, ...(mimeType ? { mimeType } : {}), ...(leftOut ? { leftOut } : {}) };
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

/**
 * Every file the helper kept for a message, and every download of it in
 * progress or left behind: what a Secret takes with it. A changed attachment
 * is a new name, so all of the message's names are found, not one.
 */
export function telegramLiveMediaFile(spoolDir: string, conversationId: string, messageId: string): string[] {
  if (!/^-?[A-Za-z0-9_]{1,40}$/.test(conversationId) || !/^-?\d{1,20}$/.test(messageId)) return [];
  const folder = join(spoolDir, 'media', conversationId);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(`${messageId}.`) || (name.startsWith(`.${messageId}.`) && name.includes(TEMPORARY_MARK)))
    .map((name) => join(folder, name))
    .filter((path) => {
      try {
        return lstatSync(path).isFile();
      } catch {
        return false;
      }
    });
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove the downloads a stopped helper left half written: no locator names them. Returns how many. */
export function sweepTelegramMediaTemporaries(spoolDir: string): number {
  const root = join(spoolDir, 'media');
  let removed = 0;
  let chats: string[];
  try {
    chats = readdirSync(root);
  } catch {
    return 0;
  }
  for (const chat of chats) {
    const folder = join(root, chat);
    let names: string[];
    try {
      if (!lstatSync(folder).isDirectory()) continue;
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('.') || !name.includes(TEMPORARY_MARK)) continue;
      const owner = Number(name.slice(name.lastIndexOf(TEMPORARY_MARK) + TEMPORARY_MARK.length));
      if (Number.isSafeInteger(owner) && owner > 0 && processIsRunning(owner)) continue;
      rmSync(join(folder, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** The bytes of the files kept under the spool's media folder, measured now; downloads in progress are not kept files. */
export function telegramKeptMediaBytes(spoolDir: string): number {
  const root = join(spoolDir, 'media');
  let total = 0;
  let chats: string[];
  try {
    chats = readdirSync(root);
  } catch {
    return 0;
  }
  for (const chat of chats) {
    const folder = join(root, chat);
    let names: string[];
    try {
      if (!lstatSync(folder).isDirectory()) continue;
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') && name.includes(TEMPORARY_MARK)) continue;
      try {
        const stat = lstatSync(join(folder, name));
        if (stat.isFile()) total += stat.size;
      } catch {
        // Removed while measured.
      }
    }
  }
  return total;
}

/**
 * The media account as it stands now, for each pull. The helper's file says
 * whether a download was refused and with how much kept; what is kept is
 * measured again here, so room made since (files removed, a Secret's files
 * taken) clears the full state at the next pull instead of at the next
 * download. Full while what is kept reaches the quota, or while a refusal
 * stands and nothing has been freed since it. Media already left out stays
 * named only; the count is of media left out since the store last filled.
 */
export function telegramMediaStateNow(spoolDir: string): TelegramMediaState | undefined {
  const state = readTelegramMediaState(spoolDir);
  if (!state || state.quotaBytes <= 0) return state;
  const kept = telegramKeptMediaBytes(spoolDir);
  const refusalStands = state.storageFull && kept >= (state.refusedWithBytes ?? state.storedBytes);
  const storageFull = kept >= state.quotaBytes || refusalStands;
  return { storedBytes: kept, quotaBytes: state.quotaBytes, storageFull, leftOutItems: refusalStands ? state.leftOutItems : 0 };
}

/** The helper's media account, or undefined when it has written none. */
export function readTelegramMediaState(spoolDir: string): TelegramMediaState | undefined {
  try {
    const path = join(spoolDir, MEDIA_STATE_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_MEDIA_STATE_BYTES) return undefined;
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (value.kind !== 'telegram_capture_media' || value.schema_version !== 1) return undefined;
    const count = (field: unknown) => (typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : 0);
    const storageFull = value.storage_full === true;
    return {
      storedBytes: count(value.stored_bytes),
      quotaBytes: count(value.quota_bytes),
      storageFull,
      leftOutItems: storageFull ? count(value.left_out_items) : 0,
      ...(storageFull && typeof value.refused_with_bytes === 'number' ? { refusedWithBytes: count(value.refused_with_bytes) } : {}),
    };
  } catch {
    return undefined;
  }
}
