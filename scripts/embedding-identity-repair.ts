// Corrects contaminated embedding-epoch labels on a store's
// `embedding_models` rows. Dry run by default.
//
//   bun scripts/embedding-identity-repair.ts --db <path>
//   bun scripts/embedding-identity-repair.ts --db <path> --execute
//   bun scripts/embedding-identity-repair.ts --db <path> --authority [--execute]
//
// Prints one line per provenance row — what it holds, what the canon says,
// and what the run did or would do. Without --authority, connector-store
// write-authority rows are only OBSERVED; with it, an authority row whose
// epoch is a known-contaminated variant is corrected under the same triple
// proof plus receipt integrity (see repairEmbeddingWriteAuthorities). No mode
// ever touches a vector.
//
// Output is counts and identifiers only: no chunk text, no locators.

import { Database } from 'bun:sqlite';
import {
  repairEmbeddingIdentities,
  repairEmbeddingWriteAuthorities,
  type EmbeddingIdentityAuthorityRepairRow,
  type EmbeddingIdentityRepairReport,
} from '../src/workers/source-index/embedding-identity-repair.ts';

interface EmbeddingIdentityRepairCliArgs {
  db: string;
  execute: boolean;
  json: boolean;
  authority: boolean;
}

const USAGE = 'Usage: bun scripts/embedding-identity-repair.ts --db <path> [--authority] [--execute] [--json]';

export function parseEmbeddingIdentityRepairCliArgs(
  argv: readonly string[],
): EmbeddingIdentityRepairCliArgs {
  let db: string | undefined;
  let execute = false;
  let json = false;
  let authority = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === '--db') {
      const next = argv[index + 1];
      if (next === undefined) throw new Error('--db requires a value.');
      index += 1;
      db = next;
    } else if (flag === '--execute') execute = true;
    else if (flag === '--json') json = true;
    else if (flag === '--authority') authority = true;
    else throw new Error(`Unknown flag ${flag}. ${USAGE}`);
  }

  if (!db?.trim()) throw new Error(USAGE);
  return { db: db.trim(), execute, json, authority };
}

export function formatEmbeddingIdentityRepairReport(
  report: EmbeddingIdentityRepairReport,
): string {
  const lines: string[] = [];
  lines.push(report.execute
    ? 'embedding identity repair: EXECUTE'
    : 'embedding identity repair: dry run (pass --execute to apply)');
  lines.push(`vector tables inspected: ${report.vectorTables.join(', ') || 'none'}`);
  for (const row of report.rows) {
    lines.push(
      `  ${row.decision.padEnd(18)} ${row.modelId} dim=${row.dimension} `
      + `vectors=${row.vectorRows}`
      + (row.vectorByteLength !== undefined ? ` bytes=${row.vectorByteLength}` : '')
      + `\n    stored:    ${row.storedEpoch}`
      + (row.canonicalEpoch ? `\n    canonical: ${row.canonicalEpoch}` : '')
      + `\n    reason:    ${row.reason}`,
    );
  }
  for (const authority of report.authority) {
    if (authority.matchesCanonical) continue;
    lines.push(
      `  authority_epoch_drift ${authority.modelId}`
      + `\n    authority: ${authority.authorityEpoch}`
      + (authority.canonicalEpoch ? `\n    canonical: ${authority.canonicalEpoch}` : '')
      + '\n    note:      write authority is owned by the bind path; not modified here.',
    );
  }
  lines.push(
    `repaired=${report.repaired} would_repair=${report.wouldRepair} refused=${report.refused}`,
  );
  return lines.join('\n');
}

export function formatEmbeddingAuthorityRepairRows(
  rows: readonly EmbeddingIdentityAuthorityRepairRow[],
): string {
  const lines: string[] = ['write-authority repair:'];
  for (const row of rows) {
    lines.push(
      `  ${row.decision.padEnd(18)} ${row.modelId || '(unparsed)'}`
      + (row.dimension !== undefined ? ` dim=${row.dimension}` : '')
      + ` vectors=${row.vectorRows}`
      + (row.vectorByteLength !== undefined ? ` bytes=${row.vectorByteLength}` : '')
      + `\n    stored:    ${row.storedEpoch || '(missing)'}`
      + (row.canonicalEpoch ? `\n    canonical: ${row.canonicalEpoch}` : '')
      + `\n    reason:    ${row.reason}`,
    );
  }
  if (rows.length === 0) lines.push('  (no write-authority rows)');
  return lines.join('\n');
}

function runEmbeddingIdentityRepair(argv: readonly string[]): {
  args: EmbeddingIdentityRepairCliArgs;
  report: EmbeddingIdentityRepairReport;
  authorityRows: EmbeddingIdentityAuthorityRepairRow[];
} {
  const args = parseEmbeddingIdentityRepairCliArgs(argv);
  // A dry run cannot write even by accident, and neither run creates a
  // database: a typo'd path fails instead of producing an empty store.
  const db = args.execute
    ? new Database(args.db, { readwrite: true, create: false })
    : new Database(args.db, { readonly: true });
  // First pragma, before any query: live stores have active writers, and a
  // lock mid-repair should wait, not error a half-reported run.
  db.exec('PRAGMA busy_timeout = 10000;');
  try {
    const report = repairEmbeddingIdentities(db, { execute: args.execute });
    const authorityRows = args.authority
      ? repairEmbeddingWriteAuthorities(db, { execute: args.execute })
      : [];
    return { args, report, authorityRows };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  try {
    const { args, report, authorityRows } = runEmbeddingIdentityRepair(process.argv.slice(2));
    const authorityRefused = authorityRows.filter((row) => row.decision === 'refused').length;
    console.log(args.json
      ? JSON.stringify({ kind: 'embedding_identity_repair', ...report, authorityRepair: authorityRows }, null, 2)
      : formatEmbeddingIdentityRepairReport(report)
        + (args.authority ? `\n${formatEmbeddingAuthorityRepairRows(authorityRows)}` : ''));
    process.exit(report.refused > 0 || authorityRefused > 0 ? 2 : 0);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
