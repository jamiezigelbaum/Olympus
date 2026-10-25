/**
 * The sources an imported archive can be an input of
 * (docs/design/archive-live-one-dataset.md, sections 1 and 7).
 *
 * A source with a live connector has one connector, and it is the only writer
 * of the source's items. An archive of that source's history is another input
 * of that connector: the archive layer reads the export and emits the live
 * reader's own record shape, and the connector turns every record into an item
 * the same way, whichever input it came from, into the account's own stores.
 * A source registers here what only it knows: which account an export belongs
 * to, its lane of one account (its set, its sync options and its connector),
 * the archive as an input, and how its pulls are kept from running beside an
 * import.
 *
 * A source with no live connector, an export of a different account than the
 * connected one, and one the owner keeps apart stay under Archives
 * (`archive.imports`), with their Remove, as before. Nothing is registered
 * until a source's connector has an archive input.
 */
import type { SourceConnector, SourceConnectorInput } from '../../core/contracts.ts';
import type { ArchiveConnectorInput } from '../../core/archive-formats.ts';
import type { LayoutEnv } from '../../core/olympus-layout.ts';
import type { ScopeRoot } from '../../core/scope-safe-fs.ts';
import type { StorageAccount } from '../../core/source-storage.ts';
import type { ConnectorStoreSyncOptions } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import type { ArchiveManifestFile } from './manifest.ts';

/**
 * What an export says about the account it belongs to, read by the source
 * (it knows its own export's profile).
 */
export type ArchiveAccountEvidence =
  /** The export names its account (opaque to everything but the source and the storage service). */
  | { kind: 'account'; importAccountId: string }
  /** The export names none (a WhatsApp export, a single Telegram chat): it joins the only account at the owner's confirmation. */
  | { kind: 'none' }
  /** The export cannot join the source (mail that is not a Gmail account's, say): it stays under Archives. */
  | { kind: 'archives' };

/** The chosen files, as the start flow has them when it asks the source about the export. */
export interface ArchiveToIdentify {
  format: string;
  root: ScopeRoot;
  chosenRelPath: string;
  files: readonly ArchiveManifestFile[];
}

/** One account of the source, as its live lane has it: nothing of it is the archive layer's. */
export interface ArchiveSourceLane {
  /** The account's own stores and set ledger. */
  set: TieredStoreSet;
  /** The live lane's own sync options (placement, content fetch): one code path for every input. */
  sync: ConnectorStoreSyncOptions;
  /** The source's one connector for this account; it reads an input through `forInput`. */
  connector: SourceConnector;
}

export interface ArchiveSourceTarget {
  /** The source's id in the storage service's registry. */
  readonly sourceId: string;
  /** The archive formats whose records this source's connector reads. */
  readonly formats: readonly string[];
  /**
   * The scheduler key the source's own pulls run under: an import writes the
   * account's stores under it, so it never runs beside them.
   */
  readonly concurrencyKey: string;
  identify(archive: ArchiveToIdentify): ArchiveAccountEvidence;
  /** The export as an input of the source: its records in the live reader's shape. */
  input(archive: ArchiveConnectorInput): SourceConnectorInput;
  lane(account: Required<StorageAccount>, env: LayoutEnv): ArchiveSourceLane;
  /**
   * For a source whose account guard can bind another account over its
   * stores: the guard's own exclusive runner, held while an import resolves
   * the account and writes into it. Absent for a source with no such guard.
   */
  exclusive?<T>(task: () => Promise<T>): Promise<T>;
}

export class ArchiveSourceTargets {
  private readonly bySource = new Map<string, ArchiveSourceTarget>();
  private readonly byFormat = new Map<string, ArchiveSourceTarget>();

  register(target: ArchiveSourceTarget): void {
    this.bySource.set(target.sourceId, target);
    for (const format of target.formats) this.byFormat.set(format, target);
  }

  unregister(sourceId: string): void {
    const target = this.bySource.get(sourceId);
    if (!target) return;
    this.bySource.delete(sourceId);
    for (const format of target.formats) if (this.byFormat.get(format) === target) this.byFormat.delete(format);
  }

  forSource(sourceId: string): ArchiveSourceTarget | undefined {
    return this.bySource.get(sourceId);
  }

  forFormat(formatId: string): ArchiveSourceTarget | undefined {
    return this.byFormat.get(formatId);
  }

  sourceIds(): string[] {
    return [...this.bySource.keys()];
  }
}

/** The sources this build knows. Each source registers itself when its connector has an archive input. */
export const archiveSourceTargets = new ArchiveSourceTargets();
