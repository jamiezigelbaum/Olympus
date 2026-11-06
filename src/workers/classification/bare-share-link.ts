/** URL shapes are content signals, independent of the message's source. No network or store lookup. */
function isDocumentShareUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === 'drive.google.com') {
    return /^\/(?:file\/d\/|drive\/(?:u\/\d+\/)?folders\/)[^/]+/.test(path)
      || (/^\/(?:open|uc)\/?$/.test(path) && url.searchParams.has('id'));
  }
  if (host === 'docs.google.com') {
    // Published pages use a separate URL from the editable/shared document.
    if (/\/d\/e\//.test(path) || /\/(?:pub|pubhtml|embed)\/?$/.test(path)) return false;
    return /^\/(?:document|spreadsheets|presentation|forms|drawings)\/(?:u\/\d+\/)?d\/[^/]+/.test(path);
  }
  if (host === 'dropbox.com' || host === 'www.dropbox.com') return /^\/(?:s|sh|scl\/(?:fi|fo))\/[^/]+/.test(path);
  if (host === 'db.tt' || host === '1drv.ms') return path.length > 1;
  if (host === 'icloud.com' || host === 'www.icloud.com') return /^\/(?:iclouddrive|pages|numbers|keynote|notes)\/[^/]+/.test(path);
  if (host === 'onedrive.live.com') return url.searchParams.has('id') || url.searchParams.has('resid') || url.searchParams.has('cid');
  if (host.endsWith('.sharepoint.com')) return /^\/:[a-z]:\//i.test(path)
    || (/\/Doc\.aspx$/i.test(path) && url.searchParams.has('sourcedoc'));
  // notion.site hosts published sites; app.notion.com hosts workspace pages.
  if (host === 'app.notion.com') {
    return /^\/(?:p\/)?(?:[^/]+-)?(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/?$/i.test(path);
  }
  if (host === 'notion.so' || host.endsWith('.notion.so')) {
    return /(?:^|[/-])[a-f0-9]{32}\/?$/i.test(path) || /\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(path);
  }
  if (host === 'box.com' || host.endsWith('.box.com')) return /^\/(?:s\/[^/]+|(?:file|folder)\/\d+)(?:\/|$)/.test(path);
  return false;
}

/** Where a URL candidate really ends: before an unmatched `)`, or a comma that precedes another URL or plain words. */
function urlEnd(raw: string): number {
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      if (depth === 0) return index;
      depth -= 1;
    } else if (char === ',' && /^(?:https?:\/\/|[^./?=&]*$)/i.test(raw.slice(index + 1))) return index;
  }
  return raw.length;
}

/**
 * Own text consisting of document/storage share URLs and at most a short
 * neutral wrapper ("here is the link", "FYI"). Meaningful surrounding words
 * and any other URL keep the model path. Also usable as a first-pass veto.
 */
export function isBareShareLink(text: string): boolean {
  let links = 0;
  let linkChars = 0;
  let otherUrl = false;
  // Filenames may hold balanced parentheses and commas. An unmatched closing
  // parenthesis ends a Markdown link, and a comma before another URL or plain
  // words ends this one, so adjacent prose and a second URL are still evaluated.
  const pattern = /https?:\/\/[^\s<>"[\]]+/giu;
  let remaining = '';
  let cursor = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const end = urlEnd(match[0]);
    const link = match[0].slice(0, end).replace(/[.,!?;:'"\]}>]+$/u, '');
    try {
      if (!isDocumentShareUrl(new URL(link))) otherUrl = true;
    } catch { otherUrl = true; }
    links++;
    linkChars += link.length;
    remaining += `${text.slice(cursor, match.index)} `;
    cursor = match.index + end;
    pattern.lastIndex = cursor;
  }
  const rest = `${remaining}${text.slice(cursor)}`.replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
  if (!links || otherUrl || rest.length > 24 || linkChars < rest.length * 2) return false;
  const words = rest ? rest.split(' ') : [];
  return words.length <= 4 && words.every(word =>
    ['here', 's', 'is', 'the', 'a', 'link', 'doc', 'document', 'file', 'folder', 'fyi', 'see', 'please', 'this', 'you', 'go', 'it'].includes(word));
}
