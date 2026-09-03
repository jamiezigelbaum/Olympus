// OpenAI-compatible AnalystModel adapter.
//
// Maps the provider-agnostic AnalystModel seam (src/core/analyst.ts) onto an
// OpenAI-compatible /chat/completions endpoint. The caller decides the trust
// posture for ordinary cloud analysts over INTERNAL/PUBLIC packs. Raw
// secure_local/S4 packs never use this standard-cloud adapter. The dedicated
// Venice adapter separately enforces its approved category floor for raw S4.
//
// The security invariant is NOT enforced here. It is enforced by the routing
// layer (workers/source-index/analyst-answer.ts), which keeps ordinary cloud
// away from secure_local evidence. This file stays a dumb transport: it formats
// the request, POSTs it, and returns model message text for createAnalyst() to
// parse. Any transport/HTTP failure surfaces as a clear OperationError so the
// routing layer can fall back to the stricter local analyst where appropriate.

import { OperationError } from './operation-error.ts';
import type { AnalystModel, AnalystModelCompletion, AnalystModelRequest } from './analyst.ts';

// Injectable so tests can script the wire without a network. Matches the global
// fetch signature closely enough for our single POST.
export type OpenAIAnalystFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export type OpenAIServiceTier = 'fast' | 'priority';
export type OpenAIReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface OpenAICompatibleAnalystModelOptions {
  // Required: bearer key for the OpenAI-compatible endpoint.
  apiKey: string;
  // Defaults chosen for the frontier-max doctrine (max reasoning, low latency).
  model?: string;
  baseUrl?: string;
  reasoningEffort?: OpenAIReasoningEffort;
  serviceTier?: OpenAIServiceTier | false;
  timeoutMs?: number;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  // Optional minimum completion budget for reasoning models. This is a floor,
  // not an unbounded override: it gives thinking models room for reasoning plus
  // final JSON while preserving the caller's explicit maxOutputChars budget
  // when it is larger.
  reasoningHeadroomTokens?: number;
  providerLabel?: string;
  apiKeyHint?: string;
  extraBody?: Record<string, unknown>;
  // Injectable transport (tests / proxies). Defaults to global fetch.
  fetchImpl?: OpenAIAnalystFetch;
}

const DEFAULT_MODEL = 'gpt-5.5';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REASONING_EFFORT: OpenAIReasoningEffort = 'high';
const DEFAULT_SERVICE_TIER: OpenAIServiceTier = 'priority';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_REASONING_HEADROOM_TOKENS = 32_768;

export function createOpenAICompatibleAnalystModel(
  options: OpenAICompatibleAnalystModelOptions,
): AnalystModel {
  const apiKey = options.apiKey?.trim();
  const providerLabel = options.providerLabel?.trim() || 'Cloud analyst';
  const apiKeyHint = options.apiKeyHint?.trim() || 'Set OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_API_KEY or pass apiKey explicitly.';
  if (!apiKey) {
    throw new OperationError(
      'config_error',
      `${providerLabel} requires an apiKey.`,
      apiKeyHint,
    );
  }
  const model = options.model?.trim() || DEFAULT_MODEL;
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const reasoningEffort = options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  const serviceTier = options.serviceTier ?? DEFAULT_SERVICE_TIER;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokensField = options.maxTokensField ?? 'max_tokens';
  const fetchImpl: OpenAIAnalystFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    async complete(request: AnalystModelRequest): Promise<AnalystModelCompletion> {
      const url = `${baseUrl}/chat/completions`;
      const body: Record<string, unknown> = {
        ...(options.extraBody ?? {}),
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        reasoning_effort: reasoningEffort,
      };
      if (serviceTier !== false) body.service_tier = serviceTier;
      // maxOutputChars passthrough -> provider token budget field (rough ~3
      // chars/token, floored so a tight answer budget never truncates JSON).
      if (request.maxOutputChars !== undefined) {
        body[maxTokensField] = maxTokensForChars(request.maxOutputChars, {
          reasoningEffort,
          ...(options.reasoningHeadroomTokens !== undefined
            ? { reasoningHeadroomTokens: options.reasoningHeadroomTokens }
            : {}),
        });
      }

      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) abortFromCaller();
      else request.signal?.addEventListener('abort', abortFromCaller, { once: true });
      // Armed across the body reads too: headers arriving proves nothing about
      // a peer that then stalls the body, and a cloud leg may carry no caller
      // budget behind this one.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } catch (error) {
          if (request.signal?.aborted) throw callerAbortError(request.signal.reason);
          throw new OperationError(
            'source_index_error',
            `${providerLabel} (${model}) was unreachable at ${url}.`,
            error instanceof Error ? error.message : `Check the ${providerLabel} endpoint and network.`,
          );
        }

        if (!response.ok) {
          const detail = await safeText(response);
          throw new OperationError(
            'source_index_error',
            `${providerLabel} (${model}) returned HTTP ${response.status}.`,
            detail || `Check the ${providerLabel} endpoint logs and API key.`,
          );
        }

        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          if (request.signal?.aborted) throw callerAbortError(request.signal.reason);
          if (timedOut) {
            throw new OperationError(
              'source_index_error',
              `${providerLabel} (${model}) did not complete within ${timeoutMs}ms.`,
              'The endpoint returned response headers but stalled the body; falling back to local.',
            );
          }
          throw new OperationError(
            'source_index_error',
            `${providerLabel} (${model}) returned a non-JSON response.`,
            error instanceof Error ? error.message : 'The endpoint did not return JSON.',
          );
        }

        const parsed = data as {
          choices?: Array<{
            finish_reason?: string | null;
            message?: {
              content?: string | null;
              reasoning?: unknown;
              reasoning_content?: unknown;
              thinking?: unknown;
            };
            reasoning?: unknown;
          }>;
          model?: string;
        };
        const choice = parsed.choices?.[0];
        const text = choice?.message?.content;
        if (typeof text !== 'string' || text.trim().length === 0) {
          const finishReason = typeof choice?.finish_reason === 'string'
            ? choice.finish_reason
            : undefined;
          const hasReasoning =
            choice?.message?.reasoning !== undefined
            || choice?.message?.reasoning_content !== undefined
            || choice?.message?.thinking !== undefined
            || choice?.reasoning !== undefined;
          const truncation = finishReason === 'length' || finishReason === 'max_tokens';
          const message = truncation || hasReasoning
            ? `${providerLabel} (${model}) completion budget exhausted during reasoning${finishReason ? ` (finish_reason=${finishReason})` : ''}; response did not include final message content.`
            : `${providerLabel} (${model}) response did not include message content.`;
          throw new OperationError(
            'source_index_error',
            message,
            'Increase the reasoning completion budget or reduce the evidence pack; falling back to local.',
          );
        }
        // createAnalyst() owns JSON parsing of the analyst answer object — we only
        // return the raw model text and the resolved model id.
        return { text, modelId: parsed.model || model };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

function callerAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  const error = new Error('Analyst request was cancelled.');
  error.name = 'AbortError';
  return error;
}

// Backend tag for observability for the ordinary cloud lane. Trusted-provider
// adapters such as Venice expose their own backend labels.
export const OPENAI_ANALYST_BACKEND = 'cloud' as const;

function maxTokensForChars(
  chars: number,
  options: {
    reasoningEffort: OpenAIReasoningEffort;
    reasoningHeadroomTokens?: number;
  },
): number {
  const answerBudget = Math.max(256, Math.ceil(chars / 3));
  if (options.reasoningEffort === 'none' || options.reasoningHeadroomTokens === undefined) {
    return answerBudget;
  }
  const boundedHeadroom = Math.max(
    0,
    Math.min(MAX_REASONING_HEADROOM_TOKENS, Math.floor(options.reasoningHeadroomTokens)),
  );
  return Math.max(answerBudget, boundedHeadroom);
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
