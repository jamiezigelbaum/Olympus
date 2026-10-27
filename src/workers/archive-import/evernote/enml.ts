/**
 * An Evernote note's body (ENML: XHTML inside `<en-note>`) as plain lines.
 *
 * - Blocks (paragraphs, divisions, headings, quotes, list items, table rows,
 *   line breaks) end a line; text inside a line has its runs of space made one.
 *   `<pre>` keeps its spacing.
 * - A list item starts with "- ", a to-do with "[x] " or "[ ] ", a table's
 *   cells are joined with " | ".
 * - An attachment (`<en-media>`) is a placeholder naming its type: the file is
 *   a child item of its own, read on its own.
 * - Encrypted text (`<en-crypt>`) is never decrypted and its ciphertext is
 *   never text: a placeholder says it is there, and it is counted as content
 *   Olympus could not read.
 * - Scripts, styles and other markup carry no text. HTML's named entities are
 *   decoded (ENML is not strict XML).
 */
import { decodeHTML } from 'entities';

export interface EnmlText {
  text: string;
  /** Parts Olympus could not read (encrypted text). */
  unsupported: number;
  /** Attachments the body shows (`<en-media>`). */
  media: number;
}

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'en-note', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const SILENT = new Set(['script', 'style', 'head', 'title', 'object', 'embed', 'applet']);
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<![^>]*>?|<\?[\s\S]*?(?:\?>|$)|<\/?[A-Za-z][^>]*>?|[^<]+|</g;
const TAG = /^<(\/?)([A-Za-z][\w:-]*)([^>]*?)(\/?)>?$/;

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attributes);
  return match ? decodeHTML(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}

export function enmlToText(enml: string): EnmlText {
  const lines: string[] = [];
  let line = '';
  let pre = 0;
  let silent = 0;
  let crypt = 0;
  let unsupported = 0;
  let media = 0;
  let cell = 0;
  const endLine = (): void => {
    const done = pre > 0 ? line.replace(/\s+$/, '') : line.replace(/[ \t ]+/g, ' ').trim();
    if (done !== '') lines.push(done);
    line = '';
    cell = 0;
  };
  const write = (text: string): void => {
    if (silent > 0 || crypt > 0 || text === '') return;
    line += pre > 0 ? text : text.replace(/\s+/g, ' ');
  };
  for (const match of enml.matchAll(TOKEN)) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?') || (token.startsWith('<!') && !token.startsWith('<![CDATA['))) continue;
    if (token.startsWith('<![CDATA[')) {
      write(match[1] ?? '');
      continue;
    }
    const tag = token.startsWith('<') ? TAG.exec(token) : null;
    if (!tag) {
      write(token === '<' ? '<' : decodeHTML(token));
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2]!.toLowerCase();
    const attributes = tag[3] ?? '';
    const empty = tag[4] === '/';
    if (name === 'en-crypt') {
      if (closing) {
        crypt = Math.max(0, crypt - 1);
      } else {
        unsupported += 1;
        write('[Encrypted text, not read]');
        if (!empty) crypt += 1;
      }
      continue;
    }
    if (SILENT.has(name)) {
      if (!empty) silent = Math.max(0, silent + (closing ? -1 : 1));
      continue;
    }
    if (closing) {
      if (BLOCKS.has(name)) endLine();
      if (name === 'pre') pre = Math.max(0, pre - 1);
      continue;
    }
    if (name === 'br') {
      endLine();
      continue;
    }
    if (name === 'en-todo') {
      write(attribute(attributes, 'checked')?.toLowerCase() === 'true' ? '[x] ' : '[ ] ');
      continue;
    }
    if (name === 'en-media') {
      media += 1;
      const type = attribute(attributes, 'type');
      write(` [Attachment${type ? `: ${type}` : ''}] `);
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (cell > 0) write(' | ');
      cell += 1;
      continue;
    }
    if (name === 'img') {
      const alt = attribute(attributes, 'alt');
      if (alt) write(` [Image: ${alt}] `);
      continue;
    }
    if (BLOCKS.has(name)) {
      if (line.trim() !== '') endLine();
      if (name === 'pre' && !empty) pre += 1;
      if (name === 'li') write('- ');
      if (name === 'hr' || empty) endLine();
    }
  }
  endLine();
  return { text: lines.join('\n'), unsupported, media };
}
