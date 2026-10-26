// A Telegram Desktop export from the approved file to its removal, on the
// shared tier spine: held Private until judged, findings counted once across
// a restart, a changed file stopping the import, and the live Telegram
// capture (a different source in different stores) never opened or touched.
// Synthetic exports only.

import { resolvedStorePath } from '../src/core/source-placement.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { archiveCorpusId, type ArchiveConnectorFactory } from '../src/core/archive-formats.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createTelegramArchiveConnector } from '../src/workers/archive-import/telegram/connector.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import { archiveConnectorStoreDbPath, archiveConnectorStoreDbPaths } from '../src/workers/archive-import/store.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../src/workers/archive-import/sync.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  isTelegramMessagesCorpusId,
} from '../src/workers/telegram-messages/corpus-adapter.ts';
import {
  telegramChat,
  telegramFixtureIso,
  telegramFullExport,
  telegramJson,
  telegramPhoto,
  telegramService,
  telegramText,
  telegramTexts,
  telegramVoice,
  writeTelegramExport,
  writeTelegramHtmlExport,
} from './support/archive-fixtures-telegram.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/**
 * Whole account: 9 messages to keep (2 of them service messages), 1 empty one to leave out, 3 media files named
 * (a photo, a voice message, the profile picture), and the account's own 7 items (the profile, the picture, 2 contacts,
 * a frequent contact, a session, other data).
 */
function accountExport(label = 'The synthetic harbour log'): string {
  return telegramJson(telegramFullExport({
    contacts: 2,
    chats: [
      telegramChat({ name: 'Alex Example', type: 'personal_chat', id: 11, messages: [
        telegramText(0, `${label}, entry 0.`),
        telegramService(1),
        telegramPhoto(2, `${label}, entry 2.`),
        telegramText(3, ''),
        telegramText(4, `${label}, entry 4.`),
      ] }),
      telegramChat({ name: 'Harbour Group', type: 'private_group', id: 12, messages: [
        telegramText(5, `${label}, entry 5.`),
        telegramVoice(6),
        telegramText(7, `${label}, entry 7.`),
      ] }),
    ],
    leftChats: [
      telegramChat({ name: 'Old Channel', type: 'public_channel', id: 13, messages: [telegramText(8, `${label}, entry 8.`), telegramService(9)] }),
    ],
  }));
}
const ACCOUNT_ITEMS = 9 + 7;
const ACCOUNT_SKIPPED = { message_without_text: 1 };
const ACCOUNT_GAPS = { media_not_imported: 3 };

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-telegram-lifecycle-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const env = { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const exports = join(base, 'exports');
  mkdirSync(exports);
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  /** Writes `exports/<name>/result.json` and starts the import of that file, or of the folder. */
  const start = (name: string, text: string, how: 'file' | 'folder' = 'file'): string => {
    const dir = join(exports, name);
    const file = writeTelegramExport(dir, text);
    const started = runtime.start(how === 'file' ? file : dir);
    if (started.kind !== 'started') throw new Error(`expected a start, got ${started.kind}`);
    return started.archive.archive_id;
  };
  return { base, env, exports, runtime, start };
}

function pull(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  return pullArchiveImport({ state: runtime.state, lane: runtime.lane('chat'), archiveId, ...options });
}

async function importAll(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  for (let pass = 0; pass < 50; pass += 1) {
    const outcome = await pull(runtime, archiveId, options);
    if (!outcome.continueSoon) return outcome;
  }
  throw new Error('the import did not finish');
}

/** Distinct items each archive holds across the chat family's stores. */
function itemsByArchive(env: Record<string, string>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const path of archiveConnectorStoreDbPaths(['chat'], env)) {
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const rows = db.query('SELECT account_scope AS scope, provider_item_id AS id FROM items').all() as Array<{ scope: string; id: string }>;
      for (const row of rows) {
        if (!found.has(row.scope)) found.set(row.scope, new Set());
        found.get(row.scope)!.add(row.id);
      }
    } finally {
      db.close();
    }
  }
  return found;
}

function everyStoredText(env: Record<string, string>): string {
  let all = '';
  for (const path of archiveConnectorStoreDbPaths(['chat'], env)) {
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      for (const row of db.query('SELECT bounded_text AS t FROM chunks').all() as Array<{ t: string }>) all += `${row.t}\n`;
      for (const row of db.query('SELECT provider, account_scope, title, search_text FROM items').all() as Array<Record<string, unknown>>) all += `${JSON.stringify(row)}\n`;
    } catch {
      // A store without those tables holds no text.
    } finally {
      db.close();
    }
  }
  return all;
}

/** The real Telegram connector, with `action` run once the first page is out and before the next is read. */
function afterFirstPage(action: () => void): (formatId: string) => ArchiveConnectorFactory {
  return () => (input) => {
    const real = createTelegramArchiveConnector(input);
    const connector: SourceConnector = {
      ...real,
      listItems(options) {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          let pages = 0;
          for await (const page of real.listItems(options)) {
            yield page;
            pages += 1;
            if (pages === 1) action();
          }
        })();
      },
    };
    return connector;
  };
}

function dyingAfterFirstPage(): (formatId: string) => ArchiveConnectorFactory {
  return () => (input) => {
    const real = createTelegramArchiveConnector(input);
    const connector: SourceConnector = {
      ...real,
      listItems(options) {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          let pages = 0;
          for await (const page of real.listItems(options)) {
            if (pages > 0) throw new Error('synthetic crash');
            pages += 1;
            yield page;
          }
        })();
      },
    };
    return connector;
  };
}

/**
 * The live Telegram capture's stores, seeded where the capture keeps them. The
 * internal one is not a database at all, so any attempt to open it as one
 * fails; the protected one is a real database with a row in it.
 */
function seedLiveTelegram(env: Record<string, string>) {
  const internal = resolvedStorePath('telegram.messages', 'internal', env);
  const protectedPath = resolvedStorePath('telegram.messages', 'secure_local', env);
  mkdirSync(dirname(internal), { recursive: true });
  writeFileSync(internal, 'Not a database: opening this file as one fails.');
  const db = new Database(protectedPath);
  db.run('CREATE TABLE live_rows (id TEXT PRIMARY KEY, body TEXT)');
  db.run("INSERT INTO live_rows VALUES ('live-1', 'a live capture row')");
  db.close();
  const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
  const snapshot = () => ({
    internal: { sha: sha(internal), mtimeMs: statSync(internal).mtimeMs },
    protected: { sha: sha(protectedPath), mtimeMs: statSync(protectedPath).mtimeMs },
    files: readdirSync(dirname(internal)).sort(),
  });
  const liveRows = (): number => {
    const reader = new Database(protectedPath, { readonly: true });
    try {
      return (reader.query('SELECT COUNT(*) AS n FROM live_rows').get() as { n: number }).n;
    } finally {
      reader.close();
    }
  };
  return { internal, protectedPath, snapshot, liveRows };
}

describe('a Telegram export imported end to end', () => {
  test('bounded passes import every message once, count what was left out, and leave the live capture alone', async () => {
    const f = fixture();
    const live = seedLiveTelegram(f.env);
    const before = live.snapshot();
    const archiveId = f.start('Telegram Desktop', accountExport());

    const first = await pull(f.runtime, archiveId, { pageSize: 2, maxItems: 3 });
    expect(first.continueSoon).toBe(true);
    const last = await importAll(f.runtime, archiveId, { pageSize: 2, maxItems: 3 });
    expect(last.receipt.counts.traversal_complete).toBe(1);

    const record = f.runtime.state.get(archiveId)!;
    expect(record).toMatchObject({ status: 'imported', format: 'telegram_json', provider: 'telegram_export', family: 'chat' });
    expect(record.files.map((file) => file.rel_path)).toEqual(['result.json']);
    expect(record.findings.skipped).toEqual(ACCOUNT_SKIPPED);
    expect(record.findings.gaps).toEqual(ACCOUNT_GAPS);
    // The range of the messages: the last is a service message (a join) and it counts; no contact or profile date is in it.
    expect(record.date_range).toEqual({ earliest: telegramFixtureIso(0), latest: telegramFixtureIso(9) });
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(ACCOUNT_ITEMS);

    const lane = f.runtime.lane('chat');
    expect(lane.ledger.accountScopeCounts('telegram_export', archiveId).items).toBe(ACCOUNT_ITEMS);
    expect(lane.set.committedCursor(archiveConnectorId(archiveId))?.cursor).toEndWith(':done');

    // A finished import has nothing more to do.
    expect((await pull(f.runtime, archiveId)).continueSoon).toBe(false);
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(ACCOUNT_ITEMS);

    // The live capture: not opened, not written, not given a sidecar file.
    expect(live.snapshot()).toEqual(before);
  });

  test('the content is held Private until judged: the account\'s contacts, sessions and phone numbers too, in the secure store and nowhere else', async () => {
    const f = fixture();
    const archiveId = f.start('Telegram Desktop', accountExport());
    await importAll(f.runtime, archiveId);
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(ACCOUNT_ITEMS);

    const secure = new Database(archiveConnectorStoreDbPath('secure_local', 'chat', f.env), { readonly: true });
    try {
      const held = secure.query(`
        SELECT COUNT(DISTINCT i.item_pk) AS n FROM chunks c JOIN items i ON i.item_pk = c.item_pk
        WHERE i.account_scope = ? AND c.bounded_text LIKE '%harbour log%'
      `).get(archiveId) as { n: number };
      // Every message with words of the log in it (the voice message has none).
      expect(held.n).toBe(6);
    } finally {
      secure.close();
    }
    const accountWords = ['555', 'Contact0', 'Synthetic Phone', 'synthetic_sam', 'Synthetic other data'];
    for (const domain of ['internal', 'public_safe'] as const) {
      const path = archiveConnectorStoreDbPath(domain, 'chat', f.env);
      if (!existsSync(path)) continue;
      const db = new Database(path, { readonly: true });
      try {
        const chunks = db.query('SELECT c.bounded_text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?').all(archiveId) as Array<{ text: string }>;
        expect(chunks.filter((chunk) => chunk.text.includes('harbour log') || accountWords.some((word) => chunk.text.includes(word)))).toEqual([]);
        expect((db.query('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    }

    // The account's own items are held with the messages: in the secure store, where the private model judges each one.
    const secureAgain = new Database(archiveConnectorStoreDbPath('secure_local', 'chat', f.env), { readonly: true });
    try {
      for (const word of accountWords) {
        const found = secureAgain.query(`
          SELECT COUNT(DISTINCT i.item_pk) AS n FROM chunks c JOIN items i ON i.item_pk = c.item_pk
          WHERE i.account_scope = ? AND c.bounded_text LIKE ?
        `).get(archiveId, `%${word}%`) as { n: number };
        expect({ word, held: found.n > 0 }).toEqual({ word, held: true });
      }
    } finally {
      secureAgain.close();
    }
  });

  test('a restart in the middle imports every message once and counts each finding once', async () => {
    const f = fixture();
    const archiveId = f.start('Telegram Desktop', accountExport());
    await expect(pull(f.runtime, archiveId, { pageSize: 2, connectorFactory: dyingAfterFirstPage() })).rejects.toThrow('synthetic crash');
    expect(f.runtime.state.get(archiveId)?.status).toBe('importing');

    await importAll(f.runtime, archiveId, { pageSize: 2, maxItems: 2 });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.skipped).toEqual(ACCOUNT_SKIPPED);
    expect(record.findings.gaps).toEqual(ACCOUNT_GAPS);
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(ACCOUNT_ITEMS);
  });

  test('a time without a zone is counted as the time zone assumed, once for the whole archive, across passes', async () => {
    const f = fixture();
    const old = telegramJson(telegramFullExport({
      withoutPersonalSections: true,
      chats: [telegramChat({ messages: [0, 1, 2, 3, 4].map((index) => telegramText(index, `Old note ${index}.`, { dateOnly: true })) })],
    }));
    const archiveId = f.start('Old Telegram', old);
    await importAll(f.runtime, archiveId, { pageSize: 1, maxItems: 1 });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.gaps).toEqual({ time_zone_assumed: 1 });
    expect(record.date_range?.earliest).toBe(new Date(2015, 0, 5, 10, 0, 0).toISOString());
  });

  test('a file that changed after the first page stops the import and says which file', async () => {
    const f = fixture();
    const archiveId = f.start('Telegram Desktop', accountExport());
    const path = join(f.exports, 'Telegram Desktop', 'result.json');
    const outcome = await pull(f.runtime, archiveId, { pageSize: 2, connectorFactory: afterFirstPage(() => appendFileSync(path, ' ')) });
    expect(outcome.receipt.counts.import_stopped).toBe(1);
    expect(f.runtime.state.get(archiveId)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: 'result.json' } });
  });

  test('a file cut short is imported as far as it goes and the damage is counted', async () => {
    const f = fixture();
    const whole = accountExport();
    const cutAt = whole.indexOf('"id": 1007,') + 10;
    const archiveId = f.start('Cut Telegram', whole.slice(0, cutAt));
    await importAll(f.runtime, archiveId);
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.gaps.file_damaged).toBe(1);
    // The account's 7 items, then messages 0 to 6 came before the cut: six of them are items (a service message is one), one has no text.
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(7 + 6);
  });
});

describe('choosing a Telegram export', () => {
  test('the folder that holds result.json is read through that one file, whatever else is beside it', async () => {
    const f = fixture();
    const dir = join(f.exports, 'Telegram Desktop');
    writeTelegramExport(dir, accountExport());
    writeTelegramHtmlExport(dir);
    mkdirSync(join(dir, 'photos'));
    writeFileSync(join(dir, 'photos', 'photo_2.jpg'), 'not a photo');
    const started = f.runtime.start(dir);
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    expect(started.archive).toMatchObject({ format: 'telegram_json', family: 'chat', chosen_rel_path: '', label: 'Telegram Desktop' });
    expect(started.archive.files.map((file) => file.rel_path)).toEqual(['result.json']);
    await importAll(f.runtime, started.archive.archive_id);
    expect(itemsByArchive(f.env).get(started.archive.archive_id)?.size).toBe(ACCOUNT_ITEMS);
  });

  test('the HTML form is refused with what to do instead, and nothing is recorded', () => {
    const f = fixture();
    const dir = join(f.exports, 'Telegram HTML');
    writeTelegramHtmlExport(dir);
    const refused = f.runtime.start(dir);
    expect(refused.kind).toBe('unsupported');
    if (refused.kind === 'unsupported') {
      expect(refused.supported).toContain('Telegram Desktop export (JSON)');
      expect(refused.advice).toContain('Machine-readable JSON');
    }
    const page = f.runtime.start(join(dir, 'messages.html'));
    expect(page.kind).toBe('unsupported');
    expect(existsSync(f.runtime.state.path)).toBe(false);
  });

  test('a single chat export is a chat archive too', async () => {
    const f = fixture();
    const archiveId = f.start('One chat', telegramJson({ name: 'Solo', type: 'personal_chat', id: 1, messages: telegramTexts(4) }));
    await importAll(f.runtime, archiveId);
    expect(f.runtime.state.get(archiveId)).toMatchObject({ status: 'imported', family: 'chat', findings: { gaps: {}, skipped: {} } });
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(4);
  });
});

describe('removing a Telegram archive', () => {
  test('takes what came from it, nothing of the other archive, and leaves the live capture rows and files', async () => {
    const f = fixture();
    const live = seedLiveTelegram(f.env);
    const before = live.snapshot();
    const removed = f.start('Removed Telegram', accountExport('Removed harbour log'));
    const kept = f.start('Kept Telegram', accountExport('Kept harbour log'));
    await importAll(f.runtime, removed);
    await importAll(f.runtime, kept);
    const lane = f.runtime.lane('chat');
    expect(lane.ledger.accountScopeCounts('telegram_export', removed).items).toBe(ACCOUNT_ITEMS);
    expect(lane.ledger.accountScopeCounts('telegram_export', kept).items).toBe(ACCOUNT_ITEMS);

    requestArchiveRemoval(f.runtime.state, removed);
    let outcome = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: removed, stepItems: 2, stepsPerRun: 2 });
    for (let run = 0; run < 30 && outcome.kind === 'progress'; run += 1) {
      outcome = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: removed, stepItems: 2, stepsPerRun: 2 });
    }
    expect(outcome.kind).toBe('removed');

    const items = itemsByArchive(f.env);
    expect(items.has(removed)).toBe(false);
    expect(items.get(kept)?.size).toBe(ACCOUNT_ITEMS);
    expect(lane.ledger.accountScopeCounts('telegram_export', removed).items).toBe(0);
    expect(lane.ledger.accountScopeCounts('telegram_export', kept).items).toBe(ACCOUNT_ITEMS);
    expect(f.runtime.state.list().map((record) => record.archive_id)).toEqual([kept]);
    expect(everyStoredText(f.env)).not.toContain('Removed harbour log');
    expect(everyStoredText(f.env)).toContain('Kept harbour log');

    // The chosen file stays; the live capture is exactly as it was.
    expect(existsSync(join(f.exports, 'Removed Telegram', 'result.json'))).toBe(true);
    expect(live.snapshot()).toEqual(before);
    expect(live.liveRows()).toBe(1);
  });

  test('deleting the live Telegram data keeps the imported archives, and deleting the archives keeps the live capture', async () => {
    const f = fixture();
    const live = seedLiveTelegram(f.env);
    const archiveId = f.start('Telegram Desktop', accountExport());
    await importAll(f.runtime, archiveId);
    for (const lane of f.runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
    const archiveStores = archiveConnectorStoreDbPaths(['chat'], f.env).filter((path) => existsSync(path));
    expect(archiveStores.length).toBeGreaterThan(0);

    deleteOlympusData({ sourceId: 'telegram.messages', homeDir: f.base, env: f.env });
    expect(existsSync(live.internal)).toBe(false);
    expect(existsSync(live.protectedPath)).toBe(false);
    for (const path of archiveStores) expect(existsSync(path)).toBe(true);
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(ACCOUNT_ITEMS);
    expect(f.runtime.state.get(archiveId)?.status).toBe('imported');

    const second = seedLiveTelegram(f.env);
    const before = second.snapshot();
    deleteOlympusData({ sourceId: 'archive.imports', homeDir: f.base, env: f.env });
    for (const path of archiveStores) expect(existsSync(path)).toBe(false);
    expect(second.snapshot()).toEqual(before);
    expect(second.liveRows()).toBe(1);
  });
});

describe('citing a Telegram archive', () => {
  test('an imported message is cited as Telegram, from its format, with the title and date it has', () => {
    const cited = searchToolResult({
      evidence: [{ trust_domain: 'internal', provider: 'telegram_export', family: 'chat', title: 'Harbour Group', excerpt: 'harbour log', authored_at: telegramFixtureIso(2) }],
      coverage: {},
    });
    const evidence = (cited.structuredContent as { evidence: Array<{ source: string; title?: string; date?: string }> }).evidence[0]!;
    expect(evidence).toMatchObject({ source: 'Telegram', title: 'Harbour Group', date: '2015-01-05' });
  });
});

describe('the archive and the live capture are different sources', () => {
  test('different corpora, different store files, and no code of the archive import reaches the capture', () => {
    for (const domain of ['secure_local', 'internal', 'public_safe'] as const) {
      expect(isTelegramMessagesCorpusId(archiveCorpusId(domain, 'chat'))).toBe(false);
    }
    expect([INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID]).not.toContain(archiveCorpusId('secure_local', 'chat'));
    const env = { HOME: '/home/example', XDG_DATA_HOME: '/home/example/xdg' };
    const live = [resolvedStorePath('telegram.messages', 'internal', env), resolvedStorePath('telegram.messages', 'secure_local', env)];
    for (const path of archiveConnectorStoreDbPaths(['chat'], env)) expect(live).not.toContain(path);

    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) found.push(path);
      }
    };
    walk(join(import.meta.dir, '..', 'src', 'workers', 'archive-import'));
    expect(found.some((path) => path.includes('/telegram/'))).toBe(true);
    for (const path of found) {
      const text = readFileSync(path, 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect({ path, specifier, live: /telegram-messages|corpus-adapter|capture|gateway/i.test(specifier) }).toEqual({ path, specifier, live: false });
      }
      for (const name of ['legacyTelegramStoreRoot', 'telegram-internal-connector-store', 'telegram-protected-connector-store', 'defaultInternalTelegramConnectorStoreDbPath', 'defaultProtectedTelegramConnectorStoreDbPath']) {
        expect({ path, name, found: text.includes(name) }).toEqual({ path, name, found: false });
      }
    }
  });
});
