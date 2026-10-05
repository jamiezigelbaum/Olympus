// Outside-help (consult) settings: the internal reader (design
// docs/design/frontier-consult-lane.md, revision 7, §A.9, build stage C3).
//
// One small file, `~/.olympus/consult.json`:
//
//   {"v": 1, "revision": N, "enabled": bool, "languages": [...],
//    "domains": {"units", "countries", "medicines", "medicineBrands"},
//    "strict": bool}
//
// - Read at every use, never cached, so a change needs no worker restart.
// - The parser is strict: invalid UTF-8, a duplicated key, an unknown key, a
//   missing key or a malformed value makes the whole file invalid. Absent,
//   unreadable, insecure or invalid all mean outside help is OFF (fail closed).
// - A job binds the settings current at its creation (`bindConsultJobPolicy`);
//   final authorization re-reads the file and refuses unless it is still the
//   same revision with outside help on (`recheckConsultJobPolicy`).
//
// This module only reads. The compare-and-swap writer lands with its first
// caller, the Mac dashboard enable path (stage C5), in its own module; the
// public `olympus consult` command is C8 and strict mode's approval step is
// C6. Until then no path at all can turn outside help on. The settings are
// changed only on the Mac, never from ChatGPT, an agent tool or the relay.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSULT_LANGUAGE_PACKS,
  DEFAULT_CONSULT_DOMAIN_PACKS,
  DEFAULT_CONSULT_LANGUAGES,
  type ConsultDomainPacks,
  type ConsultGateOptions,
  type ConsultLanguage,
} from './consult-gate.ts';

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
  | 'invalid_utf8'
  | 'malformed_json'
  | 'duplicate_key'
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

export interface ConsultSettingsLocation {
  /** Explicit file path; wins over `env`. */
  readonly path?: string;
  /** Environment whose HOME locates the file; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * `<HOME>/.olympus/consult.json` from the given environment (process.env when
 * none is given). There is no fallback to the operating system's idea of the
 * home directory: without a HOME there is no path, and the settings read as
 * absent, outside help off.
 */
export function consultSettingsPath(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const home = env.HOME?.trim();
  return home ? join(home, '.olympus', 'consult.json') : undefined;
}

/**
 * Test seams: `afterOpen` runs after the file is opened and before it is
 * examined; `afterStat` runs after the size check and before the read. A test
 * uses them to swap or grow the file in between.
 */
export const __consultSettingsTestHooks: {
  afterOpen: ((path: string) => void) | undefined;
  /** Called after the descriptor's size check, before the bounded read. */
  afterStat: ((path: string) => void) | undefined;
  /** Called with the total number of bytes the bounded read took. */
  afterRead: ((bytes: number) => void) | undefined;
} = { afterOpen: undefined, afterStat: undefined, afterRead: undefined };

/**
 * Strict schema check of a parsed settings document. Returns undefined for
 * anything that is not exactly the schema: unknown or missing keys at either
 * level, a version other than 1, a revision that is not a non-negative safe
 * integer, non-boolean flags, an empty, duplicated or unknown language list.
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
  return Object.freeze({
    v: CONSULT_SETTINGS_VERSION,
    revision,
    enabled,
    languages: Object.freeze([...languages]),
    domains: Object.freeze(Object.fromEntries(DOMAIN_KEYS.map((key) => [key, domains[key] as boolean])) as unknown as ConsultDomainPacks),
    strict,
  });
}

/**
 * Parse settings text: valid JSON with no object holding the same key twice
 * (compared after escape decoding, at every depth), then the strict schema.
 */
export function parseConsultSettingsText(text: string): ConsultSettingsRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('malformed_json');
  }
  if (hasDuplicateObjectKey(text)) return invalid('duplicate_key');
  const settings = parseConsultSettings(parsed);
  return settings ? { state: 'valid', settings } : invalid('invalid_shape');
}

/**
 * Read the settings now. Never throws and never caches. The file is opened
 * once, without following a symlink and without blocking (a FIFO cannot hang
 * it); type, owner, mode and size are checked on that descriptor, and at most
 * one byte past the limit is read from the same descriptor. Anything other
 * than a regular, owner-controlled file holding exactly the schema reads as
 * outside help off.
 */
export function readConsultSettings(location: ConsultSettingsLocation = {}): ConsultSettingsRead {
  try {
    const path = location.path ?? consultSettingsPath(location.env ?? process.env);
    if (path === undefined) return { state: 'absent', settings: DEFAULT_CONSULT_SETTINGS };
    let descriptor: number;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent', settings: DEFAULT_CONSULT_SETTINGS };
      // ELOOP: the final component is a symlink, which is never followed.
      if (code === 'ELOOP' || code === 'EMLINK') return invalid('not_a_regular_file');
      return invalid('unreadable');
    }
    try {
      __consultSettingsTestHooks.afterOpen?.(path);
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) return invalid('not_a_regular_file');
      // A file another local account could write would let that account
      // switch on egress; a file owned by someone else is not this owner's.
      if ((stats.mode & 0o022) !== 0) return invalid('insecure_permissions');
      if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) return invalid('insecure_permissions');
      if (stats.size > CONSULT_SETTINGS_MAX_BYTES) return invalid('too_large');
      __consultSettingsTestHooks.afterStat?.(path);
      // Read to EOF but never past the limit plus one byte, so a file that
      // grows after the size check is still caught.
      const buffer = Buffer.alloc(CONSULT_SETTINGS_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (read === 0) break;
        length += read;
      }
      __consultSettingsTestHooks.afterRead?.(length);
      if (length > CONSULT_SETTINGS_MAX_BYTES) return invalid('too_large');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      } catch {
        return invalid('invalid_utf8');
      }
      return parseConsultSettingsText(text);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return invalid('unreadable');
  }
}

/** True only for a valid file that turns outside help on. */
export function consultOutsideHelpEnabled(read: ConsultSettingsRead): boolean {
  return read.state === 'valid' && read.settings.enabled;
}

/** The gate options the settings select (languages and domain packs). */
export function consultGateOptionsFromSettings(settings: ConsultSettings): ConsultGateOptions {
  return { languages: [...settings.languages], domains: { ...settings.domains } };
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
  | {
    readonly ok: false;
    readonly reason: 'bound_off' | 'settings_absent' | 'settings_invalid' | 'settings_off' | 'settings_stale';
  };

/**
 * Final authorization's settings check (design §A.8 step 2, test B5): the job
 * must have bound outside help on, and the file re-read now must be valid,
 * still on, and exactly the revision the job bound. Any change since the job
 * was created, even one that turned outside help off and on again, refuses.
 */
export function recheckConsultJobPolicy(policy: ConsultJobPolicy, current: ConsultSettingsRead): ConsultJobPolicyRecheck {
  if (!policy.outsideHelp) return { ok: false, reason: 'bound_off' };
  if (current.state === 'absent') return { ok: false, reason: 'settings_absent' };
  if (current.state === 'invalid') return { ok: false, reason: 'settings_invalid' };
  if (current.settings.revision !== policy.settingsRevision) return { ok: false, reason: 'settings_stale' };
  if (!current.settings.enabled) return { ok: false, reason: 'settings_off' };
  return { ok: true };
}

function invalid(reason: ConsultSettingsInvalidReason): ConsultSettingsRead {
  return { state: 'invalid', reason, settings: DEFAULT_CONSULT_SETTINGS };
}

/**
 * Whether any object in already-valid JSON text names the same key twice.
 * JSON.parse silently keeps the last one, so `"enabled":false,"enabled":true`
 * would otherwise read as on. Keys are compared after escape decoding.
 */
function hasDuplicateObjectKey(text: string): boolean {
  const frames: Array<{ keys: Set<string> | undefined; expectKey: boolean }> = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') {
      frames.push({ keys: new Set(), expectKey: true });
    } else if (char === '[') {
      frames.push({ keys: undefined, expectKey: false });
    } else if (char === '}' || char === ']') {
      frames.pop();
    } else if (char === ',') {
      const top = frames.at(-1);
      if (top?.keys) top.expectKey = true;
    } else if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = frames.at(-1);
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(index, end + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      index = end;
    }
  }
  return false;
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
