// `olympus tier migrate ...` (design docs/design/per-item-four-tier-classification.md,
// section 4.6): the owner's tooling for moving an EXISTING install's stored
// items to their per-item tiers. It never runs on its own; every step is a
// command the owner types.
//
//   olympus tier migrate plan [--with-sniffer] [--top <n>]
//   olympus tier migrate approve --plan <id> [--why <reason>]
//   olympus tier migrate run --plan <id> [--batch <selector>] [--max-items <n>]
//   olympus tier migrate rollback --batch <id>
//   olympus tier migrate purge [--plan <id>] [--approve --why <reason>]
//   olympus tier migrate status
//
// Output is JSON. The plan's top patterns name the owner's own folders,
// labels and senders (they are what the owner reviews in M1); everything
// else is counts, tiers, identities of plans and batches, and ledger ids.

import { loadConfig } from '../../core/config.ts';
import { OperationError } from '../../core/operation-error.ts';
import { loadSensitivityMap, sensitivityMapRevision } from '../../core/sensitivity-map.ts';
import { loadSovereigntyEngine } from '../../core/sovereignty.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import type { TierMoveEmbeddingIdentity } from '../connector-store/tier-move.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { canonicalEmbeddingIdentityForModel } from '../source-index/embedding-identity.ts';
import {
  approveTierMigration,
  planTierMigration,
  purgeTierMigration,
  readTierMigrationState,
  resolveTierMigrationPaths,
  rollbackTierMigrationBatch,
  runTierMigration,
  tierMigrationPlanFreshness,
  tierMigrationStatusSummary,
  type TierMigrationDomainIdentity,
  type TierMigrationInputs,
  type TierMigrationPaths,
  type TierMigrationPriceTable,
} from './tier-migration.ts';
import {
  installedTierMigrationLaneSpecs,
  openTierMigrationLanes,
  type OpenedTierMigrationLanes,
  type TierMigrationLaneMode,
  type TierMigrationLaneSpec,
} from './tier-migration-lanes.ts';

export const TIER_MIGRATE_USAGE = 'olympus tier migrate plan [--with-sniffer] [--top <n>] | approve --plan <id> [--why <reason>] | '
  + 'run --plan <id> [--batch source:<id>|folder:<path>|label:<key>|sender:<address>|chat:<key>] [--max-items <n>] | '
  + 'rollback --batch <id> | purge [--plan <id>] [--approve --why <reason>] | status';

/** Seams for tests and for a host that wires the installed inputs differently. */
export interface TierMigrateCliContext {
  env?: Record<string, string | undefined>;
  laneSpecs?: readonly TierMigrationLaneSpec[];
  inputs?: TierMigrationInputs;
  domainIdentity?: TierMigrationDomainIdentity;
  prices?: TierMigrationPriceTable;
  paths?: TierMigrationPaths;
  now?: () => Date;
  itemDelayMs?: number;
}

export async function runTierMigrateCommand(
  args: readonly string[],
  context: TierMigrateCliContext = {},
): Promise<Record<string, unknown>> {
  const [command, ...rest] = args;
  const flags = parseFlags(rest);
  const env = context.env ?? process.env;
  const paths = context.paths ?? resolveTierMigrationPaths(env, resolveEmbeddingLedgerPath(env));
  switch (command) {
    case 'plan': {
      const withSniffer = flags.boolean('with-sniffer');
      const top = flags.number('top');
      flags.assertDone('plan');
      const inputs = context.inputs ?? installedInputs(env, { withSniffer });
      return withLanes(context, env, 'read', inputs, async (opened) => {
        const result = await planTierMigration({
          lanes: opened.lanes,
          inputs,
          domainIdentity: context.domainIdentity ?? installedDomainIdentity(env),
          paths,
          ...(context.prices ?? installedPrices(env) ? { prices: context.prices ?? installedPrices(env)! } : {}),
          ...(context.now ? { now: context.now } : {}),
          ...(top !== undefined ? { topPatterns: top } : {}),
        });
        return {
          kind: 'olympus_tier_migration_plan',
          plan_id: result.planId,
          state: result.state,
          reused: result.reused,
          counts_sha256: result.countsSha256,
          totals: result.totals,
          top_patterns: result.topPatterns,
          report_path: result.reportPath,
          ledger_note_entry_id: result.noteEntryId,
          superseded_plans: result.supersededPlans,
          estimates_note: 'Costs and times are estimates from sourceIndex.embeddingPriceEstimates or unverified defaults.',
          next: `olympus tier migrate approve --plan ${result.planId}`,
        };
      });
    }
    case 'approve': {
      const planId = flags.required('plan');
      const why = flags.string('why');
      flags.assertDone('approve');
      const inputs = context.inputs ?? installedInputs(env, { withSniffer: planUsedSniffer(paths, planId) });
      return withLanes(context, env, 'read', inputs, async (opened) => {
        const plan = await approveTierMigration({
          planId,
          lanes: opened.lanes,
          inputs,
          paths,
          ...(why ? { why } : {}),
          ...(context.now ? { now: context.now } : {}),
        });
        return {
          kind: 'olympus_tier_migration_approval',
          plan_id: plan.planId,
          state: plan.state,
          approval_entry_id: plan.approval?.entryId,
          counts_sha256: plan.countsSha256,
          next: `olympus tier migrate run --plan ${plan.planId} [--batch <selector>]`,
        };
      });
    }
    case 'run': {
      const planId = flags.required('plan');
      const selector = flags.string('batch');
      const maxItems = flags.number('max-items');
      flags.assertDone('run');
      const inputs = context.inputs ?? installedInputs(env, { withSniffer: planUsedSniffer(paths, planId) });
      return withLanes(context, env, 'write', inputs, async (opened) => {
        const result = await runTierMigration({
          planId,
          lanes: opened.lanes,
          inputs,
          domainIdentity: context.domainIdentity ?? installedDomainIdentity(env),
          paths,
          ...(context.prices ?? installedPrices(env) ? { prices: context.prices ?? installedPrices(env)! } : {}),
          ...(selector ? { selector } : {}),
          ...(maxItems !== undefined ? { maxItems } : {}),
          itemDelayMs: context.itemDelayMs ?? 2,
          ...(context.now ? { now: context.now } : {}),
        });
        return { kind: 'olympus_tier_migration_run', ...snake(result) };
      });
    }
    case 'rollback': {
      const batchId = flags.required('batch');
      flags.assertDone('rollback');
      const inputs = context.inputs ?? installedInputs(env, { withSniffer: false });
      return withLanes(context, env, 'write', inputs, async (opened) => ({
        kind: 'olympus_tier_migration_rollback',
        ...snake(await rollbackTierMigrationBatch({
          batchId,
          lanes: opened.lanes,
          paths,
          ...(context.now ? { now: context.now } : {}),
        })),
      }));
    }
    case 'purge': {
      const planId = flags.string('plan');
      const approve = flags.boolean('approve');
      const why = flags.string('why');
      flags.assertDone('purge');
      if (approve && !why?.trim()) {
        throw new OperationError('invalid_params', 'A purge deletes kept vectors: --approve needs --why <reason>.');
      }
      const inputs = context.inputs ?? installedInputs(env, { withSniffer: false });
      return withLanes(context, env, approve ? 'write' : 'read', inputs, async (opened) => ({
        kind: 'olympus_tier_migration_purge',
        ...snake(await purgeTierMigration({
          ...(planId ? { planId } : {}),
          approve,
          ...(why ? { why } : {}),
          lanes: opened.lanes,
          paths,
          ...(context.now ? { now: context.now } : {}),
        })),
        ...(approve ? {} : { note: 'Dry run: nothing was deleted. Add --approve --why <reason> to purge.' }),
      }));
    }
    case 'status': {
      flags.assertDone('status');
      const summary = tierMigrationStatusSummary(paths.statePath);
      const state = readTierMigrationState(paths.statePath);
      const latest = state.plans[state.plans.length - 1];
      let freshness: Record<string, unknown> | undefined;
      if (latest && (latest.state === 'planned' || latest.state === 'approved' || latest.state === 'stopped')) {
        const inputs = context.inputs ?? installedInputs(env, { withSniffer: latest.withSniffer });
        freshness = await withLanes(context, env, 'read', inputs, async (opened) => {
          const result = tierMigrationPlanFreshness(latest, opened.lanes, inputs);
          return { fresh: result.fresh, inputs_changed: result.inputsChanged, changed_items: result.changedItems };
        });
      }
      return {
        kind: 'olympus_tier_migration_status',
        ...(summary ? { migration: summary } : { migration: null }),
        ...(freshness ? { freshness } : {}),
        plans: state.plans.map((plan) => ({ plan_id: plan.planId, state: plan.state, created_at: plan.createdAt })),
      };
    }
    default:
      throw new OperationError('invalid_params', `Unknown tier migrate command: ${command ?? '(none)'}.`, `Usage: ${TIER_MIGRATE_USAGE}`);
  }
}

async function withLanes<T>(
  context: TierMigrateCliContext,
  env: Record<string, string | undefined>,
  mode: TierMigrationLaneMode,
  inputs: TierMigrationInputs,
  run: (opened: OpenedTierMigrationLanes) => Promise<T>,
): Promise<T> {
  const opened = openTierMigrationLanes(context.laneSpecs ?? installedTierMigrationLaneSpecs(env), {
    mode,
    ...(inputs.sensitivityMap || inputs.rules
      ? {
          tierClassification: {
            ...(inputs.sensitivityMap ? { sensitivityMap: inputs.sensitivityMap } : {}),
            ...(inputs.rules ? { rules: inputs.rules } : {}),
          },
        }
      : {}),
  });
  try {
    return await run(opened);
  } finally {
    opened.close();
  }
}

/**
 * The owner's installed classification inputs: the sensitivity map (loaded
 * strictly: an invalid map refuses rather than planning without it). Owner
 * tier rules and the privacy-safe sniffer arrive with the P2 tooling
 * (tier-rules.json, the approved sniffer); until they are installed here a
 * plan runs on the map and per-item overrides, and `--with-sniffer` refuses.
 */
function installedInputs(env: Record<string, string | undefined>, options: { withSniffer: boolean }): TierMigrationInputs {
  if (options.withSniffer) {
    throw new OperationError(
      'invalid_request',
      'The privacy-safe sniffer is not installed in this build, so --with-sniffer cannot run.',
      'Plan without --with-sniffer: items whose names look private stay Private (pending) and are left where they are.',
    );
  }
  const sensitivityMap = loadSensitivityMap({ env, allowMissing: true });
  return {
    ...(sensitivityMap ? { sensitivityMap } : {}),
    revision: `map:${sensitivityMapRevision(sensitivityMap)};rules:none`,
  };
}

function planUsedSniffer(paths: TierMigrationPaths, planId: string): boolean {
  return readTierMigrationState(paths.statePath).plans.find((plan) => plan.planId === planId)?.withSniffer === true;
}

function installedPrices(env: Record<string, string | undefined>): TierMigrationPriceTable | undefined {
  try {
    return loadConfig(env).sourceIndex.embeddingPriceEstimates;
  } catch {
    return undefined;
  }
}

/** Each trust domain's embedding identity under the install's sovereignty policy. */
function installedDomainIdentity(env: Record<string, string | undefined>): TierMigrationDomainIdentity {
  const engine = loadSovereigntyEngine({ env });
  const cache = new Map<SourceTrustDomain, TierMoveEmbeddingIdentity | undefined>();
  return (domain) => {
    if (cache.has(domain)) return cache.get(domain);
    const model = engine.resolveEmbeddingProfile(domain)?.profile.model;
    const canonical = model ? canonicalEmbeddingIdentityForModel(model) : undefined;
    const identity = canonical
      ? {
          modelId: canonical.modelId,
          provider: canonical.provider,
          backend: canonical.backend,
          dimension: canonical.dimension,
          epochId: canonical.epochId,
          configHash: '',
        }
      : undefined;
    cache.set(domain, identity);
    return identity;
  };
}

function snake(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`), entry]));
}

interface ParsedFlags {
  string(name: string): string | undefined;
  required(name: string): string;
  number(name: string): number | undefined;
  boolean(name: string): boolean;
  assertDone(command: string): void;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      throw new OperationError('invalid_params', `Unexpected argument "${arg}".`, `Usage: ${TIER_MIGRATE_USAGE}`);
    }
    const name = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, true);
    }
  }
  const used = new Set<string>();
  return {
    string(name) {
      used.add(name);
      const value = values.get(name);
      if (value === true) throw new OperationError('invalid_params', `--${name} needs a value.`);
      return value;
    },
    required(name) {
      const value = this.string(name);
      if (!value?.trim()) throw new OperationError('invalid_params', `--${name} is required.`, `Usage: ${TIER_MIGRATE_USAGE}`);
      return value.trim();
    },
    number(name) {
      const value = this.string(name);
      if (value === undefined) return undefined;
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new OperationError('invalid_params', `--${name} must be a positive integer.`);
      return parsed;
    },
    boolean(name) {
      used.add(name);
      const value = values.get(name);
      if (value !== undefined && value !== true) throw new OperationError('invalid_params', `--${name} takes no value.`);
      return value === true;
    },
    assertDone(command) {
      const unknown = [...values.keys()].filter((name) => !used.has(name));
      if (unknown.length > 0) {
        throw new OperationError('invalid_params', `Unknown option for tier migrate ${command}: --${unknown[0]}.`, `Usage: ${TIER_MIGRATE_USAGE}`);
      }
    },
  };
}
