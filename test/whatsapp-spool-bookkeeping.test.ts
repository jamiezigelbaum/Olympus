// WhatsApp spool bookkeeping under churn (review round 3 on #547): Secrets
// cleanup is owed per file identity, a file's identity survives inode reuse,
// and a seeded run of appends, prunes, replacements, cleanup failures and
// cursor resets never leaves a known Secret in the spool after a pull that
// succeeded, nor emits a reaction from a file that is gone. Synthetic data.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';
import { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { WHATSAPP_SPOOL_INDEX_FILE, WhatsAppSpoolIndex } from '../src/workers/whatsapp/spool-index.ts';
import { createWhatsAppLiveSourceConnector, emptyWhatsAppSpoolPassFindings } from '../src/workers/whatsapp/live-connector.ts';
import { WHATSAPP_SPOOL_RESET_FILE } from '../src/workers/whatsapp/spool-resets.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_SPOOL_REDACTION_FAILED_WARNING,
  clearWhatsAppSpoolSecrets,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
} from '../src/workers/whatsapp/store-sync.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const root of roots.splice(0)) {
    for (const file of existsSync(join(root, 'spool')) ? readdirSync(join(root, 'spool')) : []) {
      try { chmodSync(join(root, 'spool', file), 0o600); } catch { /* gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// Key-shaped fixture assembled at run time, so no literal key sits in the repository.
const keyFor = (n: number): string => ['sk', '_live_', `k9Xp2LmQ7vRt4WzY8bNc${String(n).padStart(4, '0')}`].join('');

function line(id: string, fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    id,
    chat_jid: 'chat-1@s.whatsapp.net',
    chat_name: 'Harbour club',
    sender_jid: 'sender-1@s.whatsapp.net',
    sender_name: 'Rowan',
    from_me: false,
    timestamp: '2026-10-25T09:00:00Z',
    text: `message ${id}`,
    ...fields,
  })}\n`;
}

function reaction(id: string, target: string, key: string, actor: string): string {
  return line(id, {
    sender_jid: actor,
    sender_name: 'Kit',
    media_type: 'reaction',
    text: '',
    reaction_target_id: target,
    reaction_target_chat_jid: 'chat-1@s.whatsapp.net',
    reaction_key: key,
  });
}

function lane() {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-'));
  roots.push(root);
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir, { recursive: true });
  const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: WHATSAPP_LIVE_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const tier = createWhatsAppTierLane({
    store,
    env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
  });
  closers.push(() => {
    tier.newStores.internal?.current()?.close();
    store.close();
  });
  const sync = createWhatsAppConnectorStoreSyncHandler({ store, spoolDir, tierSet: tier.set, now: () => new Date('2026-10-25T12:00:00Z') });
  return { root, spoolDir, sync, ledger: tier.set.ledger };
}

/** Puts new bytes in a file's place as a new file (the inode differs). */
function replaceByRename(path: string, content: string): void {
  writeFileSync(`${path}.new`, content);
  renameSync(`${path}.new`, path);
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

describe('Secrets cleanup is owed per file identity', () => {
  test('a cursor reset onto a shorter replacement with a known Secret, and one failed cleanup, still clears it', async () => {
    const target = lane();
    const file = join(target.spoolDir, '2026-10-25.jsonl');
    const secret = line('s1', { text: `prod key ${keyFor(1)}` });
    writeFileSync(file, line('a') + line('b') + secret);
    await target.sync.pull();
    expect(readFileSync(file, 'utf8')).not.toContain(keyFor(1));
    // The folder is replaced the same day: one line, the same Secret message again; the first cleanup fails.
    replaceByRename(file, secret);
    chmodSync(file, 0o400);
    const failed = await target.sync.pull();
    expect(failed.counts.spool_cursor_recovered).toBe(1);
    expect(failed.warnings).toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    chmodSync(file, 0o600);
    const retried = await target.sync.pull();
    expect(retried.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    expect(readFileSync(file, 'utf8')).not.toContain(keyFor(1));
  });
});

describe('the append-only contract, checked at every boundary', () => {
  for (const longer of [false, true]) {
    test(`a file cut and written again in place (${longer ? 'longer' : 'the same size'}) with a known Secret is cleared again`, async () => {
      const target = lane();
      const file = join(target.spoolDir, '2026-10-25.jsonl');
      const secret = line('s1', { text: `prod key ${keyFor(9)}` });
      const original = line('a') + secret + line('b');
      writeFileSync(file, original);
      await target.sync.pull();
      expect(readFileSync(file, 'utf8')).not.toContain(keyFor(9));
      // The same inode, cut and written again: the Secret is back, and the file is as long, or longer.
      writeFileSync(file, longer ? original + line('c') : original);
      const receipt = await target.sync.pull();
      expect(receipt.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
      expect(readFileSync(file, 'utf8')).not.toContain(keyFor(9));
    });
  }

  test('a file rewritten in place, longer, without a reaction line no longer has that reaction emitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-longer-'));
    roots.push(dir);
    const day = join(dir, '2026-10-24.jsonl');
    const gone = reaction('r1', 'm1', '👍', 'actor-1@s.whatsapp.net');
    writeFileSync(day, line('m1') + gone);
    const first = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    // The same inode, written again longer: a message of exactly the reaction line's length where it was (so the old cursor
    // still falls on a line's start and the first line is the same), then one more line.
    const stand = line('m2', { text: 'z'.repeat(Buffer.byteLength(gone) - Buffer.byteLength(line('m2', { text: '' }))) });
    expect(Buffer.byteLength(stand)).toBe(Buffer.byteLength(gone));
    writeFileSync(day, line('m1') + stand + line('m3'));
    writeFileSync(join(dir, '2026-10-25.jsonl'), reaction('r2', 'm1', '❤️', 'actor-2@s.whatsapp.net'));
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor: first.at(-1)!.nextCursor! }));
    const item = pages.flatMap((page) => [...page.items]).find((entry) => entry.identity.providerItemId === 'm1');
    expect((item?.metadata['reactions'] as Array<{ key: string }>).map((entry) => entry.key)).toEqual(['❤️']);
  });

  test('clearing a Secret keeps its own bookkeeping: the next pull neither rebuilds the index nor clears the file again', async () => {
    const target = lane();
    const file = join(target.spoolDir, '2026-10-25.jsonl');
    writeFileSync(file, line('s1', { text: `prod key ${keyFor(10)}` }) + line('a'));
    const first = await target.sync.pull();
    expect(first.counts.spool_records_redacted).toBe(1);
    // A file the next pull would clear again is one it opens for writing: read-only, that would fail.
    chmodSync(file, 0o400);
    const idle = await target.sync.pull();
    expect(idle.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    expect(idle.counts.spool_records_redacted).toBe(0);
  });
});

describe('review round 5', () => {
  test('a three-line file written again in place as four lines of the same size is cleared through all four', async () => {
    const target = lane();
    const file = join(target.spoolDir, '2026-10-25.jsonl');
    const original = line('a') + line('b') + line('c', { text: 'w'.repeat(600) });
    writeFileSync(file, original);
    await target.sync.pull();
    // Four lines, the last holding a Secret, padded to the three lines' size exactly.
    const secret = line('s4', { text: `prod key ${keyFor(44)}` });
    const head = line('a') + line('b');
    const pad = Buffer.byteLength(original) - Buffer.byteLength(head) - Buffer.byteLength(secret) - Buffer.byteLength(line('p', { text: '' }));
    expect(pad).toBeGreaterThan(0);
    const rewritten = head + line('p', { text: 'q'.repeat(pad) }) + secret;
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
    writeFileSync(file, rewritten);
    const receipt = await target.sync.pull();
    expect(receipt.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    expect(readFileSync(file, 'utf8')).not.toContain(keyFor(44));
  });

  test('cleanup alone, at a cursor that still says three lines, clears a same-size four-line rewrite whole', async () => {
    const target = lane();
    const file = join(target.spoolDir, '2026-10-25.jsonl');
    const original = line('a') + line('b') + line('c', { text: 'w'.repeat(600) });
    writeFileSync(file, original);
    await target.sync.pull();
    const secret = line('s5', { text: `prod key ${keyFor(55)}` });
    const head = line('a') + line('b');
    const pad = Buffer.byteLength(original) - Buffer.byteLength(head) - Buffer.byteLength(secret) - Buffer.byteLength(line('p', { text: '' }));
    writeFileSync(file, head + line('p', { text: 'q'.repeat(pad) }) + secret);
    // The cursor has not moved (nothing told the listing): the cleanup's own boundary check must not trust its line count.
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-25.jsonl:3' });
    expect(readFileSync(file, 'utf8')).not.toContain(keyFor(55));
  });

  test('a crash after the cursor moved but before clearing recorded its boundary still clears a rewrite in the old window', async () => {
    const target = lane();
    const file = join(target.spoolDir, '2026-10-25.jsonl');
    const early = line('e1', { text: 'x'.repeat(120) });
    writeFileSync(file, line('a') + early);
    await target.sync.pull();
    // The cursor moves on; clearing crashes before it records the new boundary (the cleared record keeps the old one).
    appendFileSync(file, line('b', { text: 'y'.repeat(6000) }) + line('c'));
    const writeMeta = target.ledger.writeMeta.bind(target.ledger);
    let crashed = false;
    target.ledger.writeMeta = (key: string, value: string) => {
      if (!crashed && key.endsWith(':cleared_files')) {
        crashed = true;
        throw new Error('crash before the boundary is recorded');
      }
      writeMeta(key, value);
    };
    const failed = await target.sync.pull();
    target.ledger.writeMeta = writeMeta;
    expect(crashed).toBe(true);
    expect(failed.warnings).toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    // An earlier record, inside the old boundary's window, is rewritten in place to hold a Secret.
    const secret = line('e1', { text: `k ${keyFor(66)}`.padEnd(120, ' ') });
    expect(Buffer.byteLength(secret)).toBe(Buffer.byteLength(early));
    const now = readFileSync(file, 'utf8');
    writeFileSync(file, now.replace(early, secret));
    const after = await target.sync.pull();
    expect(after.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    expect(readFileSync(file, 'utf8')).not.toContain(keyFor(66));
  });

  test('an index page commits whole: a failure before its files are recorded leaves no rows behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-atomic-'));
    roots.push(dir);
    writeFileSync(join(dir, '2026-10-24.jsonl'), line('m1') + reaction('r1', 'm1', '👍', 'actor-1@s.whatsapp.net'));
    const original = WhatsAppSpoolIndex.prototype.noteFile;
    WhatsAppSpoolIndex.prototype.noteFile = function failing() { throw new Error('crash before the file is recorded'); };
    try {
      await expect(drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems())).rejects.toThrow('crash before');
    } finally {
      WhatsAppSpoolIndex.prototype.noteFile = original;
    }
    const db = new Database(join(dir, WHATSAPP_SPOOL_INDEX_FILE), { readonly: true });
    try {
      const count = (table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect([count('messages'), count('reactions'), count('files')]).toEqual([0, 0, 0]);
      expect(db.query("SELECT value FROM meta WHERE key = 'high_water'").get()).toBeNull();
    } finally {
      db.close();
    }
    // The next listing reads it all again, and every row has its file recorded.
    await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    const after = new Database(join(dir, WHATSAPP_SPOOL_INDEX_FILE), { readonly: true });
    try {
      const orphans = after.query('SELECT COUNT(*) AS n FROM reactions r WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.name = r.file)').get() as { n: number };
      expect(orphans.n).toBe(0);
      expect((after.query('SELECT COUNT(*) AS n FROM reactions').get() as { n: number }).n).toBe(1);
    } finally {
      after.close();
    }
  });
});

describe('review round 6', () => {
  test('a line appended while cleanup scans a file is owed to the next cleanup, never certified unread', async () => {
    const target = lane();
    const day1 = join(target.spoolDir, '2026-10-24.jsonl');
    const day2 = join(target.spoolDir, '2026-10-25.jsonl');
    const secret = (id: string) => line(id, { text: `prod key ${keyFor(77)}` });
    writeFileSync(day1, line('a') + secret('s1'));
    await target.sync.pull();
    expect(readFileSync(day1, 'utf8')).not.toContain(keyFor(77));
    writeFileSync(day2, line('b'));
    // The bridge appends another copy of the Secret while the day's first cleanup is scanning it.
    const getCurrent = target.ledger.getCurrent.bind(target.ledger);
    let appended = false;
    target.ledger.getCurrent = ((identity: Parameters<typeof getCurrent>[0]) => {
      if (!appended) {
        appended = true;
        appendFileSync(day2, secret('s2'));
      }
      return getCurrent(identity);
    }) as typeof target.ledger.getCurrent;
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-25.jsonl:1' });
    target.ledger.getCurrent = getCurrent;
    expect(appended).toBe(true);
    // Two later cleanups, the cursor past the appended line: it is cleared, not skipped as already certified.
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-25.jsonl:2' });
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-25.jsonl:2' });
    expect(readFileSync(day2, 'utf8')).not.toContain(keyFor(77));
  });

  test('a listing reset survives a pass that fails before its cursor commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-replay-'));
    roots.push(dir);
    const day = join(dir, '2026-10-24.jsonl');
    writeFileSync(day, line('a') + line('b'));
    const first = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    const cursor = first.at(-1)!.nextCursor!;
    // The same length, written again in place: [a, c].
    writeFileSync(day, line('a') + line('c'));
    // The replay fails after the invalidation committed (while recording the file).
    const noteFile = WhatsAppSpoolIndex.prototype.noteFile;
    WhatsAppSpoolIndex.prototype.noteFile = function failing() { throw new Error('crash during the replay'); };
    try {
      await expect(drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor }))).rejects.toThrow('crash during the replay');
    } finally {
      WhatsAppSpoolIndex.prototype.noteFile = noteFile;
    }
    // Retried from the old cursor (the failed pass committed none): c is read.
    const retried = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor }));
    expect(retried.flatMap((page) => page.items.map((item: RawItem) => item.identity.providerItemId))).toContain('c');
    // Once a cursor carrying the new count comes back, the reset is done: nothing is read again.
    const settled = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor: retried.at(-1)!.nextCursor! }));
    expect(settled.flatMap((page) => [...page.items])).toEqual([]);
  });
});

describe('one reset counter (review round 8)', () => {
  const idsOf = (pages: readonly SourceConnectorListPage[]) => pages.flatMap((page) => page.items.map((item: RawItem) => item.identity.providerItemId));
  const list = (dir: string, cursor?: string, extra: { limit?: number; passByteBudget?: number } = {}) =>
    drain(createWhatsAppLiveSourceConnector({ spoolDir: dir, ...(extra.passByteBudget ? { passByteBudget: extra.passByteBudget } : {}) })
      .listItems({ ...(cursor ? { cursor } : {}), ...(extra.limit ? { limit: extra.limit } : {}) }));
  const spool = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `whatsapp-bookkeeping-${name}-`));
    roots.push(dir);
    return dir;
  };
  /** Lists from `cursor` until a listing reads nothing new; fails if that never happens (a replay that never settles). */
  async function settle(dir: string, cursor: string | undefined, limit?: number): Promise<{ ids: string[]; cursor: string | undefined }> {
    const ids: string[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const pages = await list(dir, cursor, limit ? { limit } : {});
      const read = idsOf(pages);
      cursor = pages.at(-1)?.nextCursor ?? cursor;
      if (read.length === 0) return { ids, cursor };
      ids.push(...read);
    }
    throw new Error('the listing never settled');
  }

  test('every cursor carries the reset count, and a cursor that carries none reads the whole spool again', async () => {
    const dir = spool('count');
    writeFileSync(join(dir, '2026-10-24.jsonl'), line('a'));
    writeFileSync(join(dir, '2026-10-25.jsonl'), line('b'));
    const cursor = (await list(dir)).at(-1)!.nextCursor!;
    // The first index build the counter sees counts one.
    expect(cursor).toMatch(/~r1$/u);
    // The same place without a count (an older cursor): it cannot say no reset happened since, so a is read again.
    const findings = emptyWhatsAppSpoolPassFindings();
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir, findings }).listItems({ cursor: cursor.replace(/~r\d+$/u, '') }));
    expect(idsOf(pages)).toEqual(['a', 'b']);
    expect(findings.cursorsRecovered).toBe(1);
  });

  test('a reset reaches every reader: one reader catching up never stops another reading it', async () => {
    const dir = spool('readers');
    const day = join(dir, '2026-10-24.jsonl');
    writeFileSync(day, line('a') + line('b'));
    const ingest = (await list(dir)).at(-1)!.nextCursor!;
    const repair = (await list(dir)).at(-1)!.nextCursor!;
    writeFileSync(day, line('a') + line('c'));
    // Ingestion's replay fails after the reset was counted.
    const noteFile = WhatsAppSpoolIndex.prototype.noteFile;
    WhatsAppSpoolIndex.prototype.noteFile = function failing() { throw new Error('crash during the replay'); };
    try {
      await expect(list(dir, ingest)).rejects.toThrow('crash during the replay');
    } finally {
      WhatsAppSpoolIndex.prototype.noteFile = noteFile;
    }
    // Sender repair reads the replay one item at a time and catches up.
    const repaired = await settle(dir, repair, 1);
    expect(repaired.ids).toContain('c');
    // Ingestion, retried from its committed cursor, still reads it: c is read.
    expect(idsOf(await list(dir, ingest))).toContain('c');
  });

  test('after the index is rebuilt a replay settles: nothing is emitted again forever, and the new line is read', async () => {
    const dir = spool('rebuild');
    const day = join(dir, '2026-10-24.jsonl');
    writeFileSync(day, line('a') + line('b'));
    let cursor = (await list(dir)).at(-1)!.nextCursor!;
    writeFileSync(day, line('a') + line('c'));
    cursor = (await settle(dir, cursor)).cursor!;
    // The disposable index is deleted, and the file is written again before any listing: the new build never held
    // the file, so only the rebuild being counted can say the old cursor is stale.
    rmSync(join(dir, WHATSAPP_SPOOL_INDEX_FILE), { force: true });
    writeFileSync(day, line('a') + line('d'));
    const replay = await settle(dir, cursor);
    expect(replay.ids).toContain('d');
    // Read once: a is emitted by the replay, then never again.
    expect(replay.ids.filter((id) => id === 'a')).toHaveLength(1);
    expect(idsOf(await list(dir, replay.cursor))).toEqual([]);
  });

  test('a cursor in a later file still reads an earlier file written again while the index was gone', async () => {
    const dir = spool('earlier');
    const first = join(dir, '2026-10-24.jsonl');
    writeFileSync(first, line('a') + line('b'));
    writeFileSync(join(dir, '2026-10-25.jsonl'), line('x'));
    const cursor = (await list(dir)).at(-1)!.nextCursor!;
    expect(cursor.startsWith('2026-10-25.jsonl:')).toBe(true);
    rmSync(join(dir, WHATSAPP_SPOOL_INDEX_FILE), { force: true });
    writeFileSync(first, line('a') + line('e'));
    const replay = await settle(dir, cursor);
    expect(replay.ids).toContain('e');
    expect(idsOf(await list(dir, replay.cursor))).toEqual([]);
  });

  test('a counter that cannot be opened fails the listing before the index forgets anything', async () => {
    const dir = spool('closed');
    const day = join(dir, '2026-10-24.jsonl');
    writeFileSync(day, line('a') + line('b'));
    const cursor = (await list(dir)).at(-1)!.nextCursor!;
    writeFileSync(day, line('a') + line('c'));
    // The counter's place is taken by a folder: it cannot be opened.
    for (const suffix of ['', '-wal', '-shm']) rmSync(join(dir, `${WHATSAPP_SPOOL_RESET_FILE}${suffix}`), { force: true });
    mkdirSync(join(dir, WHATSAPP_SPOOL_RESET_FILE));
    await expect(list(dir, cursor)).rejects.toThrow('reset counter');
    // The index still holds the file as it was: with the counter back (empty; it counts the build it first sees, so
    // the old cursor's count matches), the rewrite is still found, counted and read. Had the failed pass forgotten
    // the file, c would be missed.
    rmSync(join(dir, WHATSAPP_SPOOL_RESET_FILE), { recursive: true, force: true });
    const replay = await settle(dir, cursor);
    expect(replay.ids).toContain('c');
  });

  test('a record larger than the whole pass budget is still read, one record a pass at least', async () => {
    const dir = spool('budget');
    const ids = ['p0', 'p1', 'p2', 'p3', 'p4'];
    writeFileSync(join(dir, '2026-10-24.jsonl'), ids.map((id) => line(id, { text: `${id} ${'y'.repeat(600)}` })).join(''));
    const read: string[] = [];
    let cursor: string | undefined;
    for (let pass = 0; pass < ids.length; pass += 1) {
      const pages = await list(dir, cursor, { passByteBudget: 64 });
      const got = idsOf(pages);
      expect(got.length).toBeGreaterThanOrEqual(1);
      read.push(...got);
      cursor = pages.at(-1)?.nextCursor ?? cursor;
      if (read.length >= ids.length) break;
    }
    expect(read).toEqual(ids);
  });
});

describe('review round 9', () => {
  /** What the content judge records for a message found to be Secrets. */
  const judgeSecret = (ledger: ReturnType<typeof lane>['ledger'], id: string) => {
    ledger.recordContentDecision({ provider: 'whatsapp', accountScope: 'personal', providerItemId: id, providerConversationId: 'chat-1@s.whatsapp.net' }, {
      contentTier: 'secrets',
      decidedBy: 'secret_detector',
      reasons: ['content:secret_fixture'],
      contentPending: false,
      engineVersion: 'fixture',
      mapRevision: 'fixture',
      snifferId: 'fixture',
    });
  };
  const idsOf = (pages: readonly SourceConnectorListPage[]) => pages.flatMap((page) => page.items.map((item: RawItem) => item.identity.providerItemId));

  test('a reset never delays clearing a known Secret: the first pull after the rewrite clears it, at one item a pull', async () => {
    const target = lane();
    const day1 = join(target.spoolDir, '2026-10-24.jsonl');
    const day2 = join(target.spoolDir, '2026-10-25.jsonl');
    writeFileSync(day1, line('a') + line('b') + line('c') + line('d'));
    const secret = line('s9', { text: `prod key ${keyFor(9)}` });
    writeFileSync(day2, secret);
    await target.sync.pull();
    expect(readFileSync(day2, 'utf8')).not.toContain(keyFor(9));
    // Day 2 is put back as it was captured, Secret included: the listing restarts at day 1, one item a pull.
    replaceByRename(day2, secret);
    for (let pull = 0; pull < 3; pull += 1) {
      const receipt = await target.sync.pull({ max_items: 1 });
      expect(receipt.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
      expect(readFileSync(day2, 'utf8')).not.toContain(keyFor(9));
    }
  });

  test('clearing ahead of the cursor is bounded by bytes, one whole file a pull at least, and reaches every file', () => {
    const target = lane();
    // Three files ahead of a cursor in the first, each holding a Secret the ledger already knows.
    writeFileSync(join(target.spoolDir, '2026-10-20.jsonl'), line('a'));
    const ahead = ['2026-10-21.jsonl', '2026-10-22.jsonl', '2026-10-23.jsonl'];
    ahead.forEach((name, n) => writeFileSync(join(target.spoolDir, name), line(`k${n}`, { text: `prod key ${keyFor(20 + n)}` })));
    for (const [n] of ahead.entries()) judgeSecret(target.ledger, `k${n}`);
    const left = () => ahead.filter((name) => readFileSync(join(target.spoolDir, name), 'utf8').includes('prod key'));
    // A budget of one byte: one file a pull, in order.
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-20.jsonl:1', aheadBudgetBytes: 1 });
    expect(left()).toEqual(ahead.slice(1));
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-20.jsonl:1', aheadBudgetBytes: 1 });
    clearWhatsAppSpoolSecrets({ spoolDir: target.spoolDir, account: 'personal', ledger: target.ledger, through: '2026-10-20.jsonl:1', aheadBudgetBytes: 1 });
    expect(left()).toEqual([]);
  });

  test('an index that cannot be opened hands out no cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-noindex-'));
    roots.push(dir);
    writeFileSync(join(dir, '2026-10-24.jsonl'), line('a'));
    mkdirSync(join(dir, WHATSAPP_SPOOL_INDEX_FILE));
    await expect(drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems())).rejects.toThrow('index cannot be opened');
  });

  test('a cursor handed out before the counter saw any build reads the spool again once an index is made', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-firstbuild-'));
    roots.push(dir);
    const day = join(dir, '2026-10-24.jsonl');
    // A cursor of count 0 past [a, b], from before any index was made; b was rewritten as e since.
    writeFileSync(day, line('a') + line('e'));
    const cursor = `2026-10-24.jsonl:2@${Buffer.byteLength(line('a') + line('e'))}~r0`;
    expect(idsOf(await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor })))).toContain('e');
  });
});

describe('a file keeps its identity across inode reuse', () => {
  test('a file rewritten in place (the same inode) with other lines of the same length is indexed again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-bookkeeping-inode-'));
    roots.push(dir);
    const day = join(dir, '2026-10-24.jsonl');
    writeFileSync(day, line('m1', { text: 'xxxx' }) + line('m2', { text: 'yyyy' }));
    const first = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    // The same inode, the same length, the lines in another order.
    writeFileSync(day, line('m2', { text: 'yyyy' }) + line('m1', { text: 'xxxx' }));
    writeFileSync(join(dir, '2026-10-25.jsonl'), reaction('r1', 'm1', '👍', 'sender-2@s.whatsapp.net'));
    const findings = emptyWhatsAppSpoolPassFindings();
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir, findings }).listItems({ cursor: first.at(-1)!.nextCursor! }));
    const item = pages.flatMap((page) => [...page.items]).find((entry) => entry.identity.providerItemId === 'm1');
    expect(findings.unresolvedReactionTargets).toBe(0);
    expect(item?.content).toEqual({ kind: 'text', text: 'xxxx' });
  });
});

/** A small deterministic generator (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Each actor's current reaction to each target in the files that are there, in spool order: what may be emitted. */
function truth(spoolDir: string): Map<string, Map<string, string | undefined>> {
  const byTarget = new Map<string, Map<string, string | undefined>>();
  for (const file of readdirSync(spoolDir).filter((name) => name.endsWith('.jsonl')).sort()) {
    for (const raw of readFileSync(join(spoolDir, file), 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
      if (record['media_type'] !== 'reaction' || typeof record['reaction_target_id'] !== 'string') continue;
      const actors = byTarget.get(record['reaction_target_id']) ?? new Map<string, string | undefined>();
      actors.set(String(record['sender_jid']), typeof record['reaction_key'] === 'string' ? record['reaction_key'] : undefined);
      byTarget.set(record['reaction_target_id'], actors);
    }
  }
  return byTarget;
}

describe('spool bookkeeping under churn', () => {
  for (const seed of [1, 7, 42, 1234, 9001, 31337]) {
    test(`seed ${seed}: no known Secret survives a successful pull, and no reaction is emitted from a file that is gone`, async () => {
      const next = random(seed);
      const target = lane();
      const days = ['2026-10-21.jsonl', '2026-10-22.jsonl', '2026-10-23.jsonl', '2026-10-24.jsonl', '2026-10-25.jsonl'];
      const secrets: string[] = [];
      const secretLines: string[] = [];
      let counter = 0;
      let listCursor: string | undefined;
      let failing: string | undefined;
      const pathOf = (day: string) => join(target.spoolDir, day);
      const present = () => days.filter((day) => existsSync(pathOf(day)));
      const messageIds = () => present().flatMap((day) => readFileSync(pathOf(day), 'utf8').split('\n').filter(Boolean)
        .map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((record) => record['media_type'] !== 'reaction').map((record) => String(record['id'])));
      for (let step = 0; step < 40; step += 1) {
        const roll = next();
        const day = days[Math.min(days.length - 1, Math.floor(next() * days.length))]!;
        counter += 1;
        if (roll < 0.35) {
          appendFileSync(pathOf(day), line(`m${counter}`));
        } else if (roll < 0.5) {
          const key = keyFor(counter);
          secrets.push(key);
          const secretLine = line(`s${counter}`, { text: `deploy key ${key}` });
          secretLines.push(secretLine);
          appendFileSync(pathOf(day), secretLine);
        } else if (roll < 0.65) {
          const ids = messageIds();
          if (ids.length > 0) {
            const targetId = ids[Math.floor(next() * ids.length)]!;
            appendFileSync(pathOf(day), reaction(`r${counter}`, targetId, ['👍', '❤️', '😂'][Math.floor(next() * 3)]!, `actor-${Math.floor(next() * 4)}@s.whatsapp.net`));
          }
        } else if (roll < 0.72) {
          // Prune an older file.
          const older = present().slice(0, -1);
          if (older.length > 0) rmSync(pathOf(older[Math.floor(next() * older.length)]!));
        } else if (roll < 0.82) {
          // Replace a file: the same lines reordered (same length), in place or as a new file, or a shorter one.
          const existing = present();
          if (existing.length > 0) {
            const victim = pathOf(existing[Math.floor(next() * existing.length)]!);
            const lines = readFileSync(victim, 'utf8').split('\n').filter(Boolean);
            const kind = next();
            const reordered = `${[...lines].reverse().join('\n')}\n`;
            if (lines.length > 0) {
              if (kind < 0.2) writeFileSync(victim, reordered);
              else if (kind < 0.4) replaceByRename(victim, reordered);
              else if (kind < 0.6) replaceByRename(victim, `${lines.slice(0, Math.max(1, Math.floor(lines.length / 2))).join('\n')}\n`);
              else if (kind < 0.8) {
                // In place and longer, without its reaction lines.
                writeFileSync(victim, `${lines.filter((raw) => !raw.includes('"media_type":"reaction"')).join('\n')}\n${line(`x${counter}`, { text: 'x'.repeat(200) })}`);
              } else if (secretLines.length > 0) {
                // Cut and written again in place, with a known Secret back in it.
                writeFileSync(victim, `${lines.join('\n')}\n${secretLines[Math.floor(next() * secretLines.length)]!}`);
              }
            }
          }
        } else if (roll < 0.9) {
          // The next cleanup fails: a file cannot be opened for writing for one pull.
          const existing = present();
          if (existing.length > 0) {
            failing = pathOf(existing[Math.floor(next() * existing.length)]!);
            chmodSync(failing, 0o400);
          }
        } else {
          // A cursor reset: the listing starts over from the spool's start.
          listCursor = undefined;
        }
        const receipt = await target.sync.pull();
        if (failing) {
          chmodSync(failing, 0o600);
          failing = undefined;
        }
        if (!(receipt.warnings ?? []).includes(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING)) {
          // A pull whose cleanup succeeded leaves no known Secret in any file of the spool.
          for (const day of present()) {
            const text = readFileSync(pathOf(day), 'utf8');
            for (const key of secrets) expect(text.includes(key), `${day} still holds a Secret at step ${step}`).toBe(false);
          }
        }
        // What a listing emits about reactions comes only from the files that are there.
        const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir }).listItems(listCursor ? { cursor: listCursor } : {}));
        listCursor = pages.at(-1)?.nextCursor ?? listCursor;
        const facts = truth(target.spoolDir);
        for (const item of pages.flatMap((page) => [...page.items]) as RawItem[]) {
          const reactions = item.metadata['reactions'] as Array<{ key: string; count: number; actors?: Array<{ providerActorId?: string }> }> | undefined;
          for (const entry of reactions ?? []) {
            const actors = facts.get(item.identity.providerItemId);
            const holding = [...(actors?.entries() ?? [])].filter(([, key]) => key === entry.key);
            expect(entry.count, `${item.identity.providerItemId} ${entry.key} at step ${step}`).toBeLessThanOrEqual(holding.length);
            for (const actor of entry.actors ?? []) {
              expect(actors?.get(actor.providerActorId ?? ''), `actor of ${item.identity.providerItemId} at step ${step}`).toBe(entry.key);
            }
          }
        }
      }
    }, 120_000);
  }
});
