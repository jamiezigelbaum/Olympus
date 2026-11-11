// Claude can load connector tools on demand and miss them for an everyday question (#1266). The /mcp surfaces send
// instructions that say when to use Olympus; ChatGPT's surfaces and the directory path send none.
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { defaultConfig } from '../src/core/config.ts';
import { createOlympusMcpServer } from '../src/mcp/server.ts';
import { OLYMPUS_SEARCH_WORDS, OLYMPUS_SERVER_INSTRUCTIONS, withOlympusSearchWords } from '../src/mcp/server-instructions.ts';
import { createChatGptDirectoryMcpServer } from '../src/workers/chatgpt/directory-surface.ts';
import { createChatGptMcpServer, listChatGptTools } from '../src/workers/chatgpt/mcp-surface.ts';
import { REMOTE_SEARCH_TOOL, remoteSearchExtension } from '../src/workers/remote-search.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';

const view = { dashboardView: async () => ({ sources: [] }) as never };
const ctx = () => createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, workerFetch: async () => new Response(null, { status: 404 }), caller: { surface: 'remote', connectionId: 'test' } });

async function instructions(server: Server): Promise<string | undefined> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'instructions-test', version: '1.0.0' });
  await client.connect(clientSide);
  try { return client.getInstructions(); } finally { await client.close(); }
}

describe('MCP server instructions', () => {
  test('the remote surface and Claude\'s app surface say when to use Olympus and how to find its tools', async () => {
    expect(await instructions(createOlympusMcpServer('remote', ctx))).toBe(OLYMPUS_SERVER_INSTRUCTIONS);
    expect(await instructions(createChatGptMcpServer(ctx, { ...view, appClient: { host: 'claude', connectorUrl: 'https://example.com/mcp' } }))).toBe(OLYMPUS_SERVER_INSTRUCTIONS);
    expect(OLYMPUS_SERVER_INSTRUCTIONS).toContain('olympus_search');
    expect(OLYMPUS_SERVER_INSTRUCTIONS).toContain('source_answer');
    expect(OLYMPUS_SERVER_INSTRUCTIONS).toContain('search your tools for "Olympus source answer olympus_search"');
  });

  test('ChatGPT\'s surface and the directory path send none', async () => {
    expect(await instructions(createChatGptMcpServer(ctx, view))).toBeUndefined();
    expect(await instructions(createChatGptDirectoryMcpServer(ctx, view))).toBeUndefined();
  });

  test('Claude\'s tool listing starts each model-visible description with the words a search for Olympus would use', () => {
    const claude = listChatGptTools(ctx(), { appClient: { host: 'claude', connectorUrl: 'https://example.com/mcp' } });
    const modelVisible = claude.filter((tool) => {
      const visibility = (tool._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility;
      return !visibility || visibility.includes('model');
    });
    expect(modelVisible.length).toBeGreaterThan(0);
    for (const tool of modelVisible) expect(tool.description?.startsWith(`${OLYMPUS_SEARCH_WORDS} `)).toBe(true);
    for (const tool of claude.filter((one) => !modelVisible.includes(one))) expect(tool.description?.startsWith(OLYMPUS_SEARCH_WORDS)).toBe(false);
    for (const tool of listChatGptTools(ctx(), {})) expect(tool.description?.startsWith(OLYMPUS_SEARCH_WORDS)).toBe(false);
  });

  test('the remote surface\'s search and operation tools carry the same words, once', () => {
    const extension = remoteSearchExtension({ evidenceSearch: async () => ({ evidence: [] }) }, () => 'active');
    const listed = extension.tools!([{ name: 'source_answer', description: 'Ask.', inputSchema: { type: 'object' } } as never]);
    expect(listed.map((tool) => tool.name)).toEqual([REMOTE_SEARCH_TOOL.name, 'source_answer']);
    for (const tool of listed) expect(tool.description?.startsWith(`${OLYMPUS_SEARCH_WORDS} `)).toBe(true);
    expect(withOlympusSearchWords(listed[0]!).description).toBe(listed[0]!.description);
  });
});
