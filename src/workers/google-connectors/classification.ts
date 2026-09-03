import { loadSensitivityMap, type SensitivityMap } from '../../core/sensitivity-map.ts';
import {
  buildSourceSensitivity,
  type SourceSensitivity,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import {
  classifyItemTier,
  type ClassifyItemTierInput,
  type ItemTierClassification,
} from '../classification/engine.ts';

export type GoogleItemClassifier = (
  input: ClassifyItemTierInput,
  options: { sensitivityMap?: SensitivityMap },
) => ItemTierClassification;

export interface GoogleClassificationOptions {
  defaultTrustTier: SourceTrustTier;
  defaultTrustDomain: SourceTrustDomain;
  sensitivityMap?: SensitivityMap;
  classifier?: GoogleItemClassifier;
}

const TRUST_TIER_RANK: Record<SourceTrustTier, number> = {
  S0: 0,
  S1: 1,
  S2: 2,
  S3: 3,
  S4: 4,
  'S4+': 4.5,
  S5: 5,
};

export function loadGoogleSensitivityMap(
  env: Record<string, string | undefined> = process.env,
): SensitivityMap | undefined {
  return loadSensitivityMap({ env, allowMissing: true, ignoreInvalid: true });
}

export function classifyGoogleItemRaiseOnly(
  input: ClassifyItemTierInput,
  options: GoogleClassificationOptions,
): SourceSensitivity {
  const classifier = options.classifier ?? ((value, classifyOptions) => classifyItemTier(value, classifyOptions));
  const classified = classifier(input, {
    ...(options.sensitivityMap ? { sensitivityMap: options.sensitivityMap } : {}),
  });
  if (classified.decidedBy === 'default_secure') {
    return buildSourceSensitivity({
      trustTier: options.defaultTrustTier,
      trustDomain: options.defaultTrustDomain,
    });
  }
  const classifiedTier = classified.tier as SourceTrustTier;
  if (TRUST_TIER_RANK[classifiedTier] <= TRUST_TIER_RANK[options.defaultTrustTier]) {
    return buildSourceSensitivity({
      trustTier: options.defaultTrustTier,
      trustDomain: options.defaultTrustDomain,
    });
  }
  return buildSourceSensitivity({
    trustTier: classifiedTier,
    trustDomain: classified.trustDomain,
  });
}

export function accountFromGoogleHandle(handle: string | undefined, fallback = 'personal'): string {
  const trimmed = handle?.trim();
  if (!trimmed) return fallback;
  const match = /^[a-z_]+\.([a-z0-9_-]+)(?:\.|$)/i.exec(trimmed);
  return match?.[1] ?? fallback;
}

export function metadataString(metadata: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function metadataStringArray(metadata: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
}
