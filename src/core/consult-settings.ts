// Outside-help (consult) settings: the internal mechanism only (design
// docs/design/frontier-consult-lane.md, revision 7, §A.9, build stage C3).
//
// One small file, `~/.olympus/consult.json`:
//
//   {"v": 1, "revision": N, "enabled": bool, "languages": [...],
//    "domains": {"units", "countries", "medicines", "medicineBrands"},
//    "strict": bool}
//
// - Read at every use, never cached, so a change needs no worker restart.
// - The parser is strict: an unknown key, a missing key or a malformed value
//   makes the whole file invalid. Absent, unreadable, insecure or invalid all
//   mean outside help is OFF (fail closed).
// - Writes are compare-and-swap on `revision`, under a cross-process lease,
//   replacing the file atomically with owner-only permissions.
// - A job binds the settings current at its creation (`bindConsultJobPolicy`);
//   final authorization re-reads the file and refuses if outside help was
//   turned off (`recheckConsultJobPolicy`).
//
// Changed only on the Mac. Nothing on the ChatGPT, MCP, setup-tool or relay
// surface may call the writer: a hosted agent must not be able to switch on
// egress (test/consult-settings.test.ts holds that boundary). The Mac
// dashboard enable path is stage C5, the public `olympus consult` command is
// C8, and strict mode's approval step is C6; none of them exists yet, so no
// user-facing path can turn outside help on.

import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import {
  CONSULT_LANGUAGE_PACKS,
  DEFAULT_CONSULT_DOMAIN_PACKS,
  DEFAULT_CONSULT_LANGUAGES,
  type ConsultDomainPacks,
  type ConsultGateOptions,
  type ConsultLanguage,
} from './consult-gate.ts';
import { withFileLeaseSync } from './file-lease.ts';

export const CONSULT_SETTINGS_VERSION = 1;
/** A settings file is a few hundred bytes; anything far larger is not one. */
export const CONSULT_SETTINGS_MAX_BYTES = 16 * 1024;

export interface ConsultSettings {
  readonly v: typeof CONSULT_SETTINGS_VERSION;
  /** Compare-and-swap counter; 0 means no file has been written. */
  readonly revision: number;
  /** Outside help on or off. */
  readonly enabled: boolean;
  /** Languages the writer may use and the gate admits (ConsultGateOptions). */
  readonly languages: readonly ConsultLanguage[];
  /** Domain packs the gate admits (ConsultGateOptions). */
  readonly domains: ConsultDomainPacks;
  /** Strict mode (C6 adds its approval step; recorded only until then). */
  readonly strict: boolean;
}

export type ConsultSettingsInvalidReason =
  | 'unreadable'
  | 'not_a_regular_file'
  | 'insecure_permissions'
  | 'too_large'
  | 'malformed_json'
  | 'invalid_shape';

export type ConsultSettingsRead =
  | { readonly state: 'absent'; readonly settings: ConsultSettings }
  | { readonly state: 'valid'; readonly settings: ConsultSettings }
  | { readonly state: 'invalid'; readonly reason: ConsultSettingsInvalidReason; readonly settings: ConsultSettings };

/** What a missing, unreadable or invalid file means: outside help off, gate defaults. */
export const DEFAULT_CONSULT_SETTINGS: ConsultSettings = Object.freeze({
  v: CONSULT_SETTINGS_VERSION,
  revision: 0,
  enabled: false,
  languages: Object.freeze([...DEFAULT_CONSULT_LANGUAGES]),
  domains: Object.freeze({ ...DEFAULT_CONSULT_DOMAIN_PACKS }),
  strict: false,
});

const TOP_LEVEL_KEYS = ['v', 'revision', 'enabled', 'languages', 'domains', 'strict'] as const;
const DOMAIN_KEYS = Object.keys(DEFAULT_CONSULT_DOMAIN_PACKS) as Array<keyof ConsultDomainPacks>;
const LANGUAGES = Object.keys(CONSULT_LANGUAGE_PACKS) as ConsultLanguage[];

/**
 * `~/.olympus/consult.json` for the given environment. An injected
 * environment is honoured exactly: without a HOME in it there is no path
 * (callers then read "absent", outside help off) rather than a silent fall
 * back to the process owner's home. Only a caller that passes no environment
 * at all gets the process's own home.
 */
export function consultSettingsPath(env?: Readonly<Record<string, string | undefined>>): string | undefined {
  if (env === undefined) return join(process.env.HOME?.trim() || homedir(), '.olympus', 'consult.json');
  const home = env.HOME?.trim();
  return home ? join(home, '.olympus', 'consult.json') : undefined;
}

export interface ConsultSettingsLocation {
  /** Explicit file path; wins over `env`. */
  readonly path?: string;
  /** Environment whose HOME locates the file. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function resolvePath(location: ConsultSettingsLocation): string | undefined {
  return location.path ?? consultSettingsPath(location.env);
}

/**
 * Strict parse of a settings document. Returns undefined for anything that is
 * not exactly the schema: unknown or missing keys at either level, a version
 * other than 1, a revision that is not a non-negative safe integer, non-boolean
 * flags, an empty, duplicated or unknown language list.
 */
export function parseConsultSettings(value: unknown): ConsultSettings | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!hasExactKeys(value, TOP_LEVEL_KEYS)) return undefined;
  const { v, revision, enabled, languages, domains, strict } = value;
  if (v !== CONSULT_SETTINGS_VERSION) return undefined;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return undefined;
  if (typeof enabled !== 'boolean' || typeof strict !== 'boolean') return undefined;
  if (!Array.isArray(languages) || languages.length === 0 || languages.length > LANGUAGES.length) return undefined;
  if (!languages.every((language): language is ConsultLanguage =>
    typeof language === 'string' && (LANGUAGES as string[]).includes(language))) return undefined;
  if (new Set(languages).size !== languages.length) return undefined;
  if (!isPlainObject(domains) || !hasExactKeys(domains, DOMAIN_KEYS)) return undefined;
  if (!DOMAIN_KEYS.every((key) => typeof domains[key] === 'boolean')) return undefined;
  return freezeSettings({
    v: CONSULT_SETTINGS_VERSION,
    revision,
    enabled,
    languages: languages as ConsultLanguage[],
    domains: Object.fromEntries(DOMAIN_KEYS.map((key) => [key, domains[key] as boolean])) as unknown as ConsultDomainPacks,
    strict,
  });
}

/**
 * Read the settings now. Never throws and never caches. Anything other than a
 * regular, owner-controlled file holding exactly the schema reads as outside
 * help off.
 */
export function readConsultSettings(location: ConsultSettingsLocation = {}): ConsultSettingsRead {
  const path = resolvePath(location);
  if (path === undefined) return { state: 'absent', settings: DEFAULT_CONSULT_SETTINGS };
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return { state: 'absent', settings: DEFAULT_CONSULT_SETTINGS };
    }
    return invalid('unreadable');
  }
  if (!stats.isFile() || stats.isSymbolicLink()) return invalid('not_a_regular_file');
  // A file another local account could write would let that account switch on
  // egress; a file owned by someone else is not this owner's choice.
  if ((stats.mode & 0o022) !== 0) return invalid('insecure_permissions');
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return invalid('insecure_permissions');
  if (stats.size > CONSULT_SETTINGS_MAX_BYTES) return invalid('too_large');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return invalid('unreadable');
  }
  if (Buffer.byteLength(text, 'utf8') > CONSULT_SETTINGS_MAX_BYTES) return invalid('too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('malformed_json');
  }
  const settings = parseConsultSettings(parsed);
  return settings ? { state: 'valid', settings } : invalid('invalid_shape');
}

/** True only for a valid file that turns outside help on. */
export function consultOutsideHelpEnabled(read: ConsultSettingsRead): boolean {
  return read.state === 'valid' && read.settings.enabled;
}

/** The gate options the settings select (languages and domain packs). */
export function consultGateOptionsFromSettings(settings: ConsultSettings): ConsultGateOptions {
  return { languages: [...settings.languages], domains: { ...settings.domains } };
}

export interface ConsultSettingsChange {
  readonly enabled: boolean;
  readonly languages: readonly ConsultLanguage[];
  readonly domains: ConsultDomainPacks;
  readonly strict: boolean;
}

export type ConsultSettingsWriteResult =
  | { readonly ok: true; readonly settings: ConsultSettings }
  | { readonly ok: false; readonly reason: 'revision_conflict'; readonly currentRevision: number }
  | { readonly ok: false; readonly reason: 'current_invalid'; readonly invalidReason: ConsultSettingsInvalidReason };

/**
 * Compare-and-swap write. Succeeds only when the file's current revision equals
 * `expectedRevision` (0 when there is no file); the new file carries
 * `expectedRevision + 1`. A file that exists but is invalid is never
 * overwritten. The check and the replacement run under one cross-process lease
 * and the file is replaced atomically, created owner-only (0600) inside an
 * owner-only directory.
 *
 * Internal: no ChatGPT, MCP, setup-tool or relay path may call this. The Mac
 * dashboard enable path (C5) will be its first caller.
 */
export function writeConsultSettings(
  location: ConsultSettingsLocation,
  expectedRevision: number,
  change: ConsultSettingsChange,
): ConsultSettingsWriteResult {
  const path = resolvePath(location);
  if (path === undefined) throw new Error('Consult settings have no location: the environment has no HOME.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Consult settings expectedRevision must be a non-negative integer.');
  }
  const next = parseConsultSettings({
    v: CONSULT_SETTINGS_VERSION,
    revision: expectedRevision + 1,
    enabled: change.enabled,
    languages: change.languages,
    domains: change.domains,
    strict: change.strict,
  });
  if (!next) throw new Error('Consult settings change is not valid.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return withFileLeaseSync<ConsultSettingsWriteResult>(path, (lease) => {
    const current = readConsultSettings({ path });
    if (current.state === 'invalid') return { ok: false, reason: 'current_invalid', invalidReason: current.reason };
    if (current.settings.revision !== expectedRevision) {
      return { ok: false, reason: 'revision_conflict', currentRevision: current.settings.revision };
    }
    lease.commit(() => writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`));
    return { ok: true, settings: next };
  });
}

/**
 * The outside-help part of a job's policy, bound when the job is created.
 * Later changes to the settings never alter it (design "Job policy").
 */
export interface ConsultJobPolicy {
  readonly settingsRevision: number;
  readonly outsideHelp: boolean;
  readonly languages: readonly ConsultLanguage[];
  readonly domains: ConsultDomainPacks;
  readonly strict: boolean;
}

export function bindConsultJobPolicy(read: ConsultSettingsRead): ConsultJobPolicy {
  const settings = read.state === 'valid' ? read.settings : DEFAULT_CONSULT_SETTINGS;
  return Object.freeze({
    settingsRevision: settings.revision,
    outsideHelp: consultOutsideHelpEnabled(read),
    languages: Object.freeze([...settings.languages]),
    domains: Object.freeze({ ...settings.domains }),
    strict: settings.strict,
  });
}

export type ConsultJobPolicyRecheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bound_off' | 'settings_absent' | 'settings_invalid' | 'settings_off' };

/**
 * Final authorization's settings check: the job must have bound outside help
 * on, and the file re-read now must still be valid with outside help on.
 */
export function recheckConsultJobPolicy(policy: ConsultJobPolicy, current: ConsultSettingsRead): ConsultJobPolicyRecheck {
  if (!policy.outsideHelp) return { ok: false, reason: 'bound_off' };
  if (current.state === 'absent') return { ok: false, reason: 'settings_absent' };
  if (current.state === 'invalid') return { ok: false, reason: 'settings_invalid' };
  if (!current.settings.enabled) return { ok: false, reason: 'settings_off' };
  return { ok: true };
}

function invalid(reason: ConsultSettingsInvalidReason): ConsultSettingsRead {
  return { state: 'invalid', reason, settings: DEFAULT_CONSULT_SETTINGS };
}

function freezeSettings(settings: ConsultSettings): ConsultSettings {
  return Object.freeze({
    ...settings,
    languages: Object.freeze([...settings.languages]),
    domains: Object.freeze({ ...settings.domains }),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
