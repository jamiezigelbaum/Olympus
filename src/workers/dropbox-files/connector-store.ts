// Placement of the Dropbox connector stores on the shared spine.
//
// Per-tier stores (design docs/design/per-item-four-tier-classification.md,
// section 3.2), family `file`:
// - `secure_local.dropbox.files`: the lane's original store. Everything stored
//   before per-item routing stays here, unchanged, and Private items land here.
// - `internal.dropbox.files` and `public_safe.dropbox.files`: created only when
//   a NEW file is first routed to them (Personal by default for its names;
//   its content wherever the text the extraction factory read puts it).
// All three carry the same exclusion gate and the same approved-scope read
// filter; the secure store's co-located tier ledger governs visibility for
// all three.

import { resolvedStorePath } from '../../core/source-placement.ts';
import type { ConnectorStorePlacementRule } from '../connector-store/tier-placement.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import {
  createSourceExclusionMatcher,
  loadSourceIngestionExclusions,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import {
  defaultDropboxIngestionPolicy,
  loadDropboxIngestionPolicy,
  type SourceIngestionPolicy,
} from '../../core/source-ingestion-policy.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { fileLaneIngestionMatcher } from '../connector-store/file-ingestion-matcher.ts';
import { openConnectorStore } from '../../core/source-storage.ts';
import { DROPBOX_FILES_CORPUS_ID, DROPBOX_FILES_SOURCE_ID } from './corpus-adapter.ts';

export const DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID = DROPBOX_FILES_CORPUS_ID;

/** The Personal and Public Dropbox stores, created when a new file is first routed there. */
export const DROPBOX_INTERNAL_FILES_CORPUS_ID = 'internal.dropbox.files';
export const DROPBOX_PUBLIC_FILES_CORPUS_ID = 'public_safe.dropbox.files';

/** Every Dropbox tier store's corpus, by trust domain. */
export const DROPBOX_TIER_CORPUS_IDS: Readonly<Record<SourceTrustDomain, string>> = Object.freeze({
  public_safe: DROPBOX_PUBLIC_FILES_CORPUS_ID,
  internal: DROPBOX_INTERNAL_FILES_CORPUS_ID,
  secure_local: DROPBOX_FILES_CORPUS_ID,
});

/**
 * The source key this connector's exclusion rules are written against. It is
 * the same id the ingestion policy uses, so a user names their source once.
 */
export const DROPBOX_INGESTION_EXCLUSION_SOURCE = 'dropbox.personal';

/**
 * What a Dropbox exclusion can be expressed as.
 *
 * Path prefixes, and deliberately not folder ids. Dropbox publishes a real
 * folder path and treats it as the item's identity, so a prefix is both what a
 * setup folder-picker yields and what the provider itself compares. Declaring
 * the capability is what turns a rule this source cannot enforce — a Drive
 * folder id aimed at Dropbox — into a refusal when the gate is built, instead
 * of a rule that quietly matches nothing.
 *
 * `media` is declared because this provider publishes a byte count on every
 * file entry it lists, which is the fact a media rule needs and cannot invent.
 * A source that did not publish sizes must NOT declare it: it would answer
 * "unevaluable" for every file of the named type, and fail them all closed.
 */
export const DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA = ['path_prefix', 'media'] as const;

/**
 * Where an EXISTING Dropbox file (one stored before per-item routing) rests:
 * S4/secure_local, raised to S5 — tombstoned, location only — when the
 * textual body carries a secret. Exactly the rule the retired connector
 * classify() applied. New files are routed per item by the lane's tier set.
 */
export const DROPBOX_STORE_PLACEMENT: ConnectorStorePlacementRule = Object.freeze({
  trustTier: 'S4',
  trustDomain: 'secure_local',
  secretsInContent: true,
});

/** Every Dropbox tier store's path: the lifecycle deletes all of them with the source. */
export function dropboxTierConnectorStoreDbPaths(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'secure_local', env),
    resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'internal', env),
    resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'public_safe', env),
  ];
}

/**
 * The folder-exclusion gate for this source, built from the user's own config.
 *
 * A parse failure is NOT caught here. A user who wrote an exclusion list that
 * cannot be read must not get a store that silently ingests everything —
 * refusing to open is the fail-closed answer, and it is loud.
 */
export function dropboxIngestionExclusionMatcher(
  env: Record<string, string | undefined> = process.env,
): SourceExclusionMatcher {
  return createSourceExclusionMatcher(
    loadSourceIngestionExclusions({ env }),
    DROPBOX_INGESTION_EXCLUSION_SOURCE,
    { enforceable: DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA },
  );
}

/**
 * One gate for the canonical store: durable shared exclusions plus the older
 * Dropbox policy's item-level metadata-only/on-demand rules. The gate itself
 * is shared (`connector-store/file-ingestion-matcher.ts`); this adapter only
 * names Dropbox's standing exclusions, rule ids and default rules.
 */
export function dropboxCanonicalIngestionMatcher(
  policy: SourceIngestionPolicy,
  env: Record<string, string | undefined> = process.env,
): SourceExclusionMatcher {
  return fileLaneIngestionMatcher(policy, env, {
    standing: dropboxIngestionExclusionMatcher,
    ruleIdPrefix: 'dropbox-policy',
    defaultRules: (ready) => defaultDropboxIngestionPolicy({ stillImagesRead: ready }).rules,
  });
}

export function createDropboxConnectorStore(
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; policy?: SourceIngestionPolicy } = {},
): LocalConnectorStore {
  const policy = options.policy ?? loadDropboxIngestionPolicy({ env });
  return openConnectorStore({ sourceId: DROPBOX_FILES_SOURCE_ID }, {
    dbPath: resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'secure_local', env),
    corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    exclusions: dropboxCanonicalIngestionMatcher(policy, env),
    ...(options.readOnly === true ? { readOnly: true } : {}),
  }, env);
}

/**
 * A Personal or Public Dropbox store: the same family, exclusion gate and
 * policy as the lane's original store, bound to the lane's set ledger so it
 * never serves a copy the ledger hides — even when opened on its own.
 */
export function createDropboxTierConnectorStore(
  trustDomain: 'internal' | 'public_safe',
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; policy?: SourceIngestionPolicy; tierLedger?: TierLedger } = {},
): LocalConnectorStore {
  const policy = options.policy ?? loadDropboxIngestionPolicy({ env });
  return openConnectorStore({ sourceId: DROPBOX_FILES_SOURCE_ID }, {
    dbPath: trustDomain === 'internal'
      ? resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'internal', env)
      : resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'public_safe', env),
    corpusId: DROPBOX_TIER_CORPUS_IDS[trustDomain],
    family: 'file',
    trustDomain,
    exclusions: dropboxCanonicalIngestionMatcher(policy, env),
    ...(options.readOnly === true ? { readOnly: true } : {}),
    ...(options.tierLedger ? { tierLedger: options.tierLedger } : {}),
  }, env);
}
