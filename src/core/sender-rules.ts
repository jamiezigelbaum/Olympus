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

// Local part: a dot-atom or an RFC 5322 quoted string; domain: dotted labels.
const ADDRESS = /^((?:"(?:[^"\\]|\\.)*")|(?:[^\s<>"(),;:@]+))@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;
const ANY_ADDRESS = /((?:"(?:[^"\\]|\\.)*")|(?:[^\s<>"(),;:@]+))@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/**
 * Remove RFC 5322 comments — `(...)`, nested, outside quoted strings — so
 * `dr@therapist.example (Dr T)` reads as its address.
 */
function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
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
    if (depth === 0) out += char;
  }
  return out;
}

/**
 * The sender's own address (lower-cased), or undefined when it cannot be read
 * confidently. Handles `addr`, `Name <addr>`, `"Quoted, Name" <addr>`,
 * `addr (comment)`, `Name (comment) <addr>` and quoted local parts.
 */
export function senderAddress(from: string | undefined): { address: string; domain: string } | undefined {
  if (!from) return undefined;
  const cleaned = stripComments(from);
  const bracketed = [...cleaned.matchAll(/<([^<>]*)>/g)].at(-1)?.[1];
  const candidate = (bracketed ?? cleaned).trim();
  const match = ADDRESS.exec(candidate);
  if (!match) return undefined;
  return { address: `${match[1]!.toLowerCase()}@${match[2]!.toLowerCase()}`, domain: match[2]!.toLowerCase() };
}

/** Every address-shaped string anywhere in the header, comments included. */
function everyAddressIn(from: string | undefined): Array<{ address: string; domain: string }> {
  if (!from) return [];
  return [...from.matchAll(ANY_ADDRESS)].map((match) => ({
    address: `${match[1]!.toLowerCase()}@${match[2]!.toLowerCase()}`,
    domain: match[2]!.toLowerCase(),
  }));
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
  if (!normalized.includes('@')) return raises && (from ?? '').toLowerCase().includes(normalized);
  const sender = senderAddress(from);
  if (sender) return addressMatches(sender, normalized);
  return raises && everyAddressIn(from).some((candidate) => addressMatches(candidate, normalized));
}
