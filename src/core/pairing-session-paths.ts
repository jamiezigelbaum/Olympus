import { lstatSync, realpathSync, rmSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Where Telegram's and WhatsApp's pairing sessions live, and which roots
 * Olympus owns.
 *
 * This module exists so the two surfaces that resolve those paths cannot
 * drift: `data-lifecycle.ts` (export/delete custody) and the dashboard's
 * Unpair control. Their delete surfaces are deliberately NOT the same — the
 * lifecycle module also names the WhatsApp spool and media directories, which
 * hold the raw message text and captured audio, while Unpair must remove the
 * pairing session artifacts and nothing else. Naming the session artifacts in
 * exactly one place is what keeps that distinction reviewable: the narrow list
 * is here, and the wider one is built by adding to it, never by re-deriving
 * the same paths a second time.
 *
 * It carries no SQLite or worker imports on purpose. The worker bundles this;
 * `data-lifecycle.ts` is a CLI-side module and must not be pulled in behind it.
 */
export interface OlympusPathContext {
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

function resolveHomeDir(context: OlympusPathContext): string {
  return context.homeDir?.trim() || homedir();
}

/**
 * Every directory tree Olympus claims as its own.
 *
 * The fence in front of any delete reads this list: a state directory an
 * operator has pointed outside all of them cannot be proven ours, and the
 * honest answer is to refuse rather than to recursively remove a stranger's
 * files.
 */
export function olympusDataRoots(context: OlympusPathContext = {}): string[] {
  const home = resolveHomeDir(context);
  return [
    join(home, '.olympus'),
    join(home, '.config', 'olympus'),
    join(home, '.local', 'share', 'olympus'),
    join(home, '.local', 'share', 'openclaw', 'olympus'),
    join(home, '.local', 'state', 'olympus'),
    join(home, '.cache', 'olympus'),
    join(home, 'Library', 'Logs', 'Olympus'),
  ];
}

/**
 * The WhatsApp bridge's state directory, resolved the way the canonical
 * capture/store sync runtime resolves it (`scripts/whatsapp-live-sync.ts`).
 */
export function whatsappStateDir(context: OlympusPathContext = {}): string {
  const env = context.env ?? {};
  const configured = env.OLYMPUS_WHATSAPP_STATE_DIR?.trim();
  return configured
    ? whatsappStateDirFromValue(configured)
    : join(
      env.XDG_DATA_HOME?.trim() || join(resolveHomeDir(context), '.local', 'share'),
      'olympus',
      'whatsapp-live',
    );
}

/**
 * The whatsmeow linked-device session and the pairing QR — the artifacts that
 * make this computer a linked WhatsApp device — and nothing else.
 *
 * Deliberately excludes `spool/` and `media/`: those are the corpus, not the
 * pairing. Removing them behind a control labelled Unpair would be a silent
 * data deletion.
 */
export function whatsappPairingSessionPaths(context: OlympusPathContext = {}): string[] {
  const stateDir = whatsappStateDir(context);
  const sessionDb = join(stateDir, 'session.db');
  return [sessionDb, `${sessionDb}-wal`, `${sessionDb}-shm`, join(stateDir, 'qr.txt')];
}

/**
 * Strip the extension Telethon appends, so a base and the `.session` file that
 * belongs to it normalize to the same thing.
 *
 * Both spellings are in circulation and both are legitimate: Telethon takes a
 * BASE and appends `.session`, while QUICKSTART's own example passes the
 * `.session` file. Normalizing in exactly one place is what stops the env
 * derivation and the stored derivation from producing `custom.session` and
 * `custom.session.session` for the same pairing and then reporting a conflict
 * between a session and itself.
 */
function telegramSessionBase(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('.session') ? trimmed.slice(0, -'.session'.length) : trimmed;
}

/** Normalize either spelling of a WhatsApp state location to the directory. */
function whatsappStateDirFromValue(value: string): string {
  const trimmed = value.trim();
  return basename(trimmed) === 'session.db' ? dirname(trimmed) : trimmed;
}

/** The Telethon session file base path, without its extensions. */
export function telegramSessionBasePath(context: OlympusPathContext = {}): string {
  const env = context.env ?? {};
  const home = context.homeDir?.trim() || env.HOME?.trim() || homedir();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  const configured = env.OLYMPUS_TELEGRAM_SESSION_PATH?.trim();
  return configured
    ? telegramSessionBase(configured)
    : join(dataHome, 'olympus', 'telegram', 'telegram.personal');
}

/**
 * The Telethon mtproto login and its journal. The capture spool, gateway state
 * and drain cursor are ingest state, not pairing, and are not named here.
 */
export function telegramPairingSessionPaths(context: OlympusPathContext = {}): string[] {
  const base = telegramSessionBasePath(context);
  return [`${base}.session`, `${base}.session-journal`];
}

/**
 * The session artifacts derived from a session path the owner actually
 * registered, which is the authority whenever one exists.
 *
 * `olympus connect telegram|whatsapp --session-path <path>` stores an arbitrary
 * path, and the env/default derivation above is only a guess about where that
 * pairing lives. Deriving the sidecars from the stored value is what stops
 * Unpair from deleting nothing, reporting success, and leaving a usable login
 * on disk under a card that says unpaired.
 *
 * Both spellings a reader may have registered are accepted, because both are
 * documented: Telethon takes a session BASE and appends `.session`, while
 * QUICKSTART's own example passes the `.session` file itself. WhatsApp's value
 * is the state directory, and `session.db` inside it is accepted too.
 */
export function pairingSessionPathsFromStoredValue(
  source: 'telegram' | 'whatsapp',
  storedValue: string,
): string[] {
  const value = storedValue.trim();
  if (value === '') return [];
  // The SAME normalization the env derivation uses, so the two can only ever
  // disagree about which session is meant, never about how to spell one.
  if (source === 'telegram') {
    const base = telegramSessionBase(value);
    return [`${base}.session`, `${base}.session-journal`];
  }
  const stateDir = whatsappStateDirFromValue(value);
  const sessionDb = join(stateDir, 'session.db');
  return [sessionDb, `${sessionDb}-wal`, `${sessionDb}-shm`, join(stateDir, 'qr.txt')];
}

/** Whether an explicit env override names where this pairing session lives. */
export function pairingSessionPathOverridden(
  source: 'telegram' | 'whatsapp',
  context: OlympusPathContext = {},
): boolean {
  const env = context.env ?? {};
  const value = source === 'telegram'
    ? env.OLYMPUS_TELEGRAM_SESSION_PATH
    : env.OLYMPUS_WHATSAPP_STATE_DIR;
  return (value?.trim() ?? '') !== '';
}

/**
 * Why one pairing path may not be deleted.
 *
 * `symlink_component` is the load-bearing one. Lexical containment inside an
 * Olympus-owned root proves nothing about where a delete lands: with
 * `~/.local/share/olympus/whatsapp-live` a symlink to `/srv/other-data`, the
 * derived `session.db` passes any string comparison while `rmSync` follows the
 * link and removes a stranger's file. Every existing component from the owned
 * root down to the target is therefore lstat'd, and a link anywhere along that
 * walk refuses the whole operation.
 */
export type PairingPathRefusalReason =
  | 'outside_root'
  | 'symlink_component'
  | 'not_a_regular_file'
  | 'inspection_failed';

export interface PairingPathRefusal {
  reason: PairingPathRefusalReason;
  /** The pairing artifact that was being validated. */
  path: string;
  /** The component that caused the refusal; equal to `path` for a leaf refusal. */
  component: string;
}

export interface PairingRemovalTarget {
  path: string;
  /**
   * The real path of the parent directory as it was at validation time.
   *
   * Re-read immediately before the unlink: an ancestor swapped for a symlink
   * between validation and deletion is the same escape as one that was a
   * symlink all along, and this is what catches it.
   */
  parentRealPath: string;
}

export interface PairingRemovalPlan {
  /** Existing regular-file artifacts, in the order they were given. */
  targets: PairingRemovalTarget[];
  /** Artifacts that do not exist. Nothing to do, and not an error. */
  absent: string[];
}

export class PairingSessionPathError extends Error {
  refusal: PairingPathRefusal;

  constructor(refusal: PairingPathRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

/**
 * Validate EVERY pairing artifact before ANY of them is deleted.
 *
 * Interleaving validation with deletion means a later refusal lands after
 * earlier artifacts are already gone, which is a half-removed pairing reported
 * as a clean failure. Planning first makes the refusal total.
 */
export function planPairingSessionRemoval(
  paths: readonly string[],
  context: OlympusPathContext = {},
): { ok: true; plan: PairingRemovalPlan } | { ok: false; refusal: PairingPathRefusal } {
  const roots = olympusDataRoots(context).map((root) => resolve(root));
  const canonicalRoots = canonicalOlympusDataRoots(roots);
  const targets: PairingRemovalTarget[] = [];
  const absent: string[] = [];
  for (const path of paths) {
    const validated = validatePairingPath(path, roots, canonicalRoots);
    if ('refusal' in validated) return { ok: false, refusal: validated.refusal };
    if (validated.target === undefined) {
      absent.push(resolve(path));
      continue;
    }
    targets.push(validated.target);
  }
  return { ok: true, plan: { targets, absent } };
}

/**
 * The Olympus-owned roots as the filesystem actually resolves them.
 *
 * The lexical list is built from `$HOME`, so it is only a spelling. Relocating
 * `~/.local` — or `~/.local/share/olympus` itself — onto another volume with a
 * symlink is a normal, legitimate layout, and treating the lexical string as
 * the fence meant the ancestor was never inspected at all: an lstat of the
 * completed root path resolves every directory above the final component, so
 * the root looked like an ordinary directory and every check below it passed
 * while the delete landed outside the lexical tree.
 *
 * Canonicalizing instead of refusing is the point. `realpath(root) != root` is
 * not evidence of anything wrong; it is what a relocated data directory looks
 * like. The canonical form is the fence, so a legitimate move keeps working and
 * an escape below the root has nowhere to land.
 *
 * A root that does not exist contributes nothing — there is nothing under it to
 * delete — and one that resolves to a non-directory is not a root either.
 */
function canonicalOlympusDataRoots(roots: readonly string[]): string[] {
  const canonical: string[] = [];
  for (const root of roots) {
    try {
      const real = realpathSync(root);
      if (lstatSync(real).isDirectory()) canonical.push(real);
    } catch {
      // Absent or unreadable: not a root this run can vouch for.
    }
  }
  return [...new Set(canonical)];
}

function isInsideCanonicalRoot(path: string, canonicalRoots: readonly string[]): boolean {
  return canonicalRoots.some((root) => path === root || path.startsWith(`${root}${sep}`));
}

function validatePairingPath(
  path: string,
  roots: readonly string[],
  canonicalRoots: readonly string[],
): { target: PairingRemovalTarget | undefined } | { refusal: PairingPathRefusal } {
  const absolute = resolve(path);
  const root = roots.find((candidate) =>
    absolute === candidate || absolute.startsWith(`${candidate}${sep}`));
  if (root === undefined || absolute === root) {
    return { refusal: { reason: 'outside_root', path: absolute, component: absolute } };
  }
  // A root that does not exist holds nothing to delete. The root itself is NOT
  // rejected for being a symlink: that is the relocation case, and the
  // canonical fence below is what decides whether the target is really ours.
  const rootInspection = inspectPath(root);
  if (rootInspection.kind === 'error') {
    return { refusal: { reason: 'inspection_failed', path: absolute, component: root } };
  }
  if (rootInspection.kind === 'absent') return { target: undefined };
  const components = relative(root, absolute).split(sep).filter((part) => part !== '');
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const inspection = inspectPath(current);
    if (inspection.kind === 'error') {
      return { refusal: { reason: 'inspection_failed', path: absolute, component: current } };
    }
    // Nothing exists from here down, so there is nothing to delete and nothing
    // to refuse. A path created later is validated by the run that sees it.
    if (inspection.kind === 'absent') return { target: undefined };
    const stat = inspection.stat;
    if (stat.isSymbolicLink()) {
      return { refusal: { reason: 'symlink_component', path: absolute, component: current } };
    }
    const leaf = index === components.length - 1;
    if (leaf && !stat.isFile()) {
      return { refusal: { reason: 'not_a_regular_file', path: absolute, component: current } };
    }
    if (!leaf && !stat.isDirectory()) return { target: undefined };
  }
  let parentRealPath: string;
  try {
    parentRealPath = realpathSync(dirname(absolute));
  } catch {
    return { refusal: { reason: 'inspection_failed', path: absolute, component: dirname(absolute) } };
  }
  // The fence that actually decides. Everything above is about catching an
  // escape with a specific, nameable reason; this is the one check that cannot
  // be walked around, because it asks where the delete would truly land.
  if (!isInsideCanonicalRoot(parentRealPath, canonicalRoots)) {
    return { refusal: { reason: 'outside_root', path: absolute, component: parentRealPath } };
  }
  return { target: { path: absolute, parentRealPath } };
}

/**
 * Delete one planned artifact, re-proving custody first.
 *
 * The parent's real path and the target's own lstat are re-read here rather
 * than trusted from the plan, so an ancestor swapped for a symlink after
 * validation is refused instead of followed.
 *
 * This does NOT close the race, and must not be described as if it does. A
 * window remains between this lstat/realpath pair and the unlink below, because
 * neither Node nor Bun exposes `unlinkat`, and without a directory file
 * descriptor there is no way to remove a name relative to the directory that
 * was just verified. The threat model is what makes the residue acceptable:
 * winning this race requires write access to the owner's own data directory —
 * the same uid this worker runs as — and anything holding that can delete these
 * files directly without involving Unpair at all. The component walk in
 * `planPairingSessionRemoval` and these re-checks are defence in depth against
 * a persistent misconfiguration or a stale symlink, not a boundary against a
 * local attacker who already has the worker's own privileges.
 */
export function removePlannedPairingSessionFile(target: PairingRemovalTarget): 'removed' | 'already_gone' {
  const inspection = inspectPath(target.path);
  if (inspection.kind === 'error') {
    throw new PairingSessionPathError(
      { reason: 'inspection_failed', path: target.path, component: target.path },
      `Pairing artifact could not be inspected before removal (${inspection.code}): ${target.path}`,
    );
  }
  if (inspection.kind === 'absent') return 'already_gone';
  const stat = inspection.stat;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PairingSessionPathError(
      { reason: 'not_a_regular_file', path: target.path, component: target.path },
      `Pairing artifact changed to a non-regular file before removal: ${target.path}`,
    );
  }
  let parentRealPath: string;
  try {
    parentRealPath = realpathSync(dirname(target.path));
  } catch (error) {
    throw new PairingSessionPathError(
      { reason: 'inspection_failed', path: target.path, component: dirname(target.path) },
      `Pairing artifact's parent directory could not be resolved before removal: ${(error as Error).message}`,
    );
  }
  if (parentRealPath !== target.parentRealPath) {
    throw new PairingSessionPathError(
      { reason: 'symlink_component', path: target.path, component: dirname(target.path) },
      `Pairing artifact's parent directory changed between validation and removal: ${target.path}`,
    );
  }
  rmSync(target.path, { force: true });
  return 'removed';
}

type PathInspection =
  | { kind: 'absent' }
  | { kind: 'stat'; stat: Stats }
  | { kind: 'error'; code: string };

/**
 * lstat one component, distinguishing "is not there" from "could not look".
 *
 * Swallowing every error made an EACCES or EIO on a component read as an absent
 * artifact, so Unpair skipped a session it could not inspect and then reported
 * the removal complete. Only ENOENT and ENOTDIR mean the path genuinely does
 * not exist — ENOTDIR being the case where a component above it is a file, so
 * nothing can live below. Every other failure is an unknown, and an unknown in
 * front of a delete is a refusal.
 */
function inspectPath(path: string): PathInspection {
  try {
    return { kind: 'stat', stat: lstatSync(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'error', code };
  }
}
