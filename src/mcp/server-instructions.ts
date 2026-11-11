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
