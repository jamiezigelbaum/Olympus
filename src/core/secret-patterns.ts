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
// content can go to cloud models by design, so a miss leaks a credential. The
// patterns therefore lean toward catching, and `accept` is where the false
// positives are cut: documentation placeholders, masks, environment lookups,
// type annotations, empty values and prose never count.

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
  /** Cuts false positives after the regex matches. Absent means every match counts. */
  readonly accept?: (match: RegExpMatchArray) => boolean;
}

/** Every accepted hit of `spec` in `text`. */
export function secretPatternHits(text: string, spec: SharedSecretPattern): RegExpMatchArray[] {
  spec.pattern.lastIndex = 0;
  const hits: RegExpMatchArray[] = [];
  for (const match of text.matchAll(spec.pattern)) {
    if (!match[0]?.trim()) continue;
    if (spec.accept && !spec.accept(match)) continue;
    hits.push(match);
  }
  return hits;
}

/** Whether `spec` has at least one accepted hit in `text`. */
export function hasSecretPatternHit(text: string, spec: SharedSecretPattern): boolean {
  spec.pattern.lastIndex = 0;
  for (const match of text.matchAll(spec.pattern)) {
    if (!match[0]?.trim()) continue;
    if (!spec.accept || spec.accept(match)) return true;
  }
  return false;
}

// --- Value checks -------------------------------------------------------------

/** Words that make a "Password: ..." value prose rather than a passphrase. */
const PROSE_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'below', 'by', 'can', 'cannot', 'change', 'changed', 'characters',
  'choose', 'click', 'contact', 'could', 'do', 'does', 'enter', 'expired', 'expires', 'for', 'forgot',
  'forgotten', 'from', 'get', 'has', 'have', 'here', 'hidden', 'how', 'if', 'in', 'incorrect', 'invalid',
  'is', 'it', 'its', 'least', 'letters', 'link', 'long', 'manager', 'maximum', 'min', 'minimum', 'must',
  'my', 'need', 'needed', 'needs', 'new', 'no', 'not', 'number', 'numbers', 'of', 'on', 'only', 'optional',
  'or', 'our', 'please', 'provide', 'provided', 'protected', 'required', 'requirements', 'reset', 'see',
  'send', 'sent', 'set', 'shared', 'should', 'shown', 'sign', 'so', 'symbols', 'that', 'the', 'their',
  'then', 'these', 'this', 'those', 'to', 'type', 'unchanged', 'until', 'up', 'use', 'used', 'using',
  'via', 'was', 'we', 'when', 'where', 'which', 'will', 'with', 'without', 'would', 'you', 'your',
]);

/** A mask or elision standing in for the real value: `****`, `xxxxx`, `abc...xyz`. */
const MASKED_RUN = /(?:\*{3,}|•{3,}|…|\.{3,}|[xX]{5,})/;
const PLACEHOLDER_WORDS = new RegExp(
  [
    // YOUR_API_KEY, your-token-here, my_secret ...
    String.raw`(?:^|[^a-z])your[_ .-]?[a-z_ -]{0,16}(?:api|secret|token|key|pass|password|client|value|here)`,
    String.raw`(?:^|[^a-z])my[_ .-](?:api|secret|token|key|pass|password|client)`,
    String.raw`(?:^|[^a-z])(?:example|dummy|todo|fixme)(?:[^a-z]|$)`,
    'placeholder', 'redacted', 'changeme', 'change[_-]me', 'replace[_-]?me', 'insert[_-]?(?:your|here|key|token)',
    '[_-]here$', '^n/a$', 'not[_-]?set', '^unset$',
  ].join('|'),
  'i',
);
const BARE_LITERALS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'string',
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'empty', 'hidden', 'masked', 'required',
  'optional', 'changeme',
]);
/** Where a value is looked up (an environment, a settings object) rather than typed in. */
const CODE_LOOKUP =
  /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|system\.getenv|deno\.env|getenv|environ|env|config|settings|secrets?|self|this|args|opts|options|params|req|request|ctx|vault|input)[.[(]/i;
const CALL_EXPRESSION = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;
/** `user.password`, `req.body.token`: a property chain with no digit in it. */
const MEMBER_CHAIN = /^[A-Za-z_$][A-Za-z_$]*(?:\.[A-Za-z_$][A-Za-z_$]*)+$/;
const TYPE_ANNOTATION = /^(?:secretstr(?:ing)?|optional[[<]|option<|union[[<]|promise<|record<|array<|string\s*\||[a-z]+\s*\|\s*(?:undefined|null))/i;

/** A value that stands in for a credential rather than being one. */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v.startsWith('<') || v.startsWith('(') || /^[[{].*[\]}]$/.test(v)) return true;
  if (/\$\{|\{\{|<%|%\(|\$\(|^\$[A-Za-z_]|^%[A-Za-z_]+%$|^@/.test(v)) return true;
  if (MASKED_RUN.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true;
  if (BARE_LITERALS.has(v.toLowerCase().replace(/[.,;]+$/, ''))) return true;
  return PLACEHOLDER_WORDS.test(v);
}

/** `password_confirmation`, `token-value`: a variable or field name that mentions a credential word. */
const CREDENTIAL_WORD = /pass(?:word|wd|phrase|code)|secret|token|api[_-]?key|credential/i;
const IDENTIFIER_NAME = /^[A-Za-z]+(?:[_-][A-Za-z]+)+$/;

/** A value that reads as code, a URL or a path rather than a typed-in credential. */
function isNotLiteralCredential(value: string): boolean {
  return CODE_LOOKUP.test(value)
    || (IDENTIFIER_NAME.test(value) && CREDENTIAL_WORD.test(value))
    || CALL_EXPRESSION.test(value)
    || MEMBER_CHAIN.test(value)
    || TYPE_ANNOTATION.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || /^(?:\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(value);
}

function trimValueEnd(value: string): string {
  return value.replace(/[;,)\]}]+$/, '').replace(/\.+$/, '');
}

/** A digit or a symbol: what separates `s3cr3t-key` from the word "authentication". */
function hasCredentialShape(value: string): boolean {
  return /[0-9]/.test(value) || /[^A-Za-z0-9_.\-\s]/.test(value);
}

/**
 * A multi-word value that is plausibly a passphrase: two to ten words, none of
 * which is ordinary prose glue ("Password: reset your password at the link").
 */
function isPlausiblePassphrase(value: string): boolean {
  const v = value.trim();
  if (v.length < 12 || v.length > 120) return false;
  if (/[?:]$/.test(v) || /\bhttps?:\/\//i.test(v)) return false;
  if (isPlaceholderValue(v) || isNotLiteralCredential(v)) return false;
  const words = v.split(/\s+/);
  if (words.length < 2 || words.length > 10) return false;
  return !words.some((word) => PROSE_WORDS.has(word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')));
}

/** A word before "secret" or "token" that makes the key a named credential. */
const STRONG_QUALIFIERS = new Set([
  'client', 'app', 'api', 'access', 'refresh', 'auth', 'bearer', 'id', 'session', 'bot', 'oauth',
  'webhook', 'signing', 'jwt', 'service', 'personal', 'consumer', 'shared', 'encryption', 'master',
  'admin', 'root', 'user', 'db', 'database', 'wifi', 'email', 'login',
]);
/** Tokens that are not credentials: pagination cursors and anti-forgery nonces. */
const NON_CREDENTIAL_TOKEN_PREFIX = /(?:page|sync|cursor|continuation|resume|batch|delta|csrf|xsrf|nonce)[_ .-]?$/i;

function assignmentAccepted(match: RegExpMatchArray): boolean {
  const groups = match.groups ?? {};
  const keyword = (groups.kw ?? '').toLowerCase();
  const quotedValue = groups.dq ?? groups.sq ?? groups.bq;
  const value = (quotedValue !== undefined ? quotedValue : trimValueEnd(groups.uv ?? '')).trim();
  if (!value) return false;
  if (isPlaceholderValue(value) || isNotLiteralCredential(value)) return false;

  const isPassword = keyword.startsWith('pass');
  if (/\s/.test(value)) return isPassword && isPlausiblePassphrase(value);

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
  return value.length >= 8 && hasCredentialShape(value);
}

function maskedProviderToken(token: string): boolean {
  const body = token.replace(/^(?:github_pat_|[A-Za-z]+[_-])+/, '');
  return !body || MASKED_RUN.test(body) || /^(.)\1+$/.test(body) || /example|your|placeholder/i.test(body);
}

// --- Assignment shapes --------------------------------------------------------

const KEYWORD = String.raw`(?<kw>pass(?:word|wd|phrase|code)|secret[_ -]?(?:access[_ -]?)?key(?:[_-]?base)?|api[_ -]?key|private[_ -]?key|secret|token)`;
/** Optional closing quote or markdown emphasis, then the separator and its padding. */
const SEPARATOR = String.raw`["'\x60*_]{0,3}[ \t]*(?::=|=>|[:=])[*_]{0,2}[ \t]*(?:\r?\n[ \t]*)?`;
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
 * `Password: correct horse battery staple`: a labelled passphrase with spaces,
 * at the start of a line so a sentence mentioning a password never matches.
 */
const LABELLED_PASSPHRASE = new RegExp(
  String.raw`^[ \t>*•-]*(?:[A-Za-z0-9 _.-]{0,30}?)pass(?:word|phrase|code)["'\x60*_]{0,3}[ \t]*(?::=|[:=])[*_]{0,2}[ \t]*(?<mv>[^\n\r]{12,160})$`,
  'gim',
);

/** `scheme://user:password@host` connection strings. */
const URL_USERINFO = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{1,15}:\/\/[^\s:/@"'<>]+:(?<pw>[^\s/@"'<>]{6,})@/gi;

/** `Authorization: Bearer <value>` (also Basic and Token). */
const AUTHORIZATION_HEADER =
  /\bauthorization["'`]?[ \t]*[:=][ \t]*["']?(?:bearer|basic|token)[ \t]+(?<tok>[\w.~+/=-]{16,})/gi;

export const SHARED_SECRET_PATTERNS: readonly SharedSecretPattern[] = [
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
    pattern: CREDENTIAL_ASSIGNMENT,
    confidence: 0.9,
    accept: assignmentAccepted,
  },
  {
    findingType: 'credential_assignment',
    label: 'password',
    pattern: LABELLED_PASSPHRASE,
    confidence: 0.85,
    accept: (match) => isPlausiblePassphrase(match.groups?.mv ?? ''),
  },
  {
    findingType: 'credential_assignment',
    label: 'credential_url',
    pattern: URL_USERINFO,
    confidence: 0.9,
    accept: (match) => {
      const password = match.groups?.pw ?? '';
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
];
