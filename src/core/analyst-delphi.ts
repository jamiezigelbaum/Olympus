// Delphi-backed AnalystModel adapter.
//
// Maps the provider-agnostic AnalystModel seam (src/core/analyst.ts) onto the
// local Argus/Delphi completion client. Both Argus lanes are LOCAL endpoints,
// so this adapter is local by construction — there is no path here by which
// secure_local evidence reaches a cloud model. When localOnly evidence is weak,
// the Analyst may still propose the separately governed redacted standard-cloud
// escalation. Hence request.localOnly does not change this adapter's lane.

import type { ArgusLane, ArgusModelProfile } from './config.ts';
import { DelphiClient, type CompleteOptions } from './delphi.ts';
import { OperationError } from './operation-error.ts';
import type { AnalystModel, AnalystModelCompletion, AnalystModelRequest } from './analyst.ts';

export interface DelphiAnalystModelOptions {
  lane?: ArgusLane;
  profile?: ArgusModelProfile;
  // Fail fast on a dead or still-loading lane: a bounded /models preflight
  // before the (long-running) completion, instead of hanging requests into the
  // 180s client timeout. 0 disables the preflight.
  preflightTimeoutMs?: number;
}

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 5_000;

export function createDelphiAnalystModel(
  delphi: DelphiClient,
  options: DelphiAnalystModelOptions,
): AnalystModel {
  const preflightTimeoutMs = options.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  return {
    async complete(request: AnalystModelRequest): Promise<AnalystModelCompletion> {
      if (preflightTimeoutMs > 0) {
        await assertRouteAnswers(delphi, options, preflightTimeoutMs, request.signal);
      }
      const completeOptions: CompleteOptions = {
        prompt: request.prompt,
        system: request.system,
        temperature: 0,
        ...(options.profile ? { profile: options.profile } : {}),
        ...(options.lane ? { lane: options.lane } : {}),
        ...(request.maxOutputChars !== undefined
          ? { maxTokens: maxTokensForChars(request.maxOutputChars) }
          : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      };
      const result = await delphi.complete(completeOptions);
      return { text: result.text, modelId: result.model };
    },
  };
}

// Bounded preflight: the lane must answer /models within the budget. A dead
// port fails immediately; a loading model (accepts connections but does not
// respond) fails at the timeout — both surface as argus_unreachable so the
// caller fails CLOSED fast rather than hanging a secure question for minutes.
async function assertRouteAnswers(
  delphi: DelphiClient,
  options: DelphiAnalystModelOptions,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const label = options.profile ? `profile:${options.profile}` : `lane:${options.lane ?? 'default'}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new OperationError(
            'argus_unreachable',
            `Argus ${label} did not answer the preflight within ${timeoutMs}ms.`,
            'The local model route is down or still loading; failing closed instead of hanging.',
          ),
        ),
      timeoutMs,
    );
  });
  try {
    const preflight = options.profile
      ? delphi.listModelsForProfile(options.profile, signal)
      : delphi.listModels(options.lane ?? 'fast', signal);
    await Promise.race([preflight, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Rough char->token budget (~3 chars/token) with a floor so a tight answer
// budget never starves the model into truncated JSON.
function maxTokensForChars(chars: number): number {
  return Math.max(256, Math.ceil(chars / 3));
}
