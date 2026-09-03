import { existsSync } from 'node:fs';
import {
  SOVEREIGNTY_PRESETS,
  defaultSovereigntyConfigPath,
  loadSovereigntyEngine,
  loadSovereigntyPreset,
  type SovereigntyConfig,
  type SovereigntyPresetName,
} from '../src/core/sovereignty.ts';

const TRUST_DOMAINS = ['public_safe', 'internal', 'secure_local'] as const;

type TrustDomain = (typeof TRUST_DOMAINS)[number];

interface PolicyFieldDifference {
  live: string | null;
  preset: string | null;
}

interface PoolSetDifference {
  live: string[];
  preset: string[];
}

interface PoolOrderDifference {
  live: string[] | null;
  preset: string[] | null;
}

interface PresetComparison {
  preset: SovereigntyPresetName;
  distance: number;
  profile_names: {
    present_only_in_live: string[];
    absent_from_live: string[];
  };
  trust_domains: Partial<Record<TrustDomain, {
    embeddingProfile?: PolicyFieldDifference;
    activationMode?: PolicyFieldDifference;
    analyst_pool_membership?: PoolSetDifference;
    analyst_pool_order?: PoolOrderDifference;
  }>>;
}

export interface SovereigntyDriftReport extends PresetComparison {
  kind: 'sovereignty_config_drift';
  config_source: 'file';
  drift: boolean;
}

export function inspectSovereigntyConfigDrift(configPath: string): SovereigntyDriftReport {
  if (!existsSync(configPath)) {
    throw new Error(`Sovereignty config file does not exist: ${configPath}`);
  }
  const engine = loadSovereigntyEngine({ configPath, env: {} });
  if (engine.source !== 'file') {
    throw new Error(`Sovereignty config did not load from the required file: ${configPath}`);
  }

  const comparison = SOVEREIGNTY_PRESETS
    .map((preset) => compareWithPreset(engine.config, preset))
    .sort((left, right) => left.distance - right.distance
      || SOVEREIGNTY_PRESETS.indexOf(left.preset) - SOVEREIGNTY_PRESETS.indexOf(right.preset))[0]!;
  return {
    kind: 'sovereignty_config_drift',
    config_source: 'file',
    drift: comparison.distance > 0,
    ...comparison,
  };
}

function compareWithPreset(live: SovereigntyConfig, presetName: SovereigntyPresetName): PresetComparison {
  const preset = loadSovereigntyPreset(presetName);
  const liveProfiles = Object.keys(live.modelProfiles).sort();
  const presetProfiles = Object.keys(preset.modelProfiles).sort();
  const liveProfileSet = new Set(liveProfiles);
  const presetProfileSet = new Set(presetProfiles);
  const presentOnlyInLive = liveProfiles.filter((name) => !presetProfileSet.has(name));
  const absentFromLive = presetProfiles.filter((name) => !liveProfileSet.has(name));
  const trustDomains: PresetComparison['trust_domains'] = {};
  let distance = presentOnlyInLive.length + absentFromLive.length;

  for (const domain of TRUST_DOMAINS) {
    const livePolicy = live.retrieval.trustDomains[domain];
    const presetPolicy = preset.retrieval.trustDomains[domain];
    const livePool = effectivePool(live, domain);
    const presetPool = effectivePool(preset, domain);
    const embeddingProfile = difference(
      livePolicy?.embeddingProfile ?? null,
      presetPolicy?.embeddingProfile ?? null,
    );
    const activationMode = difference(
      livePolicy?.activationMode ?? null,
      presetPolicy?.activationMode ?? null,
    );
    const analystPoolMembership = arrayDifference(
      [...livePool.members].sort(),
      [...presetPool.members].sort(),
    );
    const analystPoolOrder = nullableArrayDifference(
      livePool.order ?? null,
      presetPool.order ?? null,
    );
    if (embeddingProfile || activationMode || analystPoolMembership || analystPoolOrder) {
      trustDomains[domain] = {
        ...(embeddingProfile ? { embeddingProfile } : {}),
        ...(activationMode ? { activationMode } : {}),
        ...(analystPoolMembership ? { analyst_pool_membership: analystPoolMembership } : {}),
        ...(analystPoolOrder ? { analyst_pool_order: analystPoolOrder } : {}),
      };
      distance += Number(Boolean(embeddingProfile))
        + Number(Boolean(activationMode))
        + Number(Boolean(analystPoolMembership))
        + Number(Boolean(analystPoolOrder));
    }
  }

  return {
    preset: presetName,
    distance,
    profile_names: {
      present_only_in_live: presentOnlyInLive,
      absent_from_live: absentFromLive,
    },
    trust_domains: trustDomains,
  };
}

function difference(live: string | null, preset: string | null): PolicyFieldDifference | undefined {
  return live === preset ? undefined : { live, preset };
}

function effectivePool(
  config: SovereigntyConfig,
  domain: TrustDomain,
): { members: string[]; order?: string[] } {
  const route = config.routes[domain];
  if (!route) return { members: [] };
  if (route.pool) {
    return {
      members: [...route.pool.members],
      ...(route.pool.order ? { order: [...route.pool.order] } : {}),
    };
  }
  const legacy = route.analyst ?? [];
  return { members: [...legacy], order: [...legacy] };
}

function arrayDifference(live: string[], preset: string[]): PoolSetDifference | undefined {
  return arraysEqual(live, preset) ? undefined : { live, preset };
}

function nullableArrayDifference(
  live: string[] | null,
  preset: string[] | null,
): PoolOrderDifference | undefined {
  if (live === null || preset === null) {
    return live === preset ? undefined : { live, preset };
  }
  return arraysEqual(live, preset) ? undefined : { live, preset };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseArgs(argv: string[]): { configPath: string } {
  let configPath = defaultSovereigntyConfigPath();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error('--config requires a path.');
      configPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { configPath };
}

if (import.meta.main) {
  const { configPath } = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(inspectSovereigntyConfigDrift(configPath), null, 2));
}
