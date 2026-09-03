/**
 * The canonical X live-scheduler drop-in render, and nothing else.
 *
 * This module deliberately imports NOTHING but node builtins. The
 * installer (`scripts/ops/install-private-host-x-bookmarks-live-scheduler.sh`) runs
 * it directly to render the file it writes, and that installer is a
 * standalone, dependency-light unit writer that also runs out of a partial
 * release checkout. Folding the render into a live-control module would make
 * an ops installer depend on the whole application module graph.
 *
 * The renderer owns only cadence and connector-store settings. Scheduler
 * admission is owned by the worker scheduler source-id manifest.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The host-manifest keys the X live-scheduler drop-in interpolates.
 *
 * These are cadence and budget bounds, so changing one is a policy change the
 * running scheduler should adopt directly from the reviewed host manifest.
 */
export const X_BOOKMARKS_DROPIN_MANIFEST_KEYS = [
  'X_BOOKMARKS_HEAD_INTERVAL_SECONDS',
  'X_BOOKMARKS_HEAD_STALE_SECONDS',
  'X_BOOKMARKS_RECONCILE_INTERVAL_SECONDS',
  'X_BOOKMARKS_RECONCILE_STALE_SECONDS',
  'X_BOOKMARKS_HEAD_PAGE_SIZE_LADDER',
  'X_BOOKMARKS_HEAD_API_REQUEST_RESERVE',
  'X_BOOKMARKS_HEAD_RESOURCE_READ_RESERVE',
  'X_BOOKMARKS_HEAD_ESTIMATED_SPEND_RESERVE_USD',
] as const;

export type XBookmarksDropinManifestKey = (typeof X_BOOKMARKS_DROPIN_MANIFEST_KEYS)[number];

/** The interpolated half of the drop-in: every manifest key, raw. */
export type XBookmarksLiveSchedulerDropinValues = Record<XBookmarksDropinManifestKey, string>;

/** The connector store is the only X data plane after Slice 2. */
export const X_BOOKMARKS_DROPIN_CONNECTOR_STORE_KEY =
  'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED' as const;

/**
 * Read an exact set of keys out of a host manifest, refusing a duplicate or an
 * absent one. Values are the raw manifest bytes after the first `=` — no
 * expansion, no trimming — so every consumer that reads the same file agrees
 * exactly. Shared by the X projection and the X drop-in render so the two can
 * never disagree about what a manifest says.
 */
export function readManifestKeys(
  manifestText: string,
  keys: readonly string[],
  label: string,
): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of manifestText.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    if (!keys.includes(key)) continue;
    if (values.has(key)) {
      throw new Error(`${label} is duplicated: ${key}`);
    }
    values.set(key, line.slice(separator + 1));
  }
  for (const key of keys) {
    if (!values.has(key)) {
      throw new Error(`${label} is absent: ${key}`);
    }
  }
  return values;
}

/**
 * Lift the drop-in values straight out of a host manifest.
 *
 * The env-driven installer supplies the same record from its own validated
 * `OLYMPUS_SPARTA_X_BOOKMARKS_*` overrides, so both entry points reach one
 * renderer instead of re-typing the template.
 */
export function xBookmarksLiveSchedulerDropinValuesFromManifest(
  manifestText: string,
): XBookmarksLiveSchedulerDropinValues {
  const values = readManifestKeys(
    manifestText,
    X_BOOKMARKS_DROPIN_MANIFEST_KEYS,
    'X drop-in manifest key',
  );
  const lifted = {} as XBookmarksLiveSchedulerDropinValues;
  for (const key of X_BOOKMARKS_DROPIN_MANIFEST_KEYS) lifted[key] = values.get(key) as string;
  return lifted;
}

/**
 * Bounds the drop-in states that are NOT manifest-driven.
 *
 * These were literals in the bash heredocs. They stay literals, but in exactly
 * one place: a host that wants one of them changed changes it here, and the
 * refresh's adopt path then proves the deployed file against the new render.
 */
const X_BOOKMARKS_DROPIN_FIXED_BOUNDS = {
  DEGRADED_INTERVAL_SECONDS: '300',
  RATE_LIMIT_LOW_WATERMARK: '12',
  DAILY_API_REQUEST_BUDGET: '4000',
  DAILY_RESOURCE_READ_BUDGET: '10000',
  DAILY_ESTIMATED_SPEND_BUDGET_USD: '5',
  ESTIMATED_UNIT_COST_USD: '0.001',
  HEAD_MAX_CATCHUP_ITEMS: '100',
  HEAD_MAX_CATCHUP_PAGES: '5',
  RECONCILE_MAX_ITEMS: '25000',
  RECONCILE_MAX_FOLDERS: '500',
  RECONCILE_MAX_PAGES_PER_SCOPE: '500',
} as const;

/**
 * THE X live-scheduler drop-in render. There is no second one.
 *
 * Before this existed the same environment lines were re-typed in multiple
 * installers, and nothing in the repo could say what the deployed file was
 * supposed to contain.
 *
 * The render is byte-exact and load-bearing in both directions: the installer
 * interpolates it to WRITE the file, and the refresh interpolates it to decide
 * whether a deployed file is sanctioned. A drifted template therefore cannot
 * silently deploy — it refuses the adopt path instead, which is the correct
 * failure direction.
 */
export function xBookmarksLiveSchedulerDropinRender(
  values: XBookmarksLiveSchedulerDropinValues,
): string {
  const manifest = (key: XBookmarksDropinManifestKey): string => {
    const value = values[key];
    // A newline would forge extra Environment= lines out of one value; a
    // quote would end the systemd-quoted value early. Neither can reach a
    // deployed unit file through this renderer.
    if (typeof value !== 'string' || value === '' || /["\n\r]/.test(value)) {
      throw new Error(`X drop-in manifest value is unusable: ${key}`);
    }
    return value;
  };
  const bounds = X_BOOKMARKS_DROPIN_FIXED_BOUNDS;
  const environment: readonly (readonly [string, string])[] = [
    [X_BOOKMARKS_DROPIN_CONNECTOR_STORE_KEY, 'true'],
    ['OLYMPUS_SOURCE_INDEX_X_HEAD_INTERVAL_SECONDS', manifest('X_BOOKMARKS_HEAD_INTERVAL_SECONDS')],
    ['OLYMPUS_SOURCE_INDEX_X_HEAD_STALE_SECONDS', manifest('X_BOOKMARKS_HEAD_STALE_SECONDS')],
    [
      'OLYMPUS_SOURCE_INDEX_X_RECONCILE_INTERVAL_SECONDS',
      manifest('X_BOOKMARKS_RECONCILE_INTERVAL_SECONDS'),
    ],
    [
      'OLYMPUS_SOURCE_INDEX_X_RECONCILE_STALE_SECONDS',
      manifest('X_BOOKMARKS_RECONCILE_STALE_SECONDS'),
    ],
    ['OLYMPUS_SOURCE_INDEX_X_HEAD_PAGE_SIZE_LADDER', manifest('X_BOOKMARKS_HEAD_PAGE_SIZE_LADDER')],
    ['OLYMPUS_SOURCE_INDEX_X_DEGRADED_INTERVAL_SECONDS', bounds.DEGRADED_INTERVAL_SECONDS],
    ['OLYMPUS_SOURCE_INDEX_X_RATE_LIMIT_LOW_WATERMARK', bounds.RATE_LIMIT_LOW_WATERMARK],
    ['OLYMPUS_SOURCE_INDEX_X_DAILY_API_REQUEST_BUDGET', bounds.DAILY_API_REQUEST_BUDGET],
    ['OLYMPUS_SOURCE_INDEX_X_DAILY_RESOURCE_READ_BUDGET', bounds.DAILY_RESOURCE_READ_BUDGET],
    [
      'OLYMPUS_SOURCE_INDEX_X_DAILY_ESTIMATED_SPEND_BUDGET_USD',
      bounds.DAILY_ESTIMATED_SPEND_BUDGET_USD,
    ],
    ['OLYMPUS_SOURCE_INDEX_X_ESTIMATED_UNIT_COST_USD', bounds.ESTIMATED_UNIT_COST_USD],
    [
      'OLYMPUS_SOURCE_INDEX_X_HEAD_API_REQUEST_RESERVE',
      manifest('X_BOOKMARKS_HEAD_API_REQUEST_RESERVE'),
    ],
    [
      'OLYMPUS_SOURCE_INDEX_X_HEAD_RESOURCE_READ_RESERVE',
      manifest('X_BOOKMARKS_HEAD_RESOURCE_READ_RESERVE'),
    ],
    [
      'OLYMPUS_SOURCE_INDEX_X_HEAD_ESTIMATED_SPEND_RESERVE_USD',
      manifest('X_BOOKMARKS_HEAD_ESTIMATED_SPEND_RESERVE_USD'),
    ],
    ['OLYMPUS_SOURCE_INDEX_X_HEAD_MAX_CATCHUP_ITEMS', bounds.HEAD_MAX_CATCHUP_ITEMS],
    ['OLYMPUS_SOURCE_INDEX_X_HEAD_MAX_CATCHUP_PAGES', bounds.HEAD_MAX_CATCHUP_PAGES],
    ['OLYMPUS_SOURCE_INDEX_X_RECONCILE_MAX_ITEMS', bounds.RECONCILE_MAX_ITEMS],
    ['OLYMPUS_SOURCE_INDEX_X_RECONCILE_MAX_FOLDERS', bounds.RECONCILE_MAX_FOLDERS],
    ['OLYMPUS_SOURCE_INDEX_X_RECONCILE_MAX_PAGES_PER_SCOPE', bounds.RECONCILE_MAX_PAGES_PER_SCOPE],
  ];
  let render = '[Service]\n';
  for (const [key, value] of environment) render += `Environment="${key}=${value}"\n`;
  return render;
}

/** The render a host manifest produces, which is what the adopt path compares against. */
export function xBookmarksLiveSchedulerDropinRenderFromManifest(
  manifestText: string,
): string {
  return xBookmarksLiveSchedulerDropinRender(
    xBookmarksLiveSchedulerDropinValuesFromManifest(manifestText),
  );
}

export function xBookmarksLiveSchedulerDropinSha256(
  manifestText: string,
): string {
  return createHash('sha256')
    .update(xBookmarksLiveSchedulerDropinRenderFromManifest(manifestText))
    .digest('hex');
}

export interface XBookmarksLiveSchedulerDropinParse {
  values: XBookmarksLiveSchedulerDropinValues;
}

/**
 * Read a deployed drop-in back into the inputs that would render it, refusing
 * anything this renderer could not have produced.
 *
 * The round-trip check at the end is what makes the answer trustworthy: a file
 * that does not render back to itself byte-for-byte is not a render at all.
 */
export function parseXBookmarksLiveSchedulerDropin(
  dropinText: string,
): XBookmarksLiveSchedulerDropinParse {
  const environment = new Map<string, string>();
  const lines = dropinText.split('\n');
  if (lines[0] !== '[Service]') {
    throw new Error('X drop-in does not begin with a [Service] section.');
  }
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const match = /^Environment="([A-Z0-9_]+)=(.*)"$/.exec(line);
    if (!match?.[1]) {
      throw new Error('X drop-in carries a line this renderer never emits.');
    }
    if (environment.has(match[1])) {
      throw new Error(`X drop-in duplicates an environment key: ${match[1]}`);
    }
    environment.set(match[1], match[2] ?? '');
  }
  const values = {} as XBookmarksLiveSchedulerDropinValues;
  for (const key of X_BOOKMARKS_DROPIN_MANIFEST_KEYS) {
    // Manifest key X_BOOKMARKS_FOO maps to Environment key
    // OLYMPUS_SOURCE_INDEX_X_FOO; the render above is the definition.
    const environmentKey = `OLYMPUS_SOURCE_INDEX_X_${key.slice('X_BOOKMARKS_'.length)}`;
    const value = environment.get(environmentKey);
    if (value === undefined) throw new Error(`X drop-in declares no ${environmentKey}.`);
    values[key] = value;
  }
  // The proof: these inputs must reproduce the exact bytes handed in. Anything
  // reordered, appended, or hand-edited fails here rather than being silently
  // normalised into a "valid" render.
  if (xBookmarksLiveSchedulerDropinRender(values) !== dropinText) {
    throw new Error('X drop-in is not byte-identical to any rendering of itself.');
  }
  return { values };
}

/**
 * Standalone render CLI, so the installer interpolates this renderer
 * rather than keeping a heredoc twin of it.
 *
 * Usage:
 *   live-scheduler-dropin.ts render
 *     ( --manifest <path> | --value KEY=value ... ) [--output <path>]
 */
function main(argv: readonly string[]): void {
  if (argv[0] !== 'render') {
    throw new Error('Usage: live-scheduler-dropin.ts render [--manifest path | --value KEY=value ...] [--output path]');
  }
  const flags = new Map<string, string[]>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error('X drop-in render arguments must be --name value pairs.');
    }
    const name = flag.slice(2);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  const single = (name: string): string | undefined => {
    const matches = flags.get(name) ?? [];
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) throw new Error(`--${name} must appear at most once.`);
    return matches[0];
  };
  const manifestPath = single('manifest');
  const explicit = flags.get('value') ?? [];
  if ((manifestPath === undefined) === (explicit.length === 0)) {
    throw new Error('X drop-in render takes exactly one value source: --manifest or --value.');
  }
  let render: string;
  if (manifestPath !== undefined) {
    render = xBookmarksLiveSchedulerDropinRenderFromManifest(readFileSync(manifestPath, 'utf8'));
  } else {
    const supplied = {} as XBookmarksLiveSchedulerDropinValues;
    for (const pair of explicit) {
      const separator = pair.indexOf('=');
      if (separator < 1) throw new Error('Each --value must be KEY=value.');
      const key = pair.slice(0, separator);
      if (!(X_BOOKMARKS_DROPIN_MANIFEST_KEYS as readonly string[]).includes(key)) {
        throw new Error(`--value names a key the X drop-in does not interpolate: ${key}`);
      }
      const typed = key as XBookmarksDropinManifestKey;
      if (supplied[typed] !== undefined) throw new Error(`--value is duplicated: ${key}`);
      supplied[typed] = pair.slice(separator + 1);
    }
    for (const key of X_BOOKMARKS_DROPIN_MANIFEST_KEYS) {
      if (supplied[key] === undefined) throw new Error(`--value is missing for ${key}.`);
    }
    render = xBookmarksLiveSchedulerDropinRender(supplied);
  }
  const outputPath = single('output');
  if (outputPath === undefined) process.stdout.write(render);
  else writeFileSync(outputPath, render, { mode: 0o644 });
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(75);
  }
}
