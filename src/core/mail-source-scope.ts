// Connect-time mail scope for Gmail (design: per-item-four-tier-classification
// §2.5, owner decision 2026-09-23).
//
// The mail equivalent of the Dropbox/Drive folder scope, on the same approval
// machinery: the same account generation (a reconnect invalidates approval),
// the same opaque revision and compare-and-swap save, the same file lease and
// private atomic write, and the same `scope_pending` status that keeps the lane
// from starting. What differs is only what the owner chooses — a time window,
// Gmail categories and labels, and sender rules — so that choice is the one
// thing this module adds.
//
// Stored beside file-source-scopes.json in its own mail-source-scopes.json, so
// an older build that does not know the mail shape can never read the folder
// file as malformed and drop Dropbox or Drive back to scope_pending.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import { withFileLeaseSync } from './file-lease.ts';
import { OperationError } from './operation-error.ts';
import {
  connectedSourceScopeAccountGeneration,
  type SourceScopeConnectedHandleRegistry,
} from './source-scope-approval.ts';

export const MAIL_SOURCE_SCOPE_ID = 'gmail.email' as const;
export type MailSourceScopeId = typeof MAIL_SOURCE_SCOPE_ID;

export const MAIL_SOURCE_SCOPE_CAPABILITY = {
  sourceId: MAIL_SOURCE_SCOPE_ID,
  provider: 'gmail',
  credentialCapability: 'gmail.email.sync',
  scopeRequirement: 'explicit_mail_scope',
} as const;

/** How far back mail is read in full. Older mail is indexed metadata-only. */
export const MAIL_SCOPE_WINDOWS = ['6m', '1y', '2y', '5y', 'all'] as const;
export type MailScopeWindow = typeof MAIL_SCOPE_WINDOWS[number];
export const DEFAULT_MAIL_SCOPE_WINDOW: MailScopeWindow = '2y';
export const MAIL_SCOPE_WINDOW_LABELS: Readonly<Record<MailScopeWindow, string>> = {
  '6m': 'Last 6 months',
  '1y': 'Last year',
  '2y': 'Last 2 years',
  '5y': 'Last 5 years',
  all: 'Everything',
};
const MAIL_SCOPE_WINDOW_MONTHS: Readonly<Record<Exclude<MailScopeWindow, 'all'>, number>> = {
  '6m': 6,
  '1y': 12,
  '2y': 24,
  '5y': 60,
};

/** Gmail's five inbox categories, by their `category:` search names. */
export const GMAIL_SCOPE_CATEGORIES = ['primary', 'social', 'promotions', 'updates', 'forums'] as const;
export type GmailScopeCategory = typeof GMAIL_SCOPE_CATEGORIES[number];
/**
 * Owner decision 2026-09-23: Promotions and Social are skipped by default.
 * Updates (receipts, statements, shipping) and Forums (lists the owner joined)
 * carry real knowledge value and are included by default.
 */
export const DEFAULT_SKIPPED_GMAIL_CATEGORIES: readonly GmailScopeCategory[] = ['promotions', 'social'];
export const GMAIL_SCOPE_CATEGORY_LABELS: Readonly<Record<GmailScopeCategory, string>> = {
  primary: 'Primary',
  social: 'Social',
  promotions: 'Promotions',
  updates: 'Updates',
  forums: 'Forums',
};
/** The provider label id for each category, as messages carry it in labelIds. */
export const GMAIL_SCOPE_CATEGORY_LABEL_IDS: Readonly<Record<GmailScopeCategory, string>> = {
  primary: 'CATEGORY_PERSONAL',
  social: 'CATEGORY_SOCIAL',
  promotions: 'CATEGORY_PROMOTIONS',
  updates: 'CATEGORY_UPDATES',
  forums: 'CATEGORY_FORUMS',
};

const MAX_SCOPE_LABELS = 500;
const MAX_SENDER_RULES = 500;
const MAX_LABEL_NAME_CHARS = 225;
const MAX_SENDER_CHARS = 320;

export interface MailScopeLabel {
  /** Gmail's opaque label id; the name is kept only to build the search. */
  id: string;
  name: string;
}

export interface MailScopeSelection {
  window: MailScopeWindow;
  /**
   * The full-content cutoff, fixed when the scope is approved (ISO timestamp).
   * Absent for `all`. Fixed rather than rolling so a traversal's query is a
   * property of its approval revision and never moves under it.
   */
  contentAfter?: string;
  skippedCategories: GmailScopeCategory[];
  /** Labels the owner chose to skip. Every other label is included. */
  skippedLabels: MailScopeLabel[];
  /** Sender addresses or @domains whose mail is always Private. */
  alwaysPrivateSenders: string[];
  /** Sender addresses or @domains that are never read. */
  skipSenders: string[];
}

/**
 * Owner tier rule in the design's §2.4 shape. The four-tier classifier (P1a)
 * is being built in parallel and its rule file (`~/.olympus/tier-rules.json`)
 * is not on main yet, so the picker stores its rules here, inside the scope
 * approval, in exactly the shape that file will hold.
 *
 * TODO(P2, tier rules): when P1a's rule loader lands, have it read these rules
 * from the mail scope approval (or migrate them into tier-rules.json) so the
 * classifier raises every matching message to Private. Until then they are
 * recorded and shown, and the existing sensitive-sender list remains the only
 * live sender raise.
 */
export interface MailScopeOwnerTierRule {
  source: MailSourceScopeId;
  match: { sender: string };
  /** Schema-v1 key for the Private tier (TRUST_MODEL "Product tier names"). */
  tier: 'secure';
  /** "Always" is an explicit hard rule; item-level raises (Secrets) still apply. */
  strength: 'force';
  origin: 'mail_scope_picker';
}

export interface MailSourceScopeApprovalSnapshot {
  sourceId: MailSourceScopeId;
  status: 'scope_pending' | 'approved';
  accountGeneration?: string;
  revision: string;
  mailScope?: MailScopeSelection;
  ownerTierRules?: MailScopeOwnerTierRule[];
  reason?: 'not_connected' | 'missing' | 'malformed' | 'account_changed';
}

interface PersistedMailSourceScopeApproval {
  source_id: MailSourceScopeId;
  account_generation: string;
  revision: string;
  status: 'approved';
  mail_scope: {
    window: MailScopeWindow;
    content_after?: string;
    skipped_categories: GmailScopeCategory[];
    skipped_labels: MailScopeLabel[];
    always_private_senders: string[];
    skip_senders: string[];
  };
  owner_tier_rules: MailScopeOwnerTierRule[];
  approved_at: string;
}

interface PersistedMailSourceScopeState {
  version: 1;
  approvals: PersistedMailSourceScopeApproval[];
}

export function defaultMailSourceScopeStatePath(handleRegistryPath: string): string {
  return join(dirname(handleRegistryPath), 'mail-source-scopes.json');
}

/** The picker's opening state: 2 years in full, Promotions and Social skipped. */
export function defaultMailScopeSelection(): Omit<MailScopeSelection, 'contentAfter'> {
  return {
    window: DEFAULT_MAIL_SCOPE_WINDOW,
    skippedCategories: [...DEFAULT_SKIPPED_GMAIL_CATEGORIES],
    skippedLabels: [],
    alwaysPrivateSenders: [],
    skipSenders: [],
  };
}

export function connectedMailSourceAccountGeneration(
  registry: SourceScopeConnectedHandleRegistry,
  pinnedHandle?: string,
): ReturnType<typeof connectedSourceScopeAccountGeneration> {
  return connectedSourceScopeAccountGeneration(MAIL_SOURCE_SCOPE_ID, MAIL_SOURCE_SCOPE_CAPABILITY, registry, pinnedHandle);
}

export function readMailSourceScopeApproval(input: {
  registry: SourceScopeConnectedHandleRegistry;
  statePath: string;
  pinnedHandle?: string;
}): MailSourceScopeApprovalSnapshot {
  const account = connectedMailSourceAccountGeneration(input.registry, input.pinnedHandle);
  if (!account) return pendingSnapshot('not-connected', undefined, 'not_connected');
  const read = readState(input.statePath);
  if (read.kind === 'missing') return pendingSnapshot(`missing:${account.generation}`, account.generation, 'missing');
  if (read.kind === 'malformed') return pendingSnapshot(`malformed:${read.digest}`, account.generation, 'malformed');
  const approval = read.state.approvals.find((candidate) => candidate.source_id === MAIL_SOURCE_SCOPE_ID);
  if (!approval) return pendingSnapshot(`missing:${account.generation}`, account.generation, 'missing');
  if (approval.account_generation !== account.generation) {
    return pendingSnapshot(`stale:${approval.revision}:${account.generation}`, account.generation, 'account_changed');
  }
  return {
    sourceId: MAIL_SOURCE_SCOPE_ID,
    status: 'approved',
    accountGeneration: account.generation,
    revision: approval.revision,
    mailScope: fromPersistedScope(approval.mail_scope),
    ownerTierRules: approval.owner_tier_rules,
  };
}

/**
 * Save an approved mail scope. Every save mints a new revision, which is what
 * re-binds the Gmail traversal: the scheduler task id and the store cursor are
 * both keyed to it, so a changed scope starts a fresh traversal under the new
 * query instead of resuming the old one's watermark.
 */
export function approveMailSourceScope(input: {
  registry: SourceScopeConnectedHandleRegistry;
  statePath: string;
  pinnedHandle?: string;
  accountGeneration: string;
  expectedRevision: string;
  scope: Omit<MailScopeSelection, 'contentAfter'>;
  now?: Date;
}): MailSourceScopeApprovalSnapshot {
  return withFileLeaseSync(input.statePath, (lease) => {
    const current = readMailSourceScopeApproval(input);
    if (!current.accountGeneration || current.accountGeneration !== input.accountGeneration) {
      throw new OperationError('source_index_policy_violation', 'The connected mailbox changed. Reopen the picker and choose its scope again.');
    }
    if (current.revision !== input.expectedRevision) {
      throw new OperationError('source_index_policy_violation', 'The mail scope changed. Reload it before saving.');
    }
    const now = input.now ?? new Date();
    const scope = normalizeMailScope(input.scope, now);
    const existing = readState(input.statePath);
    const approvals = existing.kind === 'valid'
      ? existing.state.approvals.filter((candidate) => candidate.source_id !== MAIL_SOURCE_SCOPE_ID)
      : [];
    const revision = randomUUID();
    const ownerTierRules = mailScopeOwnerTierRules(scope);
    approvals.push({
      source_id: MAIL_SOURCE_SCOPE_ID,
      account_generation: input.accountGeneration,
      revision,
      status: 'approved',
      mail_scope: toPersistedScope(scope),
      owner_tier_rules: ownerTierRules,
      approved_at: now.toISOString(),
    });
    const state: PersistedMailSourceScopeState = { version: 1, approvals };
    lease.commit(() => writePrivateFileAtomicSync(input.statePath, `${JSON.stringify(state, null, 2)}\n`));
    return {
      sourceId: MAIL_SOURCE_SCOPE_ID,
      status: 'approved',
      accountGeneration: input.accountGeneration,
      revision,
      mailScope: scope,
      ownerTierRules,
    };
  });
}

export function assertMailSourceScopeApproved(input: {
  registry: SourceScopeConnectedHandleRegistry;
  statePath: string;
  pinnedHandle?: string;
  expectedAccountGeneration?: string;
  expectedRevision?: string;
}): MailSourceScopeApprovalSnapshot & { status: 'approved'; mailScope: MailScopeSelection; accountGeneration: string } {
  const approval = readMailSourceScopeApproval(input);
  if (
    approval.status !== 'approved'
    || !approval.mailScope
    || !approval.accountGeneration
    || (input.expectedAccountGeneration !== undefined && approval.accountGeneration !== input.expectedAccountGeneration)
    || (input.expectedRevision !== undefined && approval.revision !== input.expectedRevision)
  ) {
    throw new OperationError('source_index_policy_violation', 'Mail scope approval is required for this connected mailbox.');
  }
  return approval as MailSourceScopeApprovalSnapshot & { status: 'approved'; mailScope: MailScopeSelection; accountGeneration: string };
}

/** The design's §2.4 rules the picker's "always Private" list becomes. */
export function mailScopeOwnerTierRules(scope: Pick<MailScopeSelection, 'alwaysPrivateSenders'>): MailScopeOwnerTierRule[] {
  return scope.alwaysPrivateSenders.map((sender) => ({
    source: MAIL_SOURCE_SCOPE_ID,
    match: { sender },
    tier: 'secure' as const,
    strength: 'force' as const,
    origin: 'mail_scope_picker' as const,
  }));
}

// ---------------------------------------------------------------------------
// Query compilation
// ---------------------------------------------------------------------------

export interface CompiledGmailMailScope {
  /**
   * Every filter except the date bound: categories, labels, skipped senders,
   * and the operator's hidden query override (ANDed). Undefined when nothing
   * filters.
   */
  baseQuery?: string;
  /** Mail at or after this instant is read in full; older mail is metadata-only. */
  contentAfterMs?: number;
  /** The full-content traversal's query (base AND after:). */
  contentQuery?: string;
  /** The metadata-only traversal's query (base AND before:); absent for `all`. */
  metadataQuery?: string;
  /** Category label ids the scope skips, for the connector's post-fetch filter. */
  skippedCategoryLabelIds: string[];
}

/**
 * The approved scope as Gmail search syntax. Terms are space-separated, which
 * Gmail ANDs; the operator override is parenthesised so an OR inside it cannot
 * leak across the picker's terms.
 */
export function compileGmailMailScope(
  scope: MailScopeSelection,
  options: { operatorQuery?: string | undefined } = {},
): CompiledGmailMailScope {
  const terms = [
    ...scope.skippedCategories.map((category) => `-category:${category}`),
    ...scope.skippedLabels.map((label) => `-label:${gmailSearchValue(label.name)}`),
    // A whole-domain rule is written `@example.com`; Gmail's from: matches a
    // bare domain, so the leading @ is dropped from the search term.
    ...scope.skipSenders.map((sender) => `-from:${gmailSearchValue(sender.startsWith('@') ? sender.slice(1) : sender)}`),
  ];
  const operator = options.operatorQuery?.trim();
  if (operator) terms.push(`(${operator})`);
  const baseQuery = terms.length > 0 ? terms.join(' ') : undefined;
  const contentAfterMs = scope.contentAfter ? Date.parse(scope.contentAfter) : undefined;
  const skippedCategoryLabelIds = scope.skippedCategories.map((category) => GMAIL_SCOPE_CATEGORY_LABEL_IDS[category]);
  if (contentAfterMs === undefined || !Number.isFinite(contentAfterMs)) {
    return {
      ...(baseQuery ? { baseQuery, contentQuery: baseQuery } : {}),
      skippedCategoryLabelIds,
    };
  }
  // Gmail's after:/before: take epoch seconds. after:(s-1) admits every
  // message stamped in second s or later and before:s every one before it, so
  // the two traversals partition the mailbox at the cutoff second. The
  // connector re-checks internalDate on both sides anyway.
  const cutoffSeconds = Math.floor(contentAfterMs / 1_000);
  const withBase = (bound: string): string => (baseQuery ? `${bound} ${baseQuery}` : bound);
  return {
    ...(baseQuery ? { baseQuery } : {}),
    contentAfterMs: cutoffSeconds * 1_000,
    contentQuery: withBase(`after:${cutoffSeconds - 1}`),
    metadataQuery: withBase(`before:${cutoffSeconds}`),
    skippedCategoryLabelIds,
  };
}

/** The full-content cutoff for a window, measured back from `now`. */
export function mailScopeContentAfter(window: MailScopeWindow, now: Date): string | undefined {
  if (window === 'all') return undefined;
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MAIL_SCOPE_WINDOW_MONTHS[window]);
  cutoff.setUTCHours(0, 0, 0, 0);
  return cutoff.toISOString();
}

function gmailSearchValue(value: string): string {
  // Quotes delimit a multi-word label or address; a value may not carry one.
  const cleaned = value.replace(/"/g, '').trim();
  return /[\s()]/.test(cleaned) ? `"${cleaned}"` : cleaned;
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

/**
 * Stated assumptions behind the estimate. These are rough on purpose and the
 * picker labels every number built from them as an estimate.
 */
export const MAIL_SCOPE_ESTIMATE_ASSUMPTIONS = {
  /** An average email body is ~3,000 characters, ~750 embedding tokens. */
  tokensPerFullMessage: 750,
  /**
   * Gemini Embedding 2 list price assumed by the design doc (§4.4, UNVERIFIED;
   * read the live price before relying on it). Private mail embeds locally or
   * on Venice for less, so this is an upper bound for the full-content leg.
   */
  embeddingUsdPerMillionTokens: 0.15,
  /** Gmail lists 100 ids per request, then one get per message. */
  messagesPerListRequest: 100,
} as const;

export interface MailScopeEstimateInput {
  /** Messages the full-content query matches (Gmail resultSizeEstimate). */
  contentMessages: number;
  /** Messages the metadata-only query matches. */
  metadataMessages: number;
  /** Messages one scheduled pass may read (DEFAULT_GMAIL_SYNC_MAX_MESSAGES). */
  messagesPerPass: number;
  /** Minutes between scheduled passes. */
  passIntervalMinutes: number;
  /** Provider requests the Gmail lane may spend per day. */
  dailyRequestBudget: number;
}

export interface MailScopeEstimate {
  estimate: true;
  content_messages: number;
  metadata_messages: number;
  total_messages: number;
  provider_requests: number;
  messages_per_day: number;
  /** Days of scheduled passes to finish the first read. */
  sync_days: number;
  embedding_tokens: number;
  embedding_cost_usd: number;
  limited_by: 'daily_request_budget' | 'pass_cadence';
}

export function estimateMailScope(input: MailScopeEstimateInput): MailScopeEstimate {
  const content = nonNegativeInteger(input.contentMessages);
  const metadata = nonNegativeInteger(input.metadataMessages);
  const total = content + metadata;
  const perList = MAIL_SCOPE_ESTIMATE_ASSUMPTIONS.messagesPerListRequest;
  const providerRequests = total + Math.ceil(content / perList) + Math.ceil(metadata / perList);
  const passesPerDay = Math.max(1, Math.floor((24 * 60) / Math.max(1, input.passIntervalMinutes)));
  const cadenceCap = passesPerDay * Math.max(1, input.messagesPerPass);
  // Each message costs one get, and every 100 cost one list on top.
  const budgetCap = Math.floor(Math.max(1, input.dailyRequestBudget) * perList / (perList + 1));
  const messagesPerDay = Math.max(1, Math.min(cadenceCap, budgetCap));
  const embeddingTokens = content * MAIL_SCOPE_ESTIMATE_ASSUMPTIONS.tokensPerFullMessage;
  return {
    estimate: true,
    content_messages: content,
    metadata_messages: metadata,
    total_messages: total,
    provider_requests: providerRequests,
    messages_per_day: messagesPerDay,
    sync_days: Math.round((total / messagesPerDay) * 10) / 10,
    embedding_tokens: embeddingTokens,
    embedding_cost_usd: Math.round(
      (embeddingTokens / 1_000_000) * MAIL_SCOPE_ESTIMATE_ASSUMPTIONS.embeddingUsdPerMillionTokens * 100,
    ) / 100,
    limited_by: budgetCap <= cadenceCap ? 'daily_request_budget' : 'pass_cadence',
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

// ---------------------------------------------------------------------------
// Validation and persistence
// ---------------------------------------------------------------------------

export function isMailScopeWindow(value: unknown): value is MailScopeWindow {
  return typeof value === 'string' && (MAIL_SCOPE_WINDOWS as readonly string[]).includes(value);
}

export function isGmailScopeCategory(value: unknown): value is GmailScopeCategory {
  return typeof value === 'string' && (GMAIL_SCOPE_CATEGORIES as readonly string[]).includes(value);
}

export function normalizeMailScope(
  input: Omit<MailScopeSelection, 'contentAfter'> & { contentAfter?: string },
  now: Date,
): MailScopeSelection {
  if (!isMailScopeWindow(input.window)) throw new OperationError('invalid_request', 'Choose a valid mail time window.');
  if (!Array.isArray(input.skippedCategories) || input.skippedCategories.some((category) => !isGmailScopeCategory(category))) {
    throw new OperationError('invalid_request', 'Every skipped category must be a Gmail category.');
  }
  if (!Array.isArray(input.skippedLabels) || input.skippedLabels.length > MAX_SCOPE_LABELS) {
    throw new OperationError('invalid_request', `Skip at most ${MAX_SCOPE_LABELS} labels.`);
  }
  const labels = new Map<string, MailScopeLabel>();
  for (const label of input.skippedLabels) {
    const id = typeof label?.id === 'string' ? label.id.trim() : '';
    const name = typeof label?.name === 'string' ? label.name.replace(/"/g, '').trim() : '';
    if (!id || id.length > 256 || !name || name.length > MAX_LABEL_NAME_CHARS) {
      throw new OperationError('invalid_request', 'Every skipped label needs its Gmail id and name.');
    }
    labels.set(id, { id, name });
  }
  const contentAfter = input.window === 'all'
    ? undefined
    : input.contentAfter && Number.isFinite(Date.parse(input.contentAfter))
      ? new Date(Date.parse(input.contentAfter)).toISOString()
      : mailScopeContentAfter(input.window, now);
  return {
    window: input.window,
    ...(contentAfter ? { contentAfter } : {}),
    skippedCategories: GMAIL_SCOPE_CATEGORIES.filter((category) => input.skippedCategories.includes(category)),
    skippedLabels: [...labels.values()].sort((left, right) => left.id.localeCompare(right.id)),
    alwaysPrivateSenders: normalizeSenders(input.alwaysPrivateSenders, 'always Private'),
    skipSenders: normalizeSenders(input.skipSenders, 'skip'),
  };
}

/**
 * A sender rule is an address (`name@example.com`) or a whole domain
 * (`@example.com`), lower-cased and de-duplicated. Anything else is refused so
 * a typo cannot compile into a search term that silently matches nothing.
 */
export function normalizeSenders(input: unknown, label: string): string[] {
  if (!Array.isArray(input) || input.length > MAX_SENDER_RULES) {
    throw new OperationError('invalid_request', `The ${label} list holds at most ${MAX_SENDER_RULES} senders.`);
  }
  const senders = new Set<string>();
  for (const value of input) {
    const sender = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!sender) continue;
    if (sender.length > MAX_SENDER_CHARS || !/^(?:[^\s@"()]+)?@[a-z0-9.-]+\.[a-z]{2,}$/.test(sender)) {
      throw new OperationError('invalid_request', `"${sender.slice(0, 80)}" in the ${label} list is not an email address or @domain.`);
    }
    senders.add(sender);
  }
  return [...senders].sort();
}

function toPersistedScope(scope: MailScopeSelection): PersistedMailSourceScopeApproval['mail_scope'] {
  return {
    window: scope.window,
    ...(scope.contentAfter ? { content_after: scope.contentAfter } : {}),
    skipped_categories: scope.skippedCategories,
    skipped_labels: scope.skippedLabels,
    always_private_senders: scope.alwaysPrivateSenders,
    skip_senders: scope.skipSenders,
  };
}

function fromPersistedScope(scope: PersistedMailSourceScopeApproval['mail_scope']): MailScopeSelection {
  return {
    window: scope.window,
    ...(scope.content_after ? { contentAfter: scope.content_after } : {}),
    skippedCategories: scope.skipped_categories,
    skippedLabels: scope.skipped_labels,
    alwaysPrivateSenders: scope.always_private_senders,
    skipSenders: scope.skip_senders,
  };
}

function pendingSnapshot(
  revision: string,
  accountGeneration: string | undefined,
  reason: NonNullable<MailSourceScopeApprovalSnapshot['reason']>,
): MailSourceScopeApprovalSnapshot {
  return {
    sourceId: MAIL_SOURCE_SCOPE_ID,
    status: 'scope_pending',
    ...(accountGeneration ? { accountGeneration } : {}),
    revision,
    reason,
  };
}

type StateRead =
  | { kind: 'missing' }
  | { kind: 'malformed'; digest: string }
  | { kind: 'valid'; state: PersistedMailSourceScopeState };

function readState(path: string): StateRead {
  if (!existsSync(path)) return { kind: 'missing' };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { kind: 'malformed', digest: 'unreadable' };
  }
  const digest = createHash('sha256').update(raw).digest('hex');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('record');
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.approvals)) throw new Error('version');
    const approvals = record.approvals.map(parseApproval);
    if (new Set(approvals.map((entry) => entry.source_id)).size !== approvals.length) throw new Error('duplicate');
    return { kind: 'valid', state: { version: 1, approvals } };
  } catch {
    return { kind: 'malformed', digest };
  }
}

function parseApproval(value: unknown): PersistedMailSourceScopeApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('approval');
  const record = value as Record<string, unknown>;
  if (
    record.source_id !== MAIL_SOURCE_SCOPE_ID
    || typeof record.account_generation !== 'string' || !/^[a-f0-9]{64}$/.test(record.account_generation)
    || typeof record.revision !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.revision)
    || record.status !== 'approved'
    || typeof record.approved_at !== 'string' || !Number.isFinite(Date.parse(record.approved_at))
    || !record.mail_scope || typeof record.mail_scope !== 'object' || Array.isArray(record.mail_scope)
  ) throw new Error('approval');
  const scope = record.mail_scope as Record<string, unknown>;
  const normalized = normalizeMailScope({
    window: scope.window as MailScopeWindow,
    ...(typeof scope.content_after === 'string' ? { contentAfter: scope.content_after } : {}),
    skippedCategories: scope.skipped_categories as GmailScopeCategory[],
    skippedLabels: scope.skipped_labels as MailScopeLabel[],
    alwaysPrivateSenders: scope.always_private_senders as string[],
    skipSenders: scope.skip_senders as string[],
  }, new Date(Date.parse(record.approved_at)));
  return {
    source_id: MAIL_SOURCE_SCOPE_ID,
    account_generation: record.account_generation,
    revision: record.revision,
    status: 'approved',
    mail_scope: toPersistedScope(normalized),
    // Derived, never trusted from disk: the rules are a function of the list.
    owner_tier_rules: mailScopeOwnerTierRules(normalized),
    approved_at: record.approved_at,
  };
}
