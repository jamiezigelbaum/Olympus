// Preview or apply what the user's ingestion dispositions cover but the
// connector store already holds.
//
// Excluding future ingestion while leaving already-ingested material
// searchable satisfies the letter of "keep this out" and none of its intent,
// so this is the other half of the primitive.
//
// TWO operations, never one with a flag:
//
//   - PURGE removes items an `exclude` rule covers, with their chunks and
//     vectors. `--purge`.
//   - STRIP removes the chunks and vectors of items a `metadata_only` rule
//     covers and KEEPS the item rows, which stay findable by title, path and
//     date. `--strip-metadata-only`.
//
// They are separate verbs because they destroy different things and the
// difference is the owner's whole point. One flag with a mode would put
// "delete the row" and "keep the row" a single character apart.
//
// DESTRUCTIVE, and shaped accordingly:
//
//   - `--dry-run` is the DEFAULT. Removing anything requires `--purge` or
//     `--strip-metadata-only`, typed explicitly. There is no way to reach a
//     deletion by forgetting a flag.
//   - The preview and the deletion walk the same rows through the same matcher
//     inside one transaction, so the preview cannot describe a different set
//     than the purge acts on.
//   - Rows whose path this gate cannot read are KEPT and reported, not
//     deleted. Purge is the one direction where failing closed means leaving
//     data alone; `--purge-unevaluable` is how an operator opts into removing
//     them after seeing the count.
//   - When a MEDIA rule is configured, every stored row of the named type is
//     unevaluable here, because a store keeps a locator and not a byte count.
//     `--purge-unevaluable` would therefore delete small videos as well as
//     large ones, and the report says so before an operator can reach for it.
//
// Sources whose exclusions are expressed by FOLDER IDENTITY report every stored
// row as unevaluable here, and that is the honest answer rather than a gap. A
// stored row keeps its locator, not its resolved ancestry, so nothing in the
// database can say whether a row sat under an excluded folder — and a purge
// that guessed would be deleting on evidence it does not have. The ingestion
// gate is what makes such rows impossible going forward, so this count is a
// bounded backlog from before the rules existed, not a standing hole.
//
// The report is counts-only. The one path-shaped value it prints is the user's
// own configured exclusion prefix, which is configuration, not item content:
// without it a preview cannot answer "which of my folders does this account
// for", and an operator cannot sanity-check a prefix before deleting by it.
// No item path, name, title, or text is read or printed.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createDropboxConnectorStore,
  defaultDropboxConnectorStoreDbPath,
} from '../src/workers/dropbox-files/index.ts';
import {
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  defaultGoogleDriveConnectorStoreDbPath,
  defaultGoogleDriveSecureConnectorStoreDbPath,
  googleDriveIngestionExclusionMatcher,
} from '../src/workers/google-connectors/index.ts';
import {
  LocalConnectorStore,
  type ConnectorStoreMetadataOnlyStripSummary,
  type ConnectorStorePurgeSummary,
} from '../src/workers/connector-store/index.ts';

export interface SourceExclusionPurgeArgs {
  purge: boolean;
  purgeUnevaluable: boolean;
  stripMetadataOnly: boolean;
  reportPath?: string;
}

export function parseSourceExclusionPurgeArgs(argv: readonly string[]): SourceExclusionPurgeArgs {
  const args: SourceExclusionPurgeArgs = {
    purge: false,
    purgeUnevaluable: false,
    stripMetadataOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    // `--dry-run` is accepted and is a no-op: it is the default, and refusing
    // the flag an operator naturally reaches for would be hostile.
    if (arg === '--dry-run') continue;
    if (arg === '--purge') {
      args.purge = true;
      continue;
    }
    if (arg === '--purge-unevaluable') {
      args.purgeUnevaluable = true;
      continue;
    }
    if (arg === '--strip-metadata-only') {
      args.stripMetadataOnly = true;
      continue;
    }
    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      args.reportPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.purgeUnevaluable && !args.purge) {
    // Silently previewing a different set than the flag implies would make the
    // preview lie, which is the one thing this script must never do.
    throw new Error('--purge-unevaluable only applies with --purge; a dry run always reports them separately.');
  }
  return args;
}

export function formatSourceMetadataOnlyStripReport(
  summary: ConnectorStoreMetadataOnlyStripSummary,
): string {
  const counts = summary.counts;
  const lines = [
    summary.dry_run
      ? 'Metadata-only strip DRY RUN — nothing was removed.'
      : 'Metadata-only strip COMPLETED — the content below was removed; every item row was kept.',
    `corpus: ${summary.corpus_id}`,
    `items with content scanned: ${counts.items_scanned}`,
    `items matching a metadata-only rule: ${counts.items_matched}`,
    summary.dry_run
      ? `items whose content would be stripped: ${counts.items_would_strip}`
      : `items whose content was stripped: ${counts.items_stripped}`,
    summary.dry_run
      ? `chunks that would be removed: ${counts.chunks_would_remove}`
      : `chunks removed: ${counts.chunks_removed}`,
    summary.dry_run
      ? `vectors that would be removed: ${counts.embeddings_would_remove}`
      : `vectors removed: ${counts.embeddings_removed}`,
    // Same three causes as the purge report, named the same way, because an
    // operator comparing the two receipts should not have to work out whether
    // the different wording means a different measurement.
    `items kept intact because the gate could not answer for them (path, folder ancestry, or size): `
    + `${counts.items_unevaluable_kept}`,
    'items deleted: 0 (a strip never removes an item row)',
    '',
    'Per metadata-only folder:',
  ];
  if (summary.by_prefix.length === 0) {
    lines.push('  (no metadata-only rules are configured)');
  }
  for (const row of summary.by_prefix) {
    lines.push(`  ${row.rule_id}  ${row.prefix}  ${row.items} items  (${row.reason})`);
  }
  return lines.join('\n');
}

export function formatSourceExclusionPurgeReport(summary: ConnectorStorePurgeSummary): string {
  const counts = summary.counts;
  const lines = [
    summary.dry_run
      ? 'Exclusion purge DRY RUN — nothing was removed.'
      : 'Exclusion purge COMPLETED — rows below were removed.',
    `corpus: ${summary.corpus_id}`,
    `items scanned: ${counts.items_scanned}`,
    `items matching an exclusion: ${counts.items_matched}`,
    summary.dry_run
      ? `items that would be removed: ${counts.items_would_remove}`
      : `items removed: ${counts.items_removed}`,
    summary.dry_run
      ? `chunks that would be removed: ${counts.chunks_would_remove}`
      : `chunks removed: ${counts.chunks_removed}`,
    summary.dry_run
      ? `vectors that would be removed: ${counts.embeddings_would_remove}`
      : `vectors removed: ${counts.embeddings_removed}`,
    // "path or folder ancestry" was accurate until a media rule could also go
    // unanswered, for a third reason. Naming all three keeps the line honest
    // without making it conditional on which rules happen to be configured.
    `items kept because the gate could not answer for them (path, folder ancestry, or size): `
    + `${counts.items_unevaluable_kept}`,
    '',
    'Per excluded folder:',
  ];
  if (summary.by_prefix.length === 0) {
    lines.push('  (no exclusions are configured)');
  }
  for (const row of summary.by_prefix) {
    lines.push(`  ${row.rule_id}  ${row.prefix}  ${row.items} items  (${row.reason})`);
  }
  return lines.join('\n');
}

/**
 * Every store this purge covers, opened against ITS OWN source-scoped gate.
 *
 * One matcher per source, never a shared one: a rule that names Dropbox must
 * not delete Drive rows, and the only thing standing between those two is that
 * each store is built from the rules its own source selected.
 *
 * A store whose file does not exist is skipped rather than created. Opening for
 * write would leave an empty database behind as a side effect of a dry run,
 * which is the opposite of what `--dry-run` promises.
 */
function purgeTargets(env: Record<string, string | undefined>): Array<{
  label: string;
  dbPath: string;
  open(): LocalConnectorStore;
}> {
  const driveExclusions = () => googleDriveIngestionExclusionMatcher(env);
  return [
    {
      label: 'Dropbox files',
      dbPath: defaultDropboxConnectorStoreDbPath(env),
      open: () => createDropboxConnectorStore(env),
    },
    {
      label: 'Drive docs (internal)',
      dbPath: defaultGoogleDriveConnectorStoreDbPath(env),
      open: () => new LocalConnectorStore({
        dbPath: defaultGoogleDriveConnectorStoreDbPath(env),
        corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
        family: 'file',
        trustDomain: 'internal',
        exclusions: driveExclusions(),
      }),
    },
    {
      label: 'Drive docs (secure_local)',
      dbPath: defaultGoogleDriveSecureConnectorStoreDbPath(env),
      open: () => new LocalConnectorStore({
        dbPath: defaultGoogleDriveSecureConnectorStoreDbPath(env),
        corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        exclusions: driveExclusions(),
      }),
    },
  ];
}

async function main(): Promise<void> {
  const args = parseSourceExclusionPurgeArgs(process.argv.slice(2));
  const summaries: Array<ConnectorStorePurgeSummary | ConnectorStoreMetadataOnlyStripSummary> = [];
  for (const target of purgeTargets(process.env)) {
    if (!existsSync(target.dbPath)) {
      process.stdout.write(`${target.label}: no store at this path yet — nothing to preview.\n\n`);
      continue;
    }
    const store = target.open();
    try {
      const summary = store.purgeExcludedItems({
        dryRun: !args.purge,
        ...(args.purgeUnevaluable ? { purgeUnevaluable: true } : {}),
      });
      summaries.push(summary);
      process.stdout.write(`${target.label}\n${formatSourceExclusionPurgeReport(summary)}\n`);
      if (store.exclusions.mediaActive) {
        // Said unprompted, because the operator who reaches for
        // --purge-unevaluable is by definition looking at a count they want to
        // clear, and this is the one case where clearing it deletes items the
        // rule was never about.
        process.stdout.write(
          '\nNOTE: a media rule is configured. A stored row keeps a locator, not a byte count, so\n'
          + 'every stored file of the named type counts as unevaluable above. --purge-unevaluable\n'
          + 'would delete ALL of them, including ones under the size threshold.\n',
        );
      }
      if (summary.dry_run && summary.counts.items_would_remove > 0) {
        process.stdout.write(
          `\nStore: ${target.dbPath}\n`
          + 'Re-run with --purge to remove these items, their chunks, and their vectors.\n',
        );
      }
      process.stdout.write('\n');

      // The metadata-only half, always previewed alongside the purge, because
      // an operator settling ingestion debt needs both numbers to know what
      // their configuration actually costs — and because a strip that had to
      // be discovered would never be run.
      const strip = store.stripMetadataOnlyRepresentations({ dryRun: !args.stripMetadataOnly });
      summaries.push(strip);
      process.stdout.write(`${target.label}\n${formatSourceMetadataOnlyStripReport(strip)}\n`);
      if (strip.dry_run && strip.counts.items_would_strip > 0) {
        process.stdout.write(
          `\nStore: ${target.dbPath}\n`
          + 'Re-run with --strip-metadata-only to remove this content. The item rows stay indexed.\n',
        );
      }
      process.stdout.write('\n');
    } finally {
      store.close();
    }
  }
  if (args.reportPath) {
    mkdirSync(dirname(args.reportPath), { recursive: true });
    writeFileSync(args.reportPath, `${JSON.stringify(summaries, null, 2)}\n`, 'utf8');
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
