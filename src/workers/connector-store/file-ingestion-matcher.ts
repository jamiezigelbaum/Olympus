// The folder-lane ingestion gate shared by every file source that has an
// ingestion policy (Dropbox, local files): durable shared exclusions plus the
// policy's item-level metadata-only/on-demand rules. Lifted out of the Dropbox
// connector store unchanged so a second file source does not copy it. The only
// per-source inputs are the standing exclusion matcher, the prefix the rule
// ids are reported under, and how a readiness-following default policy
// rebuilds its rules.
//
// Nothing here names a provider.

import {
  normalizeSourceExclusionPath,
  sourceExclusionFactsFromMetadata,
  sourceExclusionFileExtension,
  type SourceExclusionCriterion,
  type SourceExclusionDecision,
  type SourceExclusionItemFacts,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import { readyStillImageFormats } from '../../core/still-image-readiness.ts';
import {
  followsStillImageReadiness,
  type SourceIngestionPolicy,
  type SourceIngestionRule,
} from '../../core/source-ingestion-policy.ts';
import type { StillImageFormat } from '../../core/still-image-formats.ts';

export interface FileLaneIngestionMatcherOptions {
  /** The standing exclusion matcher for this source (durable shared exclusions). */
  standing: (env: Record<string, string | undefined>) => SourceExclusionMatcher;
  /** Prefix of the rule ids the policy's rules are reported under. */
  ruleIdPrefix: string;
  /** Rebuilds a readiness-following default policy's rules for the formats now ready. */
  defaultRules: (ready: ReadonlySet<StillImageFormat>) => SourceIngestionRule[];
}

/**
 * One gate for a canonical store: durable shared exclusions plus the source
 * policy's item-level metadata-only/on-demand rules. Keeping the adapter here
 * confines source-shaped matching to the connector boundary; the shared store
 * and extraction factory receive only SourceExclusionMatcher.
 */
export function fileLaneIngestionMatcher(
  policy: SourceIngestionPolicy,
  env: Record<string, string | undefined>,
  options: FileLaneIngestionMatcherOptions,
): SourceExclusionMatcher {
  if (!followsStillImageReadiness(policy)) return buildMatcher(policy, env, options);
  // The default policy's still-image rule is the machine's per-format
  // readiness, which can change while a worker runs (the model's image
  // encoder finishes loading, a probe is refreshed). The gate is built again
  // whenever the set of formats read changes, so admission follows it.
  let formatsKey: string | undefined;
  let built: SourceExclusionMatcher | undefined;
  const current = (): SourceExclusionMatcher => {
    if (!followsStillImageReadiness(policy)) {
      built = buildMatcher(policy, env, options);
      formatsKey = undefined;
      return built;
    }
    const ready = readyStillImageFormats();
    const key = [...ready].sort().join(',');
    if (built === undefined || key !== formatsKey) {
      formatsKey = key;
      built = buildMatcher({ ...policy, rules: options.defaultRules(ready) }, env, options);
    }
    return built;
  };
  return {
    get active() { return current().active; },
    get pathActive() { return current().pathActive; },
    get identityActive() { return current().identityActive; },
    get mediaActive() { return current().mediaActive; },
    get unenforceableRuleIds() { return current().unenforceableRuleIds; },
    get criteria() { return current().criteria; },
    evaluatePath: (path) => current().evaluatePath(path),
    evaluateMetadata: (metadata) => current().evaluateMetadata(metadata),
    evaluateItem: (facts) => current().evaluateItem(facts),
  };
}

function buildMatcher(
  policy: SourceIngestionPolicy,
  env: Record<string, string | undefined>,
  options: FileLaneIngestionMatcherOptions,
): SourceExclusionMatcher {
  const standing = options.standing(env);
  const policyRules = policy.rules.filter((rule) => rule.action !== 'full_extract');
  const policyCriteria = policyRules.flatMap((rule, index) =>
    criteriaOf(rule, index, options.ruleIdPrefix)
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
    const policyDecision = decide(policyRules, facts, options.ruleIdPrefix);
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

const POLICY_ADMITTED: SourceExclusionDecision = Object.freeze({
  excluded: false,
  disposition: 'admit',
  outcome: 'admitted',
});

function criteriaOf(rule: SourceIngestionRule, index: number, ruleIdPrefix: string): SourceExclusionCriterion[] {
  const ruleId = `${ruleIdPrefix}-${index + 1}`;
  const mode = 'metadata_only' as const;
  const pathCriteria: SourceExclusionCriterion[] = (rule.match.path_prefixes ?? []).map((path) => ({
    ruleId,
    reason: rule.reason,
    mode,
    kind: 'path_prefix',
    prefix: normalizePolicyPrefix(path) ?? path,
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

function normalizePolicyPrefix(value: string): string | undefined {
  const slashNormalized = value.trim().replace(/\\/g, '/');
  if (/^\/+$/u.test(slashNormalized)) return '/';
  return normalizeSourceExclusionPath(value);
}

function decide(
  rules: readonly SourceIngestionRule[],
  facts: SourceExclusionItemFacts,
  ruleIdPrefix: string,
): SourceExclusionDecision {
  const rawPath = typeof facts.path === 'string' ? facts.path : undefined;
  const path = rawPath === undefined ? undefined : normalizeSourceExclusionPath(rawPath);
  const name = typeof facts.name === 'string' ? facts.name : undefined;
  const extension = sourceExclusionFileExtension(path ?? name ?? '');
  const mimeType = typeof facts.mimeType === 'string' ? facts.mimeType.trim().toLowerCase() : undefined;

  for (const [index, rule] of rules.entries()) {
    const ruleId = `${ruleIdPrefix}-${index + 1}`;
    const normalizedPrefixes = (rule.match.path_prefixes ?? [])
      .map(normalizePolicyPrefix)
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
