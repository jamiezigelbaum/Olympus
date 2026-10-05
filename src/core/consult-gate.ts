/**
 * Consult outbound gate (docs/design/frontier-consult-lane.md, section A.4).
 *
 * A consult is a short request, written by a local writer model that has seen
 * Private evidence, which may then leave the machine. This module is the
 * mechanical check that runs on it before the owner is asked to approve it. It
 * is a pure function over:
 *
 *   - the proposed request: an array of at most CONSULT_GATE_MAX_SUB_QUESTIONS
 *     sub-questions, exactly as they would be sent;
 *   - an immutable snapshot of every text the writer could see
 *     (`consultWriterContextFromPack` derives it from the EvidencePack by schema
 *     path, plus any text the writer saw outside the pack, such as a draft
 *     answer);
 *   - limits, which a caller may tighten but never loosen; and
 *   - optionally, recently approved consults (held in memory by the caller).
 *
 * It returns `pass` or `refuse` plus content-free reason codes.
 *
 * WHAT THIS IS, PLAINLY: it rejects accidents and crude exfiltration. Passing
 * it is NOT de-identification and does not make a question anonymous, and
 * owner approval does not waive the writer's rules. Known limits, each pinned
 * by a test in test/consult-gate-review.test.ts or test/consult-gate.test.ts:
 *   - a rare combination of facts described in the writer's own words passes;
 *   - free-text name discovery is incomplete: a single-word name seen only at
 *     the start of a sentence, a name written only in lower case, and names in
 *     scripts without case (a short Chinese name) are not discovered unless
 *     they are also provenance values;
 *   - a single-label host written as an ordinary word is not recognised;
 *   - number words are parsed in English only; other languages' number words
 *     and Han numerals are not;
 *   - letter-for-digit substitution is folded only for the common digits
 *     (0 1 3 4 5 7 8); other leetspeak is not;
 *   - acrostics, word choice, case patterns and other covert channels are not
 *     detected;
 *   - linkage with recent consults detects reused wording only, never two
 *     consults about the same subject in different words.
 *
 * PRIVATE-BOUNDARY DATA: a verdict reveals something about the snapshot (a
 * refusal of "Can Nadia appeal?" says Nadia is in the evidence), and so does
 * its timing. Verdicts, reason codes and timings must never be returned to a
 * hosted or remote caller, where they would act as an adaptive oracle. See
 * CONSULT_GATE_VERDICT_IS_PRIVATE.
 *
 * Normalization (question and snapshot alike): NFKC; every Unicode decimal
 * digit to ASCII; canonical decomposition with every combining mark removed;
 * Cyrillic and Greek letters that look identical to a Latin letter mapped to
 * it, decided on the lower-case form and keeping the original case so upper-
 * and lower-case input normalize the same way; then lower case (plus sharp s
 * to "ss" and final sigma to sigma). Tokens are maximal runs of letters and
 * digits; Han, kana, Hangul, Thai, Lao, Khmer and Myanmar characters are one
 * token each, so spacing changes cannot hide a copy.
 *
 * Generic policy only: no question, domain or source classifiers. The module
 * is enrolled in test/architecture-guard.test.ts as a source-agnostic shared
 * file, and every function here that uses a regular expression is listed there.
 */

import type { EvidencePack } from './contracts.ts';
import { secretLabelsInText } from './opsec.ts';

// --- Named limits -----------------------------------------------------------

// Verdict details and timing are Private-boundary data (see the module doc).
export const CONSULT_GATE_VERDICT_IS_PRIVATE = true;

/**
 * Shared runs. A run of consecutive normalized tokens shared with the snapshot
 * is refused once it is at least this long AND holds at least
 * CONSULT_GATE_RUN_MIN_CONTENT_TOKENS content tokens anywhere in the run, so a
 * long copied sentence of mostly function words is caught. Four, because
 * three-token sequences are dominated by stock phrases while four-token ones
 * are already mostly document-specific.
 */
export const CONSULT_GATE_SHARED_RUN_TOKENS = 4;
export const CONSULT_GATE_RUN_MIN_CONTENT_TOKENS = 2;

/**
 * Content runs. The same comparison over content tokens only (function words
 * removed from both sides), so inserting or dropping function words does not
 * break a match. Four content tokens in order.
 */
export const CONSULT_GATE_CONTENT_RUN_TOKENS = 4;

// Whole request, UTF-8 bytes. A few short sentences fit; a document does not.
export const CONSULT_GATE_MAX_QUESTION_BYTES = 600;
export const CONSULT_GATE_MAX_QUESTION_TOKENS = 80;

/**
 * Sub-questions per request. The reference practice allows several safe
 * sub-questions on the same topic in one bounded request; facts whose
 * combination identifies the owner must go in separate requests. Whether
 * sub-questions are independent is the writer's judgement; the gate enforces
 * the count, and it takes the sub-questions as an array instead of guessing
 * them from punctuation. Three matches the per-answer consult cap.
 */
export const CONSULT_GATE_MAX_SUB_QUESTIONS = 3;

// Per sub-question: one context sentence, and a list of at most four items.
export const CONSULT_GATE_MAX_PREAMBLE_SENTENCES = 1;
export const CONSULT_GATE_MAX_LIST_ITEMS = 4;

/**
 * Snapshot ceilings, checked before comparison. The largest analyst prompt is
 * about 100 KB; one MiB is an order of magnitude above it. Nodes counts every
 * value the builder visits, including empty strings, so a pack of millions of
 * empty values overflows instead of passing.
 */
export const CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES = 1_048_576;
export const CONSULT_GATE_MAX_WRITER_CONTEXT_ENTRIES = 20_000;
export const CONSULT_GATE_MAX_WRITER_CONTEXT_NODES = 200_000;
const MAX_WALK_DEPTH = 24;

// A known identifier this short or longer is protected whole (one letter is not).
export const CONSULT_GATE_MIN_IDENTIFIER_CHARS = 2;

/**
 * Compacted comparison: letters and digits only, separators and case removed.
 * Windows of up to this many question tokens and characters are compared
 * against compacted identifiers and names, so "MargueriteOkafor",
 * "Mar-guerite", "M.a.r.g.u.e.r.i.t.e" and "Na'dia" all match.
 */
export const CONSULT_GATE_COMPACT_WINDOW_TOKENS = 32;
export const CONSULT_GATE_COMPACT_WINDOW_CHARS = 64;

/**
 * Figures: a number in the snapshot with at least this many digits (counted
 * as written, separators removed), or two digits next to a unit or currency,
 * is refused in the question. Years are numbers like any other.
 */
export const CONSULT_GATE_MIN_FIGURE_DIGITS = 3;
export const CONSULT_GATE_MIN_UNIT_FIGURE_DIGITS = 2;

// Snapshot digit runs this long are also matched against all question digits read jointly.
export const CONSULT_GATE_MIN_JOINT_DIGITS = 4;

// Any digit sequence (separators allowed) longer than this is refused outright.
export const CONSULT_GATE_MAX_DIGITS_IN_SEQUENCE = 8;

// Encoded runs: see hasEncodedBlob. Shorter encodings are decoded and compared instead.
export const CONSULT_GATE_ENCODED_MIXED_RUN_CHARS = 8;
export const CONSULT_GATE_ENCODED_RUN_CHARS = 16;

// Combining marks allowed on one base character (two covers Vietnamese).
export const CONSULT_GATE_MAX_COMBINING_MARKS_PER_BASE = 2;

export const CONSULT_GATE_MAX_RECENT_CONSULTS = 20;

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
  | 'recent_consults_too_large'
  | 'question_empty'
  | 'too_many_sub_questions'
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
  | 'unusual_letter'
  | 'not_a_question'
  | 'too_many_list_items'
  | 'secret_detected'
  | 'identifier_shape'
  | 'technical_fingerprint'
  | 'shared_token_run'
  | 'snapshot_name'
  | 'snapshot_identifier'
  | 'encoded_identifier'
  | 'snapshot_hostname'
  | 'snapshot_date'
  | 'snapshot_figure'
  | 'repeats_recent_consult'
  | 'links_recent_consult';

/**
 * `recentApprovedQuestions`: texts of consults the owner approved recently,
 * held in memory by the caller (the consult record is Private data, design
 * A.7) and passed per call. The gate keeps nothing between calls.
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
 * How a collected value is compared:
 *   user_question      the owner's question; compared as text (its wording is a fingerprint)
 *   text               free text the writer saw (chunks, cells, claims, coverage, a draft answer)
 *   identifier         provenance and every unknown path: text AND a value that must not appear
 *   person_identifier  author labels and connected accounts: every part protected
 *   account_scope      the account scope; as identifier, except the product's own default words
 *   vocabulary         closed product enumerations; compared as text only
 *   metadata           values the writer never sees (offsets, scores, build time); collected, not compared
 */
export type ConsultWriterContextKind =
  | 'user_question'
  | 'text'
  | 'identifier'
  | 'person_identifier'
  | 'account_scope'
  | 'vocabulary'
  | 'metadata';

export interface ConsultWriterContextEntry {
  readonly kind: ConsultWriterContextKind;
  readonly text: string;
  // Schema path with array indexes as [] and map keys as *.
  readonly path: string;
  // Candidate index; -1 for pack-level values; -2 for text outside the pack. Adjacent values in a group are compared as one text.
  readonly group: number;
}

export interface ConsultWriterContext {
  readonly entries: readonly ConsultWriterContextEntry[];
  // True when the builder stopped at a ceiling; the gate refuses.
  readonly overflow: boolean;
}

export interface ConsultWriterContextOptions {
  // Identifiers of the connected accounts. Every part is protected.
  readonly connectedAccountIdentifiers?: readonly string[];
  // Text the writer saw outside the pack, such as its own baseline or draft answer.
  readonly writerVisibleTexts?: readonly string[];
}

const PACK_PATH_KINDS: ReadonlyMap<string, ConsultWriterContextKind> = new Map([
  ['question', 'user_question'],
  ['builtAt', 'metadata'],
  ['candidates[].trustTier', 'vocabulary'],
  ['candidates[].trustDomain', 'vocabulary'],
  ['candidates[].chunks[]', 'text'],
  ['candidates[].tables[].caption', 'text'],
  ['candidates[].tables[].columns[]', 'text'],
  ['candidates[].tables[].rows[][]', 'text'],
  ['candidates[].facts[].claim', 'text'],
  ['candidates[].facts[].factId', 'metadata'],
  ['candidates[].facts[].sensitivity.trustTier', 'vocabulary'],
  ['candidates[].facts[].sensitivity.trustDomain', 'vocabulary'],
  ['candidates[].facts[].confidence', 'vocabulary'],
  ['candidates[].facts[].extractionKind', 'vocabulary'],
  ['candidates[].facts[].releaseSurface', 'vocabulary'],
  ['candidates[].facts[].sourceInstructionFlags[]', 'vocabulary'],
  ['candidates[].score', 'metadata'],
  ['coverage.searchedCorpora[]', 'text'],
  ['coverage.skippedCorpora[].corpusId', 'text'],
  ['coverage.skippedCorpora[].reason', 'text'],
  ['coverage.extractionGaps[]', 'text'],
  ['coverage.matchCounts[].corpusId', 'text'],
  ['coverage.matchCounts[].family', 'vocabulary'],
  ['coverage.matchCounts[].matchedItems', 'text'],
  ['coverage.matchCounts[].contentMatchedItems', 'text'],
  ['coverage.matchCounts[].inEvidence', 'text'],
]);

// Paths inside a provenance object (candidate provenance, or a fact's source provenance).
const PROVENANCE_PATH_KINDS: ReadonlyMap<string, ConsultWriterContextKind> = new Map([
  ['sourceItem.family', 'vocabulary'],
  ['sourceItem.accountScope', 'account_scope'],
  ['chunk.sourceItem.family', 'vocabulary'],
  ['chunk.sourceItem.accountScope', 'account_scope'],
  ['chunk.chunkIndex', 'metadata'],
  ['chunk.span.charStart', 'metadata'],
  ['chunk.span.charEnd', 'metadata'],
  ['chunk.span.itemCharStart', 'metadata'],
  ['chunk.span.itemCharEnd', 'metadata'],
  ['chunk.span.chunkChars', 'metadata'],
  ['chunk.span.lane', 'vocabulary'],
  ['citation.authorLabel', 'person_identifier'],
]);

const PROVENANCE_ROOTS: readonly string[] = ['candidates[].provenance', 'candidates[].facts[].sourceProvenance[]'];
const MAP_KEYS: ReadonlySet<string> = new Set(['providerIds', 'localIds']);

/**
 * Words the product itself writes as an account scope when a connector has no
 * account label. Exempt ONLY at the account-scope path; anywhere else,
 * including a connected-account identifier, they are protected like any value.
 */
const PRODUCT_DEFAULT_SCOPES: ReadonlySet<string> = new Set(['personal', 'default', 'primary']);

function classifyPath(path: string, isNumber: boolean): ConsultWriterContextKind {
  for (const root of PROVENANCE_ROOTS) {
    if (path === root || path.startsWith(`${root}.`)) {
      const relative = path.slice(root.length + 1);
      return PROVENANCE_PATH_KINDS.get(relative) ?? (isNumber ? 'metadata' : 'identifier');
    }
  }
  return PACK_PATH_KINDS.get(path) ?? (isNumber ? 'text' : 'identifier');
}

/**
 * Derive the writer-context snapshot from an EvidencePack. Every string and
 * number leaf is collected, whatever its path; the schema path only decides
 * how it is compared, and an unknown path is compared strictly. The result is
 * frozen.
 */
export function consultWriterContextFromPack(
  pack: EvidencePack,
  options: ConsultWriterContextOptions = {},
): ConsultWriterContext {
  const entries: ConsultWriterContextEntry[] = [];
  const state = { bytes: 0, nodes: 0, overflow: false };
  const ancestors = new Set<object>();
  const push = (kind: ConsultWriterContextKind, text: string, path: string, group: number): void => {
    const bytes = utf8Bytes(text);
    if (
      entries.length + 1 > CONSULT_GATE_MAX_WRITER_CONTEXT_ENTRIES
      || state.bytes + bytes > CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES
    ) {
      state.overflow = true;
      return;
    }
    state.bytes += bytes;
    if (text.length > 0) entries.push(Object.freeze({ kind, text, path, group }));
  };
  const walk = (value: unknown, path: string, group: number, depth: number): void => {
    if (state.overflow) return;
    state.nodes += 1;
    if (state.nodes > CONSULT_GATE_MAX_WRITER_CONTEXT_NODES || depth > MAX_WALK_DEPTH) {
      state.overflow = true;
      return;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      push(classifyPath(path, typeof value !== 'string'), String(value), path, group);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    // Only a cycle is skipped; a shared sub-object is walked wherever it appears.
    if (ancestors.has(value)) return;
    ancestors.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemGroup = path === 'candidates' ? index : group;
        walk(item, `${path}[]`, itemGroup, depth + 1);
      });
    } else {
      const parentKey = path.slice(path.lastIndexOf('.') + 1);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const segment = MAP_KEYS.has(parentKey) ? '*' : key;
        walk(child, path ? `${path}.${segment}` : segment, group, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  walk(pack, '', -1, 0);
  for (const text of options.writerVisibleTexts ?? []) push('text', text, 'writerVisible[]', -2);
  for (const identifier of options.connectedAccountIdentifiers ?? []) {
    push('person_identifier', identifier, 'connectedAccount[]', -3);
  }
  return Object.freeze({ entries: Object.freeze(entries), overflow: state.overflow });
}

// --- Gate ---------------------------------------------------------------------

// One sub-question; see evaluateConsultRequest.
export function evaluateConsultQuestion(
  question: string,
  context: ConsultWriterContext,
  limits: Partial<ConsultGateLimits> = {},
  history: ConsultGateHistory = {},
): ConsultGateVerdict {
  return evaluateConsultRequest([question], context, limits, history);
}

/**
 * Check one proposed consult request (its sub-questions) against the writer's
 * context. Limits may only tighten the defaults; a larger value is clamped.
 */
export function evaluateConsultRequest(
  subQuestions: readonly string[],
  context: ConsultWriterContext,
  limits: Partial<ConsultGateLimits> = {},
  history: ConsultGateHistory = {},
): ConsultGateVerdict {
  const effective = clampLimits(limits);
  const recent = history.recentApprovedQuestions ?? [];

  // 1. Size of every input, before any other work.
  if (context.overflow || !writerContextWithinLimits(context, effective)) return refuse(['writer_context_too_large']);
  if (
    recent.length > CONSULT_GATE_MAX_RECENT_CONSULTS
    || recent.some((text) => typeof text !== 'string' || utf8Bytes(text) > CONSULT_GATE_MAX_QUESTION_BYTES)
  ) {
    return refuse(['recent_consults_too_large']);
  }
  if (subQuestions.length === 0) return refuse(['question_empty']);
  if (subQuestions.length > CONSULT_GATE_MAX_SUB_QUESTIONS) return refuse(['too_many_sub_questions']);
  if (subQuestions.some((question) => typeof question !== 'string')) return refuse(['not_plain_text']);
  if (subQuestions.reduce((total, question) => total + utf8Bytes(question), 0) > effective.maxQuestionBytes) {
    return refuse(['question_too_many_bytes']);
  }

  // 2. The request on its own. Any refusal here returns before snapshot work.
  const reasons = new Set<ConsultGateReason>();
  let tokenCount = 0;
  for (const question of subQuestions) {
    if (question.trim().length === 0) {
      reasons.add('question_empty');
      continue;
    }
    for (const reason of characterReasons(question)) reasons.add(reason);
    const nfkc = question.normalize('NFKC');
    for (const reason of scriptReasons(nfkc)) reasons.add(reason);
    for (const reason of questionStructureReasons(nfkc)) reasons.add(reason);
    if (hasEncodedBlob(nfkc)) reasons.add('encoded_blob');
    if (secretLabelsInText(question).length > 0 || secretLabelsInText(nfkc).length > 0) reasons.add('secret_detected');
    if (hasIdentifierShape(nfkc)) reasons.add('identifier_shape');
    if (hasTechnicalFingerprint(nfkc)) reasons.add('technical_fingerprint');
    let count = 0;
    forEachToken(foldText(nfkc), () => { count += 1; });
    if (count === 0) reasons.add('question_empty');
    tokenCount += count;
  }
  if (tokenCount > effective.maxQuestionTokens) reasons.add('question_too_many_tokens');
  if (reasons.size > 0) return refuse([...reasons]);

  // 3. Comparison. The question side is small; the snapshot is streamed once.
  const model = questionModel(subQuestions);
  for (const reason of compareWithSnapshot(model, context)) reasons.add(reason);
  for (const reason of compareWithRecent(model, subQuestions, recent)) reasons.add(reason);
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

// --- Rules on the request alone -----------------------------------------------

/**
 * Plain text: NFKC-stable (no fullwidth or styled variants, which could carry
 * bits by choice of form); no control characters, including tab and newline;
 * no format, private-use, unassigned or invisible characters (zero-width, bidi
 * controls, tags, variation selectors, fillers); only the ASCII space as
 * whitespace, never doubled or at the ends; at most
 * CONSULT_GATE_MAX_COMBINING_MARKS_PER_BASE combining marks on one base; none
 * of < > { } ` \ |; no HTML character references; no percent-escapes.
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
  if (/[^\S ]/u.test(question.replace(/\p{Cc}/gu, '')) || /^ | $| {2,}/u.test(question)) reasons.push('irregular_whitespace');
  const marksPerBase = new RegExp(`\\p{M}{${CONSULT_GATE_MAX_COMBINING_MARKS_PER_BASE + 1},}`, 'u');
  if (marksPerBase.test(question.normalize('NFD'))) reasons.push('combining_mark_stack');
  if (/[<>{}`\\|]/u.test(question) || /&#?[a-z0-9]+;/iu.test(question)) reasons.push('not_plain_text');
  if (/%[0-9a-f]{2}/iu.test(question)) reasons.push('encoded_blob');
  return reasons;
}

/**
 * Scripts. A word whose letters come from two scripts is refused (Han, kana
 * and Hangul count as one, as Japanese and Korean mix them). A Latin letter
 * outside the basic alphabet and a closed set of ordinary European letters
 * (after accents are removed) is refused as unusual: IPA and other look-alikes
 * are refused rather than mapped, since an unknown look-alike is safer refused.
 */
function scriptReasons(text: string): ConsultGateReason[] {
  const reasons = new Set<ConsultGateReason>();
  for (const word of text.split(/[^\p{L}\p{M}]+/u)) {
    if (!word) continue;
    const scripts = new Set<string>();
    for (const char of word) {
      if (!/\p{L}/u.test(char)) continue;
      const script = scriptOf(char);
      scripts.add(script);
      if (script === 'latin') {
        const base = char.normalize('NFD').replace(/\p{M}+/gu, '');
        if (!/^[A-Za-z\u00DF\u00E6\u00C6\u0153\u0152\u00F8\u00D8\u00F0\u00D0\u00FE\u00DE\u0142\u0141\u0111\u0110\u0127\u0126\u014B\u014A\u0131]$/u.test(base)) {
          reasons.add('unusual_letter');
        }
      }
    }
    if (scripts.size > 1) reasons.add('mixed_script_token');
  }
  return [...reasons];
}

function scriptOf(char: string): string {
  if (/\p{Script=Latin}/u.test(char)) return 'latin';
  if (/\p{Script=Cyrillic}/u.test(char)) return 'cyrillic';
  if (/\p{Script=Greek}/u.test(char)) return 'greek';
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) return 'cjk';
  for (const script of ['Arabic', 'Hebrew', 'Armenian', 'Georgian', 'Devanagari', 'Bengali', 'Thai', 'Ethiopic', 'Tamil', 'Cherokee']) {
    if (new RegExp(`\\p{Script=${script}}`, 'u').test(char)) return script;
  }
  return `other:${char}`;
}

/**
 * Structure of one sub-question: it ends with a question mark (ASCII or
 * Arabic) and holds only that one; at most CONSULT_GATE_MAX_PREAMBLE_SENTENCES
 * declarative sentences come before it; and it asks for a bounded list: at
 * most CONSULT_GATE_MAX_LIST_ITEMS items, counted as commas and semicolons
 * plus one, or as list markers. More is several asks behind one question mark.
 */
function questionStructureReasons(text: string): ConsultGateReason[] {
  const trimmed = text.trim();
  const reasons: ConsultGateReason[] = [];
  const marks = (trimmed.match(/[?\u061F]/gu) ?? []).length;
  if (marks !== 1 || !/[?\u061F]$/u.test(trimmed)) reasons.push('not_a_question');
  const boundaries = (trimmed.match(/[.!;](?=\s|$)|[\u3002\uFF01]/gu) ?? []).length;
  if (boundaries > CONSULT_GATE_MAX_PREAMBLE_SENTENCES) reasons.push('too_many_list_items');
  const separators = (trimmed.match(/[,;\u3001\u060C]/gu) ?? []).length;
  const enumerators = (trimmed.match(/(?:^|\s)(?:\(?\d{1,2}[).]|\(?[a-h]\))(?=\s)/gu) ?? []).length;
  if (separators + 1 > CONSULT_GATE_MAX_LIST_ITEMS || enumerators > CONSULT_GATE_MAX_LIST_ITEMS) {
    reasons.push('too_many_list_items');
  }
  return reasons;
}

/**
 * Encoded runs refused on sight: a word (split at anything outside the
 * base64url alphabet) of at least CONSULT_GATE_ENCODED_MIXED_RUN_CHARS that
 * mixes letters and digits, or of at least CONSULT_GATE_ENCODED_RUN_CHARS that
 * is all hex letters or carries + / = or two inner case changes. Shorter
 * encodings are decoded and compared instead (see decodedViews).
 */
function hasEncodedBlob(text: string): boolean {
  for (const word of text.split(/[^A-Za-z0-9+/=_-]+/u)) {
    if (word.length < CONSULT_GATE_ENCODED_MIXED_RUN_CHARS) continue;
    if (/[0-9]/u.test(word) && /[A-Za-z]/u.test(word)) return true;
    if (word.length < CONSULT_GATE_ENCODED_RUN_CHARS) continue;
    if (/^[a-f]+$/iu.test(word)) return true;
    const humps = (word.match(/[a-z][A-Z]/gu) ?? []).length;
    if (/[+/=]/u.test(word) || humps >= 2) return true;
  }
  return false;
}

/**
 * Shapes no consult needs, refused whether or not the snapshot holds them: any
 * "@", any URL scheme or "www.", and any digit sequence (single separators
 * allowed) of more than CONSULT_GATE_MAX_DIGITS_IN_SEQUENCE digits unless it is
 * a grouped thousands figure.
 */
function hasIdentifierShape(text: string): boolean {
  if (text.includes('@')) return true;
  if (/\b[a-z][a-z0-9+.-]*:\/\//iu.test(text) || /\bwww\./iu.test(text)) return true;
  for (const sequence of text.match(/\+?\d(?:\d|[\s().\-/_](?=[\d(]))*\d/gu) ?? []) {
    const digits = sequence.replace(/\D/gu, '');
    if (digits.length <= CONSULT_GATE_MAX_DIGITS_IN_SEQUENCE) continue;
    if (/^\d{1,3}(?:([,. ])\d{3})(?:\1\d{3})*$/u.test(sequence)) continue;
    return true;
  }
  return false;
}

/**
 * Technical fingerprints, refused on sight: localhost and internal suffixes
 * (.local .internal .lan .corp .intranet .test .localhost .home.arpa), a
 * staging/dev/internal host label, an IPv4 address, any slash between two
 * letters or digits (a path; "and/or" is refused too, words are cheaper), a
 * file:line frame, a version with three or more parts, a hex error code.
 */
function hasTechnicalFingerprint(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\blocalhost\b/u.test(lower)) return true;
  if (/[\p{L}\p{N}-]\.(?:local|internal|lan|corp|intranet|test|localhost|home\.arpa)\b/u.test(lower)) return true;
  if (/\b(?:staging|stage|dev|internal|intranet|corp)[.-][\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(lower)) return true;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(lower)) return true;
  if (/[\p{L}\p{N}]\/[\p{L}\p{N}]/u.test(lower)) return true;
  if (/\.[a-z]{1,5}:\d+\b/u.test(lower)) return true;
  if (/\bv?\d+\.\d+\.\d+/u.test(lower)) return true;
  return /\b0x[0-9a-f]{4,}\b/u.test(lower);
}

// --- Normalization and tokens ---------------------------------------------------

// Lower-case Cyrillic, Greek and Latin letters that render as a basic Latin letter.
const LOOKALIKES: Readonly<Record<string, string>> = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0455': 's',
  '\u0456': 'i', '\u0458': 'j', '\u04BB': 'h', '\u0501': 'd', '\u051B': 'q', '\u051D': 'w', '\u04CF': 'l', '\u043A': 'k',
  '\u0432': 'b', '\u043C': 'm', '\u043D': 'h', '\u0442': 't', '\u04AF': 'y',
  '\u03BF': 'o', '\u03B1': 'a', '\u03BD': 'v', '\u03C1': 'p', '\u03B9': 'i', '\u03BA': 'k', '\u03C5': 'u', '\u03C7': 'x',
  '\u03F2': 'c', '\u03F3': 'j', '\u03B2': 'b', '\u03B5': 'e', '\u03B6': 'z', '\u03B7': 'h', '\u03BC': 'm', '\u03C4': 't',
  '\u0131': 'i', '\u0269': 'i', '\u0261': 'g', '\u0251': 'a', '\u0280': 'r', '\u0192': 'f',
};

// Digit-for-letter substitutions folded when comparing against identifiers and names.
const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b' };

function mapCharacters(text: string, table: Readonly<Record<string, string>>): string {
  let out = '';
  for (const char of text) out += table[char] ?? char;
  return out;
}

// Every Unicode decimal digit to its ASCII digit.
function asciiDigits(text: string): string {
  if (!/[^\x00-\x7F]/u.test(text)) return text;
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x80 || !/\p{Nd}/u.test(char)) {
      out += char;
      continue;
    }
    let start = code;
    while (start > code - 100 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    out += String((code - start) % 10);
  }
  return out;
}

// NFKC, ASCII digits, marks removed, look-alikes mapped; case kept.
function foldText(text: string): string {
  const nfkc = text.normalize('NFKC');
  // Plain ASCII needs none of the steps below; skipping them keeps a large
  // snapshot from allocating copies of itself.
  if (!/[^\x00-\x7F]/u.test(nfkc)) return nfkc;
  const unmarked = asciiDigits(nfkc).normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
  let out = '';
  for (const char of unmarked) {
    const lower = char.toLowerCase();
    const mapped = LOOKALIKES[lower];
    out += mapped === undefined ? char : char === lower ? mapped : mapped.toUpperCase();
  }
  return out;
}

function caseFold(text: string): string {
  const lower = text.toLowerCase();
  return /[\u00DF\u03C2]/u.test(lower) ? mapCharacters(lower, { '\u00DF': 'ss', '\u03C2': '\u03C3' }) : lower;
}

// The full comparison normalization. Exported for tests.
export function normalizeForComparison(text: string): string {
  return caseFold(foldText(text));
}

function compact(text: string): string {
  let out = '';
  forEachToken(foldText(text), (token) => { out += token.norm; });
  return out;
}

interface Token {
  readonly norm: string;
  readonly capitalized: boolean;
  // First token of the text, or the first after . ! ? ; :
  readonly initial: boolean;
  // Only whitespace, hyphens or apostrophes since the previous token.
  readonly joined: boolean;
}

function forEachToken(folded: string, visit: (token: Token) => void): void {
  const pattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])[\p{L}\p{N}])+/gu;
  let previousEnd = -1;
  for (const match of folded.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const gap = previousEnd < 0 ? '' : folded.slice(previousEnd, start);
    visit({
      norm: caseFold(raw),
      capitalized: /^[\p{Lu}\p{Lt}]/u.test(raw),
      initial: previousEnd < 0 || /[.!?;:]/u.test(gap),
      joined: previousEnd >= 0 && /^[\s'\u2019-]*$/u.test(gap),
    });
    previousEnd = start + raw.length;
  }
}

// Closed English function-word list: run content counting only.
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

/**
 * Words that cannot be part of a personal name: articles, prepositions,
 * conjunctions, pronouns, auxiliaries, plus month and weekday names. Modal
 * verbs ("Will", "May") are deliberately NOT here: they are also given names.
 */
const NAME_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'and', 'or', 'but', 'if', 'as', 'so',
  'than', 'then', 'not', 'no', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'who', 'how', 'when', 'where', 'why',
  'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your', 'our', 'their', 'his', 'her', 'dear', 'mr', 'mrs', 'ms', 'dr',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

function isContent(token: string): boolean {
  return !FUNCTION_WORDS.has(token);
}

// --- The question side ------------------------------------------------------------

type FormSource = 'plain' | 'decoded';

interface QuestionModel {
  // Normalized tokens of all sub-questions, in order.
  readonly tokens: readonly string[];
  // Compacted windows (and their reversals, and digit-folded variants), with where they came from.
  readonly forms: ReadonlyMap<string, FormSource>;
  // \u0001-joined token sequences of every view, for long identifier containment.
  readonly tokenKeys: readonly string[];
  readonly numberKeys: ReadonlySet<string>;
  readonly digitConcat: string;
  readonly dates: DateKeys;
  readonly hostKeys: ReadonlySet<string>;
}

function questionModel(subQuestions: readonly string[]): QuestionModel {
  const joined = subQuestions.join(' ');
  const folded = foldText(joined);
  const tokens: string[] = [];
  forEachToken(folded, (token) => tokens.push(token.norm));
  const forms = new Map<string, FormSource>();
  const tokenKeys: string[] = [];
  const addView = (viewTokens: readonly string[], source: FormSource): void => {
    tokenKeys.push(`\u0001${viewTokens.join('\u0001')}\u0001`);
    const variants = [viewTokens, viewTokens.map((token) => (/\p{L}/u.test(token) ? mapCharacters(token, LEET) : token))];
    for (const variant of variants) {
      for (let start = 0; start < variant.length; start += 1) {
        let concat = '';
        for (let end = start; end < variant.length && end - start < CONSULT_GATE_COMPACT_WINDOW_TOKENS; end += 1) {
          concat += variant[end];
          if (concat.length > CONSULT_GATE_COMPACT_WINDOW_CHARS) break;
          if (!forms.has(concat)) forms.set(concat, source);
          const reversed = [...concat].reverse().join('');
          if (!forms.has(reversed)) forms.set(reversed, source);
        }
      }
    }
  };
  addView(tokens, 'plain');
  for (const view of decodedViews(joined.normalize('NFKC'))) {
    const viewTokens: string[] = [];
    forEachToken(foldText(view), (token) => viewTokens.push(token.norm));
    addView(viewTokens, 'decoded');
  }
  const normalized = caseFold(folded);
  const wordDigits = numberWordsToDigits(tokens);
  const numberKeys = new Set<string>();
  for (const key of figureKeys(normalized, false).keys()) numberKeys.add(key);
  for (const key of figureKeys(wordDigits.join(' '), false).keys()) numberKeys.add(key);
  const digitConcat = (normalized.match(/\d/gu) ?? []).join('');
  const dates = dateKeys(normalized, wordDigits);
  const hostKeys = new Set<string>();
  const spelled = normalized.replace(/\s+dot\s+/gu, '.').replace(/[\u3002\uFF0E\uFF61]/gu, '.');
  for (const host of hostnames(spelled)) for (const key of hostKeysOf(host)) hostKeys.add(key);
  return { tokens, forms, tokenKeys, numberKeys, digitConcat, dates, hostKeys };
}

/**
 * Bounded decodings of the request: base64 and base64url runs of four or more
 * characters, alone and joined across punctuation without spaces; and hex
 * runs of two or more byte pairs, with or without single separators. A
 * decoding is kept when it is valid UTF-8 and mostly letters and spaces.
 */
function decodedViews(text: string): string[] {
  const views: string[] = [];
  const keep = (bytes: Buffer): void => {
    const decoded = bytes.toString('utf8');
    if (decoded.length < 2 || decoded.includes('\uFFFD')) return;
    const letters = (decoded.match(/[\p{L}\s]/gu) ?? []).length;
    if (letters / decoded.length >= 0.7) views.push(decoded);
  };
  for (const chunk of text.split(/\s+/u)) {
    const pieces = chunk.split(/[^A-Za-z0-9+/=_-]+/u).filter((piece) => piece.length >= 4);
    const candidates = new Set(pieces);
    if (pieces.length > 1) candidates.add(pieces.join(''));
    for (const candidate of candidates) {
      const standard = candidate.replace(/-/gu, '+').replace(/_/gu, '/').replace(/=+$/u, '');
      if (standard.length % 4 === 1) continue;
      keep(Buffer.from(standard, 'base64'));
    }
  }
  for (const match of text.matchAll(/(?:[0-9a-f]{2}[\s:,.-]?){2,}/giu)) {
    const hex = match[0].replace(/[^0-9a-f]/giu, '');
    if (hex.length % 2 === 0) keep(Buffer.from(hex, 'hex'));
  }
  return views;
}

// --- Number words (English) -------------------------------------------------------

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['zero', 0], ['oh', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7],
  ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
  ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
  ['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5], ['sixth', 6], ['seventh', 7], ['eighth', 8],
  ['ninth', 9], ['tenth', 10], ['eleventh', 11], ['twelfth', 12], ['thirteenth', 13], ['fourteenth', 14],
  ['fifteenth', 15], ['sixteenth', 16], ['seventeenth', 17], ['eighteenth', 18], ['nineteenth', 19],
  ['twentieth', 20], ['thirtieth', 30],
]);
const SCALE_WORDS: ReadonlyMap<string, number> = new Map([
  ['hundred', 100], ['thousand', 1_000], ['million', 1_000_000], ['billion', 1_000_000_000],
]);

/**
 * Replace each run of English number words with digit tokens: its arithmetic
 * value ("two thousand three hundred seventy five point five zero" is
 * 2375.50), and, when the run has no scale word, the digits of its groups
 * written one after another ("twenty twenty four" is 2024).
 */
function numberWordsToDigits(tokens: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const start = index;
    let total = 0;
    let current = 0;
    let scaled = false;
    let decimal = '';
    let inDecimal = false;
    const groups: number[] = [];
    while (index < tokens.length) {
      const word = tokens[index]!;
      const value = NUMBER_WORDS.get(word);
      const scale = SCALE_WORDS.get(word);
      if (inDecimal && value !== undefined && value < 10) {
        decimal += String(value);
      } else if (word === 'point' && index > start && !inDecimal) {
        inDecimal = true;
      } else if (value !== undefined && !inDecimal) {
        const last = groups.length > 0 ? groups[groups.length - 1]! : undefined;
        if (last !== undefined && last % 10 === 0 && last >= 20 && last < 100 && value < 10) {
          groups[groups.length - 1] = last + value;
        } else {
          groups.push(value);
        }
        current += value;
      } else if (scale !== undefined && !inDecimal && index > start) {
        scaled = true;
        if (scale === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * scale;
          current = 0;
        }
      } else if (word === 'and' && index > start && !inDecimal) {
        // "three hundred and five"
      } else break;
      index += 1;
    }
    if (index === start) {
      out.push(tokens[index]!);
      index += 1;
      continue;
    }
    const integer = String(total + current);
    out.push(decimal ? `${integer}.${decimal}` : integer);
    if (!scaled && groups.length > 1) out.push(groups.map(String).join(''));
  }
  return out;
}

// --- Snapshot comparison -------------------------------------------------------------

interface RunMatcher {
  feed(token: string): boolean;
  reset(): void;
}

/**
 * Streaming longest-common-run detector against the question's tokens. For
 * each snapshot token it extends every run ending at a matching question
 * position; a run is a hit once it reaches `minLength` tokens with at least
 * `minContent` content tokens anywhere in it. Work per snapshot token is the
 * number of question positions holding that token, so the total is bounded by
 * snapshot tokens times question tokens.
 */
function runMatcher(question: readonly string[], minLength: number, minContent: number): RunMatcher {
  const positions = new Map<string, number[]>();
  question.forEach((token, index) => {
    const list = positions.get(token) ?? [];
    list.push(index);
    positions.set(token, list);
  });
  let active = new Map<number, { length: number; content: number }>();
  return {
    feed(token: string): boolean {
      const next = new Map<number, { length: number; content: number }>();
      let hit = false;
      for (const position of positions.get(token) ?? []) {
        const previous = active.get(position - 1);
        const run = {
          length: (previous?.length ?? 0) + 1,
          content: (previous?.content ?? 0) + (isContent(token) ? 1 : 0),
        };
        next.set(position, run);
        if (run.length >= minLength && run.content >= minContent) hit = true;
      }
      active = next;
      return hit;
    },
    reset(): void {
      active = new Map();
    },
  };
}

interface NameStats {
  capitalized: number;
  lower: number;
}

function compareWithSnapshot(model: QuestionModel, context: ConsultWriterContext): Set<ConsultGateReason> {
  const reasons = new Set<ConsultGateReason>();
  const fullRun = runMatcher(model.tokens, CONSULT_GATE_SHARED_RUN_TOKENS, CONSULT_GATE_RUN_MIN_CONTENT_TOKENS);
  const contentRun = runMatcher(model.tokens.filter(isContent), CONSULT_GATE_CONTENT_RUN_TOKENS, 0);
  const formHit = (form: string): FormSource | undefined =>
    form.length >= CONSULT_GATE_MIN_IDENTIFIER_CHARS ? model.forms.get(form) : undefined;
  const identifierHit = (source: FormSource | undefined): void => {
    if (source) reasons.add(source === 'decoded' ? 'encoded_identifier' : 'snapshot_identifier');
  };
  const stats = new Map<string, NameStats>();
  const pairCandidates: Array<{ left: string; right: string; midSentence: boolean }> = [];
  const singleCandidates: Array<{ token: string; source: FormSource }> = [];
  const componentCandidates: Array<{ token: string; source: FormSource }> = [];
  let group = Number.NaN;
  let previous: Token | undefined;

  for (const entry of context.entries) {
    if (entry.kind === 'metadata') continue;
    if (entry.group !== group) {
      group = entry.group;
      fullRun.reset();
      contentRun.reset();
      previous = undefined;
    }
    const folded = foldText(entry.text);
    const normalized = caseFold(folded);

    // Values: figures, digits read jointly, dates, hosts, labelled secrets.
    for (const [key, unit] of figureKeys(normalized, true)) {
      if (model.numberKeys.has(key) && (key.replace(/\D/gu, '').length >= CONSULT_GATE_MIN_FIGURE_DIGITS || unit)) {
        reasons.add('snapshot_figure');
      }
    }
    for (const run of normalized.match(/\d(?:[\d]|[\s.\-/_](?=\d))*/gu) ?? []) {
      const digits = run.replace(/\D/gu, '');
      if (digits.length >= CONSULT_GATE_MIN_JOINT_DIGITS && model.digitConcat.includes(digits)) reasons.add('snapshot_figure');
    }
    if (model.dates.full.size > 0 || model.dates.monthDay.size > 0) {
      const snapshotDates = dateKeys(normalized, undefined);
      for (const key of model.dates.full) if (snapshotDates.full.has(key)) reasons.add('snapshot_date');
      for (const key of model.dates.monthDay) if (snapshotDates.monthDay.has(key)) reasons.add('snapshot_date');
    }
    if (model.hostKeys.size > 0) {
      for (const host of hostnames(normalized)) {
        for (const key of hostKeysOf(host)) if (model.hostKeys.has(key)) reasons.add('snapshot_hostname');
      }
    }
    for (const value of labelledSecretValues(normalized)) {
      if (formHit(compact(value))) reasons.add('secret_detected');
    }

    // Identifier values: whole, long token sequences, and their parts.
    const isIdentifier = entry.kind === 'identifier' || entry.kind === 'person_identifier' || entry.kind === 'account_scope';
    if (isIdentifier) {
      const whole = compact(entry.text);
      const exempt = entry.kind === 'account_scope' && PRODUCT_DEFAULT_SCOPES.has(whole);
      if (!exempt) {
        identifierHit(formHit(whole));
        // Each segment of a path, locator, address or "label: value" title is
        // protected whole when it is more than one word or carries a digit.
        for (const segment of entry.text.split(/[/\\?#&=:@]+/u)) {
          const segmentForm = compact(segment);
          let words = 0;
          forEachToken(foldText(segment), () => { words += 1; });
          if (segmentForm !== whole && (words > 1 || /\d/u.test(segmentForm))) identifierHit(formHit(segmentForm));
        }
        const valueTokens: string[] = [];
        forEachToken(folded, (token) => valueTokens.push(token.norm));
        if (valueTokens.length > 1 && model.tokenKeys.some((key) => key.includes(`\u0001${valueTokens.join('\u0001')}\u0001`))) {
          reasons.add('snapshot_identifier');
        }
        forEachToken(folded, (token) => {
          if (token.norm.length < 3 || NAME_STOPWORDS.has(token.norm)) return;
          const source = formHit(token.norm);
          if (!source) return;
          if (entry.kind === 'person_identifier' || (/\d/u.test(token.norm) && /\p{L}/u.test(token.norm))) identifierHit(source);
          else if (token.capitalized && !token.initial) componentCandidates.push({ token: token.norm, source });
        });
      }
    }

    // Token stream: shared runs, name pairs and single names, case statistics.
    let first = true;
    forEachToken(folded, (token) => {
      if (fullRun.feed(token.norm)) reasons.add('shared_token_run');
      if (isContent(token.norm) && contentRun.feed(token.norm)) reasons.add('shared_token_run');
      if (entry.kind === 'vocabulary') {
        previous = token;
        first = false;
        return;
      }
      const watched = model.forms.has(token.norm);
      if (watched) {
        const stat = stats.get(token.norm) ?? { capitalized: 0, lower: 0 };
        if (token.capitalized) stat.capitalized += 1;
        else if (entry.kind !== 'user_question') stat.lower += 1;
        stats.set(token.norm, stat);
      }
      const joined = first ? previous !== undefined : token.joined;
      if (previous && joined && previous.capitalized && token.capitalized
        && !NAME_STOPWORDS.has(previous.norm) && !NAME_STOPWORDS.has(token.norm)
        && previous.norm.length >= 2 && token.norm.length >= 2) {
        const source = model.forms.get(previous.norm + token.norm) ?? model.forms.get(token.norm + previous.norm)
          ?? model.forms.get(previous.norm) ?? model.forms.get(token.norm);
        if (source) {
          const midSentence = !(first || token.initial) || !previous.initial;
          pairCandidates.push({ left: previous.norm, right: token.norm, midSentence });
        }
      }
      const initial = first || token.initial;
      if (watched && token.capitalized && !initial && token.norm.length >= 3 && !NAME_STOPWORDS.has(token.norm)) {
        singleCandidates.push({ token: token.norm, source: model.forms.get(token.norm)! });
      }
      previous = token;
      first = false;
    });
  }

  // Decisions that need whole-snapshot case statistics.
  const statOf = (token: string): NameStats => stats.get(token) ?? { capitalized: 0, lower: 0 };
  const neverLower = (token: string): boolean => statOf(token).lower === 0;
  const namelike = (token: string): boolean => statOf(token).capitalized >= statOf(token).lower;
  const nameHit = (source: FormSource): void => { reasons.add(source === 'decoded' ? 'encoded_identifier' : 'snapshot_name'); };
  for (const pair of pairCandidates) {
    if (!namelike(pair.left) && !namelike(pair.right)) continue;
    const pairSource = model.forms.get(pair.left + pair.right) ?? model.forms.get(pair.right + pair.left);
    if (pairSource) nameHit(pairSource);
    // A part alone is protected only when the pair was written mid-sentence
    // (not two first words, such as a column header next to a cell) and the
    // part never appears in lower case.
    if (!pair.midSentence) continue;
    for (const part of [pair.left, pair.right]) {
      const partSource = model.forms.get(part);
      if (partSource && part.length >= 3 && neverLower(part)) nameHit(partSource);
    }
  }
  for (const single of singleCandidates) if (neverLower(single.token)) nameHit(single.source);
  for (const component of componentCandidates) if (neverLower(component.token)) identifierHit(component.source);
  return reasons;
}

function compareWithRecent(model: QuestionModel, subQuestions: readonly string[], recent: readonly string[]): Set<ConsultGateReason> {
  const reasons = new Set<ConsultGateReason>();
  if (recent.length === 0) return reasons;
  const asked = new Set([...subQuestions, subQuestions.join(' ')].map(compact));
  const fullRun = runMatcher(model.tokens, CONSULT_GATE_SHARED_RUN_TOKENS, CONSULT_GATE_RUN_MIN_CONTENT_TOKENS);
  const contentRun = runMatcher(model.tokens.filter(isContent), CONSULT_GATE_CONTENT_RUN_TOKENS, 0);
  for (const text of recent) {
    if (asked.has(compact(text))) reasons.add('repeats_recent_consult');
    fullRun.reset();
    contentRun.reset();
    forEachToken(foldText(text), (token) => {
      if (fullRun.feed(token.norm)) reasons.add('links_recent_consult');
      if (isContent(token.norm) && contentRun.feed(token.norm)) reasons.add('links_recent_consult');
    });
  }
  return reasons;
}

// Values written right after a secret-like label ("password: x", "pin = x").
function labelledSecretValues(normalized: string): string[] {
  const values: string[] = [];
  for (const match of normalized.matchAll(/\b(?:password|passcode|passphrase|pin|secret|token|api key|apikey|key)\s*[:=]\s*(\S{3,64})/gu)) {
    values.push(match[1]!);
  }
  return values;
}

// --- Hosts ----------------------------------------------------------------------

/**
 * Host names, found by one linear pass: split at every character that cannot
 * appear in a host, trim dots and hyphens, and keep pieces of two or more
 * non-empty labels whose last label is two or more letters.
 */
function hostnames(normalized: string): string[] {
  const hosts: string[] = [];
  for (const raw of normalized.split(/[^\p{L}\p{N}.-]+/u)) {
    if (!raw.includes('.')) continue;
    const piece = raw.replace(/^[.-]+|[.-]+$/gu, '');
    if (piece.length > 253) continue;
    const labels = piece.split('.');
    if (labels.length < 2 || labels.some((label) => label.length === 0 || label.length > 63)) continue;
    if (!/^\p{L}{2,}$/u.test(labels[labels.length - 1]!)) continue;
    hosts.push(piece);
  }
  return hosts;
}

// The host itself and its last two labels, so a subdomain and its parent compare equal.
function hostKeysOf(host: string): string[] {
  const labels = host.split('.');
  return labels.length > 2 ? [host, labels.slice(-2).join('.')] : [host];
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

const ROMAN_MONTHS: ReadonlyMap<string, number> = new Map(
  ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'].map((numeral, index) => [numeral, index + 1]),
);

const DATE_JOINERS: ReadonlySet<string> = new Set(['of', 'de', 'del', 'van', 'in', 'the', 'du', 'des']);

interface DateKeys {
  readonly full: Set<string>;
  readonly monthDay: Set<string>;
}

/**
 * Exact dates: ISO and numeric day/month/year in either order (both readings
 * kept); Chinese, Japanese and Korean year-month-day forms; a day next to a
 * month name in eight European languages or a Roman-numeral month between day
 * and year; days and years written as English number words when `words` is
 * given. A month with no day, or a bare year, is not an exact date.
 */
function dateKeys(normalized: string, words: readonly string[] | undefined): DateKeys {
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
  for (const match of normalized.matchAll(/(?:(\d{2,4})\s*[\u5E74\uB144]\s*)?(\d{1,2})\s*[\u6708\uC6D4]\s*(\d{1,2})\s*[\u65E5\uC77C]?/gu)) {
    add(match[1] ? expandYear(match[1]) : undefined, Number(match[2]), Number(match[3]));
  }
  const tokens = words ?? (normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
  const at = (index: number): string | undefined => tokens[index];
  const skipJoiners = (index: number): number => {
    let cursor = index;
    while (cursor < tokens.length && DATE_JOINERS.has(tokens[cursor]!)) cursor += 1;
    return cursor;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const word = tokens[index]!;
    const month = MONTH_NAMES.get(word);
    if (month !== undefined) {
      let back = index - 1;
      while (back >= 0 && DATE_JOINERS.has(tokens[back]!)) back -= 1;
      const before = dayNumber(at(back));
      const afterIndex = skipJoiners(index + 1);
      const after = dayNumber(at(afterIndex));
      if (before !== undefined) add(yearNumber(at(skipJoiners(index + 1))), month, before);
      if (after !== undefined) add(yearNumber(at(skipJoiners(afterIndex + 1))), month, after);
      continue;
    }
    const roman = ROMAN_MONTHS.get(word);
    if (roman !== undefined) {
      const day = dayNumber(at(index - 1));
      const year = yearNumber(at(index + 1));
      if (day !== undefined && year !== undefined) add(year, roman, day);
    }
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

function expandYear(text: string): number {
  const value = Number(text);
  if (text.length === 4) return value;
  return value < 70 ? 2000 + value : 1900 + value;
}

// --- Figures --------------------------------------------------------------------

const UNIT_WORDS: ReadonlySet<string> = new Set([
  '%', 'percent', 'mg', 'mcg', 'g', 'kg', 'lb', 'lbs', 'oz', 'ml', 'l', 'km', 'm', 'cm', 'mm', 'mi', 'ft', 'h', 'hr',
  'hrs', 'min', 'mins', 's', 'sec', 'ms', 'kb', 'mb', 'gb', 'tb', 'kwh', 'w', 'kw', 'eur', 'usd', 'gbp', 'chf', 'jpy',
  'cad', 'aud', 'euro', 'euros', 'dollars', 'pounds', 'k', 'bn', 'million', 'billion', 'mmol', 'iu', 'bpm', 'mmhg',
  'years', 'yrs', 'months', 'weeks', 'days', 'units',
  '$', '\u20AC', '\u00A3', '\u00A5', '\u20B9',
]);

/**
 * Numbers in normalized text, keyed by their digits as written with every
 * separator (. , ' _ and grouping spaces) removed, plus the same with trailing
 * zeros dropped, so "2,375.50", "237550", "2375.5" and "2.3755k" share a key.
 * Leading zeros are kept in one key and dropped in another. The value is true
 * when a unit or currency sits next to the number. Keys shorter than two
 * digits are not produced.
 */
function figureKeys(normalized: string, needUnits: boolean): Map<string, boolean> {
  const keys = new Map<string, boolean>();
  for (const match of normalized.matchAll(/([^\s\d]?)\s?(\d+(?:[.,'\u2019_ ]\d+)*)\s?(%|[\p{L}$\u20AC\u00A3\u00A5\u20B9]{1,8})?/gu)) {
    const before = match[1] ?? '';
    const written = match[2]!;
    const after = match[3] ?? '';
    const unit = needUnits && (UNIT_WORDS.has(before) || UNIT_WORDS.has(after));
    const parts = new Set<string>([written]);
    if (written.includes(' ')) for (const part of written.split(' ')) parts.add(part);
    for (const part of parts) {
      const digits = part.replace(/\D/gu, '');
      for (const key of [digits, digits.replace(/^0+(?=\d)/u, ''), digits.replace(/0+$/u, '')]) {
        if (key.length >= 2) keys.set(key, (keys.get(key) ?? false) || unit);
      }
    }
  }
  return keys;
}
