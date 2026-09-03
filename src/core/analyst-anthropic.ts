import { OperationError } from './operation-error.ts';
import type { AnalystModel, AnalystModelCompletion, AnalystModelRequest } from './analyst.ts';

export type AnthropicAnalystFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface AnthropicAnalystModelOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
  fetchImpl?: AnthropicAnalystFetch;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

export function createAnthropicAnalystModel(
  options: AnthropicAnalystModelOptions,
): AnalystModel {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new OperationError(
      'config_error',
      'Anthropic analyst requires an apiKey.',
      'Set the env var referenced by the sovereignty profile secretRef.',
    );
  }
  const model = options.model?.trim() || DEFAULT_MODEL;
  const baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const fetchImpl: AnthropicAnalystFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));

  return {
    async complete(request: AnalystModelRequest): Promise<AnalystModelCompletion> {
      const url = `${baseUrl}/v1/messages`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': ANTHROPIC_VERSION,
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            model,
            max_tokens: request.maxOutputChars !== undefined
              ? maxTokensForChars(request.maxOutputChars)
              : maxTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
          }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new OperationError(
          'source_index_error',
          `Anthropic analyst (${model}) was unreachable at ${url}.`,
          error instanceof Error ? error.message : 'Check the Anthropic endpoint and network.',
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const detail = await safeText(response);
        throw new OperationError(
          'source_index_error',
          `Anthropic analyst (${model}) returned HTTP ${response.status}.`,
          detail || 'Check the Anthropic endpoint logs and API key.',
        );
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        throw new OperationError(
          'source_index_error',
          `Anthropic analyst (${model}) returned a non-JSON response.`,
          error instanceof Error ? error.message : 'The endpoint did not return JSON.',
        );
      }

      const text = parseAnthropicText(data);
      if (!text) {
        throw new OperationError(
          'source_index_error',
          `Anthropic analyst (${model}) response did not include text content.`,
          'The endpoint returned no assistant message; falling back to local.',
        );
      }
      const responseModel = typeof (data as { model?: unknown }).model === 'string'
        ? (data as { model: string }).model
        : model;
      return { text, modelId: responseModel };
    },
  };
}

function parseAnthropicText(data: unknown): string {
  const content = (data as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const record = block && typeof block === 'object' && !Array.isArray(block)
        ? block as { type?: unknown; text?: unknown }
        : undefined;
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function maxTokensForChars(chars: number): number {
  return Math.max(256, Math.ceil(chars / 3));
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
