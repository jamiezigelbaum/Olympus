import type { OlympusConfig } from '../core/config.ts';
import { exposedOperations } from '../core/operation-exposure.ts';
import { operations, operationDescription, operationToolSchema } from '../core/operations.ts';

export function listMcpTools(config: OlympusConfig): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return exposedOperations(operations, { config, surface: 'mcp' }).map((operation) => ({
    name: operation.name,
    description: operationDescription(operation, { config }),
    inputSchema: operationToolSchema(operation, { config }),
  }));
}
