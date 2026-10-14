import { decodeHTMLStrict } from 'entities';

// The deterministic credential patterns shared by the Secrets floor and the
// outbound guard.
//
// Two callers read this one list so a credential shape cannot be caught on one
// path and missed on the other:
//   - src/workers/dropbox-files/content-policy.ts (the Secrets floor: an item
//     that matches is classed Secrets, stored location-only, and never reaches
//     a model or an embedding call);
//   - src/core/opsec.ts (the outbound guard on answers, consults and remote
//     results).
//
// Each entry carries the stable finding type the floor already reports
// (`private_key_material`, `aws_access_key_id`, `slack_token`,
// `api_secret_token`, `credential_assignment`) and a label for the outbound
// guard. New provider formats reuse `api_secret_token` and new assignment
// shapes reuse `credential_assignment`, so no stored key, tier name or consumer
// changes.
//
// The floor is the ONLY thing that classes an item as Secrets, and Personal
// content can go to cloud models by design, so a miss leaks a credential while
// a false positive only hides that one item from answers. Recall wins:
//   - the patterns lean toward catching, and `accept` is where false positives
//     are cut for the NEW shapes: documentation placeholders, masks,
//     environment lookups, type annotations, empty values and prose;
//   - the floor is a SUPERSET of the one it replaced. The old assignment shape
//     is kept verbatim and unfiltered (LEGACY_CREDENTIAL_ASSIGNMENT), and the
//     other old shapes are unchanged, so nothing the previous floor classed as
//     Secrets is ever let through, except URL placeholders now parsed by the
//     shared URL detector (test/content-policy-secrets.test.ts replays
//     the old regexes over its whole corpus);
//   - everything here runs on whole documents, so no pattern or check may
//     backtrack super-linearly: trims are character walks, key names are read
//     as one plain run and tested in `accept`, and the same test file runs the
//     floor over adversarial 200 KB inputs.

export type SecretFindingType =
  | 'private_key_material'
  | 'aws_access_key_id'
  | 'slack_token'
  | 'api_secret_token'
  | 'credential_assignment';

export interface SharedSecretPattern {
  readonly findingType: SecretFindingType;
  /** Label the outbound guard reports. */
  readonly label: string;
  readonly confidence: number;
  /** Global, so callers can walk every hit. Use `secretPatternHits`. */
  readonly pattern: RegExp;
  /** Delimiter-aware extraction for URL candidates. */
  readonly extract?: (text: string) => RegExpMatchArray[];
  /** Cuts false positives after the regex matches. Absent means every match counts. */
  readonly accept?: (match: RegExpMatchArray) => boolean;
}

/** Every accepted hit, on both the original and the shared canonical form. */
export function secretPatternHits(text: string, spec: SharedSecretPattern,
  variants = secretScreeningVariants(text)): RegExpMatchArray[] {
  const hits: RegExpMatchArray[] = [];
  for (const variant of variants) {
    // Recognized URL parameter keys are owned by the URL parser. Path and
    // custom-key assignments retain their old screening. Otherwise a legacy regex
    // sees an encoded or wrapped placeholder as a long literal credential.
    const urls = spec.label === 'credential_assignment' || spec.label === 'password' || spec.label === 'azure_sas_signature'
      ? credentialUrlMatches(variant).filter(url => URL.canParse(url[0])).flatMap(url => {
        // Userinfo belongs to the same parser: a username such as `password`
        // must not turn `:xxxx@host` into a legacy credential assignment.
        const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*@)/i.exec(url[0]);
        const userinfo: Array<readonly [number, number]> = authority
          ? [[url.index! + authority[0].length - authority[1]!.length, url.index! + authority[0].length]] : [];
        return [...userinfo,
          ...[...url[0].matchAll(/[?#&]((?:&(?:#[xX][0-9a-f]+|#\d+|[a-z][a-z0-9]*);|[^?#&=])*)=/gi)].flatMap(parameter => {
            const key = canonicalizeScreeningText(parameter[1]!.replace(/^amp;/, ''));
            return CREDENTIAL_QUERY_KEY.test(key)
              ? [[url.index! + parameter.index! + 1, url.index! + parameter.index! + parameter[0].length] as const] : [];
          })];
      }) : [];
    spec.pattern.lastIndex = 0;
    let urlAt = 0;
    for (const match of spec.extract?.(variant) ?? variant.matchAll(spec.pattern)) {
      while (urlAt < urls.length && urls[urlAt]![1] <= match.index!) urlAt++;
      if (!match[0]?.trim() || (urls[urlAt] && match.index! >= urls[urlAt]![0])) continue;
      if (!spec.accept || spec.accept(match)) hits.push(match);
    }
  }
  return hits;
}

/** Whether `spec` has an accepted hit in either representation. */
export function hasSecretPatternHit(text: string, spec: SharedSecretPattern,
  variants = secretScreeningVariants(text)): boolean {
  return secretPatternHits(text, spec, variants).length > 0;
}

// --- Value checks -------------------------------------------------------------
//
// Every check below runs on values of any length (an unbroken 200 KB run is a
// legal value), so none of them may backtrack: trims are character walks, and
// every regex is anchored, bounded, or has no overlapping quantifiers.

/**
 * Instruction and interface vocabulary: a spaced value that contains one of
 * these is a hint, a rule or a heading ("Password: reset your password at the
 * link"), not a passphrase. Ordinary function words (the, at, of ...) are NOT
 * here: "the horse rides at midnight" is a perfectly good passphrase.
 */
const PROSE_WORDS = new Set([
  'above', 'again', 'below', 'cannot', 'change', 'changed', 'characters', 'choose', 'click', 'contact', 'enter',
  'expired', 'expires', 'forgot', 'forgotten', 'guideline', 'guidelines', 'hidden', 'incorrect',
  'information', 'instruction', 'instructions', 'invalid', 'least', 'letters', 'link', 'manager',
  'maximum', 'min', 'minimum', 'must', 'need', 'needed', 'needs', 'number', 'numbers', 'optional',
  'please', 'policies', 'policy', 'protected', 'provide', 'provided', 'required', 'requirements',
  'reset', 'retry', 'see', 'send', 'sent', 'setting', 'settings', 'shared', 'should', 'shown', 'sign',
  'strength', 'symbols', 'unchanged', 'use', 'used', 'using', 'via',
]);

/**
 * One bounded canonical form for every credential and steering screen. Four
 * passes handle interleaved HTML entities and repeated percent encoding; NFKC
 * runs on each pass so full-width escapes cannot hide the next layer. Keep
 * scanning the original too: decoding may introduce URL/value delimiters.
 * This is screening only, never a rewrite of stored text or model material.
 */
export function canonicalizeScreeningText(value: string): string {
  for (let depth = 0; depth < 4; depth++) {
    const next = decodeHTMLStrict(value.normalize('NFKC'))
      .replace(/(?:%[0-9a-f]{2})+/gi, encoded => {
        try { return decodeURIComponent(encoded); } catch {
          // Malformed UTF-8 must not shield adjacent ASCII key/delimiter bytes.
          return encoded.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        }
      })
      .normalize('NFKC')
      .replace(/[\p{Quotation_Mark}`]/gu, quote => /['‘’‚‛`]/.test(quote) ? "'" : '"');
    if (next === value) break;
    value = next;
  }
  return value;
}

export function secretScreeningVariants(text: string): readonly string[] {
  const canonical = canonicalizeScreeningText(text);
  return canonical === text ? [text] : [text, canonical];
}

const URL_SCHEME = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//gi;

/**
 * One forward walk: external wrappers end a URL, paired punctuation inside
 * its path and an IPv6 authority do not. Preserve <token>-style values for the
 * shared placeholder check. No regex can consume the rest of a document by
 * treating a closing markdown/HTML/quote delimiter as credential bytes.
 */
function credentialUrlMatches(text: string): RegExpMatchArray[] {
  const whole = text.trim();
  // A whole locator can contain spaces/apostrophes in userinfo. Parse those
  // original bytes before delimiter extraction; only an actual credential
  // takes this path, so wrapped query placeholders never acquire punctuation.
  if (urlCarriesCredential(whole, true)) {
    return [Object.assign([whole] as [string], { index: text.indexOf(whole), input: text })];
  }
  const starts = new RegExp(URL_SCHEME);
  const matches: RegExpMatchArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = starts.exec(text))) {
    let end = starts.lastIndex;
    let parens = 0;
    let authority = true;
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (/[\s\p{Quotation_Mark}`>]/u.test(char)) break;
      if (char === '<') {
        const placeholder = text[end - 1] === '=' ? /^<[\w-]{1,64}>/.exec(text.slice(end, end + 66))?.[0] : undefined;
        if (!placeholder) break;
        end += placeholder.length - 1;
      } else if (char === '[') {
        const host = authority ? /^\[[a-f0-9:.]{2,45}\]/i.exec(text.slice(end, end + 47))?.[0] : undefined;
        if (!host) break;
        end += host.length - 1;
      } else if (char === ']') break;
      else if (char === '(') parens++;
      else if (char === ')') { if (parens === 0) break; parens--; }
      if ('/?#'.includes(char)) authority = false;
    }
    match[0] = text.slice(match.index, end);
    matches.push(match);
    starts.lastIndex = end;
  }
  return matches;
}

// One alias registry feeds URL, assignment and environment-key screening.
// The legacy subset keeps its historical unfiltered floor; sig is URL-only
// because the existing SAS detector treats it as a URL parameter.
const CREDENTIAL_KEYS = [
  { pattern: String.raw`api[_ -]?key`, legacy: true },
  { pattern: String.raw`access[_ -]?token`, legacy: true },
  { pattern: String.raw`refresh[_ -]?token`, legacy: true },
  { pattern: String.raw`client[_ -]?secret`, legacy: true },
  { pattern: 'password', legacy: true },
  { pattern: String.raw`pass(?:wd|phrase|code)|(?<![a-z])pass|pwd` },
  { pattern: String.raw`secret[_ -]?(?:access[_ -]?)?key(?:[_-]?base)?` },
  { pattern: String.raw`private[_ -]?key` },
  { pattern: 'secret' },
  { pattern: String.raw`token(?!s)` },
  { pattern: 'sig', urlOnly: true },
];
const CREDENTIAL_KEY_WORDS = CREDENTIAL_KEYS.filter(key => !key.urlOnly).map(key => key.pattern).join('|');
const LEGACY_KEY_WORDS = CREDENTIAL_KEYS.filter(key => key.legacy).map(key => key.pattern).join('|');
const CREDENTIAL_QUERY_KEY = new RegExp(`^(?:${CREDENTIAL_KEYS.map(key => key.pattern).join('|')})$`, 'i');

function urlCarriesCredential(candidate: string, userinfoOnly = false): boolean {
  try {
    const url = new URL(candidate);
    const userinfo = canonicalizeScreeningText(url.password);
    if (userinfo && !isPlaceholderValue(userinfo) && !/^(?:pass(?:word)?|secret|user|username|pwd)$/i.test(userinfo)) return true;
    if (userinfoOnly) return false;
    for (const part of [url.search.slice(1), url.hash.slice(1).replace(/^[^?]*\?/, '')]) {
      // Parse the original before decoding: %26 inside a credential is data.
      for (const variant of secretScreeningVariants(part)) {
        for (const [key, value] of new URLSearchParams(variant)) {
          if (CREDENTIAL_QUERY_KEY.test(canonicalizeScreeningText(key))
            && !isPlaceholderValue(canonicalizeScreeningText(value))) return true;
        }
      }
    }
  } catch { /* Not a URL; the other shared patterns still apply. */ }
  return false;
}

/** Shared by body/metadata classification, dispatch, outbound and storage. */
export function hasCredentialUrl(material: string): boolean {
  return secretScreeningVariants(material).some(text =>
    credentialUrlMatches(text).some(match => urlCarriesCredential(match[0])));
}

/** A mask or elision standing in for the real value: `****`, `xxxxx`, `abc...xyz`. */
const MASKED_RUN = /(?:\*{3,}|•{3,}|…|\.{3,}|[xX]{5,})/;
const PLACEHOLDER_WORDS = new RegExp(
  [
    // YOUR_API_KEY, your-token-here, my_secret ...
    String.raw`(?:^|[^a-z])your[_ .-]?[a-z_ -]{0,16}(?:api|secret|token|key|pass|password|client|value|here)`,
    String.raw`(?:^|[^a-z])my[_ .-](?:api|secret|token|key|pass|password|client)`,
    String.raw`(?:^|[^a-z])(?:example|dummy|todo|fixme)(?:[^a-z]|$)`,
    'placeholder', 'redacted', 'changeme', 'change[_-]me', 'replace[_-]?me', 'insert[_-]?(?:your|here|key|token)',
    '[_-]here$', '^n/a$', 'not[_ -]?set', '^unset$',
  ].join('|'),
  'i',
);
const BARE_LITERALS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'string',
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'empty', 'hidden', 'masked', 'required',
  'optional', 'changeme', 'enabled', 'disabled', 'encrypted', 'hashed', 'unknown', 'tbd', 'pending',
  'missing',
]);
/** Where a value is looked up (an environment, a settings object) rather than typed in. */
const CODE_LOOKUP =
  /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|system\.getenv|deno\.env|getenv|environ|env|config|settings|secrets?|self|this|args|opts|options|params|req|request|ctx|vault|input)[.[(]/i;
const CALL_EXPRESSION = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;
/** `user.password`, `req.body.token`: a dotted chain of identifiers. */
const MEMBER_CHAIN = /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)+$/;
/** First or middle segments that make a dotted chain a property lookup, not a passphrase. */
const COMMON_OBJECTS = new Set([
  'user', 'users', 'body', 'data', 'form', 'state', 'props', 'creds', 'credentials', 'account', 'profile',
  'session', 'auth', 'db', 'app', 'json', 'response', 'res', 'row', 'record', 'item', 'model',
]);
const TYPE_ANNOTATION = /^(?:secretstr(?:ing)?|optional[[<]|option<|union[[<]|promise<|record<|array<|string\s*\||[a-z]+\s*\|\s*(?:undefined|null))/i;
/** A bare code identifier: letters, `_` and `$` only, so no digit or symbol that a credential would have. */
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*$/;

/** `value` without trailing code punctuation (`;,)]}`) and sentence dots, in one walk. */
function trimValueEnd(value: string): string {
  let end = value.length;
  while (end > 0 && ';,)]}'.includes(value[end - 1]!)) end -= 1;
  while (end > 0 && value[end - 1] === '.') end -= 1;
  return value.slice(0, end);
}

/** `word` without leading and trailing characters that are not ASCII letters or digits. */
function stripNonAlphanumeric(word: string): string {
  const isAlphanumeric = (code: number): boolean =>
    (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
  const lower = word.toLowerCase();
  let start = 0;
  let end = lower.length;
  while (start < end && !isAlphanumeric(lower.charCodeAt(start))) start += 1;
  while (end > start && !isAlphanumeric(lower.charCodeAt(end - 1))) end -= 1;
  return lower.slice(start, end);
}

function isBareLiteral(value: string): boolean {
  if (value.length > 24) return false;
  let end = value.length;
  while (end > 0 && '.,;'.includes(value[end - 1]!)) end -= 1;
  return BARE_LITERALS.has(value.slice(0, end).toLowerCase());
}

/**
 * `$NAME` is a shell variable, but `$Money2024` is a password that starts with
 * a dollar sign: a bare name counts as a variable when it has an underscore,
 * is all upper case, or is all lower-case letters.
 */
function isVariableReference(value: string): boolean {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(value);
  if (!match) return false;
  const name = match[1]!;
  if (match[2]) return match[2].startsWith('/');
  return name.includes('_')
    || name === name.toUpperCase()
    || (!/[0-9]/.test(name) && name === name.toLowerCase());
}

/**
 * A value that stands in for a credential rather than being one. `lineRest` is
 * the text after the value on the same line: `<your client secret goes here>`
 * reaches this check as `<your`, and the closing `>` is what makes it a
 * placeholder rather than a password that begins with `<`.
 */
export function isPlaceholderValue(value: string, lineRest = ''): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.startsWith('<') && (v.includes('>') || lineRest.includes('>'))) return true;
  if (v.startsWith('(') && (v.includes(')') || lineRest.includes(')'))) return true;
  if (/^[[{].*[\]}]$/.test(v)) return true;
  if (/\$\{|\{\{|<%|%\(|\$\(|^%[A-Za-z_]+%$/.test(v)) return true;
  if (isVariableReference(v)) return true;
  if (MASKED_RUN.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true;
  if (isBareLiteral(v)) return true;
  return PLACEHOLDER_WORDS.test(v);
}

/** `password_confirmation`, `token-value`: a variable or field name that mentions a credential word. */
const CREDENTIAL_WORD = /pass(?:word|wd|phrase|code)|secret|token|api[_-]?key|credential/i;
/** A spaced value that ends in a credential word is a field label: "Confirm password", "enter your secret". */
const CREDENTIAL_NOUN = /^(?:pass(?:word|phrase|code)|passwd|secret|token|credential)s?$/;
const IDENTIFIER_NAME = /^[A-Za-z]+(?:[_-][A-Za-z]+)+$/;

/** A dotted chain that reads as a property lookup: a credential word or a common object in it. */
function isPropertyLookup(value: string): boolean {
  if (!MEMBER_CHAIN.test(value)) return false;
  return value.split('.').some((segment) => CREDENTIAL_WORD.test(segment) || COMMON_OBJECTS.has(segment.toLowerCase()));
}

/** A value that reads as code, a URL or a path rather than a typed-in credential. */
function isNotLiteralCredential(value: string): boolean {
  return CODE_LOOKUP.test(value)
    || (IDENTIFIER_NAME.test(value) && CREDENTIAL_WORD.test(value))
    || CALL_EXPRESSION.test(value)
    || isPropertyLookup(value)
    || TYPE_ANNOTATION.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || /^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(value);
}

/** A digit or a symbol: what separates `s3cr3t-key` from the word "authentication". */
function hasCredentialShape(value: string): boolean {
  return /[0-9]/.test(value) || /[^A-Za-z0-9_.\-\s]/.test(value);
}

/**
 * A spaced value that is plausibly a passphrase: two to fourteen words, none of
 * them instruction vocabulary, and not ending in a credential word ("Password:
 * reset your password at the link", "Confirm password"). Ordinary words are
 * fine: "the horse rides at midnight" is a passphrase.
 */
function isPlausiblePassphrase(value: string, minLength: number): boolean {
  const v = value.trim();
  if (v.length < minLength || v.length > 160) return false;
  if (/[?:]$/.test(v) || /\bhttps?:\/\//i.test(v)) return false;
  if (isPlaceholderValue(v) || isNotLiteralCredential(v)) return false;
  const words = v.split(/\s+/);
  if (words.length < 2 || words.length > 14) return false;
  if (CREDENTIAL_NOUN.test(stripNonAlphanumeric(words[words.length - 1]!))) return false;
  return !words.some((word) => PROSE_WORDS.has(stripNonAlphanumeric(word)));
}

/** A word before "secret" or "token" that makes the key a named credential. */
const STRONG_QUALIFIERS = new Set([
  'client', 'app', 'api', 'access', 'refresh', 'auth', 'bearer', 'id', 'session', 'bot', 'oauth',
  'webhook', 'signing', 'jwt', 'service', 'personal', 'consumer', 'shared', 'encryption', 'master',
  'admin', 'root', 'user', 'db', 'database', 'wifi', 'email', 'login',
]);
/** Tokens that are not credentials: pagination cursors and anti-forgery nonces. */
const NON_CREDENTIAL_TOKEN_PREFIX = /(?:page|sync|cursor|continuation|resume|batch|delta|csrf|xsrf|nonce)[_ .-]?$/i;
/** Declarations and member access: the line is code, so a bare identifier value is a variable. */
const CODE_LEAD =
  /(?:^|[^\w$])(?:const|let|var|val|final|static|public|private|protected|readonly|def)\s+[^=:\n]*$|[\w$]+\.[\w$]*$/;

/** The text on the match's own line before `index`, at most `limit` characters. */
function leadBefore(input: string, index: number, limit: number): string {
  const window = input.slice(Math.max(0, index - limit), index);
  const newline = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('\r'));
  return newline === -1 ? window : window.slice(newline + 1);
}

/** The text after the match on its own line, at most 200 characters. */
function restOfLine(match: RegExpMatchArray): string {
  const input = match.input ?? '';
  const end = (match.index ?? 0) + match[0].length;
  const window = input.slice(end, end + 200);
  const newline = window.search(/[\r\n]/);
  return newline === -1 ? window : window.slice(0, newline);
}

interface AssignedValue {
  value: string;
  quoted: boolean;
  /** Punctuation trimmed off an unquoted value (`;`, `)`, `,` ...). */
  tail: string;
}

function assignedValue(groups: Record<string, string | undefined>): AssignedValue {
  const quotedValue = groups.dq ?? groups.sq ?? groups.bq;
  if (quotedValue !== undefined) return { value: quotedValue.trim(), quoted: true, tail: '' };
  const raw = groups.uv ?? '';
  const value = trimValueEnd(raw).trim();
  return { value, quoted: false, tail: raw.slice(value.length) };
}

/**
 * Code assigning one identifier to another (`const sessionToken =
 * authenticationToken;`): a bare identifier value on a declaration or member
 * access, or closed by `;` / `)` when it is camelCase or snake_case.
 */
function isIdentifierHandOff(match: RegExpMatchArray, assigned: AssignedValue): boolean {
  if (assigned.quoted || !BARE_IDENTIFIER.test(assigned.value)) return false;
  if (CODE_LEAD.test(leadBefore(match.input ?? '', match.index ?? 0, 80))) return true;
  return /[;)]/.test(assigned.tail) && (assigned.value.includes('_') || /[a-z][A-Z]/.test(assigned.value));
}

/** Whether `value` is the whole rest of its line (a trailing comment does not count). */
function endsTheLine(match: RegExpMatchArray): boolean {
  const rest = restOfLine(match).trim();
  return rest === '' || /^(?:#|\/\/|;|--)/.test(rest);
}

function assignmentAccepted(match: RegExpMatchArray): boolean {
  const groups = match.groups ?? {};
  const keyword = (groups.kw ?? '').toLowerCase();
  const assigned = assignedValue(groups);
  const { value, quoted } = assigned;
  if (!value) return false;
  const rest = value.startsWith('<') || value.startsWith('(') ? restOfLine(match) : '';
  if (isPlaceholderValue(value, quoted ? '' : rest) || isNotLiteralCredential(value)) return false;

  const isPassword = keyword.startsWith('pass') || keyword === 'pwd';
  const isSecret = isPassword || keyword.includes('secret');

  // Quoted values with spaces are the only spaced values this pattern sees.
  if (/\s/.test(value)) return isSecret && isPlausiblePassphrase(value, 6);
  // "Password: forgotten?", "Password: Reset!": an instruction word, not a password.
  if (PROSE_WORDS.has(stripNonAlphanumeric(value))) return false;
  if (quoted && isSecret) return value.length >= 6;
  if (isIdentifierHandOff(match, assigned)) return false;

  // Bare "secret" and "token" are ordinary words; a named key (`GITHUB_TOKEN`,
  // `client_secret`, "access token") is a credential outright.
  let strong = true;
  if (keyword === 'secret' || keyword === 'token') {
    const start = match.index ?? 0;
    const lead = (match.input ?? '').slice(Math.max(0, start - 48), start);
    if (keyword === 'token' && NON_CREDENTIAL_TOKEN_PREFIX.test(lead)) return false;
    const attached = /[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(lead);
    if (!attached) {
      const previous = /([A-Za-z]+) $/.exec(lead)?.[1]?.toLowerCase();
      strong = previous !== undefined && STRONG_QUALIFIERS.has(previous);
      // A bare `token=` in a link's query string is a tracking or reset parameter.
      if (!strong && /[?&]$/.test(lead)) return false;
    }
  }

  if (!strong) return value.length >= 12 && hasCredentialShape(value);
  if (value.length >= 12) return true;
  if (value.length >= 8 && hasCredentialShape(value)) return true;
  // A short password after its label on the same line: `password: pancakes`.
  // Not when the line goes on ("Password: security guidelines"); the labelled
  // passphrase pattern reads the whole line then.
  return isPassword
    && !groups.nl
    && value.length >= 6
    && endsTheLine(match);
}

function maskedProviderToken(token: string): boolean {
  const body = token.replace(/^(?:github_pat_|[A-Za-z]+[_-])+/, '');
  return !body || MASKED_RUN.test(body) || /^(.)\1+$/.test(body) || /example|your|placeholder/i.test(body);
}

// --- Environment-style keys ---------------------------------------------------

/** A key name that mentions a credential word anywhere in it: `DB_PASSWORD_PROD`, `Pwd`, `SECRET_KEY`. */
const ENV_KEY_WORDS = CREDENTIAL_KEY_WORDS;
const ENV_CREDENTIAL_KEY = new RegExp(ENV_KEY_WORDS, 'i');
/** Keys that name a property of a credential, not the credential: `TOKEN_TYPE`, `PASSWORD_FILE`. */
const NON_CREDENTIAL_KEY_TAIL =
  /[_.-](?:file|path|dir|url|uri|hash|hashed|salt|type|length|len|ttl|expiry|expires|expiration|policy|field|header|endpoint|name|label|count|size|min|max|regex|pattern|prefix|id)$/i;
/** The camelCase form: `passwordHash`, `tokenType`. */
const NON_CREDENTIAL_CAMEL_TAIL =
  /[a-z](?:File|Path|Dir|Url|Uri|Hash|Hashed|Salt|Type|Length|Ttl|Expiry|Expires|Name|Label|Count|Size|Min|Max|Regex|Pattern|Prefix|Id)$/;

function envAssignmentAccepted(match: RegExpMatchArray): boolean {
  const groups = match.groups ?? {};
  const key = groups.ek ?? '';
  if (!ENV_CREDENTIAL_KEY.test(key)) return false;
  if (NON_CREDENTIAL_KEY_TAIL.test(key) || NON_CREDENTIAL_CAMEL_TAIL.test(key)) return false;
  const assigned = assignedValue(groups);
  const { value, quoted } = assigned;
  if (value.replace(/\s+/g, '').length < 6) return false;
  const rest = value.startsWith('<') || value.startsWith('(') ? restOfLine(match) : '';
  if (isPlaceholderValue(value, quoted ? '' : rest) || isNotLiteralCredential(value)) return false;
  if (/\s/.test(value) && !isPlausiblePassphrase(value, 6)) return false;
  if (!/\s/.test(value) && PROSE_WORDS.has(stripNonAlphanumeric(value))) return false;
  return !isIdentifierHandOff(match, assigned);
}

/** Most following lines, and characters, a block scalar is read across. */
const BLOCK_SCALAR_MAX_LINES = 16;
const BLOCK_SCALAR_WINDOW = 600;
/** A comment-looking line (`# note`, a bare `#`); `#Sunrise42!` is data. */
const COMMENT_LINE = /^#(?:\s|$)/;

/**
 * The lines of a block scalar: the first one the pattern matched, then every
 * following line indented deeper than the key (blank lines skipped), at most
 * `BLOCK_SCALAR_MAX_LINES` of them inside a `BLOCK_SCALAR_WINDOW`-character
 * window, so the read is bounded however long the document is. Comment-looking
 * lines are dropped; a `#` glued to text is data.
 */
function blockScalarLines(match: RegExpMatchArray, keyIndent: number): string[] {
  const lines = [(match.groups?.bv ?? '').trim()];
  const input = match.input ?? '';
  const end = (match.index ?? 0) + match[0].length;
  const following = input.slice(end, end + BLOCK_SCALAR_WINDOW).split(/\r?\n/);
  // The first piece is the rest of the matched line (empty: the match ran to its end).
  for (let i = 1; i < following.length && lines.length < BLOCK_SCALAR_MAX_LINES; i += 1) {
    const line = following[i]!;
    const text = line.trim();
    if (!text) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= keyIndent) break;
    lines.push(text);
  }
  return lines.filter((line) => line && !COMMENT_LINE.test(line));
}

/** The value of a YAML block scalar: `password: |` followed by lines indented under the key. */
function blockScalarAccepted(match: RegExpMatchArray): boolean {
  const groups = match.groups ?? {};
  const keyword = (groups.kw ?? '').toLowerCase();
  const keyLead = leadBefore(match.input ?? '', match.index ?? 0, 200);
  const keyIndent = (/^[ \t]*/.exec(keyLead)?.[0] ?? '').length;
  if ((groups.ind ?? '').length <= keyIndent) return false;
  const isSecret = keyword.startsWith('pass') || keyword === 'pwd' || keyword.includes('secret');
  const judge = (value: string): boolean => {
    if (!value || isPlaceholderValue(value) || isNotLiteralCredential(value)) return false;
    if (/\s/.test(value)) return isSecret && isPlausiblePassphrase(value, 6);
    if (PROSE_WORDS.has(stripNonAlphanumeric(value))) return false;
    return value.length >= (isSecret ? 6 : 8);
  };
  const lines = blockScalarLines(match, keyIndent);
  if (lines.length === 0) return false;
  // The first line alone, then the whole scalar read as one folded value
  // (`>-` over `blue` and `cat` is "blue cat").
  if (judge(lines[0]!)) return true;
  return lines.length > 1 && judge(lines.join(' '));
}

// --- Assignment shapes --------------------------------------------------------

const KEYWORD = `(?<kw>${CREDENTIAL_KEY_WORDS})`;
/** Optional closing quote or markdown emphasis, then the separator and its padding. */
const SEPARATOR = String.raw`["'\x60*_]{0,3}[ \t]*(?::=|=>|[:=])[*_]{0,2}[ \t]*(?<nl>\r?\n[ \t]*)?`;
const VALUE = String.raw`(?:"(?<dq>(?:[^"\\\n\r]|\\.)*)"|'(?<sq>(?:[^'\\\n\r]|\\.)*)'|\x60(?<bq>[^\x60\n\r]*)\x60|(?<uv>[^\s"'\x60]+))`;

/**
 * A credential keyword assigned a value, in any of: `KEY=value`,
 * `DB_PASSWORD=value`, `"client_secret": "value"`, `password: value`,
 * `Password = "value"`. The keyword may carry any prefix (`STRIPE_API_KEY`,
 * `clientSecret`, `x-api-key`) but must END the key, so `password_hash` and
 * `max_tokens` never match.
 */
const CREDENTIAL_ASSIGNMENT = new RegExp(`${KEYWORD}${SEPARATOR}${VALUE}`, 'gi');

/**
 * `KEY=value` where the key merely CONTAINS a credential word: `DB_PASSWORD_PROD=`,
 * `Pwd=` in a connection string, `spring.datasource.password=`. Only keys that
 * mention a credential word match at all, so `Id=app;Pwd=...` is not swallowed
 * by the unquoted value of an earlier, harmless pair. The key is one plain run
 * of key characters and the start is anchored by the lookbehind, so a long run
 * costs one pass. Not inside a link's query string (`?token=`), and `==`, `=~`
 * and `=>` never count.
 */
const ENV_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_.?&/%+=-])(?=(?:--)?[A-Za-z0-9_.-]*?(?:${ENV_KEY_WORDS}))(?<ek>(?:--)?[A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=(?![=~>])[ \t]*${VALUE}`,
  'gi',
);

/**
 * A YAML block scalar: `password: |-` (also `|`, `>`, `>-`, `|+`, with an
 * indentation indicator or a trailing comment) whose value is the next
 * indented line.
 */
const BLOCK_SCALAR = new RegExp(
  String.raw`${KEYWORD}["'\x60]{0,2}[ \t]*:[ \t]*[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*(?:#[^\r\n]*)?\r?\n(?:[ \t]*\r?\n)*(?<ind>[ \t]+)(?<bv>[^ \t\r\n][^\r\n]*)`,
  'gi',
);

/**
 * `Password: correct horse battery staple`: a labelled passphrase with spaces,
 * at the start of a line so a sentence mentioning a password never matches.
 */
const LABELLED_PASSPHRASE = new RegExp(
  String.raw`^[ \t>*•-]*(?:[A-Za-z0-9 _.-]{0,30}?)pass(?:word|phrase|code)["'\x60*_]{0,3}[ \t]*(?::=|[:=])[*_]{0,2}[ \t]*(?<mv>[^\s][^\n\r]{5,159})$`,
  'gim',
);

/** `scheme://user:password@host` connection strings. */
const URL_USERINFO = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:(?<pw>[^\s/@"'<>]+)@/gi;

/** `Authorization: Bearer <value>` (also Basic and Token). */
const AUTHORIZATION_HEADER =
  /\bauthorization["'`]?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)[ \t]+(?<tok>[\w.~+/=-]{16,})/gi;

/** Azure storage, Service Bus, Event Hubs and Cosmos connection strings carry the key as base64. */
const AZURE_KEY =
  /(?<![A-Za-z0-9])(?:AccountKey|SharedAccessKey)[ \t]*=[ \t]*["']?(?<key>[A-Za-z0-9+/]{40,}={0,2})/gi;
/** The `sig` of a shared access signature in a URL query (`?sv=...&sig=...`, or `&amp;sig=` in HTML). */
const AZURE_SAS_SIGNATURE = /(?<=[?&;])sig=(?<sig>[A-Za-z0-9%+/_-]{30,}={0,3})/gi;

/**
 * The assignment shape the floor had before the shared patterns, kept verbatim
 * and unfiltered. The filters above cut false positives from the NEW shapes;
 * this one is the floor's recall guarantee: every string it ever matched still
 * is Secrets outside parsed URL parameters (test/content-policy-secrets.test.ts
 * replays it over the corpus). URL placeholders use the shared exclusion policy.
 */
const LEGACY_CREDENTIAL_ASSIGNMENT =
  new RegExp(String.raw`\b(${LEGACY_KEY_WORDS})\b\s*[:=]\s*['"]?[^'"\s]{12,}`, 'gi');

export const SHARED_SECRET_PATTERNS: readonly SharedSecretPattern[] = [
  {
    findingType: 'credential_assignment', label: 'credential_url', confidence: 0.9,
    pattern: URL_SCHEME, extract: credentialUrlMatches, accept: match => urlCarriesCredential(match[0]),
  },
  {
    findingType: 'private_key_material',
    label: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    confidence: 1,
  },
  {
    findingType: 'aws_access_key_id',
    label: 'aws_access_key_id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    confidence: 0.98,
  },
  {
    findingType: 'slack_token',
    label: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    confidence: 0.98,
  },
  {
    // OpenAI and Anthropic (`sk-ant-...`) style keys.
    findingType: 'api_secret_token',
    label: 'openai_key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    confidence: 0.95,
  },
  {
    // GitHub: personal, OAuth, user-to-server, server-to-server, refresh and fine-grained tokens.
    findingType: 'api_secret_token',
    label: 'github_token',
    pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
    confidence: 0.97,
    accept: (match) => !maskedProviderToken(match[0]),
  },
  {
    // Stripe live secret and restricted keys, and webhook signing secrets.
    findingType: 'api_secret_token',
    label: 'stripe_key',
    pattern: /(?<![A-Za-z0-9])(?:(?:sk|rk)_live_|whsec_)[A-Za-z0-9]{16,}/g,
    confidence: 0.97,
    accept: (match) => !maskedProviderToken(match[0]),
  },
  {
    findingType: 'api_secret_token',
    label: 'google_api_key',
    pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
    confidence: 0.95,
    accept: (match) => !maskedProviderToken(match[0]),
  },
  {
    // Google OAuth client secret.
    findingType: 'api_secret_token',
    label: 'google_oauth_client_secret',
    pattern: /(?<![A-Za-z0-9])GOCSPX-[A-Za-z0-9_-]{20,}/g,
    confidence: 0.97,
    accept: (match) => !maskedProviderToken(match[0]),
  },
  {
    // Google OAuth refresh token and access token.
    findingType: 'api_secret_token',
    label: 'google_oauth_token',
    pattern: /(?<![A-Za-z0-9/])(?:1\/\/0[A-Za-z0-9_-]{30,}|ya29\.[A-Za-z0-9_-]{20,})/g,
    confidence: 0.95,
    accept: (match) => !maskedProviderToken(match[0]),
  },
  {
    findingType: 'credential_assignment',
    label: 'credential_assignment',
    pattern: LEGACY_CREDENTIAL_ASSIGNMENT,
    confidence: 0.9,
  },
  {
    findingType: 'credential_assignment',
    label: 'credential_assignment',
    pattern: CREDENTIAL_ASSIGNMENT,
    confidence: 0.9,
    accept: assignmentAccepted,
  },
  {
    findingType: 'credential_assignment',
    label: 'credential_assignment',
    pattern: ENV_ASSIGNMENT,
    confidence: 0.85,
    accept: envAssignmentAccepted,
  },
  {
    findingType: 'credential_assignment',
    label: 'credential_assignment',
    pattern: BLOCK_SCALAR,
    confidence: 0.85,
    accept: blockScalarAccepted,
  },
  {
    findingType: 'credential_assignment',
    label: 'password',
    pattern: LABELLED_PASSPHRASE,
    confidence: 0.85,
    accept: (match) => isPlausiblePassphrase(match.groups?.mv ?? '', 6),
  },
  {
    findingType: 'credential_assignment',
    label: 'credential_url',
    pattern: URL_USERINFO,
    confidence: 0.9,
    accept: (match) => {
      const password = canonicalizeScreeningText(match.groups?.pw ?? '');
      return !isPlaceholderValue(password) && !/^(?:pass(?:word)?|secret|user|username|pwd)$/i.test(password);
    },
  },
  {
    findingType: 'credential_assignment',
    label: 'authorization_header',
    pattern: AUTHORIZATION_HEADER,
    confidence: 0.9,
    accept: (match) => !isPlaceholderValue(match.groups?.tok ?? ''),
  },
  {
    // Azure storage, Service Bus, Event Hubs and Cosmos DB keys.
    findingType: 'api_secret_token',
    label: 'azure_key',
    pattern: AZURE_KEY,
    confidence: 0.95,
    accept: (match) => !isPlaceholderValue(match.groups?.key ?? ''),
  },
  {
    // Azure shared access signature: whoever holds the URL holds the access.
    findingType: 'api_secret_token',
    label: 'azure_sas_signature',
    pattern: AZURE_SAS_SIGNATURE,
    confidence: 0.9,
    accept: (match) => !isPlaceholderValue(match.groups?.sig ?? ''),
  },
];
