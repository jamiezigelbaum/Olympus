// Owner sender rules ("always Private", "skip", and owner tier rules of kind
// `sender`) matched against a From header. The one sender matcher: the mail
// scope, the shared tier classifier and store placement all call it.
//
// A rule is an address (`name@example.com`) or a whole domain (`@example.com`).
// Both are matched against the ACTUAL sender address only — the address in
// angle brackets, or the bare address — never an address that appears inside
// a display name (`"boss@work.example" <spam@evil.example>` is from
// evil.example). A domain rule covers the domain and every subdomain, on a
// label boundary: `@therapist.example` matches `appointments@therapist.example`
// and `appointments@mail.therapist.example`, never `x@evil-therapist.example`.
// That is the reading Gmail's `from:therapist.example` gives the skip list's
// query, so the query and the post-fetch check agree.
//
// A rule with no `@` (a bare fragment such as `clinic`) is the long-standing
// substring form. It is honoured ONLY for rules that raise an item's tier, and
// only raising rules fall back to every address in a header whose sender
// cannot be read: matching wider can only make more mail Private, never less.
// A skip rule never falls back, so unattributable mail is never skipped.

/**
 * Longest From header anything here will look at. Gmail hands the header over
 * uncapped and it is sender-controlled; every parse below is linear, and this
 * cap bounds the constant. A longer header is treated as unparseable (raising
 * rules then scan only this prefix; skip rules never match it).
 */
export const MAX_FROM_HEADER_CHARS = 4_096;

const LOCAL_CHAR = /[^\s<>"(),;:@[\]\\]/;
const DOMAIN_CHAR = /[a-z0-9.-]/i;

type Address = { address: string; domain: string };

/** A dotted domain with non-empty labels, lower-cased; undefined otherwise. */
function validDomain(raw: string): string | undefined {
  const domain = raw.toLowerCase().replace(/[.-]+$/, '');
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return undefined;
  return domain;
}

/**
 * Strip RFC 5322 comments — `(...)`, nested, outside quoted strings — and
 * report the header's structure in the same single pass: how many angle
 * brackets open and whether a comma separates mailboxes (outside quotes and
 * comments). Linear.
 */
function scanHeader(value: string): { text: string; angleOpens: number; comma: boolean } {
  let out = '';
  let depth = 0;
  let quoted = false;
  let angleOpens = 0;
  let comma = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '\\' && index + 1 < value.length) {
      if (depth === 0) out += char + value[index + 1]!;
      index += 1;
      continue;
    }
    if (depth === 0 && char === '"') quoted = !quoted;
    if (!quoted && char === '(') { depth += 1; continue; }
    if (!quoted && char === ')' && depth > 0) { depth -= 1; continue; }
    if (depth > 0) continue;
    if (!quoted && char === '<') angleOpens += 1;
    if (!quoted && char === ',') comma = true;
    out += char;
  }
  return { text: out, angleOpens, comma };
}

/** One addr-spec (`local@domain`, local may be quoted), exactly; linear. */
function parseAddrSpec(value: string): Address | undefined {
  const spec = value.trim();
  let local: string;
  let rest: string;
  if (spec.startsWith('"')) {
    let index = 1;
    while (index < spec.length && spec[index] !== '"') index += spec[index] === '\\' ? 2 : 1;
    if (index >= spec.length || spec[index + 1] !== '@') return undefined;
    local = spec.slice(0, index + 1);
    rest = spec.slice(index + 2);
  } else {
    const at = spec.indexOf('@');
    if (at <= 0) return undefined;
    local = spec.slice(0, at);
    rest = spec.slice(at + 1);
    for (const char of local) if (!LOCAL_CHAR.test(char)) return undefined;
  }
  for (const char of rest) if (!DOMAIN_CHAR.test(char)) return undefined;
  const domain = validDomain(rest);
  if (!domain || domain !== rest.toLowerCase()) return undefined;
  return { address: `${local.toLowerCase()}@${domain}`, domain };
}

/**
 * The sender's own address (lower-cased), or undefined when it cannot be read
 * confidently: more than 4 KB, more than one mailbox (two angle-bracketed
 * addresses, or a comma outside quotes and comments), or no single valid
 * address. Handles `addr`, `Name <addr>`, `"Quoted, Name" <addr>`,
 * `addr (comment)`, `Name (comment) <addr>` and quoted local parts. Linear.
 */
export function senderAddress(from: string | undefined): Address | undefined {
  if (!from || from.length > MAX_FROM_HEADER_CHARS) return undefined;
  const scanned = scanHeader(from);
  if (scanned.angleOpens > 1 || scanned.comma) return undefined;
  if (scanned.angleOpens === 1) {
    const open = scanned.text.indexOf('<');
    const close = scanned.text.indexOf('>', open + 1);
    if (close < 0 || scanned.text.slice(close + 1).trim() !== '') return undefined;
    return parseAddrSpec(scanned.text.slice(open + 1, close));
  }
  return parseAddrSpec(scanned.text);
}

/**
 * Every plain `local@domain` anywhere in the first 4 KB of the header,
 * comments and display names included. A linear tokenizer, not a pattern:
 * from each `@` it walks left over local-part characters (which stop at the
 * previous `@`) and right over domain characters, so every character is
 * visited a bounded number of times.
 */
function everyAddressIn(from: string | undefined): Address[] {
  if (!from) return [];
  const text = from.slice(0, MAX_FROM_HEADER_CHARS);
  const found: Address[] = [];
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    let start = at;
    while (start > 0 && LOCAL_CHAR.test(text[start - 1]!)) start -= 1;
    let end = at + 1;
    while (end < text.length && DOMAIN_CHAR.test(text[end]!)) end += 1;
    if (start === at) continue;
    const domain = validDomain(text.slice(at + 1, end));
    if (domain) found.push({ address: `${text.slice(start, at).toLowerCase()}@${domain}`, domain });
  }
  return found;
}

function addressMatches(sender: { address: string; domain: string }, normalizedRule: string): boolean {
  if (normalizedRule.startsWith('@')) {
    const domain = normalizedRule.slice(1);
    return domain !== '' && (sender.domain === domain || sender.domain.endsWith(`.${domain}`));
  }
  return sender.address === normalizedRule;
}

/**
 * True when the sender's own address falls under an address or `@domain` rule.
 * No fallback: a sender that cannot be read is never matched, so a skip rule
 * never drops mail it cannot attribute.
 */
export function senderMatchesRule(from: string | undefined, rule: string): boolean {
  const normalized = rule.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  const sender = senderAddress(from);
  return sender !== undefined && addressMatches(sender, normalized);
}

/**
 * An owner sender rule. Address and `@domain` values match the sender's own
 * address; a bare fragment matches by substring. A RAISING rule errs wide:
 * a bare fragment is honoured, and when the sender cannot be read confidently
 * every address anywhere in the header is tried. A non-raising rule gets
 * neither.
 */
export function ownerSenderRuleMatches(from: string | undefined, value: string, raises: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (!normalized.includes('@')) return raises && (from ?? '').slice(0, MAX_FROM_HEADER_CHARS).toLowerCase().includes(normalized);
  const sender = senderAddress(from);
  if (sender) return addressMatches(sender, normalized);
  return raises && everyAddressIn(from).some((candidate) => addressMatches(candidate, normalized));
}
