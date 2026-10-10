/**
 * The ChatGPT plugin directory's MCP endpoint, shared by the relay (which
 * answers it without an engine: relay-mcp.ts) and the engine (which serves it:
 * src/workers/chatgpt/directory-surface.ts).
 *
 * A published directory plugin's MCP URL can never change, and OpenAI rescans
 * it daily: a tool listed there reaches directory users without another
 * review. So the directory gets its own permanent endpoint, `/openai/mcp`,
 * next to `/mcp` (developer-mode connectors, and where new tools ship first).
 * Both serve the same implementation; `/openai/mcp` lists and calls only the
 * tools named below. A tool not on this list is absent from its tools/list,
 * and a call to it is answered as an unknown tool. New tools are on `/mcp`
 * only until a deliberate change adds them here.
 *
 * The directory endpoint is its own OAuth protected resource
 * (`<origin>/openai/mcp`, metadata at
 * `/.well-known/oauth-protected-resource/openai/mcp`): a token issued for one
 * of the two resources opens only that one.
 */

export const DIRECTORY_MCP_PATH = '/openai/mcp';

/** Which of the two MCP endpoints a request reached. */
export type McpSurface = 'default' | 'directory';

/**
 * The tools the ChatGPT plugin directory lists, by name. Changing this list
 * changes what directory users get at OpenAI's next scan.
 */
export const DIRECTORY_TOOL_NAMES: readonly string[] = Object.freeze([
  'olympus_dashboard',
  'olympus_search',
  'source_index_status',
  'source_answer',
  'source_answer_result',
  'ask_anonymously',
  'open_private_question',
  'olympus_connect_source',
  'olympus_scope_list',
  'olympus_scope_set',
  'olympus_disconnect_source',
  'olympus_model_set',
  'olympus_model_retry',
  'olympus_privacy_get',
  'olympus_privacy_set',
  'olympus_sync_source',
]);

const DIRECTORY_TOOLS = new Set(DIRECTORY_TOOL_NAMES);

/** Whether a tool is listed and callable on the directory endpoint. */
export function isDirectoryTool(name: unknown): boolean {
  return typeof name === 'string' && DIRECTORY_TOOLS.has(name);
}

/** The tools a surface lists, in their original order: everything on `default`, the allowlist on `directory`. */
export function toolsForSurface<T extends { name: string }>(tools: readonly T[], surface: McpSurface): T[] {
  return surface === 'directory' ? tools.filter((tool) => isDirectoryTool(tool.name)) : [...tools];
}

/** Whether a tool name may be called on a surface (unknown names pass on `default`, where the server answers them). */
export function toolCallableOn(name: unknown, surface: McpSurface): boolean {
  return surface === 'default' || isDirectoryTool(name);
}
