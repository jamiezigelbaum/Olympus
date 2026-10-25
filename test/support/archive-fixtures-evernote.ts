/**
 * Synthetic Evernote exports (.enex) for tests: invented notes, tags and
 * attachments, in the shape Evernote writes (an `en-export` root, one `note`
 * each, ENML in a CDATA `content`, attachments in base64 `data`, and
 * Evernote's own reading of an image in a `recognition` recoIndex).
 */

export interface EnexResource {
  mime: string;
  bytes: Uint8Array;
  fileName?: string;
  /** A recoIndex document, written in a CDATA section. */
  recognition?: string;
  /** Written other than as base64 (`encoding` attribute), so its bytes cannot be read. */
  encoding?: string;
  /** Leave out the `data` element (an export made without attachments). */
  noData?: boolean;
}

export interface EnexNote {
  title: string;
  /** The inside of `<en-note>`. */
  enml?: string;
  tags?: readonly string[];
  created?: string;
  updated?: string;
  resources?: readonly EnexResource[];
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function base64Lines(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('base64');
  return text.replace(/.{1,76}/g, (line) => `${line}\n`).trimEnd();
}

export function enexNote(note: EnexNote): string {
  const content = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${note.enml ?? ''}</en-note>`;
  const resources = (note.resources ?? []).map((resource) => [
    '<resource>',
    resource.noData ? '' : `<data encoding="${resource.encoding ?? 'base64'}">\n${base64Lines(resource.bytes)}\n</data>`,
    `<mime>${escape(resource.mime)}</mime>`,
    '<width>4</width><height>4</height>',
    resource.recognition ? `<recognition><![CDATA[${resource.recognition}]]></recognition>` : '',
    `<resource-attributes>${resource.fileName ? `<file-name>${escape(resource.fileName)}</file-name>` : ''}</resource-attributes>`,
    '</resource>',
  ].join('')).join('\n');
  return [
    '<note>',
    `<title>${escape(note.title)}</title>`,
    `<content><![CDATA[${content}]]></content>`,
    note.created ? `<created>${note.created}</created>` : '',
    note.updated ? `<updated>${note.updated}</updated>` : '',
    ...(note.tags ?? []).map((tag) => `<tag>${escape(tag)}</tag>`),
    '<note-attributes><author>Sam Example</author></note-attributes>',
    resources,
    '</note>',
  ].join('\n');
}

export function enexExport(notes: readonly EnexNote[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">',
    '<en-export export-date="20240601T120000Z" application="Evernote" version="10.0">',
    ...notes.map(enexNote),
    '</en-export>',
    '',
  ].join('\n');
}

/** A tiny PNG-like byte array (the signature, then invented bytes). */
export function pngBytes(seed: number, length = 300): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let index = 8; index < length; index += 1) bytes[index] = (index * 31 + seed * 17) & 0xff;
  return bytes;
}

/** A recoIndex that reads "meet Sam at noon" on two lines, with alternatives. */
export const RECO_INDEX = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<recoIndex docType="handwritten" objType="image" recoType="service" engineVersion="1">',
  '<item x="120" y="10" w="40" h="20"><t w="60">Sam</t><t w="20">Sarn</t></item>',
  '<item x="10" y="12" w="60" h="20"><t w="30">rneet</t><t w="80">meet</t></item>',
  '<item x="60" y="60" w="70" h="22"><t w="90">noon</t><t w="10">moon</t></item>',
  '<item x="10" y="58" w="30" h="22"><t w="70">at</t></item>',
  '<object type="face" x="0" y="0" w="5" h="5"/>',
  '</recoIndex>',
].join('');

/** A handful of notes: words, a to-do list, a table, an attachment with Evernote's reading, encrypted text. */
export function evernoteNotes(count: number, word = 'harbor'): EnexNote[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Note ${index + 1} about ${word}`,
    enml: `<div>First line of ${word} ${index + 1}.</div><div><en-todo checked="true"/>Done item</div><ul><li>one</li><li>two</li></ul>`,
    tags: ['fixture', `t${index % 2}`],
    created: `202406${String(index + 1).padStart(2, '0')}T090000Z`,
    updated: `202406${String(index + 1).padStart(2, '0')}T100000Z`,
  }));
}
