/**
 * One conversation of a Claude data export, as a pure function of its parsed
 * record.
 *
 * A conversation is `{uuid, name, created_at, updated_at, chat_messages}` (ISO
 * times), and a message `{uuid, sender, text, content, created_at,
 * attachments, files}`: `sender` is `human` (the owner) or `assistant`
 * (Claude), `text` the message's words, and `content`, where the export has
 * it, the same message as blocks (`{type: "text", text}`, and Claude's
 * thinking and tool use beside them). The messages are read in the order the
 * export lists them.
 *
 * - Read: the text blocks of a message's `content`; a message with none reads
 *   its `text`.
 * - Left out, as not part of what was shown: thinking, tool calls and their
 *   results.
 * - Attachments and files are not imported; the text names each one.
 * - A message from a sender this reader does not know, or with neither text
 *   nor blocks it can read, is counted as not read (`unsupported`).
 */
import { idText, isRecord, isoTime, type NoteOutcome } from '../notes/note.ts';
import { conversationNote, type ConversationTurn } from './conversation.ts';

export const CLAUDE_ASSISTANT_LABEL = 'Claude';

/** Blocks that are not part of the conversation as shown: left out without a word. */
const UNSHOWN_BLOCKS = new Set(['thinking', 'redacted_thinking', 'tool_use', 'tool_result', 'server_tool_use', 'web_search_tool_result', 'token_budget']);

/** The names of the files a message carried, as one line each. */
function attachmentLines(message: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const key of ['attachments', 'files'] as const) {
    const list = message[key];
    if (!Array.isArray(list)) continue;
    for (const file of list) {
      const name = isRecord(file) && typeof file.file_name === 'string' && file.file_name.trim() !== '' ? file.file_name.trim() : undefined;
      lines.push(name ? `[Attached file ${name}; it was not imported.]` : '[An attached file; it was not imported.]');
    }
  }
  return lines;
}

/** A message's words from its blocks, or undefined when it has no list of blocks or no text block in it. */
function blocksText(content: unknown): { text: string | undefined; unsupported: boolean } {
  if (!Array.isArray(content)) return { text: undefined, unsupported: false };
  const pieces: string[] = [];
  let unsupported = false;
  for (const block of content) {
    if (!isRecord(block)) {
      unsupported = true;
    } else if (block.type === 'text' && typeof block.text === 'string') {
      pieces.push(block.text);
    } else if (!(typeof block.type === 'string' && UNSHOWN_BLOCKS.has(block.type))) {
      unsupported = true;
    }
  }
  return { text: pieces.length > 0 ? pieces.join('\n\n') : undefined, unsupported };
}

/** One record of a Claude export's conversations as a note, an empty conversation, or no conversation at all. */
export function parseClaudeConversation(record: unknown): NoteOutcome {
  if (!isRecord(record)) return { kind: 'unreadable' };
  const messages = record.chat_messages;
  if (messages !== undefined && messages !== null && !Array.isArray(messages)) return { kind: 'unsupported' };
  const turns: ConversationTurn[] = [];
  let unsupported = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isRecord(message) || (message.sender !== 'human' && message.sender !== 'assistant')) {
      unsupported += 1;
      continue;
    }
    const blocks = blocksText(message.content);
    const words = blocks.text ?? (typeof message.text === 'string' ? message.text : undefined);
    // Neither a text block nor text: unread, unless the blocks said only what is not shown.
    if (words === undefined && (blocks.unsupported || !Array.isArray(message.content))) unsupported += 1;
    else if (blocks.unsupported) unsupported += 1;
    const text = [words ?? '', ...attachmentLines(message)].filter((part) => part.trim() !== '').join('\n');
    turns.push({ speaker: message.sender === 'human' ? 'owner' : 'assistant', text });
  }
  return conversationNote({
    key: idText(record.uuid),
    title: record.name,
    createdAt: isoTime(record.created_at),
    updatedAt: isoTime(record.updated_at),
    turns,
    unsupported,
  }, CLAUDE_ASSISTANT_LABEL);
}
