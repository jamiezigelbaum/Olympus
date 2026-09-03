import type { SourceFamily, SourceItemIdentity } from '../../core/source-index/types.ts';
import { isCanonicalConnectorStoreProvider } from './principal.ts';

export interface ConnectorStoreFolderFilterCodec {
  folderIdExactLine(value: string): string;
  folderNameExactLine(value: string): string;
}

export interface ConnectorStoreConversationTitleCandidate {
  conversationId: string;
  title: string;
}

export interface ConnectorStoreConversationTitleCandidates {
  candidates: readonly ConnectorStoreConversationTitleCandidate[];
  truncated: boolean;
}

export interface ConnectorStoreChatScopeResolution {
  conversationId: string;
  resolved: boolean;
  kind: 'structured' | 'title' | 'invalid';
  provider?: string;
  accountScope?: string;
}

export interface ConnectorStoreChatScopeFilterCodec {
  resolveConversationId(
    value: string,
    readTitleCandidates: (lookupTerms: readonly string[]) => ConnectorStoreConversationTitleCandidates,
  ): ConnectorStoreChatScopeResolution;
}

export type ConnectorStoreApprovedScopeResolution =
  | Readonly<{
      kind: 'path';
      accountScope: string;
      locatorPath: string;
    }>
  | Readonly<{
      kind: 'invalid';
      message: string;
    }>;

export interface ConnectorStoreApprovedScopeFilterCodec {
  resolveLocatorPath(
    value: string,
    principal: Readonly<{ provider: string; accountScope: string }>,
  ): ConnectorStoreApprovedScopeResolution;
}

export interface ConnectorStoreResultProjectionInput {
  sourceItem: SourceItemIdentity;
  /** Lazy exact-identity/current-eligibility lookup. The codec alone decides whether to read it. */
  readLocatorUri(): string | undefined;
}

export interface ConnectorStoreResultProjector {
  project(input: ConnectorStoreResultProjectionInput): Readonly<Record<string, unknown>> | undefined;
}

export interface ConnectorStoreResultProjectorCodec {
  create(input: Readonly<{
    principal: Readonly<{ provider: string; accountScope: string }>;
    approvedScopeKey?: string;
  }>): ConnectorStoreResultProjector;
}

const CONNECTOR_STORE_CORE_SEARCH_REQUEST_FIELDS = [
  'corpus_id',
  'query',
  'retrieval_mode',
  'max_results',
  'account',
  'conversation_id',
  'sender_id',
  'sender_label',
  'authored_after',
  'authored_before',
  'after',
  'before',
  'trust_domain',
] as const;

export const CONNECTOR_STORE_DECLARED_FILTER_FIELDS = [
  'approved_scope_key',
  'chat_scope',
  'participant_id',
  'include_deleted',
  'attachment_type',
  'include_locators',
  'chat_title',
  'chat_title_hint',
  'folder_id',
  'folder_name',
] as const;

export type ConnectorStoreDeclaredFilterField =
  typeof CONNECTOR_STORE_DECLARED_FILTER_FIELDS[number];

const CONNECTOR_STORE_SEARCH_REQUEST_FIELDS = new Set<string>([
  ...CONNECTOR_STORE_CORE_SEARCH_REQUEST_FIELDS,
  ...CONNECTOR_STORE_DECLARED_FILTER_FIELDS,
]);

export interface ConnectorStoreFamilyFilterCapabilities {
  folder?: ConnectorStoreFolderFilterCodec;
  chatScope?: ConnectorStoreChatScopeFilterCodec;
  approvedScope?: ConnectorStoreApprovedScopeFilterCodec;
  resultProjector?: ConnectorStoreResultProjectorCodec;
}

export type ConnectorStoreFilterCapabilityScope =
  | Readonly<{ family: SourceFamily }>
  | Readonly<{ family: SourceFamily; provider: string }>;

export interface ConnectorStoreFilterCapabilityIdentity {
  family: SourceFamily;
  /** Declared by the mounted corpus configuration; never inferred from rows. */
  provider?: string;
}

export interface ConnectorStoreFilterCapabilityRegistry {
  resolve(identity: ConnectorStoreFilterCapabilityIdentity): ConnectorStoreFamilyFilterCapabilities | undefined;
}

export function connectorStoreFilterCapabilityRegistry(
  entries: readonly (
    readonly [ConnectorStoreFilterCapabilityScope, ConnectorStoreFamilyFilterCapabilities]
  )[],
): ConnectorStoreFilterCapabilityRegistry {
  const familyEntries = new Map<SourceFamily, ConnectorStoreFamilyFilterCapabilities>();
  const providerEntries = new Map<string, ConnectorStoreFamilyFilterCapabilities>();
  for (const [scope, capabilities] of entries) {
    const provider = 'provider' in scope ? scope.provider : undefined;
    if (provider !== undefined && !isCanonicalConnectorStoreProvider(provider)) {
      throw new Error(
        `Connector-store capability provider scope ${JSON.stringify(provider)} in family ${JSON.stringify(scope.family)} must be a canonical lowercase provider id with no whitespace.`,
      );
    }
    const registry = provider === undefined ? familyEntries : providerEntries;
    const key = provider === undefined ? scope.family : providerScopeKey(scope.family, provider);
    if (registry.has(key)) {
      const label = provider === undefined
        ? `family "${scope.family}"`
        : `provider "${provider}" in family "${scope.family}"`;
      throw new Error(`Connector-store filter capabilities are duplicated for ${label}.`);
    }
    registry.set(key, Object.freeze({ ...capabilities }));
  }
  return Object.freeze({
    resolve(identity: ConnectorStoreFilterCapabilityIdentity) {
      const familyCapabilities = familyEntries.get(identity.family);
      const providerCapabilities = identity.provider === undefined
        ? undefined
        : providerEntries.get(providerScopeKey(identity.family, identity.provider));
      if (!familyCapabilities) return providerCapabilities;
      if (!providerCapabilities) return familyCapabilities;
      return Object.freeze({ ...familyCapabilities, ...providerCapabilities });
    },
  });
}

function providerScopeKey(family: SourceFamily, provider: string): string {
  return `${family}\u0000${provider}`;
}

export function undeclaredConnectorStoreSearchRequestFields(
  record: Readonly<Record<string, unknown>>,
): string[] {
  return Object.keys(record)
    .filter((field) => !CONNECTOR_STORE_SEARCH_REQUEST_FIELDS.has(field))
    .sort();
}

export function unsupportedConnectorStoreFilterFields(
  record: Readonly<Record<string, unknown>>,
  capabilities: ConnectorStoreFamilyFilterCapabilities | undefined,
): ConnectorStoreDeclaredFilterField[] {
  return CONNECTOR_STORE_DECLARED_FILTER_FIELDS.filter((field) => {
    if (!Object.prototype.hasOwnProperty.call(record, field)) return false;
    if ((field === 'folder_id' || field === 'folder_name') && capabilities?.folder) {
      return false;
    }
    if (field === 'chat_scope' && capabilities?.chatScope) return false;
    if (field === 'approved_scope_key' && capabilities?.approvedScope) return false;
    if (field === 'include_locators' && capabilities?.resultProjector) return false;
    return true;
  });
}
