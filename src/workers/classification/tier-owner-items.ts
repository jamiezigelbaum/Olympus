// The owner's one-item privacy change (issue #1060): find an item, see how it
// was judged, and set it Personal or Private, or put it back to the judge's
// verdict. Each change is the owner's decision on that one item, stored as the
// per-item override `olympus tier set` writes (tier-cli.ts `applyTierSet`); it
// never becomes a rule for a source, chat or folder.
//
// Two callers, two powers:
// - the dashboard on this computer (a local control session): Personal,
//   Private, or back to the judge (`allowLower: true`);
// - an AI app (the privacy_item_set operation): Private only. Raising adds
//   protection, so an agent may offer it; lowering never comes from an agent.
//   Enforced here as well as in the operation.
//
// Secrets stay as they are: an item that is Secrets is neither listed nor
// changed from here. Output names the item (title, sender, file name) only
// for the owner's own dashboard, or, for an agent, only when the item's names
// are Personal or less, the tier its names would be cited at anyway.

import { OperationError } from '../../core/operation-error.ts';
import {
  applyTierSet,
  knownStorePaths,
  knownTierLedgers,
  locateTierItemByIdentity,
  withLedgerAt,
  withStore,
  type LocatedItem,
  type TierCliContext,
} from './tier-cli.ts';
import { tierRank, type TierKey } from './tier-classifier.ts';
import { tierLedgerIdentityKey, type TierLedgerIdentity, type TierLedgerRecord } from './tier-ledger.ts';
import { tierDisplayName } from './tier-rules.ts';

/** What the owner can choose for one item. `judge`: clear the owner's word and go back to the judge's verdict. */
export type OwnerItemChoice = 'personal' | 'private' | 'judge';

export const OWNER_ITEM_DEFAULT_LIMIT = 20;
export const OWNER_ITEM_MAX_LIMIT = 50;
const OWNER_ITEM_QUERY_MAX = 200;
/** How much of an item's text its preview shows. */
export const OWNER_ITEM_PREVIEW_MAX = 600;
const ITEM_ID_PREFIX = 'oti_';

export interface OwnerTierItem {
  /** Opaque id for this item, passed back to set it. */
  item_id: string;
  /** The provider the item came from (gmail, dropbox, telegram, ...). */
  source: string;
  family: string;
  title: string | null;
  sender: string | null;
  /** The file's path or the item's link, as its store keeps it. */
  location: string | null;
  /** The item's privacy label (its text's tier), as the dashboard names it; null while nothing is recorded. */
  tier: string | null;
  /** The tier of its names (title, sender, file name). */
  names_tier: string | null;
  /** While a move is in flight: the label it is moving to. */
  moving_to?: string;
  /** Which step decided it: `override` is the owner, `sniffer` the judge. */
  decided_by: string | null;
  /** The owner set this item by hand, and it is held there. */
  owner_set: boolean;
  /** The judge's stored reason code (its category and confidence), where the judge decided it. */
  judge_reason: string | null;
  decided_at: string | null;
  /**
   * The start of what the item says, for the owner to read before deciding.
   * Only when the dashboard on this computer asks (`withPreview`); never for an agent.
   */
  preview?: string | null;
}

export interface OwnerTierItemFindInput {
  /** Words from the item's title, sender or file name. Omit with `recent`. */
  query?: string;
  /** List the items sorted most recently instead of searching. */
  recent?: boolean;
  /**
   * With `recent`: only items labelled Personal or Private, or only those the
   * owner changed by hand (the dashboard's filters).
   */
  filter?: OwnerTierItemFilter;
  /** With `recent`: only items decided before this time (an item's `decided_at`), to page further back. */
  before?: string;
  /**
   * With `before`: the item the last page ended on (its `item_id`). Items
   * decided at that same time but sorted after it are listed too, so no item
   * sharing a time with a page's last one is skipped.
   */
  beforeItem?: string;
  limit?: number;
  /**
   * For an agent: leave out every item whose names are not Personal or less
   * (and every item with nothing recorded yet), so no Private name is shown.
   */
  personalNamesOnly?: boolean;
  /**
   * The dashboard on this computer: add the start of each item's stored text.
   * Ignored with `personalNamesOnly`, so an agent never reads an item's text from here.
   */
  withPreview?: boolean;
}

export type OwnerTierItemFilter = 'personal' | 'private' | 'changed';

/** How many items carry each label, and how many the owner changed by hand: the dashboard's filter counts. */
export interface OwnerTierItemCounts {
  personal: number;
  private: number;
  changed: number;
}

export interface OwnerTierItemSetInput {
  itemId: string;
  choice: OwnerItemChoice;
  /** The dashboard on this computer: Personal and the judge's verdict are allowed. An agent: Private only. */
  allowLower: boolean;
}

export type OwnerTierItemSetResult =
  | { ok: true; item: OwnerTierItem; changed: 'set' | 'cleared' | 'unchanged'; applies: 'now' | 'next_pass'; results: Array<Record<string, unknown>> }
  | { ok: false; code: 'not_found' | 'secret_item' | 'dashboard_only' | 'not_owner_set'; message: string };

/** The bound engine the worker serves (email-source/index.ts). */
export interface OwnerTierItems {
  find(input: OwnerTierItemFindInput): { items: OwnerTierItem[] };
  set(input: OwnerTierItemSetInput): OwnerTierItemSetResult;
  /** The dashboard's filter counts. Optional so a narrow engine can leave the counts off. */
  counts?(): OwnerTierItemCounts;
}

export function createOwnerTierItems(context: TierCliContext = {}): OwnerTierItems {
  return {
    find: (input) => findOwnerTierItems(input, context),
    set: (input) => setOwnerTierItem(input, context),
    counts: () => countOwnerTierItems(context),
  };
}

// --- Item ids ------------------------------------------------------------------

export function ownerTierItemId(identity: TierLedgerIdentity): string {
  const parts = [identity.provider, identity.accountScope, identity.providerConversationId ?? '', identity.providerItemId];
  return ITEM_ID_PREFIX + Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function parseOwnerTierItemId(itemId: unknown): TierLedgerIdentity {
  const invalid = () => new OperationError('invalid_params', 'item_id is not one Olympus gave.', 'Find the item again and use the item_id it lists.');
  if (typeof itemId !== 'string' || !itemId.startsWith(ITEM_ID_PREFIX) || itemId.length > 4_096) throw invalid();
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(itemId.slice(ITEM_ID_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parts) || parts.length !== 4 || !parts.every((part) => typeof part === 'string')) throw invalid();
  const [provider, accountScope, conversation, providerItemId] = parts as [string, string, string, string];
  if (!provider || !accountScope || !providerItemId) throw invalid();
  return { provider, accountScope, providerItemId, ...(conversation ? { providerConversationId: conversation } : {}) };
}

// --- Find ----------------------------------------------------------------------

interface StoredItemRow {
  provider: string;
  family: string;
  account_scope: string;
  provider_item_id: string;
  provider_conversation_id: string | null;
  title: string | null;
  sender_label: string | null;
  sender_id: string | null;
  locator_uri: string | null;
}

interface ItemState {
  record: TierLedgerRecord | undefined;
  ownerSet: boolean;
  /** The owner's tier override, when one is set. */
  ownerTier?: TierKey;
  secret: boolean;
}

/**
 * Whether the item's names are, or are about to be, above Personal: decided
 * so, moving there, or set so by the owner. Nothing recorded counts as above.
 */
function namesAbovePersonal(state: ItemState): boolean {
  const { record } = state;
  if (!record) return true;
  return [record.metadataTier, record.targetMetadataTier, state.ownerTier]
    .some((tier) => tier !== null && tier !== undefined && tierRank(tier) > tierRank('private'));
}

export function findOwnerTierItems(input: OwnerTierItemFindInput, context: TierCliContext = {}): { items: OwnerTierItem[] } {
  const limit = clampLimit(input.limit);
  const query = input.query?.trim() ?? '';
  if (query.length > OWNER_ITEM_QUERY_MAX) throw new OperationError('invalid_params', `query is at most ${OWNER_ITEM_QUERY_MAX} characters.`);
  if (!input.recent && !query) throw new OperationError('invalid_params', 'Give words to search for, or ask for the recently sorted items.');
  if (input.recent && query) throw new OperationError('invalid_params', 'Search, or list the recently sorted items, not both.');
  if (input.filter !== undefined && (!input.recent || !['personal', 'private', 'changed'].includes(input.filter))) {
    throw new OperationError('invalid_params', 'filter is personal, private or changed, with the recently sorted items.');
  }
  if (input.before !== undefined && (!input.recent || input.filter === 'changed' || Number.isNaN(Date.parse(input.before)))) {
    throw new OperationError('invalid_params', 'before is a time, with the recently sorted items.');
  }
  if (input.beforeItem !== undefined && input.before === undefined) {
    throw new OperationError('invalid_params', 'beforeItem goes with before.');
  }
  const beforeItem = input.beforeItem === undefined ? undefined : parseOwnerTierItemId(input.beforeItem);
  const rows = input.recent ? recentRows(limit * 3, context, input.filter, input.before, beforeItem) : searchRows(query, limit * 3, context);
  const items: OwnerTierItem[] = [];
  for (const row of rows) {
    if (items.length >= limit) break;
    const identity = identityOfRow(row);
    const state = readItemState(identity, context);
    if (state.secret) continue;
    if (input.personalNamesOnly && namesAbovePersonal(state)) continue;
    const item = view(row, state);
    if (input.withPreview && !input.personalNamesOnly) item.preview = previewOf(identity, context);
    items.push(item);
  }
  return { items };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return OWNER_ITEM_DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) throw new OperationError('invalid_params', 'limit must be a positive number.');
  return Math.min(Math.floor(limit), OWNER_ITEM_MAX_LIMIT);
}

function likePattern(words: string): string {
  return `%${words.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}


function selectColumns(columns: Set<string>): string {
  const sender = columns.has('sender_label') ? 'sender_label, sender_id' : 'NULL AS sender_label, NULL AS sender_id';
  return `provider, family, account_scope, provider_item_id, provider_conversation_id, title, ${sender}, locator_uri`;
}

/** Stored items whose title, sender or file name holds the words, newest first; one row per item across twin stores. */
function searchRows(query: string, limit: number, context: TierCliContext): StoredItemRow[] {
  const pattern = likePattern(query);
  const found = new Map<string, StoredItemRow & { at: string }>();
  for (const dbPath of knownStorePaths(context)) {
    const rows = withStore<Array<StoredItemRow & { at: string }>>(dbPath, [], (db, columns) => {
      const fields = ['title', 'locator_uri', ...(columns.has('sender_label') ? ['sender_label', 'sender_id'] : [])];
      return db.query(`
        SELECT ${selectColumns(columns)}, COALESCE(authored_at, indexed_at, '') AS at FROM items
        WHERE tombstoned = 0 AND (${fields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})
        ORDER BY at DESC
        LIMIT ?
      `).all(...fields.map(() => pattern), limit) as Array<StoredItemRow & { at: string }>;
    });
    for (const row of rows) {
      const key = tierLedgerIdentityKey(identityOfRow(row));
      if (!found.has(key)) found.set(key, row);
    }
  }
  return [...found.values()].sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
}

/** The items the ledgers decided most recently, newest first, as their stores keep them; with a filter, only those. */
function recentRows(limit: number, context: TierCliContext, filter?: OwnerTierItemFilter, before?: string, beforeItem?: TierLedgerIdentity): StoredItemRow[] {
  const decided = new Map<string, TierLedgerRecord>();
  for (const ledger of knownTierLedgers(context)) {
    let records: TierLedgerRecord[] = [];
    try {
      records = withLedgerAt(ledger.path, context.now, (opened) => filter === 'changed'
        ? opened.listRoutedOverrides().filter(({ override }) => override.kind === 'tier').map(({ record }) => record)
          .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt)).slice(0, limit)
        : opened.recentDecisions(limit, filter === 'personal' ? 'private' : filter === 'private' ? 'secure' : undefined, before, beforeItem), ledger.boundLedgerId);
    } catch {
      // A ledger that cannot be read lists nothing.
    }
    for (const record of records) {
      const key = tierLedgerIdentityKey(identityOfRecord(record));
      const seen = decided.get(key);
      if (!seen || seen.decidedAt < record.decidedAt) decided.set(key, record);
    }
  }
  // Newest first, then the ledger's own tie order, so paging by the last item resumes where a page ended.
  const ordered = [...decided.values()].sort(recentOrder).slice(0, limit);
  const stores = knownStorePaths(context);
  const rows: StoredItemRow[] = [];
  for (const record of ordered) {
    const identity = identityOfRecord(record);
    for (const dbPath of stores) {
      const row = withStore<StoredItemRow | undefined>(dbPath, undefined, (db, columns) => (db.query(`
        SELECT ${selectColumns(columns)} FROM items
        WHERE tombstoned = 0 AND provider = ? AND account_scope = ? AND provider_item_id = ?
          AND COALESCE(provider_conversation_id, '') = ?
        LIMIT 1
      `).get(identity.provider, identity.accountScope, identity.providerItemId, identity.providerConversationId ?? '') as StoredItemRow | null) ?? undefined);
      if (row) {
        rows.push(row);
        break;
      }
    }
  }
  return rows;
}

/** The start of the item's stored text (its first chunk), from the first store that holds it; null when none does. */
function previewOf(identity: TierLedgerIdentity, context: TierCliContext): string | null {
  for (const dbPath of knownStorePaths(context)) {
    const text = withStore<string | undefined>(dbPath, undefined, (db) => (db.query(`
      SELECT c.bounded_text AS text FROM items i JOIN chunks c ON c.item_pk = i.item_pk
      WHERE i.tombstoned = 0 AND i.provider = ? AND i.account_scope = ? AND i.provider_item_id = ?
        AND COALESCE(i.provider_conversation_id, '') = ?
      ORDER BY c.chunk_index
      LIMIT 1
    `).get(identity.provider, identity.accountScope, identity.providerItemId, identity.providerConversationId ?? '') as { text: string } | null)?.text);
    const trimmed = text?.trim();
    if (trimmed) return trimmed.length > OWNER_ITEM_PREVIEW_MAX ? `${trimmed.slice(0, OWNER_ITEM_PREVIEW_MAX).trimEnd()}…` : trimmed;
  }
  return null;
}

/** Every ledger's items by label, and the owner's own changes. Counts only: nothing about any item. */
export function countOwnerTierItems(context: TierCliContext = {}): OwnerTierItemCounts {
  const counts: OwnerTierItemCounts = { personal: 0, private: 0, changed: 0 };
  for (const ledger of knownTierLedgers(context)) {
    try {
      withLedgerAt(ledger.path, context.now, (opened) => {
        const byTier = opened.counts().byContentTier;
        counts.personal += byTier.private;
        counts.private += byTier.secure;
        counts.changed += opened.listRoutedOverrides().filter(({ override }) => override.kind === 'tier').length;
      }, ledger.boundLedgerId);
    } catch {
      // A ledger that cannot be read counts nothing.
    }
  }
  return counts;
}

function identityOfRow(row: StoredItemRow): TierLedgerIdentity {
  return {
    provider: row.provider,
    accountScope: row.account_scope,
    providerItemId: row.provider_item_id,
    ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
  };
}

/** The ledgers' recently-sorted order: newest first, then provider, account, chat and item (recentDecisions). */
function recentOrder(left: TierLedgerRecord, right: TierLedgerRecord): number {
  if (left.decidedAt !== right.decidedAt) return left.decidedAt < right.decidedAt ? 1 : -1;
  const keys = (record: TierLedgerRecord) => [record.provider, record.accountScope, record.conversationKey, record.providerItemId];
  const [a, b] = [keys(left), keys(right)];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function identityOfRecord(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}

function readLocatedState(items: readonly LocatedItem[], context: TierCliContext): ItemState {
  const state: ItemState = { record: undefined, ownerSet: false, secret: false };
  for (const item of items) {
    withLedgerAt(item.ledgerPath, context.now, (ledger) => {
      const record = ledger.getCurrent(item.identity);
      const override = ledger.getOverride(item.identity);
      if (record && !state.record) state.record = record;
      if (override?.kind === 'tier') {
        state.ownerSet = true;
        state.ownerTier = override.tier;
      }
      if (ledger.itemIsSecret(item.identity)) state.secret = true;
    }, item.boundLedgerId);
  }
  return state;
}

function readItemState(identity: TierLedgerIdentity, context: TierCliContext): ItemState {
  try {
    return readLocatedState(locateTierItemByIdentity(identity, context), context);
  } catch {
    return { record: undefined, ownerSet: false, secret: false };
  }
}

/** The judge's verdict code (`content:sniffer:<judge>:<code>`), or its names verdict; never "undecided". */
function judgeReason(record: TierLedgerRecord | undefined): string | null {
  if (!record) return null;
  for (const prefix of ['content:sniffer:', 'metadata:sniffer:']) {
    for (const reason of record.reasons) {
      if (!reason.startsWith(prefix)) continue;
      const rest = reason.slice(prefix.length);
      // The judge's id ends at the first colon after its model part; what follows is its verdict code.
      const separator = rest.indexOf(':', rest.indexOf('.m') >= 0 ? rest.indexOf('.m') : 0);
      const code = separator >= 0 ? rest.slice(separator + 1) : '';
      if (code && code !== 'undecided') return code;
    }
  }
  return null;
}

function view(row: StoredItemRow, state: ItemState): OwnerTierItem {
  const { record } = state;
  return {
    item_id: ownerTierItemId(identityOfRow(row)),
    source: row.provider,
    family: row.family,
    title: row.title,
    sender: row.sender_label?.trim() || row.sender_id?.trim() || null,
    location: row.locator_uri,
    tier: record ? tierDisplayName(record.contentTier) : null,
    names_tier: record ? tierDisplayName(record.metadataTier) : null,
    ...(record?.state === 'moving' && record.targetContentTier ? { moving_to: tierDisplayName(record.targetContentTier) } : {}),
    decided_by: record?.decidedBy ?? null,
    owner_set: state.ownerSet,
    judge_reason: judgeReason(record),
    decided_at: record?.decidedAt ?? null,
  };
}

/**
 * One item by its id, as the dashboard on this computer shows it (with its
 * preview when asked); undefined when Olympus no longer holds it or it is
 * Secret. For the owner's own dashboard only (judge-check.ts): an agent finds
 * items through `findOwnerTierItems` with `personalNamesOnly`.
 */
export function getOwnerTierItem(itemId: string, context: TierCliContext = {}, options: { withPreview?: boolean } = {}): OwnerTierItem | undefined {
  const identity = parseOwnerTierItemId(itemId);
  let located: LocatedItem[];
  try {
    located = locateTierItemByIdentity(identity, context);
  } catch {
    return undefined;
  }
  if (located.length === 0) return undefined;
  const state = readLocatedState(located, context);
  if (state.secret) return undefined;
  const item = view(storedRowFor(identity, located, context), state);
  if (options.withPreview) item.preview = previewOf(identity, context);
  return item;
}

// --- Set -----------------------------------------------------------------------

export function setOwnerTierItem(input: OwnerTierItemSetInput, context: TierCliContext = {}): OwnerTierItemSetResult {
  const { choice } = input;
  if (choice !== 'personal' && choice !== 'private' && choice !== 'judge') {
    throw new OperationError('invalid_params', 'tier must be "personal", "private" or "judge".');
  }
  const identity = parseOwnerTierItemId(input.itemId);
  if (!input.allowLower && choice !== 'private') {
    // Only a raise can come from here: Personal, or back to a judge's lower
    // verdict, is the owner's call on the dashboard on this computer.
    return {
      ok: false,
      code: 'dashboard_only',
      message: 'An AI app can only make an item Private. To make it Personal, or put it back to the judge\'s label, use Privacy on the Olympus dashboard on this computer.',
    };
  }
  let located: LocatedItem[];
  try {
    located = locateTierItemByIdentity(identity, context);
  } catch (error) {
    if (error instanceof OperationError && error.code === 'invalid_params') {
      return { ok: false, code: 'not_found', message: 'Olympus no longer holds that item.' };
    }
    throw error;
  }
  const before = readLocatedState(located, context);
  if (before.secret) {
    return { ok: false, code: 'secret_item', message: 'This item is Secret. Secret items are not changed from here.' };
  }
  let results: Array<Record<string, unknown>>;
  let changed: 'set' | 'cleared' | 'unchanged';
  if (choice === 'judge') {
    if (!before.ownerSet) {
      return { ok: false, code: 'not_owner_set', message: 'This item already has the judge\'s label: nobody changed it by hand.' };
    }
    results = applyTierSet(located, 'clear', context);
    changed = 'cleared';
  } else {
    const tier: TierKey = choice === 'personal' ? 'private' : 'secure';
    results = applyTierSet(located, { kind: 'tier', tier }, context);
    changed = before.ownerSet && before.record?.contentTier === tier && before.record.metadataTier === tier ? 'unchanged' : 'set';
  }
  const after = readLocatedState(located, context);
  const target: TierKey | undefined = choice === 'personal' ? 'private' : choice === 'private' ? 'secure' : undefined;
  const applies = target !== undefined && after.record?.state === 'current'
    && after.record.contentTier === target && after.record.metadataTier === target ? 'now' : 'next_pass';
  const row = storedRowFor(identity, located, context);
  const item = view(row, after);
  // An agent never reads back names that are now Private.
  if (!input.allowLower && (namesAbovePersonal(before) || namesAbovePersonal(after))) {
    item.title = null;
    item.sender = null;
    item.location = null;
  }
  return { ok: true, item, changed, applies, results };
}

/** The item's stored names for the result; the identity alone when no store row is readable. */
function storedRowFor(identity: TierLedgerIdentity, located: readonly LocatedItem[], context: TierCliContext): StoredItemRow {
  for (const dbPath of knownStorePaths(context)) {
    const row = withStore<StoredItemRow | undefined>(dbPath, undefined, (db, columns) => (db.query(`
      SELECT ${selectColumns(columns)} FROM items
      WHERE tombstoned = 0 AND provider = ? AND account_scope = ? AND provider_item_id = ?
        AND COALESCE(provider_conversation_id, '') = ?
      LIMIT 1
    `).get(identity.provider, identity.accountScope, identity.providerItemId, identity.providerConversationId ?? '') as StoredItemRow | null) ?? undefined);
    if (row) return row;
  }
  return {
    provider: identity.provider,
    family: located[0]?.identity.family ?? 'unknown',
    account_scope: identity.accountScope,
    provider_item_id: identity.providerItemId,
    provider_conversation_id: identity.providerConversationId ?? null,
    title: null,
    sender_label: null,
    sender_id: null,
    locator_uri: null,
  };
}
