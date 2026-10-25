// A `legacy` Telegram or WhatsApp account resolves every path exactly as the
// messaging resolvers did before they learned account folders
// (docs/design/source-storage.md, delivery step 4b). The expected values are a
// fixture generated once from the functions as they stood on main
// (test/fixtures/messaging-resolution-golden.json), never computed with the
// code under test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FOLDER_LAYOUT_SOURCES, legacyCaptureDataRoot, legacyTelegramGatewayStateDir, legacyTelegramStoreRoot, legacyWhatsAppServiceStateDir } from '../src/core/olympus-layout.ts';
import { lifecycleAccountFiles } from '../src/data-lifecycle.ts';
import {
  telegramPairingSessionPaths,
  telegramSessionBasePath,
  whatsappPairingSessionPaths,
  whatsappStateDir,
} from '../src/core/pairing-session-paths.ts';
import { sourceRegistryPath } from '../src/core/source-registry.ts';
import { defaultTelegramCaptureSpoolDir } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import {
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from '../src/workers/telegram-messages/corpus-adapter.ts';
import {
  defaultWhatsAppConnectorStoreDbPath,
  defaultWhatsAppInternalConnectorStoreDbPath,
  defaultWhatsAppMediaDir,
  defaultWhatsAppSpoolDir,
  defaultWhatsAppStateDir,
  whatsAppLiveSyncScriptPaths,
} from '../src/workers/whatsapp/store-sync.ts';
import golden from './fixtures/messaging-resolution-golden.json';

type Env = Record<string, string | undefined>;
type Resolvers = Record<string, (env: Env) => unknown>;

const files = (sourceId: string, env: Env) => lifecycleAccountFiles(sourceId, { env });

const resolvers: Resolvers = {
  'tg.store.internal': (env) => defaultInternalTelegramConnectorStoreDbPath(env),
  'tg.store.protected': (env) => defaultProtectedTelegramConnectorStoreDbPath(env),
  'tg.spool': (env) => defaultTelegramCaptureSpoolDir(env),
  'tg.gateway_state': (env) => legacyTelegramGatewayStateDir(env),
  'tg.store_root': (env) => legacyTelegramStoreRoot(env),
  'tg.capture_root': (env) => legacyCaptureDataRoot(env),
  'tg.session_base': (env) => telegramSessionBasePath({ env }),
  'tg.session_base+home': (env) => telegramSessionBasePath({ env, homeDir: env.HOME! }),
  'tg.session_paths': (env) => telegramPairingSessionPaths({ env }),
  'tg.lifecycle.stores': (env) => files('telegram.messages', env).stores,
  'tg.lifecycle.raw': (env) => files('telegram.messages', env).raw,
  'tg.lifecycle.preservation': (env) => files('telegram.messages', env).preserved,
  'tg.lifecycle.pairing': (env) => files('telegram.messages', env).pairing,
  'wa.state': (env) => defaultWhatsAppStateDir(env),
  'wa.spool': (env) => defaultWhatsAppSpoolDir(env),
  'wa.media': (env) => defaultWhatsAppMediaDir(env),
  'wa.store': (env) => defaultWhatsAppConnectorStoreDbPath(env),
  'wa.internal_store': (env) => defaultWhatsAppInternalConnectorStoreDbPath(env),
  'wa.service_state': (env) => legacyWhatsAppServiceStateDir(env),
  'wa.pair_state': (env) => whatsappStateDir({ env }),
  'wa.pair_state+home': (env) => whatsappStateDir({ env, homeDir: env.HOME! }),
  'wa.pair_paths': (env) => whatsappPairingSessionPaths({ env }),
  'wa.lifecycle.stores': (env) => files('whatsapp.personal.messages', env).stores,
  'wa.lifecycle.raw': (env) => files('whatsapp.personal.messages', env).raw,
  'wa.lifecycle.pairing': (env) => files('whatsapp.personal.messages', env).pairing,
  // scripts/whatsapp-live-sync.ts: its own legacy resolution (it ignored XDG and the spool and store overrides), expected from the script as it stood on main.
  'script.wa.paths': (env) => {
    const { spoolDir, dbPath } = whatsAppLiveSyncScriptPaths(env, env.HOME);
    return { spoolDir, dbPath };
  },
};

const GOLDEN = golden.cases as Record<string, Record<string, unknown>>;

const TELEGRAM_OVERRIDES = [
  'OLYMPUS_TELEGRAM_SESSION_PATH',
  'OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR',
  'OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR',
  'OLYMPUS_TELEGRAM_SPOOL_DRAIN_SPOOL_DIR',
  'OLYMPUS_TELEGRAM_SPOOL_DRAIN_STATE_DIR',
  'OLYMPUS_TELEGRAM_SPOOL_DRAIN_CURSOR_PATH',
];
const WHATSAPP_OVERRIDES = [
  'OLYMPUS_WHATSAPP_STATE_DIR',
  'OLYMPUS_WHATSAPP_LIVE_DRAIN_SPOOL_DIR',
  'OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR',
  'OLYMPUS_WHATSAPP_TRANSCRIBE_MEDIA_DIR',
  'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_WHATSAPP_CONNECTOR_STORE_DB_PATH',
  'OLYMPUS_WHATSAPP_LIVE_DRAIN_DB_PATH',
  'OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH',
];
const OVERRIDE_GROUPS: Record<string, string[]> = { telegram: TELEGRAM_OVERRIDES, whatsapp: WHATSAPP_OVERRIDES };

let base: string;
let home: string;
let xdg: string;
let state: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'olympus-messaging-golden-'));
  home = join(base, 'home');
  xdg = join(base, 'xdg');
  state = join(base, 'state');
  for (const dir of [home, xdg, state]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** The fixture's `{HOME}`, `{XDG}` and `{STATE}` made real, in a path, a list or an environment value. */
function realized<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replaceAll('{HOME}', home).replaceAll('{XDG}', xdg).replaceAll('{STATE}', state));
}

/** The registry a pre-folder install has: every source adopted as `legacy`. */
function writeLegacyRegistry(env: Env): void {
  const path = sourceRegistryPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schema: 1,
    accounts: FOLDER_LAYOUT_SOURCES.map((source_id) => ({
      source_id,
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: [],
      created_at: '2026-10-01T00:00:00.000Z',
    })),
  })}\n`);
}

// What each case sets, besides the home: the same environments the fixture was
// generated with. An override case sets one variable, padded, to prove the trim.
// Every case runs under the platform it was generated under: darwin unless it says Linux.
function caseEnv(name: string): { env: Env; platform: string } {
  const homeOnly = { HOME: home };
  if (name === 'default') return { platform: 'darwin', env: homeOnly };
  if (name === 'xdg') return { platform: 'darwin', env: { ...homeOnly, XDG_DATA_HOME: xdg } };
  if (name === 'xdg-padded') return { platform: 'darwin', env: { ...homeOnly, XDG_DATA_HOME: `  ${xdg}  ` } };
  if (name === 'state-home') return { platform: 'darwin', env: { ...homeOnly, XDG_STATE_HOME: state } };
  if (name === 'state-home-padded') return { platform: 'darwin', env: { ...homeOnly, XDG_STATE_HOME: `  ${state}  ` } };
  if (name === 'xdg-and-state') return { platform: 'darwin', env: { ...homeOnly, XDG_DATA_HOME: xdg, XDG_STATE_HOME: state } };
  if (name === 'home-padded') return { platform: 'darwin', env: { HOME: `  ${home}  ` } };
  if (name === 'linux-receipt') return { platform: 'linux', env: { ...homeOnly, OLYMPUS_STANDALONE: '1' } };
  if (name === 'linux-receipt-xdg') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: xdg, OLYMPUS_STANDALONE: '1' } };
  // An OpenClaw-hosted Linux process: no standalone marker, so the hosted namespace.
  if (name === 'linux-hosted') return { platform: 'linux', env: homeOnly };
  if (name === 'linux-hosted-xdg') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: xdg } };
  if (name === 'linux-hosted-xdg-padded') return { platform: 'linux', env: { ...homeOnly, XDG_DATA_HOME: `  ${xdg}  ` } };
  const single = /^override:(.*)$/.exec(name);
  if (single) return { platform: 'darwin', env: { ...homeOnly, [single[1]!]: `  /golden/override/${single[1]!.toLowerCase()}  ` } };
  const blank = /^override-blank:(.*)$/.exec(name);
  if (blank) return { platform: 'darwin', env: { ...homeOnly, ...Object.fromEntries((OVERRIDE_GROUPS[blank[1]!] ?? []).map((n) => [n, '   '])) } };
  const all = /^override-all:(.*)$/.exec(name);
  if (all) {
    return {
      platform: 'darwin',
      env: {
        ...homeOnly,
        XDG_DATA_HOME: xdg,
        XDG_STATE_HOME: state,
        ...Object.fromEntries((OVERRIDE_GROUPS[all[1]!] ?? []).map((n) => [n, `/golden/override/${n.toLowerCase()}`])),
      },
    };
  }
  if (name === 'session-with-extension') return { platform: 'darwin', env: { ...homeOnly, OLYMPUS_TELEGRAM_SESSION_PATH: ' /golden/session/custom.session ' } };
  if (name === 'whatsapp-state-is-session-db') return { platform: 'darwin', env: { ...homeOnly, OLYMPUS_WHATSAPP_STATE_DIR: ' /golden/wa/session.db ' } };
  if (name === 'transcribe-state-only') {
    return { platform: 'darwin', env: { ...homeOnly, OLYMPUS_WHATSAPP_TRANSCRIBE_STATE_DIR: '/golden/transcribe', OLYMPUS_WHATSAPP_STATE_DIR: '/golden/wa' } };
  }
  // The plugin-config capture paths reach the capture services through these names.
  if (name === 'plugin-config-paths') {
    return {
      platform: 'darwin',
      env: {
        ...homeOnly,
        OLYMPUS_TELEGRAM_SESSION_PATH: '/golden/plugin/telegram/personal.session',
        OLYMPUS_TELEGRAM_GATEWAY_STATE_DIR: '/golden/plugin/telegram/state',
        OLYMPUS_TELEGRAM_GATEWAY_SPOOL_DIR: '/golden/plugin/telegram/spool',
        OLYMPUS_WHATSAPP_STATE_DIR: '/golden/plugin/whatsapp',
      },
    };
  }
  throw new Error(`unknown golden case ${name}`);
}

/** What the fixture records for a resolver that throws on main. */
const throwsOf = (expected: unknown): string | undefined =>
  expected && typeof expected === 'object' && '$throws' in expected ? String((expected as { $throws: unknown }).$throws) : undefined;

/** A resolver gives the fixture's answer, or throws the fixture's error where main threw. */
function expectResolves(name: string, key: string, env: Env, expected: unknown): void {
  const message = throwsOf(expected);
  if (message !== undefined) expect(() => resolvers[key]!(env), `${name}: ${key}`).toThrow(message);
  else expect(resolvers[key]!(env), `${name}: ${key}`).toEqual(realized(expected));
}

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const cases = Object.keys(GOLDEN);

describe('a legacy messaging account resolves exactly what main resolved', () => {
  test('the fixture covers the default, XDG, state home, Linux receipt, every override and the plugin-config paths', () => {
    expect(cases).toEqual(expect.arrayContaining([
      'default', 'xdg', 'xdg-padded', 'state-home', 'xdg-and-state', 'home-padded',
      'linux-receipt', 'linux-receipt-xdg', 'linux-hosted', 'linux-hosted-xdg', 'linux-hosted-xdg-padded',
      'session-with-extension', 'whatsapp-state-is-session-db', 'transcribe-state-only', 'plugin-config-paths',
    ]));
    for (const [group, names] of Object.entries(OVERRIDE_GROUPS)) {
      for (const override of names) expect(cases).toContain(`override:${override}`);
      expect(cases).toContain(`override-blank:${group}`);
      expect(cases).toContain(`override-all:${group}`);
    }
    // Every resolver the fixture names is exercised below, and the other way round.
    const keys = new Set(cases.flatMap((name) => Object.keys(GOLDEN[name]!)));
    expect([...keys].filter((key) => !(key in resolvers))).toEqual([]);
    expect(Object.keys(resolvers).filter((key) => !keys.has(key))).toEqual([]);
  });

  test.each(cases)('with an entry for it: %s', (name) => {
    const { env, platform } = caseEnv(name);
    const results = GOLDEN[name]!;
    withPlatform(platform, () => {
      // Where main cannot work out the data folder at all, no registry can be written either.
      if (!Object.values(results).some((expected) => throwsOf(expected) !== undefined)) writeLegacyRegistry(env);
      for (const [key, expected] of Object.entries(results)) expectResolves(name, key, env, expected);
    });
  });

  test('Linux refuses a padded XDG_DATA_HOME as main did, on the resolvers that need the data folder', () => {
    const results = GOLDEN['linux-hosted-xdg-padded']!;
    const thrown = Object.entries(results).filter(([, expected]) => throwsOf(expected) !== undefined).map(([key]) => key).sort();
    expect(thrown).toEqual(['tg.lifecycle.stores', 'tg.store.internal', 'tg.store.protected', 'tg.store_root']);
  });

  test.each(['default', 'xdg', 'linux-receipt'])('with legacy files and no entry: %s', (name) => {
    const { env, platform } = caseEnv(name);
    const results = GOLDEN[name]!;
    withPlatform(platform, () => {
      // One file of each account where the fixture says it was, from before this change, is enough to place it legacy.
      for (const key of ['tg.store.internal', 'wa.store']) {
        const file = realized(results[key]) as string;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, '');
      }
      for (const [key, expected] of Object.entries(results)) expectResolves(name, key, env, expected);
    });
  });

  test('a lone WhatsApp session or Telegram session file places its account legacy', () => {
    const { env } = caseEnv('default');
    const results = GOLDEN.default!;
    const session = (realized(results['tg.session_paths']) as string[])[0]!;
    mkdirSync(dirname(session), { recursive: true });
    writeFileSync(session, '');
    for (const key of Object.keys(results).filter((k) => k.startsWith('tg.'))) expectResolves('default', key, env, results[key]);
    const wa = (realized(results['wa.pair_paths']) as string[])[0]!;
    mkdirSync(dirname(wa), { recursive: true });
    writeFileSync(wa, '');
    for (const [key, expected] of Object.entries(results)) expectResolves('default', key, env, expected);
  });

  test('an override or a plugin-config path pins its account when it has no entry: honored, nothing moves', () => {
    for (const name of cases.filter((n) => n.startsWith('override:') || n.startsWith('override-all:') || [
      'session-with-extension', 'whatsapp-state-is-session-db', 'transcribe-state-only', 'plugin-config-paths',
    ].includes(n))) {
      const { env, platform } = caseEnv(name);
      const results = GOLDEN[name]!;
      withPlatform(platform, () => {
        const set = (names: string[]) => names.some((n) => (env[n] ?? '').trim() !== '');
        // The environment pins the account whose override it sets; the other is a fresh install's folder.
        const prefixes = [set(TELEGRAM_OVERRIDES) ? 'tg.' : undefined, set(WHATSAPP_OVERRIDES) ? 'wa.' : undefined].filter((p): p is string => p !== undefined);
        expect(prefixes.length, name).toBeGreaterThan(0);
        for (const [key, expected] of Object.entries(results)) {
          if (prefixes.some((prefix) => key.startsWith(prefix) || key.startsWith(`script.${prefix}`))) expectResolves(name, key, env, expected);
        }
      });
    }
  });

  test('a blank override pins nothing: a fresh install is a folder', () => {
    for (const name of ['override-blank:telegram', 'override-blank:whatsapp']) {
      const { env } = caseEnv(name);
      expect(String(resolvers['tg.store.internal']!(env))).toContain('/sources/telegram.messages/1/stores/');
      expect(String(resolvers['wa.state']!(env))).toContain('/sources/whatsapp.personal.messages/1/raw/whatsapp');
    }
  });
});
