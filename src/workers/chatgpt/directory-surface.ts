/**
 * The ChatGPT surface as the plugin directory's endpoint (`/openai/mcp`)
 * serves it: the listing submitted to OpenAI
 * (connect-relay/server/directory/approved.ts), with every call answered by
 * the current surface (mcp-surface.ts).
 *
 * OpenAI reviews, and after approval rescans daily, what this endpoint lists.
 * So tools/list and the UI resources are the submitted ones, byte for byte,
 * whatever the engine's current source generates for `/mcp`: an engine
 * release cannot change the directory listing by accident, and the relay's
 * own answers on this endpoint (Mac offline, no token) are the same listing.
 *
 * Which tools are listed is still the surface's own decision, narrowed to the
 * directory allowlist (connect-relay/shared/directory-tools.ts), so every
 * conditional listing (source_answer only with an answer model, read-only
 * tools for a demo grant) behaves identically on both endpoints; each listed
 * tool is then served as submitted. A tool off the allowlist, or not in the
 * submitted listing, is not listed, and a call to it gets exactly the
 * surface's unknown-tool result.
 *
 * Calls run the current code. A result that names a UI resource names the
 * submitted one, so the page that renders it is the submitted page. The
 * submitted private answer panel predates acknowledgments, so a Private
 * answer it collects counts as seen when it is handed over
 * (`privateAnswerSeenOnDelivery`); otherwise every answer shown there would
 * also wait on the computer.
 * test/chatgpt-directory-approved.test.ts holds the current handlers to the
 * submitted input schemas and annotations, and runs the submitted pages
 * against current results.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  APPROVED_DASHBOARD_CONTENTS,
  APPROVED_PRIVATE_ANSWER_CONTENTS,
  APPROVED_PRIVATE_QUESTION_CONTENTS,
  APPROVED_RESOURCES,
  APPROVED_TOOLS,
} from '../../../connect-relay/server/directory/approved.ts';
import { isDirectoryTool } from '../../../connect-relay/shared/directory-tools.ts';
import type { OperationContext } from '../../core/operations.ts';
import { DASHBOARD_RESOURCE_URI, type DashboardViewModelV1 } from './dashboard-contract.ts';
import { matchesResourceUri } from './dashboard-resource.ts';
import { callChatGptTool, createChatGptMcpServer, listChatGptTools, type ChatGptSurfaceOptions } from './mcp-surface.ts';
import { PRIVATE_ANSWER_RESOURCE_URI } from './private-answer-contract.ts';
import { PRIVATE_QUESTION_RESOURCE_URI } from './private-question-contract.ts';
import { ChatGptSurfaceError, dashboardForApprovedPage, errorToolResult, type ChatGptToolResult } from './response-builder.ts';

/** The submitted tool definitions, by name. */
const APPROVED_TOOL_BY_NAME: ReadonlyMap<string, (typeof APPROVED_TOOLS)[number]> = new Map(APPROVED_TOOLS.map((tool) => [tool.name, tool]));

/** Each UI resource the directory serves: its bare URI, the submitted versioned URI, and the submitted resources/read contents. */
const APPROVED_PAGES = [
  { base: DASHBOARD_RESOURCE_URI, contents: APPROVED_DASHBOARD_CONTENTS },
  { base: PRIVATE_ANSWER_RESOURCE_URI, contents: APPROVED_PRIVATE_ANSWER_CONTENTS },
  { base: PRIVATE_QUESTION_RESOURCE_URI, contents: APPROVED_PRIVATE_QUESTION_CONTENTS },
].map((page) => {
  const uri = page.contents[0]?.uri;
  if (typeof uri !== 'string' || !matchesResourceUri(uri, page.base) || !APPROVED_RESOURCES.some((resource) => resource.uri === uri)) {
    throw new Error(`approved directory listing has no page for ${page.base}`);
  }
  return { ...page, uri };
});

/** The submitted page for a resource URI (any version of it, or the bare URI). */
function approvedPage(uri: unknown): (typeof APPROVED_PAGES)[number] | undefined {
  return typeof uri === 'string' ? APPROVED_PAGES.find((page) => matchesResourceUri(uri, page.base)) : undefined;
}

/** Name the submitted page and adapt its dashboard's unmeasured progress vocabulary. */
export function withApprovedPages(result: ChatGptToolResult): ChatGptToolResult {
  // Dashboard calls inherit their page URI from tools/list; the result itself
  // need not carry UI metadata. Identify the allowlisted dashboard payload.
  const structured = result.structuredContent;
  if (structured?.v === 1 && Array.isArray(structured.sources)) {
    result = { ...result, structuredContent: dashboardForApprovedPage(structured as unknown as DashboardViewModelV1) as unknown as Record<string, unknown> };
  }
  const meta = result._meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return result;
  const next: Record<string, unknown> = { ...meta };
  const template = approvedPage(next['openai/outputTemplate']);
  if (template) next['openai/outputTemplate'] = template.uri;
  const ui = next.ui;
  if (typeof ui === 'object' && ui !== null && !Array.isArray(ui)) {
    const page = approvedPage((ui as Record<string, unknown>).resourceUri);
    if (page) next.ui = { ...ui, resourceUri: page.uri };
  }
  return { ...result, _meta: next };
}

export function createChatGptDirectoryMcpServer(
  makeOperationContext: () => OperationContext,
  options: ChatGptSurfaceOptions,
  makeDetachedContext?: () => OperationContext,
  /** The directory allowlist (always isDirectoryTool in the worker; a test may narrow it). */
  allowed: (name: string) => boolean = isDirectoryTool,
): Server {
  options = { ...options, privateAnswerSeenOnDelivery: true };
  const served = (name: string) => allowed(name) && APPROVED_TOOL_BY_NAME.has(name);
  const server = createChatGptMcpServer(makeOperationContext, options, makeDetachedContext);
  // Replaces the surface's tool and resource handlers: its decisions, the submitted listing.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const listed = new Set(listChatGptTools(makeOperationContext(), options).map((tool) => tool.name));
    return { tools: APPROVED_TOOLS.filter((tool) => listed.has(tool.name) && served(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!served(request.params.name)) return errorToolResult(new ChatGptSurfaceError('unknown_tool'));
    return withApprovedPages(await callChatGptTool(
      request.params.name,
      request.params.arguments ?? {},
      makeOperationContext(),
      options,
      extra.signal,
      makeDetachedContext,
    ));
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: APPROVED_RESOURCES.map((resource) => ({ ...resource })) }));
  // Any version of a page's URI, or its bare URI, reads the submitted page, exactly as the relay serves it.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const page = approvedPage(request.params.uri);
    if (!page) throw new McpError(ErrorCode.InvalidParams, 'Unknown resource.');
    return { contents: page.contents.map((content) => ({ ...content })) };
  });
  return server;
}
