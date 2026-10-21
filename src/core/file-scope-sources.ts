/**
 * The one registry of folder-scoped file sources.
 *
 * A source that lets a person pick which folders Olympus may read adds one
 * definition here instead of widening a union and branching in every consumer.
 * Scope approval, the picker, the read filters and the scheduler all read the
 * definition. This file is pure data: the picker's browser factory lives with
 * the other workers (`workers/source-scope-browser.ts`), and the mapping from a
 * family to connector-store filter keys lives with the filters
 * (`workers/source-scope-runtime.ts`).
 *
 * An unknown source id is never valid: persisted scope state that names one is
 * rejected as malformed, so a source that is not registered can never be read
 * as approved.
 */

/**
 * How a source's scope keys address its items in the connector store:
 * `locator_path` keys are normalized paths matched against the item locator;
 * `folder_id` keys are provider folder identities matched against the item's
 * folder ancestry.
 */
export type FileScopeFilterFamily = 'locator_path' | 'folder_id';

export interface FileScopeSourceDefinition {
  sourceId: string;
  /** The connector-store provider label of this source's items. */
  provider: string;
  /**
   * `provider_account`: scope binds to a connected provider credential.
   * `this_computer`: no credential; scope binds to this install's machine id
   * (`core/this-computer.ts`).
   */
  account: 'provider_account' | 'this_computer';
  /** The credential capability that connects the source. Required for `provider_account`. */
  credentialCapability?: string;
  /** Environment variable that pins the one credential handle this source reads. */
  pinEnvName?: string;
  /** Corpora whose unsettled extraction jobs are invalidated when the scope is re-approved. */
  corpusIdsToInvalidate: readonly string[];
  filterFamily: FileScopeFilterFamily;
  /** Applied to every selection key before it is verified and saved. */
  normalizeKey(key: string): string;
  /** Lowercase keys that name the provider root and may be selected only as Whole account. */
  rootKeys: readonly string[];
  /** The dashboard's name for the source. */
  label: string;
  /** The ingestion-disposition source id the dashboard files its exclusions under. */
  dispositionSourceId: string;
}

const definitions = new Map<string, FileScopeSourceDefinition>();
const builtInIds = new Set<string>();

export function registerFileScopeSource(definition: FileScopeSourceDefinition): void {
  const { sourceId, provider } = definition;
  if (!sourceId || !provider) throw new Error('A file-scope source needs a source id and a provider.');
  if (definition.account === 'provider_account' && !definition.credentialCapability) {
    throw new Error(`File-scope source ${sourceId} binds to a provider account and needs a credential capability.`);
  }
  if (definition.account === 'this_computer' && definition.credentialCapability) {
    throw new Error(`File-scope source ${sourceId} binds to this computer and must not name a credential capability.`);
  }
  if (definitions.has(sourceId)) throw new Error(`File-scope source ${sourceId} is already registered.`);
  for (const other of definitions.values()) {
    if (other.provider === provider) {
      throw new Error(`File-scope provider ${provider} is already registered by ${other.sourceId}.`);
    }
  }
  definitions.set(sourceId, definition);
}

/** Removes a definition added after load (tests, or a source that withdraws). Built-ins stay. */
export function unregisterFileScopeSource(sourceId: string): boolean {
  if (builtInIds.has(sourceId)) return false;
  return definitions.delete(sourceId);
}

export function getFileScopeSource(sourceId: string): FileScopeSourceDefinition | undefined {
  return definitions.get(sourceId);
}

export function requireFileScopeSource(sourceId: string): FileScopeSourceDefinition {
  const definition = definitions.get(sourceId);
  if (!definition) throw new Error(`Unknown file-scope source: ${sourceId}`);
  return definition;
}

export function listFileScopeSources(): FileScopeSourceDefinition[] {
  return [...definitions.values()];
}

export function fileScopeSourceForProvider(provider: string): FileScopeSourceDefinition | undefined {
  return listFileScopeSources().find((definition) => definition.provider === provider);
}

/** The capability a source's connected handle carries (synthesized for a source with no credential). */
export function fileScopeSourceCapability(definition: FileScopeSourceDefinition): string {
  return definition.credentialCapability ?? `${definition.sourceId}.this_computer`;
}

/** True when `key` names the provider root of `definition`. */
export function isFileScopeRootKey(definition: FileScopeSourceDefinition, key: string): boolean {
  return definition.rootKeys.includes(key.toLowerCase());
}

function registerBuiltIn(definition: FileScopeSourceDefinition): void {
  registerFileScopeSource(definition);
  builtInIds.add(definition.sourceId);
}

registerBuiltIn({
  sourceId: 'google_drive.docs',
  provider: 'google_drive',
  account: 'provider_account',
  credentialCapability: 'google_drive.docs.sync',
  pinEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE',
  corpusIdsToInvalidate: ['internal.drive.docs', 'secure_local.drive.docs'],
  filterFamily: 'folder_id',
  normalizeKey: (key) => key.trim(),
  rootKeys: ['/', 'root'],
  label: 'Google Drive',
  dispositionSourceId: 'google_drive.personal',
});

registerBuiltIn({
  sourceId: 'dropbox.files',
  provider: 'dropbox',
  account: 'provider_account',
  credentialCapability: 'dropbox.files.sync',
  pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
  corpusIdsToInvalidate: ['secure_local.dropbox.files'],
  filterFamily: 'locator_path',
  normalizeKey: (key) => key.trim().toLowerCase(),
  rootKeys: ['/'],
  label: 'Dropbox',
  dispositionSourceId: 'dropbox.personal',
});

registerBuiltIn({
  sourceId: 'local.files',
  provider: 'local_files',
  account: 'this_computer',
  corpusIdsToInvalidate: ['secure_local.local.files'],
  filterFamily: 'locator_path',
  // Paths keep their case: a case-sensitive disk can hold two names that differ only by it.
  normalizeKey: (key) => {
    const trimmed = key.trim().normalize('NFC');
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed;
  },
  rootKeys: ['/'],
  label: 'Files on this computer',
  dispositionSourceId: 'local.files',
});
