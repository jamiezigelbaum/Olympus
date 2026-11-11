import { OpenAICompatibleVlmClient } from '../../file-extraction/extractors/openai-compatible-client.ts';
import {
  type VeniceThinkingMode,
} from '../../../core/analyst-venice.ts';
import { type OpenAIReasoningEffort } from '../../../core/analyst-openai.ts';
import { parseOptionalBooleanEnv } from '../../../core/config.ts';
import {
  type SovereigntyModelProfile,
} from '../../../core/sovereignty.ts';
import {
  DEFAULT_SEMANTIC_RELEVANCE_BAR,
} from '../../connector-store/index.ts';
import { resolveSecretRefValueSync } from '../../../core/secret-store.ts';
import {
  credentialConfigFingerprint,
  WorkerBootSecretResolver,
  type CredentialReadinessBinding,
} from '../../credential-degradation.ts';

export function parseOptionalTimeoutSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds.`);
  }
  return Math.round(seconds * 1000);
}

export function parseOptionalTimeoutSecondsOrNone(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'unbounded' || normalized === 'disabled') return 0;
  return parseOptionalTimeoutSeconds(value, name);
}

export function parseRequiredTimeoutSeconds(value: string, name: string): number {
  return parseOptionalTimeoutSeconds(value, name) ?? (() => {
    throw new Error(`${name} must be a positive number of seconds.`);
  })();
}

export function parseVeniceReasoningEffort(value: string): OpenAIReasoningEffort {
  const normalized = value.trim();
  if ([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ].includes(normalized)) {
    return normalized as OpenAIReasoningEffort;
  }
  throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT must be one of none, minimal, low, medium, high, xhigh, max.');
}

export function parseVeniceThinkingMode(value: string): VeniceThinkingMode {
  const normalized = value.trim();
  if (normalized === 'enabled' || normalized === 'on' || normalized === 'true') return 'enabled';
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'false') return 'disabled';
  throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING must be enabled or disabled.');
}

export function parseOptionalTokenCount(value: string | undefined, name: string): number | undefined {
  return parseOptionalPositiveInteger(value, name);
}

export function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function sourceIndexSemanticRelevanceBarFromEnv(
  env: Record<string, string | undefined>,
): number {
  const name = 'OLYMPUS_SOURCE_INDEX_SEMANTIC_RELEVANCE_BAR';
  const value = env[name];
  if (value === undefined) return DEFAULT_SEMANTIC_RELEVANCE_BAR;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`${name} must be a finite number greater than 0 and less than 1.`);
  }
  return parsed;
}

export function parseSecureDerivativeDefault(value: string | undefined): 'allow' | 'approval' | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'allow' || normalized === 'approval') return normalized;
  throw new Error('OLYMPUS_SECURE_DERIVATIVE_DEFAULT must be allow or approval.');
}

export function sourceIndexTelegramAccountFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return optionalEnv(env, 'OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT');
}

export function accountFromDropboxCredentialHandle(value: string | undefined): string | undefined {
  const handle = value?.trim();
  if (!handle) return undefined;
  const match = /^dropbox\.([a-z0-9_-]+)(?:\.|$)/i.exec(handle);
  return match?.[1];
}

/**
 * The local VLM client for file extraction, from the
 * OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_* settings, or undefined when that lane is
 * off. The client refuses a model id with a reserved cloud-style tag.
 */
export function createFileExtractionLocalVlmClientFromEnv(
  env: Record<string, string | undefined>,
): OpenAICompatibleVlmClient | undefined {
  const fileExtractionLocalVlmEnabled = parseOptionalBooleanEnv(
    env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED,
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED',
  );
  const fileExtractionLocalVlmConfigured = [
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
  ].some((name) => Boolean(env[name]?.trim()));
  if (fileExtractionLocalVlmConfigured && !fileExtractionLocalVlmEnabled) {
    throw new Error(
      'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED=true is required when local VLM settings are present.',
    );
  }
  return fileExtractionLocalVlmEnabled
    ? new OpenAICompatibleVlmClient({
        baseUrl: requiredFileExtractionEnv(
          env,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL',
        ),
        model: requiredFileExtractionEnv(
          env,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL',
        ),
        ...(env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY?.trim()
          ? { apiKey: env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY.trim() }
          : {}),
        ...(parseOptionalTimeoutSecondsOrNone(
          env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
        ) !== undefined
          ? {
              timeoutMs: parseOptionalTimeoutSecondsOrNone(
                env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS,
                'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
              )!,
            }
          : {}),
      })
    : undefined;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OLYMPUS_EMAIL_SOURCE_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

export function firstNonEmptyEnv(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = optionalEnv(env, name);
    if (value) return value;
  }
  return undefined;
}

export function requireVeniceApiKey(env: Record<string, string | undefined>): string {
  const apiKey = firstNonEmptyEnv(env, [
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!apiKey) {
    throw new Error('Venice analyst requires OLYMPUS_SOURCE_INDEX_VENICE_API_KEY, VENICE_API_KEY, API_KEY_VENICE, or Venice-API-Key in the assistant runtime.');
  }
  return apiKey;
}

export function requireFileExtractionVeniceApiKey(
  env: Record<string, string | undefined>,
): string {
  const apiKey = firstNonEmptyEnv(env, [
    'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY',
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!apiKey) {
    throw new Error(
      'Remote file extraction requires OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY or an approved shared Venice API-key environment reference.',
    );
  }
  return apiKey;
}

export function requiredFileExtractionEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when remote file extraction is enabled.`);
  return value;
}

async function resolveSecretRef(
  secretRef: string | undefined,
  env: Record<string, string | undefined>,
  label: string,
): Promise<string> {
  return resolveSecretRefSync(secretRef, env, label) ?? (() => {
    throw new Error(`${label} secretRef did not resolve.`);
  })();
}

export function resolveSecretRefSync(
  secretRef: string | undefined,
  env: Record<string, string | undefined>,
  label: string,
  options: {
    bootSecretResolver?: WorkerBootSecretResolver;
    affectedProfiles?: string[];
    affectedCapabilities?: string[];
    profileBindings?: CredentialReadinessBinding[];
  } = {},
): string | undefined {
  const ref = secretRef?.trim();
  if (!ref) {
    if (options.bootSecretResolver) {
      return options.bootSecretResolver.resolveSync(undefined, env, {
        displayName: label,
        ...(options.affectedProfiles ? { affectedProfiles: options.affectedProfiles } : {}),
        ...(options.affectedCapabilities ? { affectedCapabilities: options.affectedCapabilities } : {}),
        ...(options.profileBindings ? { profileBindings: options.profileBindings } : {}),
      });
    }
    throw new Error(`${label} requires a secretRef; inline secrets are not allowed in sovereignty.json.`);
  }
  if (options.bootSecretResolver) {
    return options.bootSecretResolver.resolveSync(ref, env, {
      displayName: label,
      ...(options.affectedProfiles ? { affectedProfiles: options.affectedProfiles } : {}),
      ...(options.affectedCapabilities ? { affectedCapabilities: options.affectedCapabilities } : {}),
      ...(options.profileBindings ? { profileBindings: options.profileBindings } : {}),
    });
  }
  const value = resolveSecretRefValueSync(ref, { env });
  if (!value) {
    throw new Error(`${label} secretRef did not resolve.`);
  }
  return value;
}

export function bootSecretOptions(
  bootSecretResolver: WorkerBootSecretResolver | undefined,
  affectedProfiles: string[],
  affectedCapabilities: string[],
  profile?: { id: string; profile: SovereigntyModelProfile },
): {
  bootSecretResolver?: WorkerBootSecretResolver;
  affectedProfiles: string[];
  affectedCapabilities: string[];
  profileBindings?: CredentialReadinessBinding[];
} {
  return {
    ...(bootSecretResolver ? { bootSecretResolver } : {}),
    affectedProfiles,
    affectedCapabilities,
    ...(profile
      ? {
          profileBindings: [{
            profileId: profile.id,
            configFingerprint: credentialConfigFingerprint(profile.id, profile.profile),
          }],
        }
      : {}),
  };
}

function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

export function commaSeparatedEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(/,|\|\|/)
    .map((item) => item.trim())
    .filter(Boolean);
}
