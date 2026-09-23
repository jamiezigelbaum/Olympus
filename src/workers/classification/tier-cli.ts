// `olympus tier ...` (design section 2.4): per-item overrides, explanations,
// owner tier rules, and the classifier approval.
//
//   olympus tier set <locator> public|personal|private|secrets|not-secret|clear
//   olympus tier explain <locator>
//   olympus tier rules list | add --id <id> --match <kind>=<value> --tier <tier> [--source <provider>] [--strength prior|force] | remove <id>
//   olympus tier classifier status | approve --why <reason> [--model <id>] [--prompt-version <v>]
//
// Tier words are the DISPLAY names (Public, Personal, Private, Secrets); the
// files store schema-v1 keys (tier-rules.ts, tierKeyFromDisplayName).
//
// A locator is the item's locator URI as answers cite it, or its provider item
// id. Every connector store the data lifecycle knows about is searched; an
// item held by two stores (a twin pair) gets the override in both ledgers.
// Output is content-free: tiers, reason codes, identities, never a title or text.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { lifecycleSourceSpecs, type LifecyclePathContext } from '../../data-lifecycle.ts';
import { defaultMailSourceScopeStatePath, readMailSourceScopeApproval } from '../../core/mail-source-scope.ts';
import { handleRegistryPathFromEnv, readConnectedHandleRegistry } from '../credential-broker/connected-handles.ts';
import { OperationError } from '../../core/operation-error.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import { loadSovereigntyEngine } from '../../core/sovereignty.ts';
import type { SourceFamily } from '../../core/source-index/types.ts';
import {
  CLASSIFICATION_LEDGER_OWNER_APPROVAL,
  appendClassificationLedgerEntry,
  isClassifierApproved,
  readClassificationLedger,
  resolveClassificationLedgerPath,
} from '../classification-ledger.ts';
import { SNIFFER_PROMPT_VERSION } from './sniffer.ts';
import { SnifferLaneRefusedError, resolveSnifferLane } from './sniffer-lane.ts';
import { TierSnifferStore } from './sniffer-store.ts';
import { classifyItemTiers, type ItemTierOverride, type OwnerTierRule } from './tier-classifier.ts';
import { TierLedger, tierLedgerIdentityKey, type TierLedgerIdentity } from './tier-ledger.ts';
import { tierLedgerPathForStore, tierSnifferPathForLedger } from './tier-ledger-path.ts';
import { TIER_SET_BINDING_CONNECTOR_ID, TIER_SET_BINDING_RUN_ID } from '../connector-store/local-index.ts';
import {
  OWNER_TIER_RULE_MATCH_KINDS,
  addOwnerTierRule,
  loadOwnerTierRules,
  parseOwnerTierRule,
  removeOwnerTierRule,
  resolveTierRulesPath,
  tierDisplayName,
  tierKeyFromDisplayName,
  validateTierRulesFile,
} from './tier-rules.ts';

export interface TierCliContext extends LifecyclePathContext {
  /** Override the stores searched (tests). */
  storePaths?: readonly string[];
  now?: () => Date;
}

export const TIER_CLI_USAGE: Readonly<Record<string, string>> = {
  'tier set': 'olympus tier set <locator> public|personal|private|secrets|not-secret|clear',
  'tier explain': 'olympus tier explain <locator>',
  'tier rules': 'olympus tier rules list | add --id <id> --match <kind>=<value> --tier <tier> [--source <provider>] [--strength prior|force] | remove <id>',
  'tier classifier': 'olympus tier classifier status | approve --why <reason>',
  'tier migrate': 'olympus tier migrate plan [--with-sniffer] [--top <n>] | approve --plan <id> [--why <reason>] | '
    + 'run --plan <id> [--batch source:<id>|folder:<path>|label:<key>|sender:<address>|chat:<key>] [--max-items <n>] | '
    + 'rollback --batch <id> | purge [--plan <id>] [--approve --expect <digest> --why <reason>] | status',
};

export async function runTierCommand(args: readonly string[], context: TierCliContext = {}): Promise<Record<string, unknown>> {
  const [command, ...rest] = args;
  switch (command) {
    case 'set':
      return runTierSet(rest, context);
    case 'explain':
      return runTierExplain(rest, context);
    case 'rules':
      return runTierRules(rest, context);
    case 'classifier':
      return runTierClassifier(rest, context);
    case 'migrate': {
      // The migration's tooling (tier-migration-cli.ts), loaded only when used.
      const { runTierMigrateCommand } = await import('./tier-migration-cli.ts');
      return runTierMigrateCommand(rest);
    }
    default:
      throw new OperationError('invalid_params', `Unknown tier command: ${command ?? '(none)'}.`, 'Run olympus tier --help.');
  }
}

// --- Locators --------------------------------------------------------------------

interface LocatedItem {
  /** The tier ledger that holds (or will hold) this item's decision. */
  ledgerPath: string;
  identity: TierLedgerIdentity & { family: SourceFamily };
}

function knownStorePaths(context: TierCliContext): string[] {
  const paths = context.storePaths
    ?? lifecycleSourceSpecs().flatMap((spec) => spec.connectorStorePaths?.(context) ?? []);
  return [...new Set(paths)].filter((path) => path !== ':memory:' && existsSync(path));
}

interface StoreMatch {
  identity: TierLedgerIdentity & { family: SourceFamily };
  /** The set ledger this store is bound to, when a tiered store set routed into it. */
  boundLedgerPath?: string;
  ownLedgerPath: string;
}

function matchStore(dbPath: string, needle: string): StoreMatch[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000;');
    const rows = db.query(`
      SELECT provider, family, account_scope, provider_item_id, provider_conversation_id FROM items
      WHERE tombstoned = 0 AND (LOWER(locator_uri) = LOWER(?) OR provider_item_id = ?)
      LIMIT 5
    `).all(needle, needle) as Array<{
      provider: string;
      family: SourceFamily;
      account_scope: string;
      provider_item_id: string;
      provider_conversation_id: string | null;
    }>;
    if (rows.length === 0) return [];
    let boundLedgerPath: string | undefined;
    try {
      const binding = db.query('SELECT cursor FROM sync_runs WHERE sync_run_id = ? AND connector_id = ?')
        .get(TIER_SET_BINDING_RUN_ID, TIER_SET_BINDING_CONNECTOR_ID) as { cursor: string | null } | null;
      const parsed = binding?.cursor ? JSON.parse(binding.cursor) as { ledgerPath?: unknown } : undefined;
      if (typeof parsed?.ledgerPath === 'string') boundLedgerPath = parsed.ledgerPath;
    } catch {
      // No readable binding: the store's own ledger is the candidate.
    }
    return rows.map((row) => ({
      identity: {
        provider: row.provider,
        family: row.family,
        accountScope: row.account_scope,
        providerItemId: row.provider_item_id,
        ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
      },
      ...(boundLedgerPath ? { boundLedgerPath } : {}),
      ownLedgerPath: tierLedgerPathForStore(dbPath),
    }));
  } catch {
    // A store without the items table (or unreadable) holds nothing to find.
    return [];
  } finally {
    closeSqliteStore(db, { checkpoint: false });
  }
}

/**
 * Find the item and the ledger(s) that decide it. The identity includes the
 * conversation (chat items). A tiered store set keeps ONE ledger for all its
 * stores, beside its secure_local store, so the item's decision may live in a
 * ledger other than its own store's: every existing ledger behind the known
 * stores is checked for a row, and the store's bound (else own) ledger is used
 * when none has one yet.
 */
export function locateTierItem(locator: string, context: TierCliContext = {}): LocatedItem[] {
  const needle = locator.trim();
  if (!needle) throw new OperationError('invalid_params', 'A locator is required.');
  const stores = knownStorePaths(context);
  const matches = stores.flatMap((dbPath) => matchStore(dbPath, needle));
  const identities = new Map(matches.map((match) => [identityKey(match.identity), match.identity]));
  if (identities.size === 0) {
    throw new OperationError('invalid_params', 'No stored item matches that locator.', 'Use the locator an answer cited, or the provider item id.');
  }
  if (identities.size > 1) {
    throw new OperationError('invalid_params', `That locator matches ${identities.size} different items.`, 'Use the full locator URI an answer cited.');
  }
  const identity = [...identities.values()][0]!;
  const ledgerPaths = new Set<string>();
  for (const dbPath of stores) {
    const path = tierLedgerPathForStore(dbPath);
    if (existsSync(path)) ledgerPaths.add(path);
  }
  for (const match of matches) if (match.boundLedgerPath && existsSync(match.boundLedgerPath)) ledgerPaths.add(match.boundLedgerPath);
  const deciding = [...ledgerPaths].filter((path) => withLedgerAt(path, undefined, (ledger) => ledger.getCurrent(identity) !== undefined));
  if (deciding.length > 0) return deciding.map((ledgerPath) => ({ ledgerPath, identity }));
  const fallback = matches[0]!;
  return [{ ledgerPath: fallback.boundLedgerPath ?? fallback.ownLedgerPath, identity }];
}

function identityKey(identity: TierLedgerIdentity): string {
  return tierLedgerIdentityKey(identity);
}

function withLedgerAt<T>(ledgerPath: string, now: (() => Date) | undefined, run: (ledger: TierLedger) => T): T {
  const ledger = new TierLedger({ dbPath: ledgerPath, ...(now ? { now } : {}) });
  try {
    return run(ledger);
  } finally {
    ledger.close();
  }
}

/**
 * An override recorded before the ledger keyed items by conversation (schema
 * 1) sits under the conversation-less identity. For a chat item it no longer
 * applies; `tier explain` shows it so the owner can set it again.
 */
function orphanedOverride(ledger: TierLedger, identity: TierLedgerIdentity): ItemTierOverride | undefined {
  if (!identity.providerConversationId) return undefined;
  const { providerConversationId: _conversation, ...withoutConversation } = identity;
  return ledger.getOverride(withoutConversation);
}

// --- set / explain -----------------------------------------------------------------

export function runTierSet(args: readonly string[], context: TierCliContext = {}): Record<string, unknown> {
  const [locator, word] = args;
  if (!locator || !word || args.length > 2) {
    throw new OperationError('invalid_params', `Usage: ${TIER_CLI_USAGE['tier set']}`);
  }
  const normalized = word.trim().toLowerCase();
  let override: ItemTierOverride | 'clear';
  if (normalized === 'clear') override = 'clear';
  else if (normalized === 'not-secret' || normalized === 'not_secret') override = { kind: 'not_secret' };
  else {
    const tier = tierKeyFromDisplayName(normalized);
    if (!tier) {
      throw new OperationError('invalid_params', `Unknown tier "${word}".`, 'Use public, personal, private, secrets, not-secret or clear.');
    }
    override = { kind: 'tier', tier };
  }
  const items = locateTierItem(locator, context);
  const results = items.map((item) => withLedgerAt(item.ledgerPath, context.now, (ledger) => {
    if (override === 'clear') {
      const cleared = ledger.clearOverride(item.identity);
      return { cleared, note: 'The next sync re-decides this item without the override.' };
    }
    ledger.setOverride(item.identity, override);
    if (override.kind === 'not_secret') {
      return { override: 'not_secret', note: 'The next sync sends this item back through normal classification.' };
    }
    if (ledger.getCurrent(item.identity)?.routed) {
      // A routed item's placement belongs to its tiered store set: the next
      // sync applies the override and queues the move (hidden first on a raise).
      return { override: tierDisplayName(override.tier), outcome: 'set_applies_next_sync' };
    }
    // A tier override is final for both layers: record it now, so the ledger
    // (and a retrieval that reads it) reflects the owner's decision at once.
    const decision = classifyItemTiers({ signals: {} }, { override });
    const { outcome, record } = ledger.recordDecision(item.identity, decision);
    return {
      override: tierDisplayName(override.tier),
      outcome,
      metadataTier: tierDisplayName(record.metadataTier),
      contentTier: tierDisplayName(record.contentTier),
      generation: record.generation,
    };
  }));
  return {
    locator,
    item: publicIdentity(items[0]!.identity),
    stores: items.length,
    results,
  };
}

export function runTierExplain(args: readonly string[], context: TierCliContext = {}): Record<string, unknown> {
  const [locator] = args;
  if (!locator || args.length > 1) throw new OperationError('invalid_params', `Usage: ${TIER_CLI_USAGE['tier explain']}`);
  const items = locateTierItem(locator, context);
  const records = items.map((item) => {
    const recorded = withLedgerAt(item.ledgerPath, context.now, (ledger) => ({
      record: ledger.getCurrent(item.identity),
      override: ledger.getOverride(item.identity),
      orphaned: orphanedOverride(ledger, item.identity),
      history: ledger.history(item.identity),
      copies: ledger.copies(item.identity),
    }));
    const snifferPath = tierSnifferPathForLedger(item.ledgerPath);
    let waitingOn: string[] = [];
    if (existsSync(snifferPath)) {
      const sniffer = new TierSnifferStore({ dbPath: snifferPath });
      try {
        waitingOn = (['metadata', 'content'] as const).filter((pass) => sniffer.questionFor(item.identity, pass) !== undefined);
      } finally {
        sniffer.close();
      }
    }
    const { record } = recorded;
    const orphanedNote = recorded.orphaned
      ? {
          orphanedOverride: recorded.orphaned.kind === 'tier' ? tierDisplayName(recorded.orphaned.tier) : 'not_secret',
          orphanedOverrideNote: 'Set before the ledger keyed chat items by conversation; it no longer applies. Set it again with olympus tier set.',
        }
      : {};
    if (!record) return { recorded: false, ...orphanedNote, note: 'No decision is recorded for this item yet; the next sync records one.' };
    return {
      recorded: true,
      metadataTier: tierDisplayName(record.metadataTier),
      contentTier: tierDisplayName(record.contentTier),
      state: record.state,
      decidedBy: record.decidedBy,
      reasons: record.reasons,
      generation: record.generation,
      previousTiers: record.previousContentTier
        ? { metadata: tierDisplayName(record.previousMetadataTier ?? record.previousContentTier), content: tierDisplayName(record.previousContentTier) }
        : null,
      override: recorded.override
        ? recorded.override.kind === 'tier' ? tierDisplayName(recorded.override.tier) : 'not_secret'
        : null,
      classifierVersion: record.engineVersion,
      mapRevision: record.mapRevision,
      snifferModel: record.modelId,
      waitingOnSniffer: waitingOn,
      routed: record.routed,
      copies: recorded.copies.map((copy) => ({ corpusId: copy.corpusId, layers: copy.layers, state: copy.state, embedHold: copy.embedHold })),
      ...orphanedNote,
      decidedAt: record.decidedAt,
      history: recorded.history.map((entry) => ({
        generation: entry.generation,
        metadataTier: tierDisplayName(entry.metadataTier),
        contentTier: tierDisplayName(entry.contentTier),
        decidedBy: entry.decidedBy,
        state: entry.state,
        decidedAt: entry.decidedAt,
      })),
    };
  });
  return { locator, item: publicIdentity(items[0]!.identity), stores: records };
}

function publicIdentity(identity: TierLedgerIdentity & { family: SourceFamily }): Record<string, string> {
  return {
    provider: identity.provider,
    family: identity.family,
    accountScope: identity.accountScope,
    providerItemId: identity.providerItemId,
  };
}

// --- rules --------------------------------------------------------------------------

export function runTierRules(args: readonly string[], context: TierCliContext = {}): Record<string, unknown> {
  const env = context.env ?? process.env;
  const [command, ...rest] = args;
  if (command === 'list') {
    const path = resolveTierRulesPath({ env });
    const mailScopeRules = mailScopeTierRules(env);
    if (!existsSync(path)) {
      return { path, rules: [], mailScopeRules, note: 'No tier rules file yet; add one with olympus tier rules add.' };
    }
    const validation = validateTierRulesFile({ env });
    return { ...validation, rules: loadOwnerTierRules({ env }).map(describeRule), mailScopeRules };
  }
  if (command === 'add') {
    const options = parseFlags(rest, ['id', 'match', 'tier', 'source', 'strength']);
    const matchText = options.get('match');
    const separator = matchText?.indexOf('=') ?? -1;
    if (!matchText || separator <= 0) {
      throw new OperationError('invalid_params', `--match must be <kind>=<value>, with kind one of ${OWNER_TIER_RULE_MATCH_KINDS.join(', ')}.`);
    }
    const tierWord = options.get('tier') ?? '';
    const tier = tierKeyFromDisplayName(tierWord);
    if (!tier) throw new OperationError('invalid_params', '--tier must be public, personal, private or secrets.');
    const rule = parseOwnerTierRule({
      id: options.get('id'),
      ...(options.get('source') ? { source: options.get('source') } : {}),
      match: { [matchText.slice(0, separator)]: matchText.slice(separator + 1) },
      tier,
      strength: options.get('strength') ?? 'prior',
    }, 'tier rule');
    const { path, rules } = addOwnerTierRule(rule, { env });
    return { path, added: describeRule(rule), rules: rules.length };
  }
  if (command === 'remove') {
    const [id, ...extra] = rest;
    if (!id || extra.length > 0) throw new OperationError('invalid_params', 'Usage: olympus tier rules remove <id>');
    const { path, removed, rules } = removeOwnerTierRule(id, { env });
    if (!removed) throw new OperationError('invalid_params', `No tier rule has id "${id}".`);
    return { path, removed: id, rules: rules.length };
  }
  throw new OperationError('invalid_params', `Usage: ${TIER_CLI_USAGE['tier rules']}`);
}

/**
 * The mail scope picker's always-Private senders, as the owner tier rules the
 * mail lane applies (core/mail-source-scope.ts). Read-only here: they are
 * changed in the picker, not in the rules file.
 */
function mailScopeTierRules(env: Record<string, string | undefined>): Array<Record<string, unknown>> {
  try {
    const registryPath = handleRegistryPathFromEnv(env, true);
    if (!registryPath) return [];
    const approval = readMailSourceScopeApproval({
      registry: readConnectedHandleRegistry(registryPath),
      statePath: defaultMailSourceScopeStatePath(registryPath),
    });
    if (approval.status !== 'approved') return [];
    return (approval.ownerTierRules ?? []).map((rule) => ({
      ...describeRule(rule),
      origin: 'mail_scope_picker',
      readOnly: true,
    }));
  } catch {
    return [];
  }
}

function describeRule(rule: OwnerTierRule): Record<string, unknown> {
  return {
    id: rule.id,
    ...(rule.source ? { source: rule.source } : {}),
    match: { [rule.match.kind]: rule.match.value },
    tier: tierDisplayName(rule.tier),
    strength: rule.strength,
  };
}

// --- classifier approval -------------------------------------------------------------

export async function runTierClassifier(args: readonly string[], context: TierCliContext = {}): Promise<Record<string, unknown>> {
  const env = context.env ?? process.env;
  const [command, ...rest] = args;
  const ledgerPath = resolveClassificationLedgerPath(env);
  const lane = (() => {
    try {
      return resolveSnifferLane(loadSovereigntyEngine({ env }));
    } catch (error) {
      if (error instanceof SnifferLaneRefusedError) return { refused: error.reason };
      throw error;
    }
  })();
  const laneSummary = 'refused' in lane
    ? { lane: null, refused: lane.refused }
    : { lane: lane.kind, profile: lane.profileId, modelId: lane.modelId };
  if (command === 'status') {
    const ledger = await readClassificationLedger(ledgerPath);
    return {
      ...laneSummary,
      promptVersion: SNIFFER_PROMPT_VERSION,
      approved: 'refused' in lane
        ? false
        : isClassifierApproved(ledger.entries, { lane: lane.kind, profileId: lane.profileId, modelId: lane.modelId, promptVersion: SNIFFER_PROMPT_VERSION }),
      ledger: ledgerPath,
      recent: ledger.entries.slice(0, 5),
      skippedLines: ledger.skipped,
    };
  }
  if (command === 'approve') {
    const options = parseFlags(rest, ['why']);
    const why = options.get('why')?.trim();
    if (!why) throw new OperationError('invalid_params', '--why is required: say what is approved and why.');
    if ('refused' in lane) {
      throw new OperationError('invalid_params', `No private sniffer lane is configured (${lane.refused}); there is nothing to approve.`);
    }
    // The approval names exactly what the worker would use: the resolved
    // lane, profile and model, and the prompt version derived from the
    // prompt text. Any change to one of them needs a new approval.
    const modelId = lane.modelId;
    const promptVersion = SNIFFER_PROMPT_VERSION;
    const entry = {
      recorded_at: (context.now?.() ?? new Date()).toISOString(),
      kind: 'classifier_model_decision' as const,
      what: `The owner approved ${lane.kind} classifier model ${modelId} (profile ${lane.profileId}) with prompt ${promptVersion} for the privacy sniffer.`,
      model_id: modelId,
      prompt_version: promptVersion,
      lane: lane.kind,
      profile_id: lane.profileId,
      why,
      approved_by: CLASSIFICATION_LEDGER_OWNER_APPROVAL,
      status: 'complete' as const,
    };
    await appendClassificationLedgerEntry(ledgerPath, entry);
    return { ledger: ledgerPath, recorded: entry };
  }
  throw new OperationError('invalid_params', `Usage: ${TIER_CLI_USAGE['tier classifier']}`);
}

function parseFlags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new OperationError('invalid_params', `Unexpected argument: ${arg}`);
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    if (!allowed.includes(key)) throw new OperationError('invalid_params', `Unknown option: --${key}`);
    const value = equals === -1 ? args[(index += 1)] : arg.slice(equals + 1);
    if (value === undefined) throw new OperationError('invalid_params', `--${key} needs a value.`);
    values.set(key, value);
  }
  return values;
}
