// Outside-help (consult) settings: the internal reader (design
// docs/design/frontier-consult-lane.md, revision 7, §A.9, build stage C3).
//
// One small file, `~/.olympus/consult.json`:
//
//   {"v": 1, "revision": N, "enabled": bool, "languages": [...],
//    "domains": {"units", "countries", "places", "technical", "medicines", "medicineBrands"},
//    "strict": bool, "level": "unnamed" | "general",
//    "writer": {"baseUrl", "model", "secretRef"?, "timeoutMs"?},   (optional)
//    "chatgptFrontierModel": "provider/model"}                    (optional)
//
// - Read at every use, never cached, so a change needs no worker restart.
// - The parser is strict: invalid UTF-8, a duplicated key, an unknown key, a
//   missing key or a malformed value makes the whole file invalid. Absent,
//   unreadable, insecure or invalid all mean outside help is OFF (fail closed).
// - A job binds the settings current at its creation (`bindConsultJobPolicy`);
//   final authorization re-reads the file and refuses unless it is still the
//   same revision with outside help on (`recheckConsultJobPolicy`).
// - `level` says what the consult writer may send (owner decision
//   2026-10-07): "unnamed" (the user's situation with names and other
//   identifying details removed) or "general" (textbook questions only, the
//   writer's original rules). The key is optional for the reader: a file
//   written before it existed reads as "unnamed", the recommended level and
//   the default everywhere (owner decision 2026-10-08). That is safe because
//   nothing is sent until the owner has accepted the current statements,
//   which say what this level sends (zkapi-consult-settings.ts, enforced at
//   send time by the transport). The writer always writes the key.
//
// - `writer` (optional, owner decision 2026-10-10; design
//   docs/design/private-answers.md, "Writer: your own local model") names the
//   owner's own OpenAI-compatible model server (Ollama, LM Studio, a
//   llama.cpp server, a home server on the LAN or tailnet) that writes the
//   outside question in place of the built-in model. It reads the private
//   evidence, so it is the owner's choice of where that goes: any HTTP(S)
//   address is accepted, with no allowlist. Absent: the built-in model.
//   It lives here, not in the sovereignty policy, because sovereignty local
//   profiles are loopback-only (a home server on the LAN would be refused),
//   and this file is read at every use, so a change needs no restart.
// - `chatgptFrontierModel` (optional) is the zkAPI model for questions that
//   came through ChatGPT, where a model from another provider than OpenAI
//   is better (OpenAI also holds the ChatGPT conversation). Absent: the
//   zkAPI route's own `model`. No default is chosen here.
//
// This module only reads. The compare-and-swap writer lands with its first
// caller, the Mac dashboard enable path (stage C5), in its own module; the
// public `olympus consult` command is C8 and strict mode's approval step is
// C6. Until then no path at all can turn outside help on. The settings are
// changed only on the Mac, never from ChatGPT, an agent tool or the relay.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSecretRef } from './secret-store.ts';
import {
  CONSULT_LANGUAGE_PACKS,
  DEFAULT_CONSULT_DOMAIN_PACKS,
  DEFAULT_CONSULT_LANGUAGES,
  type ConsultDomainPacks,
  type ConsultGateOptions,
  type ConsultLanguage,
  type ConsultLevel,
} from './consult-gate.ts';

export type { ConsultLevel };

export const CONSULT_SETTINGS_VERSION = 1;
/** A settings file is a few hundred bytes; anything far larger is not one. */
export const CONSULT_SETTINGS_MAX_BYTES = 16 * 1024;

export const CONSULT_LEVELS: readonly ConsultLevel[] = Object.freeze(['unnamed', 'general']);
/**
 * The level of a file without the `level` key: the recommended level
 * (owner decision 2026-10-08). Sending still needs the current statements
 * accepted, and they state what this level sends.
 */
export const CONSULT_LEVEL_WHEN_UNSET: ConsultLevel = 'unnamed';
/** The level a new settings file is written with (no file yet): the same default. */
export const CONSULT_LEVEL_FOR_NEW_SETUP: ConsultLevel = CONSULT_LEVEL_WHEN_UNSET;
/**
 * The level a damaged file is rewritten with when the owner chose none: the
 * narrower one, so a repair never widens what is sent. A repair always
 * leaves outside help off.
 */
export const CONSULT_LEVEL_FOR_REPAIR: ConsultLevel = 'general';

/** The owner's own model server for the consult writer (`writer` in consult.json). */
export interface ConsultWriterChoice {
  /** OpenAI-compatible base URL, usually ending in `/v1`. Any HTTP(S) host the owner chose. */
  readonly baseUrl: string;
  readonly model: string;
  /** `env:NAME` or `store:name`; resolved like the sovereignty profiles' keys, never stored here. */
  readonly secretRef?: string;
  /** The writer's deadline in milliseconds (default CONSULT_OWN_WRITER_DEFAULT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/** Bounds of the owner's writer deadline. */
export const CONSULT_OWN_WRITER_TIMEOUT_BOUNDS_MS = Object.freeze({ min: 10_000, max: 240_000 });
export const CONSULT_OWN_WRITER_DEFAULT_TIMEOUT_MS = 180_000;
const MAX_MODEL_ID_CHARS = 200;
const MAX_BASE_URL_CHARS = 500;

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
  /** What the consult writer may send. */
  readonly level: ConsultLevel;
  /** The owner's own writer model; absent means the built-in model writes. */
  readonly writer?: ConsultWriterChoice;
  /** The zkAPI model for questions that came through ChatGPT; absent means the route's model. */
  readonly chatgptFrontierModel?: string;
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

/**
 * What a missing, unreadable or invalid file means: outside help off, gate
 * defaults. Its level is the new-setup default, which is what a first write
 * from no file records; it never sends anything, since outside help is off.
 */
export const DEFAULT_CONSULT_SETTINGS: ConsultSettings = Object.freeze({
  v: CONSULT_SETTINGS_VERSION,
  revision: 0,
  enabled: false,
  languages: Object.freeze([...DEFAULT_CONSULT_LANGUAGES]),
  domains: Object.freeze({ ...DEFAULT_CONSULT_DOMAIN_PACKS }),
  strict: false,
  level: CONSULT_LEVEL_FOR_NEW_SETUP,
});

const REQUIRED_TOP_LEVEL_KEYS = ['v', 'revision', 'enabled', 'languages', 'domains', 'strict'] as const;
const OPTIONAL_TOP_LEVEL_KEYS = ['level', 'writer', 'chatgptFrontierModel'] as const;
const WRITER_REQUIRED_KEYS = ['baseUrl', 'model'] as const;
const WRITER_OPTIONAL_KEYS = ['secretRef', 'timeoutMs'] as const;
const DOMAIN_KEYS = Object.keys(DEFAULT_CONSULT_DOMAIN_PACKS) as Array<keyof ConsultDomainPacks>;
const OPTIONAL_DOMAIN_KEYS: readonly string[] = ['places', 'technical'];
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
 * integer, non-boolean flags, an empty, duplicated or unknown language list,
 * a level other than "unnamed" or "general". `level` alone may be absent: a
 * file without it reads as "unnamed" (CONSULT_LEVEL_WHEN_UNSET).
 */
export function parseConsultSettings(value: unknown): ConsultSettings | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!hasKeys(value, REQUIRED_TOP_LEVEL_KEYS, OPTIONAL_TOP_LEVEL_KEYS)) return undefined;
  const { v, revision, enabled, languages, domains, strict } = value;
  const level = Object.hasOwn(value, 'level') ? value.level : CONSULT_LEVEL_WHEN_UNSET;
  if (typeof level !== 'string' || !(CONSULT_LEVELS as readonly string[]).includes(level)) return undefined;
  if (v !== CONSULT_SETTINGS_VERSION) return undefined;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return undefined;
  if (typeof enabled !== 'boolean' || typeof strict !== 'boolean') return undefined;
  if (!Array.isArray(languages) || languages.length === 0 || languages.length > LANGUAGES.length) return undefined;
  if (!languages.every((language): language is ConsultLanguage =>
    typeof language === 'string' && (LANGUAGES as string[]).includes(language))) return undefined;
  if (new Set(languages).size !== languages.length) return undefined;
  // Keys added after the first schema are optional and default on, so a file
  // written before them stays valid; every other key is required, and an
  // unknown key is still rejected.
  if (!isPlainObject(domains)) return undefined;
  if (!Object.keys(domains).every((key) => (DOMAIN_KEYS as string[]).includes(key))) return undefined;
  if (!DOMAIN_KEYS.every((key) => key in domains ? typeof domains[key] === 'boolean' : OPTIONAL_DOMAIN_KEYS.includes(key))) return undefined;
  let writer: ConsultWriterChoice | undefined;
  if (Object.hasOwn(value, 'writer')) {
    writer = parseConsultWriterChoice(value.writer);
    if (!writer) return undefined;
  }
  let chatgptFrontierModel: string | undefined;
  if (Object.hasOwn(value, 'chatgptFrontierModel')) {
    chatgptFrontierModel = parseModelId(value.chatgptFrontierModel);
    if (!chatgptFrontierModel) return undefined;
  }
  return Object.freeze({
    v: CONSULT_SETTINGS_VERSION,
    revision,
    enabled,
    languages: Object.freeze([...languages]),
    domains: Object.freeze(Object.fromEntries(DOMAIN_KEYS.map((key) => [key, key in domains ? domains[key] as boolean : true])) as unknown as ConsultDomainPacks),
    strict,
    level: level as ConsultLevel,
    ...(writer ? { writer } : {}),
    ...(chatgptFrontierModel ? { chatgptFrontierModel } : {}),
  });
}

function parseModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.length > MAX_MODEL_ID_CHARS || /[\u0000-\u001F\u007F\s]/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * The `writer` block: an HTTP(S) base URL without credentials, query or
 * fragment, a model id, an optional key reference and an optional deadline.
 * Any host is accepted (loopback, LAN, tailnet): where the owner's own
 * model runs is the owner's choice (owner decision 2026-10-10).
 */
export function parseConsultWriterChoice(value: unknown): ConsultWriterChoice | undefined {
  if (!isPlainObject(value) || !hasKeys(value, WRITER_REQUIRED_KEYS, WRITER_OPTIONAL_KEYS)) return undefined;
  const { baseUrl, secretRef, timeoutMs } = value;
  if (typeof baseUrl !== 'string' || baseUrl.length > MAX_BASE_URL_CHARS || baseUrl.trim() !== baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const model = parseModelId(value.model);
  if (!model) return undefined;
  if (secretRef !== undefined && (typeof secretRef !== 'string' || !normalizeSecretRef(secretRef))) return undefined;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < CONSULT_OWN_WRITER_TIMEOUT_BOUNDS_MS.min || timeoutMs > CONSULT_OWN_WRITER_TIMEOUT_BOUNDS_MS.max)) return undefined;
  return Object.freeze({
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    ...(typeof secretRef === 'string' ? { secretRef: secretRef.trim() } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
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

/** The gate options the settings select (languages, domain packs and level). */
export function consultGateOptionsFromSettings(settings: ConsultSettings): ConsultGateOptions {
  return { languages: [...settings.languages], domains: { ...settings.domains }, level: settings.level };
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
  /** What the writer may send for this job; a change since binding refuses at final authorization. */
  readonly level: ConsultLevel;
  /**
   * The owner's own writer as bound at job creation (consult.json `writer`),
   * or null for the built-in writer. The consult runs this writer, gives it
   * evidence and applies its gate net from this one value; a different writer
   * in the file at final authorization refuses (independent review of
   * PR #209: the writer and the gate net must never disagree).
   */
  readonly writer: ConsultWriterChoice | null;
}

/** A writer's identity for comparison: everything that selects where and how the question is written. */
export function consultWriterIdentity(choice: ConsultWriterChoice | null | undefined): string {
  if (!choice) return 'built-in';
  return JSON.stringify([choice.baseUrl, choice.model, choice.secretRef ?? null, choice.timeoutMs ?? null]);
}

export function bindConsultJobPolicy(read: ConsultSettingsRead): ConsultJobPolicy {
  const settings = read.state === 'valid' ? read.settings : DEFAULT_CONSULT_SETTINGS;
  return Object.freeze({
    settingsRevision: settings.revision,
    outsideHelp: consultOutsideHelpEnabled(read),
    languages: Object.freeze([...settings.languages]),
    domains: Object.freeze({ ...settings.domains }),
    strict: settings.strict,
    level: settings.level,
    writer: settings.writer ? Object.freeze({ ...settings.writer }) : null,
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
 * still on, and exactly the revision and level the job bound. Any change
 * since the job was created, even one that turned outside help off and on
 * again, refuses. A level change always moves the revision through the
 * writer; the level is compared as well so a file edited by hand without a
 * new revision cannot widen what a bound job sends, and so is the writer
 * (consultWriterIdentity), which selects the gate net.
 */
export function recheckConsultJobPolicy(policy: ConsultJobPolicy, current: ConsultSettingsRead): ConsultJobPolicyRecheck {
  if (!policy.outsideHelp) return { ok: false, reason: 'bound_off' };
  if (current.state === 'absent') return { ok: false, reason: 'settings_absent' };
  if (current.state === 'invalid') return { ok: false, reason: 'settings_invalid' };
  if (current.settings.revision !== policy.settingsRevision) return { ok: false, reason: 'settings_stale' };
  if (current.settings.level !== policy.level) return { ok: false, reason: 'settings_stale' };
  // The writer too: a bound job never sends under another writer's gate net.
  if (consultWriterIdentity(current.settings.writer) !== consultWriterIdentity(policy.writer ?? null)) return { ok: false, reason: 'settings_stale' };
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

/** Every required key present, and no key outside required plus optional. */
function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
