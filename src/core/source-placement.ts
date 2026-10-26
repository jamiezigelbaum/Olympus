/**
 * Where an account's files live: the registry's `layout` for an account it
 * lists, else what the account would be given if it were recorded now
 * (docs/design/source-storage.md, "Registry" and delivery step 4a).
 *
 * The decision is a pure function of the registry, the file system and the
 * environment, so every process that asks while the account has no entry (the
 * worker before adoption, the CLI, a script) reaches the same answer, and
 * none of them writes. Only the worker, which holds the owner lock, records
 * the answer, through adoption (core/source-storage.ts), before it creates a
 * file. From then on the entry is the answer.
 *
 * An account with no entry is placed in a folder only when nothing says it
 * already lives somewhere else:
 *
 * - its source has a folder layout at all (not Reflect or Roam, whose mounts
 *   name their paths);
 * - for messaging, no capture path env pins it and the Gateway-run service
 *   does not own its capture (that service reads its paths, plugin config
 *   included, and the account stays where they are). No per-store path
 *   override exists any more, and a connector-store mount of a source with a
 *   folder layout names no path (delivery step 6);
 * - no file of the source exists at any legacy location (stores, tier
 *   sidecars, `-wal`/`-shm`, raw state, and for messaging the capture
 *   session, spool and state; lock files do not count);
 * - every legacy location can be looked at: a folder the process may not
 *   search, or a dangling link, places it `legacy` rather than risk opening a
 *   second, empty set of stores beside data it cannot see.
 *
 * Deliberately light, like the registry: no SQLite and no workers.
 */
import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  secretLocationsPathForStore,
  tierLedgerPathForStore,
  tierSnifferPathForStore,
} from '../workers/classification/tier-ledger-path.ts';
import { archiveImportFamilies, isArchiveCorpusId } from './archive-formats.ts';
import {
  FOLDER_LAYOUT_SOURCES,
  hasLegacyLayout,
  accountExtractionSpoolRoot,
  accountFolder,
  accountRawPath,
  accountStoreNames,
  accountStorePath,
  legacyAccountPaths,
  legacyWhatsAppDefaultStateDir,
  legacyOverrideEnvNames,
  extractionSpoolRoot,
  nativeCaptureOwnerPin,
  olympusDataRoot,
  TELEGRAM_SOURCE_ID,
  WHATSAPP_SOURCE_ID,
  type AccountRawName,
  type LayoutAccount,
  type LayoutAccountLayout,
  type LayoutEnv,
} from './olympus-layout.ts';
import { captureGrantPathFromEnv, captureGrantSessionEvidence } from './messaging-capture-grant-file.ts';
import { defaultSourceCorpusRegistryConfig, type SourceCorpusConfig } from './source-corpus-registry.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry, sourceAccountMovePending, SourceRegistryError } from './source-registry.ts';

const ARCHIVE_IMPORTS_SOURCE_ID = 'archive.imports';
const MOUNTS_ENV = 'OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON';

/** Whether a source's files have a folder layout. Everything else stays `legacy`. */
export function hasFolderLayout(sourceId: string): boolean {
  return FOLDER_LAYOUT_SOURCES.includes(sourceId);
}

export interface AccountLayoutDecision {
  layout: LayoutAccountLayout;
  /** Why, in a few words: for diagnostics and tests. */
  why: string;
}

/**
 * The layout a new account of this source gets: `folder` only when nothing
 * pins or already holds its files (see the module comment). Reads the file
 * system, writes nothing.
 */
export function decideAccountLayout(sourceId: string, env: LayoutEnv = process.env): AccountLayoutDecision {
  if (!hasFolderLayout(sourceId)) return { layout: 'legacy', why: 'its source has no folder layout' };
  if (!hasLegacyLayout(sourceId)) return { layout: 'folder', why: 'its source never had legacy paths' };
  const pin = pinnedLegacyBy(sourceId, env);
  if (pin) return { layout: 'legacy', why: `${pin} pins its files` };
  const root = dataRootState(env);
  if (root === 'unreadable') return { layout: 'legacy', why: 'the data folder cannot be looked at' };
  // Not skipped for a data folder that is not there: messaging keeps files outside it.
  const existing = legacyFilesState(sourceId, env);
  if (existing === 'present') return { layout: 'legacy', why: 'its files are already at the legacy paths' };
  if (existing === 'unreadable') return { layout: 'legacy', why: 'a legacy path cannot be looked at' };
  return { layout: 'folder', why: root === 'absent' ? 'nothing is stored yet' : 'new account with no legacy files' };
}

/**
 * The account as the resolvers need it: the registry's entry for it, else the
 * layout a new one would get. A registry that cannot be read says nothing, so
 * what is on disk decides: an account with a folder is `folder`, every other
 * resolves to the paths that were always there. The storage service refuses to
 * open anything until the registry is repaired; this only lets a delete or an
 * export find the files that exist.
 */
export function placedAccount(
  sourceId: string,
  env: LayoutEnv = process.env,
  slot: string = DEFAULT_ACCOUNT_SLOT,
): LayoutAccount {
  if (!hasFolderLayout(sourceId)) return { source_id: sourceId, slot, layout: 'legacy' };
  let entry;
  try {
    entry = findRegistryAccount(readSourceRegistry(env), sourceId, slot);
  } catch (error) {
    if (error instanceof SourceRegistryError) {
      return { source_id: sourceId, slot, layout: !hasLegacyLayout(sourceId) || hasAccountFolderOnDisk(sourceId, slot, env) ? 'folder' : 'legacy' };
    }
    // The data folder itself cannot be worked out (a Linux layout that refuses this environment, say):
    // nothing is placed, and the legacy resolvers then fail exactly where they always did.
    return { source_id: sourceId, slot, layout: hasLegacyLayout(sourceId) ? 'legacy' : 'folder' };
  }
  return { source_id: sourceId, slot, layout: entry ? entry.layout : decideAccountLayout(sourceId, env).layout };
}

/**
 * Whether the account's entry holds a move plan part way (core/source-account-migration.ts):
 * its files are in two places, so no capture helper may start on them. A
 * registry that cannot be read says nothing here; the storage service refuses
 * to open anything until it is repaired.
 */
export function accountMovePending(sourceId: string, env: LayoutEnv = process.env, slot: string = DEFAULT_ACCOUNT_SLOT): boolean {
  try {
    const entry = findRegistryAccount(readSourceRegistry(env), sourceId, slot);
    return entry !== undefined && sourceAccountMovePending(entry);
  } catch {
    return false;
  }
}

/**
 * The bridge records each saved file's absolute path (a spool line's
 * `media_path`, and the item's locator the store keeps), so a WhatsApp account
 * the boot migration moved still has lines and items that name its old state
 * folder. This maps such a path to the same file in the account folder's
 * `raw/whatsapp` (the folder moved whole, so the rest of the path is the same),
 * for an account whose move is done; every other path, and every path of an
 * account that did not move, is returned as it is. Nothing is rewritten.
 */
export function whatsappMovedPathMapper(env: LayoutEnv = process.env): (path: string) => string {
  const same = (path: string): string => path;
  let entry;
  try {
    entry = findRegistryAccount(readSourceRegistry(env), WHATSAPP_SOURCE_ID, DEFAULT_ACCOUNT_SLOT);
  } catch {
    return same;
  }
  if (!entry || entry.layout !== 'folder' || entry.migration?.state !== 'done') return same;
  const from = resolve(legacyWhatsAppDefaultStateDir(env));
  const to = accountRawPath({ source_id: WHATSAPP_SOURCE_ID, slot: DEFAULT_ACCOUNT_SLOT, layout: 'folder' }, 'whatsapp', env);
  return (path) => {
    const below = relative(from, resolve(path));
    if (below === '' || below === '..' || below.startsWith(`..${sep}`) || isAbsolute(below)) return path;
    return join(to, below);
  };
}

/**
 * Where the scratch files of a file reader's input for this corpus go: the
 * extraction spool of the account that owns the corpus (the corpus registry's
 * source for it, any imported archive's corpus being `archive.imports`), in
 * its folder when it lives in one. The folder is used only when the corpus's
 * store is in it too, which is the evidence that the folder is the account's
 * (a store held elsewhere, or in memory, keeps the scratch files in the
 * shared spool a `legacy` account uses).
 */
export function extractionSpoolRootForCorpus(
  corpus: { corpusId: string; trustDomain: string; storePath?: string },
  env: LayoutEnv = process.env,
  registered: ReadonlyArray<{ corpusId: string; sourceId: string }> = [],
): string {
  return extractionSpoolPlacementForCorpus(corpus, env, registered).root;
}

/**
 * The spool root of `extractionSpoolRootForCorpus` and, for an account that
 * lives in its folder, that folder (`anchor`). The root is not made until a
 * scratch file is first written, and then only below the anchor and only while
 * the anchor is there, so a folder that is deleted under a running worker is
 * never brought back and an account that never writes a scratch file never
 * gets a `raw` folder it did not need.
 */
export function extractionSpoolPlacementForCorpus(
  corpus: { corpusId: string; trustDomain: string; storePath?: string },
  env: LayoutEnv = process.env,
  registered: ReadonlyArray<{ corpusId: string; sourceId: string }> = [],
): { root: string; anchor?: string } {
  const account = placedAccount(storageAccountForCorpus(corpus, registered).sourceId, env);
  const inFolder = account.layout === 'folder'
    && (corpus.storePath === undefined || isInsideAccountFolder(corpus.storePath, account, env));
  return inFolder
    ? { root: accountExtractionSpoolRoot(account, env), anchor: accountFolder(account, env) }
    : { root: extractionSpoolRoot(env) };
}

/** One of an account's stores, by the registry (or, with no entry, by what a new account would get). */
export function resolvedStorePath(sourceId: string, name: string, env: LayoutEnv = process.env): string {
  return accountStorePath(placedAccount(sourceId, env), name, env);
}

/**
 * Every store the shipped corpus roster gives a source with a folder layout,
 * one per corpus, at the path its account's layout puts it: what a reader of
 * every account's stores (the ingestion ledger, a status count) opens, so it
 * names no source. Imported archives' stores are listed by their families
 * elsewhere (their corpora are not shipped defaults).
 */
export function placedRosterStores(env: LayoutEnv = process.env): Array<{
  corpusId: string;
  dbPath: string;
  family: SourceCorpusConfig['family'];
  trustDomain: SourceCorpusConfig['trustDomain'];
}> {
  return defaultSourceCorpusRegistryConfig().corpora.flatMap((corpus) => {
    if (!hasFolderLayout(corpus.sourceId) || !accountStoreNames(corpus.sourceId).includes(corpus.trustDomain)) return [];
    return [{
      corpusId: corpus.corpusId,
      dbPath: resolvedStorePath(corpus.sourceId, corpus.trustDomain, env),
      family: corpus.family,
      trustDomain: corpus.trustDomain,
    }];
  });
}

/** One of an account's raw files or folders, resolved the same way. */
export function resolvedRawPath(
  sourceId: string,
  name: AccountRawName,
  env: LayoutEnv = process.env,
  options: { usageDbPath?: string } = {},
): string {
  return accountRawPath(placedAccount(sourceId, env), name, env, options);
}

/** Whether the account's folder is there (a link in its place counts: it is not a legacy path). */
function hasAccountFolderOnDisk(sourceId: string, slot: string, env: LayoutEnv): boolean {
  try {
    lstatSync(accountFolder({ source_id: sourceId, slot }, env));
    return true;
  } catch {
    return false;
  }
}

/** The account's folder, when it lives in one. */
export function placedAccountFolder(sourceId: string, env: LayoutEnv = process.env): string | undefined {
  const account = placedAccount(sourceId, env);
  return account.layout === 'folder' ? accountFolder(account, env) : undefined;
}

/** Whether a store path lies inside the folder of the account it is opened for. */
export function isInsideAccountFolder(dbPath: string, account: Pick<LayoutAccount, 'source_id' | 'slot'>, env: LayoutEnv = process.env): boolean {
  return resolve(dbPath).startsWith(`${resolve(accountFolder(account, env))}${sep}`);
}

/**
 * The account of a store declared only by its corpus (a connector-store JSON
 * mount, an operator script's `--db`): the corpus registry's source for that
 * corpus; an imported archive's corpus (any family) is `archive.imports`,
 * whose corpora are not shipped defaults; else the corpus id without its
 * trust-domain prefix (`secure_local.reflect.notes` is `reflect.notes`, the
 * id the data lifecycle names it by).
 */
export function storageAccountForCorpus(
  corpus: { corpusId: string; trustDomain: string },
  registered: ReadonlyArray<{ corpusId: string; sourceId: string }> = [],
): { sourceId: string } {
  const known = [...registered, ...defaultSourceCorpusRegistryConfig().corpora]
    .find((entry) => entry.corpusId === corpus.corpusId);
  if (known) return { sourceId: known.sourceId };
  if (isArchiveCorpusId(corpus.corpusId, corpus.trustDomain)) return { sourceId: ARCHIVE_IMPORTS_SOURCE_ID };
  const prefix = `${corpus.trustDomain}.`;
  const unprefixed = corpus.corpusId.startsWith(prefix) ? corpus.corpusId.slice(prefix.length) : '';
  return { sourceId: unprefixed || corpus.corpusId };
}

/**
 * One store the connector-store mount list declares: the source that owns it,
 * and its path when the entry names one that counts. A source with a folder
 * layout names none (its stores are placed here, and the worker ignores the
 * field), so only a mount of a source without one (Reflect, Roam, an
 * operator's own) carries a path.
 */
export interface DeclaredConnectorStoreMount {
  sourceId: string;
  corpusId: string;
  dbPath?: string;
}

/**
 * The stores `OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON` declares, or
 * `'unreadable'` for a list the worker would refuse. Entries without a corpus
 * are skipped, as the worker skips them.
 */
export function declaredConnectorStoreMounts(env: LayoutEnv = process.env): DeclaredConnectorStoreMount[] | 'unreadable' {
  const mounts = env[MOUNTS_ENV]?.trim();
  if (!mounts) return [];
  let declared: unknown;
  try {
    declared = JSON.parse(mounts);
  } catch {
    return 'unreadable';
  }
  if (!Array.isArray(declared)) return 'unreadable';
  const found: DeclaredConnectorStoreMount[] = [];
  for (const entry of declared) {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    if (typeof record.corpusId !== 'string') continue;
    const corpusId = record.corpusId.trim();
    const owner = storageAccountForCorpus({
      corpusId,
      trustDomain: typeof record.trustDomain === 'string' ? record.trustDomain.trim() : '',
    });
    const dbPath = typeof record.dbPath === 'string' && record.dbPath.trim() && !hasFolderLayout(owner.sourceId)
      ? record.dbPath.trim()
      : undefined;
    found.push({ sourceId: owner.sourceId, corpusId, ...(dbPath ? { dbPath } : {}) });
  }
  return found;
}

// The per-store path settings delivery step 6 retired (owner decision 3), by
// pattern: every `OLYMPUS_*_DB_PATH`, and the archive record's own.
const RETIRED_PATH_SETTING = /^OLYMPUS_\w+_DB_PATH$|^OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH$/;

/**
 * The retired path settings this environment still sets, in words: an
 * `OLYMPUS_*_DB_PATH` (or the archive record's path), and a connector-store
 * mount that names a path for a source whose stores Olympus places, other
 * than the one it places them at. Nothing reads them any more, so a worker
 * started with one would open an empty store where the files are not, and the
 * account's data would look gone: the worker refuses to start instead, naming
 * each one, until the files are moved to where Olympus keeps them (or the
 * setting is removed).
 */
export function retiredPathSettings(env: LayoutEnv = process.env): string[] {
  const found = Object.keys(env)
    .filter((name) => RETIRED_PATH_SETTING.test(name) && env[name]?.trim())
    .sort()
    .map((name) => `${name}=${env[name]!.trim()}`);
  const mounts = declaredConnectorStoreMountPaths(env);
  for (const mount of mounts) {
    if (!hasFolderLayout(mount.sourceId) || !accountStoreNames(mount.sourceId).includes(mount.trustDomain)) continue;
    const placed = resolvedStorePath(mount.sourceId, mount.trustDomain, env);
    if (resolve(mount.dbPath) !== resolve(placed)) found.push(`${MOUNTS_ENV} ${mount.corpusId} dbPath=${mount.dbPath} (Olympus keeps it at ${placed})`);
  }
  return found;
}

/** Every mount entry that names a path, with its owner: the raw declarations, before a folder layout drops the path. */
function declaredConnectorStoreMountPaths(env: LayoutEnv): Array<{ sourceId: string; corpusId: string; trustDomain: string; dbPath: string }> {
  let declared: unknown;
  try {
    declared = JSON.parse(env[MOUNTS_ENV]?.trim() || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(declared)) return [];
  return declared.flatMap((entry) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const corpusId = typeof record.corpusId === 'string' ? record.corpusId.trim() : '';
    const trustDomain = typeof record.trustDomain === 'string' ? record.trustDomain.trim() : '';
    const dbPath = typeof record.dbPath === 'string' ? record.dbPath.trim() : '';
    if (!corpusId || !dbPath) return [];
    return [{ sourceId: storageAccountForCorpus({ corpusId, trustDomain }).sourceId, corpusId, trustDomain, dbPath }];
  });
}

/**
 * What pins this source's files to their legacy paths, in words, when
 * something does: for messaging, a capture path env, native capture
 * ownership or a capture grant that names its session. The boot migration
 * leaves such an account where it is. It weighs
 * a messaging account's capture grant itself (`captureGrant: false`): a grant
 * that names the default legacy session is what every legacy pairing wrote, and
 * the move rewrites it (core/messaging-account-move.ts).
 */
export function legacyPinFor(sourceId: string, env: LayoutEnv = process.env, options: { captureGrant?: boolean } = {}): string | undefined {
  return pinnedLegacyBy(sourceId, env, options.captureGrant !== false);
}

/** The capture env, native ownership or capture grant that pins this source to the legacy layout, if any. */
function pinnedLegacyBy(sourceId: string, env: LayoutEnv, withGrant = true): string | undefined {
  for (const name of legacyOverrideEnvNames(sourceId)) {
    if (env[name]?.trim()) return name;
  }
  const native = nativeCaptureOwnerPin(sourceId, env);
  if (native) return native;
  return withGrant ? captureGrantPin(sourceId, env) : undefined;
}

/**
 * A messaging account's capture grant, when it keeps the account at the paths it
 * was paired at: a grant that names its session path (a folder account's names
 * none), or one that cannot be read, since then nothing shows it names none. Only
 * a grant confirmed absent, or readable and without a path, pins nothing. The
 * grant exists before the account's first file is recorded here whenever the
 * install was paired by an older build, which the environment cannot say.
 */
function captureGrantPin(sourceId: string, env: LayoutEnv): string | undefined {
  const source = sourceId === TELEGRAM_SOURCE_ID ? 'telegram' : sourceId === WHATSAPP_SOURCE_ID ? 'whatsapp' : undefined;
  if (!source) return undefined;
  const evidence = captureGrantSessionEvidence(source, captureGrantPathFromEnv(source, env));
  if (evidence.kind === 'path') return 'its capture grant (names the session path)';
  return evidence.kind === 'unreadable' ? 'its capture grant (cannot be read)' : undefined;
}

/** Whether the legacy data folder can be told apart from a fresh one. */
function dataRootState(env: LayoutEnv): 'present' | 'absent' | 'unreadable' {
  let root: string;
  try {
    root = olympusDataRoot(env);
  } catch {
    // On Linux the root is found by listing the candidate data folders, which fails on one the process may not search.
    return 'unreadable';
  }
  try {
    const link = lstatSync(root);
    // A link must lead somewhere: statSync follows it.
    const target = link.isSymbolicLink() ? statSync(root) : link;
    if (!target.isDirectory()) return 'unreadable';
    accessSync(root, constants.R_OK | constants.X_OK);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' && !isDanglingLink(root) ? 'absent' : 'unreadable';
  }
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether any file of this source sits at a legacy location. Lock files are not listed, so they do not count. */
function legacyFilesState(sourceId: string, env: LayoutEnv): 'present' | 'none' | 'unreadable' {
  const { stores, raw } = legacyAccountPaths(sourceId, env, archiveImportFamilies());
  const candidates = [
    ...raw.flatMap(withSqliteFiles),
    ...stores.flatMap((store) => [
      store,
      tierLedgerPathForStore(store),
      secretLocationsPathForStore(store),
      tierSnifferPathForStore(store),
    ].flatMap(withSqliteFiles)),
  ];
  let unreadable = false;
  for (const path of candidates) {
    try {
      lstatSync(path);
      return 'present';
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable = true;
    }
  }
  return unreadable ? 'unreadable' : 'none';
}

function withSqliteFiles(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}
