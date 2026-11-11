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
import { createHash, randomBytes } from 'node:crypto';
import { archiveFormatForProvider } from '../../core/archive-formats.ts';
import type { ExtractionItemRef } from './types.ts';
import type { ExtractionUnreadableItem, ExtractionUnreadableVerdict, ItemExtractionOutcome } from './job-store.ts';
import type { TierLedgerIdentity } from '../classification/tier-ledger.ts';

/**
 * A child item's parent, named for the file that could not be read
 * (docs/design/child-items.md, "Citations"): the parent's label and where the
 * parent lives. Names only; Secrets and a parent that is not there give none.
 */
export interface UnreadableParent {
  /**
   * The parent's subject or chat, sender and date, as a citation shows them.
   */
  label?: string;
  /**
   * The provider the parent came through, for the route (an imported
   * archive's items carry its format's provider).
   */
  provider: string;
  /**
   * The parent's account scope: an imported archive's id.
   */
  accountScope: string;
}

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
   * The parent of an item that came inside another (its label and where it
   * lives), for the computer's list only: the counts and the names never ask.
   * Undefined for an item that is not a child.
   */
  parentOf?(ref: ExtractionItemRef): UnreadableParent | undefined;
  /**
   * The provider's open target for a locator: its web page (https) and, when synced here, a local path.
   */
  openTarget(provider: string, locator: string): { url?: string; localPath?: string } | undefined;
  /**
   * Opens a local path on this computer, re-checking it first. Absent: synced copies are not opened here.
   */
  openFile?(path: string, eligible: () => Promise<boolean>): Promise<void>;
  now?: () => number;
  /**
   * How long a token stays good from when it was issued (absolute: reading the list again never extends it).
   */
  tokenTtlMs?: number;
  /**
   * Off the request path: a recheck answers the counts last counted (no older
   * than this, else still answered while a fresh count runs in the
   * background, in turns). Left out, every recheck asks each verdict now.
   * Counts only: names, the computer's list and opening still ask each file.
   */
  countsMaxAgeMs?: number;
  /**
   * Yields between slices of a background recount (ingestionTurn).
   */
  turn?: () => Promise<void> | undefined;
}

export type UnreadableOpenResult =
  | { status: 'opened' }
  | { status: 'open_link'; url: string }
  | { status: 'invalid' }
  | { status: 'gone' }
  | { status: 'rate_limited' }
  | { status: 'failed' };

/**
 * Where a child's parent is, for the person who has to act on it (every
 * problem has a route to exactly what): the imported archive it came in, else
 * the source the file's list already belongs to.
 */
export type UnreadableParentRoute =
  | { kind: 'archive'; archiveId: string }
  | { kind: 'source' };

/**
 * Why one file could not be read, as a closed code the dashboard words
 * (owner rule, 2026-11-04: a file Olympus can't ingest at all is called out
 * with exactly the reason and a link to the file). Derived from the failed
 * job's bounded error kind; never the reader's own message.
 */
export const UNREADABLE_FILE_REASONS = [
  'password',
  'damaged',
  'too_large',
  'no_text',
  'timed_out',
  'missing',
  'no_access',
  'unsupported',
  'privacy_check_missing',
  'other',
] as const;
export type UnreadableFileReason = (typeof UNREADABLE_FILE_REASONS)[number];

// Legacy widget code: accepted for older engines; new holds use the job's own reason.
export const UNREAD_PRIVACY_CHECK_MISSING_KIND = 'privacy_check_missing';

export function unreadableFileReason(errorKind: string | undefined): UnreadableFileReason {
  const kind = (errorKind ?? '').toLowerCase();
  if (!kind) return 'other';
  if (kind === UNREAD_PRIVACY_CHECK_MISSING_KIND) return 'privacy_check_missing';
  if (kind.includes('encrypted') || kind.includes('password')) return 'password';
  if (kind.includes('too_large')) return 'too_large';
  if (kind.includes('timeout')) return 'timed_out';
  if (kind.includes('not_found') || kind.includes('content_unavailable') || kind.includes('missing_bytes')) return 'missing';
  if (kind.includes('permission') || kind.includes('auth')) return 'no_access';
  if (kind.includes('unsupported') || kind === 'extractor_kind_unknown' || kind === 'no_extractor') return 'unsupported';
  if (kind.includes('empty')) return 'no_text';
  if (kind.includes('invalid') || kind.includes('undecodable') || kind.includes('corrupt') || kind.includes('damaged')) return 'damaged';
  return 'other';
}

/**
 * A display/count disposition only. None of these changes the content hold or
 * the independent names verdict. Missing extraction evidence never proves a
 * file unreadable; an indexed job means the text still awaits its judgment.
 */
export type UnreadHoldDisposition =
  | { kind: 'waiting' }
  | { kind: 'by_choice' }
  | { kind: 'cannot_read'; reason: UnreadableFileReason; errorKind: string };

export function unreadHoldDisposition(outcome: ItemExtractionOutcome | undefined, contentAllowed = true): UnreadHoldDisposition {
  if (!contentAllowed) return { kind: 'by_choice' };
  if (!outcome || outcome.status === 'indexed') return { kind: 'waiting' };
  if (outcome.status === 'blocked_policy' || (outcome.status === 'metadata_only'
    && (outcome.policyDecision === 'metadata_only' || outcome.lastErrorKind === 'store_item_metadata_only'))) {
    return { kind: 'by_choice' };
  }
  // A concrete warning (password, damage, ...) explains an otherwise generic
  // empty-output result. Never expose a reader's free-form diagnostic.
  const specific = (kind: string): boolean => !['other', 'no_text'].includes(unreadableFileReason(kind));
  const errorKind = [outcome.lastErrorKind, ...outcome.warnings, outcome.status]
    .find((kind): kind is string => kind !== undefined && specific(kind))
    ?? outcome.lastErrorKind ?? outcome.warnings[0] ?? outcome.status;
  return { kind: 'cannot_read', errorKind, reason: unreadableFileReason(errorKind) };
}

export interface UnreadableFileEntry {
  name: string;
  // Why it could not be read: unreadableFileReason.
  reason: UnreadableFileReason;
  /**
   * Present when the file has a place to open: the one-time capability the open tool takes.
   */
  token?: string;
  /**
   * Present for a file that came inside another item: the parent's label and
   * the route to its archive or source. Never the parent's content.
   */
  parent?: { label?: string; route: UnreadableParentRoute };
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
   * With countsMaxAgeMs, the last count (undefined until one has run).
   */
  recheck(corpusId: string): UnreadableRecheck | undefined;
  /**
   * The newest unreadable files' names across these corpora, newest failure first (verdicts asked again now).
   */
  names(corpusIds: readonly string[], limit: number): string[];
  /**
   * The computer's list after the `after` cursor (from the start without
   * one): up to `limit` files, how many more there are after them, and the
   * cursor to read those (`after`, present when a file was listed). Only with
   * an `opener` (an unlocked control session, or the worker bearer) does a
   * file carry an open token, bound to that opener.
   *
   * With `moreAtLeast`, the verdicts stop once one file past the page is
   * found, so `more` is only 0 or 1: for a caller that takes the count from
   * elsewhere and needs only to know whether there are more.
   */
  computerList(
    corpusIds: readonly string[],
    limit: number,
    options?: { after?: string; opener?: string; moreAtLeast?: boolean },
  ): { files: UnreadableFileEntry[]; more: number; after?: string };
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
 * A page cursor: the last listed file's failure time and an opaque digest of
 * its identity (never the identity itself).
 */
const CURSOR_TIME_ALPHABET = new Set('0123456789TZ:.+-');

/**
 * Whether a value has the shape of a page cursor computerList hands out.
 */
export function isUnreadablePageCursor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const split = value.indexOf('~');
  if (split < 10 || split > 40 || value.length !== split + 1 + 22) return false;
  return Array.from(value.slice(0, split)).every((char) => CURSOR_TIME_ALPHABET.has(char))
    && Array.from(value.slice(split + 1)).every((char) => TOKEN_ALPHABET.has(char));
}

interface TokenEntry {
  /**
   * The opener and the item: one live token per pair.
   */
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
  let bucket = OPEN_RATE.capacity;
  let refilledAt = now();

  const keyOf = (ref: ExtractionItemRef) => `${ref.corpusId}\u0000${ref.localItemId}`;

  /**
   * The verdict now, asked every time and never reused (a throw counts as
   * Secrets): an override or a secret-index write in any process shows on
   * the very next read.
   */
  function verdictOf(item: ExtractionUnreadableItem): ExtractionUnreadableVerdict {
    try {
      return options.verdict(item);
    } catch {
      return 'blocked_policy';
    }
  }

  /**
   * An item's place in the list: newest failure first, ties by an opaque
   * digest of its identity. Stable whatever else joins or leaves the list,
   * so a page cursor never skips or repeats a file.
   */
  function placeOf(item: ExtractionUnreadableItem): { at: string; id: string } {
    return { at: item.failedAt, id: createHash('sha256').update(keyOf(item.ref)).digest('base64url').slice(0, 22) };
  }

  function cursorOf(item: ExtractionUnreadableItem): string {
    const place = placeOf(item);
    return `${place.at}~${place.id}`;
  }

  /**
   * Whether `place` comes after the cursor's place in the list order.
   */
  function isAfter(place: { at: string; id: string }, cursor: string): boolean {
    const split = cursor.lastIndexOf('~');
    const at = cursor.slice(0, split);
    const id = cursor.slice(split + 1);
    return place.at < at || (place.at === at && place.id > id);
  }

  function listed(corpusId: string): readonly ExtractionUnreadableItem[] {
    try {
      return options.items(corpusId);
    } catch {
      return [];
    }
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
    const places = new Map(out.map((item) => [item, placeOf(item)]));
    return out.sort((a, b) => {
      const pa = places.get(a)!;
      const pb = places.get(b)!;
      if (pa.at !== pb.at) return pa.at < pb.at ? 1 : -1;
      return pa.id === pb.id ? 0 : pa.id < pb.id ? -1 : 1;
    });
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

  /**
   * The parent a child file came inside, asked again now: its label and the
   * route to its archive or source. Undefined for a file that is not a child.
   */
  function parentOf(item: ExtractionUnreadableItem): UnreadableFileEntry['parent'] | undefined {
    let parent: UnreadableParent | undefined;
    try {
      parent = options.parentOf?.(item.ref);
    } catch {
      return undefined;
    }
    if (!parent) return undefined;
    const archive = archiveFormatForProvider(parent.provider);
    return {
      ...(parent.label ? { label: parent.label } : {}),
      route: archive ? { kind: 'archive', archiveId: parent.accountScope } : { kind: 'source' },
    };
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

  const RECOUNT_SLICE = 100;
  const counted = new Map<string, { at: number; value: UnreadableRecheck }>();
  const recounting = new Set<string>();

  async function recount(corpusId: string): Promise<void> {
    const items = listed(corpusId);
    let unreadable = 0;
    let blocked = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (index > 0 && index % RECOUNT_SLICE === 0) {
        await (options.turn?.() ?? new Promise<void>((resolve) => setImmediate(resolve)));
      }
      const verdict = verdictOf(items[index]!);
      if (verdict === 'unreadable') unreadable += 1;
      else if (verdict === 'blocked_policy') blocked += 1;
    }
    counted.set(corpusId, { at: now(), value: { unreadable, blocked } });
  }

  function scheduleRecount(corpusId: string): void {
    if (recounting.has(corpusId)) return;
    recounting.add(corpusId);
    setTimeout(() => {
      void recount(corpusId).catch(() => undefined).finally(() => recounting.delete(corpusId));
    }, 0);
  }

  return {
    recheck(corpusId) {
      if (options.countsMaxAgeMs !== undefined) {
        const last = counted.get(corpusId);
        if (!last || now() - last.at >= options.countsMaxAgeMs) scheduleRecount(corpusId);
        return last?.value;
      }
      let unreadable = 0;
      let blocked = 0;
      for (const item of listed(corpusId)) {
        const verdict = verdictOf(item);
        if (verdict === 'unreadable') unreadable += 1;
        else if (verdict === 'blocked_policy') blocked += 1;
      }
      return { unreadable, blocked };
    },

    names(corpusIds, limit) {
      // Verdicts only until the list is full: the names are the newest few,
      // and asking every listed item first held the worker for seconds on a
      // large list (Sparta, 2026-11-04).
      const shown: ExtractionUnreadableItem[] = [];
      for (const item of merged(corpusIds)) {
        if (shown.length >= Math.max(0, limit)) break;
        if (verdictOf(item) === 'unreadable') shown.push(item);
      }
      return shown.map(displayName);
    },

    computerList(corpusIds, limit, list = {}) {
      const at = now();
      sweep(at);
      // Keyset paging over the list as it is now (Secrets checked again per
      // page): a file judged Secrets since the last page leaves the list
      // without moving any other file past the cursor.
      const cursor = list.after;
      const all = merged(corpusIds).filter((item) => !cursor || isAfter(placeOf(item), cursor));
      const shown: ExtractionUnreadableItem[] = [];
      let more = 0;
      for (const item of all) {
        if (verdictOf(item) !== 'unreadable') continue;
        if (shown.length < Math.max(0, limit)) shown.push(item);
        else {
          more += 1;
          // Every verdict is a few store reads, and the dashboard's own read
          // asked one for each of a source's unreadable files just to count
          // the rest (Sparta, d4a8cee, 2026-11-05: a quarter of the longest
          // freezes). Its count comes from the source card.
          if (list.moreAtLeast) break;
        }
      }
      const opener = list.opener;
      const files = shown.map((item): UnreadableFileEntry => {
        const name = displayName(item);
        const parent = parentOf(item);
        const reason = unreadableFileReason(item.errorKind);
        const base: UnreadableFileEntry = opener && target(item) ? { name, reason, token: mint(item, opener, at) } : { name, reason };
        return parent ? { ...base, parent } : base;
      });
      const last = shown.at(-1);
      return { files, more, ...(last ? { after: cursorOf(last) } : {}) };
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
      // Checked again now: a file that became Secrets, or that no store
      // serves any more, never opens from an older list.
      if (verdictOf(entry.item) !== 'unreadable') return { status: 'gone' };
      const resolved = target(entry.item);
      if (!resolved) return { status: 'gone' };
      if (resolved.localPath && options.openFile) {
        try {
          await options.openFile(resolved.localPath, async () => entry.expiresAt > now()
            && verdictOf(entry.item) === 'unreadable' && target(entry.item)?.localPath === resolved.localPath);
          return { status: 'opened' };
        } catch {
          // The synced copy would not open (moved, or refused on the re-check): its web page, if it has one.
          if (entry.expiresAt <= now() || verdictOf(entry.item) !== 'unreadable') return { status: 'gone' };
          if (!resolved.url) return { status: 'failed' };
        }
      }
      if (entry.expiresAt <= now() || verdictOf(entry.item) !== 'unreadable') return { status: 'gone' };
      const current = target(entry.item);
      return current?.url ? { status: 'open_link', url: current.url } : { status: 'gone' };
    },
  };
}
