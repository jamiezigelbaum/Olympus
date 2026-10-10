/**
 * A small Markdown renderer for the ChatGPT panels' answers (owner request
 * 2026-10-10: the private question panel showed a zkAPI answer as raw
 * Markdown).
 *
 * The answer is sealed content from a frontier model, so it is rendered as
 * DOM nodes built from text, never as HTML: no tag in the text survives,
 * no attribute is taken from it, and a link gets only an http(s) href with
 * `rel="noopener noreferrer"` and a new tab. Supported: headings, paragraphs,
 * bullet and numbered lists (one level of nesting by indent), tables,
 * fenced and indented code, block quotes, rules, and inline code, bold,
 * italics and links. Anything else is text.
 *
 * `chatgptMarkdownRender` is serialized into the panel pages with
 * `toString()` (as the panel programs are), so it must stay self-contained:
 * no imports, no outer references, ES2017 syntax only.
 */

export function chatgptMarkdownRender(doc: Document, container: HTMLElement, text: string): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const node = (tag: string, parent: Node, cls?: string): HTMLElement => {
    const made = doc.createElement(tag);
    if (cls) made.className = cls;
    parent.appendChild(made);
    return made;
  };
  const isBlank = (line: string | undefined): boolean => line === undefined || !line.trim();
  const fence = (line: string): string | null => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    return m ? m[1]! : null;
  };
  const tableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
  const tableRule = (line: string): boolean => /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line) || /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
  const listItem = (line: string): { indent: number; ordered: boolean; text: string } | null => {
    const m = /^(\s*)(?:([-*+])|(\d{1,3}[.)]))\s+(.*)$/.exec(line);
    if (!m) return null;
    return { indent: m[1]!.length, ordered: m[3] !== undefined, text: m[4]! };
  };
  const cells = (line: string): string[] => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const out: string[] = [];
    let cur = '';
    for (let k = 0; k < trimmed.length; k++) {
      const ch = trimmed[k]!;
      if (ch === '\\' && trimmed[k + 1] === '|') { cur += '|'; k++; continue; }
      if (ch === '|') { out.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur.trim());
    return out;
  };

  // ---- inline ---------------------------------------------------------------
  const inline = (parent: Node, src: string): void => {
    let buf = '';
    const flush = () => { if (buf) { parent.appendChild(doc.createTextNode(buf)); buf = ''; } };
    let k = 0;
    while (k < src.length) {
      const ch = src[k]!;
      if (ch === '\\' && k + 1 < src.length && /[\\`*_[\]()#+\-.!|>~]/.test(src[k + 1]!)) { buf += src[k + 1]; k += 2; continue; }
      if (ch === '`') {
        const run = /^`+/.exec(src.slice(k))![0];
        const close = src.indexOf(run, k + run.length);
        if (close > 0) {
          flush();
          const span = src.slice(k + run.length, close);
          node('code', parent).textContent = span.length > 2 && span[0] === ' ' && span[span.length - 1] === ' ' ? span.slice(1, -1) : span;
          k = close + run.length;
          continue;
        }
      }
      if (ch === '[') {
        const m = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(src.slice(k));
        if (m) {
          flush();
          const a = node('a', parent);
          a.setAttribute('href', m[2]!);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          inline(a, m[1]!);
          k += m[0].length;
          continue;
        }
      }
      if (ch === '*' || ch === '_') {
        const double = src[k + 1] === ch;
        const mark = double ? ch + ch : ch;
        const rest = src.slice(k + mark.length);
        // An opener needs a non-space after it and a matching closer later on the line.
        if (rest && !/^\s/.test(rest)) {
          let close = -1;
          let from = 0;
          for (;;) {
            const at = rest.indexOf(mark, from);
            if (at < 0) break;
            if (at > 0 && !/\s/.test(rest[at - 1]!) && (ch === '*' || !/\w/.test(rest[at + mark.length] || ''))) { close = at; break; }
            from = at + 1;
          }
          if (close > 0) {
            flush();
            inline(node(double ? 'strong' : 'em', parent), rest.slice(0, close));
            k += mark.length + close + mark.length;
            continue;
          }
        }
      }
      buf += ch;
      k++;
    }
    flush();
  };

  // ---- blocks ---------------------------------------------------------------
  const blocks = (parent: Node, stop: (line: string) => boolean): void => {
    let para: string[] = [];
    const endPara = () => {
      if (!para.length) return;
      inline(node('p', parent), para.join(' ').replace(/\s+/g, ' ').trim());
      para = [];
    };
    while (i < lines.length) {
      const line = lines[i]!;
      if (stop(line)) break;
      if (isBlank(line)) { endPara(); i++; continue; }
      const open = fence(line);
      if (open) {
        endPara();
        i++;
        const body: string[] = [];
        while (i < lines.length && !(fence(lines[i]!) && fence(lines[i]!)![0] === open[0] && fence(lines[i]!)!.length >= open.length)) body.push(lines[i++]!);
        if (i < lines.length) i++;
        node('code', node('pre', parent)).textContent = body.join('\n');
        continue;
      }
      const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        endPara();
        inline(node('h' + Math.min(6, heading[1]!.length + 2), parent), heading[2]!);
        i++;
        continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { endPara(); node('hr', parent); i++; continue; }
      if (/^\s{0,3}>/.test(line)) {
        endPara();
        const quoted: string[] = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
        chatgptMarkdownRender(doc, node('blockquote', parent), quoted.join('\n'));
        continue;
      }
      if (tableRow(line) && i + 1 < lines.length && tableRule(lines[i + 1]!)) {
        endPara();
        const table = node('table', parent);
        const headRow = node('tr', node('thead', table));
        for (const cell of cells(line)) inline(node('th', headRow), cell);
        i += 2;
        const tbody = node('tbody', table);
        while (i < lines.length && tableRow(lines[i]!)) {
          const row = node('tr', tbody);
          for (const cell of cells(lines[i]!)) inline(node('td', row), cell);
          i++;
        }
        continue;
      }
      const item = listItem(line);
      if (item && (para.length === 0 || item.indent === 0)) {
        endPara();
        list(parent, item.indent, item.ordered);
        continue;
      }
      if (/^(?: {4}|\t)/.test(line) && para.length === 0) {
        const body: string[] = [];
        while (i < lines.length && (/^(?: {4}|\t)/.test(lines[i]!) || (isBlank(lines[i]) && i + 1 < lines.length && /^(?: {4}|\t)/.test(lines[i + 1]!)))) body.push(lines[i++]!.replace(/^(?: {4}|\t)/, ''));
        node('code', node('pre', parent)).textContent = body.join('\n');
        continue;
      }
      para.push(line.trim());
      i++;
    }
    endPara();
  };
  const list = (parent: Node, indent: number, ordered: boolean): void => {
    const wrap = node(ordered ? 'ol' : 'ul', parent);
    while (i < lines.length) {
      const item = listItem(lines[i]!);
      if (!item || item.indent < indent) break;
      if (item.indent >= indent + 2) {
        // Deeper by two spaces or more: nested in the last item.
        const last = wrap.lastElementChild;
        if (!last) break;
        list(last, item.indent, item.ordered);
        continue;
      }
      if (item.ordered !== ordered) break;
      i++;
      const li = node('li', wrap);
      const text: string[] = [item.text];
      // Continuation lines of the item: indented text that is not a new item.
      while (i < lines.length && !isBlank(lines[i]) && !listItem(lines[i]!) && /^\s/.test(lines[i]!)) text.push(lines[i++]!.trim());
      inline(li, text.join(' '));
      // A blank line followed by a deeper item still belongs to this list.
      if (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length) {
        const next = listItem(lines[i + 1]!);
        if (next && next.indent >= indent) i++;
      }
    }
  };
  blocks(container, () => false);
}

/** The answer's block styles; the panel's `.answer` sets size, line height and colour. */
export const CHATGPT_MARKDOWN_CSS = `
.answer.md{white-space:normal;display:block}
.answer.md>*{margin:0 0 0.625rem}
.answer.md>*:last-child{margin-bottom:0}
.answer.md h3,.answer.md h4,.answer.md h5,.answer.md h6{font-size:1rem;font-weight:650;line-height:1.35;margin-top:0.875rem}
.answer.md h3{font-size:1.0625rem}
.answer.md>h3:first-child,.answer.md>h4:first-child{margin-top:0}
.answer.md ul,.answer.md ol{padding-left:1.375rem}
.answer.md li{margin:0.25rem 0}
.answer.md li>ul,.answer.md li>ol{margin:0.25rem 0 0}
.answer.md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.875em;background:var(--code-bg,rgba(128,128,128,0.14));border-radius:4px;padding:0.1em 0.3em}
.answer.md pre{background:var(--code-bg,rgba(128,128,128,0.14));border-radius:8px;padding:0.625rem 0.75rem;overflow-x:auto}
.answer.md pre code{background:none;padding:0;font-size:0.8125rem;line-height:1.5}
.answer.md blockquote{margin:0 0 0.625rem;padding:0 0 0 0.75rem;border-left:3px solid var(--rule,rgba(128,128,128,0.35));opacity:0.9}
.answer.md hr{border:0;border-top:1px solid var(--rule,rgba(128,128,128,0.35));margin:0.75rem 0}
.answer.md table{border-collapse:collapse;width:100%;font-size:0.875rem;display:block;overflow-x:auto}
.answer.md th,.answer.md td{border:1px solid var(--rule,rgba(128,128,128,0.35));padding:0.375rem 0.5rem;text-align:left;vertical-align:top}
.answer.md th{font-weight:650}
.answer.md a{color:inherit;text-decoration:underline}
`;
