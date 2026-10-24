/**
 * Where Olympus keeps its data: the one module that computes the data root.
 *
 * Every source store, ledger and shared file lives under the data root, and a
 * module that needs one asks here instead of rebuilding the expression
 * (docs/design/source-storage.md, step 1). The functions return today's paths
 * and move nothing. Locations that disagree with the data root today are named
 * below as legacy, so the migration into account folders (step 4) has one
 * place to read them from.
 *
 * Deliberately free of SQLite and worker imports, directly and through
 * linux-engine-layout.ts: the dashboard's Unpair path and the CLI-side
 * lifecycle module both resolve through it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { standaloneLinuxDataDir } from './linux-engine-layout.ts';

export type LayoutEnv = Record<string, string | undefined>;

/** The home the environment names, else the process owner's. */
export function layoutHome(env: LayoutEnv = process.env): string {
  return env.HOME?.trim() || homedir();
}

/** `$XDG_DATA_HOME`, else `<home>/.local/share`. */
export function xdgDataHome(env: LayoutEnv = process.env): string {
  return env.XDG_DATA_HOME?.trim() || join(layoutHome(env), '.local', 'share');
}

/**
 * The data root: the standalone Linux engine's receipt `dataDir`, else
 * `<XDG data home>/openclaw/olympus` (macOS and OpenClaw-hosted).
 */
export function olympusDataRoot(env: LayoutEnv = process.env): string {
  const standalone = standaloneLinuxDataDir(env);
  if (standalone) return standalone;
  // A relative XDG_DATA_HOME is returned as given, as each resolver did
  // before; callers that refuse one (remote access) check for themselves.
  return join(xdgDataHome(env), 'openclaw', 'olympus');
}

/** A path under the data root. */
export function olympusDataPath(env: LayoutEnv, ...segments: string[]): string {
  return join(olympusDataRoot(env), ...segments);
}

/**
 * Legacy: `<XDG data home>/olympus`, outside the data root. The WhatsApp
 * bridge's state directory and Telegram's capture spool live here today.
 * Nothing new goes here; step 4 moves them into their account folders.
 */
export function legacyCaptureDataRoot(env: LayoutEnv = process.env): string {
  return join(xdgDataHome(env), 'olympus');
}

/**
 * Legacy: the WhatsApp capture service's default state directory. It ignores
 * `XDG_DATA_HOME`, while pairing and the worker's readers honor it
 * (`legacyCaptureDataRoot`), so with a non-default `XDG_DATA_HOME` they
 * disagree. Kept exactly, `HOME` untrimmed included; step 4 moves both into
 * the account folder.
 */
export function legacyWhatsAppServiceStateDir(env: LayoutEnv = process.env): string {
  return join(env.HOME ?? homedir(), '.local', 'share', 'olympus', 'whatsapp-live');
}

/**
 * Legacy: where Telegram's connector stores live today. It ignores
 * `XDG_DATA_HOME` (every other store honors it), so with a non-default
 * `XDG_DATA_HOME` the stores sit outside the data root. Kept exactly, because
 * resolving them anywhere else would open empty stores; step 4 moves them.
 */
export function legacyTelegramStoreRoot(env: LayoutEnv = process.env): string {
  return standaloneLinuxDataDir(env) ?? join(layoutHome(env), '.local', 'share', 'openclaw', 'olympus');
}

/**
 * Legacy: the Telegram reader's gateway state, under the XDG state home, where
 * `scripts/telegram-telethon-reader.py` writes it. The service's readiness
 * probe and Delete both read it from here; step 4 moves it.
 */
export function legacyTelegramGatewayStateDir(env: LayoutEnv = process.env): string {
  return env.OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR?.trim()
    || join(env.XDG_STATE_HOME?.trim() || join(layoutHome(env), '.local', 'state'), 'olympus', 'telegram-capture-gateway');
}
