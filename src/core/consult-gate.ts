/**
 * Consult outbound gate (docs/design/frontier-consult-lane.md, section A.4).
 *
 * A consult is one question, written by a local writer model that has seen
 * Private evidence, which may then leave the machine. This module is the
 * mechanical check that runs on that question before the owner is asked to
 * approve it. It is a pure function over three inputs:
 *
 *   - the proposed question, exactly as it would be sent;
 *   - an immutable snapshot of every text the writer could see
 *     (`consultWriterContextFromPack` derives it from the EvidencePack, so no
 *     field can be forgotten); and
 *   - limits, which a caller may tighten but never loosen.
 *
 * It returns `pass` or `refuse` plus content-free reason codes. A reason never
 * carries the question, the matching snapshot text, or an offset into either.
 *
 * WHAT THIS IS, PLAINLY: it rejects accidents and crude exfiltration — a
 * copied sentence, a name, an address, an account number, an exact figure or
 * date, an encoded blob, hidden characters, a stuffed list of questions, a technical
 * fingerprint (internal host, path, stack frame, version string), or wording
 * reused from a recent consult.
 * Passing it is NOT de-identification and does not make a question anonymous;
 * owner approval does not waive these rules either. A question that describes a rare
 * combination of facts in its own words (a paraphrase, bands instead of
 * figures, a class of place instead of its name) passes this gate and can
 * still disclose something Private, especially to a provider that already
 * knows whose account is asking. The control that decides whether a derived
 * question may leave is the owner's approval of the exact text; this gate only
 * keeps obviously unsafe text from reaching that screen.
 *
 * Generic policy only: no question, domain, or source classifiers. Every rule
 * below is a property of characters, tokens, or shapes, applied identically to
 * any corpus. The module is enrolled in test/architecture-guard.test.ts as a
 * source-agnostic shared file, and every function here that uses a regular
 * expression is listed there by name.
 *
 * Normalization for comparison (applied to the question and to every snapshot
 * text identically):
 *   1. Unicode NFKC — folds fullwidth forms, mathematical alphanumerics,
 *      ligatures, superscripts, and compatibility spaces onto their plain forms.
 *   2. Upper-case cross-script look-alikes (Cyrillic and Greek capitals that
 *      render as Latin capitals) map to the Latin capital.
 *   3. Canonical decomposition, removal of every combining mark, recomposition:
 *      "café" and "cafe" compare equal. This only ever merges strings, so it can
 *      add refusals but cannot hide a copy.
 *   4. Lower-case cross-script look-alikes map to Latin. The table is a closed
 *      subset of Unicode's confusables data restricted to Cyrillic and Greek
 *      letters whose lower-case glyph is visually identical to a Latin letter in
 *      common fonts. Wider tables would also fold letters that merely resemble
 *      each other, which merges genuinely different words for no safety gain:
 *      a token that MIXES scripts is already refused outright.
 *   5. Case fold: `toLowerCase()` plus the two folds it does not perform
 *      (sharp s to "ss", final sigma to sigma).
 *
 * Tokenization: maximal runs of letters and digits; every other character is a
 * separator. Characters of scripts written without spaces (Han, Hiragana,
 * Katakana, Thai, Lao, Khmer, Myanmar) are one token each, so run matching
 * still works on them.
 */

import type { EvidencePack } from './contracts.ts';
import { secretLabelsInText } from './opsec.ts';

// --- Named limits -----------------------------------------------------------

/**
 * A question that shares this many consecutive normalized tokens with any
 * snapshot text is refused (when the run holds at least
 * CONSULT_GATE_RUN_MIN_CONTENT_TOKENS non-function tokens).
 *
 * Why 4: three-token sequences are still dominated by stock phrases every
 * document shares ("at the end", "how does a"), so N=3 would refuse most clean
 * questions about the same topic as the evidence. At four tokens the share of
 * sequences specific to one document rises sharply, which is what a copy looks
 * like, and four is short enough to catch a distinctive four-word phrase. A
 * longer N would let such phrases through whole.
 */
export const CONSULT_GATE_SHARED_RUN_TOKENS = 4;

/**
 * A shared run counts only when it carries at least this many tokens that are
 * not on the closed function-word list. This is the ONLY use of that list
 * besides splitting capitalized runs, and it cannot hide a copy of content:
 * a run whose tokens are all but one function words carries at most one content
 * token, and no run length can detect a single shared content token anyway.
 * The residual is a copy whose content tokens are each separated by three or
 * more function words, which natural text almost never is.
 */
export const CONSULT_GATE_RUN_MIN_CONTENT_TOKENS = 2;

// UTF-8 bytes. One to three short sentences fit; a document does not.
export const CONSULT_GATE_MAX_QUESTION_BYTES = 600;

// Normalized tokens. Bounds both the work and the covert-channel capacity.
export const CONSULT_GATE_MAX_QUESTION_TOKENS = 80;

/**
 * Snapshot ceiling, checked before any comparison work. The largest analyst
 * prompt Olympus builds is about 100 KB; the pack behind it can be larger
 * because it is trimmed for the prompt. One MiB is an order of magnitude above
 * the prompt ceiling, and comparison is linear in snapshot size, so this bounds
 * the gate's running time.
 */
export const CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES = 1_048_576;
export const CONSULT_GATE_MAX_WRITER_CONTEXT_ENTRIES = 20_000;
const MAX_WALK_DEPTH = 24;

// A provenance value shorter than this (normalized letters and digits) is not compared.
export const CONSULT_GATE_MIN_IDENTIFIER_CHARS = 3;

// A number with at least this many significant digits is an exact figure.
export const CONSULT_GATE_MIN_FIGURE_SIGNIFICANT_DIGITS = 3;

// Any digit sequence (separators allowed) with more digits than this is refused outright.
export const CONSULT_GATE_MAX_DIGITS_IN_SEQUENCE = 8;

/**
 * Encoded runs. A word of at least CONSULT_GATE_ENCODED_MIXED_RUN_CHARS drawn
 * from the base64url alphabet that mixes letters and digits is refused: six
 * bytes of base64 or four of hex already fit in eight characters, and ordinary
 * words do not carry digits. A word of at least CONSULT_GATE_ENCODED_RUN_CHARS
 * is refused when it is all hex letters, or base64 with + / = or two inner
 * case changes.
 */
export const CONSULT_GATE_ENCODED_MIXED_RUN_CHARS = 8;
export const CONSULT_GATE_ENCODED_RUN_CHARS = 16;

// Declarative sentences allowed before the question(s): one line of context or
// one instruction such as "Answer each of these briefly:".
export const CONSULT_GATE_MAX_PREAMBLE_SENTENCES = 1;

/**
 * Sub-questions allowed in one request. The reference practice permits several
 * safe sub-questions in one bounded request ("answer each of these"); what must
 * go in SEPARATE requests is facts whose combination identifies the owner.
 * Whether sub-questions are independent is a judgement the writer makes (the
 * gate cannot see meaning); the gate enforces only the count. Three matches the
 * per-answer consult cap on the private route, so bundling never buys more
 * questions than decomposition would.
 */
export const CONSULT_GATE_MAX_SUB_QUESTIONS = 3;

/**
 * Linkage with recent consults: a question that repeats a run of this many
 * normalized tokens (at least CONSULT_GATE_LINKAGE_MIN_CONTENT_TOKENS of them
 * content words) from a recently approved consult is refused, because reused
 * phrasing ties two requests to one author even across fresh network
 * identities. Six, not the snapshot rule's four: consults are written by the
 * same model in the same generic register, so four-token overlaps between
 * honest, independent sub-questions on one topic are expected; six tokens with
 * three content words is a copied clause. This detects reused WORDING only;
 * two consults about the same rare subject in different words are not linked
 * by this check.
 */
export const CONSULT_GATE_LINKAGE_RUN_TOKENS = 6;
export const CONSULT_GATE_LINKAGE_MIN_CONTENT_TOKENS = 3;
// Recent approved consults the check accepts; more is refused as oversized.
export const CONSULT_GATE_MAX_RECENT_CONSULTS = 20;

// Longest permitted run of combining marks on one base character.
export const CONSULT_GATE_MAX_COMBINING_MARK_RUN = 3;

export interface ConsultGateLimits {
  readonly maxQuestionBytes: number;
  readonly maxQuestionTokens: number;
  readonly maxWriterContextBytes: number;
  readonly maxWriterContextEntries: number;
}

export const DEFAULT_CONSULT_GATE_LIMITS: ConsultGateLimits = Object.freeze({
  maxQuestionBytes: CONSULT_GATE_MAX_QUESTION_BYTES,
  maxQuestionTokens: CONSULT_GATE_MAX_QUESTION_TOKENS,
  maxWriterContextBytes: CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES,
  maxWriterContextEntries: CONSULT_GATE_MAX_WRITER_CONTEXT_ENTRIES,
});

// --- Verdict ----------------------------------------------------------------

export type ConsultGateReason =
  | 'writer_context_too_large'
  | 'question_empty'
  | 'question_too_many_bytes'
  | 'question_too_many_tokens'
  | 'not_nfkc_normalized'
  | 'control_character'
  | 'invisible_or_format_character'
  | 'irregular_whitespace'
  | 'combining_mark_stack'
  | 'not_plain_text'
  | 'encoded_blob'
  | 'mixed_script_token'
  | 'too_many_sub_questions'
  | 'not_a_question'
  | 'technical_fingerprint'
  | 'recent_consults_too_large'
  | 'links_recent_consult'
  | 'secret_detected'
  | 'identifier_shape'
  | 'shared_token_run'
  | 'snapshot_name'
  | 'snapshot_identifier'
  | 'snapshot_hostname'
  | 'snapshot_date'
  | 'snapshot_figure';

/**
 * Optional history. `recentApprovedQuestions` are the texts of consults the
 * owner approved recently; the caller holds them in memory only (the consult
 * record is Private data, design A.7) and passes them per call. The gate keeps
 * nothing between calls.
 */
export interface ConsultGateHistory {
  readonly recentApprovedQuestions?: readonly string[];
}

export interface ConsultGateVerdict {
  readonly decision: 'pass' | 'refuse';
  readonly reasons: readonly ConsultGateReason[];
}

// --- Writer context snapshot -------------------------------------------------

/**
 * `user_question`: the owner's own question, compared as text (its wording is a
 * fingerprint). `text`: other free text the writer saw (chunks, table cells,
 * fact claims, coverage). `identifier`: provenance and any field the builder does
 * not recognise — compared as text AND as a whole value that must not appear.
 * `vocabulary`: closed enumerations (family, trust tier, confidence, ...) whose
 * values are product words, not facts about the owner; compared as text only.
 */
export type ConsultWriterContextKind = 'user_question' | 'text' | 'identifier' | 'vocabulary';

export interface ConsultWriterContextEntry {
  readonly kind: ConsultWriterContextKind;
  readonly text: string;
}

export interface ConsultWriterContext {
  readonly entries: readonly ConsultWriterContextEntry[];
  // True when the builder stopped collecting at a ceiling; the gate refuses.
  readonly overflow: boolean;
}

export interface ConsultWriterContextOptions {
  // Identifiers of the connected accounts (addresses, handles, ids). Always `identifier`.
  readonly connectedAccountIdentifiers?: readonly string[];
}

// Keys whose subtree is provenance: every string under them is an identifier.
const PROVENANCE_SCOPE_KEYS: ReadonlySet<string> = new Set(['provenance', 'sourceProvenance']);

// Closed-enumeration keys. Their values are product vocabulary, not owner facts.
const VOCABULARY_KEYS: ReadonlySet<string> = new Set([
  'family',
  'provider',
  'trustTier',
  'trustDomain',
  'confidence',
  'extractionKind',
  'releaseSurface',
  'sourceInstructionFlags',
  'lane',
]);

/**
 * Free-text keys outside provenance. Any key NOT listed here or in
 * VOCABULARY_KEYS is classified `identifier`, the strictest kind, so a field
 * added to the pack later is covered before anyone remembers to list it.
 */
const TEXT_KEYS: ReadonlySet<string> = new Set([
  'question',
  'chunks',
  'caption',
  'columns',
  'rows',
  'claim',
  'searchedCorpora',
  'corpusId',
  'reason',
  'extractionGaps',
  'builtAt',
  'score',
  'matchedItems',
  'contentMatchedItems',
  'inEvidence',
  'factId',
]);

/**
 * Derive the writer-context snapshot from an EvidencePack by walking the whole
 * object generically: every string and number leaf becomes an entry, whatever
 * its field name. Classification only decides HOW a leaf is compared, never
 * WHETHER it is collected. The result is frozen.
 */
export function consultWriterContextFromPack(
  pack: EvidencePack,
  options: ConsultWriterContextOptions = {},
): ConsultWriterContext {
  const entries: ConsultWriterContextEntry[] = [];
  const state = { bytes: 0, overflow: false };
  const ancestors = new Set<object>();
  const push = (kind: ConsultWriterContextKind, text: string): void => {
    if (state.overflow) return;
    if (text.length === 0) return;
    const bytes = utf8Bytes(text);
    if (
      entries.length + 1 > CONSULT_GATE_MAX_WRITER_CONTEXT_ENTRIES
      || state.bytes + bytes > CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES
    ) {
      state.overflow = true;
      return;
    }
    state.bytes += bytes;
    entries.push(Object.freeze({ kind, text }));
  };
  const walk = (value: unknown, key: string, inProvenance: boolean, depth: number): void => {
    if (state.overflow) return;
    if (depth > MAX_WALK_DEPTH) {
      state.overflow = true;
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      const text = String(value);
      const kind: ConsultWriterContextKind = depth === 1 && key === 'question'
        ? 'user_question'
        : VOCABULARY_KEYS.has(key)
          ? 'vocabulary'
          : !inProvenance && TEXT_KEYS.has(key) ? 'text' : 'identifier';
      push(kind, text);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    // Only a cycle is skipped. A shared sub-object is walked at every place it
    // appears, because the place decides how its strings are classified.
    if (ancestors.has(value)) return;
    ancestors.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, inProvenance, depth + 1);
    } else {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, childKey, inProvenance || PROVENANCE_SCOPE_KEYS.has(childKey), depth + 1);
      }
    }
    ancestors.delete(value);
  };
  walk(pack, '', false, 0);
  for (const identifier of options.connectedAccountIdentifiers ?? []) push('identifier', identifier);
  return Object.freeze({ entries: Object.freeze(entries), overflow: state.overflow });
}

// --- Gate ---------------------------------------------------------------------

/**
 * Check one proposed consult question against the writer's context.
 * Limits may only tighten the defaults; a larger value is clamped.
 */
export function evaluateConsultQuestion(
  question: string,
  context: ConsultWriterContext,
  limits: Partial<ConsultGateLimits> = {},
  history: ConsultGateHistory = {},
): ConsultGateVerdict {
  const effective = clampLimits(limits);
  const reasons = new Set<ConsultGateReason>();
  const recent = history.recentApprovedQuestions ?? [];

  // 1. Size of every input, before any comparison work.
  if (context.overflow || !writerContextWithinLimits(context, effective)) {
    return refuse(['writer_context_too_large']);
  }
  if (
    recent.length > CONSULT_GATE_MAX_RECENT_CONSULTS
    || recent.some((text) => typeof text !== 'string' || utf8Bytes(text) > CONSULT_GATE_MAX_QUESTION_BYTES)
  ) {
    return refuse(['recent_consults_too_large']);
  }
  if (utf8Bytes(question) > effective.maxQuestionBytes) {
    return refuse(['question_too_many_bytes']);
  }
  if (question.trim().length === 0) return refuse(['question_empty']);

  // 2. Characters and shape of the question itself.
  for (const reason of characterReasons(question)) reasons.add(reason);
  const folded = foldPreservingCase(question.normalize('NFKC'));
  const questionTokens = tokenize(folded);
  if (questionTokens.length > effective.maxQuestionTokens) reasons.add('question_too_many_tokens');
  if (questionTokens.length === 0) reasons.add('question_empty');
  if (hasMixedScriptToken(question.normalize('NFKC'))) reasons.add('mixed_script_token');
  if (hasEncodedBlob(question.normalize('NFKC'))) reasons.add('encoded_blob');
  for (const reason of questionStructureReasons(question.normalize('NFKC'))) reasons.add(reason);
  if (hasTechnicalFingerprint(question.normalize('NFKC'))) reasons.add('technical_fingerprint');
  if (secretLabelsInText(question).length > 0 || secretLabelsInText(question.normalize('NFKC')).length > 0) {
    reasons.add('secret_detected');
  }
  if (hasIdentifierShape(question.normalize('NFKC'))) reasons.add('identifier_shape');
  if (reasons.has('question_too_many_tokens') || reasons.has('question_empty')) {
    return refuse([...reasons]);
  }

  // 3. Comparison against the snapshot. Every check below derives a small set
  //    from the question and streams the snapshot once against it, so the work
  //    is linear in snapshot size, which step 1 bounded.
  const questionNorm = questionTokens.map((token) => token.norm);
  const questionNormalizedText = normalizeForComparison(question);
  if (sharesTokenRun(questionNorm, context)) reasons.add('shared_token_run');
  if (sharesNamePair(questionNorm, context)) reasons.add('snapshot_name');
  if (containsSnapshotIdentifier(questionNorm, context)) reasons.add('snapshot_identifier');
  if (containsSnapshotHostname(questionNormalizedText, context)) reasons.add('snapshot_hostname');
  if (containsSnapshotDate(questionNormalizedText, context)) reasons.add('snapshot_date');
  if (containsSnapshotFigure(questionNormalizedText, context)) reasons.add('snapshot_figure');
  if (linksRecentConsult(questionNorm, recent)) reasons.add('links_recent_consult');

  return reasons.size > 0 ? refuse([...reasons]) : { decision: 'pass', reasons: [] };
}

function refuse(reasons: readonly ConsultGateReason[]): ConsultGateVerdict {
  return Object.freeze({ decision: 'refuse', reasons: Object.freeze([...new Set(reasons)]) });
}

function clampLimits(limits: Partial<ConsultGateLimits>): ConsultGateLimits {
  const pick = (value: number | undefined, ceiling: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, ceiling) : ceiling;
  return {
    maxQuestionBytes: pick(limits.maxQuestionBytes, DEFAULT_CONSULT_GATE_LIMITS.maxQuestionBytes),
    maxQuestionTokens: pick(limits.maxQuestionTokens, DEFAULT_CONSULT_GATE_LIMITS.maxQuestionTokens),
    maxWriterContextBytes: pick(limits.maxWriterContextBytes, DEFAULT_CONSULT_GATE_LIMITS.maxWriterContextBytes),
    maxWriterContextEntries: pick(limits.maxWriterContextEntries, DEFAULT_CONSULT_GATE_LIMITS.maxWriterContextEntries),
  };
}

// Recomputed, never trusted from the builder: a hand-built context is checked the same way.
function writerContextWithinLimits(context: ConsultWriterContext, limits: ConsultGateLimits): boolean {
  if (context.entries.length > limits.maxWriterContextEntries) return false;
  let bytes = 0;
  for (const entry of context.entries) {
    if (typeof entry.text !== 'string') return false;
    bytes += utf8Bytes(entry.text);
    if (bytes > limits.maxWriterContextBytes) return false;
  }
  return true;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

// --- Character and shape rules ------------------------------------------------

/**
 * Plain text means: NFKC-stable (no fullwidth or styled variants, which could
 * otherwise carry bits by choice of form); no control characters, including tab
 * and newline (a consult is one line); no format, private-use, unassigned or
 * invisible characters (zero-width, bidi controls, tags, variation selectors,
 * fillers); only the ASCII space as whitespace, never doubled or at the ends;
 * no stacked combining marks; and none of the markup characters < > { } ` \ |
 * or HTML character references.
 */
function characterReasons(question: string): ConsultGateReason[] {
  const reasons: ConsultGateReason[] = [];
  if (question !== question.normalize('NFKC')) reasons.push('not_nfkc_normalized');
  if (/\p{Cc}/u.test(question)) reasons.push('control_character');
  if (
    /[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(question)
    || /[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u.test(question)
  ) {
    reasons.push('invisible_or_format_character');
  }
  if (/[^\S ]/u.test(question.replace(/\p{Cc}/gu, '')) || /^ | $| {2,}/u.test(question)) {
    reasons.push('irregular_whitespace');
  }
  if (new RegExp(`\\p{M}{${CONSULT_GATE_MAX_COMBINING_MARK_RUN + 1},}`, 'u').test(question.normalize('NFC'))) {
    reasons.push('combining_mark_stack');
  }
  if (/[<>{}`\\|]/u.test(question) || /&#?[a-z0-9]+;/iu.test(question)) reasons.push('not_plain_text');
  return reasons;
}

// A single word mixing Latin, Cyrillic and Greek letters is a look-alike substitution.
function hasMixedScriptToken(text: string): boolean {
  for (const word of text.split(/[^\p{L}\p{M}]+/u)) {
    let scripts = 0;
    if (/\p{Script=Latin}/u.test(word)) scripts += 1;
    if (/\p{Script=Cyrillic}/u.test(word)) scripts += 1;
    if (/\p{Script=Greek}/u.test(word)) scripts += 1;
    if (scripts >= 2) return true;
  }
  return false;
}

// Encoded blobs; see CONSULT_GATE_ENCODED_MIXED_RUN_CHARS. Also refused: two
// or more consecutive percent-escapes.
function hasEncodedBlob(text: string): boolean {
  if (/(?:%[0-9a-f]{2}){2,}/iu.test(text)) return true;
  for (const raw of text.split(/\s+/u)) {
    const word = raw.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    if (word.length < CONSULT_GATE_ENCODED_MIXED_RUN_CHARS) continue;
    if (!/^[A-Za-z0-9+/=_-]+$/u.test(word)) continue;
    if (/[0-9]/u.test(word) && /[A-Za-z]/u.test(word)) return true;
    if (word.length < CONSULT_GATE_ENCODED_RUN_CHARS) continue;
    if (/^[a-f]+$/iu.test(word)) return true;
    const humps = (word.match(/[a-z][A-Z]/gu) ?? []).length;
    if (/[0-9+/=]/u.test(word) || humps >= 2) return true;
  }
  return false;
}

/**
 * Question structure: the request ends with a question mark (ASCII or Arabic);
 * it holds at most CONSULT_GATE_MAX_SUB_QUESTIONS sub-questions, counted as the
 * larger of the number of question marks and the number of inline list markers
 * ("1)", "2.", "a)"); and at most CONSULT_GATE_MAX_PREAMBLE_SENTENCES
 * declarative sentences (ending at . ! ; or an ideographic full stop followed by
 * a space or the end) appear in it.
 */
function questionStructureReasons(text: string): ConsultGateReason[] {
  const trimmed = text.trim();
  const reasons: ConsultGateReason[] = [];
  if (!/[?\u061F]$/u.test(trimmed)) reasons.push('not_a_question');
  const marks = (trimmed.match(/[?\u061F]/gu) ?? []).length;
  const enumerators = (trimmed.match(/(?:^|\s)(?:\(?\d{1,2}[).]|\(?[a-h]\))(?=\s)/gu) ?? []).length;
  if (Math.max(marks, enumerators) > CONSULT_GATE_MAX_SUB_QUESTIONS) reasons.push('too_many_sub_questions');
  const boundaries = (trimmed.match(/[.!;](?=\s|$)|[\u3002\uFF01]/gu) ?? []).length;
  if (boundaries > CONSULT_GATE_MAX_PREAMBLE_SENTENCES) reasons.push('too_many_sub_questions');
  return reasons;
}

/**
 * Technical fingerprints the reference practice names, refused whether or not
 * the snapshot holds them: internal or local host names (localhost and the
 * .local, .internal, .lan, .corp, .intranet, .home.arpa, .test, .localhost
 * suffixes, or a staging/dev/internal label), IPv4 addresses, file paths with
 * three or more segments of which one holds a letter, a file:line reference (a stack-trace frame), a version
 * string with three or more components, and a hexadecimal error code.
 */
function hasTechnicalFingerprint(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\blocalhost\b/u.test(lower)) return true;
  if (/[\p{L}\p{N}-]\.(?:local|internal|lan|corp|intranet|test|localhost|home\.arpa)\b/u.test(lower)) return true;
  if (/\b(?:staging|stage|dev|internal|intranet|corp)[.-][\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(lower)) return true;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(lower)) return true;
  const path = lower.match(/(?:^|[\s(])(?:~|\.{1,2})?\/?[\p{L}\p{N}._-]+\/[\p{L}\p{N}._-]+\/[\p{L}\p{N}._-]+/u);
  if (path && /\p{L}/u.test(path[0])) return true;
  if (/\.[a-z]{1,5}:\d+\b/u.test(lower)) return true;
  if (/\bv?\d+\.\d+\.\d+/u.test(lower)) return true;
  return /\b0x[0-9a-f]{4,}\b/u.test(lower);
}

function linksRecentConsult(question: readonly string[], recent: readonly string[]): boolean {
  const n = CONSULT_GATE_LINKAGE_RUN_TOKENS;
  const wanted = new Set<string>();
  for (let index = 0; index + n <= question.length; index += 1) {
    const window = question.slice(index, index + n);
    if (window.filter((token) => !FUNCTION_WORDS.has(token)).length < CONSULT_GATE_LINKAGE_MIN_CONTENT_TOKENS) continue;
    wanted.add(window.join('\u0001'));
  }
  if (wanted.size === 0) return false;
  for (const text of recent) {
    const tokens = tokenize(foldPreservingCase(text.normalize('NFKC'))).map((token) => token.norm);
    for (let index = 0; index + n <= tokens.length; index += 1) {
      if (wanted.has(tokens.slice(index, index + n).join('\u0001'))) return true;
    }
  }
  return false;
}

/**
 * Shapes no consult needs, refused whether or not the snapshot contains them:
 * any "@" (mail addresses and handles), any URL scheme or "www." prefix, and
 * any digit sequence (single separators allowed) with more than
 * CONSULT_GATE_MAX_DIGITS_IN_SEQUENCE digits — phone and account numbers —
 * unless it is a grouped thousands figure (1,000,000).
 */
function hasIdentifierShape(text: string): boolean {
  if (text.includes('@')) return true;
  if (/\b[a-z][a-z0-9+.-]*:\/\//iu.test(text) || /\bwww\./iu.test(text)) return true;
  for (const sequence of text.match(/\+?\d(?:[\d]|[\s().\-/](?=[\d(]))*\d/gu) ?? []) {
    const digits = sequence.replace(/\D/gu, '');
    if (digits.length <= CONSULT_GATE_MAX_DIGITS_IN_SEQUENCE) continue;
    if (/^\d{1,3}(?:([,. ])\d{3})(?:\1\d{3})*$/u.test(sequence)) continue;
    return true;
  }
  return false;
}

// --- Normalization and tokens ---------------------------------------------------

const UPPER_CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic capitals
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P',
  '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u04AE': 'Y', '\u0500': 'D',
  // Greek capitals
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M',
  '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
};

const LOWER_CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic small letters
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0455': 's',
  '\u0456': 'i', '\u0458': 'j', '\u04BB': 'h', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w', '\u04CF': 'l', '\u043A': 'k',
  // Greek small letters
  '\u03BF': 'o', '\u03B1': 'a', '\u03BD': 'v', '\u03C1': 'p', '\u03B9': 'i', '\u03BA': 'k', '\u03C5': 'u', '\u03C7': 'x',
  '\u03F2': 'c', '\u03F3': 'j',
  // Latin and IPA look-alikes that NFKC leaves alone
  '\u0131': 'i', '\u0269': 'i', '\u0261': 'g', '\u0251': 'a', '\u0280': 'r',
};

function mapCharacters(text: string, table: Readonly<Record<string, string>>): string {
  let out = '';
  for (const char of text) out += table[char] ?? char;
  return out;
}

// Steps 1-4 of the module docstring; case is kept so capitalization can be read.
function foldPreservingCase(text: string): string {
  const upperFolded = mapCharacters(text.normalize('NFKC'), UPPER_CONFUSABLES);
  const unmarked = upperFolded.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  return mapCharacters(unmarked, LOWER_CONFUSABLES);
}

function caseFold(text: string): string {
  return mapCharacters(text.toLowerCase(), { '\u00DF': 'ss', '\u03C2': '\u03C3' });
}

// The full comparison normalization (steps 1-5). Exported for the leak eval and tests.
export function normalizeForComparison(text: string): string {
  return caseFold(foldPreservingCase(text));
}

interface Token {
  // Normalized, case-folded token.
  readonly norm: string;
  // First letter was upper or title case before folding.
  readonly capitalized: boolean;
  // Only whitespace, hyphens or apostrophes separate it from the previous token.
  readonly joinedToPrevious: boolean;
}

function tokenize(folded: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])[\p{L}\p{N}])+/gu;
  let previousEnd = -1;
  for (const match of folded.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const gap = previousEnd < 0 ? '' : folded.slice(previousEnd, start);
    tokens.push({
      norm: caseFold(raw),
      capitalized: /^[\p{Lu}\p{Lt}]/u.test(raw),
      joinedToPrevious: previousEnd >= 0 && gap.length <= 3 && /^[\s'’-]*$/u.test(gap),
    });
    previousEnd = start + raw.length;
  }
  return tokens;
}

function contextTokens(entry: ConsultWriterContextEntry): Token[] {
  return tokenize(foldPreservingCase(entry.text));
}

/**
 * Closed English function-word list. Used only to require two content tokens
 * in a shared run and to split capitalized runs; see
 * CONSULT_GATE_RUN_MIN_CONTENT_TOKENS for why it opens no hole.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'into', 'over', 'under', 'about',
  'and', 'or', 'but', 'nor', 'if', 'then', 'than', 'so', 'as', 'not', 'no',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'has', 'have', 'had',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'what', 'which', 'who', 'whom', 'whose', 'how', 'when', 'where', 'why',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their',
]);

// --- Comparison rules -------------------------------------------------------------

function sharesTokenRun(question: readonly string[], context: ConsultWriterContext): boolean {
  const n = CONSULT_GATE_SHARED_RUN_TOKENS;
  const wanted = new Set<string>();
  for (let index = 0; index + n <= question.length; index += 1) {
    const window = question.slice(index, index + n);
    if (window.filter((token) => !FUNCTION_WORDS.has(token)).length < CONSULT_GATE_RUN_MIN_CONTENT_TOKENS) continue;
    wanted.add(window.join('\u0001'));
  }
  if (wanted.size === 0) return false;
  for (const entry of context.entries) {
    const tokens = contextTokens(entry).map((token) => token.norm);
    for (let index = 0; index + n <= tokens.length; index += 1) {
      if (wanted.has(tokens.slice(index, index + n).join('\u0001'))) return true;
    }
  }
  return false;
}

/**
 * Names: two adjacent capitalized, non-function tokens in the snapshot (a
 * personal or place name, an organisation) where at least one of the two is
 * written capitalized more often than in lower case across the snapshot. That
 * second condition is what separates "Marguerite Okafor" from a capitalized
 * heading such as "Payment Schedule" whose words also occur in lower case in
 * running text. Counting uses prose words only (see proseWords), and
 * lower-case occurrences in the owner's own question are not counted, so an owner typing a name in lower case does not unmake it. A question that contains the pair as consecutive tokens, in
 * any case, is refused. Scripts without case have no such signal; a name in
 * them is caught only by the run and identifier rules.
 */
function sharesNamePair(question: readonly string[], context: ConsultWriterContext): boolean {
  const questionPairs = new Set<string>();
  for (let index = 0; index + 1 < question.length; index += 1) {
    // Both orders: "Given Family" and "Family, Given" are the same name.
    questionPairs.add(`${question[index]}\u0001${question[index + 1]}`);
    questionPairs.add(`${question[index + 1]}\u0001${question[index]}`);
  }
  if (questionPairs.size === 0) return false;
  const candidates: Array<readonly [string, string]> = [];
  for (const entry of context.entries) {
    if (entry.kind === 'vocabulary') continue;
    const tokens = contextTokens(entry);
    for (let index = 1; index < tokens.length; index += 1) {
      const left = tokens[index - 1]!;
      const right = tokens[index]!;
      if (!right.joinedToPrevious || !left.capitalized || !right.capitalized) continue;
      if (FUNCTION_WORDS.has(left.norm) || FUNCTION_WORDS.has(right.norm)) continue;
      if (left.norm.length < 2 || right.norm.length < 2) continue;
      if (questionPairs.has(`${left.norm}\u0001${right.norm}`)) candidates.push([left.norm, right.norm]);
    }
  }
  if (candidates.length === 0) return false;
  const watched = new Set(candidates.flat());
  const capitalizedCount = new Map<string, number>();
  const lowerCount = new Map<string, number>();
  for (const entry of context.entries) {
    if (entry.kind === 'vocabulary') continue;
    for (const token of tokenize(foldPreservingCase(proseWords(entry.text)))) {
      if (!watched.has(token.norm)) continue;
      if (!token.capitalized && entry.kind === 'user_question') continue;
      const counts = token.capitalized ? capitalizedCount : lowerCount;
      counts.set(token.norm, (counts.get(token.norm) ?? 0) + 1);
    }
  }
  const namelike = (token: string): boolean => (capitalizedCount.get(token) ?? 0) > (lowerCount.get(token) ?? 0);
  return candidates.some(([left, right]) => namelike(left) || namelike(right));
}

/**
 * The text with every word that is part of an address, host, path or handle
 * removed (anything holding @ / \\ _ or a dot between two letters or digits).
 * Those are written in lower case by convention, so counting them would make a
 * name look like an ordinary word.
 */
function proseWords(text: string): string {
  return text
    .split(/\s+/u)
    .filter((word) => !/[@/\\_]|[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(word))
    .join(' ');
}

/**
 * Scope values the product itself writes when a connector has no account
 * label. They name no one, and treating them as identifiers would refuse every
 * question containing an ordinary word such as "personal".
 */
const PRODUCT_DEFAULT_IDENTIFIER_VALUES: ReadonlySet<string> = new Set(['personal', 'default', 'primary']);

/**
 * Provenance values and other identifier entries: the whole value, and each
 * segment of a path or locator, as a token sequence. A value or segment of at
 * least CONSULT_GATE_MIN_IDENTIFIER_CHARS normalized letters and digits that
 * appears in the question as consecutive tokens is refused. A segment that is a
 * single plain word (no digit) is skipped: folder names and title prefixes are
 * mostly topic words, and refusing them refused one generic question in five
 * in the leak eval. The whole value is never skipped.
 */
function containsSnapshotIdentifier(question: readonly string[], context: ConsultWriterContext): boolean {
  const questionKey = `\u0001${question.join('\u0001')}\u0001`;
  let found = false;
  for (const entry of context.entries) {
    if (entry.kind !== 'identifier') continue;
    identifierValues(entry.text).forEach((value, index) => {
      const tokens = tokenize(foldPreservingCase(value)).map((token) => token.norm);
      if (tokens.join('').length < CONSULT_GATE_MIN_IDENTIFIER_CHARS) return;
      if (tokens.length === 1 && PRODUCT_DEFAULT_IDENTIFIER_VALUES.has(tokens[0]!)) return;
      // A segment (index > 0) that is one plain word is a folder or a topic
      // ("billing", "export"), not an identifier; whole values are always kept.
      if (index > 0 && tokens.length === 1 && !/\d/u.test(tokens[0]!)) return;
      if (questionKey.includes(`\u0001${tokens.join('\u0001')}\u0001`)) found = true;
    });
    if (found) return true;
  }
  return false;
}

// The whole value, plus each segment of a path, locator or address (split at / \ ? # & = : @).
function identifierValues(text: string): string[] {
  const values = [text];
  if (/[/\\?#&=:@]/u.test(text)) values.push(...text.split(/[/\\?#&=:@]+/u));
  return values.filter((value) => value.trim().length > 0);
}

// Hostnames in the snapshot, matched with their registrable parent in the question.
function containsSnapshotHostname(questionText: string, context: ConsultWriterContext): boolean {
  const wanted = new Set<string>();
  for (const host of hostnames(questionText)) for (const key of hostKeys(host)) wanted.add(key);
  if (wanted.size === 0) return false;
  for (const entry of context.entries) {
    for (const host of hostnames(normalizeForComparison(entry.text))) {
      for (const key of hostKeys(host)) if (wanted.has(key)) return true;
    }
  }
  return false;
}

function hostnames(normalized: string): string[] {
  return normalized.match(/(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}/gu) ?? [];
}

// The host itself and its last two labels, so a subdomain and its parent compare equal.
function hostKeys(host: string): string[] {
  const labels = host.split('.');
  const keys = [host];
  if (labels.length > 2) keys.push(labels.slice(-2).join('.'));
  return keys;
}

// --- Dates ----------------------------------------------------------------------

const MONTH_NAMES: ReadonlyMap<string, number> = buildMonthNames();

function buildMonthNames(): Map<string, number> {
  const names = new Map<string, number>();
  const lists: readonly (readonly string[])[] = [
    ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
    ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'],
    ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'],
    ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    ['januar', 'februar', 'marz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
    ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
  ];
  for (const list of lists) list.forEach((name, index) => names.set(name, index + 1));
  names.set('sept', 9);
  return names;
}

interface DateKeys {
  readonly full: Set<string>;
  readonly monthDay: Set<string>;
}

function containsSnapshotDate(questionText: string, context: ConsultWriterContext): boolean {
  const question = dateKeys(questionText);
  if (question.full.size === 0 && question.monthDay.size === 0) return false;
  for (const entry of context.entries) {
    const snapshot = dateKeys(normalizeForComparison(entry.text));
    for (const key of question.full) if (snapshot.full.has(key)) return true;
    for (const key of question.monthDay) if (snapshot.monthDay.has(key)) return true;
  }
  return false;
}

/**
 * Exact dates in common written forms: ISO (2024-03-14, with or without a
 * time), numeric day/month/year in either order (both readings kept), and a day
 * next to a month name in English, French, Spanish, German, Italian,
 * Portuguese or Dutch, with or without a year. A month with no day ("March
 * 2024") or a bare year is not an exact date.
 */
function dateKeys(normalized: string): DateKeys {
  const keys: DateKeys = { full: new Set(), monthDay: new Set() };
  const add = (year: number | undefined, month: number, day: number): void => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    keys.monthDay.add(`${month}-${day}`);
    if (year !== undefined) keys.full.add(`${year}-${month}-${day}`);
  };
  for (const match of normalized.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/gu)) {
    add(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  for (const match of normalized.matchAll(/(?<![\d\-/.])(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?!\d)/gu)) {
    const year = expandYear(match[3]!);
    add(year, Number(match[2]), Number(match[1]));
    add(year, Number(match[1]), Number(match[2]));
  }
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (let index = 0; index < words.length; index += 1) {
    const month = MONTH_NAMES.get(words[index]!);
    if (month === undefined) continue;
    const before = dayNumber(words[index - 1]) ?? (isDateJoiner(words[index - 1]) ? dayNumber(words[index - 2]) : undefined);
    const after = dayNumber(words[index + 1]);
    const yearAfter = (offset: number): number | undefined => {
      const direct = yearNumber(words[index + offset]);
      if (direct !== undefined) return direct;
      return isDateJoiner(words[index + offset]) ? yearNumber(words[index + offset + 1]) : undefined;
    };
    if (before !== undefined) add(yearAfter(1), month, before);
    if (after !== undefined) add(yearAfter(2), month, after);
  }
  return keys;
}

function dayNumber(word: string | undefined): number | undefined {
  const match = word?.match(/^(\d{1,2})(?:st|nd|rd|th|er|e|o)?$/u);
  if (!match) return undefined;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : undefined;
}

function yearNumber(word: string | undefined): number | undefined {
  if (word === undefined || !/^\d{4}$/u.test(word)) return undefined;
  return Number(word);
}

function isDateJoiner(word: string | undefined): boolean {
  return word === 'of' || word === 'de' || word === 'del' || word === 'van';
}

function expandYear(text: string): number {
  const value = Number(text);
  if (text.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

// --- Figures --------------------------------------------------------------------

function containsSnapshotFigure(questionText: string, context: ConsultWriterContext): boolean {
  const wanted = figureKeys(questionText);
  if (wanted.size === 0) return false;
  for (const entry of context.entries) {
    for (const key of figureKeys(normalizeForComparison(entry.text))) if (wanted.has(key)) return true;
  }
  return false;
}

/**
 * Exact figures: every number with at least
 * CONSULT_GATE_MIN_FIGURE_SIGNIFICANT_DIGITS significant digits, keyed by its
 * value so "48,750", "48750", "48.750" (decimal comma locales) and "48 750"
 * compare equal. Ambiguous separators yield every reading. Bare years from
 * 1900 to 2099 are exempt: a year alone identifies little, and the date rule
 * covers exact dates.
 */
function figureKeys(normalized: string): Set<string> {
  const keys = new Set<string>();
  for (const match of normalized.matchAll(/\d(?:\d|[.,'’ ](?=\d))*/gu)) {
    const raw = match[0];
    const readings = new Set<string>([raw]);
    if (raw.includes(' ')) for (const part of raw.split(' ')) readings.add(part);
    for (const reading of readings) {
      for (const value of numericReadings(reading)) {
        if (/^(?:19|20)\d\d$/u.test(value)) continue;
        if (significantDigits(value) >= CONSULT_GATE_MIN_FIGURE_SIGNIFICANT_DIGITS) keys.add(value);
      }
    }
  }
  return keys;
}

/**
 * Every valid reading of a written number: "." decimal with "," or "'" or
 * space grouping, "," decimal with "." grouping, or every separator grouping.
 * A grouping reading is valid only when each group after the first has exactly
 * three digits, so "12.5" reads only as twelve and a half while "48.750" reads
 * both ways.
 */
function numericReadings(raw: string): string[] {
  const readings = new Set<string>();
  for (const [decimal, grouping] of [['.', /[,'’ ]/u], [',', /[.'’ ]/u], ['', /[.,'’ ]/u]] as const) {
    const parts = decimal === '' ? [raw] : raw.split(decimal);
    if (parts.length > 2) continue;
    const groups = (parts[0] ?? '').split(grouping);
    if (groups.slice(1).some((group) => group.length !== 3)) continue;
    const fraction = parts[1] ?? '';
    if (fraction !== '' && !/^\d+$/u.test(fraction)) continue;
    const integer = groups.join('');
    if (!/^\d+$/u.test(integer)) continue;
    const canonicalInteger = integer.replace(/^0+(?=\d)/u, '');
    const canonicalFraction = fraction.replace(/0+$/u, '');
    readings.add(canonicalFraction ? `${canonicalInteger}.${canonicalFraction}` : canonicalInteger);
  }
  return [...readings];
}

function significantDigits(value: string): number {
  const digits = value.replace(/\./gu, '').replace(/^0+/u, '');
  return value.includes('.') ? digits.length : digits.replace(/0+$/u, '').length;
}
