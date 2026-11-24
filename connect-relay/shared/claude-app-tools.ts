import remoteCatalog from '../server/generated/remote-tools.json';
import { appClientCopy, type McpAppClient } from './mcp-app-client.ts';

interface ApprovalFields {
  name: string;
  description: string;
  inputSchema: object;
}

const CLAUDE_COMPATIBLE_TOOLS = new Set(['olympus_search', 'source_answer_result', 'source_index_status', 'ask_anonymously']);

/**
 * Claude used the remote catalog before it gained the App. Keep its approved
 * definitions where the original arguments still work, along with the App's
 * titles, annotations and panel metadata. Apply this after the host copy.
 */
export function claudeAppTools<T extends ApprovalFields>(
  tools: readonly T[],
  client: McpAppClient,
  liveRemoteTools: readonly ApprovalFields[] = [],
): T[] {
  return tools.map(tool => {
    const copy = appClientCopy(tool, client);
    if (!CLAUDE_COMPATIBLE_TOOLS.has(copy.name)) return copy;
    // The engine knows the install's corpus registry. Offline the relay only
    // has the default catalog, as it did before Claude gained the App.
    const remote = liveRemoteTools.find(candidate => candidate.name === copy.name)
      ?? remoteCatalog.tools.find(candidate => candidate.name === copy.name);
    if (!remote) throw new Error(`Missing remote tool definition for ${copy.name}`);
    return { ...copy, description: remote.description, inputSchema: remote.inputSchema };
  });
}
