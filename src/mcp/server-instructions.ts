/**
 * MCP `instructions` for the connectors whose hosts may load tools on demand (Claude on `/mcp`). A host that
 * indexes tools and loads them only when a search finds them can miss Olympus for an everyday question; these
 * instructions say when to reach for Olympus and how to find its tools (#1266). ChatGPT's surfaces and the
 * directory path send none, so what reviewers see does not change.
 */
export const OLYMPUS_SERVER_INSTRUCTIONS = [
  'Olympus searches the user\'s own sources that it indexes privately on their computer (mail, files, notes, chats and saved reading).',
  'Use it whenever the user asks about their own information: what someone wrote or sent, what a document says, when something happened,',
  'what they decided, their plans, people, places and money. olympus_search returns the evidence; source_answer answers from their computer.',
  'If Olympus\'s tools are not loaded in this chat, search your tools for "Olympus source answer olympus_search" (a search for "Olympus" alone can come back empty) before saying you cannot reach it.',
  'Do not use it for general knowledge.',
].join(' ');

/**
 * The words a tool search would use for Olympus, put first in each model-visible tool's description on `/mcp`.
 * Claude's tool search found nothing for "Olympus" or "olympus search email files documents" while Olympus's
 * tools were listed, and found them for "source answer" (traces, 2026-11-11). Only `/mcp` gets it; the
 * pinned `/openai/mcp` listing does not change.
 */
export const OLYMPUS_SEARCH_WORDS = 'Olympus: private search and answers over the user\'s own email, messages, files, documents and notes.';

/** The tool with OLYMPUS_SEARCH_WORDS before its description, unless only the app panel sees it. */
export function withOlympusSearchWords<T extends { description?: string; _meta?: unknown }>(tool: T): T {
  const visibility = (tool._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  if (Array.isArray(visibility) && !visibility.includes('model')) return tool;
  if (tool.description?.startsWith(OLYMPUS_SEARCH_WORDS)) return tool;
  return { ...tool, description: tool.description ? `${OLYMPUS_SEARCH_WORDS} ${tool.description}` : OLYMPUS_SEARCH_WORDS };
}
