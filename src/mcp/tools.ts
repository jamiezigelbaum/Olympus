import type { OlympusConfig } from '../core/config.ts';
import { exposedOperations, type OperationSurface } from '../core/operation-exposure.ts';
import { operations, operationDescription, operationToolSchema } from '../core/operations.ts';
import { remoteToolDescription, remoteToolSchema } from '../core/remote-result.ts';

export function listMcpTools(config: OlympusConfig, surface: Extract<OperationSurface, 'mcp' | 'remote'> = 'mcp'): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}> {
  return exposedOperations(operations, { config, surface }).map((operation) => ({
    name: operation.name,
    // The remote surface leaves out the parameters it does not serve
    // (core/remote-result.ts REMOTE_WITHHELD_PARAMS); local surfaces are unchanged.
    description: surface === 'remote'
      ? remoteToolDescription(operation.name, operationDescription(operation, { config }))
      : operationDescription(operation, { config }),
    inputSchema: surface === 'remote'
      ? remoteToolSchema(operation.name, operationToolSchema(operation, { config }))
      : operationToolSchema(operation, { config }),
    // Explicit hints (ChatGPT review asks for all three). Olympus tools read
    // or act on the owner's own index and models; none deletes anything.
    // Only ask_anonymously reaches a provider outside (openWorld).
    annotations: {
      readOnlyHint: !operation.mutating,
      destructiveHint: false,
      openWorldHint: operation.openWorld === true,
    },
  }));
}
