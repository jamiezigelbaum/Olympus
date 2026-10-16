// Small helpers connectors use to publish SourceClassificationSignals
// (SourceConnector 2.0.0). They read provider metadata a connector already
// holds; they decide nothing. The tier decision is the shared classifier's.

import type {
  RawItem,
  SourceClassificationPrior,
  SourceClassificationSignals,
  SourceConversationKind,
} from './contracts.ts';
import type { SourceTrustDomain } from './source-index/types.ts';

/**
 * `RawItem.metadata` key a connector sets, to `CONTENT_SCOPE_NAMES_ONLY`, on an
 * item it lists by name only because the OWNER's scope keeps its content
 * unread (mail older than the approved window). It is a fact about the item,
 * not a tier: the shared classifier then decides the names and settles the
 * content layer as "no content" instead of waiting for text that never comes.
 * The key lives in the item's metadata, not in `SourceClassificationSignals`,
 * so the stable connector contract keeps its shape.
 */
export const CONTENT_SCOPE_METADATA_KEY = 'contentScope';
export const CONTENT_SCOPE_NAMES_ONLY = 'names_only';

/** The metadata a connector spreads into an item kept names-only by the owner's scope. */
export function namesOnlyContentScopeMetadata(): { readonly contentScope: typeof CONTENT_SCOPE_NAMES_ONLY } {
  return { [CONTENT_SCOPE_METADATA_KEY]: CONTENT_SCOPE_NAMES_ONLY } as const;
}

/** Whether the connector listed this item names-only because the owner's scope keeps its content unread. */
export function itemContentKeptNamesOnly(item: Pick<RawItem, 'metadata'>): boolean {
  return item.metadata[CONTENT_SCOPE_METADATA_KEY] === CONTENT_SCOPE_NAMES_ONLY;
}

/** The first non-empty string among `keys` in a metadata record. */
export function signalText(
  metadata: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Every non-empty string held in array-valued `keys`, de-duplicated. */
export function signalTexts(
  metadata: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): string[] {
  const values = new Set<string>();
  for (const key of keys) {
    const value = metadata[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) values.add(entry.trim());
    }
  }
  return [...values];
}

/** Drops absent and empty fields so a signal set says only what is known. */
export function compactClassificationSignals(signals: {
  floor?: SourceClassificationSignals['floor'] | undefined;
  prior?: SourceClassificationSignals['prior'] | undefined;
  sharing?: SourceClassificationSignals['sharing'] | undefined;
  title?: string | undefined;
  path?: string | undefined;
  folderKeys?: readonly string[] | undefined;
  sender?: string | undefined;
  recipients?: readonly string[] | undefined;
  labels?: readonly string[] | undefined;
  conversationKind?: SourceConversationKind | undefined;
}): SourceClassificationSignals {
  const out: {
    -readonly [K in keyof SourceClassificationSignals]: SourceClassificationSignals[K];
  } = {};
  if (signals.floor) out.floor = signals.floor;
  if (signals.prior) out.prior = signals.prior;
  if (signals.sharing) out.sharing = signals.sharing;
  if (signals.title?.trim()) out.title = signals.title.trim();
  if (signals.path?.trim()) out.path = signals.path.trim();
  if (signals.folderKeys && signals.folderKeys.length > 0) out.folderKeys = [...signals.folderKeys];
  if (signals.sender?.trim()) out.sender = signals.sender.trim();
  if (signals.recipients && signals.recipients.length > 0) out.recipients = [...signals.recipients];
  if (signals.labels && signals.labels.length > 0) out.labels = [...signals.labels];
  if (signals.conversationKind) out.conversationKind = signals.conversationKind;
  return out;
}

/**
 * The resting tier a source's trust domain implies, as a `prior`: item-level
 * raises still apply and no automatic signal lowers it. `basis` says where
 * the domain came from: `source_config` for a domain the owner or deployment
 * configured, `source_default` for a source whose existing doctrine keeps
 * every item at that domain (published so the recorded decision is never
 * less private than today's placement until an owner rule replaces it).
 */
export function trustDomainPrior(
  trustDomain: SourceTrustDomain,
  basis: 'source_config' | 'source_default',
): SourceClassificationPrior {
  return {
    tier: trustDomain === 'secure_local' ? 'secure' : trustDomain === 'public_safe' ? 'public' : 'private',
    strength: 'prior',
    basis: `${basis}:trust_domain:${trustDomain}`,
  };
}
