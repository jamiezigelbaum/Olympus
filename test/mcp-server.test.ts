import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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
    expect(mcpNames).toEqual([
      'argus_ping',
      'argus_list_models',
      'argus_complete',
      'source_answer',
      'source_index_status',
      'source_index_search',
      'olympus_doctor',
    ]);
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

  test('rejects removed operations before constructing operation context', async () => {
    let builtContext = false;

    await expect(handleMcpCallTool(
      {
        params: {
          name: 'source_index_sync',
          arguments: { corpus_id: 'secure_local.dropbox.files' },
        },
      },
      () => {
        builtContext = true;
        return minimalOperationContext();
      },
    )).rejects.toThrow('Unknown Olympus operation: source_index_sync');

    expect(builtContext).toBe(false);
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
