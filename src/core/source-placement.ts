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
 * - no env override or connector-store mount pins a path for it, and, for
 *   messaging, the Gateway-run service does not own its capture (that
 *   service reads its paths, plugin config included, and the account stays
 *   where they are);
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
import { resolve, sep } from 'node:path';
import {
  secretLocationsPathForStore,
  tierLedgerPathForStore,
  tierSnifferPathForStore,
} from '../workers/classification/tier-ledger-path.ts';
import { archiveImportFamilies, isArchiveCorpusId } from './archive-formats.ts';
import {
  FOLDER_LAYOUT_SOURCES,
  accountFolder,
  accountRawPath,
  accountStorePath,
  legacyAccountPaths,
  legacyOverrideEnvNames,
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
import { defaultSourceCorpusRegistryConfig } from './source-corpus-registry.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry, SourceRegistryError } from './source-registry.ts';

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
    if (error instanceof SourceRegistryError) return { source_id: sourceId, slot, layout: hasAccountFolderOnDisk(sourceId, slot, env) ? 'folder' : 'legacy' };
    // The data folder itself cannot be worked out (a Linux layout that refuses this environment, say):
    // nothing is placed, and the legacy resolvers then fail exactly where they always did.
    return { source_id: sourceId, slot, layout: 'legacy' };
  }
  return { source_id: sourceId, slot, layout: entry ? entry.layout : decideAccountLayout(sourceId, env).layout };
}

/** One of an account's stores, by the registry (or, with no entry, by what a new account would get). */
export function resolvedStorePath(sourceId: string, name: string, env: LayoutEnv = process.env): string {
  return accountStorePath(placedAccount(sourceId, env), name, env);
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

/** One store the connector-store mount list declares: the source that owns it, and its path when the entry names one. */
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
    const dbPath = typeof record.dbPath === 'string' && record.dbPath.trim() ? record.dbPath.trim() : undefined;
    found.push({ sourceId: owner.sourceId, corpusId, ...(dbPath ? { dbPath } : {}) });
  }
  return found;
}

/**
 * What pins this source's files to their legacy paths, in words, when
 * something does: an env override, a connector-store mount (and, for
 * messaging, native capture ownership or a capture grant that names its
 * session). The boot migration leaves such an account where it is.
 */
export function legacyPinFor(sourceId: string, env: LayoutEnv = process.env): string | undefined {
  return pinnedLegacyBy(sourceId, env);
}

/** The override or mount that pins this source to the legacy layout, if any. */
function pinnedLegacyBy(sourceId: string, env: LayoutEnv): string | undefined {
  for (const name of legacyOverrideEnvNames(sourceId)) {
    if (env[name]?.trim()) return name;
  }
  const native = nativeCaptureOwnerPin(sourceId, env);
  if (native) return native;
  const grant = captureGrantPin(sourceId, env);
  if (grant) return grant;
  const mounts = declaredConnectorStoreMounts(env);
  // The worker refuses a list it cannot read; until it is fixed nothing may move.
  if (mounts === 'unreadable') return `${MOUNTS_ENV} (unreadable)`;
  const mount = mounts.find((candidate) => candidate.sourceId === sourceId);
  return mount ? `${MOUNTS_ENV} (${mount.corpusId})` : undefined;
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
