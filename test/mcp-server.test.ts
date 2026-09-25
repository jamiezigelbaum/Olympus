import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { exposedOperations } from '../src/core/operation-exposure.ts';
import { OperationError, operations, type OperationContext } from '../src/core/operations.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import { V0_4_PUBLIC_MCP_TOOLS } from '../src/core/public-surface.ts';

describe('MCP server surface', () => {
  test('lists the fresh-default operation surface minus what only a native session can serve', () => {
    const config = defaultConfig();
    const mcpNames = listMcpTools(config).map((tool) => tool.name);
    const nativeNames = exposedOperations(operations, { config, surface: 'native' })
      .map((operation) => operation.name);

    // The watch operations need the authenticated OpenClaw route, which MCP
    // has no way to mint, so advertising them here was advertising a refusal.
    // source_answer_result is MCP-only: native OpenClaw never hands a slow
    // answer off (see src/core/public-surface.ts).
    expect(mcpNames.filter((name) => name !== 'source_answer_result'))
      .toEqual(nativeNames.filter((name) => !name.startsWith('source_watch')));
    expect(nativeNames).not.toContain('source_answer_result');
    expect(nativeNames).toContain('source_watches');
    expect(mcpNames).not.toContain('source_watches');
    expect(mcpNames).toContain('source_answer');
    expect(mcpNames).toContain('source_index_status');
    expect(mcpNames).toContain('source_index_search');
    // The private tools these once stood against were deleted on 2026-09-18;
    // test/public-surface-guard.test.ts is what keeps the registry equal to the
    // public lists now. What MCP still has to prove is that it advertises the
    // MCP list exactly.
    expect(mcpNames).toEqual([...V0_4_PUBLIC_MCP_TOOLS]);
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

  test('rejects a retired tool name before dispatching to the private worker', async () => {
    // source_index_sync was a real operation MCP refused to advertise until it
    // was deleted on 2026-09-18. A caller that still knows the name must be
    // refused at the dispatcher, without an operation context being built.
    let builtContext = false;
    const ctx = minimalOperationContext({
      email: {
        sourceIndexSync: async () => {
          throw new Error('retired MCP operation reached private worker');
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
      () => {
        builtContext = true;
        return ctx;
      },
    )).rejects.toThrow(OperationError);
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
