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
import { TierLedger, type TierLedgerIdentity } from './tier-ledger.ts';
import { tierLedgerPathForStore, tierSnifferPathForStore } from './tier-ledger-path.ts';
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
  'tier classifier': 'olympus tier classifier status | approve --why <reason> [--model <id>] [--prompt-version <version>]',
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
    default:
      throw new OperationError('invalid_params', `Unknown tier command: ${command ?? '(none)'}.`, 'Run olympus tier --help.');
  }
}

// --- Locators --------------------------------------------------------------------

interface LocatedItem {
  dbPath: string;
  identity: TierLedgerIdentity & { family: SourceFamily };
}

function knownStorePaths(context: TierCliContext): string[] {
  const paths = context.storePaths
    ?? lifecycleSourceSpecs().flatMap((spec) => spec.connectorStorePaths?.(context) ?? []);
  return [...new Set(paths)].filter((path) => path !== ':memory:' && existsSync(path));
}

export function locateTierItem(locator: string, context: TierCliContext = {}): LocatedItem[] {
  const needle = locator.trim();
  if (!needle) throw new OperationError('invalid_params', 'A locator is required.');
  const found: LocatedItem[] = [];
  for (const dbPath of knownStorePaths(context)) {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec('PRAGMA busy_timeout = 10000;');
      const rows = db.query(`
        SELECT provider, family, account_scope, provider_item_id FROM items
        WHERE tombstoned = 0 AND (LOWER(locator_uri) = LOWER(?) OR provider_item_id = ?)
        LIMIT 5
      `).all(needle, needle) as Array<{ provider: string; family: SourceFamily; account_scope: string; provider_item_id: string }>;
      for (const row of rows) {
        found.push({
          dbPath,
          identity: { provider: row.provider, family: row.family, accountScope: row.account_scope, providerItemId: row.provider_item_id },
        });
      }
    } catch {
      // A store without the items table (or unreadable) holds nothing to find.
    } finally {
      closeSqliteStore(db, { checkpoint: false });
    }
  }
  const identities = new Set(found.map((item) => identityKey(item.identity)));
  if (identities.size === 0) {
    throw new OperationError('invalid_params', 'No stored item matches that locator.', 'Use the locator an answer cited, or the provider item id.');
  }
  if (identities.size > 1) {
    throw new OperationError('invalid_params', `That locator matches ${identities.size} different items.`, 'Use the full locator URI an answer cited.');
  }
  return found;
}

function identityKey(identity: TierLedgerIdentity): string {
  return `${identity.provider}\u0000${identity.accountScope}\u0000${identity.providerItemId}`;
}

function withLedger<T>(dbPath: string, now: (() => Date) | undefined, run: (ledger: TierLedger) => T): T {
  const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(dbPath), ...(now ? { now } : {}) });
  try {
    return run(ledger);
  } finally {
    ledger.close();
  }
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
  const results = items.map((item) => withLedger(item.dbPath, context.now, (ledger) => {
    if (override === 'clear') {
      const cleared = ledger.clearOverride(item.identity);
      return { cleared, note: 'The next sync re-decides this item without the override.' };
    }
    ledger.setOverride(item.identity, override);
    if (override.kind === 'not_secret') {
      return { override: 'not_secret', note: 'The next sync sends this item back through normal classification.' };
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
    const recorded = withLedger(item.dbPath, context.now, (ledger) => ({
      record: ledger.getCurrent(item.identity),
      override: ledger.getOverride(item.identity),
      history: ledger.history(item.identity),
    }));
    const snifferPath = tierSnifferPathForStore(item.dbPath);
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
    if (!record) return { recorded: false, note: 'No decision is recorded for this item yet; the next sync records one.' };
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
    if (!existsSync(path)) return { path, rules: [], note: 'No tier rules file yet; add one with olympus tier rules add.' };
    const validation = validateTierRulesFile({ env });
    return { ...validation, rules: loadOwnerTierRules({ env }).map(describeRule) };
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
      approved: 'refused' in lane ? false : isClassifierApproved(ledger.entries, { modelId: lane.modelId, promptVersion: SNIFFER_PROMPT_VERSION }),
      ledger: ledgerPath,
      recent: ledger.entries.slice(0, 5),
      skippedLines: ledger.skipped,
    };
  }
  if (command === 'approve') {
    const options = parseFlags(rest, ['model', 'prompt-version', 'why']);
    const why = options.get('why')?.trim();
    if (!why) throw new OperationError('invalid_params', '--why is required: say what is approved and why.');
    const modelId = options.get('model')?.trim() || ('refused' in lane ? undefined : lane.modelId);
    if (!modelId) {
      throw new OperationError('invalid_params', 'No private sniffer lane is configured; pass --model explicitly or configure one first.');
    }
    const promptVersion = options.get('prompt-version')?.trim() || SNIFFER_PROMPT_VERSION;
    const entry = {
      recorded_at: (context.now?.() ?? new Date()).toISOString(),
      kind: 'classifier_model_decision' as const,
      what: `The owner approved classifier model ${modelId} with prompt ${promptVersion} for the privacy sniffer.`,
      model_id: modelId,
      prompt_version: promptVersion,
      ...('refused' in lane ? {} : { lane: lane.kind }),
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
