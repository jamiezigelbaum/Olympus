// Owner sender rules ("always Private", "skip") matched against a From
// header. A rule is an address (`name@example.com`) or a whole domain
// (`@example.com`). A domain rule covers the domain and every subdomain, on a
// label boundary: `@therapist.example` matches `appointments@therapist.example`
// and `appointments@mail.therapist.example`, never `x@evil-therapist.example`.
// That is the reading Gmail's `from:therapist.example` gives the skip list's
// query, so the query and the post-fetch check agree.

const ADDRESS = /([^\s<>"(),;:@]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

/** Every address in a From header, lower-cased. */
export function senderAddresses(from: string | undefined): Array<{ address: string; domain: string }> {
  if (!from) return [];
  return [...from.matchAll(ADDRESS)].map((match) => ({
    address: `${match[1]!.toLowerCase()}@${match[2]!.toLowerCase()}`,
    domain: match[2]!.toLowerCase(),
  }));
}

/** True when any address in `from` falls under `rule`. */
export function senderMatchesRule(from: string | undefined, rule: string): boolean {
  const normalized = rule.trim().toLowerCase();
  if (!normalized) return false;
  const addresses = senderAddresses(from);
  if (normalized.startsWith('@')) {
    const domain = normalized.slice(1);
    return domain !== '' && addresses.some((entry) => entry.domain === domain || entry.domain.endsWith(`.${domain}`));
  }
  return addresses.some((entry) => entry.address === normalized);
}
