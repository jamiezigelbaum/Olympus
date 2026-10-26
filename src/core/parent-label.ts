/**
 * A child item's parent as a citation shows it (docs/design/child-items.md,
 * "Citations"): the parent's subject or chat, its sender and its date, as
 * `'Flat' from Alice, 3 March 2024`, built at pack time.
 *
 * The label is the parent's NAMES, so it is one more place the parent's names
 * can go. Three rules, each kept here:
 *
 * - Authorized per candidate. A label goes into the pack only when the
 *   parent's names tier may go wherever THIS candidate goes: its rank is no
 *   higher than the candidate's own (a Personal child bound for a cloud model
 *   gets the label only when the parent's names are Personal, and with "names
 *   are Private" set it reveals nothing of the parent). The parent's CONTENT
 *   never limits the child. Secrets never. A parent whose names are not final
 *   yet, are hidden or are gone gives no label. The corpus holding the names
 *   must be inside this request's scope.
 * - A dependency of the answer. A model that read a label has the parent's
 *   subject in its words, so the parent's names are a release input of the
 *   answer (`ReleaseInput.layer = 'names'`): if they stop being authorized
 *   before release, the whole answer is withheld, never just the label.
 * - Data, not instruction. The label is bounded and flattened to one line.
 *
 * This module names no source and no format. How a parent is found and what
 * its names tier is are the resolver's: connector-store/parent-label.ts.
 */

import type { EvidenceCandidate } from './contracts.ts';
import type { ReleaseInput } from './release-manifest.ts';
import { isSecureSensitivity, type SourceItemIdentity, type SourceTrustDomain } from './source-index/types.ts';

/**
 * The tier a parent's names sit in. Secrets are never a parent label.
 */
export type ParentNamesTier = 'public' | 'personal' | 'private';

const TIER_RANK: Readonly<Record<ParentNamesTier, number>> = { public: 0, personal: 1, private: 2 };

/**
 * What a resolver knows of one child's parent: its names and where they sit.
 */
export interface ParentNames {
  /**
   * The parent's effective names tier now (the higher of current and in-flight).
   */
  tier: ParentNamesTier;
  /**
   * The corpus holding the copy that serves the parent's names.
   */
  corpusId: string;
  /**
   * The parent: same provider, account and conversation as the child.
   */
  identity: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId'>;
  subject?: string;
  sender?: string;
  authoredAt?: string;
}

export interface ParentLabelRequest {
  /**
   * The corpus the candidate came from.
   */
  corpusId: string;
  sourceItem: Pick<SourceItemIdentity, 'provider' | 'accountScope' | 'providerItemId' | 'providerConversationId'>;
}

/**
 * The parents of these candidates, one entry per request in order; undefined
 * for an item with no parent or one whose names cannot be offered at all
 * (Secrets, names not final, hidden, gone). A resolver that throws gives no
 * labels.
 */
export type ParentLabelResolver = (requests: readonly ParentLabelRequest[]) => ReadonlyArray<ParentNames | undefined>;

/**
 * The request's scope the label must stay inside.
 */
export interface ParentLabelScope {
  allowedTrustDomains: readonly SourceTrustDomain[];
  /**
   * The corpora the request named, when it named any.
   */
  allowedCorpusIds?: readonly string[];
  /**
   * Corpora this request leaves out on purpose (owner's read scope, request scope).
   */
  excludedCorpusIds?: ReadonlySet<string>;
  /**
   * The trust domain of a registered corpus; undefined for one that is not.
   */
  domainOf(corpusId: string): SourceTrustDomain | undefined;
}

/**
 * A parent whose names a candidate's pack carries, beside the pack (index-aligned by candidate).
 */
export interface ParentLabelDependency {
  /**
   * Index into the pack's candidates.
   */
  candidateIndex: number;
  /**
   * The corpus holding the copy that serves the parent's names.
   */
  corpusId: string;
  parent: ParentNames['identity'];
  /**
   * The names were Private when the label was built.
   */
  private: boolean;
}

export const PARENT_LABEL_MAX_CHARS = 160;
const SUBJECT_MAX_CHARS = 90;
const SENDER_MAX_CHARS = 40;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * The highest names tier this candidate's own tier lets travel with it.
 */
export function candidateNamesCeiling(candidate: Pick<EvidenceCandidate, 'trustDomain' | 'trustTier' | 'facts'>): ParentNamesTier {
  if (isSecureSensitivity(candidate)) return 'private';
  return candidate.trustDomain === 'public_safe' ? 'public' : 'personal';
}

/**
 * Whether names at `names` may go wherever a candidate with ceiling `ceiling` goes.
 */
export function parentNamesMayTravel(names: ParentNamesTier, ceiling: ParentNamesTier): boolean {
  return TIER_RANK[names] <= TIER_RANK[ceiling];
}

/**
 * One line, control characters gone, runs of space folded, bounded: a label is
 * data for a model and a person.
 */
function flattened(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = '';
  let pendingSpace = false;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const blank = code <= 0x20 || (code >= 0x7f && code <= 0xa0) || code === 0x2028 || code === 0x2029;
    if (blank) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) text += ' ';
    pendingSpace = false;
    text += char;
  }
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * `3 March 2024` from an ISO time, in UTC; undefined when it is not a time.
 */
function labelDate(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  const date = new Date(at);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * `'Flat' from Alice, 3 March 2024`: the parts the parent has, in that order.
 */
export function parentLabelText(names: Pick<ParentNames, 'subject' | 'sender' | 'authoredAt'>): string | undefined {
  const subject = flattened(names.subject, SUBJECT_MAX_CHARS);
  const sender = flattened(names.sender, SENDER_MAX_CHARS);
  const date = labelDate(names.authoredAt);
  const who = [subject ? `'${subject}'` : undefined, sender ? `from ${sender}` : undefined].filter(Boolean).join(' ');
  const label = date ? (who ? `${who}, ${date}` : date) : who;
  if (!label) return undefined;
  return label.length > PARENT_LABEL_MAX_CHARS ? `${label.slice(0, PARENT_LABEL_MAX_CHARS - 1).trimEnd()}…` : label;
}

/**
 * A citation's title with its parent: `lease.pdf, in 'Flat' from Alice, 3 March
 * 2024`. The one composition every release surface uses, so the shared output
 * schemas and the tool lists stay as they are: the label rides in the title
 * text.
 */
export function citationTitleWithParent(title: string | undefined, parentLabel: string | undefined): string | undefined {
  const label = flattened(parentLabel, PARENT_LABEL_MAX_CHARS);
  const own = title?.trim();
  if (!label) return own || undefined;
  return own ? `${own}, in ${label}` : `In ${label}`;
}

export interface ParentLabelOutcome {
  /**
   * The candidates, those with an authorized label carrying it. Same order, same length.
   */
  candidates: EvidenceCandidate[];
  /**
   * One entry per candidate that carries a label.
   */
  dependencies: ParentLabelDependency[];
}

/**
 * Attaches each authorized parent label to its candidate's citation. A label
 * that is not authorized is left out (before dispatch, the unauthorized label
 * never enters the pack). A resolver error leaves every candidate as it was.
 */
export function applyParentLabels(
  candidates: readonly EvidenceCandidate[],
  corpusIds: readonly string[],
  resolver: ParentLabelResolver | undefined,
  scope: ParentLabelScope,
): ParentLabelOutcome {
  const unchanged = { candidates: [...candidates], dependencies: [] };
  if (!resolver || candidates.length === 0) return unchanged;
  let parents: ReadonlyArray<ParentNames | undefined>;
  try {
    parents = resolver(candidates.map((candidate, index) => ({
      corpusId: corpusIds[index] ?? '',
      sourceItem: candidate.provenance.sourceItem,
    })));
  } catch {
    return unchanged;
  }
  if (parents.length !== candidates.length) return unchanged;

  const dependencies: ParentLabelDependency[] = [];
  const labelled = candidates.map((candidate, index): EvidenceCandidate => {
    const parent = parents[index];
    if (!parent) return candidate;
    if (!parentNamesMayTravel(parent.tier, candidateNamesCeiling(candidate))) return candidate;
    if (!namesCorpusInScope(parent.corpusId, scope)) return candidate;
    const label = parentLabelText(parent);
    if (!label) return candidate;
    dependencies.push({
      candidateIndex: index,
      corpusId: parent.corpusId,
      parent: parent.identity,
      private: parent.tier === 'private',
    });
    return {
      ...candidate,
      provenance: {
        ...candidate.provenance,
        citation: { ...candidate.provenance.citation, parentLabel: label },
      },
    };
  });
  return { candidates: labelled, dependencies };
}

function namesCorpusInScope(corpusId: string, scope: ParentLabelScope): boolean {
  if (!corpusId || scope.excludedCorpusIds?.has(corpusId)) return false;
  if (scope.allowedCorpusIds && !scope.allowedCorpusIds.includes(corpusId)) return false;
  const domain = scope.domainOf(corpusId);
  return domain !== undefined && scope.allowedTrustDomains.includes(domain);
}

/**
 * The names-layer release inputs of a pack's labels: one per distinct parent.
 * The answer was written with these names in front of the model, so they are
 * as much a part of what it read as the items it cites.
 */
export function parentLabelReleaseInputs(dependencies: readonly ParentLabelDependency[]): ReleaseInput[] {
  const seen = new Map<string, ReleaseInput>();
  for (const dependency of dependencies) {
    const { parent } = dependency;
    const key = JSON.stringify([dependency.corpusId, parent.provider, parent.accountScope, parent.providerConversationId ?? '', parent.providerItemId]);
    const existing = seen.get(key);
    if (existing) {
      if (dependency.private) existing.privateAtAnswer = true;
      continue;
    }
    seen.set(key, {
      corpusId: dependency.corpusId,
      provider: parent.provider,
      accountScope: parent.accountScope,
      providerItemId: parent.providerItemId,
      ...(parent.providerConversationId ? { providerConversationId: parent.providerConversationId } : {}),
      privateAtAnswer: dependency.private,
      layer: 'names',
      dependency: 'parent_label',
    });
  }
  return [...seen.values()];
}
