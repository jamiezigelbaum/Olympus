/**
 * What the AI conversation exports (ChatGPT, Claude) have in common: a
 * conversation's turns, each said by the owner or by the assistant, become one
 * note whose text is every turn under its speaker's name ("You: ...",
 * "ChatGPT: ..."), kept whole. Pure: a parser hands the turns it read, and
 * this says what the note is.
 */
import { firstString, type NoteOutcome } from '../notes/note.ts';

/** How the owner's turns are named in a conversation's text. */
export const AI_CHAT_OWNER_LABEL = 'You';

export interface ConversationTurn {
  /** The owner (a prompt they wrote) or the assistant (its reply). */
  speaker: 'owner' | 'assistant';
  text: string;
}

export interface ConversationRead {
  key?: string | undefined;
  title: unknown;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  turns: readonly ConversationTurn[];
  /** Parts of the conversation the parser could not read (a message or a part of one of a shape it has no rule for). */
  unsupported: number;
}

/**
 * The note for one conversation. Turns in a row by one speaker (a reply in
 * several messages) are one turn. A conversation with no turn to read is
 * empty, or unsupported when something in it could not be read.
 */
export function conversationNote(read: ConversationRead, assistantLabel: string): NoteOutcome {
  const merged: ConversationTurn[] = [];
  for (const turn of read.turns) {
    const text = turn.text.trim();
    if (text === '') continue;
    const last = merged[merged.length - 1];
    if (last && last.speaker === turn.speaker) last.text = `${last.text}\n\n${text}`;
    else merged.push({ speaker: turn.speaker, text });
  }
  if (merged.length === 0) return read.unsupported > 0 ? { kind: 'unsupported' } : { kind: 'empty' };
  const label = (speaker: ConversationTurn['speaker']): string => (speaker === 'owner' ? AI_CHAT_OWNER_LABEL : assistantLabel);
  return {
    kind: 'note',
    note: {
      ...(read.key !== undefined ? { key: read.key } : {}),
      title: firstString(read.title) ?? '',
      body: merged.map((turn) => `${label(turn.speaker)}: ${turn.text}`).join('\n\n'),
      tags: [],
      ...(read.createdAt !== undefined ? { createdAt: read.createdAt } : {}),
      ...(read.updatedAt !== undefined ? { updatedAt: read.updatedAt } : {}),
      ...(read.unsupported > 0 ? { unsupported: read.unsupported } : {}),
      conversation: { ownerLabel: AI_CHAT_OWNER_LABEL, participants: [AI_CHAT_OWNER_LABEL, assistantLabel] },
    },
  };
}
