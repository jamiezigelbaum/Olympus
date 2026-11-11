import { hasFolderLayout } from '../../../core/source-placement.ts';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  type ConnectorStoreChatPrincipal,
  type ConnectorStoreDeclaredPrincipal,
} from '../index.ts';
import {
  type LocalConnectorStore,
  defineConnectorCorpus,
} from '../../connector-store/index.ts';
import { canonicalConnectorStoreChatPrincipal } from '../../connector-store/principal.ts';
import {
  openConnectorStore,
  storageAccountForCorpus,
  type StoreFileOwner,
} from '../../../core/source-storage.ts';
import { assertStoreTierLedgerCanOpen } from '../../classification/tier-set-binding.ts';
import {
  SOURCE_FAMILIES,
  SOURCE_TRUST_DOMAINS,
} from '../../../core/source-index/types.ts';
import { writableStoreOpensForbidden } from '../../../core/store-write-guard.ts';

export interface ConnectorStoreMount {
  store: LocalConnectorStore;
  principal?: ConnectorStoreDeclaredPrincipal;
  chatPrincipal?: ConnectorStoreChatPrincipal;
}

export interface ConnectorStoreMountParsingOptions {
  /** A runtime read declaration waits for ingestion to create its store. */
  existingOnly?: boolean;
  reportFailure?: (message: string) => void;
  collidingStores?: readonly LocalConnectorStore[];
  /**
   * The corpus registry's corpora: a declaration names no source, so its
   * account is the source registered for its corpus (`storageAccountForCorpus`).
   */
  registeredCorpora?: ReadonlyArray<{ corpusId: string; sourceId: string }>;
  /**
   * The source each known store file belongs to (the data lifecycle's
   * inventory), found by the file rather than the path's spelling. A
   * declaration over another source's file opens under that source's account,
   * so a lane withheld because its account is being deleted cannot be
   * reopened under another corpus id or another spelling of its path.
   */
  storeOwner?: StoreFileOwner;
}

interface ValidatedConnectorStoreMountDeclaration {
  /** Absent, or ignored, for a source whose stores the engine places (core/source-placement.ts `hasFolderLayout`). */
  dbPath?: string;
  corpusId: string;
  family: Parameters<typeof defineConnectorCorpus>[0]['family'];
  trustDomain: Parameters<typeof defineConnectorCorpus>[0]['trustDomain'];
  principal?: ConnectorStoreDeclaredPrincipal;
  chatPrincipal?: ConnectorStoreChatPrincipal;
}

export function parseConnectorStoreMountsFromEnv(
  raw: string | undefined,
  options: ConnectorStoreMountParsingOptions = {},
): ConnectorStoreMount[] {
  return mountConnectorStoreDeclarations(compileConnectorStoreMountDeclarations(raw, options), options);
}

/**
 * Compile fixed configuration once; only pending absent files need probes on
 * reads. A store whose file exists but fails to mount (an account mid-deletion,
 * say) is retried on a bounded backoff, so it is found without a roster change
 * or restart while repeated reads still skip the ownership scan. Each store's
 * failure is logged once until its message changes or it mounts.
 */
export function createConnectorStoreMountDiscovery(raw: string | undefined, options: {
  stores(): readonly LocalConnectorStore[];
  registeredCorpora(): NonNullable<ConnectorStoreMountParsingOptions['registeredCorpora']>;
  storeOwner(): StoreFileOwner;
  reportFailure?(message: string): void;
  now?(): number;
}): () => ConnectorStoreMount[] {
  // Local, not module-level: startup runs this factory while the module is
  // paused at the entrypoint's top-level await, before later bindings exist.
  const retryBaseMs = 5_000;
  const retryMaxMs = 10 * 60_000;
  const reported = new Map<string, string>();
  const reportFailure = (message: string): void => {
    const label = message.split(' skipped:')[0]!;
    if (reported.get(label) === message) return;
    reported.set(label, message);
    (options.reportFailure ?? console.error)(message);
  };
  const now = options.now ?? Date.now;
  const declarations = compileConnectorStoreMountDeclarations(raw, { reportFailure });
  const registeredCorpora = options.registeredCorpora();
  let previousStores: readonly LocalConnectorStore[] | undefined;
  let pending: readonly ValidatedConnectorStoreMountDeclaration[] = declarations;
  const failed = new Map<ValidatedConnectorStoreMountDeclaration, { attempts: number; retryAt: number }>();
  return () => {
    const stores = options.stores();
    if (!previousStores || previousStores.length !== stores.length || stores.some((store, i) => store !== previousStores![i])) {
      pending = declarations;
      previousStores = [...stores];
    }
    const time = now();
    const due = [...failed].filter(([declaration, failure]) => failure.retryAt <= time && !pending.includes(declaration));
    const candidates = due.length ? [...pending, ...due.map(([declaration]) => declaration)] : pending;
    if (!candidates.length) return [];
    const byCorpus = new Map(stores.map(store => [store.corpusId, store]));
    const ready: ValidatedConnectorStoreMountDeclaration[] = [];
    const absent: ValidatedConnectorStoreMountDeclaration[] = [];
    for (const declaration of candidates) {
      const placed = hasFolderLayout(storageAccountForCorpus(declaration, registeredCorpora).sourceId);
      if (byCorpus.has(declaration.corpusId) || (!placed && (!declaration.dbPath || existsSync(declaration.dbPath)))) ready.push(declaration);
      else absent.push(declaration);
    }
    pending = absent;
    if (!ready.length) return [];
    const mounts = mountConnectorStoreDeclarations(ready, {
      existingOnly: true, collidingStores: stores, registeredCorpora: options.registeredCorpora(),
      storeOwner: options.storeOwner(), reportFailure,
    });
    const mounted = new Set(mounts.map(mount => mount.store.corpusId));
    for (const declaration of ready) {
      if (mounted.has(declaration.corpusId)) {
        failed.delete(declaration);
        reported.delete(`Connector-store mount ${declaration.corpusId}`);
        continue;
      }
      const attempts = (failed.get(declaration)?.attempts ?? 0) + 1;
      const delay = Math.min(retryBaseMs * 2 ** Math.min(attempts - 1, 30), retryMaxMs);
      failed.set(declaration, { attempts, retryAt: time + delay });
    }
    return mounts;
  };
}

function compileConnectorStoreMountDeclarations(
  raw: string | undefined,
  options: ConnectorStoreMountParsingOptions,
): ValidatedConnectorStoreMountDeclaration[] {
  const value = raw?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be a JSON array.');
  }

  const reportFailure = options.reportFailure ?? ((message: string) => console.error(message));
  const declarations: ValidatedConnectorStoreMountDeclaration[] = [];
  // Validate every declaration before opening any SQLite store. A malformed
  // later entry therefore cannot strand a handle opened for an earlier one.
  for (const [index, entry] of parsed.entries()) {
    const declaredCorpusIdValue = entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).corpusId
      : undefined;
    const declaredCorpusId = typeof declaredCorpusIdValue === 'string'
      ? declaredCorpusIdValue.trim()
      : '';
    try {
      declarations.push(validateConnectorStoreMountDeclaration(entry));
    } catch (error) {
      const label = declaredCorpusId || `entry #${index + 1}`;
      const detail = error instanceof Error ? error.message : String(error);
      reportFailure(`Connector-store mount ${label} skipped: ${detail}`);
    }
  }

  return declarations;
}

function mountConnectorStoreDeclarations(
  declarations: readonly ValidatedConnectorStoreMountDeclaration[],
  options: ConnectorStoreMountParsingOptions,
): ConnectorStoreMount[] {
  const reportFailure = options.reportFailure ?? ((message: string) => console.error(message));
  const collidingStoresByCorpusId = new Map(
    (options.collidingStores ?? []).map((store) => [store.corpusId, store]),
  );
  // The resource being fenced is the SQLite file, and corpusId is the field an
  // operator varies when adding a mount. Keyed on corpusId alone, a new id over
  // an existing dbPath skips the identity check entirely and opens a second
  // handle that relabels the same rows with a different family/trustDomain.
  const ownerCorpusIdByDbPath = new Map(
    (options.collidingStores ?? []).map((store) => [store.dbPath, store.corpusId]),
  );
  const mounts: ConnectorStoreMount[] = [];
  for (const declaration of declarations) {
    try {
      const collidingStore = collidingStoresByCorpusId.get(declaration.corpusId);
      // A source whose stores the engine places names no path here (source
      // storage step 6): its declaration only adds a principal to the store
      // its lane opened, and a dbPath it carries is ignored.
      if (hasFolderLayout(storageAccountForCorpus(declaration, options.registeredCorpora).sourceId)) {
        if (!collidingStore) {
          if (options.existingOnly) continue;
          throw new Error('its source keeps its stores where Olympus places them; a declaration can only add a principal to the store its lane opened, and that lane is not open.');
        }
        const { dbPath: _ignored, ...placed } = declaration;
        assertConnectorStoreMountIdentity(placed, collidingStore);
        mounts.push({
          store: collidingStore,
          ...(declaration.principal ? { principal: declaration.principal } : {}),
          ...(declaration.chatPrincipal ? { chatPrincipal: declaration.chatPrincipal } : {}),
        });
        continue;
      }
      if (!declaration.dbPath) throw new Error('Connector store entries require dbPath, corpusId, family, trustDomain.');
      if (collidingStore) assertConnectorStoreMountIdentity(declaration, collidingStore);
      if (options.existingOnly && !collidingStore && !existsSync(declaration.dbPath)) continue;
      const pathOwnerCorpusId = ownerCorpusIdByDbPath.get(declaration.dbPath);
      if (pathOwnerCorpusId !== undefined && pathOwnerCorpusId !== declaration.corpusId) {
        throw new Error(
          `dbPath ${JSON.stringify(declaration.dbPath)} is already mounted as corpus ${JSON.stringify(pathOwnerCorpusId)}.`,
        );
      }
      // An account that may not be opened throws here, and the declaration
      // is skipped and reported like any other that cannot mount.
      const owner = options.storeOwner?.(declaration.dbPath);
      const account = owner ? { sourceId: owner } : storageAccountForCorpus(declaration, options.registeredCorpora);
      if (!collidingStore) assertStoreTierLedgerCanOpen(declaration.dbPath, writableStoreOpensForbidden());
      const store = collidingStore ?? openConnectorStore(account, {
        dbPath: declaration.dbPath,
        corpusId: declaration.corpusId,
        family: declaration.family,
        trustDomain: declaration.trustDomain,
      });
      ownerCorpusIdByDbPath.set(declaration.dbPath, declaration.corpusId);
      mounts.push({
        store,
        ...(declaration.principal ? { principal: declaration.principal } : {}),
        ...(declaration.chatPrincipal ? { chatPrincipal: declaration.chatPrincipal } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reportFailure(`Connector-store mount ${declaration.corpusId} skipped: ${detail}`);
    }
  }
  return mounts;
}

// Exact string equality on dbPath is deliberate (R49). Normalizing
// (realpath/resolve) could silently ACCEPT a declaration for a different
// file behind a symlink or `..` variant — the exact defect this reconcile
// exists to prevent. A lexically divergent path to the same file fails
// closed and loud: the declaration is skipped whole and its principal
// never registers.
function assertConnectorStoreMountIdentity(
  declaration: ValidatedConnectorStoreMountDeclaration,
  store: LocalConnectorStore,
): void {
  const mismatches = [
    ...(declaration.dbPath === undefined || declaration.dbPath === store.dbPath
      ? []
      : [`dbPath ${JSON.stringify(declaration.dbPath)} does not match lane ${JSON.stringify(store.dbPath)}`]),
    ...(declaration.family === store.family
      ? []
      : [`family ${JSON.stringify(declaration.family)} does not match lane ${JSON.stringify(store.family)}`]),
    ...(declaration.trustDomain === store.trustDomain
      ? []
      : [`trustDomain ${JSON.stringify(declaration.trustDomain)} does not match lane ${JSON.stringify(store.trustDomain)}`]),
  ];
  if (mismatches.length > 0) {
    throw new Error(`declaration conflicts with the lane store: ${mismatches.join('; ')}.`);
  }
}

function validateConnectorStoreMountDeclaration(entry: unknown): ValidatedConnectorStoreMountDeclaration {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Each connector store entry must be an object.');
  }
  const record = entry as Record<string, unknown>;
  const dbPath = typeof record.dbPath === 'string' ? record.dbPath.trim() : '';
  const corpusId = typeof record.corpusId === 'string' ? record.corpusId.trim() : '';
  const family = typeof record.family === 'string' ? record.family.trim() : '';
  const trustDomain = typeof record.trustDomain === 'string' ? record.trustDomain.trim() : '';
  if (!corpusId || !family || !trustDomain) {
    throw new Error('Connector store entries require dbPath, corpusId, family, trustDomain.');
  }
  if (dbPath && !isAbsolute(dbPath)) {
    throw new Error('Connector store dbPath must be absolute.');
  }
  // Both enums are checked before the casts below. Every secure gate in this
  // worker is exact equality against 'secure_local', so a typo'd domain does
  // not degrade the mount — it silently leaves the secure band entirely.
  if (!isDeclarableSourceFamily(family)) {
    throw new Error(
      `Connector store family must be one of: ${SOURCE_FAMILIES.join(', ')} (or an "x-" extension id).`,
    );
  }
  if (!isDeclarableSourceTrustDomain(trustDomain)) {
    throw new Error(
      `Connector store trustDomain must be one of: ${SOURCE_TRUST_DOMAINS.join(', ')} (or an "x-" extension id).`,
    );
  }
  const hasPrincipalProvider = Object.prototype.hasOwnProperty.call(record, 'principalProvider');
  const hasPrincipalAccountScope = Object.prototype.hasOwnProperty.call(record, 'principalAccountScope');
  if (hasPrincipalProvider !== hasPrincipalAccountScope) {
    throw new Error('Connector store principal identity requires both principalProvider and principalAccountScope.');
  }
  let chatPrincipal: ConnectorStoreChatPrincipal | undefined;
  let principal: ConnectorStoreDeclaredPrincipal | undefined;
  if (hasPrincipalProvider && hasPrincipalAccountScope) {
    principal = canonicalConnectorStoreChatPrincipal(
      record.principalProvider,
      record.principalAccountScope,
    );
    if (family === 'chat') chatPrincipal = principal;
  }
  return {
    ...(dbPath ? { dbPath } : {}),
    corpusId,
    family: family as Parameters<typeof defineConnectorCorpus>[0]['family'],
    trustDomain: trustDomain as Parameters<typeof defineConnectorCorpus>[0]['trustDomain'],
    ...(principal ? { principal } : {}),
    ...(chatPrincipal ? { chatPrincipal } : {}),
  };
}

function isSourceIndexExtensionId(value: string): boolean {
  return value.startsWith('x-') && value.length > 2;
}

function isDeclarableSourceFamily(value: string): boolean {
  return (SOURCE_FAMILIES as readonly string[]).includes(value) || isSourceIndexExtensionId(value);
}

function isDeclarableSourceTrustDomain(value: string): boolean {
  return (SOURCE_TRUST_DOMAINS as readonly string[]).includes(value) || isSourceIndexExtensionId(value);
}

export function mergeConnectorStores(stores: readonly LocalConnectorStore[]): LocalConnectorStore[] {
  const byCorpusId = new Map<string, LocalConnectorStore>();
  for (const store of stores) {
    if (!byCorpusId.has(store.corpusId)) {
      byCorpusId.set(store.corpusId, store);
    }
  }
  return [...byCorpusId.values()];
}
