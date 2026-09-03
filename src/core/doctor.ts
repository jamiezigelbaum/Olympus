// Olympus doctor: a read-only health walk across the chain the calling assistant depends on
// (Argus local model lanes, the private email source worker, and the source
// index), reported in plain language so an operator can see what is broken
// without manual archaeology. It touches no secrets and reads no credentials;
// every check returns statuses and counts only — never tokens, source text,
// or packets. Each check is isolated, and runDoctor itself never throws.

import { parseOptionalBooleanEnv, type ArgusLane, type ArgusModelProfile, type OlympusConfig } from './config.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DelphiClient } from './delphi.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from './worker-auth.ts';
import {
  loadSovereigntyEngine,
  type SovereigntyEngine,
} from './sovereignty.ts';
import { setupPreflight } from './setup-preflight.ts';
import type { SecretStore } from './secret-store.ts';
import {
  readConnectedHandleRegistry,
  type ConnectedHandleRegistry,
} from '../workers/credential-broker/connected-handles.ts';
import { listDetachedOAuthStates } from './connect.ts';
import { buildSourceIngestionLedgerSnapshot, type SourceIngestionLedgerSnapshot } from '../workers/source-ingestion-ledger.ts';
import type { SourceSchedulerStatus } from '../workers/source-scheduler.ts';
import { defaultSourceDashboardHistoryDbPath } from '../workers/source-dashboard.ts';
import type { SourceIndexStatusResult } from '../workers/source-index/status.ts';
import {
  assessContentExtractionThroughput,
  dropboxContentExtractionStallHours,
  type ContentExtractionThroughputSignal,
} from './ingestion-throughput.ts';
import {
  V0_4_PUBLIC_SOURCE_CAPABILITIES,
  publicSourceDoctorLanes,
} from './public-source-capabilities.ts';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorDeps {
  config: OlympusConfig;
  delphi: Pick<DelphiClient, 'listModels' | 'listModelsForProfile' | 'complete'>;
  fetchImpl?: typeof fetch;
  commandExists?: (command: string) => boolean | Promise<boolean>;
  pythonModuleExists?: (pythonCommand: string, moduleName: string) => boolean | Promise<boolean>;
  handleRegistry?: ConnectedHandleRegistry;
  readHandleRegistry?: () => ConnectedHandleRegistry;
  sovereigntyEngine?: SovereigntyEngine;
  env?: Record<string, string | undefined>;
  secretStore?: Pick<SecretStore, 'get' | 'getSync'>;
  now?: () => Date;
  oauthStateDir?: string;
  oauthPidAlive?: (pid: number) => boolean;
  ingestionHealthStatePath?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

const ARGUS_LANE_HINT = 'Check the configured local model service and rerun olympus doctor.';
const EMAIL_WORKER_HINT = 'Run olympus worker status, then olympus worker start or olympus worker install.';
const SOURCE_INDEX_HINT = 'Run olympus source index status, then use Sync now in the dashboard or check the worker logs.';
const SCHEDULER_HINT = 'Run olympus worker status and olympus source index status; restart the worker if the scheduler is not running.';
const CREDENTIAL_HINT = 'Run the matching olympus connect command again for each handle that needs reauthorization.';

const STALE_RUNNING_SYNC_MS = 24 * 60 * 60 * 1000;
const EMBEDDING_LAG_RATIO = 0.1;
const DROPBOX_FILES_CORPUS_ID = 'secure_local.dropbox.files';
const ARGUS_GENERATION_PROBE_TIMEOUT_MS = 15_000;
const INGESTION_STUCK_WARNING_HOURS = 24;
const INGESTION_STUCK_ERROR_HOURS = 72;
const INGESTION_TERMINAL_FAILURE_DELTA_WARNING = 10;
const CONNECTED_SOURCE_LANES = publicSourceDoctorLanes();

export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  const checks = [
    await safeCheck('dependencies', () => dependencyCheck(deps)),
    await safeCheck('source_capability_catalog', () => sourceCapabilityCatalogCheck(deps)),
    await safeCheck('sovereignty_prerequisites', () => sovereigntyPrerequisiteCheck(deps)),
    await safeCheck('credential_handles', () => credentialHandleCheck(deps)),
    await safeCheck('detached_oauth_connections', () => detachedOAuthConnectionCheck(deps)),
    await safeCheck('google_oauth_refresh_lifetime', () => googleOAuthRefreshLifetimeCheck(deps)),
    await safeCheck('credential_reauthorization_backlog', () => credentialReauthorizationBacklogCheck(deps)),
    await safeCheck('argus_model_pool', () => argusProfileCheck(deps, deps.config.argus.defaultProfile)),
    await safeCheck('sovereignty_model_lanes', () => sovereigntyModelLaneCheck(deps)),
    await safeCheck('email_worker', () => emailWorkerCheck(deps)),
    await safeCheck('worker_credential_lanes', () => workerCredentialLanesCheck(deps)),
    await safeCheck('dropbox_content_extraction_throughput', () => dropboxContentExtractionThroughputCheck(deps)),
    await safeCheck('source_index_status', () => sourceIndexStatusCheck(deps)),
    await safeCheck('source_scheduler_status', () => sourceSchedulerStatusCheck(deps)),
    await safeCheck('source_ingestion_health', () => sourceIngestionHealthCheck(deps)),
  ];
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

async function sourceCapabilityCatalogCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const registry = deps.handleRegistry ?? readRegistrySafely(deps);
  const connectedProviders = new Set(
    registry.handles
      .filter((handle) => handle.backendState?.status !== 'reauth_required')
      .map((handle) => handle.provider),
  );
  const connected = V0_4_PUBLIC_SOURCE_CAPABILITIES
    .filter((source) => connectedProviders.has(source.doctor_lane.provider));
  const dependencyLabels = [...new Set(connected.flatMap((source) =>
    source.dependencies.map((dependency) => dependency.label)))].sort((a, b) => a.localeCompare(b));
  return {
    name: 'source_capability_catalog',
    ok: true,
    detail: `Public source catalog declares ${V0_4_PUBLIC_SOURCE_CAPABILITIES.length} sources; ${connected.length} connected. Source-conditioned dependencies for connected sources: ${dependencyLabels.join(', ') || 'none until a source is connected'}.`,
  };
}

async function safeCheck(name: string, run: () => Promise<DoctorCheck>): Promise<DoctorCheck> {
  try {
    return await run();
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Check failed unexpectedly: ${errorDetail(error)}`,
    };
  }
}

async function argusProfileCheck(deps: DoctorDeps, profile: ArgusModelProfile): Promise<DoctorCheck> {
  const name = 'argus_model_pool';
  const profileConfig = deps.config.argus.modelProfiles[profile];
  // Posture decides whether a local Argus pool is even expected.
  const hasSovereigntyPolicy = Boolean(
    deps.sovereigntyEngine || deps.config.sovereignty?.policy || deps.config.sovereignty?.configPath,
  );
  // A fresh install has not chosen a posture yet, so it declares no local
  // lane. Probing the default loopback endpoint would report a scary
  // "unreachable at 127.0.0.1:8000" before setup has run — never assume
  // local before the operator picks how sensitive data is handled.
  if (!hasSovereigntyPolicy) {
    return {
      name,
      ok: true,
      detail: 'Skipped: no sovereignty posture configured yet. Run olympus setup to choose how sensitive data is handled.',
    };
  }
  // A posture with no local model lane (e.g. private-cloud-only) must not
  // demand a local Argus pool.
  {
    const engine = deps.sovereigntyEngine ?? loadSovereigntyEngine({
      ...(deps.config.sovereignty?.policy ? { inlineConfig: deps.config.sovereignty.policy } : {}),
      ...(deps.config.sovereignty?.configPath ? { configPath: deps.config.sovereignty.configPath } : {}),
    });
    const profiles = Object.values(engine.config.modelProfiles);
    const hasLocalLane = profiles
      .some((p) => p.provider === 'local-openai-compatible');
    if (!hasLocalLane) {
      const hasVeniceLane = profiles.some((profile) => profile.provider === 'venice');
      return {
        name,
        ok: true,
        detail: hasVeniceLane
          ? 'Skipped: the active sovereignty posture configures no local model lane. In v0.4, secure answers use the ordinary Venice API with a live-catalog Private or plain TEE model. Olympus does not provide or qualify E2EE out of the box; custom integrations are user-owned, and secure corpora remain lexical-only.'
          : 'Skipped: the active sovereignty posture configures no local model lane.',
      };
    }
  }
  try {
    const models = await deps.delphi.listModelsForProfile(profile);
    await deps.delphi.complete({
      profile,
      prompt: 'Reply exactly: OLYMPUS_DOCTOR_OK',
      temperature: 0,
      maxTokens: 16,
      requestTimeoutMs: ARGUS_GENERATION_PROBE_TIMEOUT_MS,
    });
    return {
      name,
      ok: true,
      detail: `Argus model pool is reachable at ${profileConfig.baseUrl}; default profile ${profile} uses ${profileConfig.model}, ${models.length} model${models.length === 1 ? '' : 's'} are listed, and a bounded generation probe passed.`,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Argus model pool is not healthy at ${profileConfig.baseUrl}: ${errorDetail(error)}`,
      hint: ARGUS_LANE_HINT,
    };
  }
}

async function argusLaneCheck(deps: DoctorDeps, lane: ArgusLane): Promise<DoctorCheck> {
  const name = `argus_${lane}_lane`;
  const baseUrl = deps.config.argus.lanes[lane].baseUrl;
  try {
    const models = await deps.delphi.listModels(lane);
    await deps.delphi.complete({
      lane,
      prompt: 'Reply exactly: OLYMPUS_DOCTOR_OK',
      temperature: 0,
      maxTokens: 16,
      requestTimeoutMs: ARGUS_GENERATION_PROBE_TIMEOUT_MS,
    });
    return {
      name,
      ok: true,
      detail: `Argus ${lane} lane is reachable at ${baseUrl} with ${models.length} model${models.length === 1 ? '' : 's'} and passed a bounded generation probe.`,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Argus ${lane} lane is not healthy at ${baseUrl}: ${errorDetail(error)}`,
      hint: ARGUS_LANE_HINT,
    };
  }
}

async function dependencyCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const commandExists = deps.commandExists ?? defaultCommandExists;
  const bun = await commandExists('bun');
  const node = await commandExists('node');
  const gog = await commandExists('gog');
  const op = await commandExists('op');
  const python3 = await commandExists('python3');
  const python = python3 ? false : await commandExists('python');
  const pythonCommand = python3 ? 'python3' : python ? 'python' : undefined;
  const telethon = Boolean(pythonCommand && await (deps.pythonModuleExists ?? defaultPythonModuleExists)(pythonCommand, 'telethon'));
  const go = await commandExists('go');
  const missingRequired = [
    bun ? undefined : 'bun',
    node ? undefined : 'node',
  ].filter((value): value is string => !!value);
  const optionalMissing = [
    gog ? undefined : 'gog',
    op ? undefined : 'op',
    telethon ? undefined : 'python-telethon',
    go ? undefined : 'go',
  ].filter((value): value is string => !!value);
  if (missingRequired.length > 0) {
    return {
      name: 'dependencies',
      ok: false,
      detail: `Missing required dependency: ${missingRequired.join(', ')}. Optional dependency gaps: ${optionalMissing.join(', ') || 'none'}.`,
      hint: 'Install Bun from https://bun.sh/docs/installation and Node.js from https://nodejs.org/; optional source helpers can be installed later.',
    };
  }
  return {
    name: 'dependencies',
    ok: true,
    detail: `Required dependencies are present. Optional dependency gaps: ${optionalMissing.join(', ') || 'none'}.`,
  };
}

async function sovereigntyModelLaneCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  if (!deps.sovereigntyEngine && !deps.config.sovereignty?.policy && !deps.config.sovereignty?.configPath) {
    return {
      name: 'sovereignty_model_lanes',
      ok: true,
      detail: 'Skipped: no explicit sovereignty policy is configured for lane probing.',
    };
  }
  const engine = deps.sovereigntyEngine ?? loadSovereigntyEngine({
    ...(deps.config.sovereignty?.policy ? { inlineConfig: deps.config.sovereignty.policy } : {}),
    ...(deps.config.sovereignty?.configPath ? { configPath: deps.config.sovereignty.configPath } : {}),
  });
  const fetchImpl = deps.fetchImpl ?? fetch;
  const profiles = Object.entries(engine.config.modelProfiles)
    .filter(([, profile]) => profile.provider === 'local-openai-compatible' && profile.baseUrl);
  if (profiles.length === 0) {
    return {
      name: 'sovereignty_model_lanes',
      ok: true,
      detail: 'No local HTTP sovereignty model lanes are configured for a direct reachability probe.',
    };
  }
  const problems: string[] = [];
  for (const [profileId, profile] of profiles) {
    const baseUrl = profile.baseUrl!;
    const modelsUrl = `${baseUrl.replace(/\/$/, '')}/models`;
    try {
      const response = await fetchImpl(modelsUrl, { method: 'GET' });
      if (!response.ok) problems.push(`${profileId} at ${modelsUrl} returned HTTP ${response.status}`);
    } catch (error) {
      problems.push(`${profileId} at ${modelsUrl} failed: ${errorDetail(error)}`);
    }
  }
  if (problems.length > 0) {
    return {
      name: 'sovereignty_model_lanes',
      ok: false,
      detail: `Configured model lane reachability failed: ${problems.join('; ')}.`,
      hint: 'Start the configured local model service or update sovereignty.json with a reachable profile URL.',
    };
  }
  return {
    name: 'sovereignty_model_lanes',
    ok: true,
    detail: `Configured local sovereignty model lanes are reachable (${profiles.length} profile${profiles.length === 1 ? '' : 's'} checked).`,
  };
}

async function sovereigntyPrerequisiteCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  if (!deps.sovereigntyEngine && !deps.config.sovereignty?.policy && !deps.config.sovereignty?.configPath) {
    return {
      name: 'sovereignty_prerequisites',
      ok: true,
      detail: 'Skipped: no explicit sovereignty policy is configured for prerequisite checks.',
    };
  }
  const engine = deps.sovereigntyEngine ?? loadSovereigntyEngine({
    ...(deps.config.sovereignty?.policy ? { inlineConfig: deps.config.sovereignty.policy } : {}),
    ...(deps.config.sovereignty?.configPath ? { configPath: deps.config.sovereignty.configPath } : {}),
  });
  // Setup's preflight declares a local model server unmet without probing it,
  // because the wizard must not make network calls. Doctor may, and
  // sovereignty_model_lanes below probes exactly those lanes behind the
  // identical gate — so repeating them here reports a running server as a
  // failure and leaves this check permanently red on every local posture.
  const unmet = (await setupPreflight({
    config: engine.config,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.secretStore ? { secretStore: deps.secretStore } : {}),
  })).filter((item) => item.kind !== 'local_model_server');
  if (unmet.length === 0) {
    return {
      name: 'sovereignty_prerequisites',
      ok: true,
      detail: 'Sovereignty preset prerequisites are present.',
    };
  }
  return {
    name: 'sovereignty_prerequisites',
    ok: false,
    detail: `Sovereignty preset has ${unmet.length} unmet prerequisite${unmet.length === 1 ? '' : 's'}: ${unmet.map((item) => item.detail).join('; ')}.`,
    hint: unmet.map((item) => item.remedy).join('\n'),
  };
}

async function emailWorkerCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'email_worker';
  const baseUrl = deps.config.email.baseUrl;
  if (!deps.config.email.enabled) {
    return {
      name,
      ok: true,
      detail: 'Skipped: the private email worker is disabled in config (email.enabled=false).',
    };
  }

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/health`, workerRequestInit(deps));
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Email worker is not reachable at ${baseUrl}: ${errorDetail(error)}`,
      hint: EMAIL_WORKER_HINT,
    };
  }
  if (!response.ok) {
    return {
      name,
      ok: false,
      detail: `Email worker /health at ${baseUrl} returned HTTP ${response.status}.`,
      hint: EMAIL_WORKER_HINT,
    };
  }

  const health = asRecord(await response.json());
  const configured = typeof health.configured === 'boolean' ? health.configured : true;
  const degradedCredentials = degradedCredentialDetails(health);
  if (degradedCredentials.length > 0) {
    return {
      name,
      ok: false,
      detail: `Email worker is running in degraded mode: ${degradedCredentials.join('; ')}.`,
      hint: 'Fix the listed credential, then restart the Olympus worker or POST /v1/source/credentials/recheck.',
    };
  }
  return {
    name,
    ok: configured,
    detail: `Email worker at ${baseUrl} answered /health (reachable=true configured=${configured}).`,
    ...(configured
      ? {}
      : { hint: 'The worker is running but reports configured=false; check its connector configuration.' }),
  };
}

async function sourceIndexStatusCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'source_index_status';
  const baseUrl = deps.config.email.baseUrl;
  if (!deps.config.email.enabled) {
    return {
      name,
      ok: true,
      detail: 'Skipped: the private email worker is disabled, so the source index status surface was not checked.',
    };
  }

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/source/index/status`, workerRequestInit(deps));
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Source index status is not reachable at ${baseUrl}: ${errorDetail(error)}`,
      hint: EMAIL_WORKER_HINT,
    };
  }
  if (!response.ok) {
    return {
      name,
      ok: false,
      detail: `Source index status at ${baseUrl} returned HTTP ${response.status}.`,
      hint: EMAIL_WORKER_HINT,
    };
  }

  const status = asRecord(await response.json());
  const degradedCredentials = degradedCredentialDetails(status);
  const corpora = doctorVisibleCorpora(deps, Array.isArray(status.corpora) ? status.corpora : []);
  const problems: string[] = [];
  const summaries: string[] = [];
  const informational: string[] = [];
  const connectedCorpusIds = connectedSourceCorpusIds(deps);

  for (const entry of corpora) {
    const corpus = asRecord(entry);
    const corpusId = typeof corpus.corpus_id === 'string' ? corpus.corpus_id : 'unknown_corpus';
    if (!connectedCorpusIds.has(corpusId)) {
      informational.push(`${corpusId} not connected — optional`);
      continue;
    }
    if (!hasSyncRecord(corpus)) {
      informational.push(`${corpusId} connected — first sync pending`);
      continue;
    }
    const staleSync = staleRunningSync(corpus);
    if (staleSync) {
      problems.push(`${corpusId} sync run ${staleSync.syncRunId} has been running since ${staleSync.startedAt} (older than 24h)`);
    }
    const counts = asRecord(corpus.counts);
    const embeddingParity = asRecord(corpus.embedding_parity);
    const embeddingRequired = corpus.embedding_policy !== 'disabled'
      && embeddingParity.required !== false;
    const chunks = typeof embeddingParity.chunks === 'number'
      ? asCount(embeddingParity.chunks)
      : asCount(counts.chunks);
    const embedded = typeof embeddingParity.embedded_chunks === 'number'
      ? asCount(embeddingParity.embedded_chunks)
      : asCount(counts.embedded_chunks);
    const embeddingLag = Math.max(chunks - embedded, 0);
    if (chunks > 0 || embedded > 0) {
      summaries.push(embeddingRequired
        ? `${corpusId}: connector store, ${chunks} chunks, ${embedded} embedded (lag ${embeddingLag})`
        : `${corpusId}: connector store, ${chunks} chunks, embeddings disabled`);
    }
    if (embeddingRequired && chunks > 0 && embeddingLag > chunks * EMBEDDING_LAG_RATIO) {
      problems.push(`${corpusId} embedding lag is ${embeddingLag} of ${chunks} chunks (over 10%)`);
    }
  }

  const summary = summaries.length > 0 ? ` ${summaries.join('; ')}.` : '';
  const info = informational.length > 0 ? ` Informational: ${informational.join('; ')}.` : '';
  if (degradedCredentials.length > 0) {
    problems.push(...degradedCredentials);
  }
  if (problems.length > 0) {
    return {
      name,
      ok: false,
      detail: `Source index reported ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.join('; ')}.${summary}${info}`,
      hint: SOURCE_INDEX_HINT,
    };
  }
  return {
    name,
    ok: true,
    detail: `Source index status is healthy across ${corpora.length} corpus report${corpora.length === 1 ? '' : 's'}.${summary}${info}`,
  };
}

async function workerCredentialLanesCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'worker_credential_lanes';
  const baseUrl = deps.config.email.baseUrl;
  if (!deps.config.sourceIndex.enabled) {
    return {
      name,
      ok: true,
      detail: 'Skipped: sourceIndex.enabled=false, so worker credential lanes are deliberately off.',
    };
  }

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/source/index/status`, workerRequestInit(deps));
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Worker credential lane status is not reachable at ${baseUrl} while sourceIndex.enabled=true: ${errorDetail(error)}`,
      hint: EMAIL_WORKER_HINT,
    };
  }
  if (!response.ok) {
    return {
      name,
      ok: false,
      detail: `Worker credential lane status at ${baseUrl} returned HTTP ${response.status} while sourceIndex.enabled=true.`,
      hint: EMAIL_WORKER_HINT,
    };
  }

  const status = asRecord(await response.json());
  const degradedCredentials = degradedCredentialDetails(status, { onlyFailingStates: true });
  if (degradedCredentials.length > 0) {
    return {
      name,
      ok: false,
      detail: `Worker credential lanes are degraded: ${degradedCredentials.join('; ')}.`,
      hint: 'Fix the listed credential, then POST /v1/source/credentials/recheck with the worker bearer token; if it reports resolved_restart_required, restart the Olympus worker.',
    };
  }
  return {
    name,
    ok: true,
    detail: 'Worker credential lanes are healthy; no degraded credentials reported by source status.',
  };
}

async function dropboxContentExtractionThroughputCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'dropbox_content_extraction_throughput';
  const baseUrl = deps.config.email.baseUrl;
  if (!deps.config.sourceIndex.enabled) {
    return {
      name,
      ok: true,
      detail: 'Skipped: sourceIndex.enabled=false, so Dropbox content extraction is deliberately off.',
    };
  }

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(
      `${baseUrl}/source/index/status?include_ingestion_ledger=true&include_readiness_ledger=true&include_items=false`,
      workerRequestInit(deps),
    );
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Dropbox content extraction throughput is not reachable at ${baseUrl}: ${errorDetail(error)}`,
      hint: EMAIL_WORKER_HINT,
    };
  }
  if (!response.ok) {
    return {
      name,
      ok: false,
      detail: `Dropbox content extraction throughput at ${baseUrl} returned HTTP ${response.status}.`,
      hint: EMAIL_WORKER_HINT,
    };
  }

  const status = asRecord(await response.json());
  const ledger = sourceIngestionLedgerFromStatus(status);
  const dropbox = ledger?.rows.find((row) => row.source_id === 'dropbox');
  if (!dropbox?.configured) {
    return {
      name,
      ok: true,
      detail: 'Skipped: the Dropbox source index is not configured.',
    };
  }
  const signal = contentExtractionThroughputSignal(dropbox.ingestion_health.content_extraction_throughput);
  if (!signal) {
    const corpus = (Array.isArray(status.corpora) ? status.corpora : [])
      .map((entry) => asRecord(entry))
      .find((entry) => entry.corpus_id === DROPBOX_FILES_CORPUS_ID);
    const counts = asRecord(corpus?.counts);
    const actionable = asCount(counts.extraction_jobs_queued_actionable);
    if (actionable === 0) {
      return {
        name,
        ok: true,
        detail: 'Dropbox content extraction throughput is healthy: no actionable queued work is reported.',
      };
    }
    return {
      name,
      ok: false,
      detail: `Dropbox content extraction throughput is unknown for ${actionable} actionable job(s) because the worker did not report terminal-progress timing.`,
      hint: 'Refresh the installed Olympus worker, then rerun olympus doctor.',
    };
  }

  const assessment = assessContentExtractionThroughput(signal, {
    now: deps.now?.() ?? new Date(),
    thresholdHours: dropboxContentExtractionStallHours(deps.env),
  });
  if (assessment.state === 'idle') {
    return {
      name,
      ok: true,
      detail: 'Dropbox content extraction throughput is healthy: no actionable queued or retryable-due jobs.',
    };
  }
  const hours = assessment.hours_without_terminal_progress;
  if (assessment.state === 'stalled') {
    return {
      name,
      ok: false,
      detail: `Dropbox content extraction is stalled: ${assessment.actionable} actionable queued/retryable-due job(s), with no terminal progress for ${hours}h (>=${assessment.threshold_hours}h).`,
      hint: 'Check the Dropbox source-processing supervisor and worker logs, then rerun olympus doctor after extraction resumes.',
    };
  }
  if (assessment.state === 'warning') {
    return {
      name,
      ok: true,
      detail: `Dropbox content extraction throughput WARNING: ${assessment.actionable} actionable queued/retryable-due job(s), with no terminal progress for ${hours}h (warning at half of ${assessment.threshold_hours}h).`,
    };
  }
  if (assessment.state === 'unknown') {
    return {
      name,
      ok: true,
      detail: `Dropbox content extraction throughput WARNING: ${assessment.actionable} actionable queued/retryable-due job(s), but terminal-progress age is unknown.`,
    };
  }
  return {
    name,
    ok: true,
    detail: `Dropbox content extraction throughput is healthy: ${assessment.actionable} actionable queued/retryable-due job(s), with terminal progress ${hours}h ago (<${assessment.threshold_hours}h).`,
  };
}

function contentExtractionThroughputSignal(value: unknown): ContentExtractionThroughputSignal | undefined {
  const record = asRecord(value);
  if (!('actionable_queued' in record) || !('actionable_retryable_due' in record)) return undefined;
  return {
    actionable_queued: asCount(record.actionable_queued),
    actionable_retryable_due: asCount(record.actionable_retryable_due),
    ...(typeof record.oldest_actionable_at === 'string' ? { oldest_actionable_at: record.oldest_actionable_at } : {}),
    ...(typeof record.newest_terminal_progress_at === 'string'
      ? { newest_terminal_progress_at: record.newest_terminal_progress_at }
      : {}),
  };
}

function degradedCredentialDetails(
  record: Record<string, unknown>,
  options: { onlyFailingStates?: boolean } = {},
): string[] {
  const credentials = Array.isArray(record.degraded_credentials) ? record.degraded_credentials : [];
  return credentials.flatMap((entry) => {
    const credential = asRecord(entry);
    const state = typeof credential.state === 'string' ? credential.state : undefined;
    if (options.onlyFailingStates && !isFailingCredentialState(state)) return [];
    const displayName = typeof credential.display_name === 'string' ? credential.display_name : 'configured credential';
    const message = typeof credential.status_label === 'string' ? credential.status_label : 'credential unavailable - needs your attention';
    const hint = typeof credential.hint === 'string' ? credential.hint : 'fix the credential and re-check';
    const capabilities = Array.isArray(credential.affected_capabilities)
      ? credential.affected_capabilities.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const capabilityDetail = capabilities.length > 0 ? ` affected capabilities: ${capabilities.join(',')};` : '';
    const stateDetail = state ? ` state=${state};` : '';
    return [`${displayName}:${stateDetail}${capabilityDetail} ${message}; ${hint}`];
  });
}

function isFailingCredentialState(state: string | undefined): boolean {
  return state === 'retrying' || state === 'stopped' || state === 'resolved_restart_required';
}

async function sourceSchedulerStatusCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'source_scheduler_status';
  const baseUrl = deps.config.email.baseUrl;
  if (!deps.config.email.enabled) {
    return {
      name,
      ok: true,
      detail: 'Skipped: the private source worker is disabled, so scheduler status was not checked.',
    };
  }
  if (deps.config.worker.scheduler.enabled !== true) {
    return {
      name,
      ok: true,
      detail: 'Skipped: the in-process source scheduler is disabled in config.',
    };
  }
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/source/scheduler/status`, workerRequestInit(deps));
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `Source scheduler status is not reachable at ${baseUrl}: ${errorDetail(error)}`,
      hint: SCHEDULER_HINT,
    };
  }
  if (!response.ok) {
    return {
      name,
      ok: false,
      detail: `Source scheduler status at ${baseUrl} returned HTTP ${response.status}.`,
      hint: SCHEDULER_HINT,
    };
  }
  const status = asRecord(await response.json());
  const problems: string[] = [];
  if (status.enabled !== true) problems.push('scheduler is not enabled');
  if (status.running !== true) problems.push('scheduler is not running');
  const sources = Array.isArray(status.sources) ? status.sources : [];
  const reportedSelectedSourceIds = Array.isArray(status.selected_source_ids)
    ? status.selected_source_ids.filter((value): value is string => typeof value === 'string')
    : [];
  const selectionContractActive = Array.isArray(status.selected_source_ids)
    || deps.config.worker.scheduler.sourceIds.length > 0;
  const configuredSelectedSourceIds = new Set(deps.config.worker.scheduler.sourceIds);
  if (selectionContractActive) {
    const reported = new Set(reportedSelectedSourceIds);
    for (const sourceId of configuredSelectedSourceIds) {
      if (!reported.has(sourceId)) problems.push(`configured scheduler source ${sourceId} is missing from worker selection`);
    }
    for (const sourceId of reported) {
      if (!configuredSelectedSourceIds.has(sourceId)) problems.push(`worker selected unexpected scheduler source ${sourceId}`);
    }
  }
  const missingSelectedSourceIds = Array.isArray(status.missing_selected_source_ids)
    ? status.missing_selected_source_ids.filter((value): value is string => typeof value === 'string')
    : [];
  for (const sourceId of missingSelectedSourceIds) {
    problems.push(`selected scheduler source ${sourceId} is not registered`);
  }
  const schedulerSourceIds = new Set<string>();
  const schedulerCorpusIds = new Set<string>();
  for (const entry of sources) {
    const source = asRecord(entry);
    const sourceId = typeof source.source_id === 'string' ? source.source_id : 'unknown_source';
    if (typeof source.source_id === 'string') schedulerSourceIds.add(source.source_id);
    if (typeof source.corpus_id === 'string') schedulerCorpusIds.add(source.corpus_id);
    if (source.stale_sync_anomaly === true) problems.push(`${sourceId} is past its freshness threshold`);
    const tasks = Array.isArray(source.tasks) ? source.tasks : [];
    for (const taskEntry of tasks) {
      const task = asRecord(taskEntry);
      const taskId = typeof task.id === 'string' ? task.id : 'unknown_task';
      const failures = asCount(task.consecutive_failures);
      if (task.stale_anomaly === true) {
        problems.push(`${sourceId}/${taskId} is past its task freshness threshold`);
      }
      if (failures >= deps.config.worker.scheduler.maxTransientRetries) {
        problems.push(`${sourceId}/${taskId} has ${failures} consecutive failures`);
      }
      if (task.running === true && staleTaskAttempt(task, deps)) {
        problems.push(`${sourceId}/${taskId} appears stalled`);
      }
    }
  }
  if (selectionContractActive) {
    for (const sourceId of configuredSelectedSourceIds) {
      if (!schedulerSourceIds.has(sourceId)) problems.push(`selected scheduler source ${sourceId} is not active`);
    }
  }
  const corpusIds = await sourceIndexCorpusIdsForDoctor(deps, baseUrl);
  problems.push(...connectedButUnsyncableProblems(deps, {
    corpusIds,
    schedulerSourceIds,
    schedulerCorpusIds,
    ...(selectionContractActive ? { selectedSourceIds: configuredSelectedSourceIds } : {}),
  }));
  if (problems.length > 0) {
    return {
      name,
      ok: false,
      detail: `Source scheduler reported ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.join('; ')}.`,
      hint: SCHEDULER_HINT,
    };
  }
  return {
    name,
    ok: true,
    detail: `Source scheduler is healthy across ${sources.length} source report${sources.length === 1 ? '' : 's'}.`,
  };
}

async function sourceIngestionHealthCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const name = 'source_ingestion_health';
  const baseUrl = deps.config.email.baseUrl;
  if (!deps.config.email.enabled) {
    return {
      name,
      ok: true,
      detail: 'Skipped: the private source worker is disabled, so ingestion health was not checked.',
    };
  }

  const status = await fetchSourceIndexStatusForIngestion(deps, baseUrl);
  if (!status) {
    return {
      name,
      ok: false,
      detail: `Source ingestion health is unknown because source index status is not reachable at ${baseUrl}.`,
      hint: EMAIL_WORKER_HINT,
    };
  }
  const schedulerStatus = await fetchSchedulerStatusForIngestion(deps, baseUrl);
  const now = deps.now?.() ?? new Date();
  const workerLedger = sourceIngestionLedgerFromStatus(status);
  const ledger = workerLedger ?? buildSourceIngestionLedgerSnapshot(status as unknown as SourceIndexStatusResult, {
    ...(schedulerStatus ? { schedulerStatus } : {}),
    now,
    safeForCastor: true,
  });
  const statePath = ingestionHealthStatePath(deps);
  const previous = readIngestionHealthState(statePath);
  const current = ingestionHealthStateFromLedger(ledger);
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const row of ledger.rows) {
    const stuck = row.ingestion_health.stuck_work;
    const actionable = stuck.queued + stuck.failed_retryable;
    if (actionable > 0) {
      const oldest = stuck.oldest_age_hours;
      if (oldest === undefined) {
        warnings.push(`${row.label}: WARNING ${actionable} queued/retryable item(s), oldest age unknown.`);
      } else if (oldest >= INGESTION_STUCK_ERROR_HOURS) {
        errors.push(`${row.label}: ERROR ${actionable} queued/retryable item(s), oldest ${oldest}h (>=72h).`);
      } else if (oldest >= INGESTION_STUCK_WARNING_HOURS) {
        warnings.push(`${row.label}: WARNING ${actionable} queued/retryable item(s), oldest ${oldest}h (>=24h).`);
      }
      const drain = row.ingestion_health.drain;
      if (schedulerStatus && (schedulerStatus.enabled !== true || schedulerStatus.running !== true)) {
        errors.push(`${row.label}: ERROR work is queued but the source scheduler reports ${schedulerStatus.enabled === true ? 'not running' : 'disabled'}.`);
      }
      if (drain.state === 'disabled' || drain.state === 'held') {
        errors.push(`${row.label}: ERROR work is queued but nothing will process it; drain ${drain.state}${drain.unit ? ` (${drain.unit})` : ''}.`);
      } else if (drain.state === 'unknown') {
        warnings.push(`${row.label}: WARNING queued work exists but drain state is unknown.`);
      }
      const previousActionable = previous?.sources[row.source_id]?.actionable_stuck ?? actionable;
      if (actionable > previousActionable) {
        errors.push(`${row.label}: ERROR queued/retryable work is growing across doctor runs (${previousActionable} -> ${actionable}).`);
      }
    }

    const previousTerminal = previous?.sources[row.source_id]?.failed_terminal_by_class ?? {};
    for (const [failureClass, count] of Object.entries(current.sources[row.source_id]?.failed_terminal_by_class ?? {})) {
      const delta = count - (previousTerminal[failureClass] ?? count);
      if (delta > INGESTION_TERMINAL_FAILURE_DELTA_WARNING) {
        warnings.push(`${row.label}: WARNING failed_terminal ${failureClass} grew by ${delta} since the previous doctor run.`);
      }
    }
  }

  writeIngestionHealthState(statePath, current);

  const hint = ingestionHealthHint(ledger);
  if (errors.length > 0) {
    return {
      name,
      ok: false,
      detail: `Source ingestion health reported ${errors.length} error${errors.length === 1 ? '' : 's'}${warnings.length ? ` and ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}: ${[...errors, ...warnings].join('; ')}.`,
      ...(hint ? { hint } : {}),
    };
  }
  if (warnings.length > 0) {
    return {
      name,
      ok: true,
      detail: `Source ingestion health reported ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings.join('; ')}.`,
      ...(hint ? { hint } : {}),
    };
  }
  return {
    name,
    ok: true,
    detail: `Source ingestion health is healthy across ${ledger.rows.length} source${ledger.rows.length === 1 ? '' : 's'}; no queued/retryable stuck work or growing terminal failures.`,
  };
}

async function fetchSourceIndexStatusForIngestion(deps: DoctorDeps, baseUrl: string): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/source/index/status?include_ingestion_ledger=true&include_items=false`, workerRequestInit(deps));
    if (!response.ok) return undefined;
    return asRecord(await response.json());
  } catch {
    return undefined;
  }
}

async function fetchSchedulerStatusForIngestion(deps: DoctorDeps, baseUrl: string): Promise<SourceSchedulerStatus | undefined> {
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/source/scheduler/status`, workerRequestInit(deps));
    if (!response.ok) return undefined;
    const status = asRecord(await response.json());
    if (status.kind !== 'source_scheduler_status') return undefined;
    return status as unknown as SourceSchedulerStatus;
  } catch {
    return undefined;
  }
}

function sourceIngestionLedgerFromStatus(status: Record<string, unknown>): SourceIngestionLedgerSnapshot | undefined {
  const ledger = asRecord(status.ingestion_ledger);
  if (ledger.kind !== 'source_ingestion_ledger' || !Array.isArray(ledger.rows)) return undefined;
  return ledger as unknown as SourceIngestionLedgerSnapshot;
}

interface IngestionHealthDoctorState {
  generated_at: string;
  sources: Record<string, {
    actionable_stuck: number;
    failed_terminal_by_class: Record<string, number>;
  }>;
}

function ingestionHealthStatePath(deps: DoctorDeps): string {
  if (deps.ingestionHealthStatePath) return deps.ingestionHealthStatePath;
  return join(dirname(defaultSourceDashboardHistoryDbPath(deps.env)), 'source-ingestion-doctor-state.json');
}

function ingestionHealthStateFromLedger(ledger: SourceIngestionLedgerSnapshot): IngestionHealthDoctorState {
  const sources: IngestionHealthDoctorState['sources'] = {};
  for (const row of ledger.rows) {
    const terminal: Record<string, number> = {};
    for (const item of row.ingestion_health.stuck_work.by_class) {
      if (item.status !== 'failed_terminal') continue;
      const key = `${item.extractor_kind}:${item.error_class ?? 'unknown'}`;
      terminal[key] = (terminal[key] ?? 0) + item.count;
    }
    sources[row.source_id] = {
      actionable_stuck: row.ingestion_health.stuck_work.queued + row.ingestion_health.stuck_work.failed_retryable,
      failed_terminal_by_class: terminal,
    };
  }
  return { generated_at: ledger.generated_at, sources };
}

function readIngestionHealthState(path: string): IngestionHealthDoctorState | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    const record = asRecord(parsed);
    const sources = asRecord(record.sources);
    const normalized: IngestionHealthDoctorState['sources'] = {};
    for (const [sourceId, sourceValue] of Object.entries(sources)) {
      const source = asRecord(sourceValue);
      const terminal = asRecord(source.failed_terminal_by_class);
      normalized[sourceId] = {
        actionable_stuck: asCount(source.actionable_stuck),
        failed_terminal_by_class: Object.fromEntries(Object.entries(terminal)
          .map(([key, value]) => [key, asCount(value)])),
      };
    }
    return {
      generated_at: typeof record.generated_at === 'string' ? record.generated_at : new Date(0).toISOString(),
      sources: normalized,
    };
  } catch {
    return undefined;
  }
}

function writeIngestionHealthState(path: string, state: IngestionHealthDoctorState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function ingestionHealthHint(ledger: SourceIngestionLedgerSnapshot): string | undefined {
  const hints = ledger.rows
    .map((row) => row.ingestion_health.drain.hint)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return hints[0];
}

async function sourceIndexCorpusIdsForDoctor(deps: DoctorDeps, baseUrl: string): Promise<Set<string>> {
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${baseUrl}/source/index/status`, workerRequestInit(deps));
    if (!response.ok) return new Set();
    const status = asRecord(await response.json());
    const corpora = doctorVisibleCorpora(deps, Array.isArray(status.corpora) ? status.corpora : []);
    return new Set(corpora
      .map((entry) => asRecord(entry))
      .map((corpus) => typeof corpus.corpus_id === 'string' ? corpus.corpus_id : undefined)
      .filter((corpusId): corpusId is string => !!corpusId));
  } catch {
    return new Set();
  }
}

function connectedButUnsyncableProblems(
  deps: DoctorDeps,
  state: {
    corpusIds: Set<string>;
    schedulerSourceIds: Set<string>;
    schedulerCorpusIds: Set<string>;
    selectedSourceIds?: Set<string>;
  },
): string[] {
  const registry = deps.handleRegistry ?? readRegistrySafely(deps);
  const problems: string[] = [];
  for (const handle of registry.handles) {
    if (handle.backendState?.status === 'reauth_required') continue;
    const lane = CONNECTED_SOURCE_LANES.find((candidate) =>
      candidate.provider === handle.provider
      && handle.allowedCapabilities.includes(candidate.capability)
    );
    if (!lane) continue;
    if (state.selectedSourceIds && !state.selectedSourceIds.has(lane.sourceId)) continue;
    const missing: string[] = [];
    const hasCorpus = state.corpusIds.has(lane.corpusId);
    const hasScheduler = state.schedulerSourceIds.has(lane.sourceId) || state.schedulerCorpusIds.has(lane.corpusId);
    if (!hasCorpus || !hasScheduler) {
      for (const flag of [
        ...(lane.envFlag
          ? [{ envFlag: lane.envFlag, defaultOffWhenAbsent: lane.defaultOffWhenAbsent }]
          : []),
      ]) {
        const envFlagProblem = connectedLaneEnvFlagProblem(
          deps.env,
          flag.envFlag,
          flag.defaultOffWhenAbsent === true,
        );
        if (envFlagProblem) missing.push(envFlagProblem);
      }
    }
    if (!hasCorpus) {
      missing.push(`missing corpus ${lane.corpusId}`);
    }
    if (!hasScheduler) {
      missing.push(`missing scheduler source ${lane.sourceId}`);
    }
    if (missing.length > 0) {
      problems.push(`${handle.handle} connected but nothing will sync it: ${missing.join(', ')}`);
    }
  }
  return problems;
}

function connectedLaneEnvFlagProblem(
  env: Record<string, string | undefined> | undefined,
  envFlag: string,
  defaultOffWhenAbsent: boolean,
): string | undefined {
  const value = env?.[envFlag];
  if (value === undefined || value.trim().length === 0) {
    return defaultOffWhenAbsent ? `${envFlag} absent for default-off lane` : undefined;
  }
  const enabled = parseOptionalBooleanEnv(value, envFlag, { invalid: 'warn-false', warn: () => {} });
  return enabled ? undefined : `gated off by ${envFlag}=${value.trim()}`;
}

function connectedSourceCorpusIds(deps: DoctorDeps): Set<string> {
  const registry = deps.handleRegistry ?? readRegistrySafely(deps);
  const corpusIds = new Set<string>();
  for (const handle of registry.handles) {
    if (handle.backendState?.status === 'reauth_required') continue;
    for (const lane of CONNECTED_SOURCE_LANES) {
      if (lane.provider === handle.provider && handle.allowedCapabilities.includes(lane.capability)) {
        corpusIds.add(lane.corpusId);
      }
    }
  }
  return corpusIds;
}

async function credentialHandleCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const registry = deps.handleRegistry ?? readRegistrySafely(deps);
  const problems: string[] = [];
  for (const handle of registry.handles) {
    const status = typeof handle.backendState?.status === 'string' ? handle.backendState.status : undefined;
    if (status && status !== 'available') {
      problems.push(`${handle.handle} status=${status}`);
    }
  }
  if (problems.length > 0) {
    return {
      name: 'credential_handles',
      ok: false,
      detail: `Credential handles need attention: ${problems.join('; ')}.`,
      hint: CREDENTIAL_HINT,
    };
  }
  return {
    name: 'credential_handles',
    ok: true,
    detail: `Credential handle metadata is healthy (${registry.handles.length} handle${registry.handles.length === 1 ? '' : 's'} checked).`,
  };
}

async function detachedOAuthConnectionCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const states = listDetachedOAuthStates({
    ...(deps.oauthStateDir ? { stateDir: deps.oauthStateDir } : {}),
    ...(deps.oauthPidAlive ? { pidAlive: deps.oauthPidAlive } : {}),
  }).filter((state) => state.status === 'pending' || state.status === 'died');
  if (states.length === 0) {
    return {
      name: 'detached_oauth_connections',
      ok: true,
      detail: 'No pending or died detached OAuth connections were found.',
    };
  }
  return {
    name: 'detached_oauth_connections',
    ok: false,
    detail: `Detached OAuth needs attention: ${states.map((state) => `${state.source}/${state.accountRole} status=${state.status}${state.logPath ? ` log=${state.logPath}` : ''}`).join('; ')}.`,
    hint: 'Run olympus connect status, open the authorization URL for pending connections, or rerun olympus connect <source> --detach if the child died.',
  };
}

/**
 * Every token-refresh handle whose credential has died, whatever its provider.
 *
 * The Google check below only sees handles carrying an `oauth2Refresh` block,
 * which is the shape `connect` produces. A handle minted from the broker's own
 * catalog has no such block -- x.bookmarks.personal is required not to have one
 * -- so its reauthorization was recorded in the registry and reported to nobody.
 * That is how a dead X handle stayed dead for two days (2026-07-28).
 *
 * Scoped to the refresh lane on purpose. Guided sessions report the same status
 * before they have ever been paired, and a setup step nobody has reached yet is
 * not a credential that broke.
 */
async function credentialReauthorizationBacklogCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const registry = deps.handleRegistry ?? readRegistrySafely(deps);
  const handles = registry.handles
    .filter((handle) => handle.backendState?.kind === 'oauth2_refresh')
    .filter((handle) => handle.backendState?.status === 'reauth_required')
    .map((handle) => handle.handle)
    .sort((a, b) => a.localeCompare(b));
  if (handles.length === 0) {
    return {
      name: 'credential_reauthorization_backlog',
      ok: true,
      detail: 'No token-refresh handle is waiting for reauthorization.',
      hint: 'A handle lands here when its refresh token is refused or a rotation could not be recorded; reconnect that source to clear it.',
    };
  }
  return {
    name: 'credential_reauthorization_backlog',
    ok: false,
    detail: `Reauthorization is required for ${handles.join(', ')}.`,
    hint: 'Re-run the matching olympus connect command for each handle. A handle whose provider rotates refresh tokens (X) cannot be recovered any other way once the stored token is spent.',
  };
}

async function googleOAuthRefreshLifetimeCheck(deps: DoctorDeps): Promise<DoctorCheck> {
  const registry = deps.handleRegistry ?? readRegistrySafely(deps);
  const googleReauthHandles = registry.handles
    .filter((handle) => handle.oauth2Refresh)
    .filter((handle) => handle.provider === 'gmail' || handle.provider === 'google_drive')
    .filter((handle) => handle.backendState?.status === 'reauth_required')
    .map((handle) => handle.handle)
    .sort((a, b) => a.localeCompare(b));
  if (googleReauthHandles.length > 0) {
    return {
      name: 'google_oauth_refresh_lifetime',
      ok: false,
      detail: `Google OAuth refresh requires reauthorization for ${googleReauthHandles.join(', ')}.`,
      hint: 'Run the matching olympus connect google/gmail/google-drive command again. If this repeats after a few days, check that the OAuth consent screen is published to production: https://console.cloud.google.com/auth/audience. Testing mode refresh tokens expire after 7 days.',
    };
  }
  return {
    name: 'google_oauth_refresh_lifetime',
    ok: true,
    detail: 'No Google OAuth refresh reauthorization state is recorded in the connected-handle registry.',
    hint: 'If Gmail or Drive worked for a few days and then needs reauth, check that the OAuth consent screen is published to production: https://console.cloud.google.com/auth/audience. Testing mode refresh tokens expire after 7 days.',
  };
}

function staleRunningSync(corpus: Record<string, unknown>): { syncRunId: string; startedAt: string } | undefined {
  const lastRefresh = asRecord(corpus.last_refresh);
  if (lastRefresh.status !== 'running') return undefined;
  const startedAt = typeof lastRefresh.started_at === 'string' ? lastRefresh.started_at : undefined;
  if (!startedAt) return undefined;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || Date.now() - startedAtMs <= STALE_RUNNING_SYNC_MS) return undefined;
  return {
    syncRunId: typeof lastRefresh.sync_run_id === 'string' ? lastRefresh.sync_run_id : 'unknown',
    startedAt,
  };
}

function hasSyncRecord(corpus: Record<string, unknown>): boolean {
  const lastRefresh = asRecord(corpus.last_refresh);
  if (Object.keys(lastRefresh).length > 0) return true;
  const lastSync = asRecord(corpus.last_sync);
  if (Object.keys(lastSync).length > 0) return true;
  const counts = asRecord(corpus.counts);
  return asCount(counts.items_indexed) > 0 || asCount(counts.messages_indexed) > 0 || asCount(counts.total_items) > 0;
}

function doctorVisibleCorpora(deps: DoctorDeps, corpora: unknown[]): unknown[] {
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
  return corpora.filter((entry) => {
    const corpus = asRecord(entry);
    const corpusId = typeof corpus.corpus_id === 'string' ? corpus.corpus_id : '';
    return !isDomainCorpus(corpusId) || deps.config.domainExpert.enabled === true;
  });
  // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  return corpora;
}

// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
function isDomainCorpus(corpusId: string): boolean {
  return corpusId.startsWith('internal.solon.') || corpusId.startsWith('secure_local.solon.');
}
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

function staleTaskAttempt(task: Record<string, unknown>, deps: DoctorDeps): boolean {
  const attemptedAt = typeof task.last_attempt_at === 'string' ? task.last_attempt_at : undefined;
  if (!attemptedAt) return false;
  const attemptedAtMs = Date.parse(attemptedAt);
  if (!Number.isFinite(attemptedAtMs)) return false;
  const now = deps.now?.() ?? new Date();
  return now.getTime() - attemptedAtMs > deps.config.worker.scheduler.tickSeconds * 3 * 1_000;
}

function workerRequestInit(deps: DoctorDeps): RequestInit {
  return withWorkerAuthHeader({ method: 'GET' }, workerAuthTokenFromConfig(deps.config));
}

function readRegistrySafely(deps: DoctorDeps): ConnectedHandleRegistry {
  try {
    return deps.readHandleRegistry?.() ?? readConnectedHandleRegistry();
  } catch {
    return { version: 1, handles: [] };
  }
}

function defaultCommandExists(command: string): boolean {
  const path = process.env.PATH ?? '';
  return path.split(':').some((dir) => Boolean(dir) && existsSync(join(dir, command)));
}

function defaultPythonModuleExists(pythonCommand: string, moduleName: string): boolean {
  const proc = spawnSync(pythonCommand, ['-c', `import ${moduleName}`], { stdio: 'ignore' });
  return proc.status === 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
