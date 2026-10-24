/**
 * Reading openclaw.json for the Olympus plugin entry, kept apart from config.ts
 * so path resolvers (linux-engine-layout.ts, and through it the data-root
 * layout) can ask whether OpenClaw hosts Olympus without loading the rest of
 * the config module and the workers it imports.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute as isAbsolutePath, join } from 'node:path';

/** Where OpenClaw keeps its config: OPENCLAW_CONFIG_PATH, else the state folder's openclaw.json. */
export function openClawConfigPath(homeDir: string, env: Record<string, string | undefined>): string {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit && isAbsolutePath(explicit)) return explicit;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  return join(stateDir && isAbsolutePath(stateDir) ? stateDir : join(homeDir, '.openclaw'), 'openclaw.json');
}

/**
 * What openclaw.json says about the Olympus plugin's `remote` section, for a
 * worker the Gateway did not launch (a systemd or launchd worker unit, or
 * `olympus worker run`). Such a worker gets no handoff from the Gateway, so it
 * reads the section from the file the Gateway reads.
 *
 * - `hosted: false`: no openclaw.json, no `olympus` entry, or the entry is
 *   disabled. OpenClaw does not run Olympus here and has nothing to say.
 * - `hosted: true` with `remote`: the section as written (undefined when the
 *   entry has no `remote`).
 * - `hosted: true` with `unreadable`: the file exists but could not be read or
 *   parsed, so its remote settings are unknown.
 *
 * Values are read as written. OpenClaw resolves SecretRefs, `${VAR}`
 * substitution and `$include` before the Gateway hands config to its own
 * services; this reader does none of that, so a value written that way does
 * not resolve to a usable setting here.
 */
export type OpenClawPluginRemote =
  | { hosted: false }
  | { hosted: true; path: string; remote: Record<string, unknown> | undefined }
  | { hosted: true; path: string; unreadable: true };

export function readOpenClawPluginRemote(env: Record<string, string | undefined>): OpenClawPluginRemote {
  const path = openClawConfigPath(env.HOME?.trim() || homedir(), env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Only a file that is not there says nothing. One that cannot be read may
    // hold a remote section, and falling back to engine.json then could bring
    // back demo credentials openclaw.json has since turned off.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { hosted: false };
    return { hosted: true, path, unreadable: true };
  }
  const parsed = parseOpenClawConfigText(text);
  // Unparseable for the same reason: a truncated file may have lost the very
  // entry that disabled demo sign-in.
  if (parsed === undefined) return { hosted: true, path, unreadable: true };
  const entries = asRecord(asRecord(asRecord(parsed)?.plugins)?.entries);
  const entry = entries && Object.hasOwn(entries, 'olympus') ? asRecord(entries.olympus) : undefined;
  if (!entry || entry.enabled === false) return { hosted: false };
  return { hosted: true, path, remote: asRecord(asRecord(entry.config)?.remote) };
}

/** openclaw.json is JSON as OpenClaw writes it, and may be JSON5 when edited by hand. */
function parseOpenClawConfigText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // The worker runs on Bun, which parses JSON5; elsewhere strict JSON is all there is.
    const json5 = (globalThis as { Bun?: { JSON5?: { parse(text: string): unknown } } }).Bun?.JSON5;
    if (!json5) return undefined;
    try {
      return json5.parse(text);
    } catch {
      return undefined;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
