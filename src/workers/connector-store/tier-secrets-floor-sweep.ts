// The Secrets floor applied to items already stored (#880). Source-agnostic: it
// reads only the tier ledger and the names and text each item's store keeps.
//
// An item's text meets the shared secret patterns (src/core/secret-patterns.ts)
// once, when it lands. A pattern added later (labelled recovery and backup
// codes, #880) would leave an item stored before it Personal, and Personal
// content can reach cloud models. When SECRETS_FLOOR_VERSION changes, this
// pass reads every routed item's stored names and text once (a bounded page
// per call, resumed from the ledger; mid-move, the copy the move kept) and
// runs the floor on them, nothing else: no model is
// asked and no other rule is re-run, so an archive-wide pass costs a regex
// scan per item, not a classifier-version re-judge (which can ask the model
// about every item without a cached verdict; see
// docs/design/per-item-four-tier-classification.md).
//
// A hit is settled exactly as a landing settles one (`settleRoutedSecrets`):
// every copy hidden in one ledger write, the location recorded, the copies
// handed to the one Secrets policy. Items already Secrets and items with an
// owner override are left as they are, as the re-judge leaves them. An item
// that could not be read or settled is held and retried alone once the walk
// ends (a bounded list in the ledger; past it the whole walk runs again), so
// the version is recorded as done only when nothing was left behind.

import { SECRETS_FLOOR_VERSION, hasCredentialUrl } from '../../core/secret-patterns.ts';
import { detectSecretFindingKinds, secretScanReusable } from '../classification/engine.ts';
import { scanSecretsAhead } from '../classification/secret-scan-off-thread.ts';
import { UNDECIDED_TIER_SNIFFER, type TierDecision } from '../classification/tier-classifier.ts';
import { copyServingLayer, type TierLedgerIdentity, type TierLedgerRecord } from '../classification/tier-ledger.ts';
import { storedCopyOf, storedSignals } from './stored-names.ts';
import { settleRoutedSecrets } from './tier-rejudge.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** Routed ledger rows read per call. */
export const DEFAULT_SECRETS_FLOOR_SWEEP_ROWS = 200;
const SWEEP_META_KEY = 'secrets_floor_sweep';
/** Held-back items remembered between calls; past this the whole walk runs again instead. */
const MAX_HELD_ITEMS = 200;

export interface SecretsFloorSweepReport {
  /** Routed rows read this call. */
  scanned: number;
  /** Items the floor found a secret in: hidden and handed to the Secrets policy. */
  secrets: number;
  /** Items that could not be read or settled; held and retried. */
  failed: number;
  /** Whether every stored item has met the current floor. */
  complete: boolean;
}

interface SweepState {
  /** The floor version every routed item has met. */
  done?: string;
  /**
   * A walk in progress: the version it applies and where it stopped. `held`
   * are items that could not be read or settled; once the walk ends only those
   * are retried (`retry`). `overflow`: too many to remember, so the whole walk
   * runs again.
   */
  pending?: { version: string; after?: TierLedgerIdentity; held: TierLedgerIdentity[]; retry?: boolean; overflow?: boolean };
}

export async function sweepSecretsFloor(options: {
  set: TieredStoreSet;
  limit?: number;
  /** A yield point between items (the scheduler's ingestion turn). */
  turn?: () => Promise<void> | undefined;
}): Promise<SecretsFloorSweepReport> {
  const report: SecretsFloorSweepReport = { scanned: 0, secrets: 0, failed: 0, complete: true };
  const { set } = options;
  const ledger = set.ledger;
  const state = readState(ledger.readMeta(SWEEP_META_KEY));
  if (state.done === SECRETS_FLOOR_VERSION) return report;
  const progress = state.pending?.version === SECRETS_FLOOR_VERSION ? state.pending : undefined;
  const held: TierLedgerIdentity[] = [...(progress?.held ?? [])];
  let overflow = progress?.overflow === true;
  const keep = state.done ? { done: state.done } : {};
  const attempt = async (record: TierLedgerRecord): Promise<void> => {
    await options.turn?.();
    report.scanned += 1;
    let outcome: FloorOutcome;
    try {
      outcome = await applyFloor(set, record);
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'secrets') report.secrets += 1;
    else if (outcome === 'failed') {
      report.failed += 1;
      if (held.length < MAX_HELD_ITEMS) held.push(identityOf(record));
      else overflow = true;
    }
  };
  if (progress?.retry && !progress.overflow) {
    // The walk is over; only what it held back is tried again.
    for (const identity of held.splice(0)) {
      const record = ledger.getCurrent(identity);
      if (record?.routed) await attempt(record);
    }
    if (held.length === 0 && !overflow) writeState(ledger, { done: SECRETS_FLOOR_VERSION });
    else {
      report.complete = false;
      writeState(ledger, { ...keep, pending: overflow ? { version: SECRETS_FLOOR_VERSION, held: [] } : { version: SECRETS_FLOOR_VERSION, held, retry: true } });
    }
    return report;
  }
  const limit = Math.max(1, options.limit ?? DEFAULT_SECRETS_FLOOR_SWEEP_ROWS);
  const rows = ledger.listRouted({ ...(progress?.after ? { after: progress.after } : {}), limit });
  for (const record of rows) await attempt(record);
  if (rows.length < limit) {
    if (held.length === 0 && !overflow) writeState(ledger, { done: SECRETS_FLOOR_VERSION });
    else {
      report.complete = false;
      // Too many held to remember: the next call walks the whole pass again.
      writeState(ledger, { ...keep, pending: overflow ? { version: SECRETS_FLOOR_VERSION, held: [] } : { version: SECRETS_FLOOR_VERSION, held, retry: true } });
    }
  } else {
    report.complete = false;
    writeState(ledger, {
      ...keep,
      pending: { version: SECRETS_FLOOR_VERSION, after: identityOf(rows.at(-1)!), held, ...(overflow ? { overflow: true } : {}) },
    });
  }
  return report;
}

type FloorOutcome = 'secrets' | 'clear' | 'failed';

async function applyFloor(set: TieredStoreSet, record: TierLedgerRecord): Promise<FloorOutcome> {
  if (record.contentTier === 'secrets' || record.metadataTier === 'secrets') return 'clear';
  const identity = identityOf(record);
  if (set.ledger.getOverride(identity)) return 'clear';
  const copies = set.ledger.copies(identity);
  if (copies.length === 0) return 'clear';
  // The copy that serves the item, or, mid-move (a hide-first raise leaves
  // every source copy superseded and the destination staged), the copy the
  // move kept: completing a move never runs the floor again.
  const current = copies.filter((copy) => copy.state === 'current');
  const serving = copyServingLayer(current, 'content');
  const domain = serving ? set.domainForCorpus(serving.corpusId) : undefined;
  const exported = (domain ? set.store(domain)?.exportItemCopy(identity) : undefined) ?? storedCopyOf(set, identity, copies);
  if (!exported) return 'failed';
  // The names, exactly as the names pass screens what a store keeps of them
  // (title, path, sender, folder keys); a raw locator that is not a path is
  // not a name.
  const signals = storedSignals(exported);
  const names = [signals.title, signals.path, signals.sender, ...(signals.folderKeys ?? [])]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  const nameKinds = new Set(names.length > 0 ? detectSecretFindingKinds(names.join('\n')) : []);
  if (names.some(hasCredentialUrl)) nameKinds.add('credential_assignment');
  // The text, as the content pass reads it.
  const text = exported.chunks.map((chunk) => chunk.boundedText).join('');
  const textKinds = new Set<string>();
  if (text.trim()) {
    // A large text is scanned off the thread first; the scan below reuses it.
    if (secretScanReusable(text)) await scanSecretsAhead(text);
    for (const kind of detectSecretFindingKinds(text)) textKinds.add(kind);
    if (hasCredentialUrl(text)) textKinds.add('credential_assignment');
  }
  if (nameKinds.size === 0 && textKinds.size === 0) return 'clear';
  // The item may have changed while the scan ran: settle only what is still there.
  const latest = set.ledger.getCurrent(identity);
  if (!latest?.routed || latest.contentTier === 'secrets' || latest.metadataTier === 'secrets') return 'clear';
  const findingKinds = [...new Set([...nameKinds, ...textKinds])].sort();
  const decision: TierDecision = {
    // A secret in the names makes the names Secrets too, so none is released
    // (the location index keeps no title for it).
    metadataTier: nameKinds.size > 0 ? 'secrets' : latest.metadataTier,
    contentTier: 'secrets',
    decidedBy: 'secret_detector',
    reasons: [
      ...(nameKinds.size > 0
        ? [...nameKinds].sort().map((kind) => `metadata:secret:${kind}`)
        : latest.reasons.filter((reason) => !reason.startsWith('content:'))),
      ...[...textKinds].sort().map((kind) => `content:secret:${kind}`),
    ],
    state: 'current',
    contentRead: latest.contentRead || textKinds.size > 0,
    metadataPending: false,
    contentPending: false,
    metadataForced: latest.metadataForced,
    metadataFlagged: latest.metadataFlagged,
    engineVersion: latest.engineVersion,
    mapRevision: latest.mapRevision,
    snifferId: UNDECIDED_TIER_SNIFFER.id,
  };
  return settleRoutedSecrets(set, identity, decision, exported, { ...(text ? { text } : {}), findingKinds }) ? 'secrets' : 'failed';
}

function readState(raw: string | undefined): SweepState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { done?: unknown; pending?: unknown };
    const pending = parsed.pending as { version?: unknown; after?: unknown; held?: unknown; retry?: unknown; overflow?: unknown } | undefined;
    return {
      ...(typeof parsed.done === 'string' ? { done: parsed.done } : {}),
      ...(pending && typeof pending.version === 'string' ? {
        pending: {
          version: pending.version,
          ...(isIdentity(pending.after) ? { after: pending.after } : {}),
          held: Array.isArray(pending.held) ? pending.held.filter(isIdentity) : [],
          ...(pending.retry === true ? { retry: true } : {}),
          ...(pending.overflow === true ? { overflow: true } : {}),
        },
      } : {}),
    };
  } catch {
    return {};
  }
}

function isIdentity(value: unknown): value is TierLedgerIdentity {
  const candidate = value as Partial<TierLedgerIdentity> | undefined;
  return typeof candidate === 'object' && candidate !== null
    && typeof candidate.provider === 'string' && typeof candidate.accountScope === 'string'
    && typeof candidate.providerItemId === 'string';
}

function writeState(ledger: TieredStoreSet['ledger'], state: SweepState): void {
  ledger.writeMeta(SWEEP_META_KEY, JSON.stringify(state));
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}
