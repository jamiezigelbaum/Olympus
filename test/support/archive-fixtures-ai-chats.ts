/**
 * Synthetic ChatGPT and Claude data exports built in code, for tests: the
 * shapes the connectors read (archive-import/ai-chats), each conversation
 * carrying a search word of its own. Nothing here is a real export or real
 * personal data.
 */
import { buildZip, type ZipFixtureEntry } from '../helpers/zip-fixture.ts';

type Json = Record<string, unknown>;

/** One ChatGPT message node's message. */
export function chatGptMessage(
  role: string,
  parts: readonly unknown[],
  options: { contentType?: string; recipient?: string; hidden?: boolean; at?: number; content?: Json } = {},
): Json {
  return {
    id: `msg-${Math.abs(hash(`${role}${JSON.stringify(parts)}`))}`,
    author: { role, name: null, metadata: {} },
    create_time: options.at ?? null,
    update_time: null,
    content: options.content ?? { content_type: options.contentType ?? 'text', parts },
    status: 'finished_successfully',
    end_turn: true,
    weight: 1,
    metadata: options.hidden ? { is_visually_hidden_from_conversation: true } : {},
    recipient: options.recipient ?? 'all',
  };
}

function hash(text: string): number {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) | 0;
  return h;
}

/**
 * A ChatGPT conversation whose visible thread is `thread` (root first), with
 * any `branches` hanging off a node of it that the thread does not follow.
 */
export function chatGptConversation(input: {
  title?: unknown;
  id?: string;
  createTime?: number;
  updateTime?: number;
  thread: readonly Json[];
  /** Nodes off the visible thread: `[index of the thread node they hang off, message]`. */
  branches?: ReadonlyArray<readonly [number, Json]>;
  currentNode?: string | null;
}): Json {
  const mapping: Record<string, Json> = {};
  const rootId = 'client-created-root';
  mapping[rootId] = { id: rootId, message: null, parent: null, children: [] };
  let parent = rootId;
  const ids: string[] = [];
  input.thread.forEach((message, index) => {
    const id = `node-${index}`;
    mapping[id] = { id, message, parent, children: [] };
    (mapping[parent]!.children as string[]).push(id);
    ids.push(id);
    parent = id;
  });
  (input.branches ?? []).forEach(([at, message], index) => {
    const id = `branch-${index}`;
    const from = at < 0 ? rootId : ids[at]!;
    mapping[id] = { id, message, parent: from, children: [] };
    (mapping[from]!.children as string[]).push(id);
  });
  return {
    title: input.title ?? 'Synthetic conversation',
    create_time: input.createTime ?? 1_717_200_000.123,
    update_time: input.updateTime ?? 1_717_203_600.5,
    mapping,
    moderation_results: [],
    current_node: input.currentNode === undefined ? parent : input.currentNode,
    plugin_ids: null,
    conversation_id: input.id ?? 'synthetic-conversation-id',
    conversation_template_id: null,
    gizmo_id: null,
    is_archived: false,
    safe_urls: [],
    default_model_slug: 'synthetic-model',
    id: input.id ?? 'synthetic-conversation-id',
  };
}

/** A numbered run of ordinary ChatGPT conversations, each with a word of its own. */
export function chatGptConversations(count: number, word = 'lighthouse'): Json[] {
  return Array.from({ length: count }, (_, index) => chatGptConversation({
    title: `Synthetic ${word} chat ${index}`,
    id: `${word}-chatgpt-${index}`,
    createTime: Date.UTC(2024, 5, 1 + index, 9) / 1000,
    updateTime: Date.UTC(2024, 5, 1 + index, 10) / 1000,
    thread: [
      chatGptMessage('system', [''], { hidden: true }),
      chatGptMessage('user', [`How do I keep the synthetic ${word} log, entry ${index}?`], { at: Date.UTC(2024, 5, 1 + index, 9) / 1000 }),
      chatGptMessage('assistant', [`Write the ${word} entry ${index} every evening.`], { at: Date.UTC(2024, 5, 1 + index, 9, 1) / 1000 }),
    ],
  }));
}

/** A ChatGPT export zip: the conversations (one file, or several numbered ones), and the other files an export holds. */
export function chatGptExportZip(
  conversations: readonly Json[] | readonly (readonly Json[])[],
  options: { split?: boolean; method?: 'stored' | 'deflate'; extra?: readonly ZipFixtureEntry[] } = {},
): Uint8Array {
  const files: ZipFixtureEntry[] = options.split
    ? (conversations as readonly (readonly Json[])[]).map((part, index) => ({
      name: `conversations-${String(index).padStart(3, '0')}.json`,
      data: JSON.stringify(part),
      method: options.method ?? 'deflate',
    }))
    : [{ name: 'conversations.json', data: JSON.stringify(conversations), method: options.method ?? 'deflate' }];
  return buildZip([
    { name: 'user.json', data: JSON.stringify({ id: 'user-synthetic', email: 'person@example.invalid', chatgpt_plus_user: false }) },
    ...files,
    { name: 'message_feedback.json', data: JSON.stringify([{ id: 'f1', conversation_id: 'c1', user_id: 'user-synthetic', rating: 'thumbsUp', create_time: '2024-06-01T09:00:00Z' }]) },
    { name: 'chat.html', data: '<html><body>synthetic</body></html>' },
    { name: 'file-synthetic-picture.png', data: 'not really a png' },
    ...(options.extra ?? []),
  ]);
}

/** One Claude message. */
export function claudeMessage(sender: string, text: string | undefined, options: { content?: unknown; at?: string; attachments?: unknown[]; files?: unknown[] } = {}): Json {
  return {
    uuid: `m-${Math.abs(hash(`${sender}${text ?? ''}`))}`,
    ...(text !== undefined ? { text } : {}),
    ...(options.content !== undefined ? { content: options.content } : {}),
    sender,
    created_at: options.at ?? '2024-06-01T09:00:00.000000Z',
    updated_at: options.at ?? '2024-06-01T09:00:00.000000Z',
    attachments: options.attachments ?? [],
    files: options.files ?? [],
  };
}

export function claudeConversation(input: { uuid?: string; name?: unknown; createdAt?: string; updatedAt?: string; messages: unknown }): Json {
  return {
    uuid: input.uuid ?? 'synthetic-claude-uuid',
    name: input.name ?? 'Synthetic Claude conversation',
    created_at: input.createdAt ?? '2024-06-01T09:00:00.000000Z',
    updated_at: input.updatedAt ?? '2024-06-01T10:00:00.000000Z',
    account: { uuid: 'synthetic-account' },
    chat_messages: input.messages,
  };
}

/** A numbered run of ordinary Claude conversations, each with a word of its own. */
export function claudeConversations(count: number, word = 'harbour'): Json[] {
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(Date.UTC(2024, 6, 1 + index, 9)).toISOString();
    return claudeConversation({
      uuid: `${word}-claude-${index}`,
      name: `Synthetic ${word} chat ${index}`,
      createdAt: day,
      updatedAt: new Date(Date.UTC(2024, 6, 1 + index, 10)).toISOString(),
      messages: [
        claudeMessage('human', `What goes in the synthetic ${word} plan, part ${index}?`, {
          content: [{ type: 'text', text: `What goes in the synthetic ${word} plan, part ${index}?` }],
        }),
        claudeMessage('assistant', `The ${word} plan part ${index} needs a map.`, {
          content: [
            { type: 'thinking', thinking: 'internal reasoning that was not shown' },
            { type: 'text', text: `The ${word} plan part ${index} needs a map.` },
          ],
        }),
      ],
    });
  });
}

/** A Claude export zip: conversations.json beside the account's other lists. */
export function claudeExportZip(conversations: readonly Json[], options: { method?: 'stored' | 'deflate'; extra?: readonly ZipFixtureEntry[] } = {}): Uint8Array {
  return buildZip([
    { name: 'users.json', data: JSON.stringify([{ uuid: 'synthetic-account', full_name: 'Synthetic Person', email_address: 'person@example.invalid' }]) },
    { name: 'conversations.json', data: JSON.stringify(conversations), method: options.method ?? 'deflate' },
    { name: 'projects.json', data: JSON.stringify([{ uuid: 'p1', name: 'Synthetic project', description: '', docs: [], created_at: '2024-06-01T09:00:00Z' }]) },
    ...(options.extra ?? []),
  ]);
}
