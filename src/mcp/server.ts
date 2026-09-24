import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../core/config.ts';
import { createDelphiTransport, DelphiClient } from '../core/delphi.ts';
import { createEmailTransport, EmailClient } from '../core/email.ts';
import { sanitizeCallerDisplayName, type OperationCaller } from '../core/operation-caller.ts';
import { shouldExposeOperation, type OperationSurface } from '../core/operation-exposure.ts';
import { findOperationByName, operations, OperationError } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { listMcpTools } from './tools.ts';

type McpSurface = Extract<OperationSurface, 'mcp' | 'remote'>;

interface McpCallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown> | undefined;
  };
}

export async function handleMcpCallTool(
  request: McpCallToolRequest,
  makeOperationContext: () => OperationContext = makeContext,
  surface: McpSurface = 'mcp',
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const operation = findOperationByName(request.params.name);
  if (!operation) {
    throw new OperationError('invalid_params', `Unknown Olympus operation: ${request.params.name}`);
  }
  const ctx = makeOperationContext();
  if (!shouldExposeOperation(operation, { config: ctx.config, surface })) {
    throw new OperationError(
      'invalid_params',
      `Olympus operation is not available on this MCP surface: ${operation.name}`,
      'Enable the matching product or operator configuration for this Olympus surface.',
    );
  }
  const result = await operation.handler(ctx, request.params.arguments ?? {});
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * An MCP server for one surface over an already-built operation context. The
 * remote endpoint builds one per HTTP request, with the connection's caller
 * identity already on the context.
 */
export function createOlympusMcpServer(
  surface: McpSurface,
  makeOperationContext: () => OperationContext,
): Server {
  const server = new Server(
    { name: 'olympus', version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listMcpTools(makeOperationContext().config, surface),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    handleMcpCallTool(request, makeOperationContext, surface));
  return server;
}

export async function serve(): Promise<void> {
  const server = new Server(
    {
      name: 'olympus',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: listMcpTools(loadConfig()),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // The stdio client names itself during initialize (e.g. "claude-code").
    // Self-reported, so it is an audit label only, never an authorization.
    return handleMcpCallTool(request, () => makeContext(server.getClientVersion()?.name));
  });

  await server.connect(new StdioServerTransport());
}

/** The stdio MCP caller identity; the client's self-reported name is a label only. */
export function mcpOperationCaller(clientName?: string): OperationCaller {
  const displayName = sanitizeCallerDisplayName(clientName);
  return { surface: 'mcp', ...(displayName ? { displayName } : {}) };
}

function makeContext(clientName?: string): OperationContext {
  const config = loadConfig();
  return {
    config,
    delphi: new DelphiClient(config, createDelphiTransport(config)),
    email: new EmailClient(config, createEmailTransport(config)),
    caller: mcpOperationCaller(clientName),
  };
}
