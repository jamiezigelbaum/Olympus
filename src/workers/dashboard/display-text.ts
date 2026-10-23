/**
 * Text that came from a file path, made safe to show among words that mean
 * something (an approval line, a Needs you line, an agent's message).
 *
 * A path is chosen by whoever asked, not by the person who approves it. A
 * zero-width space makes `Inbox.mbox` and `Inbox<ZWSP>.mbox` look the same; a
 * right-to-left override reverses whatever follows it, so a name can read
 * differently from how it is spelled; either can make an approval name
 * something other than what it opens. So:
 *
 * - `visibleText` writes every control, invisible, space-lookalike and
 *   direction-changing character as `⟨U+200B⟩`, so it can be seen and read
 *   back. The angle brackets are escaped too, so a name cannot imitate an
 *   escape. Nothing else changes. Only the text shown is escaped: the stored
 *   path is kept as asked, and is what the disk is asked for.
 * - `displayText` is that, isolated from the words around it (first-strong
 *   isolate, U+2068 ... U+2069), so a name or folder in right-to-left script
 *   cannot reorder the sentence it sits in. Plain ASCII holds no
 *   right-to-left text and is left as it is.
 *
 * Escape once, at the point a display value is made: escaping an escaped
 * value escapes its brackets again.
 */

const FIRST_STRONG_ISOLATE = '⁨';
const POP_DIRECTIONAL_ISOLATE = '⁩';

/**
 * Control (Cc), format (Cf: zero-width, direction controls, soft hyphen, tags,
 * byte order mark), surrogate, private-use and unassigned characters, line
 * and paragraph separators, and every space but a plain one; plus the letters
 * and marks that draw nothing (Hangul fillers, the blank Braille cell,
 * Khmer inherent vowels, the combining grapheme joiner); plus the escape's
 * own brackets.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}͏ᅟᅠ឴឵⠀ㅤﾠ⟨⟩]/gu;

function escapeOne(char: string): string {
  if (char === ' ') return char;
  const code = char.codePointAt(0) ?? 0;
  return `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/**
 * The text with every character that cannot be seen, or that moves the
 * words around it, written out as `⟨U+XXXX⟩`.
 */
export function visibleText(text: string): string {
  return text.replace(HIDDEN, escapeOne);
}

/**
 * `visibleText`, isolated so it cannot reorder its neighbours: the value a
 * sentence, a message or a line of the dashboard shows for a name or folder.
 */
export function displayText(text: string): string {
  const shown = visibleText(text);
  return /^[\x20-\x7e]*$/.test(shown) ? shown : `${FIRST_STRONG_ISOLATE}${shown}${POP_DIRECTIONAL_ISOLATE}`;
}
