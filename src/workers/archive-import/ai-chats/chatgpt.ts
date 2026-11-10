/**
 * One conversation of a ChatGPT data export, as a pure function of its parsed
 * record.
 *
 * A conversation is `{title, create_time, update_time, mapping, current_node,
 * conversation_id?, id?}` (times in seconds). `mapping` is a graph of nodes
 * `{id, message, parent, children}`: every branch the conversation ever took
 * (an edited prompt, a regenerated reply) is in it. What the person saw is the
 * thread from `current_node` back through `parent` to the root, so only that
 * thread is read, in order. A node's `message` is `{author: {role}, content:
 * {content_type, parts | text}, recipient, metadata, create_time}` or null.
 *
 * - Read: the owner's (`user`) and ChatGPT's (`assistant`) messages addressed
 *   to the conversation (`recipient` "all" or none), in `text` and
 *   `multimodal_text` content (the string parts, and a part that is an object
 *   with its own `text`), and code ChatGPT showed (`code`).
 * - Left out, as not part of what was shown: system and tool messages, calls
 *   to a tool (any other `recipient`), messages the export marks hidden
 *   (`metadata.is_visually_hidden_from_conversation`), and ChatGPT's thinking,
 *   browsing and custom-instruction content (`thoughts`, `reasoning_recap`,
 *   `user_editable_context`, ...).
 * - Pictures (an image part) are not imported; the text says one was there.
 * - A message of a content type this reader has no rule for and no text in
 *   it, or a graph it cannot follow, is counted as not read (`unsupported`).
 */
import { idText, isRecord, isoTime, type NoteOutcome } from '../notes/note.ts';
import { conversationNote, type ConversationTurn } from './conversation.ts';

export const CHATGPT_ASSISTANT_LABEL = 'ChatGPT';

/** Content that is not part of the conversation as shown: left out without a word. */
const UNSHOWN_CONTENT = new Set([
  'thoughts',
  'reasoning_recap',
  'user_editable_context',
  'model_editable_context',
  'tether_browsing_display',
  'tether_quote',
  'execution_output',
  'system_error',
  'computer_output',
  'super_widget',
]);

const IMAGE_NOT_IMPORTED = '[A picture was here; it was not imported.]';

/** The words of a message's content, and whether any of it was of a shape with no rule here. */
function contentText(content: unknown): { text: string; unsupported: boolean } {
  if (!isRecord(content)) return { text: '', unsupported: true };
  const type = content.content_type;
  if (typeof type === 'string' && UNSHOWN_CONTENT.has(type)) return { text: '', unsupported: false };
  if (type === 'code') {
    const code = typeof content.text === 'string' ? content.text.trim() : '';
    return { text: code === '' ? '' : `\`\`\`\n${code}\n\`\`\``, unsupported: typeof content.text !== 'string' };
  }
  if (!Array.isArray(content.parts)) {
    // A known kind with text of its own, or a kind with no rule here.
    return typeof content.text === 'string' ? { text: content.text, unsupported: false } : { text: '', unsupported: true };
  }
  const pieces: string[] = [];
  let unsupported = false;
  for (const part of content.parts) {
    if (typeof part === 'string') {
      pieces.push(part);
    } else if (isRecord(part) && typeof part.text === 'string') {
      pieces.push(part.text);
    } else if (isRecord(part) && typeof part.content_type === 'string' && part.content_type.includes('image')) {
      pieces.push(IMAGE_NOT_IMPORTED);
    } else if (isRecord(part) && typeof part.content_type === 'string' && /audio|video/.test(part.content_type)) {
      // A voice conversation's recording, beside its transcript (a part with text): the recording is not read.
      continue;
    } else if (part !== null && part !== undefined) {
      unsupported = true;
    }
  }
  return { text: pieces.join('\n').trim(), unsupported };
}

/** The node ids of the visible thread, root first: `current_node` back through `parent`. */
function visibleThread(mapping: Record<string, unknown>, current: unknown): string[] | undefined {
  if (typeof current !== 'string' || !isRecord(mapping[current])) return undefined;
  const path: string[] = [];
  const seen = new Set<string>();
  let id: unknown = current;
  while (typeof id === 'string' && isRecord(mapping[id])) {
    // A parent chain that loops is not a thread.
    if (seen.has(id)) return undefined;
    seen.add(id);
    path.push(id);
    id = (mapping[id] as Record<string, unknown>).parent;
  }
  return path.reverse();
}

/** One record of a ChatGPT export's conversations as a note, an empty conversation, or no conversation at all. */
export function parseChatGptConversation(record: unknown): NoteOutcome {
  if (!isRecord(record)) return { kind: 'unreadable' };
  if (!isRecord(record.mapping)) return { kind: 'unsupported' };
  const mapping = record.mapping;
  const thread = visibleThread(mapping, record.current_node);
  if (!thread) return { kind: 'unsupported' };
  const turns: ConversationTurn[] = [];
  let unsupported = 0;
  for (const id of thread) {
    const message = (mapping[id] as Record<string, unknown>).message;
    if (message === null || message === undefined) continue;
    if (!isRecord(message)) {
      unsupported += 1;
      continue;
    }
    const role = isRecord(message.author) ? message.author.role : undefined;
    if (role !== 'user' && role !== 'assistant') continue;
    if (isRecord(message.metadata) && message.metadata.is_visually_hidden_from_conversation === true) continue;
    if (typeof message.recipient === 'string' && message.recipient !== 'all') continue;
    const read = contentText(message.content);
    if (read.unsupported) unsupported += 1;
    turns.push({ speaker: role === 'user' ? 'owner' : 'assistant', text: read.text });
  }
  return conversationNote({
    key: idText(record.conversation_id) ?? idText(record.id),
    title: record.title,
    createdAt: isoTime(record.create_time),
    updatedAt: isoTime(record.update_time),
    turns,
    unsupported,
  }, CHATGPT_ASSISTANT_LABEL);
}
