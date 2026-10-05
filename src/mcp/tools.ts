import type { OlympusConfig } from '../core/config.ts';
import { exposedOperations, type OperationSurface } from '../core/operation-exposure.ts';
import { operations, operationDescription, operationToolSchema } from '../core/operations.ts';

export function listMcpTools(config: OlympusConfig, surface: Extract<OperationSurface, 'mcp' | 'remote'> = 'mcp'): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}> {
  return exposedOperations(operations, { config, surface }).map((operation) => ({
    name: operation.name,
    description: operationDescription(operation, { config }),
    inputSchema: operationToolSchema(operation, { config }),
    // Explicit hints (ChatGPT review asks for all three). Olympus tools read
    // or act on the owner's own index and models, never the open web; none
    // deletes anything.
    annotations: {
      readOnlyHint: !operation.mutating,
      destructiveHint: false,
      openWorldHint: false,
    },
  }));
}
