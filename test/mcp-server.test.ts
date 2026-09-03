import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { OperationError, operations, type OperationContext } from '../src/core/operations.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { listMcpTools } from '../src/mcp/tools.ts';

describe('MCP server surface', () => {
  test('lists the fresh-default operation surface minus what only a native session can serve', () => {
    const config = defaultConfig();
    const mcpNames = listMcpTools(config).map((tool) => tool.name);
    const nativeNames = exposedOperations(operations, { config, surface: 'native' })
      .map((operation) => operation.name);

    // The watch operations need the authenticated OpenClaw route, which MCP
    // has no way to mint, so advertising them here was advertising a refusal.
    expect(mcpNames).toEqual(nativeNames.filter((name) => !name.startsWith('source_watch')));
    expect(nativeNames).toContain('source_watches');
    expect(mcpNames).not.toContain('source_watches');
    expect(mcpNames).toContain('source_answer');
    expect(mcpNames).toContain('source_index_status');
    expect(mcpNames).toContain('source_index_search');
    expect(mcpNames).not.toContain('source_index_sync');
    expect(mcpNames).not.toContain('source_export');
    expect(mcpNames).not.toContain('source_transcribe');
    expect(mcpNames).not.toContain('source_media_ingest');
  });

  test('uses sanitized operation schemas on the MCP surface', () => {
    const sourceAnswer = listMcpTools(defaultConfig()).find((tool) => tool.name === 'source_answer');

    expect(sourceAnswer).toBeDefined();
    expect(sourceAnswer!.description).toContain('calling-assistant-safe');
    expect(JSON.stringify(sourceAnswer!.inputSchema)).not.toContain('OAuth');
    expect(JSON.stringify(sourceAnswer!.inputSchema)).not.toContain('token');
  });

  test('rejects unknown tool calls before constructing operation context', async () => {
    let builtContext = false;

    await expect(handleMcpCallTool(
      { params: { name: 'source_index_hidden_admin' } },
      () => {
        builtContext = true;
        return minimalOperationContext();
      },
    )).rejects.toThrow('Unknown Olympus operation: source_index_hidden_admin');

    expect(builtContext).toBe(false);
  });

  test('rejects hidden tool calls before dispatching to private worker', async () => {
    const ctx = minimalOperationContext({
      email: {
        sourceIndexSync: async () => {
          throw new Error('hidden MCP operation reached private worker');
        },
      } as unknown as OperationContext['email'],
    });

    await expect(handleMcpCallTool(
      {
        params: {
          name: 'source_index_sync',
          arguments: { corpus_id: 'secure_local.dropbox.files' },
        },
      },
      () => ctx,
    )).rejects.toThrow(OperationError);
  });
});

function minimalOperationContext(
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    config: defaultConfig(),
    delphi: {} as OperationContext['delphi'],
    email: {} as OperationContext['email'],
    ...overrides,
  };
}
