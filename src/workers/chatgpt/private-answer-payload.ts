/**
 * The panel payload contract: one authoritative set of limits and a total
 * serializer, enforced at the jobs boundary before first delivery on every
 * install.
 *
 * Limits (after normalization), and what they tighten against the previous
 * jobs boundary on every install:
 *
 *   answer       ≤ 2,700 UTF-16 units   (was 65,536; the model layer writes at
 *                                        most 2,700 in full detail, 1,000 summary)
 *   citations    ≤ 4                    (was 20; the panel reads at most 4 items)
 *   title/source ≤ 300 units each       (unchanged)
 *   date         ≤ 32 units             (unchanged)
 *   web URL      ≤ 2,048 characters, the normalized https form (unchanged)
 *   Mac token    43 characters          (unchanged)
 *   unanswered   ≤ 4 × 300 units        (was 10 × 300; 3 model gaps + 1 note)
 *
 * Nothing shown today is cut: the production model is constructed without a
 * limits override (`email-source/server.ts`, `createBuiltInPrivateAnswerModel`),
 * so its answers already sit inside these bounds. A model limit configured
 * above the contract is clamped here.
 *
 * The serializer is total: every input yields JSON whose fields sit inside
 * their byte budgets (below). Lone surrogates become U+FFFD; control,
 * bidirectional-override and zero-width characters are stripped; URLs go
 * through `new URL().href` (non-https dropped); a field over its budget is cut
 * at a code-point boundary with "…" inside the budget; list entries beyond
 * their count are dropped. The sealed plaintext is then bucket-padded
 * (private-answer-crypto.ts).
 */
import type { PrivateAnswerCitation, PrivateAnswerPlaintextV1 } from './private-answer-contract.ts';

export const PRIVATE_ANSWER_PAYLOAD_LIMITS = Object.freeze({
  /** UTF-16 code units of the answer. */
  answerUnits: 2_700,
  citations: 4,
  /** UTF-16 code units of a citation's title and of its source, each. */
  citationTextUnits: 300,
  dateUnits: 32,
  /** Characters of a normalized https URL (ASCII). */
  urlChars: 2_048,
  /** A source-open token: 32 random bytes, base64url. */
  openTokenChars: 43,
  gaps: 4,
  /** UTF-16 code units of one gap line. */
  gapUnits: 300,
});

/** Serialized UTF-8 byte budgets per part: the answer, each citation, each gap line. */
export const PRIVATE_ANSWER_BYTE_BUDGETS = Object.freeze({
  answer: 8_192,
  citation: 4_096,
  gap: 1_024,
});

const CUT_MARK = '…';
/**
 * C0 and C1 controls (tab, newline and carriage return aside), bidirectional
 * overrides and isolates, zero-width marks and the byte-order mark. Tabs
 * become spaces; newlines are kept in multi-line text and folded in one-line
 * fields.
 */
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const WHITESPACE_CONTROLS = /[\u0009]/g;

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Lone surrogates become U+FFFD, so the text round-trips through UTF-8 unchanged. */
function wellFormed(text: string): string {
  // ES2024's String.prototype.toWellFormed where the runtime has it (Bun does); the same replacement otherwise.
  const native = (text as unknown as { toWellFormed?: () => string }).toWellFormed;
  return typeof native === 'function' ? native.call(text) : text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

/** The first `units` UTF-16 units, never ending in a split surrogate pair. */
function cutUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  let end = units;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** A bounded one-line text field: well-formed, unsafe characters and whitespace runs become one space, trimmed, cut. Undefined when empty. */
export function cleanTextField(value: unknown, maxUnits: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = cutUnits(wellFormed(value).replace(UNSAFE, ' ').replace(WHITESPACE_CONTROLS, ' ').replace(/\s+/g, ' ').trim(), maxUnits).trim();
  return text || undefined;
}

/** The answer text: well-formed, unsafe characters removed (newlines kept), cut to the contract. */
export function cleanAnswerText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return cutUnits(wellFormed(value).replace(/\r\n?/g, '\n').replace(UNSAFE, ''), PRIVATE_ANSWER_PAYLOAD_LIMITS.answerUnits);
}

/**
 * An https URL in its normalized form (`new URL().href`), bounded, with no
 * credentials, or undefined. The bound applies to the normalized text.
 */
export function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4 * PRIVATE_ANSWER_PAYLOAD_LIMITS.urlChars) return undefined;
  const text = wellFormed(value);
  if (text.replace(UNSAFE, '') !== text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return undefined;
  const href = url.href;
  if (href.length > PRIVATE_ANSWER_PAYLOAD_LIMITS.urlChars || !/^[\x21-\x7e]+$/.test(href)) return undefined;
  return href;
}

const OPEN_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Cuts `text` so that `JSON.stringify(text)` is at most `budget` UTF-8 bytes,
 * at a code-point boundary, with the cut mark inside the budget. Total: any
 * budget yields a string that fits (an empty one when nothing else can).
 */
export function fitJsonString(text: string, budget: number): { text: string; cut: boolean } {
  if (utf8Bytes(JSON.stringify(text)) <= budget) return { text, cut: false };
  const markBytes = utf8Bytes(CUT_MARK);
  // Two bytes of quotes, then the mark, then as many whole code points as fit.
  let room = budget - 2 - markBytes;
  if (room < 0) return { text: '', cut: true };
  let kept = '';
  for (const char of text) {
    const bytes = utf8Bytes(JSON.stringify(char)) - 2;
    if (bytes > room) break;
    room -= bytes;
    kept += char;
  }
  return { text: kept + CUT_MARK, cut: true };
}

/** A citation as the model returned it, normalized to the contract; `localPath` is kept beside it for the open-token map. */
export interface PreparedPrivateAnswer {
  answer: string;
  citations: PrivateAnswerCitation[];
  unanswered: string[];
  /** Index-aligned with `citations`: the source's local file on this computer, never serialized. */
  localPaths: (string | undefined)[];
}

/**
 * The model's result reduced to the contract, field by field: text only,
 * bounded by the limits above. The byte budgets are applied at serialization.
 */
export function preparePrivateAnswer(result: { answer: unknown; citations?: unknown; unanswered?: unknown }): PreparedPrivateAnswer {
  const limits = PRIVATE_ANSWER_PAYLOAD_LIMITS;
  const citations: PrivateAnswerCitation[] = [];
  const localPaths: (string | undefined)[] = [];
  for (const value of Array.isArray(result.citations) ? result.citations : []) {
    if (citations.length >= limits.citations) break;
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const citation: PrivateAnswerCitation = {};
    const title = cleanTextField(record.title, limits.citationTextUnits);
    const source = cleanTextField(record.source, limits.citationTextUnits);
    const date = cleanTextField(record.date, limits.dateUnits);
    const url = httpsUrl(record.url);
    if (title) citation.title = title;
    if (source) citation.source = source;
    if (date) citation.date = date;
    if (url) citation.open = { kind: 'web', url };
    if (Object.keys(citation).length > 0) {
      citations.push(citation);
      localPaths.push(typeof record.localPath === 'string' && record.localPath.startsWith('/') ? record.localPath : undefined);
    }
  }
  const unanswered: string[] = [];
  for (const value of Array.isArray(result.unanswered) ? result.unanswered : []) {
    if (unanswered.length >= limits.gaps) break;
    const line = cleanTextField(value, limits.gapUnits);
    if (line) unanswered.push(line);
  }
  return { answer: cleanAnswerText(result.answer), citations, unanswered, localPaths };
}

/** One citation inside its byte budget: the title is cut first, then the source, then the open target is dropped. */
function fitCitation(citation: PrivateAnswerCitation): PrivateAnswerCitation {
  const limits = PRIVATE_ANSWER_PAYLOAD_LIMITS;
  const out: PrivateAnswerCitation = {};
  const title = cleanTextField(citation.title, limits.citationTextUnits);
  const source = cleanTextField(citation.source, limits.citationTextUnits);
  const date = cleanTextField(citation.date, limits.dateUnits);
  if (title) out.title = title;
  if (source) out.source = source;
  if (date) out.date = date;
  const open = citation.open;
  if (open && typeof open === 'object') {
    if (open.kind === 'mac' && typeof open.token === 'string' && OPEN_TOKEN.test(open.token)) out.open = { kind: 'mac', token: open.token };
    else if (open.kind === 'web') {
      const url = httpsUrl(open.url);
      if (url) out.open = { kind: 'web', url };
    }
  }
  const budget = PRIVATE_ANSWER_BYTE_BUDGETS.citation;
  const over = () => utf8Bytes(JSON.stringify(out)) - budget;
  if (over() <= 0) return out;
  if (out.title) {
    const excess = over();
    const fitted = fitJsonString(out.title, Math.max(0, utf8Bytes(JSON.stringify(out.title)) - excess));
    if (fitted.text) out.title = fitted.text;
    else delete out.title;
  }
  if (over() > 0 && out.source) {
    const excess = over();
    const fitted = fitJsonString(out.source, Math.max(0, utf8Bytes(JSON.stringify(out.source)) - excess));
    if (fitted.text) out.source = fitted.text;
    else delete out.source;
  }
  if (over() > 0) delete out.open;
  if (over() > 0) delete out.date;
  return out;
}

/** The first-answer fields inside their byte budgets, in the contract's key order. */
export function fitFirstAnswer(answer: { answer: string; citations: readonly PrivateAnswerCitation[]; unanswered?: readonly string[] | undefined }): {
  answer: string;
  citations: PrivateAnswerCitation[];
  unanswered?: string[];
} {
  const limits = PRIVATE_ANSWER_PAYLOAD_LIMITS;
  const text = fitJsonString(cleanAnswerText(answer.answer), PRIVATE_ANSWER_BYTE_BUDGETS.answer).text;
  const citations = (Array.isArray(answer.citations) ? answer.citations : [])
    .filter((citation): citation is PrivateAnswerCitation => typeof citation === 'object' && citation !== null)
    .slice(0, limits.citations)
    .map(fitCitation)
    .filter((citation) => Object.keys(citation).length > 0);
  const unanswered = (answer.unanswered ?? []).slice(0, limits.gaps)
    .map((line) => cleanTextField(line, limits.gapUnits))
    .filter((line): line is string => line !== undefined)
    .map((line) => fitJsonString(line, PRIVATE_ANSWER_BYTE_BUDGETS.gap).text)
    .filter(Boolean);
  return { answer: text, citations, ...(unanswered.length > 0 ? { unanswered } : {}) };
}

/**
 * The plaintext (`{v, answer, citations, unanswered?}`) serialized under the
 * contract's limits and byte budgets. Every job seals this, bucket-padded.
 */
export function serializePrivateAnswerPlaintext(plaintext: PrivateAnswerPlaintextV1): string {
  return JSON.stringify({ v: 1, ...fitFirstAnswer(plaintext) });
}
