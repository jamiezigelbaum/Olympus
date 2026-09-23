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
// substring form. It is honoured ONLY for rules that raise an item's tier:
// matching wider can only make more mail Private, never less.

const ADDRESS = /^([^\s<>"(),;:@]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/** The sender's own address (lower-cased), or undefined when there is none. */
export function senderAddress(from: string | undefined): { address: string; domain: string } | undefined {
  if (!from) return undefined;
  const bracketed = [...from.matchAll(/<([^<>]*)>/g)].at(-1)?.[1];
  const candidate = (bracketed ?? from).trim();
  const match = ADDRESS.exec(candidate);
  if (!match) return undefined;
  return { address: `${match[1]!.toLowerCase()}@${match[2]!.toLowerCase()}`, domain: match[2]!.toLowerCase() };
}

/** True when the sender's own address falls under an address or `@domain` rule. */
export function senderMatchesRule(from: string | undefined, rule: string): boolean {
  const normalized = rule.trim().toLowerCase();
  if (!normalized.includes('@')) return false;
  const sender = senderAddress(from);
  if (!sender) return false;
  if (normalized.startsWith('@')) {
    const domain = normalized.slice(1);
    return domain !== '' && (sender.domain === domain || sender.domain.endsWith(`.${domain}`));
  }
  return sender.address === normalized;
}

/**
 * An owner sender rule: address and `@domain` values through the boundary
 * matcher; a bare fragment by substring, and only when the rule raises.
 */
export function ownerSenderRuleMatches(from: string | undefined, value: string, raises: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('@')) return senderMatchesRule(from, normalized);
  return raises && (from ?? '').toLowerCase().includes(normalized);
}
