/**
 * The AI conversation archive connectors: one item per conversation, from
 * ChatGPT's data export and from Claude's (a zip holding `conversations.json`,
 * or that file, or the unzipped folder). The reading, paging and resume are
 * the notes engine's (`notes/archive.ts`), which reads a JSON list of records
 * from a file or a zip; this file says where each export keeps its
 * conversations (a top-level list) and how one becomes an item (`chatgpt.ts`,
 * `claude.ts`).
 *
 * - A conversation is kept whole, every turn under its speaker's name, up to
 *   the size the engine reads a record to (NOTE_MAX_RECORD_BYTES); a bigger
 *   one is reported as too large, never cut.
 * - The owner is the conversation's sender (`senderIsOwner`); the assistant's
 *   words are in the text under its name.
 * - The export's other files (pictures, its other JSON lists, its HTML copy)
 *   are not read, and are counted as such.
 * - No prior is published: each conversation gets its tier from the privacy
 *   settings and the judge, and is held Private until judged.
 */
import {
  acceptsChatGptJson,
  acceptsClaudeJson,
  registerArchiveFormatConnector,
  type ArchiveConnectorInput,
} from '../../../core/archive-formats.ts';
import type { SourceConnector } from '../../../core/contracts.ts';
import { createNoteArchiveConnector, type NoteArchiveSpec } from '../notes/archive.ts';
import { parseChatGptConversation } from './chatgpt.ts';
import { parseClaudeConversation } from './claude.ts';

export const CHATGPT_CURSOR_PREFIX = 'chatgpt1:';
export const CLAUDE_CURSOR_PREFIX = 'claude1:';

// Only a list of conversations is either export; any other document is reported, not guessed at.
const listOnly = (root: 'array' | 'object') => (root === 'array' ? [[]] : undefined);

const CHATGPT_SPEC: NoteArchiveSpec = {
  cursorPrefix: CHATGPT_CURSOR_PREFIX,
  source: { kind: 'json', itemPaths: listOnly, accepts: acceptsChatGptJson, parse: parseChatGptConversation },
};

const CLAUDE_SPEC: NoteArchiveSpec = {
  cursorPrefix: CLAUDE_CURSOR_PREFIX,
  source: { kind: 'json', itemPaths: listOnly, accepts: acceptsClaudeJson, parse: parseClaudeConversation },
};

export function createChatGptArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  return createNoteArchiveConnector(input, CHATGPT_SPEC);
}

export function createClaudeArchiveConnector(input: ArchiveConnectorInput): SourceConnector {
  return createNoteArchiveConnector(input, CLAUDE_SPEC);
}

/** Registers the ChatGPT and Claude connectors with the format registry. Idempotent. */
export function registerAiChatArchiveConnectors(): void {
  registerArchiveFormatConnector('chatgpt-export', createChatGptArchiveConnector);
  registerArchiveFormatConnector('claude-export', createClaudeArchiveConnector);
}
