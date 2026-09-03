/**
 * Loopback-only OpenAI-compatible client for the shared local vision lanes.
 *
 * The client owns two safety properties that must remain true after removing
 * the former source-family implementation: construction refuses a routable
 * endpoint, and the health probe proves that the configured model is actually
 * listed before the runner leases a batch.
 */

import { Buffer } from 'node:buffer';
import type {
  VlmClient,
  VlmDescribeRequest,
  VlmDescribeResult,
  VlmProbeRequest,
} from '../types.ts';
import { normalizeExtractedText } from './bounded-text.ts';
import { requireLocalHttpBaseUrl, requireNonEmpty } from './remote-vlm.ts';
import {
  DEFAULT_VLM_PDF_HEALTHCHECK_TIMEOUT_MS,
  VLM_ROUTER_PROFILE_UNKNOWN_ERROR_KIND,
  VlmRouterError,
  classifyVlmRouterEndpointError,
  vlmRouterErrorKind,
} from './vlm.ts';

export const DEFAULT_LOCAL_VLM_TIMEOUT_MS = 180_000;

export interface OpenAICompatibleVlmClientOptions {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
}

export class OpenAICompatibleVlmClient implements VlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleVlmClientOptions) {
    this.baseUrl = requireLocalHttpBaseUrl(
      options.baseUrl,
      'File extraction local VLM base URL',
    );
    this.model = requireNonEmpty(options.model, 'File extraction local VLM model');
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (options.apiKey?.trim()) this.apiKey = options.apiKey.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_VLM_TIMEOUT_MS;
  }

  async describe(request: VlmDescribeRequest): Promise<VlmDescribeResult> {
    const timeout = requestTimeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        ...(timeout.signal ? { signal: timeout.signal } : {}),
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: request.maxTokens ?? 700,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            {
              role: 'system',
              content: 'You are a local secure visual extraction worker. Return concise evidence text only.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: request.prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${request.mimeType};base64,${Buffer.from(request.bytes).toString('base64')}`,
                  },
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok) {
        const classified = classifyVlmRouterEndpointError(response.status);
        throw new VlmRouterError({
          status: response.status,
          errorKind: classified.kind,
          retryable: classified.retryable,
          message: `Local VLM endpoint returned HTTP ${response.status}.`,
        });
      }
      const text = normalizeExtractedText(
        parseOpenAICompatibleResponseText(await response.json()),
      ).slice(0, request.maxOutputChars);
      return {
        text,
        confidence: text ? 0.65 : 0.2,
        warnings: [text ? 'local_private_model' : 'vlm_empty'],
      };
    } catch (error) {
      if (error instanceof VlmRouterError) throw error;
      throw new Error(error instanceof Error ? error.message : 'Local VLM endpoint failed.');
    } finally {
      timeout.clear();
    }
  }

  async probe(request: VlmProbeRequest = {}): Promise<void> {
    const timeout = requestTimeout(
      request.timeoutMs ?? DEFAULT_VLM_PDF_HEALTHCHECK_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        ...(timeout.signal ? { signal: timeout.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`Local VLM endpoint returned HTTP ${response.status}.`);
      }
      const listed = listedVlmProfileIds(await response.json().catch(() => undefined));
      if (listed.length === 0) {
        throw new Error('the endpoint did not return a readable model listing.');
      }
      if (!listed.includes(this.model)) {
        throw new VlmRouterError({
          status: 404,
          errorKind: VLM_ROUTER_PROFILE_UNKNOWN_ERROR_KIND,
          retryable: false,
          message: 'the configured vision profile is not served by this endpoint.',
        });
      }
    } catch (error) {
      if (error instanceof VlmRouterError) throw error;
      const kind = vlmRouterErrorKind(error) ?? 'vlm_backend_unavailable';
      throw new VlmRouterError({
        status: 503,
        errorKind: kind,
        retryable: true,
        message: `${kind}: Local VLM endpoint health probe failed.`,
      });
    } finally {
      timeout.clear();
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Connection: 'close',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }
}

export function listedVlmProfileIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry && typeof entry === 'object'
      ? (entry as { id?: unknown }).id
      : undefined))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function requestTimeout(timeoutMs: number): { signal?: AbortSignal; clear: () => void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { clear: () => undefined };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function parseOpenAICompatibleResponseText(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('Local VLM endpoint returned a malformed response.');
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Local VLM endpoint returned no choices.');
  }
  const first = choices[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Local VLM endpoint returned a malformed choice.');
  }
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') {
    throw new Error('Local VLM endpoint returned no message.');
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const text = (item as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .filter((text) => text.trim().length > 0)
      .join('\n');
  }
  throw new Error('Local VLM endpoint returned no text content.');
}
