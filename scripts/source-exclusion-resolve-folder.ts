// Turn something a human has — a Drive folder URL, or a folder name — into the
// `folder_ids` entry an exclusion rule needs.
//
// This exists because the alternative is asking an owner to type a 33-character
// opaque provider id from memory, which nobody can do and nobody should have
// to. An exclusion the owner cannot author is an exclusion that does not get
// written, and a folder that does not get excluded is another system's corpus
// in personal search.
//
// READ-ONLY. It lists folder metadata and prints JSON. It never writes config,
// never touches a store, and never deletes anything: the operator pastes the
// output into their own exclusions file, which keeps the decision theirs.
//
// Two inputs, because operators arrive from two directions:
//
//   - A URL pasted from the browser address bar, which is the common case and
//     needs no API call at all — the id is in the URL.
//   - A folder NAME, which needs a lookup, and may legitimately match several
//     folders. All matches are printed with their parent folder so the operator
//     can tell two folders named "Books" apart. Choosing between them is the
//     operator's job; guessing would be this script silently excluding the
//     wrong subtree.

import {
  GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
  GoogleDriveSourceConnector,
  createGoogleDriveDailyRequestBudget,
  type GoogleDriveApiClient,
} from '../src/workers/google-connectors/index.ts';

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface ResolvedExclusionFolder {
  id: string;
  name: string;
  /** The parent folder's id, so two folders with one name are tellable apart. */
  parentId?: string;
}

/**
 * Pull a folder id out of a pasted Drive URL.
 *
 * Drive publishes folder URLs as `.../drive/folders/<id>` and sometimes carries
 * the id in a `?id=` parameter instead. Anything else returns undefined rather
 * than a guess: a wrong id here silently excludes the wrong folder, and an
 * operator who sees "not a folder URL" tries again, while an operator who sees
 * a plausible-looking wrong id does not.
 */
export function driveFolderIdFromUrl(value: string): string | undefined {
  const text = value.trim();
  if (!text.includes('://')) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!url.hostname.endsWith('google.com')) return undefined;
  const fromQuery = url.searchParams.get('id')?.trim();
  if (fromQuery) return fromQuery;
  const segments = url.pathname.split('/').filter(Boolean);
  const marker = segments.lastIndexOf('folders');
  const candidate = marker >= 0 ? segments[marker + 1]?.trim() : undefined;
  return candidate || undefined;
}

/**
 * Every folder whose name matches, with its parent.
 *
 * The name is passed to the provider as a literal equality match, with single
 * quotes escaped, because Drive's query language is a string grammar and a
 * folder legitimately named `Bob's Papers` would otherwise terminate the
 * clause. Escaping rather than rejecting keeps the tool usable on real folder
 * names.
 */
export async function findDriveFoldersByName(
  client: GoogleDriveApiClient,
  name: string,
): Promise<ResolvedExclusionFolder[]> {
  const escaped = name.trim().split('\\').join('\\\\').split("'").join("\\'");
  const page = await client.listFiles({
    pageSize: 50,
    query: `mimeType = '${FOLDER_MIME_TYPE}' and name = '${escaped}' and trashed = false`,
  });
  return page.files.map((file) => ({
    id: file.id,
    name: file.name ?? name.trim(),
    ...(file.parents?.[0] ? { parentId: file.parents[0] } : {}),
  }));
}

/**
 * The rule fragment an operator pastes into their exclusions file.
 *
 * Printed as a complete rule rather than a bare id because the surrounding
 * fields are not optional in practice: `sources` is REQUIRED for a folder-id
 * rule (an id belongs to one provider), and a reason is what makes the file
 * readable a year from now. Emitting the whole shape means the operator cannot
 * accidentally write the half that parses but does not apply.
 */
export function exclusionRuleFragment(folders: readonly ResolvedExclusionFolder[]): string {
  return `${JSON.stringify({
    id: 'rename-me',
    sources: [GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE],
    reason: 'why this folder is not Olympus material',
    folder_ids: folders.map((folder) => ({ id: folder.id, name: folder.name })),
  }, null, 2)}`;
}

function usage(): string {
  return [
    'Resolve a Google Drive folder to the folder_ids entry an exclusion rule needs.',
    '',
    'Usage:',
    '  bun run source-exclusions:resolve-folder -- <drive folder URL>',
    '  bun run source-exclusions:resolve-folder -- --name "3 Resources/Books"',
    '',
    'Getting the URL: open the folder in Drive and copy the address bar. The id',
    'is the segment after /folders/. No API call is needed for that form.',
    '',
    'Paste the printed rule into your exclusions file (default:',
    '~/.olympus/sources/ingestion-exclusions.json), edit the id and reason, and',
    'restart the worker. Nothing is written for you.',
  ].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (argv[0] === '--name') {
    const name = argv[1]?.trim();
    if (!name) throw new Error('--name requires a folder name.');
    const connector = new GoogleDriveSourceConnector({
      env: process.env,
      requestBudget: createGoogleDriveDailyRequestBudget({ env: process.env }),
    });
    const client = await connector.apiClientForTooling();
    const folders = await findDriveFoldersByName(client, name);
    if (folders.length === 0) {
      process.stdout.write(`No folder named ${JSON.stringify(name)} was found.\n`);
      process.exitCode = 1;
      return;
    }
    if (folders.length > 1) {
      process.stdout.write(
        `${folders.length} folders share that name. Pick the one you mean by its parent id `
        + 'and keep only that entry:\n\n',
      );
      for (const folder of folders) {
        process.stdout.write(`  id=${folder.id}  parent=${folder.parentId ?? '(root)'}\n`);
      }
      process.stdout.write('\n');
    }
    process.stdout.write(`${exclusionRuleFragment(folders)}\n`);
    return;
  }

  const id = driveFolderIdFromUrl(argv[0]!);
  if (!id) {
    throw new Error(
      'That does not look like a Drive folder URL. Expected .../drive/folders/<id>, '
      + 'or use --name "<folder name>".',
    );
  }
  process.stdout.write(`${exclusionRuleFragment([{ id, name: 'name this folder for your future self' }])}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
