/**
 * Whether a tool result carries the product's fixed Private note: the one
 * sentence an agent is given when Private items it was not shown may answer
 * its question. Both surfaces' wordings are recognized (the default remote
 * surface's, and the ChatGPT surface's panel notes), through the product's own
 * constants, so a wording change cannot make this check silently pass.
 */
import { REMOTE_PRIVATE_NOTE } from '../../src/core/remote-result.ts';
import { privateNoteKind } from '../chatgpt-live-smoke.ts';

export function privateNoteKindIn(text: string, structured?: unknown): string | null {
  const panel = privateNoteKind(text);
  if (panel) return panel;
  const remote = text.includes(REMOTE_PRIVATE_NOTE) || (structured as { private_note?: string } | null | undefined)?.private_note === REMOTE_PRIVATE_NOTE;
  return remote ? 'remote' : null;
}
