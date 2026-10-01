/**
 * The MCP surface ChatGPT reaches through the relay: Olympus's answer tools
 * plus the dashboard tool and its MCP Apps resource.
 *
 * Tool names stay those of the remote surface (source_answer,
 * source_answer_result, source_index_status) so the async answer pattern is
 * unchanged; their descriptions and input schemas are written here for
 * ChatGPT's model and carry no owner-specific examples. Every response, error
 * included, is built by response-builder.ts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { shouldExposeOperation } from '../../core/operation-exposure.ts';
import { findOperationByName, type OperationContext } from '../../core/operations.ts';
import { createPublicSourceCorpusRegistry } from '../../core/source-corpus-registry.ts';
import { VERSION } from '../../version.ts';
import type { SourceDashboardViewModel } from '../source-dashboard.ts';
import { DASHBOARD_RESOURCE_URI, DASHBOARD_TOOL_NAME } from './dashboard-contract.ts';
import { DASHBOARD_RESOURCE, dashboardResourceHtml, dashboardResourceMeta } from './dashboard-resource.ts';
import { buildChatGptDashboardViewModel, type ChatGptDashboardOptions } from './dashboard-view-model.ts';
import {
  answerToolResult,
  ChatGptSurfaceError,
  dashboardToolMeta,
  dashboardToolResult,
  errorToolResult,
  sourceStatusToolResult,
  type ChatGptToolResult,
} from './response-builder.ts';

export interface ChatGptSurfaceOptions {
  /** The engine's dashboard view (the `/dashboard.json` object). */
  dashboardView: (signal?: AbortSignal) => Promise<SourceDashboardViewModel>;
  /**
   * Whether any Private item matches the question. Only the boolean leaves
   * this function; defaults to a one-hit search of each Private corpus.
   */
  privateMatchProbe?: (question: string, ctx: OperationContext) => Promise<boolean>;
  /** The built-in embedding model's state, when the embeddings lane reports one. */
  embedding?: () => ChatGptDashboardOptions['embedding'];
}

export interface ChatGptToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  _meta?: Record<string, unknown>;
}

/** Every tool here reads the owner's own index; none changes anything or reaches the open web. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** One source_answer handoff budget, as the operation's own description asks callers to pass. */
const SOURCE_ANSWER_TIMEOUT_MS = 600_000;

export const DASHBOARD_TOOL: ChatGptToolDefinition = {
  name: DASHBOARD_TOOL_NAME,
  title: 'Olympus dashboard',
  description: [
    'Show the Olympus dashboard: which of the user\'s sources are connected, how far indexing has got,',
    'what needs the user\'s attention, and whether the models are ready.',
    'Use it when the user asks about Olympus setup, status or progress, or why Olympus could not answer.',
    'Takes no arguments. Read-only.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: READ_ONLY,
  _meta: dashboardToolMeta(),
};

export const SOURCE_ANSWER_TOOL: ChatGptToolDefinition = {
  name: 'source_answer',
  title: 'Ask Olympus',
  description: [
    'Answer a question from the user\'s own sources that Olympus indexes privately on their Mac',
    '(mail, files, notes, chats and saved reading).',
    'Use it whenever the user asks about their own information: what someone wrote, what a document says,',
    'when something happened, what they decided. Do not use it for general knowledge.',
    'Returns {status: "answered", answer, citations[]}: present the answer and cite it with the numbered sources;',
    'if the answer says something could not be found, say so rather than guessing.',
    'If it returns {status: "working", job_id}, the answer is still being prepared: call source_answer_result',
    'with that job_id (again while it says working) instead of asking again.',
    'Ask one question at a time and wait for each answer.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The user\'s question, in their own words, with any names, dates or places they gave.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const SOURCE_ANSWER_RESULT_TOOL: ChatGptToolDefinition = {
  name: 'source_answer_result',
  title: 'Get an Olympus answer',
  description: [
    'Collect the answer to a source_answer call that returned {status: "working", job_id}.',
    'Returns the finished answer with citations, or {status: "working"} again after waiting up to about a minute;',
    'then call it again. A job_id expires about 15 minutes after its answer is ready.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { job_id: { type: 'string', description: 'The job_id from source_answer.' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const SOURCE_STATUS_TOOL: ChatGptToolDefinition = {
  name: 'source_index_status',
  title: 'Olympus source status',
  description: [
    'List each source Olympus indexes with a one-word status (Fresh, Working, Waiting, Needs you, Failing, Off)',
    'and a short line about it. Use it to check whether a source is connected and up to date before or after',
    'an answer. Takes no arguments. For the visual dashboard use olympus_dashboard.',
  ].join(' '),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: READ_ONLY,
};

const ANSWER_TOOLS = [SOURCE_ANSWER_TOOL, SOURCE_ANSWER_RESULT_TOOL] as const;

export function listChatGptTools(ctx: OperationContext): ChatGptToolDefinition[] {
  const tools: ChatGptToolDefinition[] = [DASHBOARD_TOOL, SOURCE_STATUS_TOOL];
  for (const tool of ANSWER_TOOLS) {
    const operation = findOperationByName(tool.name);
    if (operation && shouldExposeOperation(operation, { config: ctx.config, surface: 'remote' })) tools.push(tool);
  }
  return tools;
}

export async function callChatGptTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OperationContext,
  options: ChatGptSurfaceOptions,
  signal?: AbortSignal,
): Promise<ChatGptToolResult> {
  try {
    switch (name) {
      case DASHBOARD_TOOL_NAME:
        return dashboardToolResult(await dashboardViewModel(options, signal));
      case SOURCE_STATUS_TOOL.name:
        return sourceStatusToolResult(await dashboardViewModel(options, signal));
      case SOURCE_ANSWER_TOOL.name: {
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) throw new ChatGptSurfaceError('invalid_params');
        const probe = options.privateMatchProbe ?? defaultPrivateMatchProbe;
        const [raw, privateMatched] = await Promise.all([
          // Public and Personal evidence only: nothing Private, not even a
          // bounded derivative, is answered from on this surface.
          runOperation(SOURCE_ANSWER_TOOL.name, ctx, {
            question,
            include_secure_local: false,
            include_secure_local_content: false,
            timeoutMs: SOURCE_ANSWER_TIMEOUT_MS,
          }),
          probe(question, ctx).catch(() => false),
        ]);
        const jobId = pendingJobId(raw);
        if (jobId) rememberPrivateMatch(jobId, privateMatched);
        return answerToolResult(raw, { privateMatched });
      }
      case SOURCE_ANSWER_RESULT_TOOL.name: {
        const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
        if (!jobId) throw new ChatGptSurfaceError('invalid_params');
        const raw = await runOperation(SOURCE_ANSWER_RESULT_TOOL.name, ctx, { job_id: jobId });
        const privateMatched = privateMatchForJob(jobId, pendingJobId(raw) === undefined);
        return answerToolResult(raw, { privateMatched });
      }
      default:
        throw new ChatGptSurfaceError('unknown_tool');
    }
  } catch (error) {
    return errorToolResult(error);
  }
}

/**
 * Whether a Private item matches: one hit from each Private corpus, searched
 * in the engine. Nothing but the boolean is kept; an unsearchable corpus
 * counts as no match.
 */
export async function defaultPrivateMatchProbe(question: string, ctx: OperationContext): Promise<boolean> {
  const query = question.slice(0, PROBE_QUERY_MAX_CHARS);
  const corpora = createPublicSourceCorpusRegistry(ctx.config.sourceIndex.corpusRegistry)
    .list('search')
    .filter((corpus) => corpus.trustDomain === 'secure_local');
  if (corpora.length === 0) return false;
  const searches = corpora.map((corpus) => ctx.email
    .sourceIndexSearch({ query, corpusId: corpus.corpusId, maxResults: 1, allTiers: false })
    .then((result) => Array.isArray(result.hits) && result.hits.length > 0, () => false));
  const timeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([Promise.all(searches).then((hits) => hits.some(Boolean)), timeout]);
}

const PROBE_QUERY_MAX_CHARS = 500;
const PROBE_TIMEOUT_MS = 20_000;

/** A handed-off answer's probe result, until its source_answer_result collects it. */
const privateMatchByJob = new Map<string, { matched: boolean; expiresAt: number }>();
const PRIVATE_MATCH_TTL_MS = 30 * 60_000;
const PRIVATE_MATCH_MAX_JOBS = 1_000;

function pendingJobId(raw: unknown): string | undefined {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined;
  return record?.status === 'working' && typeof record.job_id === 'string' ? record.job_id : undefined;
}

function rememberPrivateMatch(jobId: string, matched: boolean): void {
  const now = Date.now();
  for (const [id, entry] of privateMatchByJob) if (entry.expiresAt <= now) privateMatchByJob.delete(id);
  while (privateMatchByJob.size >= PRIVATE_MATCH_MAX_JOBS) {
    const oldest = privateMatchByJob.keys().next().value;
    if (oldest === undefined) break;
    privateMatchByJob.delete(oldest);
  }
  privateMatchByJob.set(jobId, { matched, expiresAt: now + PRIVATE_MATCH_TTL_MS });
}

function privateMatchForJob(jobId: string, done: boolean): boolean {
  const entry = privateMatchByJob.get(jobId);
  if (done) privateMatchByJob.delete(jobId);
  return entry !== undefined && entry.expiresAt > Date.now() && entry.matched;
}

async function runOperation(name: string, ctx: OperationContext, params: Record<string, unknown>): Promise<unknown> {
  const operation = findOperationByName(name);
  if (!operation || !shouldExposeOperation(operation, { config: ctx.config, surface: 'remote' })) {
    throw new ChatGptSurfaceError('unknown_tool');
  }
  return operation.handler(ctx, params);
}

async function dashboardViewModel(options: ChatGptSurfaceOptions, signal?: AbortSignal) {
  let view: SourceDashboardViewModel;
  try {
    view = await options.dashboardView(signal);
  } catch {
    throw new ChatGptSurfaceError('unavailable');
  }
  const embedding = options.embedding?.();
  return buildChatGptDashboardViewModel(view, embedding ? { embedding } : {});
}

export function readChatGptResource(uri: string): { contents: Array<Record<string, unknown>> } {
  if (uri !== DASHBOARD_RESOURCE_URI) {
    throw new McpError(ErrorCode.InvalidParams, 'Unknown resource.');
  }
  return {
    contents: [{
      uri: DASHBOARD_RESOURCE.uri,
      mimeType: DASHBOARD_RESOURCE.mimeType,
      text: dashboardResourceHtml(),
      _meta: dashboardResourceMeta(),
    }],
  };
}

/**
 * One MCP server for one request, the way the remote endpoint builds them.
 * `makeOperationContext` carries the connection's caller identity.
 */
export function createChatGptMcpServer(
  makeOperationContext: () => OperationContext,
  options: ChatGptSurfaceOptions,
): Server {
  const server = new Server(
    { name: 'olympus', version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listChatGptTools(makeOperationContext()) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callChatGptTool(request.params.name, request.params.arguments ?? {}, makeOperationContext(), options, extra.signal));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ ...DASHBOARD_RESOURCE }] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => readChatGptResource(request.params.uri));
  return server;
}
