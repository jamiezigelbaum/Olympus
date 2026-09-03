import { createDefaultSecretStore, normalizeSecretRef, type SecretStore } from './secret-store.ts';
import type { SovereigntyConfig, SovereigntyModelProfile } from './sovereignty.ts';

export type SetupPrerequisiteKind = 'env_secret' | 'store_secret' | 'local_model_server';

export interface SetupPrerequisite {
  id: string;
  kind: SetupPrerequisiteKind;
  profileId: string;
  label: string;
  detail: string;
  remedy: string;
}

export interface SetupPreflightOptions {
  config: SovereigntyConfig;
  env?: Record<string, string | undefined>;
  secretStore?: Pick<SecretStore, 'get' | 'getSync'>;
}

export async function setupPreflight(options: SetupPreflightOptions): Promise<SetupPrerequisite[]> {
  const env = options.env ?? process.env;
  const secretStore = options.secretStore ?? createDefaultSecretStore({ env });
  const unmet: SetupPrerequisite[] = [];
  const seen = new Set<string>();

  for (const [profileId, profile] of Object.entries(options.config.modelProfiles)) {
    if (profile.secretRef) {
      const prerequisite = await secretRefPrerequisite(profileId, profile, env, secretStore);
      if (prerequisite && !seen.has(prerequisite.id)) {
        seen.add(prerequisite.id);
        unmet.push(prerequisite);
      }
    }

    if (isLocalLoopbackProfile(profile)) {
      const prerequisite = localServerPrerequisite(profileId, profile);
      if (!seen.has(prerequisite.id)) {
        seen.add(prerequisite.id);
        unmet.push(prerequisite);
      }
    }
  }

  return unmet;
}

async function secretRefPrerequisite(
  profileId: string,
  profile: SovereigntyModelProfile,
  env: Record<string, string | undefined>,
  secretStore: Pick<SecretStore, 'get' | 'getSync'>,
): Promise<SetupPrerequisite | undefined> {
  const ref = normalizeSecretRef(profile.secretRef ?? '');
  if (!ref) return undefined;
  if (ref.kind === 'env') {
    if (env[ref.key]?.trim()) return undefined;
    if (ref.key === 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY' && env.GEMINI_API_KEY?.trim()) return undefined;
    const displayKey = ref.key === 'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY' ? 'GEMINI_API_KEY' : ref.key;
    return {
      id: `env:${displayKey}`,
      kind: 'env_secret',
      profileId,
      label: `${displayKey} environment variable`,
      detail: `Profile ${profileId} needs ${displayKey} for ${profile.provider}.`,
      remedy: `export ${displayKey}=...`,
    };
  }

  const value = secretStore.getSync
    ? secretStore.getSync(ref.key)
    : await secretStore.get(ref.key);
  if (value?.trim()) return undefined;
  return {
    id: `store:${ref.key}`,
    kind: 'store_secret',
    profileId,
    label: `${ref.key} secret-store entry`,
    detail: `Profile ${profileId} needs ${ref.key} in the Olympus secret store.`,
    remedy: storeSecretRemedy(ref.key),
  };
}

function isLocalLoopbackProfile(profile: SovereigntyModelProfile): boolean {
  if (profile.provider !== 'local-openai-compatible' || !profile.baseUrl) return false;
  try {
    const url = new URL(profile.baseUrl);
    const host = url.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function localServerPrerequisite(profileId: string, profile: SovereigntyModelProfile): SetupPrerequisite {
  const baseUrl = profile.baseUrl!;
  return {
    id: `local_model_server:${profileId}:${baseUrl}`,
    kind: 'local_model_server',
    profileId,
    label: `${profileId} local model server`,
    detail: `Profile ${profileId} expects an OpenAI-compatible local model server at ${baseUrl}.`,
    remedy: `Start a local OpenAI-compatible model server on ${baseUrl.replace(/\/v1\/?$/, '')} or choose --preset no-sensitive.`,
  };
}

function storeSecretRemedy(key: string): string {
  if (key === 'venice.api_key') {
    return 'printf \'%s\' "$KEY" | olympus connect venice --api-key-stdin';
  }
  return `Store ${key} with the matching olympus connect command before source answering.`;
}
