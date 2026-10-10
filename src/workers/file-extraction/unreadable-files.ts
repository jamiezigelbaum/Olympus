/**
 * Which files can't be read, and opening one (owner ruling, 2026-10-10:
 * never say something is wrong without a way to find out exactly what).
 *
 * The list is the readiness ledger's own (readiness-ledger.ts
 * `unreadableItems`): the items its unreadable count is the length of, after
 * the same verdict, so a count and its names come from one decision. Secrets
 * items are never on it (they count with the policy exit).
 *
 * Names go wherever the count goes (ChatGPT included: file names may reach
 * it, only content is Private). Opening a file is the computer's alone: the
 * panel gets a one-time token per file, and this module keeps which item it
 * means. At open time the item is checked again (still unreadable, not
 * Secrets, still served by a store), its locator is read again, and its
 * open target resolved again: a synced copy on this computer opens here (the
 * caller re-checks the path), anything else answers the file's own web page
 * for the panel to open. No path ever reaches the browser, and no path is
 * ever read from a request.
 *
 * Source-neutral: the provider's open target (a Dropbox web preview and its
 * synced copy, a Drive web link) is the composition root's to resolve.
 */
import { randomBytes } from 'node:crypto';
import type { ExtractionItemRef } from './types.ts';
import type { ExtractionUnreadableItem, ExtractionUnreadableVerdict } from './job-store.ts';
import type { TierLedgerIdentity } from '../classification/tier-ledger.ts';

export interface UnreadableFileLocation {
  locatorUri?: string;
  providerConversationId?: string;
}

/** One tier lane's facts the verdict reads: which corpora it serves, its ledger and its secret index. */
export interface UnreadableVerdictLane {
  corpusIds: ReadonlySet<string>;
  ledger: { getCurrent(identity: TierLedgerIdentity): { metadataTier: string; contentTier: string } | undefined };
  secrets?: { get(identity: TierLedgerIdentity): unknown };
}

/**
 * Whether an item extraction gave up on is really unreadable (the readiness
 * counts' ExtractionUnreadableVerdict):
 * - a Secrets item, by its tier ledger row (names or content judged Secrets,
 *   an owner's `olympus tier` override included) or located as a secret by
 *   its lane's secret index, counts with the policy exit: Secrets never
 *   belong in Olympus, so they never show as unreadable, on any host;
 * - an item no store serves any more (removed, or a copy nothing may show)
 *   is left out of the count and the list alike;
 * - anything else is unreadable.
 * Source-neutral: every lane, by corpus.
 */
export function createUnreadableVerdict(input: {
  locate(ref: ExtractionItemRef): UnreadableFileLocation | undefined;
  lanes(): Iterable<UnreadableVerdictLane>;
}): (item: ExtractionUnreadableItem) => ExtractionUnreadableVerdict {
  return (item) => {
    const located = input.locate(item.ref);
    const identity: TierLedgerIdentity = {
      provider: item.ref.provider,
      accountScope: item.ref.accountScope,
      providerItemId: item.ref.providerItemId,
      ...(located?.providerConversationId ? { providerConversationId: located.providerConversationId } : {}),
    };
    for (const lane of input.lanes()) {
      if (!lane.corpusIds.has(item.ref.corpusId)) continue;
      const record = lane.ledger.getCurrent(identity);
      if (record && (record.metadataTier === 'secrets' || record.contentTier === 'secrets')) return 'blocked_policy';
      if (lane.secrets?.get(identity) !== undefined) return 'blocked_policy';
    }
    return located ? 'unreadable' : 'hidden';
  };
}

export interface UnreadableFilesOptions {
  /** The ledger's list for one corpus, newest failure first. */
  items(corpusId: string): readonly ExtractionUnreadableItem[];
  /** The verdict the counts use, asked again before a file opens. */
  verdict(item: ExtractionUnreadableItem): ExtractionUnreadableVerdict;
  /** Where the item lives now, with tier-copy visibility applied; undefined when no store serves it. */
  locate(ref: ExtractionItemRef): UnreadableFileLocation | undefined;
  /** The provider's open target for a locator: its web page (https) and, when synced here, a local path. */
  openTarget(provider: string, locator: string): { url?: string; localPath?: string } | undefined;
  /** Opens a local path on this computer, re-checking it first. Absent: synced copies are not opened here. */
  openFile?(path: string): Promise<void>;
  now?: () => number;
  /** How long a token stays good after the list that carried it was last read. */
  tokenTtlMs?: number;
}

export type UnreadableOpenResult =
  | { status: 'opened' }
  | { status: 'open_link'; url: string }
  | { status: 'invalid' }
  | { status: 'gone' }
  | { status: 'rate_limited' }
  | { status: 'failed' };

export interface UnreadableFileEntry {
  name: string;
  /** Present when the file has a place to open: the one-time capability the open tool takes. */
  token?: string;
}

export interface UnreadableFiles {
  /** The newest unreadable files' names across these corpora, newest failure first. */
  names(corpusIds: readonly string[], limit: number): string[];
  /** The computer's list: up to `limit` files with open tokens, and how many more there are. */
  computerList(corpusIds: readonly string[], limit: number): { files: UnreadableFileEntry[]; more: number };
  /** Opens the file a token from computerList names. */
  open(token: unknown): Promise<UnreadableOpenResult>;
}

/** 32 random bytes, base64url. */
export const UNREADABLE_OPEN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;
/** Outstanding tokens across every list; the oldest go first. */
const MAX_TOKENS = 2_000;
/** A burst of opens, then one a second. */
const OPEN_RATE = { capacity: 10, refillPerSecond: 1 };
const UNNAMED = 'Unnamed file';

interface TokenEntry {
  key: string;
  item: ExtractionUnreadableItem;
  expiresAt: number;
}

export function createUnreadableFiles(options: UnreadableFilesOptions): UnreadableFiles {
  const now = options.now ?? Date.now;
  const ttl = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const byToken = new Map<string, TokenEntry>();
  const tokenByKey = new Map<string, string>();
  let bucket = OPEN_RATE.capacity;
  let refilledAt = now();

  const keyOf = (ref: ExtractionItemRef) => `${ref.corpusId}\u0000${ref.localItemId}`;

  function merged(corpusIds: readonly string[]): ExtractionUnreadableItem[] {
    const seen = new Set<string>();
    const out: ExtractionUnreadableItem[] = [];
    for (const corpusId of new Set(corpusIds)) {
      let items: readonly ExtractionUnreadableItem[];
      try {
        items = options.items(corpusId);
      } catch {
        items = [];
      }
      for (const item of items) {
        const key = keyOf(item.ref);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
    }
    return out.sort((a, b) => (a.failedAt === b.failedAt ? 0 : a.failedAt < b.failedAt ? 1 : -1));
  }

  function locator(item: ExtractionUnreadableItem): string | undefined {
    try {
      return options.locate(item.ref)?.locatorUri;
    } catch {
      return undefined;
    }
  }

  function displayName(item: ExtractionUnreadableItem): string {
    const named = item.ref.name?.trim();
    if (named) return named;
    // No name captured at enqueue: the last segment of a path locator, never a web address.
    const path = locator(item);
    if (path && !/^[a-z][a-z0-9+.-]*:/i.test(path)) {
      const last = path.split('/').filter(Boolean).at(-1);
      if (last) return last;
    }
    return UNNAMED;
  }

  function target(item: ExtractionUnreadableItem): { url?: string; localPath?: string } | undefined {
    const found = locator(item);
    if (!found) return undefined;
    try {
      const resolved = options.openTarget(item.ref.provider, found);
      if (!resolved) return undefined;
      const url = resolved.url && /^https:\/\//.test(resolved.url) ? resolved.url : undefined;
      const localPath = options.openFile ? resolved.localPath : undefined;
      return url || localPath ? { ...(url ? { url } : {}), ...(localPath ? { localPath } : {}) } : undefined;
    } catch {
      return undefined;
    }
  }

  function sweep(at: number): void {
    for (const [token, entry] of byToken) {
      if (entry.expiresAt > at) continue;
      byToken.delete(token);
      if (tokenByKey.get(entry.key) === token) tokenByKey.delete(entry.key);
    }
  }

  function mint(item: ExtractionUnreadableItem, at: number): string {
    const key = keyOf(item.ref);
    const existing = tokenByKey.get(key);
    const entry = existing ? byToken.get(existing) : undefined;
    if (existing && entry) {
      // Read again: the same token, good for another window.
      byToken.delete(existing);
      byToken.set(existing, { key, item, expiresAt: at + ttl });
      return existing;
    }
    const token = randomBytes(32).toString('base64url');
    byToken.set(token, { key, item, expiresAt: at + ttl });
    tokenByKey.set(key, token);
    while (byToken.size > MAX_TOKENS) {
      const [oldest, old] = byToken.entries().next().value as [string, TokenEntry];
      byToken.delete(oldest);
      if (tokenByKey.get(old.key) === oldest) tokenByKey.delete(old.key);
    }
    return token;
  }

  function takeOpen(at: number): boolean {
    bucket = Math.min(OPEN_RATE.capacity, bucket + ((at - refilledAt) / 1000) * OPEN_RATE.refillPerSecond);
    refilledAt = at;
    if (bucket < 1) return false;
    bucket -= 1;
    return true;
  }

  return {
    names(corpusIds, limit) {
      return merged(corpusIds).slice(0, Math.max(0, limit)).map(displayName);
    },

    computerList(corpusIds, limit) {
      const at = now();
      sweep(at);
      const all = merged(corpusIds);
      const shown = all.slice(0, Math.max(0, limit));
      const files = shown.map((item): UnreadableFileEntry => {
        const name = displayName(item);
        return target(item) ? { name, token: mint(item, at) } : { name };
      });
      return { files, more: all.length - shown.length };
    },

    async open(token) {
      if (typeof token !== 'string' || !UNREADABLE_OPEN_TOKEN_PATTERN.test(token)) return { status: 'invalid' };
      const at = now();
      sweep(at);
      const entry = byToken.get(token);
      if (!entry) return { status: 'gone' };
      if (!takeOpen(at)) return { status: 'rate_limited' };
      // Checked again now: a file that became Secrets, or that no store
      // serves any more, never opens from an older list.
      let verdict: ExtractionUnreadableVerdict;
      try {
        verdict = options.verdict(entry.item);
      } catch {
        verdict = 'blocked_policy';
      }
      if (verdict !== 'unreadable') {
        byToken.delete(token);
        if (tokenByKey.get(entry.key) === token) tokenByKey.delete(entry.key);
        return { status: 'gone' };
      }
      const resolved = target(entry.item);
      if (!resolved) return { status: 'gone' };
      if (resolved.localPath && options.openFile) {
        try {
          await options.openFile(resolved.localPath);
          return { status: 'opened' };
        } catch {
          // The synced copy would not open (moved, or refused on the re-check): its web page, if it has one.
          if (!resolved.url) return { status: 'failed' };
        }
      }
      return resolved.url ? { status: 'open_link', url: resolved.url } : { status: 'gone' };
    },
  };
}
