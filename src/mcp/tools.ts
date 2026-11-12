import type { OlympusConfig } from '../core/config.ts';
import { exposedOperations, type OperationSurface } from '../core/operation-exposure.ts';
import { operations, operationDescription, operationToolSchema } from '../core/operations.ts';
import { remoteToolDescription, remoteToolSchema } from '../core/remote-result.ts';

export function listMcpTools(
  config: OlympusConfig,
  surface: Extract<OperationSurface, 'mcp' | 'remote'> = 'mcp',
  options: { remoteReadHandles?: boolean } = {},
): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}> {
  // A live remote handler owns the handle map. The relay's offline listing
  // has no map and cannot serve reads; keep that generated listing unchanged.
  const listed = exposedOperations(operations, { config, surface })
    .filter(operation => surface !== 'remote' || operation.name !== 'source_item_read' || options.remoteReadHandles === true);
  return listed.map((operation) => ({
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
    // or act on the owner's own index and models; none deletes anything
    // (archive_import only asks: the owner approves on the dashboard).
    // Only ask_anonymously reaches a provider outside (openWorld).
    annotations: {
      readOnlyHint: !operation.mutating,
      destructiveHint: false,
      openWorldHint: operation.openWorld === true,
    },
  }));
}
