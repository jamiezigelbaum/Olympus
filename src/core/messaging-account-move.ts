/**
 * What a Telegram or WhatsApp account's move into its folder (docs/design/
 * source-storage.md, delivery step 4d) needs outside the data folder: the
 * records that name where the account's session is.
 *
 * Three places name it, all written by pairing and connect:
 * - the capture grant (`messaging-capture.<source>.json` beside the handle
 *   registry): `sessionPath`, and the session path in `producer.env`
 *   (`OLYMPUS_TELEGRAM_SESSION_PATH`, `OLYMPUS_WHATSAPP_STATE_DIR`);
 * - the secret store's `<source>.<role>.session_path`, which Unpair treats as
 *   the authority on which files are the login;
 * - an Unpair that did not finish, whose record names the files it could not
 *   remove.
 *
 * Before the pass (`messagingMoveFacts`): an account whose records name any
 * place but the default legacy one, or that has an Unpair part way, stays
 * where it is (`pin`); one whose records cannot be read stays too
 * (`unreadable`). After it (`repointMovedMessagingAccounts`, every boot, so a
 * boot that stopped between the flip and the rewrite is finished by the next):
 * the grant of an account the pass moved loses its paths, as a folder
 * account's grant has none, and each stored session path that names the old
 * place names the folder's, as connect writes it for a folder account. Until
 * then nothing reads the old paths for a folder account: the capture child is
 * given the folder's paths last, and the dashboard derives the folder's.
 *
 * The records sit in the config folder, not the data folder, so they are not
 * part of the move's plan: the plan's flip is the commit, and these follow it.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { writePrivateFileAtomicSync } from './atomic-file.ts';
import type { MessagingCaptureGrant } from './messaging-capture.ts';
import { captureGrantPathFromEnv, readCaptureGrantFile, type CaptureGrantSource } from './messaging-capture-grant-file.ts';
import {
  TELEGRAM_SOURCE_ID,
  WHATSAPP_SOURCE_ID,
  accountRawPath,
  accountSessionPath,
  legacyOverrideEnvNames,
  legacyTelegramSessionBase,
  legacyWhatsAppDefaultStateDir,
  whatsappStateDirFromValue,
  type LayoutAccount,
  type LayoutEnv,
} from './olympus-layout.ts';
import type { MessagingMoveFacts } from './source-account-migration.ts';
import { DEFAULT_ACCOUNT_SLOT, findRegistryAccount, readSourceRegistry } from './source-registry.ts';
import type { SecretStore } from './secret-store.ts';
import { readUnpairedSources } from '../workers/credential-broker/unpaired-sources.ts';

const SOURCES: ReadonlyArray<{ sourceId: string; source: CaptureGrantSource; sessionEnv: string }> = [
  { sourceId: TELEGRAM_SOURCE_ID, source: 'telegram', sessionEnv: 'OLYMPUS_TELEGRAM_SESSION_PATH' },
  { sourceId: WHATSAPP_SOURCE_ID, source: 'whatsapp', sessionEnv: 'OLYMPUS_WHATSAPP_STATE_DIR' },
];

/** Whether a recorded session path names the account's default legacy session, in either spelling a reader may have used. */
export function namesDefaultLegacySession(source: CaptureGrantSource, value: string, env: LayoutEnv): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  if (source === 'telegram') {
    const base = trimmed.endsWith('.session') ? trimmed.slice(0, -'.session'.length) : trimmed;
    return resolve(base) === resolve(legacyTelegramSessionBase(env));
  }
  return resolve(whatsappStateDirFromValue(trimmed)) === resolve(legacyWhatsAppDefaultStateDir(env));
}

/** What a folder account's records name: connect stores Telegram's login base and WhatsApp's state folder. */
function folderSessionValue(source: CaptureGrantSource, env: LayoutEnv): string {
  const account: LayoutAccount = { source_id: source === 'telegram' ? TELEGRAM_SOURCE_ID : WHATSAPP_SOURCE_ID, slot: DEFAULT_ACCOUNT_SLOT, layout: 'folder' };
  return source === 'telegram' ? accountSessionPath(account, env) : accountRawPath(account, 'whatsapp', env);
}

/** The handle registry the grant and the Unpair record sit beside, as the worker finds it. */
function handleRegistryPath(env: LayoutEnv): string {
  return env.OLYMPUS_CREDENTIAL_HANDLE_REGISTRY_PATH?.trim() || join(env.HOME?.trim() || homedir(), '.config', 'olympus', 'handles.json');
}

/** Every secret key that may hold this source's session path: the canonical one, and any role's the store lists. */
async function sessionPathKeys(source: CaptureGrantSource, secretStore: SecretStore): Promise<string[]> {
  const keys = new Set([source === 'telegram' ? 'telegram.personal.session_path' : 'whatsapp.personal_local.session_path']);
  try {
    for (const key of await secretStore.list()) if (key.startsWith(`${source}.`) && key.endsWith('.session_path')) keys.add(key);
  } catch {
    // Listing is an optimization over the canonical key, as for Unpair.
  }
  return [...keys].sort();
}

/** The grant's own word on the session's place: the session path, and the path env it starts its child with. */
function grantSessionValues(grant: MessagingCaptureGrant, sessionEnv: string): string[] {
  const env = grant.producer.env as Record<string, unknown> | undefined;
  const fromEnv = env && typeof env[sessionEnv] === 'string' ? [env[sessionEnv] as string] : [];
  return [...(grant.sessionPath !== undefined ? [grant.sessionPath] : []), ...fromEnv];
}

/**
 * For each messaging source, what its records say about moving it (see the
 * module comment). Never throws: a record that cannot be read is the
 * account's `unreadable`.
 */
export async function messagingMoveFacts(env: LayoutEnv, secretStore: SecretStore): Promise<Record<string, MessagingMoveFacts>> {
  const facts: Record<string, MessagingMoveFacts> = {};
  const unpaired = readUnpairedSources(handleRegistryPath(env));
  for (const { sourceId, source, sessionEnv } of SOURCES) {
    facts[sourceId] = await factsFor(env, secretStore, unpaired, sourceId, source, sessionEnv);
  }
  return facts;
}

async function factsFor(
  env: LayoutEnv,
  secretStore: SecretStore,
  unpaired: ReturnType<typeof readUnpairedSources>,
  sourceId: string,
  source: CaptureGrantSource,
  sessionEnv: string,
): Promise<MessagingMoveFacts> {
  const read = readCaptureGrantFile(captureGrantPathFromEnv(source, env));
  if (read.kind === 'invalid' || (read.kind === 'valid' && read.grant.source !== source)) {
    return { unreadable: 'Its capture grant cannot be read, so it cannot be told where its session is.' };
  }
  if (read.kind === 'valid') {
    if (grantSessionValues(read.grant, sessionEnv).some((value) => !namesDefaultLegacySession(source, value, env))) {
      return { pin: 'Its capture grant names a session path of its own, so its files stay there.' };
    }
    const producerEnv = (read.grant.producer.env ?? {}) as Record<string, unknown>;
    const other = legacyOverrideEnvNames(sourceId).find((name) => name !== sessionEnv && typeof producerEnv[name] === 'string' && (producerEnv[name] as string).trim() !== '');
    if (other) return { pin: `Its capture grant starts capture with ${other}, so its files stay where that names.` };
  }
  try {
    for (const key of await sessionPathKeys(source, secretStore)) {
      const value = (await secretStore.get(key))?.trim();
      if (value && !namesDefaultLegacySession(source, value, env)) {
        return { pin: 'It was connected with a session path of its own, so its files stay there.' };
      }
    }
  } catch {
    return { unreadable: 'The session path it was connected with cannot be read from the secret store.' };
  }
  if (unpaired.status === 'unreadable') return { unreadable: 'The record of its last Unpair cannot be read.' };
  if (unpaired.status === 'ok' && unpaired.records.some((record) => record.source_id === sourceId && record.state !== 'unpaired')) {
    return { pin: 'An Unpair that did not finish names its files, so they stay where it can find them.' };
  }
  return {};
}

export interface MessagingRepointReport {
  /** `<sourceId>: grant` or `<sourceId>: <secret key>` for each record rewritten. */
  rewritten: string[];
  errors: Array<{ sourceId: string; message: string }>;
}

/**
 * For each messaging account a move finished (`layout: folder`, `migration.state:
 * done`), rewrites every record that still names its default legacy session:
 * the grant without paths, a stored session path as the folder's. Records that
 * name anything else are left alone (the pass never moves such an account).
 * Idempotent; never throws.
 */
export async function repointMovedMessagingAccounts(env: LayoutEnv, secretStore: SecretStore): Promise<MessagingRepointReport> {
  const report: MessagingRepointReport = { rewritten: [], errors: [] };
  let accounts;
  try {
    accounts = readSourceRegistry(env).accounts;
  } catch {
    return report;
  }
  for (const { sourceId, source, sessionEnv } of SOURCES) {
    const entry = findRegistryAccount({ schema: 2, accounts }, sourceId, DEFAULT_ACCOUNT_SLOT);
    if (!entry || entry.state !== 'active' || entry.layout !== 'folder' || entry.migration?.state !== 'done') continue;
    try {
      if (repointGrant(env, source, sessionEnv)) report.rewritten.push(`${sourceId}: capture grant`);
    } catch (error) {
      report.errors.push({ sourceId, message: `capture grant: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}` });
    }
    try {
      for (const key of await sessionPathKeys(source, secretStore)) {
        const value = await secretStore.get(key);
        if (value === undefined || !namesDefaultLegacySession(source, value, env)) continue;
        await secretStore.set(key, folderSessionValue(source, env));
        report.rewritten.push(`${sourceId}: ${key}`);
      }
    } catch (error) {
      report.errors.push({ sourceId, message: `secret store: ${(error as NodeJS.ErrnoException)?.code ?? 'error'}` });
    }
  }
  return report;
}

/** Drops the grant's paths when they name the default legacy session. Re-reads the file before it writes, so a grant a pairing wrote meanwhile stands. */
function repointGrant(env: LayoutEnv, source: CaptureGrantSource, sessionEnv: string): boolean {
  const path = captureGrantPathFromEnv(source, env);
  let before: string;
  try {
    before = readFileSync(path, 'utf8');
  } catch {
    return false; // No grant.
  }
  const read = readCaptureGrantFile(path);
  if (read.kind !== 'valid' || read.grant.source !== source) return false;
  const values = grantSessionValues(read.grant, sessionEnv);
  if (values.length === 0 || !values.every((value) => namesDefaultLegacySession(source, value, env))) return false;
  const { sessionPath: _dropped, ...rest } = read.grant;
  const producerEnv = { ...(read.grant.producer.env ?? {}) } as Record<string, string>;
  delete producerEnv[sessionEnv];
  const grant: MessagingCaptureGrant = { ...rest, producer: { ...read.grant.producer, env: producerEnv } };
  if (readFileSync(path, 'utf8') !== before) return false;
  writePrivateFileAtomicSync(path, `${JSON.stringify(grant, null, 2)}\n`);
  return true;
}
