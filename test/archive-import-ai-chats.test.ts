// ChatGPT and Claude data exports as archive imports: which files are theirs
// (told by structure, never by name), how one conversation becomes one item
// with its turns under their speakers' names, what is left out and what is
// reported, and a whole import through the runtime: held Private until
// judged, the owner as the conversation's sender. Synthetic exports built in
// code, never a real one.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHATGPT_ARCHIVE_FORMAT,
  CLAUDE_ARCHIVE_FORMAT,
  archiveFormatConnector,
  archiveFormatForProvider,
  archiveProbeNames,
  detectArchiveFormat,
  type ArchiveDetection,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archivePickIntro } from '../src/workers/dashboard/vocabulary.ts';
import { archiveContinuations } from '../src/workers/archive-import/continuation-cache.ts';
import { parseChatGptConversation } from '../src/workers/archive-import/ai-chats/chatgpt.ts';
import { parseClaudeConversation } from '../src/workers/archive-import/ai-chats/claude.ts';
import {
  CHATGPT_CURSOR_PREFIX,
  createChatGptArchiveConnector,
  createClaudeArchiveConnector,
} from '../src/workers/archive-import/ai-chats/connector.ts';
import { registerArchiveFormatConnectors } from '../src/workers/archive-import/format-connectors.ts';
import { probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import { NOTE_FINDINGS, type NoteOutcome } from '../src/workers/archive-import/notes/note.ts';
import { archiveConnectorStoreDbPath } from '../src/workers/archive-import/store.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../src/workers/archive-import/sync.ts';
import type { ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { buildZip } from './helpers/zip-fixture.ts';
import { roamJson, roamPages } from './support/archive-fixtures-roam.ts';
import { reflectJson, reflectNotes } from './support/archive-fixtures-reflect.ts';
import {
  chatGptConversation,
  chatGptConversations,
  chatGptExportZip,
  chatGptMessage,
  claudeConversation,
  claudeConversations,
  claudeExportZip,
  claudeMessage,
} from './support/archive-fixtures-ai-chats.ts';
import { importFixture, listAll, openConnector, tempFolder, textOf, writeExport } from './support/archive-notes-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  archiveContinuations.clear();
  while (cleanups.length) cleanups.pop()!();
});

function detectPath(dir: string, relPath: string): ArchiveDetection {
  const root = ScopeRoot.open(dir);
  try {
    return detectArchiveFormat(probeArchivePath(root, relPath, { probeNames: archiveProbeNames() }));
  } finally {
    root.close();
  }
}

function detectFile(name: string, content: string | Uint8Array): ArchiveDetection {
  const file = writeExport(cleanups, name, content);
  return detectPath(file.dir, name);
}

function formatOf(detection: ArchiveDetection): string {
  return detection.kind === 'match' ? detection.format.id : detection.kind;
}

const kinds = (findings: ReadonlyArray<{ kind: string; class: string }>) => findings.map((finding) => `${finding.class}:${finding.kind}`);

function noteOf(outcome: NoteOutcome) {
  if (outcome.kind !== 'note') throw new Error(`expected a note, got ${outcome.kind}`);
  return outcome.note;
}

describe('which files are ChatGPT or Claude exports', () => {
  test('a ChatGPT export zip, its conversations.json, and a split export are ChatGPT\'s', () => {
    const conversations = chatGptConversations(3);
    for (const method of ['stored', 'deflate'] as const) {
      expect(formatOf(detectFile('chatgpt-export.zip', chatGptExportZip(conversations, { method })))).toBe('chatgpt-export');
    }
    expect(formatOf(detectFile('conversations.json', JSON.stringify(conversations)))).toBe('chatgpt-export');
    expect(formatOf(detectFile('pretty.json', JSON.stringify(conversations, null, 2)))).toBe('chatgpt-export');
    const split = chatGptExportZip([chatGptConversations(2, 'alpha'), chatGptConversations(2, 'beta')], { split: true });
    expect(formatOf(detectFile('big-export.zip', split))).toBe('chatgpt-export');
  });

  test('a Claude export zip and its conversations.json are Claude\'s', () => {
    const conversations = claudeConversations(3);
    for (const method of ['stored', 'deflate'] as const) {
      expect(formatOf(detectFile('data-2026-11-10.zip', claudeExportZip(conversations, { method })))).toBe('claude-export');
    }
    expect(formatOf(detectFile('conversations.json', JSON.stringify(conversations)))).toBe('claude-export');
  });

  test('the structure decides, not the name: a renamed file is still told, and Olympus\'s other JSON formats are still theirs', () => {
    expect(formatOf(detectFile('my history.json', JSON.stringify(chatGptConversations(1))))).toBe('chatgpt-export');
    expect(formatOf(detectFile('backup.json', JSON.stringify(claudeConversations(1))))).toBe('claude-export');
    expect(formatOf(detectFile('Roam.json', roamJson(roamPages(2))))).toBe('roam-json');
    expect(formatOf(detectFile('Reflect.json', reflectJson(reflectNotes(2))))).toBe('reflect-json');
  });

  test('a first conversation longer than the first bytes is still told by its keys', () => {
    const long = chatGptConversation({
      title: 'Long one',
      thread: [chatGptMessage('user', ['x'.repeat(20_000)]), chatGptMessage('assistant', ['ok'])],
    });
    // The title and times come after a long mapping here, so the first bytes show only `mapping`.
    const reordered = { mapping: long.mapping, title: long.title, create_time: long.create_time, current_node: long.current_node };
    expect(formatOf(detectFile('conversations.json', JSON.stringify([reordered])))).toBe('chatgpt-export');
    const claude = claudeConversation({ messages: [claudeMessage('human', 'y'.repeat(20_000))] });
    const claudeReordered = { chat_messages: claude.chat_messages, uuid: claude.uuid, name: claude.name };
    expect(formatOf(detectFile('conversations.json', JSON.stringify([claudeReordered])))).toBe('claude-export');
  });

  test('an unzipped export folder is read, every part of a split one in order', () => {
    const dir = tempFolder(cleanups);
    writeFileSync(join(dir, 'conversations-001.json'), JSON.stringify(chatGptConversations(1, 'beta')));
    writeFileSync(join(dir, 'conversations-000.json'), JSON.stringify(chatGptConversations(1, 'alpha')));
    writeFileSync(join(dir, 'user.json'), '{"id":"user-synthetic"}');
    writeFileSync(join(dir, 'chat.html'), '<html></html>');
    expect(detectPath(dir, '')).toMatchObject({ kind: 'match', files: ['conversations-000.json', 'conversations-001.json'] });
    expect(formatOf(detectPath(dir, ''))).toBe('chatgpt-export');
  });

  test('look-alikes are not either export, and the refusal lists both as supported', () => {
    const negatives: Array<[string, string | Uint8Array]> = [
      // One key of the kind is any application's data.
      ['mapping-only.json', JSON.stringify([{ mapping: {} }])],
      ['messages-only.json', JSON.stringify([{ chat_messages: [] }])],
      // A conversation list under an object, not a bare list.
      ['wrapped.json', JSON.stringify({ conversations: chatGptConversations(1) })],
      // Some other chat app's export.
      ['other.json', JSON.stringify([{ id: 1, messages: [{ role: 'user', content: 'hi' }] }])],
      // A ChatGPT export with only its HTML copy.
      ['html-only.zip', buildHtmlOnlyZip()],
      // A zip holding both exports is not guessed at.
      ['both.zip', buildBothZip()],
    ];
    for (const [name, content] of negatives) {
      const detection = detectFile(name, content);
      expect({ name, kind: detection.kind }).toEqual({ name, kind: 'none' });
      if (detection.kind === 'none') {
        expect(detection.supported).toContain(CHATGPT_ARCHIVE_FORMAT.label);
        expect(detection.supported).toContain(CLAUDE_ARCHIVE_FORMAT.label);
      }
    }
  });

  test('the formats say what they are, are chat items cited by their app, and the drop zone offers them', () => {
    registerArchiveFormatConnectors();
    expect(archiveFormatConnector('chatgpt-export')).toBe(createChatGptArchiveConnector);
    expect(archiveFormatConnector('claude-export')).toBe(createClaudeArchiveConnector);
    expect(CHATGPT_ARCHIVE_FORMAT).toMatchObject({ family: 'chat', provider: 'chatgpt_export', citationLabel: 'ChatGPT' });
    expect(CLAUDE_ARCHIVE_FORMAT).toMatchObject({ family: 'chat', provider: 'claude_export', citationLabel: 'Claude' });
    expect(archiveFormatForProvider('chatgpt_export')).toBe(CHATGPT_ARCHIVE_FORMAT);
    expect(archiveFormatForProvider('claude_export')).toBe(CLAUDE_ARCHIVE_FORMAT);
    const intro = archivePickIntro();
    expect(intro).toContain('a ChatGPT data export');
    expect(intro).toContain('a Claude data export');
  });
});

/** A ChatGPT export with no conversations file: only its other lists and its HTML copy. */
function buildHtmlOnlyZip(): Uint8Array {
  return buildZip([
    { name: 'user.json', data: '{"id":"user-synthetic"}' },
    { name: 'message_feedback.json', data: '[]' },
    { name: 'chat.html', data: '<html><body>synthetic</body></html>' },
  ]);
}

/** A zip holding a ChatGPT export and a Claude export side by side. */
function buildBothZip(): Uint8Array {
  return buildZip([
    { name: 'chatgpt/conversations.json', data: JSON.stringify(chatGptConversations(1)) },
    { name: 'claude/conversations.json', data: JSON.stringify(claudeConversations(1)) },
  ]);
}

describe('one ChatGPT conversation', () => {
  test('only the visible thread is read, each turn under its speaker, with the title, dates and id', () => {
    const conversation = chatGptConversation({
      title: 'Planning the garden',
      id: 'conv-1',
      createTime: 1_717_200_000.5,
      updateTime: 1_717_210_000,
      thread: [
        chatGptMessage('system', [''], { hidden: true }),
        chatGptMessage('user', ['First draft of the question']),
        chatGptMessage('assistant', ['An answer to the edited question']),
      ],
      // An earlier reply that was regenerated, hanging off the prompt: not on the visible thread.
      branches: [[1, chatGptMessage('assistant', ['A discarded reply'])]],
    });
    const note = noteOf(parseChatGptConversation(conversation));
    expect(note).toMatchObject({
      key: 'conv-1',
      title: 'Planning the garden',
      createdAt: new Date(1_717_200_000_500).toISOString(),
      updatedAt: new Date(1_717_210_000_000).toISOString(),
      conversation: { ownerLabel: 'You', participants: ['You', 'ChatGPT'] },
    });
    expect(note.body).toBe('You: First draft of the question\n\nChatGPT: An answer to the edited question');
    expect(note.body).not.toContain('discarded');
    expect(note.unsupported).toBeUndefined();
  });

  test('hidden, system, tool and thinking messages are left out; a tool call is not a turn; replies in a row are one turn', () => {
    const conversation = chatGptConversation({
      thread: [
        chatGptMessage('user', ['Custom instructions'], { contentType: 'user_editable_context', content: { content_type: 'user_editable_context', user_profile: 'p', user_instructions: 'i' } }),
        chatGptMessage('user', ['Search the weather'], {}),
        chatGptMessage('assistant', ['{"query": "weather"}'], { contentType: 'code', recipient: 'browser', content: { content_type: 'code', language: 'json', text: '{"query":"weather"}' } }),
        chatGptMessage('tool', ['raw search results'], {}),
        chatGptMessage('assistant', [''], { content: { content_type: 'thoughts', thoughts: [{ summary: 's', content: 'c' }] } }),
        chatGptMessage('assistant', ['It looks sunny.'], {}),
        chatGptMessage('assistant', ['Take a hat.'], {}),
        chatGptMessage('assistant', ['hidden note'], { hidden: true }),
      ],
    });
    const note = noteOf(parseChatGptConversation(conversation));
    expect(note.body).toBe('You: Search the weather\n\nChatGPT: It looks sunny.\n\nTake a hat.');
  });

  test('pictures are said to be there, code is kept, and text parts that are objects are read', () => {
    const conversation = chatGptConversation({
      thread: [
        chatGptMessage('user', [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-x', width: 10, height: 10 }, 'What is in this picture?'], { contentType: 'multimodal_text' }),
        chatGptMessage('assistant', [], { content: { content_type: 'code', language: 'python', text: 'print(1)' } }),
        chatGptMessage('assistant', [{ content_type: 'audio_transcription', text: 'A spoken reply' }, { content_type: 'audio_asset_pointer', asset_pointer: 'x' }], { contentType: 'multimodal_text' }),
      ],
    });
    const note = noteOf(parseChatGptConversation(conversation));
    expect(note.body).toBe('You: [A picture was here; it was not imported.]\nWhat is in this picture?\n\nChatGPT: ```\nprint(1)\n```\n\nA spoken reply');
    expect(note.unsupported).toBeUndefined();
  });

  test('content of a kind it has no rule for is counted; a conversation of nothing else is unsupported, of nothing at all empty', () => {
    const partly = chatGptConversation({
      thread: [
        chatGptMessage('user', ['Hello']),
        chatGptMessage('assistant', [], { content: { content_type: 'some_future_kind', payload: {} } }),
      ],
    });
    expect(noteOf(parseChatGptConversation(partly))).toMatchObject({ body: 'You: Hello', unsupported: 1 });
    const unreadable = chatGptConversation({ thread: [chatGptMessage('assistant', [], { content: { content_type: 'some_future_kind' } })] });
    expect(parseChatGptConversation(unreadable)).toEqual({ kind: 'unsupported' });
    expect(parseChatGptConversation(chatGptConversation({ thread: [chatGptMessage('system', [''], { hidden: true })] }))).toEqual({ kind: 'empty' });
  });

  test('a conversation whose thread cannot be followed is unsupported, and what is not a record is unreadable', () => {
    expect(parseChatGptConversation(chatGptConversation({ thread: [chatGptMessage('user', ['x'])], currentNode: null }))).toEqual({ kind: 'unsupported' });
    expect(parseChatGptConversation(chatGptConversation({ thread: [chatGptMessage('user', ['x'])], currentNode: 'missing' }))).toEqual({ kind: 'unsupported' });
    const looped = chatGptConversation({ thread: [chatGptMessage('user', ['x']), chatGptMessage('assistant', ['y'])] });
    (looped.mapping as Record<string, Record<string, unknown>>)['client-created-root']!.parent = 'node-1';
    expect(parseChatGptConversation(looped)).toEqual({ kind: 'unsupported' });
    expect(parseChatGptConversation({ title: 'no mapping' })).toEqual({ kind: 'unsupported' });
    expect(parseChatGptConversation('text')).toEqual({ kind: 'unreadable' });
  });
});

describe('one Claude conversation', () => {
  test('text blocks are read in order under their speakers; thinking and tools are left out; text is the fallback', () => {
    const conversation = claudeConversation({
      uuid: 'c-1',
      name: 'Trip planning',
      createdAt: '2024-06-01T09:00:00.000000Z',
      updatedAt: '2024-06-02T09:00:00.000000Z',
      messages: [
        claudeMessage('human', 'Plan a trip', { content: [{ type: 'text', text: 'Plan a trip' }] }),
        claudeMessage('assistant', 'stale text', {
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'tool_use', name: 'search', input: {} },
            { type: 'tool_result', content: [] },
            { type: 'text', text: 'Here is a plan.' },
          ],
        }),
        // An older export: text and no blocks.
        claudeMessage('human', 'Thanks'),
      ],
    });
    const note = noteOf(parseClaudeConversation(conversation));
    expect(note).toMatchObject({
      key: 'c-1',
      title: 'Trip planning',
      createdAt: '2024-06-01T09:00:00.000Z',
      updatedAt: '2024-06-02T09:00:00.000Z',
      conversation: { ownerLabel: 'You', participants: ['You', 'Claude'] },
    });
    expect(note.body).toBe('You: Plan a trip\n\nClaude: Here is a plan.\n\nYou: Thanks');
    expect(note.unsupported).toBeUndefined();
  });

  test('an edited prompt: only the chain ending at the newest message is read; without parents, list order', () => {
    const root = '00000000-0000-4000-8000-000000000000';
    const at = (minute: number) => new Date(Date.UTC(2024, 5, 1, 9, minute)).toISOString();
    const message = (uuid: string, parent: string, sender: string, text: string, minute: number) =>
      ({ ...claudeMessage(sender, text, { at: at(minute) }), uuid, parent_message_uuid: parent });
    const messages = [
      message('h1', root, 'human', 'First question', 0),
      message('a1', 'h1', 'assistant', 'First answer', 1),
      message('h2', 'a1', 'human', 'Original follow-up', 2),
      message('a2', 'h2', 'assistant', 'Answer to the original', 3),
      // The follow-up edited: a new branch off the first answer, and its reply is the newest message.
      message('h2b', 'a1', 'human', 'Edited follow-up', 4),
      message('a2b', 'h2b', 'assistant', 'Answer to the edit', 5),
    ];
    const edited = noteOf(parseClaudeConversation(claudeConversation({ messages })));
    expect(edited.body).toBe('You: First question\n\nClaude: First answer\n\nYou: Edited follow-up\n\nClaude: Answer to the edit');
    // Listed out of time order, the newest message still ends the thread.
    const shuffled = noteOf(parseClaudeConversation(claudeConversation({ messages: [messages[4], messages[5], ...messages.slice(0, 4)] })));
    expect(shuffled.body).toBe(edited.body);
    // One message without the field: the list order, every message read.
    const { parent_message_uuid: _dropped, ...noParent } = messages[0]!;
    const listed = noteOf(parseClaudeConversation(claudeConversation({ messages: [noParent, ...messages.slice(1)] })));
    expect(listed.body).toBe('You: First question\n\nClaude: First answer\n\nYou: Original follow-up\n\nClaude: Answer to the original\n\nYou: Edited follow-up\n\nClaude: Answer to the edit');
    // A parent chain that loops is no thread: the list order again.
    const looped = noteOf(parseClaudeConversation(claudeConversation({ messages: [message('x', 'y', 'human', 'one', 0), message('y', 'x', 'assistant', 'two', 1)] })));
    expect(looped.body).toBe('You: one\n\nClaude: two');
  });

  test('attachments are named, not read; an unknown sender or block is counted; nothing to read is empty', () => {
    const conversation = claudeConversation({
      name: '',
      messages: [
        claudeMessage('human', 'See the file', { attachments: [{ file_name: 'notes.txt', file_size: 3, extracted_content: 'secret text not imported' }], files: [{ file_name: 'photo.png' }] }),
        claudeMessage('system', 'A sender with no rule'),
        claudeMessage('assistant', undefined, { content: [{ type: 'some_future_block', data: 1 }, { type: 'text', text: 'Read it.' }] }),
      ],
    });
    const note = noteOf(parseClaudeConversation(conversation));
    expect(note.title).toBe('');
    expect(note.body).toBe('You: See the file\n[Attached file notes.txt; it was not imported.]\n[Attached file photo.png; it was not imported.]\n\nClaude: Read it.');
    expect(note.body).not.toContain('secret text');
    expect(note.unsupported).toBe(2);
    expect(parseClaudeConversation(claudeConversation({ messages: [] }))).toEqual({ kind: 'empty' });
    expect(parseClaudeConversation(claudeConversation({ messages: [claudeMessage('assistant', undefined)] }))).toEqual({ kind: 'unsupported' });
    expect(parseClaudeConversation(claudeConversation({ messages: 'not a list' }))).toEqual({ kind: 'unsupported' });
    expect(parseClaudeConversation(7)).toEqual({ kind: 'unreadable' });
  });
});

type OpenOptions = Parameters<typeof openConnector>[5];

describe('the ChatGPT and Claude connectors', () => {
  test('a ChatGPT export zip: one chat item per conversation, the owner as sender, its own thread, no prior; the other files counted', async () => {
    const file = writeExport(cleanups, 'chatgpt-export.zip', chatGptExportZip(chatGptConversations(3)));
    const opened = openConnector(cleanups, file.dir, ['chatgpt-export.zip'], CHATGPT_ARCHIVE_FORMAT, createChatGptArchiveConnector);
    const { items, done } = await listAll(opened.connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(3);
    const first = items[0]!;
    expect(first.identity).toMatchObject({ family: 'chat', provider: 'chatgpt_export', accountScope: 'synthetic-archive' });
    expect(first.identity.providerConversationId).toBe(`conversation:${first.identity.providerItemId}`);
    expect(new Set(items.map((item) => item.identity.providerConversationId)).size).toBe(3);
    expect(first.metadata).toMatchObject({
      title: 'Synthetic lighthouse chat 0',
      chat: 'Synthetic lighthouse chat 0',
      senderLabel: 'You',
      senderIsOwner: true,
      fromMe: true,
      participants: ['You', 'ChatGPT'],
      authoredAt: new Date(Date.UTC(2024, 5, 1, 9)).toISOString(),
    });
    expect(textOf(first)).toBe([
      'Synthetic lighthouse chat 0\nCreated: 2024-06-01\nUpdated: 2024-06-01',
      'You: How do I keep the synthetic lighthouse log, entry 0?',
      'ChatGPT: Write the lighthouse entry 0 every evening.',
    ].join('\n\n'));
    const signals = opened.connector.classificationSignals!(first);
    expect(signals).toEqual({ title: 'Synthetic lighthouse chat 0' });
    expect('prior' in signals).toBe(false);
    expect('floor' in signals).toBe(false);
    // user.json and message_feedback.json are not conversations; chat.html and the picture are not read.
    expect(kinds(opened.findings).sort()).toEqual(['gap:media_not_imported', 'gap:section_not_imported', 'gap:section_not_imported']);
    expect(opened.findings.find((finding) => finding.kind === 'media_not_imported')?.count).toBe(2);
  });

  test('a split ChatGPT export is read part by part, in order, and resumes exactly where a page ended', async () => {
    const zip = chatGptExportZip([chatGptConversations(3, 'alpha'), chatGptConversations(2, 'beta')], { split: true });
    const file = writeExport(cleanups, 'big-export.zip', zip);
    const open = (options: OpenOptions = {}) => openConnector(cleanups, file.dir, ['big-export.zip'], CHATGPT_ARCHIVE_FORMAT, createChatGptArchiveConnector, options);
    const whole = await listAll(open().connector);
    expect(whole.items.map((item) => item.metadata.title)).toEqual([
      'Synthetic alpha chat 0', 'Synthetic alpha chat 1', 'Synthetic alpha chat 2', 'Synthetic beta chat 0', 'Synthetic beta chat 1',
    ]);
    // Page by page, each page from a fresh connector as after a restart.
    const titles: unknown[] = [];
    let cursor: string | undefined;
    for (let pass = 0; pass < 20; pass += 1) {
      const page = await listAll(open({ pageSize: 2 }).connector, cursor, 2);
      titles.push(...page.items.map((item) => item.metadata.title));
      cursor = page.cursors[page.cursors.length - 1];
      expect(cursor?.startsWith(CHATGPT_CURSOR_PREFIX)).toBe(true);
      if (cursor?.endsWith(':done')) break;
    }
    expect(titles).toEqual(whole.items.map((item) => item.metadata.title));
  });

  test('a Claude conversations.json: chat items as Claude, empty conversations skipped, unreadable ones reported at their place', async () => {
    const conversations = [
      ...claudeConversations(2),
      claudeConversation({ uuid: 'empty', messages: [] }),
      'not a conversation',
      claudeConversation({ uuid: 'future', messages: [claudeMessage('assistant', undefined, { content: [{ type: 'future_block' }] })] }),
    ];
    const file = writeExport(cleanups, 'conversations.json', JSON.stringify(conversations));
    const opened = openConnector(cleanups, file.dir, ['conversations.json'], CLAUDE_ARCHIVE_FORMAT, createClaudeArchiveConnector);
    const { items } = await listAll(opened.connector);
    expect(items.map((item) => item.metadata.title)).toEqual(['Synthetic harbour chat 0', 'Synthetic harbour chat 1']);
    expect(items[0]!.identity).toMatchObject({ family: 'chat', provider: 'claude_export' });
    expect(items[0]!.metadata).toMatchObject({ senderLabel: 'You', senderIsOwner: true, participants: ['You', 'Claude'] });
    expect(textOf(items[0]!)).toContain('You: What goes in the synthetic harbour plan, part 0?\n\nClaude: The harbour plan part 0 needs a map.');
    expect(textOf(items[0]!)).not.toContain('internal reasoning');
    expect(kinds(opened.findings)).toEqual([
      `skipped:${NOTE_FINDINGS.empty}`,
      `gap:${NOTE_FINDINGS.unreadable}`,
      `gap:${NOTE_FINDINGS.unsupported}`,
    ]);
  });
});

// --- A whole import through the runtime -------------------------------------------

function pullChats(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  return pullArchiveImport({ state: runtime.state, lane: runtime.lane('chat'), archiveId, ...options });
}

async function importAllChats(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  for (let pass = 0; pass < 100; pass += 1) {
    const outcome = await pullChats(runtime, archiveId, options);
    if (!outcome.continueSoon) return outcome;
  }
  throw new Error('the import did not finish');
}

function chatRows(env: Record<string, string>, domain: 'public_safe' | 'internal' | 'secure_local', accountScope: string) {
  const path = archiveConnectorStoreDbPath(domain, 'chat', env);
  if (!existsSync(path)) return { items: [] as Array<Record<string, unknown>>, chunks: [] as string[] };
  const db = new Database(path, { readonly: true });
  try {
    const items = db.query('SELECT provider, family, title, sender_label, sender_is_owner, provider_conversation_id FROM items WHERE account_scope = ?').all(accountScope) as Array<Record<string, unknown>>;
    const chunks = (db.query('SELECT c.bounded_text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?').all(accountScope) as Array<{ text: string }>).map((row) => row.text);
    return { items, chunks };
  } finally {
    db.close();
  }
}

describe('ChatGPT and Claude imports through the runtime', () => {
  for (const [label, name, build, provider, format, word] of [
    ['ChatGPT', 'chatgpt-export.zip', () => chatGptExportZip(chatGptConversations(3)), 'chatgpt_export', 'chatgpt-export', 'lighthouse'],
    ['Claude', 'claude-export.zip', () => claudeExportZip(claudeConversations(3)), 'claude_export', 'claude-export', 'harbour'],
  ] as const) {
    test(`a ${label} export is imported once per conversation, the owner as sender, and held Private until judged`, async () => {
      const f = importFixture(cleanups);
      const started = f.start(name, build());
      expect(started.format).toBe(format);
      const last = await importAllChats(f.runtime, started.archiveId, { pageSize: 1, maxItems: 1 });
      expect(last.receipt.counts.traversal_complete).toBe(1);
      expect(f.runtime.state.get(started.archiveId)).toMatchObject({ status: 'imported', family: 'chat', provider, format });
      const secure = chatRows(f.env, 'secure_local', started.archiveId);
      expect(secure.items).toHaveLength(3);
      for (const row of secure.items) {
        expect(row).toMatchObject({ provider, family: 'chat', sender_label: 'You', sender_is_owner: 1 });
      }
      expect(new Set(secure.items.map((row) => row.provider_conversation_id)).size).toBe(3);
      expect(secure.chunks.some((text) => text.includes(word))).toBe(true);
      // With no judge running, the conversations' words are in the Private store and nowhere else.
      for (const domain of ['internal', 'public_safe'] as const) {
        expect(chatRows(f.env, domain, started.archiveId).chunks).toEqual([]);
      }
    });
  }
});
