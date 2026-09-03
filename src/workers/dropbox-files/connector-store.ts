// Placement of the Dropbox connector store on the shared spine.
//
// One store, one corpus: `secure_local.dropbox.files`, family `file`, trust
// domain `secure_local`. Unlike Drive there is no internal twin: the Dropbox
// corpus has never had an internal band.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createSourceExclusionMatcher,
  loadSourceIngestionExclusions,
  normalizeSourceExclusionPath,
  sourceExclusionFactsFromMetadata,
  sourceExclusionFileExtension,
  type SourceExclusionCriterion,
  type SourceExclusionDecision,
  type SourceExclusionItemFacts,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import {
  loadDropboxIngestionPolicy,
  type SourceIngestionPolicy,
  type SourceIngestionRule,
} from '../../core/source-ingestion-policy.ts';
import { LocalConnectorStore } from '../connector-store/index.ts';
import { DROPBOX_FILES_CORPUS_ID } from './corpus-adapter.ts';

export const DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID = DROPBOX_FILES_CORPUS_ID;

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

export const DROPBOX_CONNECTOR_STORE_DB_PATH_ENV =
  'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_DB_PATH';

export function defaultDropboxConnectorStoreDbPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env[DROPBOX_CONNECTOR_STORE_DB_PATH_ENV]?.trim();
  if (configured) return configured;
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(dataHome, 'openclaw', 'olympus', 'dropbox-files-connector-store.sqlite');
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
 * Dropbox policy's item-level metadata-only/on-demand rules. Keeping the
 * adapter here confines source-shaped matching to the connector boundary; the
 * shared store and extraction factory receive only SourceExclusionMatcher.
 */
export function dropboxCanonicalIngestionMatcher(
  policy: SourceIngestionPolicy,
  env: Record<string, string | undefined> = process.env,
): SourceExclusionMatcher {
  const standing = dropboxIngestionExclusionMatcher(env);
  const policyRules = policy.rules.filter((rule) => rule.action !== 'full_extract');
  const policyCriteria = policyRules.flatMap((rule, index) =>
    dropboxPolicyCriteria(rule, index)
  );
  const pathActive = standing.pathActive || policyRules.some((rule) =>
    (rule.match.path_prefixes?.length ?? 0) > 0
    || (rule.match.path_contains?.length ?? 0) > 0
  );
  const mediaActive = standing.mediaActive || policyRules.some((rule) =>
    (rule.match.extensions?.length ?? 0) > 0
    || (rule.match.mime_type_prefixes?.length ?? 0) > 0
  );

  const evaluateItem = (facts: SourceExclusionItemFacts): SourceExclusionDecision => {
    const standingDecision = standing.evaluateItem(facts);
    if (standingDecision.disposition === 'exclude') return standingDecision;
    const policyDecision = dropboxPolicyDecision(policyRules, facts);
    return standingDecision.disposition === 'metadata_only'
      ? standingDecision
      : policyDecision;
  };

  return {
    active: standing.active || policyRules.length > 0,
    pathActive,
    identityActive: standing.identityActive,
    mediaActive,
    unenforceableRuleIds: standing.unenforceableRuleIds,
    criteria: Object.freeze([...standing.criteria, ...policyCriteria]),
    evaluatePath: (path) => evaluateItem({ path }),
    evaluateMetadata: (metadata) => evaluateItem(sourceExclusionFactsFromMetadata(metadata)),
    evaluateItem,
  };
}

export function createDropboxConnectorStore(
  env: Record<string, string | undefined> = process.env,
  options: { readOnly?: boolean; policy?: SourceIngestionPolicy } = {},
): LocalConnectorStore {
  const policy = options.policy ?? loadDropboxIngestionPolicy({ env });
  return new LocalConnectorStore({
    dbPath: defaultDropboxConnectorStoreDbPath(env),
    corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    exclusions: dropboxCanonicalIngestionMatcher(policy, env),
    ...(options.readOnly === true ? { readOnly: true } : {}),
  });
}

const POLICY_ADMITTED: SourceExclusionDecision = Object.freeze({
  excluded: false,
  disposition: 'admit',
  outcome: 'admitted',
});

function dropboxPolicyCriteria(rule: SourceIngestionRule, index: number): SourceExclusionCriterion[] {
  const ruleId = `dropbox-policy-${index + 1}`;
  const mode = 'metadata_only' as const;
  const pathCriteria: SourceExclusionCriterion[] = (rule.match.path_prefixes ?? []).map((path) => ({
    ruleId,
    reason: rule.reason,
    mode,
    kind: 'path_prefix',
    prefix: normalizeDropboxPolicyPrefix(path) ?? path,
  }));
  const containsCriteria: SourceExclusionCriterion[] = (rule.match.path_contains ?? [])
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .map((segment) => ({
      ruleId,
      reason: rule.reason,
      mode,
      kind: 'path_prefix' as const,
      prefix: `contains:${segment}`,
    }));
  const extensions = (rule.match.extensions ?? []).map((extension) =>
    extension.startsWith('.') ? extension.toLowerCase() : `.${extension.toLowerCase()}`
  );
  const mimePrefixes = (rule.match.mime_type_prefixes ?? []).map((prefix) => prefix.toLowerCase());
  return extensions.length > 0 || mimePrefixes.length > 0
    ? [
        ...pathCriteria,
        ...containsCriteria,
        {
          ruleId,
          reason: rule.reason,
          mode,
          kind: 'media',
          prefix: `policy:${ruleId}:media`,
          media: { extensions, mime_prefixes: mimePrefixes },
        },
      ]
    : [...pathCriteria, ...containsCriteria];
}

function normalizeDropboxPolicyPrefix(value: string): string | undefined {
  const slashNormalized = value.trim().replace(/\\/g, '/');
  if (/^\/+$/u.test(slashNormalized)) return '/';
  return normalizeSourceExclusionPath(value);
}

function dropboxPolicyDecision(
  rules: readonly SourceIngestionRule[],
  facts: SourceExclusionItemFacts,
): SourceExclusionDecision {
  const rawPath = typeof facts.path === 'string' ? facts.path : undefined;
  const path = rawPath === undefined ? undefined : normalizeSourceExclusionPath(rawPath);
  const name = typeof facts.name === 'string' ? facts.name : undefined;
  const extension = sourceExclusionFileExtension(path ?? name ?? '');
  const mimeType = typeof facts.mimeType === 'string' ? facts.mimeType.trim().toLowerCase() : undefined;

  for (const [index, rule] of rules.entries()) {
    const ruleId = `dropbox-policy-${index + 1}`;
    const normalizedPrefixes = (rule.match.path_prefixes ?? [])
      .map(normalizeDropboxPolicyPrefix)
      .filter((value): value is string => value !== undefined);
    const contains = (rule.match.path_contains ?? []).map((value) => value.trim().toLowerCase());
    const hasPathRule = normalizedPrefixes.length > 0 || contains.length > 0;
    if (hasPathRule && path === undefined) {
      return {
        excluded: false,
        disposition: 'metadata_only',
        outcome: 'metadata_only_unevaluable',
        ruleId,
        reason: rule.reason,
      };
    }
    const pathMatchesPrefix = path !== undefined && normalizedPrefixes.some((prefix) =>
      prefix === '/' || path === prefix || path.startsWith(`${prefix}/`)
    );
    const pathSegments = path?.split('/').filter(Boolean) ?? [];
    const pathMatchesContains = contains.some((segment) => pathSegments.includes(segment));
    const extensionMatches = extension !== undefined
      && (rule.match.extensions ?? []).some((candidate) =>
        extension === (candidate.startsWith('.') ? candidate.toLowerCase() : `.${candidate.toLowerCase()}`)
      );
    const mimeMatches = mimeType !== undefined
      && (rule.match.mime_type_prefixes ?? []).some((prefix) => mimeType.startsWith(prefix.toLowerCase()));
    if (!pathMatchesPrefix && !pathMatchesContains && !extensionMatches && !mimeMatches) continue;
    const matchedPrefix = pathMatchesPrefix
      ? normalizedPrefixes.find((prefix) => prefix === '/' || path === prefix || path?.startsWith(`${prefix}/`))
      : pathMatchesContains
        ? contains.find((segment) => pathSegments.includes(segment))
        : undefined;
    return {
      excluded: false,
      disposition: 'metadata_only',
      outcome: pathMatchesPrefix || pathMatchesContains
        ? 'metadata_only_path_prefix'
        : 'metadata_only_media',
      ruleId,
      reason: rule.reason,
      prefix: pathMatchesPrefix
        ? matchedPrefix ?? '/'
        : pathMatchesContains
          ? `contains:${matchedPrefix ?? ruleId}`
          : `policy:${ruleId}:media`,
    };
  }
  return POLICY_ADMITTED;
}
