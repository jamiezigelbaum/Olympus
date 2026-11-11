// Claude can load connector tools on demand and miss them for an everyday question (#1266). The /mcp surfaces send
// instructions that say when to use Olympus; ChatGPT's surfaces and the directory path send none.
import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { defaultConfig } from '../src/core/config.ts';
import { createOlympusMcpServer } from '../src/mcp/server.ts';
import { OLYMPUS_SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions.ts';
import { createChatGptDirectoryMcpServer } from '../src/workers/chatgpt/directory-surface.ts';
import { createChatGptMcpServer } from '../src/workers/chatgpt/mcp-surface.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';

const ctx = () => createInProcessOperationContext({ config: defaultConfig(), sourceIndexReadEnabled: true, caller: { surface: 'remote', connectionId: 'test' } });

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
    expect(await instructions(createChatGptMcpServer(ctx, { appClient: { host: 'claude', connectorUrl: 'https://example.com/mcp' } }))).toBe(OLYMPUS_SERVER_INSTRUCTIONS);
    expect(OLYMPUS_SERVER_INSTRUCTIONS).toContain('olympus_search');
    expect(OLYMPUS_SERVER_INSTRUCTIONS).toContain('source_answer');
    expect(OLYMPUS_SERVER_INSTRUCTIONS).toContain('search your tools for "Olympus"');
  });

  test('ChatGPT\'s surface and the directory path send none', async () => {
    expect(await instructions(createChatGptMcpServer(ctx, {}))).toBeUndefined();
    expect(await instructions(createChatGptDirectoryMcpServer(ctx, {}))).toBeUndefined();
  });
});
