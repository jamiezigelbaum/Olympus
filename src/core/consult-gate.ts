/**
 * Consult outbound gate (docs/design/frontier-consult-lane.md, section A.4).
 *
 * A consult is a short request, written by a local writer model that has seen
 * Private evidence, which may then leave the machine. This module is the
 * mechanical check that runs on it before it is sent (automatically, or after
 * the owner's approval in strict mode). Nothing calls it on an answer path yet;
 * the doctor reports its vocabulary packs. It is a pure function over:
 *
 *   - the proposed request: an array of at most CONSULT_GATE_MAX_SUB_QUESTIONS
 *     sub-questions, exactly as they would be sent;
 *   - an immutable snapshot of every text the writer could see
 *     (`consultWriterContextFromPack` derives it from the EvidencePack by schema
 *     path, plus any text the writer saw outside the pack, such as a draft
 *     answer);
 *   - limits, which a caller may tighten but never loosen; and
 *   - optionally, recently sent consults (held in memory by the caller).
 *
 * It returns `pass` or `refuse` plus content-free reason codes.
 *
 * WHAT IT GUARANTEES, EXACTLY (design section A.4): it refuses the specified
 * copied-word patterns (runs of four content tokens shared with the snapshot,
 * and reordered copies), recognized names and identifiers from the snapshot,
 * figures from the snapshot that meet the documented thresholds, and repeats
 * of a recent consult. A name or figure it does not recognize under those
 * rules passes. It CANNOT guarantee that a question carries no Private information: synonym
 * paraphrase, rare combinations of ordinary words, a dictionary-word name in
 * lower-case prose, figures re-expressed by arithmetic and covert channels in
 * word choice pass it (see the known limits below). Passing it is NOT
 * de-identification and does not make a question anonymous, and strict-mode
 * approval does not waive the writer's rules.
 *
 * Two lines of defence. First, a vocabulary allowlist: every word in the
 * request must be in a word pack the owner has configured (ConsultGateOptions:
 * consult languages, default English, plus domain packs for units, countries
 * and medicines; see CONSULT_VOCABULARY_PACKS and docs/THIRD_PARTY_DATA.md).
 * A word outside them is refused whether or not the snapshot holds it, which
 * stops names, glued identifiers, host names and most encodings that are not
 * dictionary words. It does NOT stop names that are dictionary words: on a
 * fixed sample (eval/consult-leak/name-sample.ts) English alone admits 27 of
 * 200 given names, 41 of 200 surnames, 13 of 100 cities and 18 of 50 brands,
 * and each added language admits more. Second, snapshot rules for what an
 * allowlist cannot see: copied runs of ordinary words (ordered, as adjacent
 * unordered spans, and as rare words of one sentence in any order), names
 * written capitalized (mid-sentence, at the start of a prose sentence, as a
 * pair), label and quoted values in any case, capitalized identifier and path
 * components, simple inflections and ROT13 of recognised names and known
 * identifiers, known identifiers of any length, and figures and dates written
 * with digits or as number words in the configured languages, both sides.
 *
 * Known limits, each pinned by a test (consult-gate*.test.ts):
 *   - a name that is a dictionary word and appears in the evidence only in
 *     lower-case prose ("mason reported a breach");
 *   - dictionary entries that are also names stay in their packs: the English
 *     list's own (John, Grace, Mason, Smith), and lower-case entries of other
 *     languages (French "fenwick", a forklift; pt-BR "guilherme", "joao");
 *   - a lower-case identifier component that is a dictionary word (a folder
 *     named "tenancy") is not protected on its own;
 *   - languages with no configured pack are refused outright; German and
 *     Italian ship only as user-installed packs; scripts without spaces
 *     (Chinese, Japanese, Thai) are not supported;
 *   - compounds not listed whole (common in Dutch and German) are refused;
 *   - number words outside the seven tables (en nl fr es pt de it), Han
 *     numerals, a figure re-expressed by arithmetic, relative dates;
 *   - synonym paraphrase, and rare combinations of ordinary words;
 *   - items inside one sub-question are not counted, only bounded by
 *     CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION;
 *   - acrostics, word choice, case patterns and other covert channels;
 *   - two consults linked by subject in different words;
 *   - a name whose ROT13 or reversal is a function word (Jung and "what"):
 *     function words are left out of those comparisons. The name is fixed by
 *     the evidence, so this is a coincidence of that name, not a channel the
 *     writer can choose beyond it.
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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { EvidencePack } from './contracts.ts';
import { secretLabelsInText } from './opsec.ts';
import { SOURCE_FAMILIES, SOURCE_TRUST_DOMAINS, SOURCE_TRUST_TIERS } from './source-index/types.ts';

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

/**
 * Unordered overlap with one snapshot sentence: a request that contains at
 * least this many of one sentence's content words, in any order and across
 * sub-questions, is refused, counting only words that are rare in the
 * snapshot (at most CONSULT_GATE_RARE_WORD_OCCURRENCES occurrences), so that
 * the ordinary topical words a question shares with its evidence do not count.
 * Five rare words of one sentence is a copy reordered, not a topic.
 */
export const CONSULT_GATE_SENTENCE_OVERLAP_WORDS = 5;
export const CONSULT_GATE_RARE_WORD_OCCURRENCES = 2;
// Sentences longer than this many tokens are cut into pieces of this size.
const SENTENCE_OVERLAP_SPAN_TOKENS = 40;

// Per sub-question: one context sentence before the question.
export const CONSULT_GATE_MAX_PREAMBLE_SENTENCES = 1;

/**
 * Per sub-question, content words (tokens not on the function-word list). A
 * size cap: one plain question rarely needs more than a dozen. It bounds a
 * run-on list of asks, without pretending to count items.
 */
export const CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION = 12;

/**
 * The "Your situation, without names" level (ConsultGateOptions.level,
 * owner decision 2026-10-07; owner ruling in review, the same day: "err on
 * the side of allowing more through"). The writer may describe the user's
 * situation and repeat the durations that define it ("gave 45 days' notice
 * where the lease requires 60 days"). These rules widen for that level, and
 * only these; personal names outside the dictionaries, exact dates and
 * years, ages, exact amounts, account, phone and ID numbers, addresses,
 * mail addresses, handles, hosts and secrets are refused exactly as at the
 * general level, which is unchanged (eval/consult-leak: zero leaks at both
 * levels):
 *
 *   - size: a whole sub-question may hold
 *     CONSULT_GATE_MAX_CONTENT_WORDS_PER_UNNAMED_QUESTION content words and
 *     CONSULT_GATE_UNNAMED_MAX_PREAMBLE_SENTENCES sentences of situation
 *     before the ask, while the question sentence itself keeps the general
 *     cap, so a run-on list of asks is refused as before;
 *   - rule figures: a figure from the snapshot of at most
 *     CONSULT_GATE_UNNAMED_MAX_RULE_FIGURE_DIGITS digits may be repeated only
 *     when (a) every occurrence of that value in the snapshot, in digits or
 *     in number words, is a plain number followed by a duration (hours to
 *     months) or a full percent expression ("%", "percent", "per cent"), and
 *     (b) every occurrence in the question is written the same way. One
 *     occurrence as money, a rate ("120 per hour"), a year count, a bare
 *     number or another unit, in any form, refuses it;
 *   - copied wording: the copy rules (shared runs, content runs and spans,
 *     sentence overlap) do not compare against the local answer and its gaps
 *     (`writerAnswerTexts`), and an ordered copy of the documents or the
 *     owner's question must be CONSULT_GATE_UNNAMED_SHARED_RUN_TOKENS tokens
 *     instead of four (whole three- and four-token sentences still caught);
 *   - ordinary words: a word of the owner's language dictionaries, or a
 *     country, is not taken for a name on its own when the snapshot also
 *     writes it in lower case somewhere ("Retail Park" beside "a retail
 *     park", "Offer letter: probation"); a dictionary word the snapshot only
 *     ever capitalizes ("rue des Tanneurs", "Grace called"), a capitalized
 *     label or quoted value, and a word of a title, path, author or account
 *     value stay protected.
 *
 * Accepted residuals (owner ruling, measured in
 * eval/consult-leak/unnamed-level.ts): a name, venue or project made of
 * lower-case or dictionary words ("the red lion", "Retail Park") copied from
 * the documents or the answer can pass at this level, and so can a person's
 * name that is itself a dictionary word ("Rose", "Mason") when the snapshot
 * also uses that word in lower case ("a rose bush", "the mason"). The writer's rules still forbid both; the gate
 * does not catch them.
 */
export const CONSULT_GATE_MAX_CONTENT_WORDS_PER_UNNAMED_QUESTION = 18;
export const CONSULT_GATE_UNNAMED_MAX_RULE_FIGURE_DIGITS = 3;
export const CONSULT_GATE_UNNAMED_MAX_PREAMBLE_SENTENCES = 2;
export const CONSULT_GATE_UNNAMED_SHARED_RUN_TOKENS = 5;

/**
 * Identifiers whose compacted form is at least this long are also matched as a
 * substring of the whole compacted question (catching an identifier glued
 * inside a longer token), independently of the window ceiling below.
 */
export const CONSULT_GATE_MIN_DISTINCTIVE_IDENTIFIER_CHARS = 6;

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
  | 'too_many_sentences'
  | 'too_many_content_words'
  | 'unknown_word'
  | 'vocabulary_unavailable'
  | 'writer_context_malformed'
  | 'gate_internal_error'
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
 * `recentApprovedQuestions`: texts of consults sent recently (the name dates
 * from when every consult was approved first), held in memory by the caller
 * (the consult record is Private data, design A.7) and passed per call. The
 * gate keeps nothing between calls.
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
  // True when the pack held out-of-contract values; the gate refuses.
  readonly malformed?: boolean;
}

export interface ConsultWriterContextOptions {
  // Identifiers of the connected accounts. Every part is protected.
  readonly connectedAccountIdentifiers?: readonly string[];
  // Text the writer saw outside the pack, such as its own baseline or draft answer.
  readonly writerVisibleTexts?: readonly string[];
  // The local answer and its gaps as the writer saw them: compared exactly as
  // writerVisibleTexts (same kind and group, after them), except that the
  // unnamed level's copied-wording rules skip them (see
  // CONSULT_GATE_MAX_CONTENT_WORDS_PER_UNNAMED_QUESTION).
  readonly writerAnswerTexts?: readonly string[];
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

const SOURCE_INSTRUCTION_FLAGS: readonly string[] = [
  'ignore_previous_instructions', 'role_or_policy_override', 'credential_exfiltration_request',
  'external_communication_request', 'tool_escalation_request', 'general_source_instruction',
];

/**
 * Closed enumerations. A value outside them is an out-of-contract pack: the
 * Analyst would still render it, so the snapshot is refused as malformed
 * instead of comparing it as a harmless product word.
 */
const CLOSED_VALUES: ReadonlyMap<string, readonly string[]> = new Map([
  ['trustTier', SOURCE_TRUST_TIERS],
  ['trustDomain', SOURCE_TRUST_DOMAINS],
  ['family', SOURCE_FAMILIES],
  ['confidence', ['low', 'medium', 'high']],
  ['extractionKind', ['quoted_fact', 'paraphrase', 'inference', 'metadata']],
  ['releaseSurface', ['castor_answer', 'user_review', 'local_only']],
  ['sourceInstructionFlags', SOURCE_INSTRUCTION_FLAGS],
  ['lane', ['keyword', 'semantic']],
]);
const EXTENSIBLE_CLOSED_KEYS: ReadonlySet<string> = new Set(['trustDomain', 'family']);

// Known paths whose value must be a number or a boolean; every other known path holds a string.
const NUMBER_PATHS: ReadonlySet<string> = new Set([
  'candidates[].score', 'coverage.matchCounts[].matchedItems', 'coverage.matchCounts[].contentMatchedItems',
  'coverage.matchCounts[].inEvidence', 'chunk.chunkIndex', 'chunk.span.charStart', 'chunk.span.charEnd',
  'chunk.span.itemCharStart', 'chunk.span.itemCharEnd', 'chunk.span.chunkChars',
]);
const BOOLEAN_PATHS: ReadonlySet<string> = new Set([
  'candidates[].facts[].sensitivity.localOnly', 'candidates[].facts[].sensitivity.cloudEmbeddingEligible',
  'coverage.matchCounts[].atLeast',
]);

interface PathClass {
  readonly kind: ConsultWriterContextKind;
  // The path is part of the schema; its value's type is checked.
  readonly known: boolean;
  // The last schema key, for closed-value checks.
  readonly key: string;
  readonly relative: string;
}

function classifyPath(path: string, isNumber: boolean): PathClass {
  const key = path.slice(path.lastIndexOf('.') + 1).replace(/\[\]$/u, '');
  for (const root of PROVENANCE_ROOTS) {
    if (path === root || path.startsWith(`${root}.`)) {
      const relative = path.slice(root.length + 1);
      const kind = PROVENANCE_PATH_KINDS.get(relative);
      // Unknown provenance values, numbers included, are identifiers.
      return { kind: kind ?? 'identifier', known: kind !== undefined || isKnownProvenancePath(relative), key, relative };
    }
  }
  const kind = PACK_PATH_KINDS.get(path);
  return { kind: kind ?? (isNumber ? 'text' : 'identifier'), known: kind !== undefined || BOOLEAN_PATHS.has(path), key, relative: path };
}

function isKnownProvenancePath(relative: string): boolean {
  return /^(?:chunk\.)?sourceItem\.(?:provider|providerItemId|providerThreadId|providerConversationId|providerFileId|providerEventId|localItemId|sourceVersion)$/u.test(relative)
    || /^(?:chunk\.(?:chunkId|contentHash)|providerIds\.\*|localIds\.\*|syncRunId|syncCheckpoint|citation\.(?:title|sourceLabel|uri|authoredAt|updatedAt))$/u.test(relative);
}

// A key that could be mistaken for path syntax is quoted, so it can never match a schema path.
function pathSegment(key: string): string {
  return /^[A-Za-z0-9_]+$/u.test(key) ? key : `{${JSON.stringify(key)}}`;
}

/**
 * Derive the writer-context snapshot from an EvidencePack. Every string and
 * number leaf is collected, whatever its path, and so is every object key at a
 * path the schema does not know; the schema path decides how a value is
 * compared, and an unknown path is compared strictly. A value of the wrong type
 * at a schema path, or outside a closed enumeration, marks the snapshot
 * malformed. The result is frozen.
 */
export function consultWriterContextFromPack(
  pack: EvidencePack,
  options: ConsultWriterContextOptions = {},
): ConsultWriterContext {
  const entries: ConsultWriterContextEntry[] = [];
  const state = { bytes: 0, nodes: 0, overflow: false, malformed: false };
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
    const isLeaf = typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean';
    const shape = classifyPath(path, typeof value === 'number' || typeof value === 'bigint');
    if (shape.known) {
      const wantsNumber = NUMBER_PATHS.has(shape.relative);
      const wantsBoolean = BOOLEAN_PATHS.has(shape.relative);
      const typeOk = wantsBoolean ? typeof value === 'boolean'
        : wantsNumber ? typeof value === 'number'
          : typeof value === 'string';
      if (!typeOk) state.malformed = true;
      const closed = CLOSED_VALUES.get(shape.key);
      if (closed && shape.kind === 'vocabulary' && typeof value === 'string'
        && !closed.includes(value) && !(EXTENSIBLE_CLOSED_KEYS.has(shape.key) && /^x-[a-z0-9-]+$/u.test(value))) {
        state.malformed = true;
      }
    }
    if (isLeaf) {
      if (typeof value !== 'boolean') push(shape.kind, String(value), path, group);
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
      const isMap = MAP_KEYS.has(parentKey);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const segment = isMap ? '*' : pathSegment(key);
        const childPath = path ? `${path}.${segment}` : segment;
        // A key the schema does not name, and every map key, may reach a
        // rendered prompt (JSON.stringify of an out-of-contract value): collect
        // it strictly.
        if (isMap || !SCHEMA_FIELD_NAMES.has(key)) push('identifier', key, `${childPath}#key`, group);
        walk(child, childPath, group, depth + 1);
      }
    }
    ancestors.delete(value);
  };
  // The containers the Analyst renders must exist with their types; a pack
  // without them is not an EvidencePack and is refused as malformed.
  const shape = pack as unknown as { question?: unknown; candidates?: unknown; coverage?: Record<string, unknown> } | null;
  if (
    !shape || typeof shape !== 'object' || typeof shape.question !== 'string' || !Array.isArray(shape.candidates)
    || !shape.coverage || typeof shape.coverage !== 'object'
    || !Array.isArray(shape.coverage.searchedCorpora) || !Array.isArray(shape.coverage.skippedCorpora)
    || !Array.isArray(shape.coverage.extractionGaps)
  ) {
    state.malformed = true;
  }
  walk(pack, '', -1, 0);
  for (const text of options.writerVisibleTexts ?? []) push('text', text, 'writerVisible[]', -2);
  for (const text of options.writerAnswerTexts ?? []) push('text', text, WRITER_ANSWER_PATH, -2);
  for (const identifier of options.connectedAccountIdentifiers ?? []) {
    push('person_identifier', identifier, 'connectedAccount[]', -3);
  }
  return Object.freeze({ entries: Object.freeze(entries), overflow: state.overflow, malformed: state.malformed });
}

// Every field name in the EvidencePack schema. Any other object key is data.
const SCHEMA_FIELD_NAMES: ReadonlySet<string> = new Set([
  'question', 'candidates', 'coverage', 'builtAt', 'provenance', 'trustTier', 'trustDomain', 'chunks', 'tables',
  'facts', 'score', 'caption', 'columns', 'rows', 'factId', 'claim', 'sourceProvenance', 'sensitivity', 'localOnly',
  'cloudEmbeddingEligible', 'confidence', 'extractionKind', 'sourceInstructionFlags', 'releaseSurface', 'sourceItem',
  'chunk', 'providerIds', 'localIds', 'syncRunId', 'syncCheckpoint', 'citation', 'family', 'provider', 'accountScope',
  'providerItemId', 'providerThreadId', 'providerConversationId', 'providerFileId', 'providerEventId', 'localItemId',
  'sourceVersion', 'chunkId', 'chunkIndex', 'contentHash', 'span', 'charStart', 'charEnd', 'itemCharStart',
  'itemCharEnd', 'chunkChars', 'lane', 'title', 'sourceLabel', 'conversationLabel', 'authorLabel', 'uri',
  'authoredAt', 'updatedAt', 'searchedCorpora', 'skippedCorpora', 'corpusId', 'reason', 'extractionGaps',
  'matchCounts', 'matchedItems', 'contentMatchedItems', 'atLeast', 'inEvidence',
]);

// --- Gate ---------------------------------------------------------------------

// One sub-question; see evaluateConsultRequest.
export function evaluateConsultQuestion(
  question: string,
  context: ConsultWriterContext,
  limits: Partial<ConsultGateLimits> = {},
  history: ConsultGateHistory = {},
  options: ConsultGateOptions = {},
): ConsultGateVerdict {
  return evaluateConsultRequest([question], context, limits, history, options);
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
  options: ConsultGateOptions = {},
): ConsultGateVerdict {
  // Fail closed: an exception anywhere in evaluation is a refusal, never a throw.
  try {
    return evaluateCheckedRequest(subQuestions, context, limits, history, options);
  } catch {
    return refuse(['gate_internal_error']);
  }
}

function evaluateCheckedRequest(
  subQuestions: readonly string[],
  context: ConsultWriterContext,
  limits: Partial<ConsultGateLimits>,
  history: ConsultGateHistory,
  options: ConsultGateOptions,
): ConsultGateVerdict {
  const effective = clampLimits(limits ?? {});
  const recent: unknown = history?.recentApprovedQuestions ?? [];

  // 1. Shape and size of every input, before any comparison. The entry count
  // is bounded before the entries are walked.
  if (!context || typeof context !== 'object' || Array.isArray(context) || !Array.isArray(context.entries)) {
    return refuse(['writer_context_malformed']);
  }
  if (context.overflow === true || context.entries.length > effective.maxWriterContextEntries) return refuse(['writer_context_too_large']);
  if (!writerContextShapeValid(context)) return refuse(['writer_context_malformed']);
  if (!writerContextWithinLimits(context, effective)) return refuse(['writer_context_too_large']);
  if (context.malformed) return refuse(['writer_context_malformed']);
  const vocabulary = consultVocabulary(options ?? {});
  if (!vocabulary) return refuse(['vocabulary_unavailable']);
  if (!Array.isArray(subQuestions)) return refuse(['not_plain_text']);
  if (
    !Array.isArray(recent)
    || recent.length > CONSULT_GATE_MAX_RECENT_CONSULTS
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
  const unnamed = options?.level === 'unnamed';
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
    for (const reason of unnamed
      ? questionStructureReasons(nfkc, CONSULT_GATE_MAX_CONTENT_WORDS_PER_UNNAMED_QUESTION, CONSULT_GATE_UNNAMED_MAX_PREAMBLE_SENTENCES)
      : questionStructureReasons(nfkc, CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION)) reasons.add(reason);
    if (hasEncodedBlob(nfkc)) reasons.add('encoded_blob');
    if (secretLabelsInText(question).length > 0 || secretLabelsInText(nfkc).length > 0) reasons.add('secret_detected');
    if (hasIdentifierShape(nfkc)) reasons.add('identifier_shape');
    if (hasTechnicalFingerprint(nfkc)) reasons.add('technical_fingerprint');
    if (hasUnknownWord(nfkc, vocabulary)) {
      reasons.add('unknown_word');
      // A language the owner asked for whose pack is not installed (German,
      // Italian) makes every word of that language unknown; say so rather than
      // looking like an ordinary vocabulary refusal.
      if (requestedPackNotLoaded(options ?? {})) reasons.add('vocabulary_unavailable');
    }
    let count = 0;
    forEachToken(foldText(nfkc), () => { count += 1; });
    if (count === 0) reasons.add('question_empty');
    tokenCount += count;
  }
  if (tokenCount > effective.maxQuestionTokens) reasons.add('question_too_many_tokens');
  if (reasons.size > 0) return refuse([...reasons]);

  // 3. Comparison. The question side is small; the snapshot is streamed once.
  const model = questionModel(subQuestions);
  // Unnamed level: the owner's language dictionaries and country names (no
  // place, brand or term pack), for the name rule's ordinary-word exemption.
  const languageOnly = unnamed
    ? consultVocabulary({ languages: options?.languages ?? [], domains: { units: false, countries: true, places: false, technical: false, medicines: false, medicineBrands: false } })
    : null;
  const ordinaryWord = languageOnly ? (token: string) => languageOnly.has(token) : undefined;
  for (const reason of compareWithSnapshot(model, context, unnamed, ordinaryWord)) reasons.add(reason);
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
const WRITER_CONTEXT_KINDS: ReadonlySet<string> = new Set<ConsultWriterContextKind>([
  'user_question', 'text', 'identifier', 'person_identifier', 'account_scope', 'vocabulary', 'metadata',
]);

// The complete snapshot shape: flags are booleans, and every entry has a known kind, string text and path, and an integer group.
function writerContextShapeValid(context: ConsultWriterContext): boolean {
  if (typeof context.overflow !== 'boolean') return false;
  if (context.malformed !== undefined && typeof context.malformed !== 'boolean') return false;
  for (const entry of context.entries as readonly unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const { kind, text, path, group } = entry as Record<string, unknown>;
    if (typeof kind !== 'string' || !WRITER_CONTEXT_KINDS.has(kind)) return false;
    if (typeof text !== 'string' || typeof path !== 'string' || !Number.isSafeInteger(group)) return false;
  }
  return true;
}

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
 * declarative sentences come before it; and it holds at most
 * CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION content words. That last bound is
 * a size cap, not an item count: the gate does not infer list items from
 * punctuation. The structural limit on asks is the sub-question array.
 */
function questionStructureReasons(text: string, maxContentWords: number, maxPreambleSentences: number = CONSULT_GATE_MAX_PREAMBLE_SENTENCES): ConsultGateReason[] {
  const trimmed = text.trim();
  const reasons: ConsultGateReason[] = [];
  const marks = (trimmed.match(/[?\u061F]/gu) ?? []).length;
  if (marks !== 1 || !/[?\u061F]$/u.test(trimmed)) reasons.push('not_a_question');
  const boundaries = (trimmed.match(/[.!;](?=\s|$)|[\u3002\uFF01]/gu) ?? []).length;
  if (boundaries > maxPreambleSentences) reasons.push('too_many_sentences');
  let content = 0;
  forEachToken(foldText(trimmed), (token) => { if (isContent(token.norm)) content += 1; });
  // The question sentence (after the last sentence boundary) never carries
  // more than the general cap, whatever the whole sub-question may.
  const asked = trimmed.split(/[.!;](?=\s)|[\u3002\uFF01]/u).at(-1) ?? trimmed;
  let askedContent = 0;
  forEachToken(foldText(asked), (token) => { if (isContent(token.norm)) askedContent += 1; });
  if (content > maxContentWords || askedContent > CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION) reasons.push('too_many_content_words');
  return reasons;
}

/**
 * Encoded runs refused on sight: base64 padding; a digit between letters; a word (split at anything outside the
 * base64url alphabet) of at least CONSULT_GATE_ENCODED_MIXED_RUN_CHARS that
 * mixes letters and digits, or of at least CONSULT_GATE_ENCODED_RUN_CHARS that
 * is all hex letters or carries + / = or two inner case changes. Shorter
 * encodings are decoded and compared instead (see decodedViews).
 */
function hasEncodedBlob(text: string): boolean {
  // Base64 padding, or a digit with letters on both sides inside one word
  // ("U1ha", "NC0w"): shapes of encoded text, not of words or model numbers.
  if (/[A-Za-z0-9]=+(?![A-Za-z0-9])/u.test(text) || /\p{L}\d+\p{L}/u.test(text)) return true;
  // Three or more single letters in a row ("n a d i a", "N.A.D.I.A") spell a word out.
  if (/(?:^|[^\p{L}\p{N}])\p{L}(?:[^\p{L}\p{N}]{1,2}\p{L}){2,}(?![\p{L}\p{N}])/u.test(text)) return true;
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
 * letters or digits (a path) except a closed list of unit and word pairs
 * ("and/or", "mg/dL", "mmol/L", "km/h", ...), a
 * file:line frame, a version with three or more parts, a hex error code.
 */
function hasTechnicalFingerprint(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\blocalhost\b/u.test(lower)) return true;
  if (/[\p{L}\p{N}-]\.(?:local|internal|lan|corp|intranet|test|localhost|home\.arpa)\b/u.test(lower)) return true;
  if (/\b(?:staging|stage|dev|internal|intranet|corp)[.-][\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(lower)) return true;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/u.test(lower)) return true;
  if (/[\p{L}\p{N}]\/[\p{L}\p{N}]/u.test(lower.replace(/\b(?:and\/or|mg\/dl|mmol\/l|mg\/l|g\/l|mg\/kg|km\/h|m\/s|kb\/s|mb\/s|gb\/s|24\/7)\b/gu, ' '))) return true;
  if (/\.[a-z]{1,5}:\d+\b/u.test(lower)) return true;
  if (/\bv?\d+\.\d+\.\d+/u.test(lower)) return true;
  return /\b0x[0-9a-f]{4,}\b/u.test(lower);
}

// --- Vocabulary -------------------------------------------------------------------

/**
 * Words the bundled list lacks that a plain English question about law,
 * health, money or technology still needs: unit symbols and common standard
 * abbreviations. Short on purpose; every entry is reviewable here.
 */
const CURATED_VOCABULARY: readonly string[] = [
  // units
  'mg', 'mcg', 'kg', 'km', 'cm', 'mm', 'ml', 'dl', 'mmol', 'kwh', 'kw', 'mw', 'hz', 'khz', 'mhz', 'ghz', 'kb', 'mb',
  'gb', 'tb', 'kbps', 'mbps', 'gbps', 'ms', 'rpm', 'bpm', 'psi', 'kpa', 'mph', 'kph', 'ph',
  // standards and technology
  'iso', 'iec', 'ieee', 'rfc', 'tls', 'ssl', 'http', 'https', 'html', 'css', 'api', 'apis', 'sql', 'url', 'urls',
  'uri', 'dns', 'tcp', 'udp', 'vpn', 'ssh', 'oauth', 'json', 'xml', 'csv', 'pdf', 'cpu', 'gpu', 'ram', 'ssd', 'usb',
  'wifi', 'ipv', 'mfa', 'otp', 'sms', 'gps',
  // money, law, health
  'gdpr', 'hipaa', 'vat', 'gst', 'apr', 'apy', 'cpi', 'gdp', 'etf', 'etfs', 'ira', 'faq', 'dna', 'mri', 'ecg', 'ekg',
  'bmi', 'adhd', 'ptsd', 'hiv', 'covid', 'uk', 'eu', 'un', 'usa',
  // ordinal suffixes after a digit ("14th")
  'st', 'nd', 'rd', 'th',
];

/**
 * Vocabulary packs shipped in assets/consult/vocabulary/, generated by
 * scripts/build-consult-vocabulary.ts. Each is a gzip-compressed, sorted word
 * list; the SHA-256 of each compressed file is pinned here and checked when it
 * is loaded. Only the packs a configuration selects are loaded (see
 * ConsultGateOptions); a selected shipped pack that is missing, altered or
 * unreadable makes every request refuse (vocabulary_unavailable). Sources and
 * licences: the pack headers, the <pack>.LICENSE.txt files beside them, and
 * docs/THIRD_PARTY_DATA.md.
 */
export const CONSULT_VOCABULARY_PACKS: Readonly<Record<string, string>> = {
  'en-esdb': '9d04850bf1b3c1a70ddf4c706c9d69fd99c205de11c822bb5a5f7a8360a5b4cc',
  'nl-opentaal': 'f3868461cc6dc9b758d7d4d11fd443e9f0310f10c5c4c7626cc9c2d523fade80',
  'fr-grammalecte': 'd4aa9fb6947d382025a28ded59bdb8fcb2406dc6dc630be57fa0bc7f72e21582',
  'es-hunspell': '0950c5880f7c39e48a31ecb15571be88c738acfd14191e32a35743f9ac204510',
  'pt-br-hunspell': '69411801530ac979cfa60ae1e0463a07b4e4b6c3684d0603408dfb76d4e5f868',
  'pt-pt-hunspell': '61d7365a29d9c2f15d60dd3033b464c87b459d0b779b0979c62bb17425ebcd4c',
  'cldr-units': '19c8502b1c09353e3011b8683dede75229984b924218d0dae31f092b89dff177',
  'cldr-countries': '1e90b040de7bfa69ce6f134021b6adf3c5ac48f578b958fd676a2cb28b577e75',
  'places': 'd75e915054efdcbcbb3bbf083e4bb0210274463aa5e9704d0cbcfdd594ae0ee8',
  'olympus-terms': 'c64fd85082c07305dcb52165b3e0fa666d5bef2ce845573997e55b23718aa3c1',
  'rx-ingredients': 'edaff96cb6251b73387889d1503280a81f7e59693c6f915056bae321777baae2',
  'rx-brands': 'ea5dd90a5131aeee31e1d009b5d975bc792775361e0b9e9a1989e7b427bea2ca',
};

/**
 * Consult languages and the pack each one loads. German and Italian are
 * user-installed packs (their lists are GPL); the others ship.
 */
export const CONSULT_LANGUAGE_PACKS: Readonly<Record<ConsultLanguage, string>> = {
  en: 'en-esdb',
  nl: 'nl-opentaal',
  fr: 'fr-grammalecte',
  es: 'es-hunspell',
  'pt-PT': 'pt-pt-hunspell',
  'pt-BR': 'pt-br-hunspell',
  de: 'de-hunspell',
  it: 'it-hunspell',
};

export type ConsultLanguage = 'en' | 'nl' | 'fr' | 'es' | 'pt-PT' | 'pt-BR' | 'de' | 'it';

/**
 * Domain packs, switched separately from languages.
 *   units           CLDR unit names in seven languages. Default on: unit words
 *                   are what a bounded quantitative question needs, and the
 *                   sample admits no personal name through them.
 *   countries       CLDR country and macro-region names. Default on
 *                   (owner decision 2026-10-07, from the false-refusal
 *                   measurement): a country name narrows where the owner is or
 *                   travels, and several are given names (Jordan, Georgia,
 *                   Chad). The snapshot name rules refuse a name the
 *                   documents hold only where they recognise it as a name
 *                   (heuristic, capitalisation-based). The owner can turn it
 *                   off.
 *   places          GeoNames populated places of 15,000 or more and first-level
 *                   regions (name and ASCII name, CC BY 4.0). Default on (owner
 *                   decision 2026-10-07): cities and regions are no longer
 *                   refused as unknown words. Many place names are also given
 *                   names (Victoria, Sydney, Austin). The snapshot name rules
 *                   refuse such a word the owner's documents hold only where
 *                   they recognise it as a name, which is heuristic
 *                   (capitalisation rules); a lower-case or unusually placed
 *                   occurrence can pass. The owner can turn the pack off.
 *   technical       Olympus-authored general terms (olympus-terms): units the
 *                   CLDR pack drops (Celsius, Fahrenheit), file formats,
 *                   protocols, device and network terms, and a few stable
 *                   general proper terms (Roth, Mediterranean, Montessori,
 *                   Schengen). Default on. No person, organisation, brand or
 *                   place smaller than a country.
 *   medicines       single-word RxNorm ingredient names. Default on: generic
 *                   drug names are needed for questions about medicines and the
 *                   measured sample admits none of its names through them.
 *   medicineBrands  single-word RxNorm brand names. Default off: brand names
 *                   are proper nouns and admit some personal names.
 */
export interface ConsultDomainPacks {
  readonly units: boolean;
  readonly countries: boolean;
  readonly places: boolean;
  readonly technical: boolean;
  readonly medicines: boolean;
  readonly medicineBrands: boolean;
}

export const DEFAULT_CONSULT_DOMAIN_PACKS: ConsultDomainPacks = Object.freeze({
  units: true,
  countries: true,
  places: true,
  technical: true,
  medicines: true,
  medicineBrands: false,
});

const DOMAIN_PACK_IDS: Readonly<Record<keyof ConsultDomainPacks, string>> = {
  units: 'cldr-units',
  countries: 'cldr-countries',
  places: 'places',
  technical: 'olympus-terms',
  medicines: 'rx-ingredients',
  medicineBrands: 'rx-brands',
};

/**
 * The owner's consult settings. `languages` are the languages the writer may
 * write in (default English; setup may propose the system locale's language,
 * and the owner may add more). Only these languages' packs and the enabled
 * domain packs are admitted; every other pack stays on disk unused.
 */
/**
 * What the consult writer may send (consult-settings.ts, owner decision
 * 2026-10-07): "unnamed", the user's situation with names and other
 * identifying details removed; "general", textbook questions only.
 */
export type ConsultLevel = 'unnamed' | 'general';

export interface ConsultGateOptions {
  readonly languages?: readonly ConsultLanguage[];
  readonly domains?: Partial<ConsultDomainPacks>;
  /**
   * What the writer was allowed to send (consult-settings.ts ConsultLevel).
   * "unnamed" widens the two rules named at
   * CONSULT_GATE_MAX_CONTENT_WORDS_PER_UNNAMED_QUESTION; anything else,
   * absent included, is the general level.
   */
  readonly level?: ConsultLevel;
}

export const DEFAULT_CONSULT_LANGUAGES: readonly ConsultLanguage[] = Object.freeze(['en']);

// The shipped and user pack ids a configuration admits, in a stable order.
export function consultVocabularySelection(options: ConsultGateOptions = {}): { shipped: string[]; user: string[] } {
  const languages = [...new Set(options.languages && options.languages.length > 0 ? options.languages : DEFAULT_CONSULT_LANGUAGES)];
  const domains = { ...DEFAULT_CONSULT_DOMAIN_PACKS, ...options.domains };
  const shipped: string[] = [];
  const user: string[] = [];
  for (const language of languages) {
    const id = CONSULT_LANGUAGE_PACKS[language];
    if (!id) continue;
    (id in CONSULT_VOCABULARY_PACKS ? shipped : user).push(id);
  }
  for (const [domain, enabled] of Object.entries(domains) as Array<[keyof ConsultDomainPacks, boolean]>) {
    if (enabled && DOMAIN_PACK_IDS[domain]) shipped.push(DOMAIN_PACK_IDS[domain]);
  }
  return { shipped: shipped.sort(), user: user.sort() };
}

const VOCABULARY_DIR: readonly string[] = ['assets', 'consult', 'vocabulary'];

// Bounds on any pack, shipped or user-installed.
export const CONSULT_VOCABULARY_MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
export const CONSULT_VOCABULARY_MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
export const CONSULT_VOCABULARY_MAX_WORD_BYTES = 64;
export const CONSULT_VOCABULARY_MAX_USER_PACKS = 8;

/**
 * Optional packs a user builds locally (German and Italian, whose only lists
 * are GPL) with scripts/install-consult-language-pack.ts. They live in
 * OLYMPUS_CONSULT_VOCABULARY_DIR or ~/.olympus/consult/vocabulary, never in the
 * repository or dist/. manifest.json records each pack's SHA-256 at build
 * time; a pack whose file does not match is skipped (its words stay refused).
 */
export function consultUserVocabularyDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OLYMPUS_CONSULT_VOCABULARY_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.olympus', 'consult', 'vocabulary');
}

export interface ConsultVocabulary {
  has(word: string): boolean;
  readonly words: number;
}

export interface ConsultVocabularyPackStatus {
  readonly id: string;
  readonly origin: 'shipped' | 'user';
  readonly state: 'loaded' | 'missing' | 'hash_mismatch' | 'unreadable' | 'too_large';
  readonly words: number;
}

/**
 * One pack held as its decompressed bytes plus the start offset of each word:
 * about one byte per letter and four per word, instead of a JavaScript string
 * and a hash-set slot per word. Lookup is a binary search over the sorted list.
 */
interface SortedPack {
  readonly bytes: Buffer;
  readonly starts: Uint32Array;
}

function sortedPack(bytes: Buffer): SortedPack | undefined {
  // Two passes: count words, then fill a typed array, so no per-word
  // JavaScript value is ever allocated. Header lines start with "#". A word
  // longer than CONSULT_VOCABULARY_MAX_WORD_BYTES rejects the pack.
  let tooLong = false;
  const scan = (visit: (start: number) => void): void => {
    let lineStart = 0;
    for (let index = bytes.indexOf(0x0a); index !== -1; index = bytes.indexOf(0x0a, lineStart)) {
      if (index > lineStart && bytes[lineStart] !== 0x23) {
        if (index - lineStart > CONSULT_VOCABULARY_MAX_WORD_BYTES) tooLong = true;
        visit(lineStart);
      }
      lineStart = index + 1;
    }
    if (lineStart < bytes.length && bytes[lineStart] !== 0x23) {
      if (bytes.length - lineStart > CONSULT_VOCABULARY_MAX_WORD_BYTES) tooLong = true;
      visit(lineStart);
    }
  };
  let count = 0;
  scan(() => { count += 1; });
  if (tooLong) return undefined;
  const starts = new Uint32Array(count);
  let next = 0;
  scan((start) => { starts[next] = start; next += 1; });
  return { bytes, starts };
}

function packHas(pack: SortedPack, word: string): boolean {
  let low = 0;
  let high = pack.starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = pack.starts[middle]!;
    let order = 0;
    let offset = 0;
    for (; ; offset += 1) {
      const byte = pack.bytes[start + offset];
      const atEnd = byte === undefined || byte === 0x0a;
      if (offset === word.length) {
        order = atEnd ? 0 : 1;
        break;
      }
      if (atEnd) {
        order = -1;
        break;
      }
      const diff = byte - word.charCodeAt(offset);
      if (diff !== 0) {
        order = diff;
        break;
      }
    }
    if (order === 0) return true;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

interface LoadedVocabulary {
  readonly vocabulary: ConsultVocabulary | null;
  readonly status: readonly ConsultVocabularyPackStatus[];
}

const vocabularyCache = new Map<string, LoadedVocabulary>();
let evaluationVocabulary: ConsultVocabulary | undefined;

function selectionKey(options: ConsultGateOptions): string {
  const selection = consultVocabularySelection(options);
  return `${selection.shipped.join(',')}|${selection.user.join(',')}|${consultUserVocabularyDir()}`;
}

function consultVocabulary(options: ConsultGateOptions): ConsultVocabulary | null {
  if (evaluationVocabulary) return evaluationVocabulary;
  const key = selectionKey(options);
  let loaded = vocabularyCache.get(key);
  if (!loaded) {
    const selection = consultVocabularySelection(options);
    const shipped = Object.fromEntries(selection.shipped.map((id) => [id, CONSULT_VOCABULARY_PACKS[id]!]));
    loaded = loadConsultVocabulary(shipped, consultUserVocabularyDir(), selection.user);
    vocabularyCache.set(key, loaded);
  }
  return loaded.vocabulary;
}

// True when a user-installed pack the configuration requests is not loaded.
function requestedPackNotLoaded(options: ConsultGateOptions): boolean {
  if (evaluationVocabulary) return false;
  return (vocabularyCache.get(selectionKey(options))?.status ?? []).some((entry) => entry.origin === 'user' && entry.state !== 'loaded');
}

// Which packs a configuration loads, and their state. For status surfaces (doctor).
export function consultVocabularyStatus(options: ConsultGateOptions = {}): readonly ConsultVocabularyPackStatus[] {
  consultVocabulary(options);
  return vocabularyCache.get(selectionKey(options))?.status ?? [];
}

/**
 * Evaluation only: run the gate against a given vocabulary (to compare word
 * lists), or pass undefined to return to the packaged one. Never called by
 * product code.
 */
export function setConsultVocabularyForEvaluation(vocabulary: ConsultVocabulary | undefined): void {
  evaluationVocabulary = vocabulary;
}

// Drop the cached vocabularies so the next request reloads them (after installing a pack).
export function reloadConsultVocabulary(): void {
  vocabularyCache.clear();
}

// The compressed pack file if it exists, is within bounds and matches its pinned hash.
function verifiedPackFile(path: string, sha256: string): Buffer | Exclude<ConsultVocabularyPackStatus['state'], 'loaded'> {
  try {
    if (!existsSync(path)) return 'missing';
    if (statSync(path).size > CONSULT_VOCABULARY_MAX_COMPRESSED_BYTES) return 'too_large';
    const gz = readFileSync(path);
    return createHash('sha256').update(gz).digest('hex') === sha256 ? gz : 'hash_mismatch';
  } catch {
    return 'unreadable';
  }
}

function readPack(path: string, sha256: string): SortedPack | ConsultVocabularyPackStatus['state'] {
  try {
    const gz = verifiedPackFile(path, sha256);
    if (typeof gz === 'string') return gz;
    let bytes: Buffer;
    try {
      bytes = gunzipSync(gz, { maxOutputLength: CONSULT_VOCABULARY_MAX_EXPANDED_BYTES });
    } catch (error) {
      return error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'unreadable';
    }
    return sortedPack(bytes) ?? 'too_large';
  } catch {
    return 'unreadable';
  }
}

/**
 * The directory holding assets/consult/vocabulary, by supported layout only:
 * this module in src/core/ of a checkout resolves to the repository root, and
 * a bundle directly in dist/ of a package resolves to the package root. Any
 * other layout, or a supported one without the directory, has no root (every
 * shipped pack is then missing). Never a parent of the package, and never
 * src/assets/. The pinned hashes already stop substitution; this keeps the
 * lookup from wandering.
 */
export function consultVocabularyRoot(moduleUrl: string = import.meta.url): string | undefined {
  const here = dirname(fileURLToPath(moduleUrl));
  const root = basename(here) === 'core' && basename(dirname(here)) === 'src'
    ? dirname(dirname(here))
    : basename(here) === 'dist' ? dirname(here) : undefined;
  return root !== undefined && existsSync(join(root, ...VOCABULARY_DIR)) ? root : undefined;
}

export interface ConsultVocabularyFileStatus {
  readonly id: string;
  readonly origin: 'shipped' | 'user';
  readonly state: 'verified' | Exclude<ConsultVocabularyPackStatus['state'], 'loaded'>;
}

/**
 * For status surfaces (doctor): whether each pack a configuration selects is
 * present and matches its pinned hash (shipped) or its local manifest hash
 * (user-installed). It hashes the compressed files only: nothing is
 * decompressed, cached or admitted, so it retains no decompressed vocabulary
 * and changes no verdict. Content-free: pack ids and states only.
 */
export function consultVocabularyFileStatus(
  options: ConsultGateOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): readonly ConsultVocabularyFileStatus[] {
  const selection = consultVocabularySelection(options);
  const root = consultVocabularyRoot();
  const status: ConsultVocabularyFileStatus[] = selection.shipped.map((id) => {
    const result = root ? verifiedPackFile(join(root, ...VOCABULARY_DIR, `${id}.txt.gz`), CONSULT_VOCABULARY_PACKS[id]!) : 'missing';
    return { id, origin: 'shipped', state: typeof result === 'string' ? result : 'verified' };
  });
  if (selection.user.length > 0) {
    const userDir = consultUserVocabularyDir(env);
    const manifest = new Map(userManifestEntries(userDir));
    for (const id of selection.user) {
      const sha256 = manifest.get(id);
      const result = !manifest.has(id) ? 'missing' : sha256 === undefined ? 'hash_mismatch' : verifiedPackFile(join(userDir, `${id}.txt.gz`), sha256);
      status.push({ id, origin: 'user', state: typeof result === 'string' ? result : 'verified' });
    }
  }
  return status;
}

/**
 * Load the given shipped packs (every one must verify, or the result is null)
 * and the given user-installed packs from `userDir` (each verified against the
 * local manifest; a failure skips only that pack). Never throws.
 */
export function loadConsultVocabulary(
  packs: Readonly<Record<string, string>> = CONSULT_VOCABULARY_PACKS,
  userDir: string | null = null,
  userPacks: readonly string[] | 'all' = 'all',
): LoadedVocabulary {
  const root = consultVocabularyRoot();
  const loaded: SortedPack[] = [];
  const status: ConsultVocabularyPackStatus[] = [];
  let complete = root !== undefined;
  for (const [id, sha256] of Object.entries(packs)) {
    const result = root ? readPack(join(root, ...VOCABULARY_DIR, `${id}.txt.gz`), sha256) : 'missing';
    if (typeof result === 'string') {
      status.push({ id, origin: 'shipped', state: result, words: 0 });
      complete = false;
      continue;
    }
    loaded.push(result);
    status.push({ id, origin: 'shipped', state: 'loaded', words: result.starts.length });
  }
  for (const [id, sha256] of userManifestEntries(userDir)) {
    if (id in CONSULT_VOCABULARY_PACKS || (userPacks !== 'all' && !userPacks.includes(id))) continue;
    if (status.filter((entry) => entry.origin === 'user').length >= CONSULT_VOCABULARY_MAX_USER_PACKS) break;
    const result = sha256 === undefined ? 'hash_mismatch' : readPack(join(userDir!, `${id}.txt.gz`), sha256);
    if (typeof result === 'string') {
      status.push({ id, origin: 'user', state: result, words: 0 });
      continue;
    }
    loaded.push(result);
    status.push({ id, origin: 'user', state: 'loaded', words: result.starts.length });
  }
  if (userPacks !== 'all') {
    for (const id of userPacks) {
      if (!status.some((entry) => entry.id === id)) status.push({ id, origin: 'user', state: 'missing', words: 0 });
    }
  }
  if (!complete) return { vocabulary: null, status };
  const curated = new Set(CURATED_VOCABULARY);
  const words = curated.size + loaded.reduce((total, pack) => total + pack.starts.length, 0);
  return {
    vocabulary: { has: (word) => curated.has(word) || loaded.some((pack) => packHas(pack, word)), words },
    status,
  };
}

// The manifest's well-formed entries: [id, sha256 or undefined]. Malformed manifests yield none.
function userManifestEntries(userDir: string | null): Array<[string, string | undefined]> {
  if (!userDir) return [];
  try {
    const path = join(userDir, 'manifest.json');
    if (!existsSync(path) || statSync(path).size > 1024 * 1024) return [];
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
    const packs = (manifest as { packs?: unknown }).packs;
    if (!packs || typeof packs !== 'object' || Array.isArray(packs)) return [];
    return Object.entries(packs as Record<string, unknown>)
      .filter(([id]) => /^[a-z0-9-]{1,40}$/u.test(id))
      .map(([id, entry]) => {
        const sha256 = entry && typeof entry === 'object' ? (entry as { sha256?: unknown }).sha256 : undefined;
        return [id, typeof sha256 === 'string' && /^[0-9a-f]{64}$/u.test(sha256) ? sha256 : undefined];
      });
  } catch {
    return [];
  }
}

// Letters the packs spell out: ligatures and special letters folded the same way as the generator.
const VOCABULARY_LETTER_FOLDS: Readonly<Record<string, string>> = {
  '\u0153': 'oe', '\u00E6': 'ae', '\u00F8': 'o', '\u0142': 'l', '\u0111': 'd', '\u00F0': 'd', '\u00FE': 'th', '\u00DF': 'ss', '\u0131': 'i',
};

/**
 * Every run of letters in the question must be a word of the configured
 * vocabulary: a loaded pack, the curated list, or a single letter. Accents are
 * removed first ("cafe"), special letters folded ("oe" for the ligature), case
 * is ignored, and a token mixing letters and digits is split into its letter
 * runs ("OAuth2" is "oauth"). Anything else is refused, whether or not the
 * snapshot holds it. This refuses words outside the vocabulary; it says
 * nothing about dictionary words that are also names.
 */
function hasUnknownWord(text: string, vocabulary: ConsultVocabulary): boolean {
  let unknown = false;
  forEachToken(foldText(text), (token) => {
    if (unknown) return;
    const folded = mapCharacters(token.norm, VOCABULARY_LETTER_FOLDS);
    for (const run of folded.split(/[0-9]+/u)) {
      if (run.length === 0) continue;
      if (!/^[a-z]+$/u.test(run) || (run.length > 1 && !vocabulary.has(run))) {
        unknown = true;
        return;
      }
    }
  });
  return unknown;
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
  // letters the vocabulary packs spell out, so "Hølt" and "Holt" compare equal
  '\u00F8': 'o', '\u0142': 'l', '\u0111': 'd', '\u00F0': 'd', '\u00FE': 'th', '\u00E6': 'ae', '\u0153': 'oe',
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
  // Written as a label value: right after a colon, or opened by a quote
  // (double or single) that follows a space.
  readonly labelled: boolean;
}

function forEachToken(folded: string, visit: (token: Token) => void): void {
  const pattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])[\p{L}\p{N}])+/gu;
  let previousEnd = -1;
  for (const match of folded.matchAll(pattern)) {
    const raw = match[0];
    const start = match.index ?? 0;
    // The common gap is one space: answer it without running the gap regexes.
    const simpleGap = start - previousEnd === 1 && folded.charCodeAt(previousEnd) === 0x20;
    const gap = previousEnd < 0 || simpleGap ? '' : folded.slice(previousEnd, start);
    const firstCode = raw.charCodeAt(0);
    const lower = raw.toLowerCase();
    visit({
      norm: lower === raw && firstCode < 0x80 ? raw : caseFold(raw),
      capitalized: firstCode < 0x80 ? firstCode >= 0x41 && firstCode <= 0x5a : /^[\p{Lu}\p{Lt}]/u.test(raw),
      initial: previousEnd < 0 || (!simpleGap && /[.!?;:]/u.test(gap)),
      joined: simpleGap || (previousEnd >= 0 && /^[\s'\u2019-]*$/u.test(gap)),
      labelled: !simpleGap && previousEnd >= 0 && (/:\s*["'\u201C\u2018\u00AB]?$/u.test(gap) || /(?:^|\s)["'\u201C\u2018\u00AB]$/u.test(gap)),
    });
    previousEnd = start + raw.length;
  }
}

// Closed function-word lists (English, Dutch, French, Spanish, Portuguese,
// German, Italian): content counting only, for shared runs and the
// content-word cap. A word here counts as carrying no content; a few are also
// English content words ("die", "come"), which only makes run detection
// slightly less eager on them.
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'into', 'over', 'under', 'about',
  'and', 'or', 'but', 'nor', 'if', 'then', 'than', 'so', 'as', 'not', 'no',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'has', 'have', 'had',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'what', 'which', 'who', 'whom', 'whose', 'how', 'when', 'where', 'why',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'our', 'their',
  // nl
  'de', 'het', 'een', 'en', 'of', 'van', 'te', 'op', 'aan', 'met', 'voor', 'naar', 'bij', 'uit', 'om', 'over', 'dat',
  'die', 'dit', 'deze', 'wat', 'wie', 'hoe', 'waar', 'wanneer', 'is', 'zijn', 'was', 'wordt', 'worden', 'heeft', 'hebben',
  'kan', 'moet', 'mag', 'niet', 'geen', 'er', 'hij', 'zij', 'ze', 'wij', 'we', 'jij', 'u', 'mijn', 'uw', 'hun',
  // fr
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'd', 'au', 'aux', 'et', 'ou', 'mais', 'que', 'qu', 'qui', 'quoi',
  'quel', 'quelle', 'quels', 'quelles', 'dans', 'sur', 'sous', 'par', 'pour', 'avec', 'sans', 'entre', 'ce', 'cet',
  'cette', 'ces', 'son', 'sa', 'ses', 'leur', 'leurs', 'il', 'elle', 'ils', 'elles', 'on', 'se', 's', 'ne', 'pas',
  'est', 'sont', 'a', 'ont', 'etre', 'avoir', 'peut', 'doit', 'comment', 'quand', 'combien', 'y', 'en', 't', 'c',
  // es
  'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al', 'y', 'o', 'pero', 'que', 'cual', 'cuales', 'quien',
  'en', 'por', 'para', 'con', 'sin', 'entre', 'sobre', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'su', 'sus',
  'se', 'lo', 'le', 'les', 'es', 'son', 'ser', 'esta', 'hay', 'puede', 'debe', 'como', 'cuando', 'cuanto', 'donde',
  'no', 'mas',
  // pt
  'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'ao', 'aos',
  'e', 'ou', 'mas', 'que', 'qual', 'quais', 'quem', 'em', 'por', 'para', 'com', 'sem', 'entre', 'sobre', 'este',
  'esta', 'esse', 'essa', 'seu', 'sua', 'seus', 'suas', 'se', 'ele', 'ela', 'eles', 'elas', 'e', 'sao', 'ser',
  'tem', 'pode', 'deve', 'como', 'quando', 'quanto', 'onde', 'nao', 'mais', 'um',
  // de
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'und', 'oder', 'aber',
  'dass', 'wer', 'was', 'welche', 'welcher', 'welches', 'wie', 'wo', 'wann', 'in', 'im', 'an', 'am', 'auf', 'aus',
  'bei', 'mit', 'nach', 'von', 'vom', 'zu', 'zum', 'zur', 'fur', 'uber', 'unter', 'zwischen', 'ist', 'sind', 'war',
  'wird', 'werden', 'hat', 'haben', 'kann', 'muss', 'soll', 'nicht', 'kein', 'keine', 'sich', 'es', 'er', 'sie', 'wir',
  'ihr', 'ihre', 'sein', 'seine',
  // it
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'della', 'dei', 'delle', 'a', 'al', 'alla',
  'da', 'dal', 'in', 'nel', 'nella', 'con', 'su', 'per', 'tra', 'fra', 'e', 'o', 'ma', 'che', 'chi', 'quale', 'quali',
  'come', 'quando', 'quanto', 'dove', 'non', 'si', 'ci', 'suo', 'sua', 'loro', 'questo', 'questa', 'e', 'sono',
  'essere', 'ha', 'hanno', 'puo', 'deve',
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
  // Unnamed level: figures every occurrence of which, in every view and in
  // digits or words, is a plain number followed by a duration or percent word.
  readonly ruleOnlyKeys: ReadonlySet<string>;
  readonly digitConcat: string;
  readonly dates: DateKeys;
  readonly hostKeys: ReadonlySet<string>;
  // The whole request compacted (first), then each decoded view compacted.
  readonly compactViews: readonly string[];
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
        let onlyFunctionWords = true;
        for (let end = start; end < variant.length && end - start < CONSULT_GATE_COMPACT_WINDOW_TOKENS; end += 1) {
          concat += variant[end];
          onlyFunctionWords &&= FUNCTION_WORDS.has(viewTokens[end] ?? '');
          if (concat.length > CONSULT_GATE_COMPACT_WINDOW_CHARS) break;
          if (!forms.has(concat)) forms.set(concat, source);
          // A window of function words only is never compared reversed: "tahw"
          // reversed is "what", and every question has words like it.
          if (onlyFunctionWords) continue;
          const reversed = [...concat].reverse().join('');
          if (!forms.has(reversed)) forms.set(reversed, source);
        }
      }
    }
  };
  // Simple inflections of each question word (plural, possessive) are also
  // compared against recognised names and identifiers: "masons" is "mason".
  const uninflected = tokens.map((token) => (token.length >= 5 && token.endsWith('es') ? token.slice(0, -2) : token.length >= 4 && token.endsWith('s') ? token.slice(0, -1) : token));
  addView(tokens, 'plain');
  addView(uninflected, 'plain');
  // ROT13 of every question word, compared like a decoding: a known
  // identifier whose ROT13 happens to be a dictionary word is still caught.
  // Function words are left out of the ROT13 view: "what" is the ROT13 of
  // "Jung", and refusing every question with "what" for an owner with such a
  // contact would make the lane unusable (see the stated limits).
  addView(tokens.map((token) => (FUNCTION_WORDS.has(token) ? String.fromCharCode(2) : rot13(token))), 'decoded');
  const compactViews = [tokens.join('')];
  const decoded = decodedViews(joined.normalize('NFKC'));
  for (const view of decoded) {
    const viewTokens: string[] = [];
    forEachToken(foldText(view), (token) => viewTokens.push(token.norm));
    addView(viewTokens, 'decoded');
    compactViews.push(viewTokens.join(''));
  }
  // Figures and dates are read from the request and from every decoding.
  const numberKeys = new Set<string>();
  const ruleSeen = new Map<string, FigureSeen>();
  const dates: DateKeys = { full: new Set(), monthDay: new Set() };
  let digitConcat = '';
  for (const text of [joined, ...decoded]) {
    const viewFolded = foldText(text);
    const normalized = caseFold(viewFolded);
    const wordDigits = numberWordsToDigits(wordsOf(viewFolded));
    for (const key of figureKeys(normalized, false).keys()) numberKeys.add(key);
    for (const key of figureKeys(wordDigits.join(' '), false).keys()) numberKeys.add(key);
    for (const form of [figureKeys(normalized, true), figureKeys(wordDigits.join(' '), true)]) {
      for (const [key, seen] of form) ruleSeen.set(key, mergeFigureSeen(ruleSeen.get(key), seen));
    }
    digitConcat += (normalized.match(/\d/gu) ?? []).join('');
    const viewDates = dateKeys(normalized, wordDigits);
    for (const key of viewDates.full) dates.full.add(key);
    for (const key of viewDates.monthDay) dates.monthDay.add(key);
  }
  const normalized = caseFold(folded);
  const hostKeys = new Set<string>();
  const spelled = normalized.replace(/\s+dot\s+/gu, '.').replace(/[\u3002\uFF0E\uFF61]/gu, '.');
  for (const host of hostnames(spelled)) for (const key of hostKeysOf(host)) hostKeys.add(key);
  const ruleOnlyKeys = new Set([...numberKeys].filter((key) => {
    const seen = ruleSeen.get(key);
    return seen !== undefined && seen.rule && !seen.bare && !seen.other;
  }));
  return { tokens, forms, tokenKeys, numberKeys, ruleOnlyKeys, digitConcat, dates, hostKeys, compactViews };
}

/**
 * Bounded decodings of the request: hex runs of two or more byte pairs, with or
 * without single separators or 0x prefixes ("4d6961", "4e 61 64", "0x49 0x76").
 * Most other encodings (base64, base32, base58, rot13) are already refused by
 * the vocabulary rule, because their tokens are not English words; hex
 * survives it because its letter runs are single letters. A decoding is kept
 * when it is valid UTF-8 without control characters.
 */
function rot13(word: string): string {
  let out = '';
  for (const char of word) {
    const code = char.charCodeAt(0);
    out += code >= 0x61 && code <= 0x7a ? String.fromCharCode(((code - 0x61 + 13) % 26) + 0x61) : char;
  }
  return out;
}

function decodedViews(text: string): string[] {
  const views: string[] = [];
  const keep = (bytes: Buffer): void => {
    const decoded = bytes.toString('utf8');
    if (decoded.length < 2 || decoded.includes('\uFFFD')) return;
    if (/\p{Cc}/u.test(decoded)) return;
    views.push(decoded);
  };
  text = text.replace(/\b0x([0-9a-f]{2})\b/giu, '$1');
  for (const match of text.matchAll(/(?:[0-9a-f]{2}[\s:,.-]?){2,}/giu)) {
    const hex = match[0].replace(/[^0-9a-f]/giu, '');
    if (hex.length % 2 === 0) keep(Buffer.from(hex, 'hex'));
  }
  return views;
}

// --- Number words (English, Dutch, French, Spanish, Portuguese, German, Italian) ----

/**
 * Cardinal and ordinal number words, accents removed (the tokens they are
 * compared with are folded the same way). Ambiguous short words that are
 * also ordinary words ("due", "sei", "tre", "un", "en") only take effect next
 * to another number word, because a run needs a value to start and a lone
 * value below 10 produces no key the figure rules use.
 */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  // en
  ['zero', 0], ['oh', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7],
  ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19], ['twenty', 20],
  ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60], ['seventy', 70], ['eighty', 80], ['ninety', 90],
  ['first', 1], ['second', 2], ['third', 3], ['fourth', 4], ['fifth', 5], ['sixth', 6], ['seventh', 7], ['eighth', 8],
  ['ninth', 9], ['tenth', 10], ['eleventh', 11], ['twelfth', 12], ['thirteenth', 13], ['fourteenth', 14],
  ['fifteenth', 15], ['sixteenth', 16], ['seventeenth', 17], ['eighteenth', 18], ['nineteenth', 19],
  ['twentieth', 20], ['thirtieth', 30],
  // fr
  ['un', 1], ['une', 1], ['deux', 2], ['trois', 3], ['quatre', 4], ['cinq', 5], ['sept', 7], ['huit', 8], ['neuf', 9],
  ['dix', 10], ['onze', 11], ['douze', 12], ['treize', 13], ['quatorze', 14], ['quinze', 15], ['seize', 16],
  ['vingt', 20], ['vingts', 20], ['trente', 30], ['quarante', 40], ['cinquante', 50], ['soixante', 60], ['premier', 1],
  // es
  ['uno', 1], ['una', 1], ['dos', 2], ['tres', 3], ['cuatro', 4], ['cinco', 5], ['seis', 6], ['siete', 7], ['ocho', 8],
  ['nueve', 9], ['diez', 10], ['once', 11], ['doce', 12], ['trece', 13], ['catorce', 14], ['quince', 15],
  ['dieciseis', 16], ['diecisiete', 17], ['dieciocho', 18], ['diecinueve', 19], ['veinte', 20], ['veintiuno', 21],
  ['veintidos', 22], ['veintitres', 23], ['veinticuatro', 24], ['veinticinco', 25], ['veintiseis', 26],
  ['veintisiete', 27], ['veintiocho', 28], ['veintinueve', 29], ['treinta', 30], ['cuarenta', 40], ['cincuenta', 50],
  ['sesenta', 60], ['setenta', 70], ['ochenta', 80], ['noventa', 90], ['doscientos', 200], ['trescientos', 300],
  ['cuatrocientos', 400], ['quinientos', 500], ['seiscientos', 600], ['setecientos', 700], ['ochocientos', 800],
  ['novecientos', 900], ['primero', 1],
  // pt
  ['um', 1], ['dois', 2], ['duas', 2], ['quatro', 4], ['sete', 7], ['oito', 8], ['nove', 9], ['dez', 10],
  ['catorze', 14], ['dezesseis', 16], ['dezasseis', 16], ['dezessete', 17], ['dezassete', 17], ['dezoito', 18],
  ['dezenove', 19], ['dezanove', 19], ['vinte', 20], ['trinta', 30], ['quarenta', 40], ['cinquenta', 50],
  ['sessenta', 60], ['oitenta', 80], ['duzentos', 200], ['trezentos', 300], ['quatrocentos', 400],
  ['quinhentos', 500], ['oitocentos', 800], ['primeiro', 1],
  // nl
  ['een', 1], ['twee', 2], ['drie', 3], ['vier', 4], ['vijf', 5], ['zes', 6], ['zeven', 7], ['acht', 8], ['negen', 9],
  ['tien', 10], ['elf', 11], ['twaalf', 12], ['dertien', 13], ['veertien', 14], ['vijftien', 15], ['zestien', 16],
  ['zeventien', 17], ['achttien', 18], ['negentien', 19], ['twintig', 20], ['dertig', 30], ['veertig', 40],
  ['vijftig', 50], ['zestig', 60], ['zeventig', 70], ['tachtig', 80], ['negentig', 90],
  // de
  ['eins', 1], ['ein', 1], ['eine', 1], ['zwei', 2], ['drei', 3], ['funf', 5], ['sechs', 6], ['sieben', 7], ['neun', 9],
  ['zehn', 10], ['zwolf', 12], ['dreizehn', 13], ['vierzehn', 14], ['funfzehn', 15], ['sechzehn', 16], ['siebzehn', 17],
  ['achtzehn', 18], ['neunzehn', 19], ['zwanzig', 20], ['dreissig', 30], ['vierzig', 40], ['funfzig', 50],
  ['sechzig', 60], ['siebzig', 70], ['achtzig', 80], ['neunzig', 90], ['erste', 1], ['ersten', 1],
  // it
  ['due', 2], ['tre', 3], ['quattro', 4], ['cinque', 5], ['sei', 6], ['sette', 7], ['otto', 8], ['dieci', 10],
  ['undici', 11], ['dodici', 12], ['tredici', 13], ['quattordici', 14], ['quindici', 15], ['sedici', 16],
  ['diciassette', 17], ['diciotto', 18], ['diciannove', 19], ['venti', 20], ['vent', 20], ['trenta', 30], ['trent', 30],
  ['quaranta', 40], ['quarant', 40], ['cinquanta', 50], ['cinquant', 50], ['sessanta', 60], ['sessant', 60],
  ['settanta', 70], ['settant', 70], ['ottanta', 80], ['ottant', 80], ['novanta', 90], ['novant', 90], ['primo', 1],
]);

const SCALE_WORDS: ReadonlyMap<string, number> = new Map([
  ['hundred', 100], ['thousand', 1_000], ['million', 1_000_000], ['billion', 1_000_000_000],
  ['cent', 100], ['cents', 100], ['mille', 1_000], ['millions', 1_000_000], ['milliard', 1_000_000_000],
  ['cien', 100], ['ciento', 100], ['mil', 1_000], ['millon', 1_000_000], ['millones', 1_000_000],
  ['cem', 100], ['cento', 100], ['milhao', 1_000_000], ['milhoes', 1_000_000],
  ['honderd', 100], ['duizend', 1_000], ['miljoen', 1_000_000],
  ['hundert', 100], ['tausend', 1_000], ['millionen', 1_000_000],
  ['mila', 1_000], ['milione', 1_000_000], ['milioni', 1_000_000],
]);

// Words that join parts of one number ("three hundred and five", "treinta y dos", "vinte e quatro").
const NUMBER_CONNECTORS: ReadonlySet<string> = new Set(['and', 'et', 'y', 'e', 'en', 'und']);

// Words that, before a scale word, mean one ("a hundred", "un millon").
const SCALE_ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'one', 'un', 'une', 'uno', 'una', 'um', 'uma', 'een', 'ein', 'eine']);

// Point words for decimals.
const DECIMAL_WORDS: ReadonlySet<string> = new Set(['point', 'virgule', 'coma', 'virgula', 'komma']);

const NUMBER_PARTS: readonly string[] = [...NUMBER_WORDS.keys(), ...SCALE_WORDS.keys(), 'en', 'und', 'e'].sort((a, b) => b.length - a.length);

/**
 * A token written as several number words glued together (Dutch
 * "vierentwintig", German "zweiundsechzig", Italian "ottocentosessantadue"):
 * its parts, or undefined. Longest-match first, backtracking, bounded by the
 * token length.
 */
function gluedNumberParts(token: string): string[] | undefined {
  if (token.length < 6 || token.length > 40 || NUMBER_WORDS.has(token) || SCALE_WORDS.has(token)) return undefined;
  const memo = new Map<number, string[] | null>();
  const solve = (at: number): string[] | null => {
    if (at === token.length) return [];
    const known = memo.get(at);
    if (known !== undefined) return known;
    let found: string[] | null = null;
    for (const part of NUMBER_PARTS) {
      if (!token.startsWith(part, at)) continue;
      const rest = solve(at + part.length);
      if (rest) {
        found = [part, ...rest];
        break;
      }
    }
    memo.set(at, found);
    return found;
  };
  const parts = solve(0);
  return parts && parts.length >= 2 && parts.some((part) => NUMBER_WORDS.has(part) || SCALE_WORDS.has(part)) ? parts : undefined;
}

/**
 * Replace each run of number words with digit tokens: its arithmetic value
 * ("two thousand three hundred seventy five point five zero" is 2375.50,
 * "huit cent soixante-deux" is 862, "a hundred" is 100), and, when the run has
 * no scale word, the digits of its groups written one after another ("twenty
 * twenty four" is 2024). Glued number words are split first. French
 * "quatre-vingt" multiplies.
 */
function numberWordsToDigits(input: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const token of input) {
    const glued = gluedNumberParts(token);
    if (glued) tokens.push(...glued);
    else tokens.push(token);
  }
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const start = index;
    let total = 0;
    let current = 0;
    let scaled = false;
    let decimal = '';
    let inDecimal = false;
    let previousValue: number | undefined;
    const groups: number[] = [];
    while (index < tokens.length) {
      const word = tokens[index]!;
      const value = NUMBER_WORDS.get(word);
      const scale = SCALE_WORDS.get(word);
      const startsScale = index === start && SCALE_ARTICLES.has(word) && SCALE_WORDS.has(tokens[index + 1] ?? '');
      if (startsScale) {
        current = 0;
      } else if (inDecimal && value !== undefined && value < 10) {
        decimal += String(value);
      } else if (DECIMAL_WORDS.has(word) && index > start && !inDecimal) {
        inDecimal = true;
      } else if (value !== undefined && !inDecimal) {
        if (value === 20 && previousValue === 4 && (word === 'vingt' || word === 'vingts')) {
          // quatre-vingt(s): 4 x 20
          current += 76;
          groups[groups.length - 1] = 80;
        } else {
          const last = groups.length > 0 ? groups[groups.length - 1]! : undefined;
          if (last !== undefined && last % 10 === 0 && last >= 20 && last < 100 && value < 10) {
            groups[groups.length - 1] = last + value;
          } else {
            groups.push(value);
          }
          current += value;
        }
        previousValue = value;
      } else if (scale !== undefined && !inDecimal && (index > start || tokens.length > 0)) {
        scaled = true;
        if (scale === 100) current = (current || 1) * 100;
        else {
          total += (current || 1) * scale;
          current = 0;
        }
        previousValue = undefined;
      } else if (NUMBER_CONNECTORS.has(word) && index > start && !inDecimal
        && (NUMBER_WORDS.has(tokens[index + 1] ?? '') || SCALE_WORDS.has(tokens[index + 1] ?? ''))) {
        // "three hundred and five", "treinta y dos", "vinte e quatro"
      } else break;
      index += 1;
    }
    if (index === start) {
      out.push(tokens[index]!);
      index += 1;
      continue;
    }
    const integer = String(total + current);
    // Groups written one after another first ("twenty twenty four" is 2024),
    // so a year in a date reads as a year; the arithmetic value follows.
    if (!scaled && groups.length > 1) out.push(groups.map(String).join(''));
    out.push(decimal ? `${integer}.${decimal}` : integer);
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
  // Double-buffered run lengths per question position; only the positions
  // touched by the previous token are cleared, so no allocation per token.
  let previousLength = new Int32Array(question.length);
  let previousContent = new Int32Array(question.length);
  let currentLength = new Int32Array(question.length);
  let currentContent = new Int32Array(question.length);
  let previousActive: readonly number[] = [];
  const clear = (): void => {
    for (const position of previousActive) {
      previousLength[position] = 0;
      previousContent[position] = 0;
    }
  };
  return {
    feed(token: string): boolean {
      const active = positions.get(token) ?? [];
      const content = isContent(token) ? 1 : 0;
      let hit = false;
      for (const position of active) {
        const length = (position > 0 ? previousLength[position - 1]! : 0) + 1;
        const contentCount = (position > 0 ? previousContent[position - 1]! : 0) + content;
        currentLength[position] = length;
        currentContent[position] = contentCount;
        if (length >= minLength && contentCount >= minContent) hit = true;
      }
      clear();
      [previousLength, currentLength] = [currentLength, previousLength];
      [previousContent, currentContent] = [currentContent, previousContent];
      previousActive = active;
      return hit;
    },
    reset(): void {
      clear();
      previousActive = [];
    },
  };
}

interface NameStats {
  capitalized: number;
  // Lower-case occurrences in the snapshot, not counting the owner's question.
  lower: number;
  // Lower-case occurrences in prose or in the owner's question: evidence that
  // the word is ordinary, used for identifier components.
  lowerAnywhere: number;
}

// Paths whose text is running prose (sentence-initial capitals mean something there).
const WRITER_ANSWER_PATH = 'writerAnswer[]';
const PROSE_PATHS: ReadonlySet<string> = new Set(['candidates[].chunks[]', 'candidates[].facts[].claim', 'writerVisible[]', WRITER_ANSWER_PATH]);

// Separator for joined token keys (the same character the question model uses).
const SEP = String.fromCharCode(1);

/**
 * `unnamed`: the unnamed level's figure and copied-wording exemptions (see
 * CONSULT_GATE_MAX_CONTENT_WORDS_PER_UNNAMED_QUESTION); false is the general
 * level, unchanged.
 */
function compareWithSnapshot(
  model: QuestionModel,
  context: ConsultWriterContext,
  unnamed: boolean,
  ordinaryWord?: (token: string) => boolean,
): Set<ConsultGateReason> {
  const reasons = new Set<ConsultGateReason>();
  const runTokens = unnamed ? CONSULT_GATE_UNNAMED_SHARED_RUN_TOKENS : CONSULT_GATE_SHARED_RUN_TOKENS;
  const fullRun = runMatcher(model.tokens, runTokens, CONSULT_GATE_RUN_MIN_CONTENT_TOKENS);
  const contentTokens = model.tokens.filter(isContent);
  const contentRun = runMatcher(contentTokens, CONSULT_GATE_CONTENT_RUN_TOKENS, 0);
  const contentSpan = spanMatcher(contentTokens, CONSULT_GATE_CONTENT_RUN_TOKENS);
  const longestCompact = Math.max(...model.compactViews.map((view) => view.length));
  const formHit = (form: string): FormSource | undefined =>
    form.length >= CONSULT_GATE_MIN_IDENTIFIER_CHARS ? model.forms.get(form) : undefined;
  const identifierHit = (source: FormSource | undefined): void => {
    if (source) reasons.add(source === 'decoded' ? 'encoded_identifier' : 'snapshot_identifier');
  };
  const stats = new Map<string, NameStats>();
  const pairCandidates = new Map<string, { left: string; right: string; midSentence: boolean }>();
  // Unordered sentence overlap (CONSULT_GATE_SENTENCE_OVERLAP_WORDS).
  const questionContent = new Set(contentTokens);
  const contentCounts = new Map<string, number>();
  const overlapCandidates: string[][] = [];
  let sentenceContent = new Set<string>();
  let sentenceTokens = 0;
  const closeOverlap = (): void => {
    if (sentenceContent.size >= CONSULT_GATE_SENTENCE_OVERLAP_WORDS) overlapCandidates.push([...sentenceContent]);
    sentenceContent = new Set();
    sentenceTokens = 0;
  };
  const singleCandidates = new Map<string, { source: FormSource; labelled: boolean; initialOnly: boolean; strongLabel: boolean }>();
  const componentCandidates = new Map<string, FormSource>();
  // Unnamed level: every snapshot occurrence of a question figure the general
  // rule would refuse, decided once the whole snapshot is read.
  const figureSeen = new Map<string, FigureSeen>();
  // Every word of an identifier, provenance, author or account value (titles, paths, labels).
  const identifierTokens = new Set<string>();
  const figureRefused = new Set<string>();
  let group = Number.NaN;
  let previous: Token | undefined;

  for (const entry of context.entries) {
    // Stop at the first entry that establishes a refusal: one reason refuses,
    // and the rest of a large snapshot need not be read.
    if (reasons.size > 0) break;
    if (entry.kind === 'metadata') continue;
    if (entry.group !== group) {
      group = entry.group;
      fullRun.reset();
      contentRun.reset();
      contentSpan.reset();
      previous = undefined;
    }
    const folded = foldText(entry.text);
    const normalized = caseFold(folded);

    // Values: figures, digits read jointly, dates, hosts, labelled secrets.
    // Number words and date words are read here exactly as on the question side.
    const words = hasNumberWord(normalized) ? numberWordsToDigits(wordsOf(folded)) : undefined;
    const snapshotFigures = figureKeys(normalized, true);
    // Number words add keys; a figure already read from digits keeps how it was written.
    if (words) for (const [key, seen] of figureKeys(words.join(' '), false)) if (!snapshotFigures.has(key)) snapshotFigures.set(key, seen);
    // Unnamed level: every occurrence of a question figure, in digits and in
    // number words alike, with what follows it, whether or not the general
    // rule refuses it here. One occurrence that is not a rule figure, in any
    // form and in any entry, defeats the exemption.
    if (unnamed) {
      const forms = [figureKeys(normalized, true), ...(words ? [figureKeys(words.join(' '), true)] : [])];
      for (const form of forms) {
        for (const [key, seen] of form) if (model.numberKeys.has(key)) figureSeen.set(key, mergeFigureSeen(figureSeen.get(key), seen));
      }
    }
    for (const [key, seen] of snapshotFigures) {
      if (!model.numberKeys.has(key)) continue;
      if (key.length >= CONSULT_GATE_MIN_FIGURE_DIGITS || seen.unit) {
        if (unnamed) figureRefused.add(key);
        else reasons.add('snapshot_figure');
      }
    }
    for (const run of normalized.match(/\d(?:[\d]|[\s.\-/_](?=\d))*/gu) ?? []) {
      const digits = run.replace(/\D/gu, '');
      if (digits.length >= CONSULT_GATE_MIN_JOINT_DIGITS && model.digitConcat.includes(digits)) reasons.add('snapshot_figure');
    }
    if (model.dates.full.size > 0 || model.dates.monthDay.size > 0) {
      const snapshotDates = dateKeys(normalized, words);
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

    if (reasons.size > 0) break;
    // Identifier values: whole (any length, also glued inside a longer token),
    // segments, long token sequences, and their parts.
    const isIdentifier = entry.kind === 'identifier' || entry.kind === 'person_identifier' || entry.kind === 'account_scope';
    if (isIdentifier) {
      const whole = compact(entry.text);
      const exempt = entry.kind === 'account_scope' && PRODUCT_DEFAULT_SCOPES.has(whole);
      if (!exempt && whole.length <= longestCompact) {
        identifierHit(formHit(whole));
        if (whole.length >= CONSULT_GATE_MIN_DISTINCTIVE_IDENTIFIER_CHARS) {
          model.compactViews.forEach((view, index) => {
            if (view.includes(whole)) identifierHit(index === 0 ? 'plain' : 'decoded');
          });
        }
      }
      if (!exempt) {
        // Each segment of a path, locator, address or "label: value" title is
        // protected whole when it is more than one word or carries a digit.
        for (const segment of entry.text.split(/[/\\?#&=:@]+/u)) {
          if (segment.length === 0 || segment.length > longestCompact * 4) continue;
          const segmentForm = compact(segment);
          let segmentWords = 0;
          forEachToken(foldText(segment), () => { segmentWords += 1; });
          if (segmentForm !== whole && (segmentWords > 1 || /\d/u.test(segmentForm))) identifierHit(formHit(segmentForm));
        }
        forEachToken(folded, (token) => {
          identifierTokens.add(token.norm);
          if (token.norm.length < 3 || NAME_STOPWORDS.has(token.norm) || componentCandidates.has(token.norm)) return;
          const source = formHit(token.norm);
          if (!source) return;
          if (entry.kind === 'person_identifier' || (/\d/u.test(token.norm) && /\p{L}/u.test(token.norm))) identifierHit(source);
          else if (token.capitalized || token.labelled) componentCandidates.set(token.norm, source);
        });
      }
    }

    if (reasons.size > 0) break;
    // Token stream: shared runs (ordered and as content-word sets), names, case statistics.
    // A whole sentence shorter than the run length (and at least three
    // tokens) is still a copy when the question contains all of it: tracked
    // here per sentence.
    let sentence: string[] = [];
    const closeSentence = (): void => {
      if (sentence.length >= CONSULT_GATE_SHARED_RUN_TOKENS - 1 && sentence.length < runTokens
        && sentence.filter(isContent).length >= CONSULT_GATE_RUN_MIN_CONTENT_TOKENS
        && model.tokenKeys[0]!.includes(`${SEP}${sentence.join(SEP)}${SEP}`)) {
        reasons.add('shared_token_run');
      }
      sentence = [];
    };
    // Unnamed level: the answer's own wording is not compared for copies (the
    // runs restart on either side of it); everything else below still reads it.
    const wordingExempt = unnamed && entry.path === WRITER_ANSWER_PATH;
    if (wordingExempt) {
      closeOverlap();
      fullRun.reset();
      contentRun.reset();
      contentSpan.reset();
    }
    let first = true;
    forEachToken(folded, (token) => {
      if (wordingExempt) {
        // Name and case statistics only: no runs, no sentence overlap.
      } else {
        if (first || token.initial) {
          closeSentence();
          closeOverlap();
        }
        sentenceTokens += 1;
        if (sentenceTokens > SENTENCE_OVERLAP_SPAN_TOKENS) closeOverlap();
        if (questionContent.has(token.norm)) {
          sentenceContent.add(token.norm);
          contentCounts.set(token.norm, (contentCounts.get(token.norm) ?? 0) + 1);
        }
        if (sentence.length < runTokens) sentence.push(token.norm);
        if (fullRun.feed(token.norm)) reasons.add('shared_token_run');
        if (isContent(token.norm) && (contentRun.feed(token.norm) || contentSpan.feed(token.norm))) reasons.add('shared_token_run');
      }
      if (entry.kind === 'vocabulary') {
        previous = token;
        first = false;
        return;
      }
      const watched = model.forms.has(token.norm);
      if (watched) {
        const stat = stats.get(token.norm) ?? { capitalized: 0, lower: 0, lowerAnywhere: 0 };
        const prose = entry.kind === 'text' || entry.kind === 'user_question';
        if (token.capitalized) stat.capitalized += 1;
        else {
          if (entry.kind !== 'user_question') stat.lower += 1;
          if (prose && !token.labelled) stat.lowerAnywhere += 1;
        }
        stats.set(token.norm, stat);
      }
      const joined = first ? previous !== undefined : token.joined;
      if (previous && joined && previous.capitalized && token.capitalized
        && !NAME_STOPWORDS.has(previous.norm) && !NAME_STOPWORDS.has(token.norm)
        && previous.norm.length >= 2 && token.norm.length >= 2) {
        const known = model.forms.has(previous.norm + token.norm) || model.forms.has(token.norm + previous.norm)
          || model.forms.has(previous.norm) || model.forms.has(token.norm);
        if (known) {
          const midSentence = !(first || token.initial) || !previous.initial;
          const key = `${previous.norm} ${token.norm}`;
          const existing = pairCandidates.get(key);
          pairCandidates.set(key, { left: previous.norm, right: token.norm, midSentence: midSentence || (existing?.midSentence ?? false) });
        }
      }
      const initial = first || token.initial;
      // Single-word names: capitalized words in prose (sentence-initial ones
      // included), and label or quoted values in any entry and any case.
      // Capitalized words inside paths and titles go through the component rule.
      if (watched && token.norm.length >= 2 && !NAME_STOPWORDS.has(token.norm) && !FUNCTION_WORDS.has(token.norm)
        && (token.labelled || (entry.kind === 'text' && token.capitalized && token.norm.length >= 3
          // A first word counts only in running prose: the first word of a
          // table cell, caption or column header is capitalized by layout.
          && (!initial || PROSE_PATHS.has(entry.path))))) {
        const existing = singleCandidates.get(token.norm);
        singleCandidates.set(token.norm, {
          source: model.forms.get(token.norm)!,
          labelled: token.labelled || (existing?.labelled ?? false),
          initialOnly: (existing?.initialOnly ?? true) && initial && !token.labelled,
          // A capitalized label or quoted value ("Reporter: 'Fenwick'"): how a
          // name is written, so never an ordinary word at the unnamed level.
          strongLabel: (existing?.strongLabel ?? false) || (token.labelled && token.capitalized),
        });
      }
      previous = token;
      first = false;
    });
    if (wordingExempt) {
      sentence = [];
      fullRun.reset();
      contentRun.reset();
      contentSpan.reset();
    } else {
      closeSentence();
      closeOverlap();
    }
  }
  if (reasons.size > 0) return reasons;
  // Unnamed level: a figure the general rule refuses passes only when every
  // snapshot occurrence, in digits or in words, is a plain number of at most
  // three digits followed by a duration or percent word, and the question
  // itself writes it that way every time (QuestionModel.ruleOnlyKeys).
  for (const key of figureRefused) {
    const seen = figureSeen.get(key);
    const exempt = seen !== undefined && seen.rule && !seen.bare && !seen.other
      && key.length <= CONSULT_GATE_UNNAMED_MAX_RULE_FIGURE_DIGITS && model.ruleOnlyKeys.has(key);
    if (!exempt) {
      reasons.add('snapshot_figure');
      return reasons;
    }
  }
  for (const words of overlapCandidates) {
    const rare = words.filter((word) => (contentCounts.get(word) ?? 0) <= CONSULT_GATE_RARE_WORD_OCCURRENCES);
    if (rare.length >= CONSULT_GATE_SENTENCE_OVERLAP_WORDS) {
      reasons.add('shared_token_run');
      return reasons;
    }
  }

  // Decisions that need whole-snapshot case statistics.
  const statOf = (token: string): NameStats => stats.get(token) ?? { capitalized: 0, lower: 0, lowerAnywhere: 0 };
  const ordinary = (token: string): boolean => ordinaryWord !== undefined && ordinaryWord(token) && !identifierTokens.has(token);
  const neverLower = (token: string): boolean => statOf(token).lower === 0;
  const nameHit = (source: FormSource): void => { reasons.add(source === 'decoded' ? 'encoded_identifier' : 'snapshot_name'); };
  for (const pair of pairCandidates.values()) {
    // A capitalized pair is a name once it was written with one part
    // mid-sentence; lower-case occurrences elsewhere do not cancel it.
    if (!pair.midSentence) {
      const namelike = (part: string): boolean => statOf(part).capitalized >= statOf(part).lower;
      if (!namelike(pair.left) && !namelike(pair.right)) continue;
    }
    const pairSource = model.forms.get(pair.left + pair.right) ?? model.forms.get(pair.right + pair.left);
    if (pairSource) nameHit(pairSource);
    // A part alone is protected when the pair was written mid-sentence and the
    // part (an ordinary word, or the vocabulary rule would already refuse it)
    // never appears in lower case.
    if (!pair.midSentence) continue;
    for (const part of [pair.left, pair.right]) {
      const partSource = model.forms.get(part);
      if (partSource && part.length >= 3 && neverLower(part)) nameHit(partSource);
    }
  }
  for (const [token, single] of singleCandidates) {
    // A label or quoted value is a name outright. A capitalized word seen
    // mid-sentence is one unless lower-case uses clearly dominate (three or
    // more, and at least three times the capitalized ones), so a lower-case
    // repeat does not unmake a name while a defined term used mostly in lower
    // case stays a word. A word seen capitalized only at the start of
    // sentences is weaker evidence: it is a name only if never written in
    // lower case anywhere.
    // Unnamed level (owner ruling): an ordinary dictionary word of the owner's
    // languages, or a country, is not a name on its own when the snapshot
    // also writes it in lower case at least once ("Retail Park" beside "a
    // retail park", "Offer letter: probation"). A dictionary word the
    // snapshot only ever capitalizes ("rue des Tanneurs", "Grace called"), a
    // capitalized label or quoted value ("Reporter: 'Fenwick'"), a word of a
    // title, path, author or account value, and every word outside the
    // dictionaries keep the general rule. (Exempting sentence-initial-only
    // words as well let 39 of 223 sample given names through and cut no
    // false refusal on the measured set, so it is not done.)
    if (!single.strongLabel && ordinary(token) && statOf(token).lower + statOf(token).lowerAnywhere > 0) continue;
    const stat = statOf(token);
    const dominatedByLower = stat.lower >= 3 && stat.lower >= 3 * stat.capitalized;
    if (single.labelled || (single.initialOnly ? stat.lower === 0 && stat.lowerAnywhere === 0 : !dominatedByLower)) nameHit(single.source);
  }
  // Identifier and path components written capitalized (or as a label value),
  // in any position, unless the word is shown to be ordinary by a lower-case
  // use in prose or in the owner's question. A lower-case component that is a
  // dictionary word (a folder named "tenancy") is not protected: it is the
  // topic, and protecting it would refuse every question about that topic.
  for (const [token, source] of componentCandidates) if (statOf(token).lowerAnywhere === 0) identifierHit(source);
  return reasons;
}

/**
 * Unordered content-word spans: a window of `size` consecutive content tokens
 * whose multiset equals that of any window of the question's content tokens,
 * so swapping adjacent words does not hide a copy.
 */
function spanMatcher(question: readonly string[], size: number): { feed(token: string): boolean; reset(): void } {
  const key = (tokens: readonly string[]): string => [...tokens].sort().join(' ');
  const wanted = new Set<string>();
  for (let start = 0; start + size <= question.length; start += 1) wanted.add(key(question.slice(start, start + size)));
  const vocabulary = new Set(question);
  // Count of window tokens the question contains; a key is built only when
  // every token in the window is a question token, so ordinary text allocates nothing.
  let window: string[] = [];
  let inQuestion = 0;
  return {
    feed(token: string): boolean {
      if (wanted.size === 0) return false;
      window.push(token);
      if (vocabulary.has(token)) inQuestion += 1;
      if (window.length > size && vocabulary.has(window.shift()!)) inQuestion -= 1;
      return window.length === size && inQuestion === size && wanted.has(key(window));
    },
    reset(): void {
      window = [];
      inQuestion = 0;
    },
  };
}

function wordsOf(folded: string): string[] {
  const words: string[] = [];
  forEachToken(folded, (token) => words.push(token.norm));
  return words;
}

function hasNumberWord(normalized: string): boolean {
  NUMBER_WORD_PREFIX ??= new RegExp(`\\b(?:${NUMBER_PARTS.filter((part) => part.length >= 3).join('|')})`, 'u');
  return NUMBER_WORD_PREFIX.test(normalized);
}
let NUMBER_WORD_PREFIX: RegExp | undefined;

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

const DATE_JOINERS: ReadonlySet<string> = new Set(['of', 'de', 'del', 'van', 'in', 'the', 'du', 'des', 'le', 'el', 'em', 'op', 'am', 'den', 'il', 'di', 'da', 'do']);

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
  'years', 'yrs', 'months', 'weeks', 'days', 'units', 'hours', 'minutes',
  // other configured languages (accents removed)
  'anos', 'ans', 'annees', 'anni', 'jaar', 'jahre', 'jahren', 'meses', 'mois', 'maanden', 'monate', 'mesi', 'dias',
  'jours', 'dagen', 'tage', 'giorni', 'semanas', 'semaines', 'weken', 'wochen', 'settimane', 'horas', 'heures', 'uur',
  'stunden', 'ore', 'minutos', 'minuten', 'minuti', 'euro', 'dolares', 'reais', 'real', 'libras', 'francs', 'franken',
  'kilos', 'gramos', 'grammes', 'gramm', 'grammi', 'metros', 'metres', 'meter', 'metri', 'litros', 'litres', 'liter',
  'litri', 'procent', 'prozent', 'percento', 'porcento', 'pourcent',
  '$', '\u20AC', '\u00A3', '\u00A5', '\u20B9',
]);

/**
 * Rule units: the words after a figure that the unnamed level lets a small
 * snapshot figure keep (durations from hours to months, singular and plural,
 * and percent), in the configured languages, accents removed. Years are left
 * out on purpose: "37 years" is as often an age as a duration, and an exact
 * age is a personal figure (eval/consult-leak/corpus.ts r3-figure-unit-pt).
 */
const RULE_UNIT_WORDS: ReadonlySet<string> = new Set([
  'hour', 'hours', 'hr', 'hrs', 'h', 'minute', 'minutes', 'min', 'mins', 'day', 'days', 'week', 'weeks', 'month', 'months',
  '%', 'percent',
  'mes', 'meses', 'mois',
  'maand', 'maanden', 'monat', 'monate', 'mese', 'mesi', 'dia', 'dias', 'jour', 'jours', 'dag', 'dagen', 'tag', 'tage',
  'giorno', 'giorni', 'semana', 'semanas', 'semaine', 'semaines', 'week', 'weken', 'woche', 'wochen', 'settimana',
  'settimane', 'hora', 'horas', 'heure', 'heures', 'uur', 'stunde', 'stunden', 'ora', 'ore', 'minuto', 'minutos',
  'minuten', 'minuti', 'procent', 'prozent', 'percento', 'porcento', 'pourcent',
]);

// Symbols before a figure that make it money or a share, never a rule figure.
const FIGURE_PREFIX_SYMBOLS: ReadonlySet<string> = new Set(['$', '\u20AC', '\u00A3', '\u00A5', '\u20B9', '%']);

/**
 * How one figure key was seen in a text, merged over every occurrence:
 * `unit`, a unit or currency next to it (the general rule); and, for the
 * unnamed level, `rule` (a plain number followed by a rule unit), `bare` (no
 * unit at all) and `other` (anything else: another unit, a currency, a
 * written form with separators).
 */
interface FigureSeen {
  readonly unit: boolean;
  readonly rule: boolean;
  readonly bare: boolean;
  readonly other: boolean;
}

function mergeFigureSeen(left: FigureSeen | undefined, right: FigureSeen): FigureSeen {
  if (!left) return right;
  return { unit: left.unit || right.unit, rule: left.rule || right.rule, bare: left.bare || right.bare, other: left.other || right.other };
}

/**
 * Numbers in normalized text, keyed by their digits as written with every
 * separator (. , ' _ and grouping spaces) removed, plus the same with trailing
 * zeros dropped, so "2,375.50", "237550", "2375.5" and "2.3755k" share a key.
 * A zero fraction of one or two digits is also dropped ("2,400.00" keys as
 * "2400" too). Leading zeros are kept in one key and dropped in another. The value says
 * how the number was seen (FigureSeen); `unit` is true when a unit or currency
 * sits next to the number. Keys shorter than two digits are not produced.
 */
function figureKeys(normalized: string, needUnits: boolean): Map<string, FigureSeen> {
  const keys = new Map<string, FigureSeen>();
  for (const match of normalized.matchAll(/([^\s\d]?)\s?(\d+(?:[.,'\u2019_ ]\d+)*)\s?(%|[\p{L}$\u20AC\u00A3\u00A5\u20B9]{1,8})?/gu)) {
    const before = match[1] ?? '';
    const written = match[2]!;
    const after = match[3] ?? '';
    const unit = needUnits && (UNIT_WORDS.has(before) || UNIT_WORDS.has(after));
    // A letter before the number ends the previous word; only a symbol there
    // can make the figure money or a share.
    // "per" and "pour" count only as the first word of "per cent" / "pour cent";
    // a bare "per" ("120 per hour") is a rate, never a rule figure.
    const end = (match.index ?? 0) + match[0].length;
    const ruleUnit = after === 'per' || after === 'pour' ? /^\s?cent(?![\p{L}\p{N}])/u.test(normalized.slice(end)) : RULE_UNIT_WORDS.has(after);
    const rule = needUnits && /^\d+$/u.test(written) && ruleUnit && !FIGURE_PREFIX_SYMBOLS.has(before);
    const seen: FigureSeen = { unit, rule, bare: !unit && !rule, other: unit && !rule };
    const parts = new Set<string>([written]);
    if (written.includes(' ')) for (const part of written.split(' ')) parts.add(part);
    // A zero fraction is the same amount without it: "2,400.00" also keys as
    // "2400", so "2,400" in a question matches it (dropping the trailing zeros
    // alone would leave only the two-digit key "24", which is not refused).
    for (const part of [...parts]) {
      const whole = part.replace(/[.,]0{1,2}$/u, '');
      if (whole !== part && /\d/u.test(whole)) parts.add(whole);
    }
    for (const part of parts) {
      const digits = part.replace(/\D/gu, '');
      for (const key of [digits, digits.replace(/^0+(?=\d)/u, ''), digits.replace(/0+$/u, '')]) {
        if (key.length >= 2) keys.set(key, mergeFigureSeen(keys.get(key), seen));
      }
    }
  }
  return keys;
}
