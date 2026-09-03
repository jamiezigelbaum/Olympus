import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { loadConfig } from './core/config.ts';
import type { OlympusConfig } from './core/config.ts';
import {
  deleteAllConfirmationPrompts,
  deleteOlympusDataWithCustody,
  exportOlympusData,
  validateDeleteAllConfirmations,
  verifyOlympusDataExport,
} from './data-lifecycle.ts';
import { createDelphiTransport, DelphiClient } from './core/delphi.ts';
import { createEmailTransport, EmailClient } from './core/email.ts';
import { exposedOperations, shouldExposeOperation } from './core/operation-exposure.ts';
import { findOperationByCliName, operations, operationDescription, operationToolSchema, OperationError } from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { VERSION } from './version.ts';
import type { WorkerServicePlatform, WorkerServiceState } from './core/worker-service.ts';
import {
  runWorkerLifecycle,
  type LifecycleRecoverySignal,
  type WorkerLifecycleAction,
} from './core/lifecycle.ts';
import { V0_4_PUBLIC_SOURCE_CAPABILITIES } from './core/public-source-capabilities.ts';
import {
  connectPublicApiKeySource,
  connectOAuthSourceDetached,
  connectGuidedSession,
  connectOAuthSource,
  listDetachedOAuthStates,
  runDetachedOAuthChildFromRequestFile,
  readApiKeyFromStdin,
  type ConnectSource,
} from './core/connect.ts';
import {
  CalendarAgendaError,
  formatCalendarAgenda,
  parseCalendarAgendaArgs,
  runCalendarAgenda,
} from './core/calendar-agenda.ts';
import { createEnvCredentialBroker } from './workers/credential-broker/index.ts';
import {
  handleRegistryPathFromEnv,
  readConnectedHandleRegistry,
  withConnectedHandleGrantCustody,
} from './workers/credential-broker/connected-handles.ts';
import { createDefaultSecretStore } from './core/secret-store.ts';
import {
  SOVEREIGNTY_PRESETS,
  defaultSovereigntyConfigPath,
  loadSovereigntyPreset,
  writeSovereigntyConfigFile,
  type SovereigntyPresetName,
} from './core/sovereignty.ts';
import { validateSensitivityMapFile } from './core/sensitivity-map.ts';
import {
  runSetupWizard,
  type SetupCloudLane,
} from './core/setup.ts';
import {
  applyWorkerSetupEnv,
  dashboardQueryTokenFromWorkerAuthToken,
  withWorkerAuthHeader,
  normalizeWorkerAuthToken,
  workerAuthTokenFromConfig,
  workerAuthTokenFromSetupEnv,
} from './core/worker-auth.ts';
import {
  collectLocalSourceIngestionLedger,
  formatSourceIngestionLedger,
} from './workers/source-ingestion-ledger.ts';
import {
  LocalXBookmarksReconcileStateStore,
  defaultXBookmarksReconcileStateDbPath,
} from './workers/x-bookmarks/reconcile-state.ts';
import {
  LocalSourceSchedulerStateStore,
  SourceSchedulerUnparkRefusal,
  type SourceSchedulerUnparkCancellationReceipt,
  type SourceSchedulerUnparkReceipt,
} from './workers/source-scheduler-state.ts';
import {
  GoogleDailyRequestBudget,
  GoogleRequestBudgetError,
  GoogleRequestBudgetRecoveryRefusal,
  type GoogleRequestBudgetFutureDayRecoveryReceipt,
} from './workers/google-connectors/request-budget.ts';
import { defaultGmailRequestBudgetStatePath } from './workers/google-connectors/gmail.ts';
import { defaultGoogleDriveRequestBudgetStatePath } from './workers/google-connectors/drive.ts';
import {
  V0_4_PUBLIC_CLI_COMMANDS,
  V0_4_PUBLIC_CLI_GLOBALS,
  V0_4_PACKAGE_INTERNAL_CLI_HELPERS,
  V0_4_PUBLIC_CONNECT_SOURCES,
} from './core/public-surface.ts';
import { PUBLIC_RUNTIME_BUILD } from './core/build-flavor.ts';

const PUBLIC_CLI_COMMAND_NAMES = new Set<string>(V0_4_PUBLIC_CLI_COMMANDS);
const PUBLIC_CLI_HELP_GROUPS = new Set([
  'argus',
  'source',
  'source index',
  'sovereignty',
  'sensitivity',
  'worker',
  'connect',
  'data',
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!isV04PublicCliInvocation(args)) {
    console.error(`Unknown command: ${args.filter((arg) => !isHelpFlag(arg)).join(' ')}`);
    console.error('Run olympus --help for available commands.');
    process.exit(1);
  }

  if (args.length === 0 || (args.length === 1 && (args[0] === '--help' || args[0] === '-h'))) {
    printHelp();
    return;
  }

  if (args.length === 1 && (args[0] === '--version' || args[0] === 'version')) {
    console.log(`olympus ${VERSION}`);
    return;
  }

  if (args.length === 1 && args[0] === '--tools-json') {
    console.log(JSON.stringify(toToolsJson(loadConfig()), null, 2));
    return;
  }

  if (isHelpRequest(args)) {
    const commandArgs = args.filter((arg) => !isHelpFlag(arg));
    if (printPublicLeafCommandHelp(commandArgs) || printCommandGroupHelp(commandArgs)) return;
  }

  if (args[0] === 'serve') {
    const { serve } = await import('./mcp/server.ts');
    await serve();
    return;
  }

  if (args[0] === 'sovereignty' && args[1] === 'init') {
    try {
      const result = runSovereigntyInit(args.slice(2));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (args[0] === 'sensitivity' && args[1] === 'validate') {
    try {
      console.log(JSON.stringify(validateSensitivityMapFile(parseSensitivityValidateArgs(args.slice(2))), null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (args[0] === 'setup') {
    try {
      const result = await runSetupWizard(parseSetupArgs(args.slice(1)));
      console.log(JSON.stringify(result, null, 2));
      if (result.unmet_prerequisites.length > 0) {
        console.error('Unmet preset prerequisites:');
        for (const item of result.unmet_prerequisites) {
          console.error(`- ${item.label}: ${item.remedy}`);
        }
      }
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (args[0] === 'worker') {
    await runWorkerCommand(args.slice(1));
    return;
  }

  if (args[0] === '__worker-service-run') {
    await runWorkerForeground();
    return;
  }

  if (args[0] === '__oauth-detached-child') {
    const requestPath = args[1];
    if (!requestPath) throw new OperationError('invalid_params', 'Detached OAuth child request path is required.');
    await runDetachedOAuthChildFromRequestFile(requestPath);
    return;
  }

  if (args[0] === 'connect') {
    try {
      const result = await runConnect(args.slice(1));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (args[0] === 'dashboard') {
    if (args[1] === 'token') {
      // Prints the worker auth token, on purpose and only when asked by name:
      // it is what the dashboard's "Unlock" field takes, and the owner ruled
      // (2026-09-01) that handing it over on request is the supported path.
      // Bare value on stdout so it can be piped or copied; nothing else.
      console.log(runDashboardTokenCommand());
      return;
    }
    const result = runDashboardCommand();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'calendar' && args[1] === 'agenda') {
    try {
      const agenda = parseCalendarAgendaArgs(args.slice(2));
      const result = await runCalendarAgenda({ broker: createEnvCredentialBroker(), agenda });
      console.log(agenda.json ? JSON.stringify(result, null, 2) : formatCalendarAgenda(result));
    } catch (error) {
      if (error instanceof CalendarAgendaError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'source' && args[1] === 'scheduler' && args[2] === 'unpark') {
    try {
      const cancelling = args[3] === 'cancel';
      const options = parseSourceSchedulerUnparkArgs(args.slice(cancelling ? 4 : 3));
      console.log(JSON.stringify(
        cancelling
          ? runSourceSchedulerUnparkCancel(options)
          : runSourceSchedulerUnpark(options),
        null,
        2,
      ));
    } catch (error) {
      if (error instanceof SourceSchedulerUnparkRefusal) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (
    !PUBLIC_RUNTIME_BUILD
    && args[0] === 'source'
    && args[1] === 'request-budget'
    && args[2] === 'recover-future'
  ) {
    try {
      console.log(JSON.stringify(runGoogleRequestBudgetFutureRecovery(
        parseGoogleRequestBudgetFutureRecoveryArgs(args.slice(3)),
      ), null, 2));
    } catch (error) {
      if (error instanceof GoogleRequestBudgetRecoveryRefusal) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      if (error instanceof GoogleRequestBudgetError) {
        console.error(`Error [${error.reason}]: ${error.message}`);
        process.exit(1);
      }
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'ingestion' && args[1] === 'status') {
    const json = args.includes('--json');
    const result = await collectLocalSourceIngestionLedger({ config: loadConfig() });
    console.log(json ? JSON.stringify(result, null, 2) : formatSourceIngestionLedger(result));
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'ingestion' && args[1] === 'requalify') {
    try {
      const result = await runTerminalContentRequalify(parseTerminalContentRequalifyArgs(args.slice(2)));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'ingestion' && args[1] === 'retarget-queued') {
    try {
      const result = await runQueuedContentRetarget(parseQueuedContentRetargetArgs(args.slice(2)));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'ingestion' && args[1] === 'export-eval-shard') {
    try {
      const result = await runEvalShardExport(parseEvalShardExportArgs(args.slice(2)));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'ingestion' && args[1] === 'apply-tier-overrides') {
    try {
      const result = await runOwnerTierOverride(parseOwnerTierOverrideArgs(args.slice(2)));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'x' && args[1] === 'reconcile' && args[2] === 'recover') {
    try {
      console.log(JSON.stringify(runXReconcileRecovery(
        parseXReconcileRecoveryArgs(args.slice(3)),
      ), null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (!PUBLIC_RUNTIME_BUILD && args[0] === 'x' && args[1] === 'content' && args[2] === 'recover') {
    try {
      const options = parseXContentRecoveryArgs(args.slice(3));
      console.log(JSON.stringify(
        await makeContext().email.xBookmarksContentRecovery(options),
        null,
        2,
      ));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  if (args[0] === 'data') {
    try {
      const result = await runDataCommand(args.slice(1));
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (error instanceof OperationError) {
        console.error(`Error [${error.code}]: ${error.message}`);
        if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  const { operation, rest } = resolveCliOperation(args);
  if (!operation) {
    if (isHelpRequest(args) && printCommandGroupHelp(args.filter((arg) => !isHelpFlag(arg)))) {
      return;
    }
    console.error(`Unknown command: ${args.join(' ')}`);
    console.error('Run olympus --help for available commands.');
    process.exit(1);
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    printOperationHelp(operation);
    return;
  }

  try {
    const params = parseArgs(operation, rest);
    validateRequired(operation, params);
    const ctx = makeContext();
    if (!shouldExposeOperation(operation, { config: ctx.config, surface: 'cli' })) {
      throw new OperationError(
        'invalid_params',
        `Olympus operation is not available on this CLI surface: ${operation.cliHints.name}`,
        'Enable the appropriate proof gate and, for private/admin email tools, use an approved local/private model surface.',
      );
    }
    const result = await operation.handler(ctx, params);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (error instanceof OperationError) {
      console.error(`Error [${error.code}]: ${error.message}`);
      if (error.suggestion) console.error(`Fix: ${error.suggestion}`);
      process.exit(1);
    }
    throw error;
  }
}

export function parseArgs(operation: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = operation.cliHints.positional ?? [];
  let position = 0;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const rawFlag = arg.slice(2);
      const equalsIndex = rawFlag.indexOf('=');
      const rawKey = equalsIndex === -1 ? rawFlag : rawFlag.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : rawFlag.slice(equalsIndex + 1);
      const key = rawKey.replace(/-/g, '_');
      const definition = operation.params[key];
      if (definition?.type === 'boolean') {
        if (inlineValue !== undefined) {
          params[key] = parseCliBoolean(inlineValue, key);
        } else if (isBooleanLiteral(args[index + 1])) {
          params[key] = parseCliBoolean(args[index + 1]!, key);
          index += 1;
        } else {
          params[key] = true;
        }
      } else {
        const value = inlineValue ?? args[index + 1];
        if (value === undefined) {
          throw new OperationError('invalid_params', `Missing value for --${key.replace(/_/g, '-')}.`);
        }
        params[key] = definition?.type === 'number' ? Number(value) : value;
        if (inlineValue === undefined) index += 1;
      }
    } else if (position < positional.length) {
      const key = positional[position];
      if (!key) continue;
      const definition = operation.params[key];
      params[key] = definition?.type === 'number' ? Number(arg) : arg;
      position += 1;
    } else {
      throw new OperationError(
        'invalid_params',
        `Unexpected argument: ${arg}.`,
        'Quote multi-word values, for example: olympus source answer "what did we decide about the contract".',
      );
    }
  }

  if (operation.cliHints.stdin && params[operation.cliHints.stdin] === undefined && !process.stdin.isTTY) {
    params[operation.cliHints.stdin] = readFileSync('/dev/stdin', 'utf8');
  }

  return params;
}

function isBooleanLiteral(value: string | undefined): boolean {
  return value === 'true' || value === 'false' || value === '1' || value === '0' || value === 'yes' || value === 'no';
}

function parseCliBoolean(value: string, key: string): boolean {
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new OperationError('invalid_params', `${key} must be true or false.`);
}

// The catalog is the authority on how many leading tokens a CLI name spans; a
// hardcoded cap silently orphans every longer name the catalog declares.
const MAX_CLI_NAME_WORDS = Math.max(
  ...operations.map((operation) => operation.cliHints.name.split(' ').length),
);

export function resolveCliOperation(args: string[]): { operation?: Operation; rest: string[] } {
  for (let length = Math.min(MAX_CLI_NAME_WORDS, args.length); length > 0; length -= 1) {
    const cliName = args.slice(0, length).join(' ');
    const operation = findOperationByCliName(cliName);
    if (operation) return { operation, rest: args.slice(length) };
  }
  return { rest: args };
}

export function v04PublicCliCommandName(args: readonly string[]): string | undefined {
  const commandArgs = args.filter((arg) => !isHelpFlag(arg));
  if (commandArgs.length === 0) return undefined;
  const { operation } = resolveCliOperation([...commandArgs]);
  if (operation) return operation.cliHints.name;

  const [group, command] = commandArgs;
  if (group === 'setup' || group === 'dashboard' || group === 'serve') return group;
  if (
    group === 'sovereignty'
    || group === 'sensitivity'
    || group === 'worker'
    || group === 'connect'
    || group === 'data'
  ) {
    return command ? `${group} ${command}` : undefined;
  }
  return undefined;
}

export function isV04PublicCliInvocation(args: readonly string[]): boolean {
  if (args.length === 0) return true;
  if (args.length === 1 && (V0_4_PUBLIC_CLI_GLOBALS as readonly string[]).includes(args[0] ?? '')) {
    return true;
  }
  if ((V0_4_PACKAGE_INTERNAL_CLI_HELPERS as readonly string[]).includes(args[0] ?? '')) return true;
  const commandArgs = args.filter((arg) => !isHelpFlag(arg));
  if (isHelpRequest(args) && PUBLIC_CLI_HELP_GROUPS.has(commandArgs.join(' '))) return true;
  const commandName = v04PublicCliCommandName(args);
  return commandName !== undefined && PUBLIC_CLI_COMMAND_NAMES.has(commandName);
}

function validateRequired(operation: Operation, params: Record<string, unknown>): void {
  for (const [name, definition] of Object.entries(operation.params)) {
    if (definition.required && params[name] === undefined) {
      throw new OperationError('invalid_params', `Missing required parameter: ${name}.`);
    }
  }
}

function makeContext(): OperationContext {
  const config = loadConfig();
  return {
    config,
    delphi: new DelphiClient(config, createDelphiTransport(config)),
    email: new EmailClient(config, createEmailTransport(config)),
  };
}

export interface QueuedContentRetargetCliOptions {
  account: string;
  approved_scope_key: string;
  source_extractor_kind: string;
  target_extractor_kind: string;
  target_extractor_version: string;
  limit?: number;
  no_limit?: true;
  dry_run: boolean;
}

export interface TerminalContentRequalifyCliOptions {
  account: string;
  approved_scope_key: string;
  source_extractor_kind: string;
  source_extractor_version?: string;
  source_statuses?: Array<'failed_terminal' | 'metadata_only'>;
  target_extractor_kind: string;
  target_extractor_version: string;
  limit?: number;
  no_limit?: true;
  include_superseded?: true;
  reason?: string;
  dry_run: boolean;
}

export function parseTerminalContentRequalifyArgs(args: string[]): TerminalContentRequalifyCliOptions {
  const values = new Map<string, string>();
  let noLimit = false;
  let includeSuperseded = false;
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--no-limit') {
      noLimit = true;
      continue;
    }
    if (arg === '--include-superseded') {
      includeSuperseded = true;
      continue;
    }
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--dry-run') continue;
    if (!arg.startsWith('--')) throw new OperationError('invalid_params', `Unexpected argument: ${arg}.`);
    const key = arg.slice(2);
    if (![
      'scope',
      'account',
      'source-kind',
      'source-version',
      'statuses',
      'target-kind',
      'target-version',
      'limit',
      'reason',
    ].includes(key)) {
      throw new OperationError('invalid_params', `Unknown terminal-requalify option: ${arg}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} requires a value.`);
    values.set(key, value);
    index += 1;
  }

  const scope = values.get('scope')?.trim();
  const sourceKind = values.get('source-kind')?.trim();
  const targetKind = values.get('target-kind')?.trim();
  const targetVersion = values.get('target-version')?.trim();
  if (!scope) throw new OperationError('invalid_params', 'Terminal requalify requires an explicit --scope.');
  if (!sourceKind) throw new OperationError('invalid_params', 'Terminal requalify requires --source-kind.');
  if (!targetKind) throw new OperationError('invalid_params', 'Terminal requalify requires --target-kind.');
  if (!targetVersion) throw new OperationError('invalid_params', 'Terminal requalify requires --target-version.');

  const account = values.get('account')?.trim() || 'personal';
  const approvedScopeKey = scope.startsWith('/') ? `dropbox.${account}:${scope}` : scope;
  const limitValue = values.get('limit');
  if ((limitValue === undefined) === !noLimit) {
    throw new OperationError('invalid_params', 'Terminal requalify requires exactly one of --limit N or --no-limit.');
  }
  let limit: number | undefined;
  if (limitValue !== undefined) {
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new OperationError('invalid_params', '--limit must be a positive integer.');
    }
  }
  const statusesValue = values.get('statuses');
  const statuses = statusesValue?.split(',').map((status) => status.trim()).filter(Boolean);
  const allowedStatuses = new Set(['failed_terminal', 'metadata_only']);
  if (statusesValue !== undefined && (
    !statuses
    || statuses.length === 0
    || statuses.some((status) => !allowedStatuses.has(status))
  )) {
    throw new OperationError('invalid_params', '--statuses must be a comma-separated subset of failed_terminal,metadata_only.');
  }

  return {
    account,
    approved_scope_key: approvedScopeKey,
    source_extractor_kind: sourceKind,
    ...(values.get('source-version')?.trim()
      ? { source_extractor_version: values.get('source-version')!.trim() }
      : {}),
    ...(statuses ? { source_statuses: [...new Set(statuses)] as Array<'failed_terminal' | 'metadata_only'> } : {}),
    target_extractor_kind: targetKind,
    target_extractor_version: targetVersion,
    ...(limit !== undefined ? { limit } : {}),
    ...(noLimit ? { no_limit: true as const } : {}),
    ...(includeSuperseded ? { include_superseded: true as const } : {}),
    ...(values.get('reason')?.trim() ? { reason: values.get('reason')!.trim() } : {}),
    dry_run: !execute,
  };
}

async function runTerminalContentRequalify(options: TerminalContentRequalifyCliOptions): Promise<unknown> {
  const config = loadConfig();
  const authToken = workerAuthTokenFromConfig(config);
  const response = await fetch(`${config.email.baseUrl}/source/index/dropbox/content/requalify-terminal`, withWorkerAuthHeader({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  }, authToken));
  const body = await response.text();
  if (!response.ok) {
    throw new OperationError(
      'source_index_error',
      `Terminal requalify worker request failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

export function parseQueuedContentRetargetArgs(args: string[]): QueuedContentRetargetCliOptions {
  const values = new Map<string, string>();
  let noLimit = false;
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--no-limit') {
      noLimit = true;
      continue;
    }
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--dry-run') continue;
    if (!arg.startsWith('--')) throw new OperationError('invalid_params', `Unexpected argument: ${arg}.`);
    const key = arg.slice(2);
    if (!['scope', 'account', 'source-kind', 'target-kind', 'target-version', 'limit'].includes(key)) {
      throw new OperationError('invalid_params', `Unknown queued-retarget option: ${arg}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} requires a value.`);
    values.set(key, value);
    index += 1;
  }

  const scope = values.get('scope')?.trim();
  const sourceKind = values.get('source-kind')?.trim();
  const targetKind = values.get('target-kind')?.trim();
  const targetVersion = values.get('target-version')?.trim();
  if (!scope) throw new OperationError('invalid_params', 'Queued retarget requires an explicit --scope.');
  if (!sourceKind) throw new OperationError('invalid_params', 'Queued retarget requires --source-kind.');
  if (!targetKind) throw new OperationError('invalid_params', 'Queued retarget requires --target-kind.');
  if (!targetVersion) throw new OperationError('invalid_params', 'Queued retarget requires --target-version.');

  const account = values.get('account')?.trim() || 'personal';
  const approvedScopeKey = scope.startsWith('/') ? `dropbox.${account}:${scope}` : scope;
  const limitValue = values.get('limit');
  if ((limitValue === undefined) === !noLimit) {
    throw new OperationError('invalid_params', 'Queued retarget requires exactly one of --limit N or --no-limit.');
  }
  let limit: number | undefined;
  if (limitValue !== undefined) {
    limit = Number(limitValue);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new OperationError('invalid_params', '--limit must be a positive integer.');
    }
  }

  return {
    account,
    approved_scope_key: approvedScopeKey,
    source_extractor_kind: sourceKind,
    target_extractor_kind: targetKind,
    target_extractor_version: targetVersion,
    ...(limit !== undefined ? { limit } : {}),
    ...(noLimit ? { no_limit: true as const } : {}),
    dry_run: !execute,
  };
}

async function runQueuedContentRetarget(options: QueuedContentRetargetCliOptions): Promise<unknown> {
  const config = loadConfig();
  const authToken = workerAuthTokenFromConfig(config);
  const response = await fetch(`${config.email.baseUrl}/source/index/dropbox/content/retarget-queued`, withWorkerAuthHeader({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  }, authToken));
  const body = await response.text();
  if (!response.ok) {
    throw new OperationError(
      'source_index_error',
      `Queued retarget worker request failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

export interface EvalShardExportCliOptions {
  account: string;
  approved_scope_key: string;
  count: number;
  out_dir: string;
  doc_types?: string[];
  dry_run: boolean;
}

export function parseEvalShardExportArgs(args: string[]): EvalShardExportCliOptions {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--dry-run') continue;
    if (!arg.startsWith('--')) throw new OperationError('invalid_params', `Unexpected argument: ${arg}.`);
    const key = arg.slice(2);
    if (!['scope', 'account', 'count', 'out', 'doc-types'].includes(key)) {
      throw new OperationError('invalid_params', `Unknown eval-shard export option: ${arg}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} requires a value.`);
    values.set(key, value);
    index += 1;
  }

  const scope = values.get('scope')?.trim();
  if (!scope) throw new OperationError('invalid_params', 'Eval shard export requires an explicit --scope.');
  const count = Number(values.get('count'));
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new OperationError('invalid_params', 'Eval shard export requires --count N as a positive integer.');
  }
  const out = values.get('out')?.trim();
  if (!out) throw new OperationError('invalid_params', 'Eval shard export requires --out DIR.');
  const account = values.get('account')?.trim() || 'personal';
  const approvedScopeKey = scope.startsWith('/') ? `dropbox.${account}:${scope}` : scope;
  const docTypes = values.get('doc-types')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.has('doc-types') && (!docTypes || docTypes.length === 0)) {
    throw new OperationError('invalid_params', '--doc-types requires a comma-separated type list.');
  }
  return {
    account,
    approved_scope_key: approvedScopeKey,
    count,
    out_dir: resolve(out),
    ...(docTypes ? { doc_types: docTypes } : {}),
    dry_run: !execute,
  };
}

async function runEvalShardExport(options: EvalShardExportCliOptions): Promise<unknown> {
  const config = loadConfig();
  const authToken = workerAuthTokenFromConfig(config);
  const response = await fetch(`${config.email.baseUrl}/source/index/dropbox/content/export-eval-shard`, withWorkerAuthHeader({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  }, authToken));
  const body = await response.text();
  if (!response.ok) {
    throw new OperationError(
      'source_index_error',
      `Eval shard export worker request failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

export interface OwnerTierOverrideCliOptions {
  overrides: Record<string, string>;
  reason: string;
  dry_run: boolean;
}

export function parseOwnerTierOverrideArgs(args: string[]): OwnerTierOverrideCliOptions {
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--apply' || arg === '--execute') {
      execute = true;
      continue;
    }
    if (arg === '--dry-run') continue;
    if (!arg.startsWith('--')) throw new OperationError('invalid_params', `Unexpected argument: ${arg}.`);
    const key = arg.slice(2);
    if (!['input', 'reason'].includes(key)) {
      throw new OperationError('invalid_params', `Unknown apply-tier-overrides option: ${arg}.`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${arg} requires a value.`);
    values.set(key, value);
    index += 1;
  }

  const input = values.get('input')?.trim();
  if (!input) throw new OperationError('invalid_params', 'Owner tier override requires --input <file.json>.');
  const reason = values.get('reason')?.trim();
  if (!reason) throw new OperationError('invalid_params', 'Owner tier override requires --reason <string>.');

  let raw: string;
  try {
    raw = readFileSync(resolve(input), 'utf8');
  } catch (error) {
    throw new OperationError('invalid_params', `Owner tier override --input file could not be read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new OperationError('invalid_params', `Owner tier override --input file is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperationError('invalid_params', 'Owner tier override --input file must be a JSON object mapping review keys to trust tiers.');
  }
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new OperationError('invalid_params', `Owner tier override --input value for ${JSON.stringify(key)} must be a trust-tier string.`);
    }
    overrides[key] = value;
  }

  return { overrides, reason, dry_run: !execute };
}

async function runOwnerTierOverride(options: OwnerTierOverrideCliOptions): Promise<unknown> {
  const config = loadConfig();
  const authToken = workerAuthTokenFromConfig(config);
  const response = await fetch(`${config.email.baseUrl}/source/index/dropbox/content/apply-tier-overrides`, withWorkerAuthHeader({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  }, authToken));
  const body = await response.text();
  if (!response.ok) {
    throw new OperationError(
      'source_index_error',
      `Owner tier override worker request failed with HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return body ? JSON.parse(body) : {};
}

function toToolsJson(config: OlympusConfig): unknown[] {
  return exposedOperations(operations, { config, surface: 'cli' }).map((operation) => ({
    name: operation.name,
    description: operationDescription(operation, { config }),
    inputSchema: operationToolSchema(operation, { config }),
  }));
}

function printHelp(): void {
  console.log(`Olympus ${VERSION}`);
  console.log('');
  console.log('Commands:');
  console.log('  olympus argus ping [--lane fast|deep]');
  console.log('  olympus argus list [--lane fast|deep]');
  console.log('  olympus argus complete <prompt> [--lane fast|deep]');
  console.log('  olympus source answer <question>');
  console.log('  olympus source index status');
  console.log('  olympus source index search <query> --corpus-id <corpus>');
  console.log(`  olympus setup --preset ${SOVEREIGNTY_PRESETS.join('|')} --yes [--cloud-lane subscription|api-key]`);
  console.log(`  olympus sovereignty init --preset ${SOVEREIGNTY_PRESETS.join('|')} [--path ~/.olympus/sovereignty.json]`);
  console.log('  olympus sensitivity validate [--path ~/.olympus/sensitivity-map.json]');
  console.log('  olympus worker install [--platform darwin|linux] [--dry-run]');
  console.log('  olympus worker start|stop|restart|status|foreground|upgrade|uninstall');
  console.log('  olympus dashboard');
  console.log('  olympus dashboard token');
  console.log('  olympus doctor');
  console.log('  olympus connect google|gmail|google-drive --client-id <id> [--client-secret-stdin] [--redirect-port <port>] [--oauth-timeout-ms <ms>]');
  console.log('  olympus connect dropbox --client-id <id> [--redirect-port <port>] [--oauth-timeout-ms <ms>]');
  console.log('  olympus connect telegram|whatsapp --session-path <path>');
  console.log('  olympus connect venice|readwise --api-key-stdin');
  console.log('  olympus connect status [google|gmail|google-drive|dropbox]');
  console.log('  olympus data export --output <dir> [--source <id>]');
  console.log('  olympus data verify --input <dir>');
  console.log('  olympus data delete --all|--source <id> [--dry-run] [--yes-i-am-sure]');
  console.log('  olympus serve');
  console.log('  olympus --tools-json');
}

const PUBLIC_LEAF_USAGE: Readonly<Record<string, string>> = {
  setup: 'olympus setup --preset <preset> --yes',
  'sovereignty init': 'olympus sovereignty init --preset <preset> [--path <path>]',
  'sensitivity validate': 'olympus sensitivity validate [--path <path>]',
  'worker install': 'olympus worker install [--platform darwin|linux] [--dry-run]',
  'worker status': 'olympus worker status [--platform darwin|linux]',
  'worker start': 'olympus worker start [--platform darwin|linux]',
  'worker stop': 'olympus worker stop [--platform darwin|linux]',
  'worker restart': 'olympus worker restart [--platform darwin|linux]',
  'worker foreground': 'olympus worker foreground',
  'worker upgrade': 'olympus worker upgrade --artifact <path> [--platform darwin|linux]',
  'worker uninstall': 'olympus worker uninstall [--platform darwin|linux]',
  'worker run': 'olympus worker run',
  'connect google': 'olympus connect google --client-id <id>',
  'connect gmail': 'olympus connect gmail --client-id <id>',
  'connect google-drive': 'olympus connect google-drive --client-id <id>',
  'connect dropbox': 'olympus connect dropbox --client-id <id>',
  'connect telegram': 'olympus connect telegram --session-path <path>',
  'connect whatsapp': 'olympus connect whatsapp --session-path <path>',
  'connect venice': 'olympus connect venice --api-key-stdin',
  'connect readwise': 'olympus connect readwise --api-key-stdin',
  'connect status': 'olympus connect status [google|gmail|google-drive|dropbox]',
  dashboard: 'olympus dashboard',
  'data export': 'olympus data export --output <dir> [--source <id>]',
  'data verify': 'olympus data verify --input <dir>',
  'data delete': 'olympus data delete --all|--source <id> [--dry-run]',
  serve: 'olympus serve',
};

function printPublicLeafCommandHelp(args: string[]): boolean {
  const commandName = v04PublicCliCommandName(args);
  if (!commandName || !PUBLIC_CLI_COMMAND_NAMES.has(commandName)) return false;
  const { operation } = resolveCliOperation(args);
  if (operation) {
    printOperationHelp(operation);
    return true;
  }
  const usage = PUBLIC_LEAF_USAGE[commandName];
  if (!usage) throw new Error(`Missing public leaf help for ${commandName}.`);
  console.log(`Usage: ${usage}`);
  return true;
}

const COMMAND_GROUP_HELP: Record<string, string[]> = {
  argus: [
    'Usage: olympus argus <command>',
    'Commands:',
    '  olympus argus ping [--lane fast|deep]',
    '  olympus argus list [--lane fast|deep]',
    '  olympus argus complete <prompt> [--lane fast|deep]',
  ],
  source: [
    'Usage: olympus source <command>',
    'Commands:',
    '  olympus source answer <question>',
    '  olympus source index status',
    '  olympus source index search <query> --corpus-id <corpus>',
  ],
  'source index': [
    'Usage: olympus source index <command>',
    'Commands:',
    '  olympus source index status',
    '  olympus source index search <query> --corpus-id <corpus>',
  ],
  sovereignty: [
    'Usage: olympus sovereignty <command>',
    'Commands:',
    `  olympus sovereignty init --preset ${SOVEREIGNTY_PRESETS.join('|')} [--path <path>] [--force]`,
  ],
  sensitivity: [
    'Usage: olympus sensitivity <command>',
    'Commands:',
    '  olympus sensitivity validate [--path <path>]',
  ],
  worker: [
    'Usage: olympus worker install|start|stop|restart|status|foreground|upgrade|uninstall',
  ],
  connect: [
    'Usage: olympus connect <source>',
    'Commands:',
    '  olympus connect google|gmail|google-drive --client-id <id> [--client-secret-stdin]',
    '  olympus connect dropbox --client-id <id>',
    '  olympus connect telegram|whatsapp --session-path <path>',
    '  olympus connect venice|readwise --api-key-stdin',
  ],
  data: [
    'Usage: olympus data <command>',
    'Commands:',
    '  olympus data export --output <dir> [--source <id>]',
    '  olympus data verify --input <dir>',
    '  olympus data delete --all|--source <id> [--dry-run] [--yes-i-am-sure]',
  ],
};

export interface XContentRecoveryCliOptions {
  execute: boolean;
  limit?: number;
}

export function parseXContentRecoveryArgs(args: string[]): XContentRecoveryCliOptions {
  let execute = false;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--execute') execute = true;
    else if (arg === '--limit') limit = Number(requireOptionValue(args, (index += 1), arg));
    else if (arg?.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length));
    else throw new OperationError('invalid_params', `Unknown X content recovery option: ${arg}`);
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
    throw new OperationError('invalid_params', 'X content recovery limit must be between 1 and 100.');
  }
  return { execute, ...(limit !== undefined ? { limit } : {}) };
}

export interface XReconcileRecoveryCliOptions {
  account: string;
  stateDbPath?: string;
  execute: boolean;
  expectedStagedDigestSha256?: string;
}

export function parseXReconcileRecoveryArgs(args: string[]): XReconcileRecoveryCliOptions {
  let account = 'personal';
  let stateDbPath: string | undefined;
  let execute = false;
  let expectedStagedDigestSha256: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--account') account = requireOptionValue(args, (index += 1), arg);
    else if (arg?.startsWith('--account=')) account = arg.slice('--account='.length);
    else if (arg === '--state-db') stateDbPath = requireOptionValue(args, (index += 1), arg);
    else if (arg?.startsWith('--state-db=')) stateDbPath = arg.slice('--state-db='.length);
    else if (arg === '--expected-staged-digest') {
      expectedStagedDigestSha256 = requireOptionValue(args, (index += 1), arg);
    } else if (arg?.startsWith('--expected-staged-digest=')) {
      expectedStagedDigestSha256 = arg.slice('--expected-staged-digest='.length);
    } else if (arg === '--execute') execute = true;
    else throw new OperationError('invalid_params', `Unknown X reconcile recovery option: ${arg}`);
  }
  account = account.trim();
  if (!account) throw new OperationError('invalid_params', 'X reconcile recovery account must be non-empty.');
  if (stateDbPath !== undefined && !stateDbPath.trim()) {
    throw new OperationError('invalid_params', 'X reconcile recovery state DB path must be non-empty.');
  }
  if (expectedStagedDigestSha256 !== undefined
    && !/^[a-f0-9]{64}$/.test(expectedStagedDigestSha256)) {
    throw new OperationError(
      'invalid_params',
      'X reconcile recovery expected staged digest must be lowercase SHA-256.',
    );
  }
  if (execute && !expectedStagedDigestSha256) {
    throw new OperationError(
      'invalid_params',
      'X reconcile recovery --execute requires --expected-staged-digest from a fresh inspection.',
    );
  }
  return {
    account,
    ...(stateDbPath ? { stateDbPath: resolve(stateDbPath) } : {}),
    execute,
    ...(expectedStagedDigestSha256 ? { expectedStagedDigestSha256 } : {}),
  };
}

export function runXReconcileRecovery(options: XReconcileRecoveryCliOptions): unknown {
  const store = new LocalXBookmarksReconcileStateStore(
    options.stateDbPath ?? defaultXBookmarksReconcileStateDbPath(),
  );
  try {
    if (!options.execute) return store.stagedRecoveryStatus(options.account);
    return store.recoverStagedRun({
      account: options.account,
      expectedStagedDigestSha256: options.expectedStagedDigestSha256!,
      mode: 'operator',
    });
  } finally {
    store.close();
  }
}

function isHelpFlag(value: string): boolean {
  return value === '--help' || value === '-h';
}

function isHelpRequest(args: readonly string[]): boolean {
  return args.some(isHelpFlag);
}

function printCommandGroupHelp(path: string[]): boolean {
  const key = path.join(' ');
  const lines = COMMAND_GROUP_HELP[key];
  if (!lines) return false;
  console.log(lines.join('\n'));
  return true;
}

export interface SourceSchedulerUnparkCliOptions {
  source: string;
  task: string;
  expectedNotBefore: string;
  reason: string;
}

const SAFE_SOURCE_SCHEDULER_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SAFE_SOURCE_SCHEDULER_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseSourceSchedulerUnparkArgs(
  args: string[],
): SourceSchedulerUnparkCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: olympus source scheduler unpark --source <source> --task <task> '
        + '--expected-not-before <ISO> --reason <reason>',
      );
      process.exit(0);
    }
    if (!arg?.startsWith('--')) {
      throw new OperationError('invalid_params', `Unexpected source scheduler unpark argument: ${arg}`);
    }
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    if (!['source', 'task', 'expected-not-before', 'reason'].includes(key)) {
      throw new OperationError('invalid_params', `Unknown source scheduler unpark option: --${key}`);
    }
    const value = equals === -1
      ? requireOptionValue(args, (index += 1), `--${key}`)
      : arg.slice(equals + 1);
    if (!value.trim()) {
      throw new OperationError('invalid_params', `--${key} requires a non-empty value.`);
    }
    values.set(key, value.trim());
  }
  const source = values.get('source');
  const task = values.get('task');
  const expectedNotBefore = values.get('expected-not-before');
  const reason = values.get('reason');
  if (!source || !task || !expectedNotBefore || !reason) {
    throw new OperationError(
      'invalid_params',
      'Source scheduler unpark requires --source, --task, --expected-not-before, and --reason.',
    );
  }
  if (!Number.isFinite(Date.parse(expectedNotBefore))) {
    throw new OperationError('invalid_params', '--expected-not-before must be a valid ISO timestamp.');
  }
  if (!SAFE_SOURCE_SCHEDULER_KEY.test(source)) {
    throw new OperationError('invalid_params', '--source must be a safe scheduler identifier.');
  }
  if (!SAFE_SOURCE_SCHEDULER_KEY.test(task)) {
    throw new OperationError('invalid_params', '--task must be a safe scheduler identifier.');
  }
  if (!SAFE_SOURCE_SCHEDULER_TOKEN.test(reason)) {
    throw new OperationError('invalid_params', '--reason must be a safe categorical token.');
  }
  return {
    source,
    task,
    expectedNotBefore,
    reason,
  };
}

export function runSourceSchedulerUnpark(
  options: SourceSchedulerUnparkCliOptions,
): SourceSchedulerUnparkReceipt {
  const store = new LocalSourceSchedulerStateStore();
  try {
    return store.requestUnpark({
      sourceId: options.source,
      taskId: options.task,
      expectedNotBeforeAt: options.expectedNotBefore,
      reason: options.reason,
      requestedAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
}

export function runSourceSchedulerUnparkCancel(
  options: SourceSchedulerUnparkCliOptions,
): SourceSchedulerUnparkCancellationReceipt {
  const store = new LocalSourceSchedulerStateStore();
  try {
    return store.cancelUnpark({
      sourceId: options.source,
      taskId: options.task,
      expectedNotBeforeAt: options.expectedNotBefore,
      reason: options.reason,
      cancelledAt: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
}

export interface GoogleRequestBudgetFutureRecoveryCliOptions {
  provider: 'gmail' | 'google-drive';
  expectedFutureDay: string;
  reason: string;
}

export function parseGoogleRequestBudgetFutureRecoveryArgs(
  args: string[],
): GoogleRequestBudgetFutureRecoveryCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: olympus source request-budget recover-future '
        + '--provider gmail|google-drive --expected-future-day <YYYY-MM-DD> --reason <reason>',
      );
      process.exit(0);
    }
    if (!arg?.startsWith('--')) {
      throw new OperationError('invalid_params', `Unexpected request-budget recovery argument: ${arg}`);
    }
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    if (!['provider', 'expected-future-day', 'reason'].includes(key)) {
      throw new OperationError('invalid_params', `Unknown request-budget recovery option: --${key}`);
    }
    const value = equals === -1
      ? requireOptionValue(args, (index += 1), `--${key}`)
      : arg.slice(equals + 1);
    values.set(key, value.trim());
  }
  const provider = values.get('provider');
  const expectedFutureDay = values.get('expected-future-day');
  const reason = values.get('reason');
  if (
    (provider !== 'gmail' && provider !== 'google-drive')
    || !expectedFutureDay
    || !reason
  ) {
    throw new OperationError(
      'invalid_params',
      'Request-budget recovery requires --provider gmail|google-drive, --expected-future-day, and --reason.',
    );
  }
  if (
    !UTC_DAY.test(expectedFutureDay)
    || new Date(`${expectedFutureDay}T00:00:00.000Z`).toISOString().slice(0, 10) !== expectedFutureDay
  ) {
    throw new OperationError('invalid_params', '--expected-future-day must be a valid UTC day.');
  }
  if (!SAFE_SOURCE_SCHEDULER_TOKEN.test(reason)) {
    throw new OperationError('invalid_params', '--reason must be a safe categorical token.');
  }
  return { provider, expectedFutureDay, reason };
}

export function runGoogleRequestBudgetFutureRecovery(
  options: GoogleRequestBudgetFutureRecoveryCliOptions,
): GoogleRequestBudgetFutureDayRecoveryReceipt {
  const gmail = options.provider === 'gmail';
  const budget = new GoogleDailyRequestBudget({
    provider: gmail ? 'Gmail' : 'Google Drive',
    dailyRequestBudget: 1,
    statePath: gmail
      ? defaultGmailRequestBudgetStatePath(process.env)
      : defaultGoogleDriveRequestBudgetStatePath(process.env),
  });
  return budget.recoverFutureUtcDay({
    expectedFutureUtcDay: options.expectedFutureDay,
    reason: options.reason,
  });
}

async function runWorkerCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    console.log('Usage: olympus worker install|start|stop|restart|status|foreground|upgrade|uninstall');
    return;
  }
  if (command === 'run' || command === 'foreground') {
    await runWorkerForeground();
    return;
  }
  if (command === 'install' || command === 'upgrade') {
    const parsed = parseWorkerInstallArgs(command, args.slice(1));
    const options = command === 'install' ? withWorkerInstallAuth(parsed) : parsed;
    console.log(JSON.stringify(runWorkerLifecycle(command, options), null, 2));
    return;
  }
  if (['status', 'start', 'stop', 'restart', 'uninstall'].includes(command)) {
    const actionOptions = parseWorkerActionArgs(args.slice(1));
    const workerHttp = command === 'status' ? await readWorkerHttpState() : undefined;
    const result = runWorkerLifecycle(
      command as Extract<WorkerLifecycleAction, 'status' | 'start' | 'stop' | 'restart' | 'uninstall'>,
      {
        ...actionOptions,
        ...(workerHttp ? { recoverySignals: lifecycleRecoverySignalsFromWorkerHttpState(workerHttp) } : {}),
      },
    );
    if (command === 'status') {
      console.log(JSON.stringify({
        ...result,
        worker_http: workerHttp,
      }, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new OperationError('invalid_params', `Unknown worker command: ${command}`);
}

async function runWorkerForeground(): Promise<void> {
  applyWorkerSetupEnv();
  const { main: startEmailSourceWorker } = await import('./workers/email-source/server.ts');
  startEmailSourceWorker();
}

async function readWorkerHttpState(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const baseUrl = config.email.baseUrl;
  const authToken = workerAuthTokenFromConfig(config);
  try {
    const health = await fetchJson(`${baseUrl}/health`, { method: 'GET' });
    const output: Record<string, unknown> = {
      reachable: true,
      base_url: baseUrl,
      health,
    };
    if (config.sourceIndex.enabled && authToken) {
      try {
        output.source_index_status = await fetchJson(`${baseUrl}/source/index/status`, withWorkerAuthHeader({ method: 'GET' }, authToken));
      } catch (error) {
        output.source_index_status = {
          reachable: false,
          error: cliErrorDetail(error),
        };
      }
    } else if (config.sourceIndex.enabled) {
      output.source_index_status = { reachable: false, skipped_reason: 'worker_auth_token_unavailable' };
    }
    if (authToken) {
      try {
        output.source_dashboard = await fetchJson(`${baseUrl}/dashboard.json`, withWorkerAuthHeader({ method: 'GET' }, authToken));
      } catch (error) {
        output.source_dashboard = { reachable: false, error: cliErrorDetail(error) };
      }
    } else {
      output.source_dashboard = { reachable: false, skipped_reason: 'worker_auth_token_unavailable' };
    }
    return {
      ...output,
    };
  } catch (error) {
    return {
      reachable: false,
      base_url: baseUrl,
      error: cliErrorDetail(error),
    };
  }
}

/** Translate the worker's public dashboard facts into exact no-restart recovery verbs. */
export function lifecycleRecoverySignalsFromWorkerHttpState(
  workerHttp: unknown,
): LifecycleRecoverySignal[] {
  const root = asRecord(workerHttp);
  const dashboard = asRecord(root?.source_dashboard);
  const sources = Array.isArray(dashboard?.sources) ? dashboard.sources : [];
  const capabilities: ReadonlyMap<string, (typeof V0_4_PUBLIC_SOURCE_CAPABILITIES)[number]> = new Map(
    V0_4_PUBLIC_SOURCE_CAPABILITIES.map((item) => [item.source_id, item]),
  );
  const signals: LifecycleRecoverySignal[] = [];
  const add = (signal: LifecycleRecoverySignal): void => {
    const key = `${signal.kind}|${signal.source_id ?? ''}|${signal.dependency_id ?? ''}`;
    if (!signals.some((existing) => `${existing.kind}|${existing.source_id ?? ''}|${existing.dependency_id ?? ''}` === key)) {
      signals.push(signal);
    }
  };

  for (const raw of sources) {
    const source = asRecord(raw);
    if (!source) continue;
    const sourceId = typeof source.source_id === 'string' && capabilities.has(source.source_id)
      ? source.source_id
      : undefined;
    if (!sourceId) continue;
    const capability = capabilities.get(sourceId)!;
    const connection = asRecord(source.connection);
    const connectionState = typeof connection?.state === 'string' ? connection.state : '';
    const answerReadiness = asRecord(source.answer_readiness);
    const queue = asRecord(source.queue_health);
    const needsAttention = typeof queue?.needs_attention === 'number' && queue.needs_attention > 0;

    if (connectionState === 'awaiting_consent') add({ kind: 'oauth_pending', source_id: sourceId });
    if (connectionState === 'reauth_required') {
      if (capability.authentication.type === 'paired_session') add({ kind: 'pairing_pending', source_id: sourceId });
      else if (capability.authentication.type === 'oauth2') add({ kind: 'oauth_pending', source_id: sourceId });
      else if (capability.dependencies[0]) {
        add({ kind: 'missing_dependency', source_id: sourceId, dependency_id: capability.dependencies[0].id });
      }
    }
    if (
      capability.authentication.type === 'paired_session'
      && (connectionState === 'not_connected' || connectionState === 'needs_setup')
    ) {
      add({ kind: 'pairing_pending', source_id: sourceId });
    }
    if (answerReadiness?.state === 'needs_attention' || needsAttention) {
      add({
        kind: capability.authentication.type === 'paired_session' ? 'capture_interrupted' : 'partial_sync',
        source_id: sourceId,
      });
    }
    if (source.embedding_lane_state === 'embedding_lane_disabled') {
      const dependency = capability.dependencies.find((item) => item.id === 'local_embedding_lane');
      if (dependency) add({ kind: 'missing_dependency', source_id: sourceId, dependency_id: dependency.id });
    }
  }
  return signals;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function cliErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WorkerInstallCliOptions {
  platform?: WorkerServicePlatform;
  homeDir?: string;
  authToken?: string;
  schedulerEnabled?: boolean;
  dryRun?: boolean;
  artifactPath?: string;
}

function parseWorkerInstallArgs(action: 'install' | 'upgrade', args: string[]): WorkerInstallCliOptions {
  const options: WorkerInstallCliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--platform') {
      options.platform = parseWorkerPlatform(args[index + 1]);
      index += 1;
    } else if (arg?.startsWith('--platform=')) {
      options.platform = parseWorkerPlatform(arg.slice('--platform='.length));
    } else if (arg === '--home') {
      options.homeDir = requireNext(args, index, '--home');
      index += 1;
    } else if (arg?.startsWith('--home=')) {
      options.homeDir = arg.slice('--home='.length);
    } else if (arg === '--scheduler-enabled') {
      options.schedulerEnabled = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (action === 'upgrade' && arg === '--artifact') {
      options.artifactPath = requireNext(args, index, '--artifact');
      index += 1;
    } else if (action === 'upgrade' && arg?.startsWith('--artifact=')) {
      options.artifactPath = arg.slice('--artifact='.length);
    } else {
      throw new OperationError('invalid_params', `Unknown worker ${action} option: ${arg}`);
    }
  }
  if (action === 'upgrade' && !options.artifactPath?.trim()) {
    throw new OperationError('invalid_params', 'olympus worker upgrade requires --artifact <path>.');
  }
  return options;
}

function withWorkerInstallAuth(options: WorkerInstallCliOptions): WorkerInstallCliOptions {
  if (options.dryRun === true || options.authToken?.trim()) return options;
  return {
    ...options,
    authToken: workerAuthTokenFromSetupEnv({
      ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    }) ?? generateWorkerAuthToken(),
  };
}

function generateWorkerAuthToken(): string {
  return randomBytes(32).toString('base64url');
}

function parseWorkerActionArgs(args: string[]): { platform?: WorkerServicePlatform; homeDir?: string } {
  const options: { platform?: WorkerServicePlatform; homeDir?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--platform') {
      options.platform = parseWorkerPlatform(args[index + 1]);
      index += 1;
    } else if (arg?.startsWith('--platform=')) {
      options.platform = parseWorkerPlatform(arg.slice('--platform='.length));
    } else if (arg === '--home') {
      options.homeDir = requireNext(args, index, '--home');
      index += 1;
    } else if (arg?.startsWith('--home=')) {
      options.homeDir = arg.slice('--home='.length);
    } else {
      throw new OperationError('invalid_params', `Unknown worker service option: ${arg}`);
    }
  }
  return options;
}

function parseWorkerPlatform(value: string | undefined): WorkerServicePlatform {
  if (value === 'darwin' || value === 'linux') return value;
  throw new OperationError('invalid_params', '--platform must be darwin or linux.');
}

function parseSetupArgs(args: string[]): Parameters<typeof runSetupWizard>[0] {
  let preset: SovereigntyPresetName | undefined;
  let yes = false;
  let cloudLane: SetupCloudLane | undefined;
  let sovereigntyPath: string | undefined;
  let force = false;
  let dryRun = false;
  let platform: WorkerServicePlatform | undefined;
  let homeDir: string | undefined;
  let olympusBin: string | undefined;
  let workingDirectory: string | undefined;
  let envPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--preset') {
      preset = parseSetupPreset(requireNext(args, index, '--preset'));
      index += 1;
    } else if (arg?.startsWith('--preset=')) {
      preset = parseSetupPreset(arg.slice('--preset='.length));
    } else if (arg === '--yes') {
      yes = true;
    } else if (arg === '--cloud-lane') {
      cloudLane = parseSetupCloudLane(requireNext(args, index, '--cloud-lane'));
      index += 1;
    } else if (arg?.startsWith('--cloud-lane=')) {
      cloudLane = parseSetupCloudLane(arg.slice('--cloud-lane='.length));
    } else if (arg === '--path') {
      sovereigntyPath = requireNext(args, index, '--path');
      index += 1;
    } else if (arg?.startsWith('--path=')) {
      sovereigntyPath = arg.slice('--path='.length);
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--platform') {
      platform = parseWorkerPlatform(requireNext(args, index, '--platform'));
      index += 1;
    } else if (arg?.startsWith('--platform=')) {
      platform = parseWorkerPlatform(arg.slice('--platform='.length));
    } else if (arg === '--home') {
      homeDir = requireNext(args, index, '--home');
      index += 1;
    } else if (arg?.startsWith('--home=')) {
      homeDir = arg.slice('--home='.length);
    } else if (arg === '--olympus-bin') {
      olympusBin = requireNext(args, index, '--olympus-bin');
      index += 1;
    } else if (arg?.startsWith('--olympus-bin=')) {
      olympusBin = arg.slice('--olympus-bin='.length);
    } else if (arg === '--working-directory') {
      workingDirectory = requireNext(args, index, '--working-directory');
      index += 1;
    } else if (arg?.startsWith('--working-directory=')) {
      workingDirectory = arg.slice('--working-directory='.length);
    } else if (arg === '--env-path') {
      envPath = requireNext(args, index, '--env-path');
      index += 1;
    } else if (arg?.startsWith('--env-path=')) {
      envPath = arg.slice('--env-path='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: olympus setup --preset ${SOVEREIGNTY_PRESETS.join('|')} --yes [--cloud-lane subscription|api-key] [--path <path>] [--force] [--platform darwin|linux] [--home <path>] [--dry-run]`);
      process.exit(0);
    } else {
      throw new OperationError('invalid_params', `Unknown setup option: ${arg}`);
    }
  }
  if (!preset) {
    throw new OperationError(
      'invalid_params',
      '--preset is required for olympus setup.',
      `Use one of: ${SOVEREIGNTY_PRESETS.join(', ')}.`,
    );
  }
  return {
    preset,
    yes,
    ...(cloudLane ? { cloudLane } : {}),
    ...(sovereigntyPath ? { sovereigntyPath } : {}),
    force,
    dryRun,
    ...(platform ? { platform } : {}),
    ...(homeDir ? { homeDir } : {}),
    ...(olympusBin ? { olympusBin } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(envPath ? { envPath } : {}),
  };
}

function parseSetupPreset(value: string): SovereigntyPresetName {
  if (isSovereigntyPreset(value)) return value;
  throw new OperationError('invalid_params', `--preset must be one of ${SOVEREIGNTY_PRESETS.join(', ')}.`);
}

function parseSetupCloudLane(value: string): SetupCloudLane {
  if (value === 'subscription' || value === 'api-key') return value;
  throw new OperationError('invalid_params', '--cloud-lane must be subscription or api-key.');
}

function requireNext(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value) throw new OperationError('invalid_params', `Missing value for ${flag}.`);
  return value;
}

function printOperationHelp(operation: Operation): void {
  console.log(operationDescription(operation));
  console.log('');
  console.log(`Usage: olympus ${operation.cliHints.name} ${(operation.cliHints.positional ?? []).map((name) => `<${name}>`).join(' ')}`);
}

function runSovereigntyInit(args: string[]): {
  ok: true;
  path: string;
  preset: SovereigntyPresetName;
  schemaVersion: 1;
} {
  let preset: SovereigntyPresetName | undefined;
  let path: string | undefined;
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--preset') {
      const value = args[index + 1];
      if (!isSovereigntyPreset(value)) {
        throw new OperationError(
          'invalid_params',
          `--preset must be one of ${SOVEREIGNTY_PRESETS.join(', ')}.`,
        );
      }
      preset = value;
      index += 1;
    } else if (arg?.startsWith('--preset=')) {
      const value = arg.slice('--preset='.length);
      if (!isSovereigntyPreset(value)) {
        throw new OperationError(
          'invalid_params',
          `--preset must be one of ${SOVEREIGNTY_PRESETS.join(', ')}.`,
        );
      }
      preset = value;
    } else if (arg === '--path') {
      path = args[index + 1];
      if (!path) throw new OperationError('invalid_params', 'Missing value for --path.');
      index += 1;
    } else if (arg?.startsWith('--path=')) {
      path = arg.slice('--path='.length);
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: olympus sovereignty init --preset ${SOVEREIGNTY_PRESETS.join('|')} [--path <path>] [--force]`);
      process.exit(0);
    } else {
      throw new OperationError('invalid_params', `Unknown sovereignty init option: ${arg}`);
    }
  }
  if (!preset) {
    throw new OperationError(
      'invalid_params',
      '--preset is required.',
      `Use one of: ${SOVEREIGNTY_PRESETS.join(', ')}.`,
    );
  }
  const targetPath = writeSovereigntyConfigFile({
    config: loadSovereigntyPreset(preset),
    path: path ?? defaultSovereigntyConfigPath(),
    force,
  });
  return {
    ok: true,
    path: targetPath,
    preset,
    schemaVersion: 1,
  };
}

function isSovereigntyPreset(value: string | undefined): value is SovereigntyPresetName {
  return typeof value === 'string' && (SOVEREIGNTY_PRESETS as readonly string[]).includes(value);
}

async function runConnect(args: string[]): Promise<unknown> {
  const rawSource = args[0];
  if (!rawSource || rawSource === '--help' || rawSource === '-h') {
    return {
      usage: [
        'olympus connect google|gmail|google-drive --client-id <id> [--client-secret-stdin] [--detach] [--redirect-port <port>] [--no-open] [--oauth-timeout-ms <ms>]',
        'olympus connect dropbox --client-id <id> [--detach] [--redirect-port <port>] [--no-open] [--oauth-timeout-ms <ms>]',
        'olympus connect telegram|whatsapp --session-path <path> [--session-ready]',
        'olympus connect venice|readwise --api-key-stdin',
        'olympus connect status [google|gmail|google-drive|dropbox]',
      ],
    };
  }
  if (rawSource === 'status') {
    const rawStatusSource = args[1] && !args[1]!.startsWith('--') ? args[1] : undefined;
    const supportedStatusSources = ['google', 'gmail', 'google-drive', 'dropbox'] as const;
    if (rawStatusSource && !(supportedStatusSources as readonly string[]).includes(rawStatusSource)) {
      throw new OperationError(
        'invalid_params',
        `Unsupported connect status source: ${rawStatusSource}`,
        `Use one of: ${supportedStatusSources.join(', ')}.`,
      );
    }
    const statusSource = rawStatusSource as typeof supportedStatusSources[number] | undefined;
    const statusOptions = parseConnectOptions(rawStatusSource ? args.slice(2) : args.slice(1));
    return {
      ok: true,
      states: listDetachedOAuthStates({
        ...(statusSource ? { source: statusSource } : {}),
        ...(statusOptions.oauthStateDir ? { stateDir: statusOptions.oauthStateDir } : {}),
      }),
    };
  }
  if (!(V0_4_PUBLIC_CONNECT_SOURCES as readonly string[]).includes(rawSource)) {
    throw new OperationError('invalid_params', `Unsupported connect source: ${rawSource}`);
  }
  const source = rawSource as ConnectSource;
  const rest = args.slice(1);
  const options = parseConnectOptions(rest);
  const secretStore = createDefaultSecretStore({
    env: {
      ...process.env,
      ...(options.secretStoreBackend ? { OLYMPUS_SECRET_STORE_BACKEND: options.secretStoreBackend } : {}),
    },
    paths: {
      ...(options.secretStorePath ? { encryptedFilePath: options.secretStorePath } : {}),
      ...(options.secretStoreKeyPath ? { keyFilePath: options.secretStoreKeyPath } : {}),
    },
  });
  if (source === 'google' || source === 'gmail' || source === 'google-drive' || source === 'dropbox' || source === 'x') {
    if (!options.clientId) throw new OperationError('invalid_params', '--client-id is required.');
    if (options.clientSecret) {
      throw new OperationError('invalid_params', '--client-secret is not supported; pipe the Google OAuth client secret with --client-secret-stdin so it is not exposed in shell history.');
    }
    const googleOAuthSource = source === 'google' || source === 'gmail' || source === 'google-drive';
    if (!googleOAuthSource && options.clientSecretStdin) {
      throw new OperationError('invalid_params', '--client-secret-stdin is only supported for Google OAuth sources.');
    }
    const clientSecret = options.clientSecretStdin ? await readApiKeyFromStdin() : undefined;
    if (options.detach) {
      return connectOAuthSourceDetached({
        source,
        clientId: options.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        ...(options.accountRole ? { accountRole: options.accountRole } : {}),
        ...(options.authUrl ? { authUrl: options.authUrl } : {}),
        ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
        ...(options.redirectPort ? { redirectPort: Number(options.redirectPort) } : {}),
        ...(options.oauthTimeoutMs
          ? {
            authorizationTimeoutMs: Number(options.oauthTimeoutMs),
            tokenExchangeTimeoutMs: Number(options.oauthTimeoutMs),
          }
          : {}),
        openBrowser: !options.noOpen,
        ...(options.registryPath ? { registryPath: options.registryPath } : {}),
        ...(options.oauthStateDir ? { stateDir: options.oauthStateDir } : {}),
        ...(options.oauthLogDir ? { logDir: options.oauthLogDir } : {}),
        ...(options.secretStoreBackend ? { secretStoreBackend: options.secretStoreBackend } : {}),
        ...(options.secretStorePath ? { secretStorePath: options.secretStorePath } : {}),
        ...(options.secretStoreKeyPath ? { secretStoreKeyPath: options.secretStoreKeyPath } : {}),
      });
    }
    return connectOAuthSource({
      source,
      clientId: options.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      ...(options.accountRole ? { accountRole: options.accountRole } : {}),
      ...(options.authUrl ? { authUrl: options.authUrl } : {}),
      ...(options.tokenUrl ? { tokenUrl: options.tokenUrl } : {}),
      ...(options.redirectPort ? { redirectPort: Number(options.redirectPort) } : {}),
      ...(options.oauthTimeoutMs
        ? {
          authorizationTimeoutMs: Number(options.oauthTimeoutMs),
          tokenExchangeTimeoutMs: Number(options.oauthTimeoutMs),
        }
        : {}),
      openBrowser: !options.noOpen,
      ...(options.registryPath ? { registryPath: options.registryPath } : {}),
      secretStore,
      onAuthorizationUrl: (url) => {
        console.error('Open this authorization URL to continue:');
        console.error(url);
      },
    });
  }
  if (source === 'telegram' || source === 'whatsapp') {
    if (!options.sessionPath) throw new OperationError('invalid_params', '--session-path is required.');
    return connectGuidedSession({
      source,
      sessionPath: options.sessionPath,
      ...(options.accountRole ? { accountRole: options.accountRole } : {}),
      ...(options.registryPath ? { registryPath: options.registryPath } : {}),
      secretStore,
      sessionReady: options.sessionReady,
    });
  }
  if (source === 'venice' || source === 'readwise') {
    if (!options.apiKeyStdin) {
      throw new OperationError('invalid_params', '--api-key-stdin is required so API keys are not exposed in shell history.');
    }
    return connectPublicApiKeySource({
      source,
      apiKey: await readApiKeyFromStdin(),
      ...(options.accountRole ? { accountRole: options.accountRole } : {}),
      ...(options.registryPath ? { registryPath: options.registryPath } : {}),
      secretStore,
    });
  }
  throw new OperationError('invalid_params', `Unsupported connect source: ${source}`);
}

function parseConnectOptions(args: string[]): {
  clientId?: string;
  clientSecret?: string;
  clientSecretStdin: boolean;
  accountRole?: string;
  authUrl?: string;
  tokenUrl?: string;
  redirectPort?: string;
  oauthTimeoutMs?: string;
  detach: boolean;
  noOpen: boolean;
  oauthStateDir?: string;
  oauthLogDir?: string;
  registryPath?: string;
  secretStoreBackend?: string;
  secretStorePath?: string;
  secretStoreKeyPath?: string;
  sessionPath?: string;
  sessionReady: boolean;
  apiKeyStdin: boolean;
} {
  const options = { detach: false, noOpen: false, sessionReady: false, apiKeyStdin: false, clientSecretStdin: false } as ReturnType<typeof parseConnectOptions>;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? arg.split(/=(.*)/s, 2)
      : [arg, undefined];
    const nextValue = (): string => {
      const value = inlineValue ?? args[index + 1];
      if (value === undefined) throw new OperationError('invalid_params', `Missing value for ${flag}.`);
      if (inlineValue === undefined) index += 1;
      return value;
    };
    switch (flag) {
      case '--client-id':
        options.clientId = nextValue();
        break;
      case '--client-secret':
        options.clientSecret = nextValue();
        break;
      case '--client-secret-stdin':
        options.clientSecretStdin = true;
        break;
      case '--account-role':
        options.accountRole = nextValue();
        break;
      case '--auth-url':
        options.authUrl = nextValue();
        break;
      case '--token-url':
        options.tokenUrl = nextValue();
        break;
      case '--redirect-port':
        options.redirectPort = nextValue();
        break;
      case '--oauth-timeout-ms':
        options.oauthTimeoutMs = nextValue();
        break;
      case '--detach':
        options.detach = true;
        break;
      case '--oauth-state-dir':
        options.oauthStateDir = nextValue();
        break;
      case '--oauth-log-dir':
        options.oauthLogDir = nextValue();
        break;
      case '--registry-path':
        options.registryPath = nextValue();
        break;
      case '--secret-store-backend':
        options.secretStoreBackend = nextValue();
        break;
      case '--secret-store-path':
        options.secretStorePath = nextValue();
        break;
      case '--secret-store-key-path':
        options.secretStoreKeyPath = nextValue();
        break;
      case '--session-path':
        options.sessionPath = nextValue();
        break;
      case '--session-ready':
        options.sessionReady = true;
        break;
      case '--api-key-stdin':
        options.apiKeyStdin = true;
        break;
      case '--no-open':
        options.noOpen = true;
        break;
      default:
        throw new OperationError('invalid_params', `Unknown connect option: ${arg}`);
    }
  }
  return options;
}

/** The supervised worker state delete custody reads, or `unknown` if unreadable. */
function observedWorkerServiceState(): WorkerServiceState {
  const lifecycleStatus = runWorkerLifecycle('status');
  return lifecycleStatus.action === 'status' ? lifecycleStatus.service.state : 'unknown';
}

async function runDataCommand(args: string[]): Promise<unknown> {
  const command = args[0];
  if (command === 'export') {
    const options = parseDataOptions(args.slice(1));
    return exportOlympusData({
      destination: options.output,
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    });
  }
  if (command === 'verify') {
    const options = parseDataOptions(args.slice(1));
    return verifyOlympusDataExport({ destination: options.input });
  }
  if (command === 'delete') {
    const options = parseDataOptions(args.slice(1));
    if (options.all && !options.yesIAMSure && options.dryRun !== true) {
      await confirmDeleteAll();
    }
    // Custody decides the precondition; the CLI only reports what it observes.
    // A public source is gated on Disconnect and ignores this, but a source
    // with no public capability falls through to the worker-inactive
    // requirement, which is unsatisfiable unless the observed state is passed
    // in — the delete was refused at every worker state without it.
    const workerState = observedWorkerServiceState();
    if (options.sourceId) {
      const sourceId = options.sourceId;
      const registryPath = handleRegistryPathFromEnv(process.env, true)!;
      return withConnectedHandleGrantCustody(registryPath, {}, async () =>
        deleteOlympusDataWithCustody({
          sourceId,
          dryRun: options.dryRun,
          connectedRegistry: readConnectedHandleRegistry(registryPath),
          workerState,
        })
      );
    }
    return deleteOlympusDataWithCustody({
      all: options.all,
      dryRun: options.dryRun,
      workerState,
    });
  }
  if (command === '--help' || command === '-h') {
    console.log('Usage: olympus data export --output <dir> [--source <id>]\n       olympus data verify --input <dir>\n       olympus data delete --all|--source <id> [--dry-run] [--yes-i-am-sure]');
    process.exit(0);
  }
  throw new OperationError('invalid_params', `Unknown data command: ${command ?? ''}`.trim());
}

function parseDataOptions(args: string[]): {
  output: string;
  input: string;
  sourceId: string | undefined;
  all: boolean;
  dryRun: boolean;
  yesIAMSure: boolean;
} {
  let outputPath = '';
  let inputPath = '';
  let sourceId: string | undefined;
  let all = false;
  let dryRun = false;
  let yesIAMSure = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output') {
      outputPath = requireOptionValue(args, (index += 1), arg);
    } else if (arg?.startsWith('--output=')) {
      outputPath = arg.slice('--output='.length);
    } else if (arg === '--input') {
      inputPath = requireOptionValue(args, (index += 1), arg);
    } else if (arg?.startsWith('--input=')) {
      inputPath = arg.slice('--input='.length);
    } else if (arg === '--source') {
      sourceId = requireOptionValue(args, (index += 1), arg);
    } else if (arg?.startsWith('--source=')) {
      sourceId = arg.slice('--source='.length);
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--yes-i-am-sure') {
      yesIAMSure = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: olympus data export --output <dir> [--source <id>]\n       olympus data verify --input <dir>\n       olympus data delete --all|--source <id> [--dry-run] [--yes-i-am-sure]');
      process.exit(0);
    } else {
      throw new OperationError('invalid_params', `Unknown data option: ${arg}`);
    }
  }
  return { output: outputPath, input: inputPath, sourceId, all, dryRun, yesIAMSure };
}

function parseSensitivityValidateArgs(args: string[]): { path?: string } {
  const options: { path?: string } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--path') {
      options.path = requireOptionValue(args, (index += 1), arg);
    } else if (arg?.startsWith('--path=')) {
      options.path = arg.slice('--path='.length);
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: olympus sensitivity validate [--path <path>]');
      process.exit(0);
    } else {
      throw new OperationError('invalid_params', `Unknown sensitivity validate option: ${arg}`);
    }
  }
  return options;
}

async function confirmDeleteAll(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new OperationError(
      'invalid_params',
      'olympus data delete --all requires interactive confirmation.',
      'Run from a terminal and complete both prompts, or use --yes-i-am-sure for automated tests.',
    );
  }
  const prompts = deleteAllConfirmationPrompts();
  const rl = createInterface({ input, output });
  try {
    const first = await rl.question(`Type "${prompts.first}" to delete all Olympus data: `);
    const second = await rl.question(`Type "${prompts.second}" to confirm permanent deletion: `);
    validateDeleteAllConfirmations(first, second);
  } finally {
    rl.close();
  }
}

function requireOptionValue(args: string[], index: number, optionName: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new OperationError('invalid_params', `${optionName} requires a value.`);
  return value;
}


/** The worker auth token from config or worker.env, or a clear refusal. */
export function runDashboardTokenCommand(env: Record<string, string | undefined> = process.env): string {
  // The worker authenticates from ITS process environment, which the service
  // loads from worker.env — so that file outranks a token remembered in a
  // legacy config file, and an explicit environment variable outranks both.
  // Printing the config's token when worker.env holds a newer one would hand
  // the reader a token the worker refuses.
  const token = normalizeWorkerAuthToken(env.OLYMPUS_WORKER_AUTH_TOKEN)
    ?? workerAuthTokenFromSetupEnv({ env })
    ?? normalizeWorkerAuthToken(loadConfig().worker.authToken);
  if (!token) {
    throw new OperationError(
      'config_error',
      'No worker auth token is configured. Run olympus setup first; the token is written to worker.env as OLYMPUS_WORKER_AUTH_TOKEN.',
    );
  }
  return token;
}

function runDashboardCommand(): { url: string; opened: boolean; hint?: string } {
  const config = loadConfig();
  const base = config.email.baseUrl.replace(/\/v1\/?$/, '');
  const token = workerAuthTokenFromConfig(config);
  const url = `${base}/dashboard`;
  const dashboardToken = dashboardQueryTokenFromWorkerAuthToken(token);
  const openUrl = dashboardToken ? `${url}?token=${encodeURIComponent(dashboardToken)}` : url;
  let opened = false;
  try {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = Bun.spawnSync([opener, openUrl], { stdout: 'ignore', stderr: 'ignore' });
    opened = child.exitCode === 0;
  } catch {
    opened = false;
  }
  return {
    url,
    opened,
    ...(dashboardToken ? { auth: 'dashboard_query_token_used_for_browser_open' } : { hint: 'No worker auth token found; if the worker enforces one, run olympus setup first.' }),
  };
}

if (import.meta.main) {
  main().catch((error) => {
    for (const line of formatCliFatalError(error)) console.error(line);
    process.exit(1);
  });
}

export function formatCliFatalError(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== 'object') return [message];
  const candidate = error as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown };
  if (
    typeof candidate.code !== 'string'
    || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(candidate.code)
  ) return [message];
  const lines = [`Error [${candidate.code}]: ${message}`];
  if (
    candidate.retryable === true
    && typeof candidate.retryAfterMs === 'number'
    && Number.isSafeInteger(candidate.retryAfterMs)
    && candidate.retryAfterMs > 0
  ) {
    lines.push(`Retryable: retry after ${Math.ceil(candidate.retryAfterMs / 1_000)} seconds.`);
  } else if (candidate.retryable === true) {
    lines.push('Retryable: retry the operation after the transient condition clears.');
  }
  return lines;
}
