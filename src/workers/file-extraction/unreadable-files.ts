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
 * Source-neutral: the provider's open target (a web page, and a synced copy
 * on this computer) is the composition root's to resolve.
 */
import { randomBytes } from 'node:crypto';
import type { ExtractionItemRef } from './types.ts';
import type { ExtractionUnreadableItem, ExtractionUnreadableVerdict } from './job-store.ts';
import type { TierLedgerIdentity } from '../classification/tier-ledger.ts';

export interface UnreadableFileLocation {
  locatorUri?: string;
  providerConversationId?: string;
}

/**
 * One tier lane's facts the verdict reads: which corpora it serves, its ledger and its secret index.
 */
export interface UnreadableVerdictLane {
  corpusIds: ReadonlySet<string>;
  ledger: {
    getCurrent(identity: TierLedgerIdentity): { metadataTier: string; contentTier: string } | undefined;
    /**
     * The owner's persisted `olympus tier set` override. A Secrets one counts
     * at once, before the next sync re-decides a routed item's record.
     */
    getOverride?(identity: TierLedgerIdentity): { kind: string; tier?: string } | undefined;
  };
  secrets?: { get(identity: TierLedgerIdentity): unknown };
}

/**
 * Whether an item extraction gave up on is really unreadable (the readiness
 * counts' ExtractionUnreadableVerdict):
 * - a Secrets item, by its tier ledger row (names or content judged Secrets),
 *   by the owner's persisted `olympus tier set … secrets` override (read
 *   directly: for a routed item the record only follows at the next sync), or
 *   located as a secret by its lane's secret index, counts with the policy
 *   exit: Secrets never
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
      const override = lane.ledger.getOverride?.(identity);
      if (override?.kind === 'tier' && override.tier === 'secrets') return 'blocked_policy';
      if (lane.secrets?.get(identity) !== undefined) return 'blocked_policy';
    }
    return located ? 'unreadable' : 'hidden';
  };
}

export interface UnreadableFilesOptions {
  /**
   * The ledger's list for one corpus, newest failure first.
   */
  items(corpusId: string): readonly ExtractionUnreadableItem[];
  /**
   * The verdict the counts use, asked again before a file opens.
   */
  verdict(item: ExtractionUnreadableItem): ExtractionUnreadableVerdict;
  /**
   * Where the item lives now, with tier-copy visibility applied; undefined when no store serves it.
   */
  locate(ref: ExtractionItemRef): UnreadableFileLocation | undefined;
  /**
   * The provider's open target for a locator: its web page (https) and, when synced here, a local path.
   */
  openTarget(provider: string, locator: string): { url?: string; localPath?: string } | undefined;
  /**
   * Opens a local path on this computer, re-checking it first. Absent: synced copies are not opened here.
   */
  openFile?(path: string): Promise<void>;
  now?: () => number;
  /**
   * How long a token stays good from when it was issued (absolute: reading the list again never extends it).
   */
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
  /**
   * Present when the file has a place to open: the one-time capability the open tool takes.
   */
  token?: string;
}

/**
 * One corpus's unreadable count checked again now: how many of the items its
 * last snapshot counted are still unreadable, and how many have since become
 * Secrets (they move to the policy exit).
 */
export interface UnreadableRecheck {
  unreadable: number;
  blocked: number;
}

export interface UnreadableFiles {
  /**
   * The corpus's last counted list, each verdict asked again now: the count a
   * dashboard publishes beside the names, so neither lags a Secrets change.
   */
  recheck(corpusId: string): UnreadableRecheck;
  /**
   * The newest unreadable files' names across these corpora, newest failure first (verdicts asked again now).
   */
  names(corpusIds: readonly string[], limit: number): string[];
  /**
   * The computer's list from `offset`: up to `limit` files, and how many more
   * there are after them. Only with an `opener` (an unlocked control session,
   * or the worker bearer) does a file carry an open token, bound to that opener.
   */
  computerList(
    corpusIds: readonly string[],
    limit: number,
    options?: { offset?: number; opener?: string },
  ): { files: UnreadableFileEntry[]; more: number };
  /**
   * Opens the file a token from computerList names, for the opener it was issued to. A token opens once.
   */
  open(token: unknown, opener?: string): Promise<UnreadableOpenResult>;
}

const TOKEN_LENGTH = 43;
const TOKEN_ALPHABET = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_');

/**
 * Whether a value has the shape of an open token: 32 random bytes, base64url.
 */
export function isUnreadableOpenToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === TOKEN_LENGTH && Array.from(value).every((char) => TOKEN_ALPHABET.has(char));
}

const DEFAULT_TOKEN_TTL_MS = 30 * 60_000;
/**
 * Outstanding tokens across every list; the oldest go first.
 */
const MAX_TOKENS = 2_000;
/**
 * A burst of opens, then one a second.
 */
const OPEN_RATE = { capacity: 10, refillPerSecond: 1 };
const UNNAMED = 'Unnamed file';

/**
 * A verdict asked within this long is reused: one dashboard read asks for the
 * count, the names and the computer's list of the same items.
 */
const VERDICT_REUSE_MS = 1_000;

interface TokenEntry {
  /** The opener and the item: one live token per pair. */
  slot: string;
  opener: string;
  item: ExtractionUnreadableItem;
  expiresAt: number;
}

export function createUnreadableFiles(options: UnreadableFilesOptions): UnreadableFiles {
  const now = options.now ?? Date.now;
  const ttl = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const byToken = new Map<string, TokenEntry>();
  const tokenBySlot = new Map<string, string>();
  const verdicts = new Map<string, { verdict: ExtractionUnreadableVerdict; at: number }>();
  let bucket = OPEN_RATE.capacity;
  let refilledAt = now();

  const keyOf = (ref: ExtractionItemRef) => `${ref.corpusId}\u0000${ref.localItemId}`;

  /** The verdict now (a throw counts as Secrets), reused for VERDICT_REUSE_MS. */
  function verdictOf(item: ExtractionUnreadableItem, at: number): ExtractionUnreadableVerdict {
    const key = keyOf(item.ref);
    const known = verdicts.get(key);
    if (known && at - known.at < VERDICT_REUSE_MS && at >= known.at) return known.verdict;
    let verdict: ExtractionUnreadableVerdict;
    try {
      verdict = options.verdict(item);
    } catch {
      verdict = 'blocked_policy';
    }
    verdicts.set(key, { verdict, at });
    if (verdicts.size > MAX_TOKENS) verdicts.delete(verdicts.keys().next().value as string);
    return verdict;
  }

  function listed(corpusId: string): readonly ExtractionUnreadableItem[] {
    try {
      return options.items(corpusId);
    } catch {
      return [];
    }
  }

  /** The counted items across these corpora still unreadable now, newest failure first. */
  function current(corpusIds: readonly string[], at: number): ExtractionUnreadableItem[] {
    return merged(corpusIds).filter((item) => verdictOf(item, at) === 'unreadable');
  }

  function merged(corpusIds: readonly string[]): ExtractionUnreadableItem[] {
    const seen = new Set<string>();
    const out: ExtractionUnreadableItem[] = [];
    for (const corpusId of new Set(corpusIds)) {
      for (const item of listed(corpusId)) {
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
    if (path && path.startsWith('/')) {
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
      const url = resolved.url && resolved.url.startsWith('https://') ? resolved.url : undefined;
      const localPath = options.openFile ? resolved.localPath : undefined;
      return url || localPath ? { ...(url ? { url } : {}), ...(localPath ? { localPath } : {}) } : undefined;
    } catch {
      return undefined;
    }
  }

  function drop(token: string, entry: TokenEntry): void {
    byToken.delete(token);
    if (tokenBySlot.get(entry.slot) === token) tokenBySlot.delete(entry.slot);
  }

  function sweep(at: number): void {
    for (const [token, entry] of byToken) {
      if (entry.expiresAt <= at) drop(token, entry);
    }
  }

  /**
   * The opener's live token for this item, else a new one. Never renewed: a
   * token's life runs from when it was issued, however often the list is read.
   */
  function mint(item: ExtractionUnreadableItem, opener: string, at: number): string {
    const slot = `${opener}\u0000${keyOf(item.ref)}`;
    const existing = tokenBySlot.get(slot);
    if (existing && byToken.has(existing)) {
      byToken.get(existing)!.item = item;
      return existing;
    }
    const token = randomBytes(32).toString('base64url');
    byToken.set(token, { slot, opener, item, expiresAt: at + ttl });
    tokenBySlot.set(slot, token);
    while (byToken.size > MAX_TOKENS) {
      const [oldest, old] = byToken.entries().next().value as [string, TokenEntry];
      drop(oldest, old);
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
    recheck(corpusId) {
      const at = now();
      let unreadable = 0;
      let blocked = 0;
      for (const item of listed(corpusId)) {
        const verdict = verdictOf(item, at);
        if (verdict === 'unreadable') unreadable += 1;
        else if (verdict === 'blocked_policy') blocked += 1;
      }
      return { unreadable, blocked };
    },

    names(corpusIds, limit) {
      return current(corpusIds, now()).slice(0, Math.max(0, limit)).map(displayName);
    },

    computerList(corpusIds, limit, list = {}) {
      const at = now();
      sweep(at);
      const all = current(corpusIds, at);
      const offset = Math.max(0, Math.trunc(list.offset ?? 0));
      const shown = all.slice(offset, offset + Math.max(0, limit));
      const opener = list.opener;
      const files = shown.map((item): UnreadableFileEntry => {
        const name = displayName(item);
        return opener && target(item) ? { name, token: mint(item, opener, at) } : { name };
      });
      return { files, more: Math.max(0, all.length - offset - shown.length) };
    },

    async open(token, opener) {
      if (!isUnreadableOpenToken(token)) return { status: 'invalid' };
      const at = now();
      sweep(at);
      const entry = byToken.get(token);
      // Another opener's token is no token here (and stays theirs).
      if (!entry || !opener || entry.opener !== opener) return { status: 'gone' };
      if (!takeOpen(at)) return { status: 'rate_limited' };
      // Spent now, before anything waits: a token opens once, and a second
      // call racing this one finds nothing.
      drop(token, entry);
      // Checked again now (never a reused verdict): a file that became
      // Secrets, or that no store serves any more, never opens from an older list.
      verdicts.delete(keyOf(entry.item.ref));
      if (verdictOf(entry.item, at) !== 'unreadable') return { status: 'gone' };
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
