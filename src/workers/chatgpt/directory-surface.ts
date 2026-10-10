/**
 * The ChatGPT surface as the plugin directory's endpoint (`/openai/mcp`)
 * serves it: the same server as `/mcp` (mcp-surface.ts), with tools/list and
 * tools/call narrowed to the directory allowlist
 * (connect-relay/shared/directory-tools.ts).
 *
 * Narrowing happens after the surface's own decisions, so every conditional
 * listing (source_answer only with an answer model, read-only tools for a
 * demo grant) behaves identically on both endpoints. A tool off the allowlist
 * is not listed, and a call to it gets exactly the surface's unknown-tool
 * result. Resources (the dashboard and private panels) are served unchanged.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isDirectoryTool } from '../../../connect-relay/shared/directory-tools.ts';
import type { OperationContext } from '../../core/operations.ts';
import { callChatGptTool, createChatGptMcpServer, listChatGptTools, type ChatGptSurfaceOptions } from './mcp-surface.ts';
import { ChatGptSurfaceError, errorToolResult } from './response-builder.ts';

export function createChatGptDirectoryMcpServer(
  makeOperationContext: () => OperationContext,
  options: ChatGptSurfaceOptions,
  makeDetachedContext?: () => OperationContext,
  /** The directory allowlist (always isDirectoryTool in the worker; a test may narrow it). */
  allowed: (name: string) => boolean = isDirectoryTool,
): Server {
  const server = createChatGptMcpServer(makeOperationContext, options, makeDetachedContext);
  // Replaces the surface's own two tool handlers with the same calls, narrowed.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listChatGptTools(makeOperationContext(), options).filter((tool) => allowed(tool.name)),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!allowed(request.params.name)) return errorToolResult(new ChatGptSurfaceError('unknown_tool'));
    return callChatGptTool(request.params.name, request.params.arguments ?? {}, makeOperationContext(), options, extra.signal, makeDetachedContext);
  });
  return server;
}
