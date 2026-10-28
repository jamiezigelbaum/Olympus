/**
 * One pass's connection to a provider's MCP server (docs/CREATE_CONNECTOR.md,
 * "MCP sources"), source-neutral:
 *
 * - Streamable HTTP to the server the connector fixed; never a user setting.
 * - Read-only and allowlisted: the connector names its read tools. Any other
 *   name is refused before it is sent, and so is a named tool the server's
 *   listing no longer marks `readOnlyHint: true` (the listing is read again by
 *   every pass, so a server that changes a tool is caught at the next pass).
 * - Paced by the server's one pacer, retried with backoff when the provider
 *   says slow down, bounded by a per-pass call budget, and stopped between
 *   calls when the pass is told to stop.
 * - What comes back is data: a tool's structured result, else its text.
 *   Tool descriptions and the server's instructions are never kept, so they
 *   cannot reach a model.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpSourceError, type McpSourceErrorKind } from './errors.ts';
import { McpCallPacer, mcpServerPacer } from './pacer.ts';

export const MCP_SOURCE_DEFAULT_RATE_LIMIT_RETRIES = 3;
export const MCP_SOURCE_DEFAULT_RATE_LIMIT_BACKOFF_MS = 15_000;
export const MCP_SOURCE_DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** A tool's answer, as data. `isError` is the provider saying the call failed for a reason of its own (not found, say). */
export interface McpToolOutput {
  isError: boolean;
  /** `structuredContent`, else the text parsed as JSON when it is JSON. */
  data: unknown;
  /** The text blocks, joined. */
  text: string;
}

export interface McpSourceSessionOptions {
  serverUrl: string;
  clientName: string;
  clientVersion: string;
  /** The read tools the connector calls; nothing else is ever sent. */
  readTools: readonly string[];
  /** Upper bound on tool calls (listing included) this pass may make. */
  callBudget: number;
  /** Carries the credential (`mcpAuthorizedFetch`); a plain fetch otherwise. */
  fetch?: FetchLike;
  pacer?: McpCallPacer;
  shouldContinue?: () => boolean;
  rateLimitRetries?: number;
  rateLimitBackoffMs?: number;
  callTimeoutMs?: number;
}

const RATE_LIMIT_TEXT = /rate.?limit|too many requests|\b429\b/i;
const PERMISSION_TEXT = /permission denied|insufficient[_ ]scope|wasn't granted|was not granted|\bforbidden\b/i;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function dataOf(structured: unknown, text: string): unknown {
  if (structured && typeof structured === 'object') return structured;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A thrown error's kind, or undefined when it is not one this layer names. */
function errorKind(error: unknown): McpSourceErrorKind | 'rate' | undefined {
  if (error instanceof McpSourceError) return error.kind;
  if (error instanceof StreamableHTTPError) {
    if (error.code === 429) return 'rate';
    if (error.code === 401) return 'auth_revoked';
    if (error.code === 403) return 'permission_missing';
    return 'server_error';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (RATE_LIMIT_TEXT.test(message)) return 'rate';
  return undefined;
}

export class McpSourceSession {
  /** Tool calls made, listing and retries included. */
  calls = 0;
  rateLimitRetries = 0;
  private readonly client: Client;
  private readonly pacer: McpCallPacer;
  private readOnly = new Map<string, boolean>();
  private opened = false;

  constructor(private readonly options: McpSourceSessionOptions) {
    if (!Number.isSafeInteger(options.callBudget) || options.callBudget <= 0) {
      throw new TypeError('An MCP source session needs a positive call budget.');
    }
    this.client = new Client({ name: options.clientName, version: options.clientVersion });
    this.pacer = options.pacer ?? mcpServerPacer(options.serverUrl);
  }

  /** Connects and reads the tool listing (which tools exist, and which say they are read-only). */
  async open(): Promise<void> {
    this.ensureContinue();
    const transport = new StreamableHTTPClientTransport(new URL(this.options.serverUrl), {
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId).
    await this.paced(() => this.client.connect(transport as unknown as Parameters<Client['connect']>[0]));
    let cursor: string | undefined;
    const readOnly = new Map<string, boolean>();
    do {
      const page = await this.metered(() => this.client.listTools(cursor ? { cursor } : undefined));
      for (const tool of page.tools) readOnly.set(tool.name, tool.annotations?.readOnlyHint === true);
      cursor = page.nextCursor;
    } while (cursor);
    this.readOnly = readOnly;
    this.opened = true;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }

  /** Calls one of the connector's read tools. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolOutput> {
    if (!this.opened) throw new TypeError('Open the MCP source session before calling a tool.');
    if (!this.options.readTools.includes(name) || this.readOnly.get(name) !== true) throw new McpSourceError('tool_refused');
    const result = await this.metered(() => this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.options.callTimeoutMs ?? MCP_SOURCE_DEFAULT_CALL_TIMEOUT_MS },
    ), true);
    const text = textOf(result.content);
    return { isError: result.isError === true, data: dataOf(result.structuredContent, text), text };
  }

  private ensureContinue(): void {
    if (this.options.shouldContinue && !this.options.shouldContinue()) throw new McpSourceError('cancelled');
  }

  private async paced<T>(work: () => Promise<T>): Promise<T> {
    await this.pacer.turn();
    try {
      return await work();
    } catch (error) {
      const kind = errorKind(error);
      if (error instanceof McpSourceError) throw error;
      throw new McpSourceError(kind === 'rate' ? 'rate_limited' : kind ?? 'server_error', { cause: error });
    }
  }

  /**
   * One budgeted call, retried with backoff while the provider says slow
   * down (as an HTTP 429 or as a tool error saying so). A tool error that says
   * a permission is missing is `permission_missing`.
   */
  private async metered<T>(work: () => Promise<T>, toolCall = false): Promise<T> {
    const retries = this.options.rateLimitRetries ?? MCP_SOURCE_DEFAULT_RATE_LIMIT_RETRIES;
    const backoffMs = this.options.rateLimitBackoffMs ?? MCP_SOURCE_DEFAULT_RATE_LIMIT_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
      this.ensureContinue();
      if (this.calls >= this.options.callBudget) throw new McpSourceError('budget_exhausted');
      this.calls += 1;
      await this.pacer.turn();
      let limited = false;
      let result: T | undefined;
      try {
        result = await work();
      } catch (error) {
        const kind = errorKind(error);
        if (kind !== 'rate') {
          if (error instanceof McpSourceError) throw error;
          throw new McpSourceError(kind ?? 'server_error', { cause: error });
        }
        limited = true;
      }
      if (!limited && toolCall) {
        const output = result as { isError?: boolean; content?: unknown };
        if (output.isError === true) {
          const text = textOf(output.content);
          if (RATE_LIMIT_TEXT.test(text)) limited = true;
          else if (PERMISSION_TEXT.test(text)) throw new McpSourceError('permission_missing');
        }
      }
      if (!limited) return result as T;
      const wait = backoffMs * attempt;
      if (attempt > retries) throw new McpSourceError('rate_limited', { retryAfterMs: wait });
      this.rateLimitRetries += 1;
      this.pacer.backoff(wait);
    }
  }
}
