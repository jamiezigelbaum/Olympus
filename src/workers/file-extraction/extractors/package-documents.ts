import { posix } from 'node:path';
import { OfficeDocumentUnreadableError, readZipEntries, readZipEntryText } from './document-formats.ts';
import type { DocumentSheet } from './legacy-workbook.ts';

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: Array<XmlNode | string>;
}

export interface PackageDocument {
  sections?: Array<{ name: string; text: string }>;
  sheets?: DocumentSheet[];
  text?: string;
}

function unreadable(reason: 'damaged' | 'encrypted' | 'unsupported', message: string): never {
  throw new OfficeDocumentUnreadableError(reason, message);
}

// No entities are fetched or expanded from declarations.
function parseMarkup(xml: string): XmlNode {
  const root: XmlNode = { name: '', attributes: {}, children: [] };
  const stack = [root];
  const tokens = xml.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\/?(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g);
  let count = 0;
  let end = 0;
  for (const token of tokens) {
    if (token.index !== end) unreadable('damaged', 'Document markup is malformed.');
    end += token[0].length;
    const value = token[0];
    const parent = stack.at(-1)!;
    if (value.startsWith('<![CDATA[')) parent.children.push(token[1]!);
    else if (value.startsWith('<!') || value.startsWith('<?')) continue;
    else if (value.startsWith('</')) {
      // Book chapters are often loose HTML: close back to the matching tag, or ignore a stray one.
      const name = value.slice(2, -1).trim();
      const open = stack.map((node) => node.name).lastIndexOf(name);
      if (open > 0) stack.length = open;
    } else if (value.startsWith('<')) {
      const inner = value.slice(1, value.endsWith('/>') ? -2 : -1).trim();
      const name = inner.split(/\s/, 1)[0]!;
      const attributes: Record<string, string> = Object.create(null);
      for (const match of inner.slice(name.length).matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attributes[localName(match[1]!)] = decodeEntities(match[2] ?? match[3] ?? '');
      }
      const node: XmlNode = { name, attributes, children: [] };
      if (++count > 200_000 || stack.length > 256) unreadable('unsupported', 'Document markup exceeds the local read limit.');
      parent.children.push(node);
      if (!value.endsWith('/>') && !VOID_ELEMENTS.has(localName(name).toLowerCase())) stack.push(node);
    } else parent.children.push(decodeEntities(value));
  }
  if (end !== xml.length) unreadable('damaged', 'Document markup is incomplete.');
  return root;
}

// HTML elements that never hold content, written without a closing slash in loose HTML.
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

const MARKUP_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  "AElig": "Æ", "Aacute": "Á", "Acirc": "Â", "Agrave": "À", "Alpha": "Α", "Aring": "Å",
  "Atilde": "Ã", "Auml": "Ä", "Beta": "Β", "Ccedil": "Ç", "Chi": "Χ", "Dagger": "‡",
  "Delta": "Δ", "ETH": "Ð", "Eacute": "É", "Ecirc": "Ê", "Egrave": "È", "Epsilon": "Ε",
  "Eta": "Η", "Euml": "Ë", "Gamma": "Γ", "Iacute": "Í", "Icirc": "Î", "Igrave": "Ì",
  "Iota": "Ι", "Iuml": "Ï", "Kappa": "Κ", "Lambda": "Λ", "Mu": "Μ", "Ntilde": "Ñ",
  "Nu": "Ν", "OElig": "Œ", "Oacute": "Ó", "Ocirc": "Ô", "Ograve": "Ò", "Omega": "Ω",
  "Omicron": "Ο", "Oslash": "Ø", "Otilde": "Õ", "Ouml": "Ö", "Phi": "Φ", "Pi": "Π",
  "Prime": "″", "Psi": "Ψ", "Rho": "Ρ", "Scaron": "Š", "Sigma": "Σ", "THORN": "Þ",
  "Tau": "Τ", "Theta": "Θ", "Uacute": "Ú", "Ucirc": "Û", "Ugrave": "Ù", "Upsilon": "Υ",
  "Uuml": "Ü", "Xi": "Ξ", "Yacute": "Ý", "Yuml": "Ÿ", "Zeta": "Ζ", "aacute": "á",
  "acirc": "â", "acute": "´", "aelig": "æ", "agrave": "à", "alefsym": "ℵ", "alpha": "α",
  "amp": "&", "and": "∧", "ang": "∠", "aring": "å", "asymp": "≈", "atilde": "ã",
  "auml": "ä", "bdquo": "„", "beta": "β", "brvbar": "¦", "bull": "•", "cap": "∩",
  "ccedil": "ç", "cedil": "¸", "cent": "¢", "chi": "χ", "circ": "ˆ", "clubs": "♣",
  "cong": "≅", "copy": "©", "crarr": "↵", "cup": "∪", "curren": "¤", "dArr": "⇓",
  "dagger": "†", "darr": "↓", "deg": "°", "delta": "δ", "diams": "♦", "divide": "÷",
  "eacute": "é", "ecirc": "ê", "egrave": "è", "empty": "∅", "emsp": " ", "ensp": " ",
  "epsilon": "ε", "equiv": "≡", "eta": "η", "eth": "ð", "euml": "ë", "euro": "€",
  "exist": "∃", "fnof": "ƒ", "forall": "∀", "frac12": "½", "frac14": "¼", "frac34": "¾",
  "frasl": "⁄", "gamma": "γ", "ge": "≥", "gt": ">", "hArr": "⇔", "harr": "↔",
  "hearts": "♥", "hellip": "…", "iacute": "í", "icirc": "î", "iexcl": "¡", "igrave": "ì",
  "image": "ℑ", "infin": "∞", "int": "∫", "iota": "ι", "iquest": "¿", "isin": "∈",
  "iuml": "ï", "kappa": "κ", "lArr": "⇐", "lambda": "λ", "lang": "〈", "laquo": "«",
  "larr": "←", "lceil": "⌈", "ldquo": "“", "le": "≤", "lfloor": "⌊", "lowast": "∗",
  "loz": "◊", "lrm": "‎", "lsaquo": "‹", "lsquo": "‘", "lt": "<", "macr": "¯",
  "mdash": "—", "micro": "µ", "middot": "·", "minus": "−", "mu": "μ", "nabla": "∇",
  "nbsp": " ", "ndash": "–", "ne": "≠", "ni": "∋", "not": "¬", "notin": "∉",
  "nsub": "⊄", "ntilde": "ñ", "nu": "ν", "oacute": "ó", "ocirc": "ô", "oelig": "œ",
  "ograve": "ò", "oline": "‾", "omega": "ω", "omicron": "ο", "oplus": "⊕", "or": "∨",
  "ordf": "ª", "ordm": "º", "oslash": "ø", "otilde": "õ", "otimes": "⊗", "ouml": "ö",
  "para": "¶", "part": "∂", "permil": "‰", "perp": "⊥", "phi": "φ", "pi": "π",
  "piv": "ϖ", "plusmn": "±", "pound": "£", "prime": "′", "prod": "∏", "prop": "∝",
  "psi": "ψ", "quot": "\"", "rArr": "⇒", "radic": "√", "rang": "〉", "raquo": "»",
  "rarr": "→", "rceil": "⌉", "rdquo": "”", "real": "ℜ", "reg": "®", "rfloor": "⌋",
  "rho": "ρ", "rlm": "‏", "rsaquo": "›", "rsquo": "’", "sbquo": "‚", "scaron": "š",
  "sdot": "⋅", "sect": "§", "shy": "­", "sigma": "σ", "sigmaf": "ς", "sim": "∼",
  "spades": "♠", "sub": "⊂", "sube": "⊆", "sum": "∑", "sup": "⊃", "sup1": "¹",
  "sup2": "²", "sup3": "³", "supe": "⊇", "szlig": "ß", "tau": "τ", "there4": "∴",
  "theta": "θ", "thetasym": "ϑ", "thinsp": " ", "thorn": "þ", "tilde": "˜", "times": "×",
  "trade": "™", "uArr": "⇑", "uacute": "ú", "uarr": "↑", "ucirc": "û", "ugrave": "ù",
  "uml": "¨", "upsih": "ϒ", "upsilon": "υ", "uuml": "ü", "weierp": "℘", "xi": "ξ",
  "yacute": "ý", "yen": "¥", "yuml": "ÿ", "zeta": "ζ", "zwj": "‍", "zwnj": "‌",
  "apos": "'",
});

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, key: string) => {
    if (!key.startsWith('#')) return Object.hasOwn(MARKUP_ENTITIES, key) ? MARKUP_ENTITIES[key]! : whole;
    const code = key[1]?.toLowerCase() === 'x' ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function nodes(root: XmlNode, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const walk = (node: XmlNode): void => {
    for (const child of node.children) {
      if (typeof child === 'string') continue;
      if (localName(child.name) === name) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function markupText(node: XmlNode): string {
  const name = localName(node.name).toLowerCase();
  if (name === 'script' || name === 'style' || name === 'head' || name === 'binary-data') return '';
  if (name === 's') return ' '.repeat(repeatCount(node.attributes.c, 1000));
  if (name === 'tab') return '\t';
  if (name === 'br' || name === 'line-break') return '\n';
  const text = node.children.map((child) => typeof child === 'string' ? child : markupText(child)).join('');
  if (name === 'table-cell' || name === 'covered-table-cell' || name === 'td' || name === 'th') return `${text.trim()}\t`;
  return ['p', 'h', 'list-item', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'li', 'tr', 'section', 'table-row'].includes(name)
    ? `${text.trim()}\n` : text;
}

function repeatCount(value: string | undefined, maximum = 500_000): number {
  if (value === undefined) return 1;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > maximum) unreadable('unsupported', 'Document repetition exceeds the local read limit.');
  return count;
}

function packageReader(bytes: Uint8Array): (name: string, required?: boolean) => string | undefined {
  const entries = readZipEntries(bytes);
  let total = 0;
  return (name, required = false) => {
    const text = readZipEntryText(bytes, entries, name);
    if (text === undefined && required) unreadable('damaged', 'A required document part is missing.');
    total += (text?.length ?? 0) * 2;
    if (total > 64 * 1024 * 1024) unreadable('unsupported', 'Document parts exceed the local read limit.');
    return text;
  };
}

export function readOpenDocument(bytes: Uint8Array, format: 'odt' | 'ods' | 'odp'): PackageDocument {
  const read = packageReader(bytes);
  const manifest = read('META-INF/manifest.xml');
  if (manifest && nodes(parseMarkup(manifest), 'encryption-data').length) unreadable('encrypted', 'OpenDocument content is encrypted.');
  const content = parseMarkup(read('content.xml', true)!);
  if (format === 'odt') return { text: markupText(content) };
  if (format === 'odp') return {
    sections: nodes(content, 'page').map((page, index) => ({ name: `Slide ${index + 1}`, text: markupText(page) })),
  };
  let totalCells = 0;
  const sheets = nodes(content, 'table').map((table, index) => {
    const rows: string[][] = [];
    for (const row of nodes(table, 'table-row')) {
      const runs: Array<{ value: string; repeat: number }> = [];
      let width = 0;
      for (const cell of row.children) {
        if (typeof cell === 'string' || !['table-cell', 'covered-table-cell'].includes(localName(cell.name))) continue;
        const value = markupText(cell).trim() || cell.attributes['string-value'] || cell.attributes.value
          || cell.attributes['boolean-value'] || cell.attributes['date-value'] || cell.attributes['time-value'] || '';
        const repeat = repeatCount(cell.attributes['number-columns-repeated'], 16_384);
        width += repeat;
        if (width > 16_384) unreadable('unsupported', 'Document table is too wide.');
        runs.push({ value, repeat });
      }
      // Writers pad rows with empty cells out to the sheet's full width; drop that padding before expanding.
      while (runs.length && !runs.at(-1)!.value.trim()) runs.pop();
      if (!runs.length) continue;
      const cells = runs.flatMap(({ value, repeat }) => Array<string>(repeat).fill(value));
      const repeat = repeatCount(row.attributes['number-rows-repeated']);
      totalCells += repeat * cells.length;
      if (totalCells > 500_000) unreadable('unsupported', 'Document table exceeds the local read limit.');
      for (let i = 0; i < repeat; i += 1) rows.push(cells);
    }
    return { name: table.attributes.name ?? `sheet ${index + 1}`, rows };
  });
  return { sheets };
}

function packagePath(base: string, href: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(href.split('#')[0]!.split('?')[0]!); }
  catch { return unreadable('damaged', 'Document part path is malformed.'); }
  if (decoded.includes(':') || decoded.includes('\\') || decoded.startsWith('/')) unreadable('unsupported', 'External document parts are unsupported.');
  const path = posix.normalize(posix.join(base, decoded));
  if (path === '..' || path.startsWith('../')) unreadable('damaged', 'Document part path leaves its package.');
  return path;
}

// A manifest may list remote assets that are never read; only a spine item must be inside the package.
function manifestPath(base: string, href: string): string | undefined {
  try {
    return packagePath(base, href);
  } catch (error) {
    if (error instanceof OfficeDocumentUnreadableError && error.reason === 'unsupported') return undefined;
    throw error;
  }
}

export function readEpub(bytes: Uint8Array): PackageDocument {
  const read = packageReader(bytes);
  const container = parseMarkup(read('META-INF/container.xml', true)!);
  const rootfile = nodes(container, 'rootfile')[0]?.attributes['full-path'];
  if (!rootfile) unreadable('damaged', 'EPUB package path is missing.');
  const opfPath = packagePath('', rootfile);
  const opf = parseMarkup(read(opfPath, true)!);
  const items = new Map<string, { href: string; path?: string; mime: string }>();
  for (const item of nodes(opf, 'item')) {
    const { id, href } = item.attributes;
    if (!id || !href || items.has(id)) unreadable('damaged', 'EPUB manifest item is malformed.');
    items.set(id, { href, path: manifestPath(posix.dirname(opfPath), href), mime: item.attributes['media-type'] ?? '' });
  }
  const itemsByPath = new Map([...items.values()].flatMap((item) => (item.path ? [[item.path, item] as const] : [])));
  const encryption = read('META-INF/encryption.xml');
  if (encryption) {
    for (const reference of nodes(parseMarkup(encryption), 'CipherReference')) {
      const uri = reference.attributes.URI;
      if (!uri) unreadable('damaged', 'EPUB encryption reference is missing.');
      const path = packagePath('', uri);
      const item = itemsByPath.get(path);
      const font = item && (item.mime.startsWith('font/') || ['application/vnd.ms-opentype', 'application/font-sfnt', 'application/font-woff'].includes(item.mime));
      if (!font) unreadable('encrypted', 'EPUB content is encrypted.');
    }
  }
  const spine = nodes(opf, 'itemref');
  if (spine.length === 0) unreadable('damaged', 'EPUB spine is missing.');
  if (spine.length > 2048) unreadable('unsupported', 'EPUB spine exceeds the local read limit.');
  const sections = spine.map((reference, index) => {
    const item = items.get(reference.attributes.idref ?? '');
    if (!item) unreadable('damaged', 'EPUB spine item is missing.');
    if (!['application/xhtml+xml', 'text/html'].includes(item.mime)) unreadable('unsupported', 'EPUB spine item is not text.');
    const path = item.path ?? packagePath(posix.dirname(opfPath), item.href);
    return { name: `Chapter ${index + 1}`, text: markupText(parseMarkup(read(path, true)!)) };
  });
  return { sections };
}
