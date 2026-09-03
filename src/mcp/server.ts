import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../core/config.ts';
import { createDelphiTransport, DelphiClient } from '../core/delphi.ts';
import { createEmailTransport, EmailClient } from '../core/email.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
import { createFileDeliveryTransport, FileDeliveryClient } from '../core/file-delivery.ts';
import { createCastorWorkspaceTransport, CastorWorkspaceClient } from '../core/castor-workspace.ts';
import { createDomainExpertTransport, DomainExpertClient } from '../core/domain-expert-client.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
import { shouldExposeOperation } from '../core/operation-exposure.ts';
import { findOperationByName, operations, OperationError } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { listMcpTools } from './tools.ts';

interface McpCallToolRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown> | undefined;
  };
}

export async function handleMcpCallTool(
  request: McpCallToolRequest,
  makeOperationContext: () => OperationContext = makeContext,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const operation = findOperationByName(request.params.name);
  if (!operation) {
    throw new OperationError('invalid_params', `Unknown Olympus operation: ${request.params.name}`);
  }
  const ctx = makeOperationContext();
  if (!shouldExposeOperation(operation, { config: ctx.config, surface: 'mcp' })) {
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
    return handleMcpCallTool(request);
  });

  await server.connect(new StdioServerTransport());
}

function makeContext(): OperationContext {
  const config = loadConfig();
  return {
    config,
    delphi: new DelphiClient(config, createDelphiTransport(config)),
    email: new EmailClient(config, createEmailTransport(config)),
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
    fileDelivery: new FileDeliveryClient(config, createFileDeliveryTransport(config)),
    castorWorkspace: new CastorWorkspaceClient(config, createCastorWorkspaceTransport(config)),
    domainExpert: new DomainExpertClient(config, createDomainExpertTransport(config)),
    // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
  };
}
