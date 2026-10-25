/**
 * Whether an mbox is an export of one Gmail account, and which
 * (docs/design/archive-live-one-dataset.md, section 7).
 *
 * An export of a Gmail account carries Gmail's own markers on every message
 * (`X-GM-THRID`, `X-Gmail-Labels`), and the mail it received names the account
 * in its topmost `Delivered-To` (Gmail adds it on delivery; mail the account
 * sent has none). The first messages are read, within a bound, by headers
 * only:
 *
 * - every message read carries a marker, and
 * - the received ones name exactly one address.
 *
 * Anything else (no markers, a message without them, no delivered-to address,
 * two addresses) is not one Gmail account's export: it stays under Archives.
 * The address is never kept: it is hashed into the opaque label the source
 * binding uses (provider-account-identity.ts), and an address proves no
 * account by itself, so a match asks the owner (core/source-storage.ts).
 */
import type { ArchiveFileEntry } from '../../../core/archive-formats.ts';
import type { ScopeRoot } from '../../../core/scope-safe-fs.ts';
import { MboxSplitter } from './split.ts';

/** Messages read at most, and bytes, before deciding. */
const MAX_MESSAGES = 500;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export type GmailExportEvidence =
  | { kind: 'gmail'; address: string }
  | { kind: 'not_gmail'; reason: 'no_markers' | 'no_address' | 'several_addresses' | 'empty' };

function topHeaders(raw: Uint8Array): Map<string, string> {
  const text = Buffer.from(raw.buffer, raw.byteOffset, Math.min(raw.byteLength, MAX_HEADER_BYTES)).toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // The first is the topmost: the one the account's own server added last.
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return headers;
}

/** `Name <a@b>` or `a@b` → `a@b`, lower-cased; undefined when it is not one address. */
export function bareAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const inner = /<([^<>\s]+)>/.exec(value)?.[1] ?? value.trim();
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(inner) ? inner.toLowerCase() : undefined;
}

export function identifyGmailExport(root: ScopeRoot, files: readonly ArchiveFileEntry[]): GmailExportEvidence {
  const addresses = new Set<string>();
  let messages = 0;
  let bytes = 0;
  for (const file of files) {
    const reader = root.openFile(file.relPath, { expected: file.version });
    try {
      const splitter = new MboxSplitter(reader, { maxMessageBytes: MAX_MESSAGE_BYTES });
      for (;;) {
        if (messages >= MAX_MESSAGES || bytes >= MAX_BYTES) break;
        const span = splitter.next();
        if (!span) break;
        bytes += span.length;
        // A message over the bound is not read; it says nothing either way.
        if (!span.raw) continue;
        messages += 1;
        const headers = topHeaders(span.raw);
        if (!headers.has('x-gm-thrid') && !headers.has('x-gmail-labels')) return { kind: 'not_gmail', reason: 'no_markers' };
        const delivered = headers.get('delivered-to');
        if (delivered === undefined) continue;
        const address = bareAddress(delivered);
        if (!address) return { kind: 'not_gmail', reason: 'several_addresses' };
        addresses.add(address);
        if (addresses.size > 1) return { kind: 'not_gmail', reason: 'several_addresses' };
      }
    } finally {
      reader.close();
    }
    if (messages >= MAX_MESSAGES || bytes >= MAX_BYTES) break;
  }
  if (messages === 0) return { kind: 'not_gmail', reason: 'empty' };
  const [address] = [...addresses];
  return address ? { kind: 'gmail', address } : { kind: 'not_gmail', reason: 'no_address' };
}
