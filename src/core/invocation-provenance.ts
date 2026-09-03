// Who initiated a source run, in a form every lane can read.
//
// Usage budgets in this repo are Olympus's OWN artificial constraint on
// provider spend, and they gate ROUTINE (scheduled) operations only: an
// operator/dev-initiated run is never refused by them (owner ruling
// 2026-08-19). The ruling is source-neutral, so the vocabulary is too — a
// per-lane copy of this union is how the exemption would drift between
// sources.
//
// Two rules hold everywhere this type travels:
//
//  - Fail closed. Anything that is not the exact literal 'operator' is
//    'scheduled', including undefined, a stray string, and any value that
//    crossed a JSON boundary. Nothing can be laundered into an exemption by
//    being unparseable.
//  - Exempt from OUR budgets, never from the PROVIDER's. A provider's own
//    refusal (a 429, an exhausted quota) binds every provenance; waiving it
//    would be waiving someone else's constraint. Usage is still recorded
//    truthfully under either provenance, so the next scheduled run is guarded
//    against what an operator run actually spent.

export type SourceInvocationProvenance = 'scheduled' | 'operator';

/**
 * Normalizes any value to a provenance, failing closed to 'scheduled'.
 *
 * `unknown` rather than the union deliberately: the callers are HTTP request
 * bodies, scheduler contexts, and durable rows, and a type-level promise is not
 * a runtime one on any of them.
 */
export function sourceInvocationProvenance(value: unknown): SourceInvocationProvenance {
  return value === 'operator' ? 'operator' : 'scheduled';
}
