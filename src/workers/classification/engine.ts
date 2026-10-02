// Per-item tier classification engine (frontier-max doctrine).
//
// Corpus-level secure_local tiers are pre-classification DEFAULTS only. This
// engine decides each item's REAL tier: conservative sensitive detectors keep
// the financial/health/credential/identity minority at S4/S5 (secure_local,
// local lanes only), confident-clean items downgrade to internal so they can
// ride frontier (cloud) lanes, and EVERYTHING ELSE stays secure_local as a
// pending pattern-level decision for the future human approval surface.
//
// Invariants:
// - Sensitive detectors run FIRST and any hit wins. A clean signal can never
//   rescue an item that tripped a detector (the asymmetry property).
// - Downgrades require a POSITIVE clean signal. Absence of sensitive signals
//   is never enough; ambiguity defaults to secure_local.
// - Nothing uncertain is auto-approved: default_secure items carry a
//   patternKey (sender domain / folder subtree / chat) so pending volumes can
//   be aggregated for the approval surface, which is FUTURE work.
// - The engine is pure and deterministic — no model calls in this slice. The
//   scorer seam below is where a local-LLM scorer plugs in later.

import { scanDropboxContentPolicyText } from '../dropbox-files/content-policy.ts';
import {
  matchSensitivityMap,
  type SensitivityMap,
} from '../../core/sensitivity-map.ts';

export const ITEM_CLASSIFICATION_ENGINE_KIND = 'olympus_deterministic_item_tier_classifier';
export const ITEM_CLASSIFICATION_ENGINE_VERSION = '2026-06-21.1';

export type ItemTier = 'S2' | 'S3' | 'S4' | 'S5';
export type ItemTrustDomain = 'internal' | 'secure_local';
export type ItemTierDecidedBy = 'sensitive_detector' | 'sensitivity_map' | 'clean_rules' | 'default_secure';

export interface ClassifyItemTierInput {
  subject?: string;
  title?: string;
  sender?: string;
  path?: string;
  labels?: readonly string[];
  text: string;
}

export interface ItemTierClassification {
  tier: ItemTier;
  trustDomain: ItemTrustDomain;
  decidedBy: ItemTierDecidedBy;
  signals: string[];
  patternKey?: string;
}

// --- Scorer seam (future local-LLM plug-in) --------------------------------
// A scorer is ONLY consulted for items the deterministic engine would leave at
// default_secure, and may only declare them confidently clean. It can never
// override a sensitive detector hit, and anything it is not confident about
// stays secure_local. Async scorers (a local model on Delphi) go through
// classifyItemTierWithScorer; the sync engine ignores Promise verdicts, which
// fails SAFE (the item stays secure).

export interface TierScorerVerdict {
  confidentClean: boolean;
  signals?: readonly string[];
}

export interface ItemTierScorer {
  readonly id: string;
  scoreClean(input: ClassifyItemTierInput): TierScorerVerdict | Promise<TierScorerVerdict>;
}

export interface ClassifyItemTierOptions {
  scorer?: ItemTierScorer;
  // Senders whose mail is ALWAYS sensitive (e.g. the user's clinicians),
  // matched case-insensitively as substrings of the sender field. Checked as
  // a detector: overrides clean rules, never overridden by them.
  sensitiveSenderPatterns?: readonly string[];
  sensitivityMap?: SensitivityMap;
}

export function classifyItemTier(
  input: ClassifyItemTierInput,
  options: ClassifyItemTierOptions = {},
): ItemTierClassification {
  const haystack = buildHaystack(input);

  // The S5 secret floor outranks EVERY override, including the sensitive
  // sender list. That option is a raise (S4 for senders the owner flagged);
  // returning S4 ahead of this check would also CAP a credential-carrying
  // message at a tier that is model- and Venice-eligible.
  const sensitive = detectSensitiveSignals(input, haystack);
  if (sensitive.signals.length > 0 && sensitive.tier === 'S5') {
    return {
      tier: 'S5',
      trustDomain: 'secure_local',
      decidedBy: 'sensitive_detector',
      signals: sensitive.signals,
    };
  }

  const senderLower = (input.sender ?? '').toLowerCase();
  for (const pattern of options.sensitiveSenderPatterns ?? []) {
    const needle = pattern.trim().toLowerCase();
    if (needle && senderLower.includes(needle)) {
      return {
        tier: 'S4',
        trustDomain: 'secure_local',
        decidedBy: 'sensitive_detector',
        signals: ['sensitive_sender_override'],
      };
    }
  }

  const sensitivityMapMatch = matchSensitivityMap(options.sensitivityMap, input);
  if (sensitivityMapMatch) {
    return {
      tier: sensitivityMapMatch.targetTrustTier,
      trustDomain: sensitivityMapMatch.targetTrustDomain,
      decidedBy: 'sensitivity_map',
      signals: sensitivityMapMatch.categoryIds.map((categoryId) => `sensitivity_map:${categoryId}`),
    };
  }

  if (sensitive.signals.length > 0) {
    return {
      tier: sensitive.tier,
      trustDomain: 'secure_local',
      decidedBy: 'sensitive_detector',
      signals: sensitive.signals,
    };
  }

  const clean = detectCleanSignals(input, haystack);
  if (clean.signals.length > 0) {
    return {
      tier: clean.tier,
      trustDomain: 'internal',
      decidedBy: 'clean_rules',
      signals: clean.signals,
    };
  }

  if (options.scorer) {
    const verdict = options.scorer.scoreClean(input);
    if (isSyncVerdict(verdict) && verdict.confidentClean) {
      return {
        tier: 'S3',
        trustDomain: 'internal',
        decidedBy: 'clean_rules',
        signals: [`scorer:${options.scorer.id}`, ...(verdict.signals ?? [])],
      };
    }
  }

  return defaultSecureClassification(input);
}

// Async seam wrapper for local-LLM scorers. Same invariants: the scorer is
// consulted only on default_secure outcomes, scorer failure keeps the item
// secure, and a detector hit always wins. Detector options (e.g. sensitive
// sender patterns) run BEFORE the scorer, so a configured detector can never
// be rescued by a confident-clean verdict.
export async function classifyItemTierWithScorer(
  input: ClassifyItemTierInput,
  scorer: ItemTierScorer | undefined,
  options: Omit<ClassifyItemTierOptions, 'scorer'> = {},
): Promise<ItemTierClassification> {
  const base = classifyItemTier(input, options);
  if (!scorer || base.decidedBy !== 'default_secure') return base;
  let verdict: TierScorerVerdict;
  try {
    verdict = await scorer.scoreClean(input);
  } catch {
    return base; // scorer failure fails SAFE: stay secure
  }
  if (!verdict.confidentClean) return base;
  return {
    tier: 'S3',
    trustDomain: 'internal',
    decidedBy: 'clean_rules',
    signals: [`scorer:${scorer.id}`, ...(verdict.signals ?? [])],
  };
}

// patternKey for pending (default_secure) aggregation: sender domain for mail,
// second-level folder subtree for files, 'chat' for messages.
export function deriveClassificationPatternKey(input: ClassifyItemTierInput): string {
  const sender = input.sender?.trim();
  if (sender) {
    const matches = [...sender.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)];
    const domain = matches.at(-1)?.[1]?.toLowerCase().replace(/[.>]+$/, '');
    return domain ? `sender:${domain}` : 'sender:unparsed';
  }
  const path = input.path?.trim();
  if (path) {
    const segments = path.split(/[\\/]+/).filter(Boolean);
    const folders = segments.slice(0, -1); // drop the filename
    const subtree = folders.slice(0, 2).join('/');
    return `folder:/${subtree.toLowerCase()}`;
  }
  return 'chat';
}

function defaultSecureClassification(input: ClassifyItemTierInput): ItemTierClassification {
  return {
    tier: 'S4',
    trustDomain: 'secure_local',
    decidedBy: 'default_secure',
    signals: ['default:no_confident_signal'],
    patternKey: deriveClassificationPatternKey(input),
  };
}

function isSyncVerdict(value: TierScorerVerdict | Promise<TierScorerVerdict>): value is TierScorerVerdict {
  return typeof (value as { then?: unknown }).then !== 'function';
}

function buildHaystack(input: ClassifyItemTierInput): string {
  return [input.subject, input.title, input.text]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

// --- Detector surface shared with the four-tier classifier -------------------
// The tier classifier (tier-classifier.ts) reuses these exact detectors rather
// than keeping a second copy. They are pure and content-free in what they
// return: finding kinds and fixed-vocabulary categories, never matched text.

/** Secret finding kinds (S5) present in `text`. Empty when none. */
export function detectSecretFindingKinds(text: string): string[] {
  if (!text.trim()) return [];
  const scan = scanDropboxContentPolicyText({ text });
  return [...new Set(
    scan.findings
      .map((finding) => finding.finding_type)
      .filter((type) => SECRET_FINDING_TYPES.has(type)),
  )].sort();
}

export interface SensitiveContentDetection {
  /**
   * Structured detector hits: a Luhn-valid card, an IBAN, a routing or account
   * number, an SSN, a passport or NIF number. Each one raises to Private at once.
   */
  signals: string[];
  /**
   * Vocabulary-only hits (`health:vocabulary:treatment`, `financial:vocabulary:invoice`,
   * `health:origin_hint`). Words alone do not prove an item private: a book
   * chapter says "treatment" and "symptoms" too. When a privacy-safe model can
   * be asked, these families are borderline and the model judges the item;
   * with none, they raise to Private exactly like a structured hit.
   */
  vocabulary: string[];
  /**
   * Families worth the privacy-safe model's second look: every vocabulary
   * family above, plus families with a single weak term (not enough to raise).
   * A family with a structured hit is never borderline (it is already Private).
   */
  borderline: string[];
}

/**
 * The S4 detectors (financial, health, identity) without the secret scan,
 * split into structured hits and vocabulary-only hits, plus which families
 * came close. `input.sender` and `input.path` feed the health origin hint
 * exactly as they do in classifyItemTier.
 */
export function detectSensitiveContent(input: ClassifyItemTierInput): SensitiveContentDetection {
  const haystack = buildHaystack(input);
  const signals = [
    ...detectFinancialStructuredSignals(haystack),
    ...detectIdentityDocumentSignals(haystack),
  ];
  const vocabulary = [
    ...detectFinancialVocabularySignals(haystack),
    ...detectHealthSignals(input, haystack),
  ];
  const structured = (family: string) => signals.some((signal) => signal.startsWith(`${family}:`));
  const worded = (family: string) => vocabulary.some((signal) => signal.startsWith(`${family}:`));
  const borderline: string[] = [];
  if (!structured('financial')
    && (worded('financial') || matchTerms(haystack, FINANCIAL_WEAK_TERMS).length === 1)) {
    borderline.push('financial');
  }
  if (worded('health') || matchTerms(haystack, HEALTH_WEAK_TERMS).length === 1) {
    borderline.push('health');
  }
  // Therapy, legal, family-law and identity vocabulary in the TEXT has no
  // deterministic raise of its own; it is exactly what the privacy-safe
  // sniffer's excerpt question is for (design section 2.2, step 12). The text
  // alone: the names were already judged in pass 1, where an owner's
  // Personal-target category can settle them.
  const text = input.text ?? '';
  if (PERSONAL_LIFE_NAME_PATTERN.test(text)) borderline.push('personal_life');
  if (!structured('identity') && IDENTITY_NAME_PATTERN.test(text)) {
    borderline.push('identity');
  }
  return { signals, vocabulary, borderline };
}

/**
 * Whether a set of names (title, path, folder names, labels) uses the fixed
 * sensitive vocabulary at all. A single weak term is enough: this only decides
 * whether the privacy-safe sniffer should be ASKED, never the tier itself.
 */
export function namesLookPossiblyPrivate(names: string): string[] {
  if (!names.trim()) return [];
  const families: string[] = [];
  if (matchTerms(names, [...FINANCIAL_STRONG_TERMS, ...FINANCIAL_WEAK_TERMS]).length > 0) families.push('financial');
  if (matchTerms(names, [...HEALTH_STRONG_TERMS, ...HEALTH_WEAK_TERMS]).length > 0) families.push('health');
  if (IDENTITY_NAME_PATTERN.test(names)) families.push('identity');
  if (PERSONAL_LIFE_NAME_PATTERN.test(names)) families.push('personal_life');
  return families;
}

const IDENTITY_NAME_PATTERN = /\b(?:passport|ssn|social security|driver'?s licen[cs]e|national id|identity card|birth certificate)\b/i;
const PERSONAL_LIFE_NAME_PATTERN = /\b(?:therapy|therapist|counsel(?:l)?ing|divorce|custody|lawsuit|attorney|legal|bank|banking|mortgage|loan|will and testament|estate)\b/i;

// --- Sensitive detectors (hard S4/S5 floors, any hit wins) ------------------

const SECRET_FINDING_TYPES = new Set([
  'private_key_material',
  'aws_access_key_id',
  'slack_token',
  'api_secret_token',
  'credential_assignment',
  'explicit_s5_marker',
]);

const FINANCIAL_STRONG_TERMS = [
  'bank statement',
  'account statement',
  'tax return',
  'wire transfer',
  'payroll',
  'direct deposit',
  'bank account',
  'iban',
] as const;

const FINANCIAL_WEAK_TERMS = [
  'invoice',
  'salary',
  'tax',
  'banking',
  'remittance',
  'billing',
  'balance due',
  'payment due',
  'swift',
  'irs',
  'accountant',
  'payslip',
] as const;

const HEALTH_STRONG_TERMS = [
  'medical record',
  'patient portal',
  'lab result',
  'lab results',
  'health insurance',
  'blood test',
] as const;

const HEALTH_WEAK_TERMS = [
  'diagnosis',
  'prescription',
  'clinical',
  'patient',
  'medication',
  'dosage',
  'symptom',
  'symptoms',
  'treatment',
  'biopsy',
  'radiology',
  'pathology',
  'mri',
  'immunization',
  'vaccination',
  'physician',
  'pediatric',
  'cardiology',
  'clinic',
  'hospital',
] as const;

const HEALTH_ORIGIN_HINT = /clinic|hospital|medic|health|pharma|doctor/i;

function detectSensitiveSignals(
  input: ClassifyItemTierInput,
  haystack: string,
): { tier: 'S4' | 'S5'; signals: string[] } {
  const signals: string[] = [];

  // Credentials/secrets first: the only S5 floor. Reuses the shared
  // deterministic secret scan from the Dropbox content policy.
  const scan = scanDropboxContentPolicyText({ text: haystack });
  const secretTypes = [...new Set(
    scan.findings
      .map((finding) => finding.finding_type)
      .filter((type) => SECRET_FINDING_TYPES.has(type)),
  )];
  for (const type of secretTypes) signals.push(`secret:${type}`);

  signals.push(...detectFinancialSignals(haystack));
  signals.push(...detectHealthSignals(input, haystack));
  signals.push(...detectIdentityDocumentSignals(haystack));

  return { tier: secretTypes.length > 0 ? 'S5' : 'S4', signals };
}

function detectFinancialSignals(haystack: string): string[] {
  return [...detectFinancialStructuredSignals(haystack), ...detectFinancialVocabularySignals(haystack)];
}

/** Structured financial identifiers: checksummed or labelled numbers, never words alone. */
function detectFinancialStructuredSignals(haystack: string): string[] {
  const signals: string[] = [];

  if (findValidIban(haystack)) signals.push('financial:iban');
  if (findLuhnCardNumber(haystack)) signals.push('financial:card_luhn');
  if (/\b(?:aba|routing)\s*(?:number|no\.?|#)?\s*[:#-]?\s*\d{9}\b/i.test(haystack)) {
    signals.push('financial:routing_number');
  }
  if (/\baccount\s*(?:number|no\.?|#)\s*[:#-]?\s*[\dXx*][\dXx* -]{5,}/i.test(haystack)) {
    signals.push('financial:account_number');
  }
  return signals;
}

/** Financial vocabulary: one strong term or two weak ones. Words, not proof. */
function detectFinancialVocabularySignals(haystack: string): string[] {
  const strong = matchTerms(haystack, FINANCIAL_STRONG_TERMS);
  const weak = matchTerms(haystack, FINANCIAL_WEAK_TERMS);
  if (strong.length >= 1 || weak.length >= 2) {
    return [...strong, ...weak].map((term) => `financial:vocabulary:${term}`);
  }
  return [];
}

function detectHealthSignals(input: ClassifyItemTierInput, haystack: string): string[] {
  const strong = matchTerms(haystack, HEALTH_STRONG_TERMS);
  const weak = matchTerms(haystack, HEALTH_WEAK_TERMS);
  const origin = `${input.sender ?? ''}\n${input.path ?? ''}`;
  const originHint = HEALTH_ORIGIN_HINT.test(origin);

  const hit = strong.length >= 1 || weak.length >= 2 || (originHint && strong.length + weak.length >= 1);
  if (!hit) return [];

  const signals = [...strong, ...weak].map((term) => `health:vocabulary:${term}`);
  if (originHint) signals.push('health:origin_hint');
  return signals;
}

function detectIdentityDocumentSignals(haystack: string): string[] {
  const signals: string[] = [];
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(haystack) || /\b(?:ssn|social security number)\b[:\s#]*\d{3}-?\d{2}-?\d{4}\b/i.test(haystack)) {
    signals.push('identity:ssn');
  }
  const passport = haystack.match(/\bpassport\s*(?:no\.?|number|#)\s*[:#-]?\s*([A-Z0-9]{6,9})\b/i);
  if (passport?.[1] && /\d{4,}/.test(passport[1])) {
    signals.push('identity:passport_number');
  }
  if (findValidNif(haystack)) signals.push('identity:nif');
  return signals;
}

// IBAN candidates validated with the real mod-97 check so near-misses (wrong
// check digits) do not fire. False negatives fall to default_secure anyway.
function findValidIban(haystack: string): boolean {
  const candidates = haystack.toUpperCase().matchAll(/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g);
  for (const candidate of candidates) {
    if (isValidIban(candidate[0])) return true;
  }
  return false;
}

function isValidIban(candidate: string): boolean {
  const compact = candidate.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= '0' && char <= '9' ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

// Card numbers (design 2.2, step 10). A Luhn check alone is a 1-in-10 coin
// toss on any digit run, so a candidate must also LOOK like a card:
//
// - a whole number: never the fraction of a decimal ("111.32059161437502"),
//   never part of a longer number or of a grid of digit groups;
// - grouped the way cards are printed (4-4-4-4, 4-4-4-4-3, 4-4-4-1..3,
//   Amex 4-6-5, Diners 4-6-4, one separator throughout), or one unbroken run;
// - an issuer prefix with a length that issuer uses (Visa, Mastercard, Amex,
//   Discover, Diners, JCB, UnionPay, Maestro);
// - and passes Luhn.
//
// An unbroken run carries no printed shape, so it also needs card context
// nearby (card, visa, expiry, cvv, an MM/YY date) or must stand on its own:
// a number in a column of numbers (a spreadsheet, a table) without card
// words around it is data, not a card. 2026-10-02: a calorie spreadsheet
// went Private on the digits of a formula result.
const CARD_GROUPED = /(?<![\d.,]|\d[ -])(\d{4}([ -])(?:\d{4}\2\d{4}\2\d{4}(?:\2\d{3})?|\d{4}\2\d{4}\2\d{1,3}|\d{6}\2\d{4,5}))(?!\d|[.,]\d|\2\d)/g;
const CARD_UNBROKEN = /(?<![\d.,]|\d[ -])\d{13,19}(?!\d|[.,]\d)/g;
const CARD_CONTEXT = /\b(?:cards?|card ?(?:no|number|#)|visa|master ?card|amex|american express|discover|diners|jcb|maestro|union ?pay|credit|debit|cardholder|exp|expiry|expires|expiration|valid thru|cvv2?|cvc2?|csc|security code)\b|\b(?:0[1-9]|1[0-2]) ?\/ ?(?:\d{2}|20\d{2})\b/i;
/** Characters either side of an unbroken run read for context and density. */
const CARD_WINDOW = 60;
/** Other digits in that window that make a run part of a numeric table. */
const CARD_DENSE_DIGITS = 8;

function findLuhnCardNumber(haystack: string): boolean {
  for (const match of haystack.matchAll(CARD_GROUPED)) {
    if (isCardNumber(match[1]!.replace(/[ -]/g, ''))) return true;
  }
  for (const match of haystack.matchAll(CARD_UNBROKEN)) {
    const digits = match[0];
    if (!isCardNumber(digits)) continue;
    const before = haystack.slice(Math.max(0, match.index! - CARD_WINDOW), match.index!);
    const after = haystack.slice(match.index! + digits.length, match.index! + digits.length + CARD_WINDOW);
    if (CARD_CONTEXT.test(before) || CARD_CONTEXT.test(after)) return true;
    const otherDigits = (before + after).replace(/\D/g, '').length;
    if (otherDigits < CARD_DENSE_DIGITS) return true;
  }
  return false;
}

/** An issuer prefix with a length that issuer uses, and a valid Luhn check digit. */
function isCardNumber(digits: string): boolean {
  return cardIssuerAccepts(digits) && passesLuhn(digits);
}

function cardIssuerAccepts(digits: string): boolean {
  const length = digits.length;
  const two = Number(digits.slice(0, 2));
  const three = Number(digits.slice(0, 3));
  const four = Number(digits.slice(0, 4));
  const six = Number(digits.slice(0, 6));
  if (digits[0] === '4') return length === 13 || length === 16 || length === 19; // Visa
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return length === 16; // Mastercard
  if (two === 34 || two === 37) return length === 15; // Amex
  if (four === 6011 || two === 65 || (three >= 644 && three <= 649) || (six >= 622126 && six <= 622925)) {
    return length >= 16 && length <= 19; // Discover
  }
  if ((three >= 300 && three <= 305) || two === 36 || two === 38 || two === 39) return length >= 14 && length <= 19; // Diners
  if (four >= 3528 && four <= 3589) return length >= 16 && length <= 19; // JCB
  if (two === 62) return length >= 16 && length <= 19; // UnionPay
  if (two === 50 || (two >= 56 && two <= 69)) return length >= 13 && length <= 19; // Maestro
  return false;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

// Spanish NIF/DNI: 8 digits + the mod-23 check letter. Wrong letters do not fire.
const NIF_CHECK_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

function findValidNif(haystack: string): boolean {
  const candidates = haystack.matchAll(/\b(\d{8})([A-Za-z])\b/g);
  for (const candidate of candidates) {
    const number = Number.parseInt(candidate[1]!, 10);
    const letter = candidate[2]!.toUpperCase();
    if (NIF_CHECK_LETTERS[number % 23] === letter) return true;
  }
  return false;
}

function matchTerms(haystack: string, terms: readonly string[]): string[] {
  const matched: string[] = [];
  for (const term of terms) {
    const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (pattern.test(haystack)) matched.push(term);
  }
  return matched;
}

// --- Clean rules (downgrade ONLY on a positive clean signal) -----------------

const CLEAN_GMAIL_CATEGORIES = new Set(['CATEGORY_FORUMS', 'CATEGORY_UPDATES']);

const LIST_SENDER_LOCAL_PART = /\b(?:no-?reply|donotreply|newsletter|mailer(?:-daemon)?|notifications?|updates|digest|news)@/i;
const LIST_SENDER_DOMAIN = /@(?:[a-z0-9-]+\.)*(?:substack\.com|mailchimp\.com|mailchimpapp\.net|mailgun\.(?:com|org|net)|sendgrid\.(?:com|net)|beehiiv\.com|buttondown\.email|list-manage\.com|lists?\.[a-z0-9.-]+)\b/i;

const PUBLICISH_PATH_SEGMENTS = ['/2 areas/work/', '/presentations/', '/published/', '/public/'];
const PRESENTATION_EXTENSIONS = ['.pptx', '.key', '.odp'];

const PLEASANTRY_PATTERN = /\b(?:thanks|thank you|thx|sounds good|see you|congrats|congratulations|happy birthday|no problem|you'?re welcome|lgtm|great work|well done|good night|good morning|safe travels|haha|lol)\b|👍|🎉|❤️/i;
const SCHEDULING_PATTERN = /\b(?:calendar invite|meeting invite|meeting notes|agenda|zoom link|google meet|rescheduled|schedule|scheduling|available (?:at|on)|see you (?:at|on)|call notes|weekly sync|standup)\b/i;
const COMMERCE_NOTICE_PATTERN = /\b(?:order confirmation|your order|receipt|shipped|shipping update|delivery update|delivered|tracking number|return label|subscription renewal|trial expires|invoice received)\b/i;
const WORK_COORDINATION_PATTERN = /\b(?:project update|status update|roadmap|milestone|pull request|pr review|design review|launch plan|offsite agenda|meeting recap|action items|next steps)\b/i;

function detectCleanSignals(
  input: ClassifyItemTierInput,
  haystack: string,
): { tier: 'S2' | 'S3'; signals: string[] } {
  const signals: string[] = [];

  for (const label of input.labels ?? []) {
    const normalized = label.trim().toUpperCase();
    if (CLEAN_GMAIL_CATEGORIES.has(normalized)) signals.push(`clean:gmail_category:${normalized}`);
  }

  const sender = input.sender?.trim() ?? '';
  if (sender && (LIST_SENDER_LOCAL_PART.test(sender) || LIST_SENDER_DOMAIN.test(sender))) {
    signals.push('clean:list_sender');
  }

  const path = input.path?.trim().toLowerCase() ?? '';
  if (path) {
    const normalizedPath = path.endsWith('/') ? path : `${path}/`;
    for (const segment of PUBLICISH_PATH_SEGMENTS) {
      if (normalizedPath.includes(segment)) {
        signals.push(`clean:public_path:${segment.replace(/\/$/, '')}`);
        break;
      }
    }
    if (PRESENTATION_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      signals.push('clean:presentation_document');
    }
  }

  const pleasantry = isShortPleasantry(haystack);
  if (pleasantry) signals.push('clean:short_pleasantry');
  if (SCHEDULING_PATTERN.test(haystack)) signals.push('clean:scheduling_coordination');
  if (COMMERCE_NOTICE_PATTERN.test(haystack)) signals.push('clean:commerce_notice');
  if (WORK_COORDINATION_PATTERN.test(haystack)) signals.push('clean:work_coordination');

  // Short pleasantries with no other signal are the most clearly harmless
  // class (S2); everything else downgraded by a clean rule stays S3.
  const tier: 'S2' | 'S3' = pleasantry && signals.length === 1 ? 'S2' : 'S3';
  return { tier, signals };
}

function isShortPleasantry(haystack: string): boolean {
  const text = haystack.trim();
  if (!text || text.length > 200) return false;
  if (text.split(/\s+/).length > 30) return false;
  if (/\d{5,}/.test(text)) return false;
  if (/https?:\/\//i.test(text)) return false;
  return PLEASANTRY_PATTERN.test(text);
}
