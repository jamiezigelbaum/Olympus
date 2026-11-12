import { withJudgeSpendingStop } from '../../classification/judge-spending.ts';
import { JUDGE_PROMPT_CACHE_KEY, JUDGE_SAMPLING, JudgeRateLimitPacer } from '../../classification/judge-pacing.ts';
import { createDecisionSnifferModel } from '../../classification/sniffer-decision.ts';
import {
  builtInAnalystEnabled,
  createBuiltInAnalystModel,
  resolveBuiltInReasoningModel,
  type BuiltInAnalystModel,
} from '../../../core/analyst-built-in.ts';
import { createDelphiAnalystModel } from '../../../core/analyst-delphi.ts';
import {
  createVeniceAnalystModel,
} from '../../../core/analyst-venice.ts';
import { loadConfig } from '../../../core/config.ts';
import { DelphiClient } from '../../../core/delphi.ts';
import {
  type SovereigntyModelProfile,
} from '../../../core/sovereignty.ts';
import {
  WorkerBootSecretResolver,
} from '../../credential-degradation.ts';
import { type SnifferLane } from '../../classification/sniffer-lane.ts';
import type { AnalystModel } from '../../../core/analyst.ts';
import { resolveSecretRefSync, bootSecretOptions } from './environment.ts';

/**
 * The built-in analyst for this worker, or undefined when it is switched off,
 * unsupported here, or the machine has too little memory. Under the test
 * runner it is never created: a test must not fetch model weights.
 */
function createWorkerBuiltInAnalystModel(env: Record<string, string | undefined>): BuiltInAnalystModel | undefined {
  if (env.NODE_ENV === 'test' || !builtInAnalystEnabled(env)) return undefined;
  if (!resolveBuiltInReasoningModel(env)) return undefined;
  return createBuiltInAnalystModel({ env });
}

/**
 * Worker shutdown stops the built-in model's server process (SIGTERM, then
 * SIGKILL; bounded at about 10 s), so a clean shutdown never leaves it running
 * or holding the worker open. A failure is swallowed: shutdown goes on.
 */
export function stopBuiltInModelOnShutdown(model: Pick<BuiltInAnalystModel, 'stop'> | undefined): void {
  if (!model) return;
  try {
    void model.stop().catch(() => undefined);
  } catch {
    // Shutdown continues whatever the model does.
  }
}

/**
 * The worker's one built-in private model, with `available()`: downloaded,
 * verified and prepared in this process, so a caller (the sniffer, the
 * private answer panel) never asks it while a first-time download runs. A
 * model already installed on disk is prepared at boot (a checksum pass, no
 * download); a fresh install is started by the answer pool when the local
 * model service is down.
 */
const BUILT_IN_MODEL_RETRY_MS = 10 * 60_000;
// How often an install another process finished is verified again here.
const BUILT_IN_MODEL_REVERIFY_MS = 30_000;

export function createWorkerSharedBuiltInModel(
  env: Record<string, string | undefined>,
): { model: BuiltInAnalystModel; available: () => boolean; startIfIdle: () => void } | undefined {
  const base = createWorkerBuiltInAnalystModel(env);
  return base ? sharedBuiltInModel(base) : undefined;
}

/** `createWorkerSharedBuiltInModel` around a given model (exported for tests). */
export function sharedBuiltInModel(
  base: BuiltInAnalystModel,
  nowMs: () => number = Date.now,
): { model: BuiltInAnalystModel; available: () => boolean; startIfIdle: () => void } {
  let prepared = false;
  const installedOnDisk = (): boolean => {
    try {
      const state = base.status().state;
      return state === 'loading' || state === 'ready';
    } catch {
      return false;
    }
  };
  const model: BuiltInAnalystModel = {
    ...base,
    async prepare() {
      await base.prepare();
      prepared = installedOnDisk();
    },
  };
  // Any install this computer has started is re-checked at boot, whatever
  // its status file says: a status file is one process's last word, not a
  // fact about the disk. "verifying" or "downloading" left behind by a
  // process that is gone (or a models directory copied mid-install) used to
  // be trusted and stay there forever. prepare() re-verifies the pinned
  // checksums, resumes or restarts a download, and ends ready or failed.
  if (base.status().state !== 'not_started') void model.prepare();
  // A fresh install's first download, started by the tier sniffer when it
  // has items waiting for this model (prepare() is shared and deduplicated).
  // A verified install (prepared in this process) whose server later failed
  // to start is re-armed too, at most once per BUILT_IN_MODEL_RETRY_MS:
  // otherwise `failed` would keep the sniffer and the private panel off this
  // model until the engine restarts. A failed install is never re-run here.
  // With the engine split, the front and the background share one models
  // directory and one status file, and both can install the model at once.
  // This process's prepare() can end while the other's install still reads
  // downloading or verifying, so it stays unprepared after the status turns
  // ready, and the judge waits forever on "not available (ready)" (switch-on
  // release check, 2026-11-12). An install that reads ready here but was not
  // prepared here is verified again, at most once per BUILT_IN_MODEL_REVERIFY_MS.
  let lastRetryMs = 0;
  let lastReverifyMs = Number.NEGATIVE_INFINITY;
  const startIfIdle = (): void => {
    const status = base.status();
    if (status.state === 'not_started') {
      void model.prepare();
      return;
    }
    if (!prepared && (status.state === 'ready' || status.state === 'loading')
      && nowMs() - lastReverifyMs >= BUILT_IN_MODEL_REVERIFY_MS) {
      lastReverifyMs = nowMs();
      void model.prepare();
      return;
    }
    if (prepared && status.state === 'failed' && status.failure?.reason === 'runtime_load_failed'
      && nowMs() - lastRetryMs >= BUILT_IN_MODEL_RETRY_MS) {
      lastRetryMs = nowMs();
      void model.prepare();
    }
  };
  return { model, available: () => prepared && installedOnDisk(), startIfIdle };
}

/**
 * The completion model behind the privacy-safe tier sniffer. Only the two
 * lanes the sniffer lane resolver admits are built here: a loopback local
 * model, or catalog-gated Venice Private (every dispatch re-checks the model's
 * privacy category). Short, cheap, no thinking: it answers one JSON verdict
 * per item.
 */
export function createTierSnifferModel(input: {
  judgeFetch?: import('../../../core/analyst-openai.ts').OpenAIAnalystFetch;
  judgeStatus?: () => import('../../classification/judge-spending.ts').JudgeSpendingStatus;
  judgeOnStop?: () => void;
  lane: SnifferLane;
  /**
   * The profile as configured under the lane's id. Credential readiness is
   * recorded against it, so a judge Olympus derives from an answer profile
   * (its own model, #1252) never replaces that profile's readiness evidence.
   */
  configuredProfile?: SovereigntyModelProfile | undefined;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  bootSecretResolver: WorkerBootSecretResolver;
}): AnalystModel | undefined {
  const { lane } = input;
  const profile = lane.profile;
  if (lane.kind === 'local' && profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) return undefined;
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Tier sniffer local model profile',
        bootSecretOptions(input.bootSecretResolver, [lane.profileId], ['classification'], { id: lane.profileId, profile }),
      )
      : undefined;
    if (profile.secretRef && !apiKey) return undefined;
    const config = structuredClone(input.olympusConfig);
    config.argus.modelProfiles.source_answer = {
      ...config.argus.modelProfiles.source_answer,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.secretRef ? { secretRef: profile.secretRef } : {}),
      purpose: 'text_reasoning',
    };
    return createDecisionSnifferModel(lane, createDelphiAnalystModel(new DelphiClient(config, undefined, { resolveSecretRef: () => apiKey }), {
      profile: 'source_answer',
      preflightTimeoutMs: 5_000,
    }), { apiKey, log: (line) => console.warn(line) });
  }
  if (lane.kind === 'venice' && profile.provider === 'venice') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Tier sniffer Venice model profile',
      bootSecretOptions(input.bootSecretResolver, [lane.profileId], ['classification'], { id: lane.profileId, profile: input.configuredProfile ?? profile }),
    );
    if (!apiKey) return undefined;
    // Paced to the key's per-model request limit; a 429 waits and retries (#884).
    const pacer = new JudgeRateLimitPacer();
    const model = pacer.model(createVeniceAnalystModel({
      apiKey,
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      fetchImpl: pacer.fetch(input.judgeFetch ?? ((url, init) => fetch(url, init))),
      thinking: 'disabled',
      reasoningEffort: 'low',
      reasoningHeadroomTokens: 0,
      timeoutMs: 60_000,
      promptCacheKey: JUDGE_PROMPT_CACHE_KEY,
      sampling: JUDGE_SAMPLING,
    }));
    return input.judgeStatus ? withJudgeSpendingStop(model, input.judgeStatus, input.judgeOnStop) : model;
  }
  return undefined;
}
