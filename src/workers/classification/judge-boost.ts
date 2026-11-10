// Items a question just matched that still wait for their privacy judgment
// (#1062). The search or answer that found them does not wait: it notes them
// here, and the judge (sniffer-resolver.ts) asks about them before the rest
// of the queue, so the same question asked again a few minutes later can
// find them.
//
// Order only. Nothing here releases an item or changes a verdict: a raised
// item is still held until its own verdict, exactly as before. The judge's
// reserved slot for aged questions still comes first, so a stream of
// questions cannot starve the backlog.
//
// In memory and bounded: at most JUDGE_BOOST_PER_QUESTION items per question,
// JUDGE_BOOST_MAX_ITEMS in all (the oldest raise goes first), each for
// JUDGE_BOOST_TTL_MS. A restart forgets them; the queue's own order resumes.

import { tierLedgerIdentityKey, type TierLedgerIdentity } from './tier-ledger.ts';

/** The most items one question's matches raise: its top matches. */
export const JUDGE_BOOST_PER_QUESTION = 20;
/** The most raised items kept at once, across questions. */
export const JUDGE_BOOST_MAX_ITEMS = 200;
/** How long a raise lasts: long enough for a slow local judge to reach 20 items. */
export const JUDGE_BOOST_TTL_MS = 15 * 60_000;

export class JudgeBoosts {
  private readonly entries = new Map<string, { identity: TierLedgerIdentity; expiresAt: number }>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Raise one question's matched pending items, best match first; only the first JUDGE_BOOST_PER_QUESTION count. */
  raise(identities: readonly TierLedgerIdentity[]): void {
    const expiresAt = this.now() + JUDGE_BOOST_TTL_MS;
    const seen = new Set<string>();
    for (const identity of identities) {
      if (seen.size >= JUDGE_BOOST_PER_QUESTION) break;
      const key = tierLedgerIdentityKey(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      // Re-inserted so the newest raise is the last to be evicted.
      this.entries.delete(key);
      this.entries.set(key, {
        identity: {
          provider: identity.provider, accountScope: identity.accountScope, providerItemId: identity.providerItemId,
          ...(identity.providerConversationId ? { providerConversationId: identity.providerConversationId } : {}),
        },
        expiresAt,
      });
    }
    while (this.entries.size > JUDGE_BOOST_MAX_ITEMS) this.entries.delete(this.entries.keys().next().value!);
  }

  /** Whether this item is raised now. */
  has(identity: TierLedgerIdentity): boolean {
    const entry = this.entries.get(tierLedgerIdentityKey(identity));
    if (!entry) return false;
    if (entry.expiresAt > this.now()) return true;
    this.entries.delete(tierLedgerIdentityKey(identity));
    return false;
  }

  /** The items raised now, dropping expired ones. */
  live(): TierLedgerIdentity[] {
    const now = this.now();
    const live: TierLedgerIdentity[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) live.push(entry.identity);
      else this.entries.delete(key);
    }
    return live;
  }

  /** The item has no question left to ask: nothing to raise. */
  drop(identity: TierLedgerIdentity): void {
    this.entries.delete(tierLedgerIdentityKey(identity));
  }

  get size(): number { return this.entries.size; }
}

/** The worker's one set: search and answers raise, the judge in the same worker reads. */
export const judgeBoosts = new JudgeBoosts();
