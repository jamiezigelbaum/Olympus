import { OperationError } from './operation-error.ts';
import {
  SOURCE_INDEX_ACTIVATION_MODES,
  defineSourceIndexCorpus,
  type SourceIndexActivationMode,
  type SourceIndexCorpusDefinition,
} from './source-index/corpus.ts';
import {
  SOURCE_FAMILIES,
  SOURCE_TRUST_DOMAINS,
  type SourceFamily,
  type SourceTrustDomain,
} from './source-index/types.ts';
import { V0_4_PUBLIC_SOURCE_IDS } from './public-surface.ts';

export const SOURCE_CORPUS_REGISTRY_SCHEMA_VERSION = 1;
export const READWISE_LIBRARY_CORPUS_ID = 'internal.readwise.library';
export const LEGACY_READWISE_LIBRARY_CORPUS_ID = 'public_safe.readwise.library';
export const PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID = 'secure_local.telegram.protected.messages';
export const LEGACY_TELEGRAM_MESSAGES_CORPUS_ID = 'secure_local.telegram.messages';

export const SOURCE_CORPUS_CAPABILITIES = [
  'answer',
  'status',
  'sync',
  'search',
  'promotion_candidates',
] as const;

export type SourceCorpusCapability = (typeof SOURCE_CORPUS_CAPABILITIES)[number];

export interface SourceCorpusConfig {
  corpusId: string;
  sourceId: string;
  provider: string;
  family: SourceFamily;
  trustDomain: SourceTrustDomain;
  activationMode?: SourceIndexActivationMode;
  enabled?: boolean;
  capabilities: SourceCorpusCapability[];
  description?: string;
}

export interface SourceCorpusRegistryConfig {
  schemaVersion: 1;
  corpora: SourceCorpusConfig[];
}

export interface SourceCorpusRegistry {
  list(capability?: SourceCorpusCapability): SourceCorpusConfig[];
  ids(capability?: SourceCorpusCapability): string[];
  has(corpusId: string, capability?: SourceCorpusCapability): boolean;
  require(corpusId: string, capability: SourceCorpusCapability, paramName?: string): string;
  definitions(
    capability?: SourceCorpusCapability,
    fullDefinitions?: readonly SourceIndexCorpusDefinition[],
  ): SourceIndexCorpusDefinition[];
}

const DEFAULT_SOURCE_CORPORA: SourceCorpusConfig[] = [
  {
    corpusId: 'secure_local.email.private',
    sourceId: 'gmail.email',
    provider: 'gmail',
    family: 'email',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    capabilities: ['answer', 'status', 'sync', 'search'],
  },
  {
    corpusId: 'internal.email',
    sourceId: 'gmail.email',
    provider: 'gmail',
    family: 'email',
    trustDomain: 'internal',
    activationMode: 'hybrid_shadow',
    capabilities: ['answer', 'status', 'sync', 'search'],
  },
  {
    corpusId: 'internal.drive.docs',
    sourceId: 'google_drive.docs',
    provider: 'google_drive',
    family: 'file',
    trustDomain: 'internal',
    activationMode: 'hybrid_primary',
    capabilities: ['answer', 'status', 'sync', 'search'],
  },
  {
    corpusId: 'secure_local.drive.docs',
    sourceId: 'google_drive.docs',
    provider: 'google_drive',
    family: 'file',
    trustDomain: 'secure_local',
    activationMode: 'lexical_only',
    capabilities: ['answer', 'status', 'sync', 'search'],
    description: 'Secure-local Google Drive/Docs items raised by per-item sensitivity classification.',
  },
  {
    corpusId: 'internal.telegram.messages',
    sourceId: 'telegram.messages',
    provider: 'telegram',
    family: 'chat',
    trustDomain: 'internal',
    activationMode: 'hybrid_primary',
    capabilities: ['answer', 'status', 'sync', 'search'],
  },
  {
    corpusId: READWISE_LIBRARY_CORPUS_ID,
    sourceId: 'readwise.library',
    provider: 'readwise',
    family: 'readwise',
    trustDomain: 'internal',
    activationMode: 'lexical_only',
    capabilities: ['answer', 'status', 'sync'],
    description: 'S1/internal Readwise saved library. The former public-safe corpus id resolves here as an input alias.',
  },
  {
    corpusId: 'internal.x.bookmarks',
    sourceId: 'x.bookmarks',
    provider: 'x',
    family: 'x',
    trustDomain: 'internal',
    activationMode: 'hybrid_shadow',
    capabilities: ['answer', 'status', 'sync', 'search'],
  },
  {
    corpusId: 'secure_local.dropbox.files',
    sourceId: 'dropbox.files',
    provider: 'dropbox',
    family: 'file',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    capabilities: ['answer', 'status', 'sync', 'search', 'promotion_candidates'],
  },
  {
    corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    sourceId: 'telegram.messages',
    provider: 'telegram',
    family: 'chat',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_primary',
    capabilities: ['answer', 'status', 'sync', 'search'],
  },
  {
    corpusId: 'secure_local.whatsapp.messages',
    sourceId: 'whatsapp.personal.messages',
    provider: 'whatsapp',
    family: 'chat',
    trustDomain: 'secure_local',
    activationMode: 'hybrid_shadow',
    capabilities: ['status', 'sync', 'search', 'answer'],
    description: 'WhatsApp live capture (thin whatsmeow bridge -> shared scheduler -> connector store), including locally transcribed voice notes.',
  },
];

const DEFAULT_CAPABILITY_ORDER: Partial<Record<SourceCorpusCapability, readonly string[]>> = {
  answer: [
    'secure_local.email.private',
    'internal.email',
    'internal.drive.docs',
    'secure_local.drive.docs',
    'internal.telegram.messages',
    READWISE_LIBRARY_CORPUS_ID,
    'internal.x.bookmarks',
    'secure_local.dropbox.files',
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    'secure_local.whatsapp.messages',
  ],
  status: [
    'secure_local.email.private',
    'internal.email',
    'internal.drive.docs',
    'secure_local.drive.docs',
    'internal.telegram.messages',
    READWISE_LIBRARY_CORPUS_ID,
    'internal.x.bookmarks',
    'secure_local.dropbox.files',
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    'secure_local.whatsapp.messages',
  ],
  sync: [
    'internal.email',
    'secure_local.email.private',
    'internal.drive.docs',
    'secure_local.drive.docs',
    READWISE_LIBRARY_CORPUS_ID,
    'internal.x.bookmarks',
    'secure_local.dropbox.files',
    'internal.telegram.messages',
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  ],
  search: [
    'internal.email',
    'secure_local.email.private',
    'internal.drive.docs',
    'secure_local.drive.docs',
    'secure_local.dropbox.files',
    'internal.x.bookmarks',
    'internal.telegram.messages',
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  ],
  promotion_candidates: ['secure_local.dropbox.files'],
};

export function defaultSourceCorpusRegistryConfig(): SourceCorpusRegistryConfig {
  return {
    schemaVersion: SOURCE_CORPUS_REGISTRY_SCHEMA_VERSION,
    corpora: structuredClone(DEFAULT_SOURCE_CORPORA),
  };
}

export function createSourceCorpusRegistry(rawConfig?: unknown): SourceCorpusRegistry {
  const config = parseSourceCorpusRegistryConfig(rawConfig ?? defaultSourceCorpusRegistryConfig());
  return sourceCorpusRegistryFromConfig(config);
}

/**
 * The public view of a registry the permissive loader already accepted. It
 * narrows rather than rejects, because this is what renders the public tool
 * schema: parameterEnum builds every operation's schema in one map, so a throw
 * here erases the whole tool surface — argus_ping included — over one corpus
 * the caller never asked about. parsePublicSourceCorpusRegistryConfig keeps
 * rejecting for the public plugin-config path, where the operator wrote the
 * offending entry and can fix it.
 */
export function createPublicSourceCorpusRegistry(rawConfig?: unknown): SourceCorpusRegistry {
  const config = narrowSourceCorpusRegistryConfigToPublic(rawConfig ?? defaultSourceCorpusRegistryConfig());
  return sourceCorpusRegistryFromConfig(config);
}

function sourceCorpusRegistryFromConfig(config: SourceCorpusRegistryConfig): SourceCorpusRegistry {
  const active = config.corpora.filter((corpus) => corpus.enabled !== false);
  return {
    list(capability) {
      const selected = active.filter((corpus) => !capability || corpus.capabilities.includes(capability));
      return capability ? orderCorporaForCapability(selected, capability) : selected;
    },
    ids(capability) {
      return this.list(capability).map((corpus) => corpus.corpusId);
    },
    has(corpusId, capability) {
      const canonicalCorpusId = canonicalSourceCorpusId(corpusId);
      return this.list(capability).some((corpus) => corpus.corpusId === canonicalCorpusId);
    },
    require(corpusId, capability, paramName = 'corpus_id') {
      const canonicalCorpusId = canonicalSourceCorpusId(corpusId);
      if (this.has(canonicalCorpusId, capability)) return canonicalCorpusId;
      const allowed = this.ids(capability);
      throw new OperationError(
        'invalid_params',
        `${paramName} must be one of the configured ${capability} corpora: ${allowed.join(', ')}.`,
      );
    },
    definitions(capability, fullDefinitions = []) {
      const overrides = new Map<string, SourceIndexCorpusDefinition>();
      for (const definition of fullDefinitions) {
        if (overrides.has(definition.corpusId)) {
          throw new Error(`Duplicate full source-index corpus definition "${definition.corpusId}".`);
        }
        overrides.set(definition.corpusId, definition);
      }
      return this.list(capability).map((corpus) => (
        definitionForRegistryCorpus(corpus, overrides.get(corpus.corpusId))
      ));
    },
  };
}

/**
 * Pre-ruling ids remain input aliases only. Keeping them out of the configured
 * roster prevents duplicate default fan-out and ensures every status/result
 * surface reports one canonical corpus.
 */
export function canonicalSourceCorpusId(corpusId: string): string {
  if (corpusId === LEGACY_READWISE_LIBRARY_CORPUS_ID) return READWISE_LIBRARY_CORPUS_ID;
  if (corpusId === LEGACY_TELEGRAM_MESSAGES_CORPUS_ID) return PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID;
  return corpusId;
}

function definitionForRegistryCorpus(
  corpus: SourceCorpusConfig,
  fullDefinition: SourceIndexCorpusDefinition | undefined,
): SourceIndexCorpusDefinition {
  if (!fullDefinition) {
    return defineSourceIndexCorpus({
      corpusId: corpus.corpusId,
      family: corpus.family,
      trustDomain: corpus.trustDomain,
      ...(corpus.activationMode ? { activationMode: corpus.activationMode } : {}),
      ...(corpus.description ? { description: corpus.description } : {}),
    });
  }
  if (fullDefinition.family !== corpus.family || fullDefinition.trustDomain !== corpus.trustDomain) {
    throw new Error(
      `Full source-index corpus definition "${corpus.corpusId}" does not match its registry family/trust domain.`,
    );
  }
  if (corpus.activationMode && corpus.activationMode !== fullDefinition.activationMode) {
    return { ...fullDefinition, activationMode: corpus.activationMode };
  }
  return fullDefinition;
}

function orderCorporaForCapability(corpora: SourceCorpusConfig[], capability: SourceCorpusCapability): SourceCorpusConfig[] {
  const order = DEFAULT_CAPABILITY_ORDER[capability] ?? [];
  const byId = new Map(corpora.map((corpus) => [corpus.corpusId, corpus]));
  const ordered: SourceCorpusConfig[] = [];
  for (const corpusId of order) {
    const corpus = byId.get(corpusId);
    if (corpus) {
      ordered.push(corpus);
      byId.delete(corpusId);
    }
  }
  ordered.push(...corpora.filter((corpus) => byId.has(corpus.corpusId)));
  return ordered;
}

export function parseSourceCorpusRegistryConfig(rawConfig: unknown): SourceCorpusRegistryConfig {
  const root = asRecord(rawConfig);
  if (!root) {
    throw new OperationError('config_error', 'sourceIndex corpus registry must be an object.');
  }
  if (root.schemaVersion !== SOURCE_CORPUS_REGISTRY_SCHEMA_VERSION) {
    throw new OperationError('config_error', 'sourceIndex corpus registry schemaVersion must be 1.');
  }
  if (!Array.isArray(root.corpora)) {
    throw new OperationError('config_error', 'sourceIndex corpus registry requires a corpora array.');
  }
  const corpora = root.corpora.map(parseSourceCorpusConfig);
  const seen = new Set<string>();
  for (const corpus of corpora) {
    if (seen.has(corpus.corpusId)) {
      throw new OperationError('config_error', `Duplicate source-index corpus id "${corpus.corpusId}" in registry.`);
    }
    seen.add(corpus.corpusId);
  }
  return { schemaVersion: SOURCE_CORPUS_REGISTRY_SCHEMA_VERSION, corpora };
}

/**
 * The public v0.4 registry can narrow or disable shipped corpora, but cannot
 * register a new provider/source family or widen a corpus capability. Private
 * repository consumers retain parseSourceCorpusRegistryConfig for their own
 * explicitly non-public extension surface.
 */
export function parsePublicSourceCorpusRegistryConfig(rawConfig: unknown): SourceCorpusRegistryConfig {
  const config = parseSourceCorpusRegistryConfig(rawConfig);
  for (const corpus of config.corpora) {
    const { violation } = narrowSourceCorpusToPublic(corpus);
    if (violation) throw new OperationError('config_error', violation);
  }
  return config;
}

/**
 * Same declaration check, read as a filter: the public subset of a registry the
 * permissive parser accepted. Corpora v0.4 never declared drop out entirely,
 * and a declared corpus configured past its declared capabilities keeps only
 * the declared ones.
 */
function narrowSourceCorpusRegistryConfigToPublic(rawConfig: unknown): SourceCorpusRegistryConfig {
  const config = parseSourceCorpusRegistryConfig(rawConfig);
  return {
    schemaVersion: SOURCE_CORPUS_REGISTRY_SCHEMA_VERSION,
    corpora: config.corpora.flatMap((corpus) => {
      const publicCorpus = narrowSourceCorpusToPublic(corpus).corpus;
      return publicCorpus ? [publicCorpus] : [];
    }),
  };
}

const PUBLIC_SOURCE_IDS = new Set<string>(V0_4_PUBLIC_SOURCE_IDS);
const PUBLIC_CORPUS_DECLARATIONS = new Map(
  DEFAULT_SOURCE_CORPORA.map((corpus) => [corpus.corpusId, corpus] as const),
);

/**
 * The single declaration check both public readings share.
 *
 * `corpus` is the entry as the public surface may expose it, absent when
 * nothing of it is public. `violation` is why the configured entry is not
 * public verbatim. Both can be set at once: a declared corpus reaching past its
 * declared capabilities is a violation the strict parser refuses, and the
 * narrowed view keeps it under its declared capabilities.
 */
function narrowSourceCorpusToPublic(corpus: SourceCorpusConfig): {
  corpus?: SourceCorpusConfig;
  violation?: string;
} {
  if (!PUBLIC_SOURCE_IDS.has(corpus.sourceId)) {
    return {
      violation: `Public sourceIndex corpus ${corpus.corpusId} sourceId must be one of: ${V0_4_PUBLIC_SOURCE_IDS.join(', ')}.`,
    };
  }
  const declaration = PUBLIC_CORPUS_DECLARATIONS.get(corpus.corpusId);
  if (!declaration) {
    return { violation: `Public sourceIndex corpusId is not declared by v0.4: ${corpus.corpusId}.` };
  }
  for (const field of ['sourceId', 'provider', 'family', 'trustDomain'] as const) {
    if (corpus[field] !== declaration[field]) {
      return {
        violation: `Public sourceIndex corpus ${corpus.corpusId} ${field} must be ${declaration[field]}.`,
      };
    }
  }
  const declaredCapabilities = new Set<SourceCorpusCapability>(declaration.capabilities);
  const widened = corpus.capabilities.filter((capability) => !declaredCapabilities.has(capability));
  if (widened.length === 0) return { corpus };
  const narrowed = corpus.capabilities.filter((capability) => declaredCapabilities.has(capability));
  return {
    violation: `Public sourceIndex corpus ${corpus.corpusId} cannot add capabilities: ${widened.join(', ')}.`,
    ...(narrowed.length > 0 ? { corpus: { ...corpus, capabilities: narrowed } } : {}),
  };
}

function parseSourceCorpusConfig(value: unknown): SourceCorpusConfig {
  const record = asRecord(value);
  if (!record) {
    throw new OperationError('config_error', 'sourceIndex corpus entries must be objects.');
  }
  const corpusId = canonicalSourceCorpusId(requiredString(record.corpusId, 'sourceIndex corpusId'));
  const sourceId = requiredString(record.sourceId, `sourceIndex corpus ${corpusId} sourceId`);
  const provider = requiredString(record.provider, `sourceIndex corpus ${corpusId} provider`);
  const family = requiredEnum(record.family, SOURCE_FAMILIES, `sourceIndex corpus ${corpusId} family`) as SourceFamily;
  const trustDomain = requiredEnum(record.trustDomain, SOURCE_TRUST_DOMAINS, `sourceIndex corpus ${corpusId} trustDomain`) as SourceTrustDomain;
  const activationMode = record.activationMode === undefined
    ? undefined
    : requiredEnum(
        record.activationMode,
        SOURCE_INDEX_ACTIVATION_MODES,
        `sourceIndex corpus ${corpusId} activationMode`,
      ) as SourceIndexActivationMode;
  if (!Array.isArray(record.capabilities)) {
    throw new OperationError('config_error', `sourceIndex corpus ${corpusId} capabilities must be an array.`);
  }
  const capabilities = [...new Set(record.capabilities.map((capability) => (
    requiredEnum(capability, SOURCE_CORPUS_CAPABILITIES, `sourceIndex corpus ${corpusId} capability`) as SourceCorpusCapability
  )))];
  if (capabilities.length === 0) {
    throw new OperationError('config_error', `sourceIndex corpus ${corpusId} must enable at least one capability.`);
  }
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new OperationError('config_error', `sourceIndex corpus ${corpusId} enabled must be boolean when provided.`);
  }
  return {
    corpusId,
    sourceId,
    provider,
    family,
    trustDomain,
    ...(activationMode ? { activationMode } : {}),
    ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
    capabilities,
    ...(typeof record.description === 'string' && record.description.trim()
      ? { description: record.description.trim() }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OperationError('config_error', `${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredEnum(value: unknown, allowed: readonly string[], label: string): string {
  if (typeof value === 'string' && allowed.includes(value)) return value;
  throw new OperationError('config_error', `${label} must be one of: ${allowed.join(', ')}.`);
}
