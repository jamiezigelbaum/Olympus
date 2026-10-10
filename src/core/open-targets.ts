/**
 * The closed set of places an `olympus://` link may open (owner decision,
 * 2026-10-09: no Terminal step for "do this on your computer").
 *
 * Any website can fire an `olympus://` link (the browser asks first), so the
 * link is only ever a request to SHOW a page: the handler maps it to one of
 * these targets and opens the local dashboard there. Nothing in a link is
 * passed through: the target is looked up from this list by exact match, and
 * every other `olympus://` link opens the plain dashboard.
 *
 * Pure and dependency-free: the CLI, the opening page, the olympusplugin.ai
 * /open/ pages and the ChatGPT view model all read the same list.
 * docs/design/open-on-computer.md holds the threat model.
 */

export const OLYMPUS_URL_SCHEME = 'olympus';

/** The sources set up on the computer, by the short id a link names. */
export const OPEN_CONNECT_SOURCES = {
  x: { sourceId: 'x.bookmarks', label: 'X bookmarks' },
  readwise: { sourceId: 'readwise.library', label: 'Readwise' },
  telegram: { sourceId: 'telegram.messages', label: 'Telegram' },
  whatsapp: { sourceId: 'whatsapp.personal.messages', label: 'WhatsApp' },
} as const;

export type OpenConnectSource = keyof typeof OPEN_CONNECT_SOURCES;

/** The sections of https://olympusplugin.ai/help/on-your-computer/ a fix can name. */
export const OPEN_FIX_SECTIONS = ['connect', 'reconnect', 'answers', 'search', 'models'] as const;

export type OpenFixSection = typeof OPEN_FIX_SECTIONS[number];

/**
 * The sources whose files can be unreadable (the extraction factory reads
 * them), by the short id a link names: `unreadable/<id>` opens the computer's
 * dashboard with See why expanded on that source, where every unreadable
 * file is listed and opens (owner ruling, 2026-10-10).
 */
export const OPEN_UNREADABLE_SOURCES = {
  dropbox: { sourceId: 'dropbox.files', label: 'Dropbox' },
  drive: { sourceId: 'google_drive.docs', label: 'Google Drive' },
  whatsapp: { sourceId: 'whatsapp.personal.messages', label: 'WhatsApp' },
} as const;

export type OpenUnreadableSource = keyof typeof OPEN_UNREADABLE_SOURCES;

export type OpenTarget =
  | { kind: 'dashboard' }
  | { kind: 'connect'; source: OpenConnectSource }
  | { kind: 'fix'; section: OpenFixSection }
  | { kind: 'unreadable'; source: OpenUnreadableSource };

/** The longest link the handler reads at all; anything longer is ignored. */
export const OPEN_URL_MAX_LENGTH = 128;

/** Every target, in a fixed order (the /open/ pages are generated from it). */
export function allOpenTargets(): OpenTarget[] {
  return [
    { kind: 'dashboard' },
    ...(Object.keys(OPEN_CONNECT_SOURCES) as OpenConnectSource[]).map((source) => ({ kind: 'connect' as const, source })),
    ...OPEN_FIX_SECTIONS.map((section) => ({ kind: 'fix' as const, section })),
    ...(Object.keys(OPEN_UNREADABLE_SOURCES) as OpenUnreadableSource[]).map((source) => ({ kind: 'unreadable' as const, source })),
  ];
}

/** `dashboard`, `connect/x`, `fix/models`: the path after `olympus://open/` and `/open/`. */
export function openTargetPath(target: OpenTarget): string {
  if (target.kind === 'connect') return `connect/${target.source}`;
  if (target.kind === 'fix') return `fix/${target.section}`;
  if (target.kind === 'unreadable') return `unreadable/${target.source}`;
  return 'dashboard';
}

/** The target a path names exactly (`connect/x`), or undefined: never a fallback. */
export function openTargetFromPath(path: unknown): OpenTarget | undefined {
  if (typeof path !== 'string') return undefined;
  return allOpenTargets().find((target) => openTargetPath(target) === path);
}

/** `olympus://open/<path>`. */
export function olympusOpenUrl(target: OpenTarget): string {
  return `${OLYMPUS_URL_SCHEME}://open/${openTargetPath(target)}`;
}

/** The olympusplugin.ai page that tries the link and says what to do when nothing happens. */
export const OPEN_PAGE_BASE_URL = 'https://olympusplugin.ai/open/';

export function openPageUrl(target: OpenTarget): string {
  return `${OPEN_PAGE_BASE_URL}${openTargetPath(target)}/`;
}

/**
 * The result of reading a link:
 * - a target, when the link is exactly one of the allowlisted ones;
 * - `{ kind: 'dashboard', fallback: true }` for any other well-formed
 *   `olympus:` link (unknown, malformed or hostile: it opens the plain
 *   dashboard and carries nothing through);
 * - undefined for anything that is not a short printable `olympus:` link,
 *   which opens nothing.
 */
export function parseOlympusOpenUrl(raw: unknown): (OpenTarget & { fallback?: true }) | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > OPEN_URL_MAX_LENGTH) return undefined;
  // Printable ASCII only: no spaces, controls, quotes or non-ASCII look-alikes.
  if (!/^[\x21-\x7e]+$/.test(raw) || /["'`\\<>]/.test(raw)) return undefined;
  if (!raw.toLowerCase().startsWith(`${OLYMPUS_URL_SCHEME}:`)) return undefined;
  const match = /^olympus:\/\/open\/([a-z]+(?:\/[a-z]+)?)\/?$/.exec(raw);
  const path = match?.[1];
  if (path !== undefined) {
    for (const target of allOpenTargets()) {
      if (openTargetPath(target) === path) return target;
    }
  }
  return { kind: 'dashboard', fallback: true };
}

/**
 * The opening ticket's companion in the launch fragment (`olympus_open=`), and
 * the dashboard fragment (`#olympus-open=`): `connect.x`, `fix.models`. Absent
 * for the plain dashboard.
 */
export function openTargetToken(target: OpenTarget): string | undefined {
  if (target.kind === 'connect') return `connect.${target.source}`;
  if (target.kind === 'fix') return `fix.${target.section}`;
  if (target.kind === 'unreadable') return `unreadable.${target.source}`;
  return undefined;
}

/** The exact tokens, as one anchored pattern source, for the pages that must check one without importing this module. */
export function openTargetTokenPattern(): string {
  const tokens = allOpenTargets().map(openTargetToken).filter((token): token is string => token !== undefined);
  return `^(?:${tokens.map((token) => token.replace('.', '\\.')).join('|')})$`;
}

/**
 * The targets the computer's Keys page opens something for: Connect for a
 * source set up on the computer, and the model fixes (Models). Every other
 * target (the dashboard, a ChatGPT connect or reconnect fix) lands on the
 * plain dashboard.
 */
export function isKeysOpenTarget(target: OpenTarget): boolean {
  return target.kind === 'connect'
    || (target.kind === 'fix' && (target.section === 'models' || target.section === 'answers' || target.section === 'search'));
}

/** The Keys targets' tokens, as one anchored pattern source (see openTargetTokenPattern). */
export function keysOpenTargetTokenPattern(): string {
  const tokens = allOpenTargets().filter(isKeysOpenTarget).map(openTargetToken).filter((token): token is string => token !== undefined);
  return `^(?:${tokens.map((token) => token.replace('.', '\\.')).join('|')})$`;
}

/**
 * The targets that land in the dashboard panel itself (See why on one
 * source), not on Keys: the opening page sends them to
 * `/dashboard#olympus-open=<token>`, and the computer's host page tells the
 * panel where to land.
 */
export function isPanelOpenTarget(target: OpenTarget): boolean {
  return target.kind === 'unreadable';
}

/** The panel targets' tokens, as one anchored pattern source (see openTargetTokenPattern). */
export function panelOpenTargetTokenPattern(): string {
  const tokens = allOpenTargets().filter(isPanelOpenTarget).map(openTargetToken).filter((token): token is string => token !== undefined);
  return `^(?:${tokens.map((token) => token.replace('.', '\\.')).join('|')})$`;
}

/** The dashboard source id a panel target lands on, by its token: `unreadable.dropbox` → `dropbox.files`. */
export function panelOpenTargetSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const target of allOpenTargets()) {
    if (target.kind !== 'unreadable') continue;
    out[openTargetToken(target)!] = OPEN_UNREADABLE_SOURCES[target.source].sourceId;
  }
  return out;
}

/** The short id of the unreadable target for a dashboard source id, if it has one. */
export function openUnreadableSourceFor(sourceId: string): OpenUnreadableSource | undefined {
  return (Object.keys(OPEN_UNREADABLE_SOURCES) as OpenUnreadableSource[])
    .find((source) => OPEN_UNREADABLE_SOURCES[source].sourceId === sourceId);
}

export const DASHBOARD_OPEN_FRAGMENT_KEY = 'olympus-open';
export const DASHBOARD_LAUNCH_OPEN_KEY = 'olympus_open';
