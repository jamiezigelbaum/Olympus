/**
 * Catalog-gated client for the approved remote vision lane.
 *
 * Construction pins the endpoint to Venice over HTTPS. Dispatch then resolves
 * the selected model through the Venice-published privacy catalog and refuses
 * every missing, anonymized, or otherwise unapproved category before document
 * bytes are sent. The result carries the category-derived destination so the
 * runner can issue a receipt for the boundary that was actually crossed.
 */

import { Buffer } from 'node:buffer';
import { DEFAULT_VENICE_BASE_URL } from '../../../core/analyst-venice.ts';
import {
  createVenicePrivacyCategoryResolver,
  type VeniceModelCatalogOptions,
  type VenicePrivacyCategoryResolver,
} from '../../../core/venice-model-catalog.ts';
import {
  assertVeniceAnalystModelAllowed,
  normalizeVeniceAnalystModelId,
  venicePrivacyCategoryForModel,
  type VenicePrivacyCategory,
} from '../../../core/venice-models.ts';
import { assertSecureAnalystPoolModelIdAllowed } from '../../../core/sovereignty.ts';
import type {
  ExtractionApprovedRemoteDestination,
  VlmClient,
  VlmDescribeRequest,
  VlmDescribeResult,
} from '../types.ts';
import { IMAGE_MIME_TYPES, normalizeExtractedText } from './bounded-text.ts';
import {
  classifyRemoteVlmEndpointError,
  requireApprovedRemoteExtractionBaseUrl,
  requireNonEmpty,
} from './remote-vlm.ts';

export const DEFAULT_VENICE_EXTRACTION_MODEL = 'kimi-k3';
export const DEFAULT_VENICE_EXTRACTION_TIMEOUT_MS = 180_000;

export interface VeniceVlmClientOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  catalog?: VeniceModelCatalogOptions;
}

export class VeniceVlmClient implements VlmClient {
  readonly approvedRemoteDestination?: ExtractionApprovedRemoteDestination;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly resolvePrivacyCategory: VenicePrivacyCategoryResolver;

  constructor(options: VeniceVlmClientOptions) {
    this.apiKey = requireNonEmpty(options.apiKey, 'File extraction Venice API key');
    this.baseUrl = requireApprovedRemoteExtractionBaseUrl(
      options.baseUrl ?? DEFAULT_VENICE_BASE_URL,
      'File extraction Venice base URL',
    );
    this.model = normalizeVeniceAnalystModelId(
      options.model ?? DEFAULT_VENICE_EXTRACTION_MODEL,
    );
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VENICE_EXTRACTION_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.resolvePrivacyCategory = createVenicePrivacyCategoryResolver({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      ...(options.catalog
        ? { catalog: options.catalog }
        : options.fetchImpl
          ? { catalog: { fetchImpl: options.fetchImpl } }
          : {}),
    });
    const approvedRemoteDestination = approvedDestinationForPrivacy(
      venicePrivacyCategoryForModel(this.model),
    );
    if (approvedRemoteDestination) {
      this.approvedRemoteDestination = approvedRemoteDestination;
    }
  }

  async describe(request: VlmDescribeRequest): Promise<VlmDescribeResult> {
    if (!IMAGE_MIME_TYPES.has(request.mimeType)) {
      throw new Error('Venice extraction requires an image MIME type.');
    }

    const timeout = requestTimeout(this.timeoutMs);
    try {
      assertSecureAnalystPoolModelIdAllowed('file-extraction-remote', this.model);
      const privacyCategory = await this.resolvePrivacyCategory(this.model, timeout.signal);
      await assertVeniceAnalystModelAllowed(
        this.model,
        true,
        async () => privacyCategory,
        timeout.signal,
      );
      const egressDestination = approvedDestinationForPrivacy(privacyCategory);
      if (!privacyCategory || !egressDestination) {
        throw new Error('Venice extraction model has no approved remote destination.');
      }

      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'close',
          Authorization: `Bearer ${this.apiKey}`,
        },
        ...(timeout.signal ? { signal: timeout.signal } : {}),
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_completion_tokens: request.maxTokens ?? 900,
          venice_parameters: {
            enable_web_search: 'off',
            enable_web_scraping: false,
            enable_web_citations: false,
            include_venice_system_prompt: false,
            strip_thinking_response: true,
            disable_thinking: true,
          },
          messages: [
            {
              role: 'system',
              content: `You are a Venice ${privacyCategory} secure-local extraction worker. Return concise evidence text only.`,
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
        const body = await response.text().catch(() => '');
        const safeKind = classifyRemoteVlmEndpointError(response.status, body);
        throw new Error(`Venice extraction endpoint ${safeKind} (HTTP ${response.status}).`);
      }

      const text = normalizeExtractedText(
        parseOpenAICompatibleResponseText(await response.json()),
      ).slice(0, request.maxOutputChars);
      return {
        text,
        confidence: text ? 0.75 : 0.2,
        warnings: [text ? extractionWarning(privacyCategory) : 'venice_empty'],
        egressDestination,
      };
    } finally {
      timeout.clear();
    }
  }
}

function approvedDestinationForPrivacy(
  category: VenicePrivacyCategory | undefined,
): ExtractionApprovedRemoteDestination | undefined {
  if (category === 'private') return 'venice_private';
  if (category === 'tee') return 'venice_tee';
  if (category === 'e2ee') return 'venice_e2ee';
  return undefined;
}

function extractionWarning(category: VenicePrivacyCategory): string {
  if (category === 'private') return 'venice_private_extraction';
  if (category === 'tee') return 'venice_tee_extraction';
  if (category === 'e2ee') return 'venice_e2ee_extraction';
  return 'venice_unapproved_extraction';
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
    throw new Error('Venice extraction endpoint returned a malformed response.');
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Venice extraction endpoint returned no choices.');
  }
  const first = choices[0];
  if (!first || typeof first !== 'object') {
    throw new Error('Venice extraction endpoint returned a malformed choice.');
  }
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== 'object') {
    throw new Error('Venice extraction endpoint returned no message.');
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
  throw new Error('Venice extraction endpoint returned no text content.');
}
