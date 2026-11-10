// Re-judge routed items after the classifier, owner words or judge model changes;
// built-in wording alone leaves settled decisions in place (owner, 2026-11-07).
// Source-agnostic: it reads only the tier ledger
// and the stored copy of an item's text, never a source.
//
// A routed item's content decision is recorded once, when its text lands.
// Nothing re-made it when the classifier (TIER_CLASSIFIER_VERSION) or the
// owner's words or judge model changed, so an item judged Personal under older rules
// stayed Personal. This pass finds those items (`rejudgeCandidatePage`),
// reads the stored text back from the store that serves it, and runs the
// shared content pass again with the item's names, exactly as a landing does.
//
// - Owner overrides, force rules and owner rules on the names are never
//   re-judged; neither are Secrets or mid-move items, nor items pending on
//   their names. An item held only for its text question is re-read once
//   per classifier and sniffer: the content pass queues its question again
//   (one lost from the sniffer's queue would otherwise hold it forever), or
//   a cached verdict settles it at once.
// - The item was visible under its previous decision, so a re-judge NEVER
//   hides it pending an answer (review fix 2026-10-02: re-judging hid items
//   far faster than answers and moves could bring them back). A decision
//   that needs the sniffer opens a re-judge question
//   (`TierLedger.openRejudgeQuestion`): the item stays exactly where it is,
//   and the sniffer's answer settles it (`applySnifferVerdict`). Only a
//   Private verdict raises it (hidden first); a Personal verdict changes
//   nothing but its reasons; a Private item judged Personal moves down.
// - A decision made at once (a cached verdict, a structured detector) is
//   recorded at once; a raise hides first.
// - On an install whose moves wait for the owner-approved migration
//   (`autoMoves` false: an embedding other than the built-in local model),
//   nothing is hidden at all: a raise is queued with the item still visible,
//   which is exactly the migration's proposal for it.
// - A secret found in stored text is settled at once like any Secrets
//   decision: every copy hidden in the same ledger write, the location
//   recorded, and the copies handed to the one Secrets policy
//   (secrets-disposition.ts).
// - A row the pass leaves as it was is stamped (`markRejudged`), so it is not
//   re-read on every tick; a page reads a bounded window of the ledger. A row
//   whose serving text cannot be read is not settled: it is retried after a
//   backoff (`markRejudgeUnavailable`).
// - Runs only with a sniffer configured (the sniffer service calls it): with
//   no private lane, recorded decisions stand exactly as before.

import { imageJudgmentSignal } from '../source-index/media-judge.ts';
import { parentNamesContext } from './parent-context.ts';
import { storedSignals } from './stored-names.ts';
import {
  classifyContentTier,
  classifyItemTiers,
  HELD_RECORD_PRIORITY,
  HELD_UNTIL_JUDGED_PRIORITY,
  heldUntilJudged,
  SNIFFER_NAMES_MAX_CHARS,
  snifferFolderKeyNames,
  tierSnifferInputHash,
  maxTier,
  hasCredentialUrl,
  namesWithParentContext,
  namesDecidedByOwner,
  RETIRED_SOURCE_PRIOR_REASON,
  restsOnRetiredSourcePrior,
  TIER_CLASSIFIER_VERSION,
  type OwnerTierRule,
  type TierDecision,
  type TierSniffer,
} from '../classification/tier-classifier.ts';
import {
  copyServingLayer,
  holdSnifferLowering,
  type TierLedgerIdentity,
  type TierLedgerRecord,
  type TierOwnerOverrideGuard,
  type TierRejudgeCause,
} from '../classification/tier-ledger.ts';
import type { SecretLocationsIndex } from '../classification/secret-locations.ts';
import { STORED_NAMES_ASKED_REASON, STORED_NAMES_REASON, type TierLedger } from '../classification/tier-ledger.ts';
import type { LocalConnectorStore } from './local-index.ts';
import type { ConnectorStoreItemCopy } from './local-index.ts';
import { settleSecretsCopies } from './secrets-disposition.ts';
import { secretFencedSniffer } from './tier-placement.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';
import { scanSecretsAhead } from '../classification/secret-scan-off-thread.ts';
import { secretScanReusable } from '../classification/engine.ts';

/** Items re-judged per call (one call per sniffer tick, per set). */
export const DEFAULT_TIER_REJUDGE_PER_PASS = 100;
export const TIER_REJUDGE_CONNECTOR_ID = 'olympus_tier_rejudge';

export interface TierRejudgeReport {
  /** Settled Private decisions kept in place by the rollout switch. */
  heldLowering: number;
  /** Candidates read from the ledger. */
  seen: number;
  /** Decisions recorded with no change of stores. */
  updated: number;
  /** Re-judged decisions that need other stores: queued moves (a raise hides first unless `autoMoves` is off). */
  movesQueued: number;
  /** Re-judged and waiting on a sniffer question, still where it was (never hidden for it). */
  asked: number;
  /** A secret found in stored text: hidden at once and handed to the Secrets policy. */
  secrets: number;
  /** Nothing to re-read (no stored text) or an owner override: left as it was. */
  skipped: number;
  failed: number;
  /**
   * Candidates by the rule that picked them (content-free, for the pass's
   * log line, #954): held for a text question, a retired whole-source prior,
   * a question lost from the queue, another classifier version, owner words,
   * judge model, or names/content without a compatible sniffer verdict.
   */
  causeHeld: number;
  causeRetiredPrior: number;
  causeMissingQuestion: number;
  causeClassifier: number;
  causeOwnerWords: number;
  causeJudgeModel: number;
  causeNamesPrompt: number;
  causeContentPrompt: number;
  /** Settled items in the scanned window whose only stale input is built-in wording. */
  builtinPromptSkipped: number;
  /** Items the owner asked to check again (`olympus tier recheck`) that this pass re-judged. */
  rechecked: number;
}

const CAUSE_FIELD: Record<TierRejudgeCause, keyof TierRejudgeReport> = {
  held: 'causeHeld',
  retired_prior: 'causeRetiredPrior',
  missing_question: 'causeMissingQuestion',
  classifier: 'causeClassifier',
  owner_words: 'causeOwnerWords',
  judge_model: 'causeJudgeModel',
  names_prompt: 'causeNamesPrompt',
  content_prompt: 'causeContentPrompt',
};

export interface TierRejudgeOptions {
  set: TieredStoreSet;
  limit?: number;
  /** Where the previous call stopped; the returned `next` continues from it. */
  after?: TierLedgerIdentity;
  /**
   * Whether this set's queued moves run automatically (the sniffer service's
   * automatic moves: every embedding is the built-in local model). False: a
   * re-judge never hides anything; a raise is queued with the item visible,
   * for the owner-approved migration.
   */
  autoMoves?: boolean;
}

export function emptyTierRejudgeReport(): TierRejudgeReport {
  return {
    heldLowering: 0, seen: 0, updated: 0, movesQueued: 0, asked: 0, secrets: 0, skipped: 0, failed: 0,
    causeHeld: 0, causeRetiredPrior: 0, causeMissingQuestion: 0, causeClassifier: 0, causeOwnerWords: 0, causeJudgeModel: 0,
    causeNamesPrompt: 0, causeContentPrompt: 0, builtinPromptSkipped: 0, rechecked: 0,
  };
}

export function rejudgeRoutedItems(options: TierRejudgeOptions): { report: TierRejudgeReport; next?: TierLedgerIdentity } {
  const steps = rejudgeSteps(options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * rejudgeRoutedItems with the thread given back between items, and a large
 * stored text's secret scan made on the second thread first
 * (secret-scan-off-thread.ts), so the classifier reuses it. A page of 100
 * re-judges in one go, each scanning its text, was 18% of Sparta's freeze
 * time on 2007d67 (2026-11-05). The decisions are the same either way.
 */
export async function rejudgeRoutedItemsInTurns(
  options: TierRejudgeOptions & { turn: () => Promise<void> | undefined },
): Promise<{ report: TierRejudgeReport; next?: TierLedgerIdentity }> {
  const steps = rejudgeSteps(options);
  let step = steps.next();
  while (!step.done) {
    await options.turn();
    const text = step.value === undefined ? undefined : storedContentText(options.set, step.value);
    if (text !== undefined && secretScanReusable(text)) await scanSecretsAhead(text);
    step = steps.next();
  }
  return step.value;
}

// The stored text a re-judge of `record` will read, for scanning ahead only:
// rejudgeStoredContent reads it again itself, after any wait.
function storedContentText(set: TieredStoreSet, record: TierLedgerRecord): string | undefined {
  try {
    const identity = identityOf(record);
    const current = set.ledger.copies(identity).filter((copy) => copy.state === 'current');
    const serving = copyServingLayer(current, 'content');
    const domain = serving ? set.domainForCorpus(serving.corpusId) : undefined;
    const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
    return exported?.chunks.map((chunk) => chunk.boundedText).join('');
  } catch {
    return undefined;
  }
}

// Yields each candidate before it is re-judged (a turn point for the caller).
function* rejudgeSteps(options: TierRejudgeOptions): Generator<TierLedgerRecord, { report: TierRejudgeReport; next?: TierLedgerIdentity }> {
  const report = emptyTierRejudgeReport();
  const { set } = options;
  const classification = set.classification();
  // No sniffer, or inputs that cannot be trusted: recorded decisions stand.
  if (!classification?.sniffer || classification.unavailableReason || classification.sniffer.rejudgeReady === false) return { report };
  const ledger = set.ledger;
  const limit = Math.max(1, options.limit ?? DEFAULT_TIER_REJUDGE_PER_PASS);
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: classification.sniffer.id };
  // The owner's re-check requests come first, from the same budget.
  const recheck = { rules: classification.rules ?? [] };
  let budget = limit;
  for (const request of ledger.recheckRequests()) {
    if (budget <= 0) break;
    const scoped = ledger.recheckScopePage(request.scope, { ...(request.after ? { after: request.after } : {}), limit: budget });
    for (const record of scoped.records) {
      yield record;
      budget -= 1;
      if (!rechecks(record)) {
        report.skipped += 1;
        continue;
      }
      report.rechecked += 1;
      try {
        rejudgeStoredContent(set, record, {
          sniffer: classification.sniffer,
          ...(classification.retirePublic ? { retirePublic: true } : {}),
          report,
          key,
          autoMoves: options.autoMoves === true,
          recheck,
        });
      } catch {
        // The item keeps its recorded decision; the owner can ask again.
        report.failed += 1;
      }
    }
    ledger.advanceRecheck(request, scoped.next);
  }
  if (budget <= 0) return { report, ...(options.after ? { next: options.after } : {}) };
  const page = ledger.rejudgeCandidatePage({
    ...key,
    ...(options.after ? { after: options.after } : {}),
    limit: budget,
  });
  report.builtinPromptSkipped = page.builtinPromptSkipped;
  for (const [index, record] of page.records.entries()) {
    yield record;
    report.seen += 1;
    const cause = page.causes[index];
    if (cause) report[CAUSE_FIELD[cause]] += 1;
    try {
      rejudgeStoredContent(set, record, {
        sniffer: classification.sniffer,
        ...(classification.retirePublic ? { retirePublic: true } : {}),
        report,
        key,
        autoMoves: options.autoMoves === true,
      });
    } catch {
      // The item keeps its recorded decision; a later pass tries again.
      report.failed += 1;
    }
  }
  return { report, ...(page.next ? { next: page.next } : {}) };
}

/**
 * Whether an item in a re-check's scope is judged again: a settled, routed
 * item whose text was read. Secrets, items mid-move or waiting on a question,
 * and items the owner set are left exactly as they are.
 */
function rechecks(record: TierLedgerRecord): boolean {
  return record.routed && record.contentRead && record.state === 'current'
    && record.contentTier !== 'secrets' && record.decidedBy !== 'override';
}

/**
 * Re-judges one routed item's content from the copy the store serving it
 * holds, exactly as a landing judges it: the re-judge pass above, and the
 * photo judge's verdicts (tier-media-judgment-sweep.ts) use it. A still
 * image's picture judgment travels with the stored copy, so a re-judge never
 * forgets it. `key` stamps the row for the re-judge pass; without one (a
 * sweep that runs with no sniffer) nothing is stamped.
 */
export function rejudgeStoredContent(
  set: TieredStoreSet,
  record: TierLedgerRecord,
  options: {
    sniffer?: TierSniffer;
    retirePublic?: boolean;
    report: TierRejudgeReport;
    key?: { engineVersion: string; snifferId: string };
    autoMoves: boolean;
    /**
     * Hide the current copies at once on a raise even when moves wait for the
     * owner (the photo judge: a picture whose ordinary verdict no longer
     * holds must not stay visible outside Private).
     */
    hideRaises?: boolean;
    /**
     * The owner asked to check this item's chat or source again (#638): its
     * names are judged again by the model whatever judged them before, and
     * may come out lower. The owner's rules decide first.
     */
    recheck?: { rules: readonly OwnerTierRule[] };
  },
): void {
  const { report, key, autoMoves } = options;
  const ledger = set.ledger;
  const identity = identityOf(record);
  const read = ledger.classificationRead(identity);
  if (read.override) {
    if (key) ledger.markRejudged(identity, key);
    report.skipped += 1;
    return;
  }
  const current = ledger.copies(identity).filter((copy) => copy.state === 'current');
  const serving = copyServingLayer(current, 'content');
  const domain = serving ? set.domainForCorpus(serving.corpusId) : undefined;
  const exported = domain ? set.store(domain)?.exportItemCopy(identity) : undefined;
  const text = exported?.chunks.map((chunk) => chunk.boundedText).join('') ?? '';
  if (!exported || !text.trim()) {
    // Nothing to read back: the decision stands, but it was not re-judged, so
    // the row is not stamped settled (#1002: an owner-words change would never
    // be applied once the text came back). It is tried again after a backoff,
    // or at once after a newer decision (markRejudgeUnavailable).
    if (key) ledger.markRejudgeUnavailable(record, key);
    report.skipped += 1;
    return;
  }
  const imageJudgment = exported.chunks.find((chunk) => chunk.mediaJudgment)?.mediaJudgment;
  const title = columnString(exported.columns['title']);
  const path = columnString(exported.columns['locator_uri']);
  const sender = columnString(exported.columns['sender_label']);
  const mimeType = columnString(exported.columns['mime_type']);
  // The same folder keys the owner-rule sweep reads: a message's chat is one of them.
  const folderKeys = [...(storedSignals(exported).folderKeys ?? [])];
  // A failed cache/queue operation is not an open question. Leave all retry
  // stamps and receipts untouched until every needed question is persisted.
  let questionNotQueued = false;
  // Fenced for both passes: a pass that began before the item became
  // Secrets queues none of its names or excerpt (tier-placement.ts).
  const counting: TierSniffer | undefined = options.sniffer && {
    id: options.sniffer.id,
    judge(request) {
      const verdict = options.sniffer!.judge(request);
      if (verdict.verdict === 'undecided' && verdict.queued !== true) questionNotQueued = true;
      return verdict;
    },
  };
  const sniffer = counting && secretFencedSniffer(counting, ledger, identity, read);
  // The lane's hold, or the one the stored decision carries: a held item is
  // judged again exactly as it was held at landing.
  const holdUntilJudged = set.holdsContentUntilJudged() || heldUntilJudged(record.reasons);
  // A child is judged again with its parent's names as context, as it was at listing and landing.
  const parentContext = sniffer ? parentNamesContext(set, identity) : undefined;
  const metadata = rejudgeMetadata(record, sniffer, { title, path, sender, folderKeys }, identity, holdUntilJudged, parentContext, options.recheck);
  const content = classifyContentTier(
    {
      text,
      hasNonTextContent: !record.reasons.includes('content:text_only'),
      metadataTier: metadata.metadataTier,
      metadataForced: metadata.metadataForced,
      metadataFlagged: metadata.metadataFlagged,
      metadataOwnerDecided: namesDecidedByOwner(record.reasons),
      ...(title ? { title } : {}),
      ...(path ? { path } : {}),
      ...(sender ? { sender } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(holdUntilJudged ? { holdUntilJudged: true } : {}),
      ...(imageJudgment ? { imageJudgment: imageJudgmentSignal(imageJudgment) } : {}),
      ...(parentContext ? { parentContext } : {}),
      subject: identity,
    },
    {
      ...(sniffer ? { sniffer } : {}),
      ...(options.retirePublic ? { retirePublic: true } : {}),
    },
  );
  const decision: TierDecision = {
    metadataTier: metadata.metadataTier,
    contentTier: maxTier(content.contentTier, metadata.metadataTier),
    decidedBy: content.decidedBy,
    reasons: [
      ...metadata.reasons,
      ...content.reasons,
    ],
    state: metadata.metadataPending || content.contentPending ? 'pending' : 'current',
    contentRead: true,
    metadataPending: metadata.metadataPending,
    contentPending: content.contentPending,
    metadataForced: metadata.metadataForced,
    metadataFlagged: metadata.metadataFlagged,
    engineVersion: content.engineVersion,
    mapRevision: content.mapRevision,
    snifferId: content.snifferId,
  };
  if (content.contentTier === 'secrets') {
    settleRoutedSecrets(set, identity, decision, exported, {
      text,
      findingKinds: content.reasons
        .filter((reason) => reason.startsWith('content:secret:'))
        .map((reason) => reason.slice('content:secret:'.length)),
    });
    report.secrets += 1;
    return;
  }
  if (questionNotQueued) {
    report.failed += 1;
    return;
  }
  if (content.contentPending && record.state === 'pending') {
    // Already held for this question: the content pass just queued it again
    // (`subject` above); the sniffer's answer settles the row.
    // Refresh the content receipt too: an old held row may predate receipts,
    // or a refused move may have been judged against another stored body.
    ledger.recordRoutedPlacement(identity, decision, {
      copies: current, embedHold: current.some(copy => copy.embedHold),
    }, { guard: { generation: record.generation, override: undefined } });
    if (key) ledger.markHeldRejudged(ledger.getCurrent(identity)!, key);
    report.asked += 1;
    return;
  }
  if (content.contentPending || metadata.metadataPending) {
    // Asked, not hidden: the item stays where it is until the answer.
    if (ledger.openRejudgeQuestion(identity, {
      expectedGeneration: record.generation,
      decision,
      keepVisible: !autoMoves,
    })) report.asked += 1;
    else report.skipped += 1;
    return;
  }
  // The row this decision was made from must still be the row it writes:
  // the same generation and still no owner override (re-judge candidates
  // have none). An owner who set the item meanwhile decides it, not this pass.
  if (holdSnifferLowering(record, decision)) {
    // No stamp: turning the switch off makes the same cached answer eligible.
    report.heldLowering += 1;
    return;
  }
  const recorded = ledger.recordRoutedPlacement(
    identity,
    decision,
    set.placementFor(decision),
    {
      ...(autoMoves || options.hideRaises === true ? {} : { queueWithoutHiding: true }),
      guard: { generation: record.generation, override: undefined },
    },
  );
  if (key) ledger.markRejudged(identity, key);
  if (recorded.outcome === 'queued_move') report.movesQueued += 1;
  else report.updated += 1;
}

/** Only a model's obsolete names verdict may be replaced here. Owner rules,
 * overrides and provider floors retain their authority. The old placement
 * stays in force while these new names and content questions are answered. */
function rejudgeMetadata(
  record: TierLedgerRecord,
  sniffer: TierSniffer | undefined,
  names: { title: string | undefined; path: string | undefined; sender: string | undefined; folderKeys: string[] },
  subject: TierLedgerIdentity,
  holdUntilJudged = false,
  parentContext?: string,
  recheck?: { rules: readonly OwnerTierRule[] },
): Pick<TierDecision, 'metadataTier' | 'metadataForced' | 'metadataFlagged' | 'metadataPending' | 'reasons'> {
  const previous = { ...record, reasons: record.reasons.filter(reason => !reason.startsWith('content:')) };
  // Names resting on a retired whole-source prior were never judged at all:
  // they are judged now, and may come out lower than the prior held them.
  const retiredPrior = restsOnRetiredSourcePrior(record.reasons);
  // A re-check the owner asked for judges any model verdict on the names again, the current judge's too.
  const judgedAgain = (reason: string) => reason.startsWith('metadata:sniffer:')
    && (recheck !== undefined || !reason.startsWith(`metadata:sniffer:${sniffer?.id}:`));
  if (!sniffer || record.state !== 'current' || record.metadataForced || namesDecidedByOwner(record.reasons)
    || (!retiredPrior && !record.reasons.some(judgedAgain))) return previous;
  const signals = {
    ...(names.title ? { title: names.title } : {}),
    ...(names.path ? { path: names.path } : {}),
    ...(names.sender ? { sender: names.sender } : {}),
    folderKeys: names.folderKeys,
  };
  const fresh = classifyItemTiers({ signals, namesOnly: true });
  // An owner rule that matches the names now decides them, not this re-check:
  // the owner-rule sweep (tier-rules-sweep.ts) applies it.
  if (recheck && recheck.rules.length > 0) {
    const ruled = classifyItemTiers({ signals, namesOnly: true, provider: subject.provider }, { rules: recheck.rules });
    if (ruled.metadataForced || namesDecidedByOwner(ruled.reasons)) return previous;
  }
  // The store retains scope folder keys but not labels (nor all provider
  // facts). An old model verdict may have relied on those missing signals.
  // Re-judging may raise it, but only a connector relist with complete signals
  // can lower the names and therefore their content floor.
  const providerReasons = previous.reasons.filter(reason => /^metadata:(floor|prior):/.test(reason) && !reason.startsWith(RETIRED_SOURCE_PRIOR_REASON));
  // A verdict an earlier re-judge made from these same stored names lacked
  // nothing this one has, so a better prompt may lower it (1.2.1 canary: names
  // a re-judge held Private by mistake otherwise stayed Private for good).
  const fromStoredNames = record.reasons.includes(STORED_NAMES_REASON);
  // The owner's re-check may lower names a model held higher (#638: a chat held
  // Private by verdicts of builds that read its numeric id as an identity).
  // A provider floor or prior recorded on the names is a fact the store does
  // not keep the tier of, so names resting on one are never lowered here.
  const ownerRecheck = recheck !== undefined && providerReasons.length === 0;
  const baseline = retiredPrior || fromStoredNames || ownerRecheck ? fresh.metadataTier : maxTier(fresh.metadataTier, record.metadataTier);
  if (baseline === 'secrets') return { ...previous, metadataTier: baseline, metadataPending: false, reasons: fresh.reasons };
  const material = [names.title, names.path, ...snifferFolderKeyNames(names.folderKeys), names.sender].filter(Boolean).join(' | ').slice(0, SNIFFER_NAMES_MAX_CHARS);
  const verdict = sniffer.judge({ pass: 'metadata', material: namesWithParentContext(material, parentContext), flags: ['names:rejudge'], subject,
    materialHash: tierSnifferInputHash('metadata', signals, undefined, parentContext),
    mapRevision: fresh.mapRevision, priority: holdUntilJudged ? HELD_UNTIL_JUDGED_PRIORITY : HELD_RECORD_PRIORITY });
  const pending = verdict.verdict === 'undecided';
  const metadataTier = pending ? baseline : maxTier(baseline, verdict.tier);
  return {
    metadataTier,
    metadataForced: false,
    metadataFlagged: pending || fresh.metadataFlagged,
    metadataPending: pending,
    reasons: [
      ...fresh.reasons.filter(reason => reason.startsWith('metadata:') && !reason.startsWith('metadata:sniffer:') && !reason.startsWith('metadata:possibly_private:')),
      ...providerReasons,
      `metadata:sniffer:${sniffer.id}:${pending ? 'undecided' : verdict.code}`,
      // Mark only a raise this stored-names verdict made. A tier held at the
      // inherited floor must stay unmarked, or the next re-judge drops it. A
      // queued question is marked when its answer comes in (tier-ledger.ts).
      ...(pending ? [STORED_NAMES_ASKED_REASON] : metadataTier !== baseline ? [STORED_NAMES_REASON] : []),
    ],
  };
}

/** A legacy row has no copy ledger: remove every actual copy before settling. */
export function settleLegacySecrets(options: {
  ledger: TierLedger;
  stores: readonly Pick<LocalConnectorStore, 'exportItemCopy' | 'tombstoneCopy'>[];
  locations: SecretLocationsIndex;
  identity: TierLedgerIdentity;
  decision: TierDecision;
}): boolean {
  const copies = options.stores.flatMap(store => {
    const exported = store.exportItemCopy(options.identity);
    return exported ? [{ store, exported }] : [];
  });
  // A crash after the last tombstone can leave only the location receipt.
  // Without that durable evidence, keep the question for retry.
  if (copies.length === 0 && !options.locations.get(options.identity)?.findingKinds.includes('sniffer_secret_refusal')) return false;
  for (const { exported } of copies) recordSecretLocation(options.locations, options.decision, exported, { findingKinds: ['sniffer_secret_refusal'] });
  // Legacy reads do not obey routed copy rows. Tombstone before the final
  // ledger write; a partial failure retains the question and remaining copy.
  for (const { store, exported } of copies) {
    store.tombstoneCopy(exported.identity, { connectorId: TIER_REJUDGE_CONNECTOR_ID, trustTier: 'S5' });
  }
  options.ledger.recordDecision(options.identity, options.decision);
  return true;
}

/**
 * A routed item judged Secrets after it was stored (a re-judge found a
 * secret in its text; an owner rule made it Secrets): one ledger write hides
 * every copy (Secrets outrank everything), the location is recorded, and the
 * copies go to the one Secrets policy (secrets-disposition.ts), exactly as a
 * landing settles one. Returns whether the item became Secrets.
 */
export function settleRoutedSecrets(
  set: TieredStoreSet,
  identity: TierLedgerIdentity,
  decision: TierDecision,
  exported: ConnectorStoreItemCopy,
  finding: { text?: string; findingKinds: readonly string[] },
  placement: { guard?: TierOwnerOverrideGuard } = {},
): boolean {
  const ledger = set.ledger;
  const recorded = ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision), {
    ...(placement.guard ? { guard: placement.guard } : {}),
  });
  if (recorded.outcome !== 'secrets') return false;
  const locations = set.secrets();
  if (locations) recordSecretLocation(locations, decision, exported, finding);
  settleSecretsCopies({
    ledger,
    identity: exported.identity,
    copies: recorded.previousCopies,
    storeFor: (corpusId) => {
      const domain = set.domainForCorpus(corpusId);
      return domain ? set.store(domain) : undefined;
    },
    connectorId: TIER_REJUDGE_CONNECTOR_ID,
  });
  return true;
}

function recordSecretLocation(
  locations: SecretLocationsIndex,
  decision: TierDecision,
  exported: ConnectorStoreItemCopy,
  finding: { text?: string; findingKinds: readonly string[] },
): void {
  const locator = columnString(exported.columns['locator_uri']);
  const title = columnString(exported.columns['title']);
  const namesReleasable = decision.metadataTier === 'public' || decision.metadataTier === 'private';
  const folderKeys = storedFolderKeys(exported.columns['source_scope_folder_keys_json']);
  const scopeGeneration = columnString(exported.columns['source_scope_generation']);
  const scopeRevision = columnString(exported.columns['source_scope_revision']);
  locations.record({
    identity: exported.identity,
    ...(locator && !hasCredentialUrl(locator) ? { locator } : {}),
    ...(title && namesReleasable ? { title } : {}),
    namesReleasable,
    ...(folderKeys.length > 0 ? { folderKeys } : {}),
    ...(scopeGeneration && scopeRevision ? { scopeGeneration, scopeRevision } : {}),
    findingKinds: finding.findingKinds.length > 0 ? finding.findingKinds : ['owner_marked_secret'],
    ...(finding.text !== undefined ? { text: finding.text } : {}),
  });
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}

function columnString(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function storedFolderKeys(value: string | number | null | undefined): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}
