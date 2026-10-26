// Live WhatsApp capture, review round 1 on #547: a recovered cursor never
// re-applies an older version, idle pulls do not rewrite the spool, the byte
// budget bounds every read, reactions aggregate from a persistent index, and a
// disconnected bridge reads as stopped. Every fixture is synthetic.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createWhatsAppLiveSourceConnector, emptyWhatsAppSpoolPassFindings } from '../src/workers/whatsapp/live-connector.ts';
import { WHATSAPP_SPOOL_INDEX_FILE } from '../src/workers/whatsapp/spool-index.ts';
import {
  WHATSAPP_CAPTURE_DISCONNECTED_WARNING,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_SPOOL_REDACTION_FAILED_WARNING,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
} from '../src/workers/whatsapp/store-sync.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const root of roots.splice(0)) {
    try { chmodSync(join(root, 'spool', '2026-10-25.jsonl'), 0o600); } catch { /* not there */ }
    rmSync(root, { recursive: true, force: true });
  }
});

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

function reaction(id: string, target: string, key: string, sender = 'sender-2@s.whatsapp.net'): string {
  return line(id, {
    sender_jid: sender,
    sender_name: 'Kit',
    media_type: 'reaction',
    text: '',
    reaction_target_id: target,
    reaction_target_chat_jid: 'chat-1@s.whatsapp.net',
    reaction_key: key,
  });
}

function lane(now = '2026-10-25T12:00:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-review-'));
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
  const sync = createWhatsAppConnectorStoreSyncHandler({ store, spoolDir, tierSet: tier.set, now: () => new Date(now) });
  return { root, spoolDir, store, sync, file: join(spoolDir, '2026-10-25.jsonl') };
}

function storedText(target: ReturnType<typeof lane>, providerItemId: string): string {
  return (target.store.localContent(`personal:chat-1@s.whatsapp.net:${providerItemId}`)?.chunks ?? []).join(' ');
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

describe('a recovered cursor never re-applies an older version', () => {
  test('a replaced, shorter file read again from its start keeps the newer stored message', async () => {
    const target = lane();
    writeFileSync(target.file, line('a', { timestamp: '2026-10-25T10:00:00Z', text: 'the ten o\'clock wording' }) + line('b') + line('c'));
    await target.sync.pull();
    expect(storedText(target, 'a')).toContain('ten o\'clock');
    // The folder is replaced the same day; its file holds an older copy of "a".
    rmSync(target.file);
    writeFileSync(target.file, line('a', { timestamp: '2026-10-25T08:00:00Z', text: 'the eight o\'clock wording' }));
    const receipt = await target.sync.pull();
    expect(receipt.counts.spool_cursor_recovered).toBe(1);
    expect(storedText(target, 'a')).toContain('ten o\'clock');
    expect(storedText(target, 'a')).not.toContain('eight o\'clock');
  });
});

describe('idle pulls do not rewrite the spool', () => {
  test('a pull that read nothing new never opens the spool for the Secrets window', async () => {
    const target = lane();
    writeFileSync(target.file, line('a') + line('b'));
    const first = await target.sync.pull();
    expect(first.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    // A file that cannot be opened for writing fails any window clearing that touches it.
    chmodSync(target.file, 0o400);
    const idle = await target.sync.pull();
    expect(idle.status).toBe('idle');
    expect(idle.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
  });
});

describe('the byte budget bounds every read', () => {
  test('an over-long record is skipped across passes within the budget, counted once, and never read again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-budget-'));
    roots.push(dir);
    const huge = line('huge', { text: 'x'.repeat(3 * 1024 * 1024) });
    writeFileSync(join(dir, '2026-10-25.jsonl'), line('a') + huge + line('b'));
    let cursor: string | undefined;
    const seen: string[] = [];
    let oversized = 0;
    const cursors: string[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const findings = emptyWhatsAppSpoolPassFindings();
      const connector = createWhatsAppLiveSourceConnector({ spoolDir: dir, findings, passByteBudget: 512 * 1024, maxRecordBytes: 64 * 1024 });
      const pages = await drain(connector.listItems(cursor ? { cursor } : {}));
      seen.push(...pages.flatMap((page) => page.items.map((item: RawItem) => item.identity.providerItemId)));
      oversized += findings.oversizedRecords;
      cursor = pages.at(-1)?.nextCursor;
      if (cursor) cursors.push(cursor);
      if (pages.at(-1)?.done) break;
    }
    expect(seen).toEqual(['a', 'b']);
    expect(oversized).toBe(1);
    // Every pass went on from inside the record, never from its start.
    const offsets = cursors.map((value) => Number(/@(\d+)/u.exec(value)?.[1]));
    for (let index = 1; index < offsets.length; index += 1) expect(offsets[index]!).toBeGreaterThan(offsets[index - 1]!);
    expect(cursors.some((value) => /@\d+s(~r|$)/u.test(value))).toBe(true);
  });

  test('a resume seeks to its byte offset instead of counting lines from the start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-seek-'));
    roots.push(dir);
    const first = line('a');
    writeFileSync(join(dir, '2026-10-25.jsonl'), first + line('b'));
    // A cursor whose line count disagrees with its offset: the offset is where reading goes on.
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor: `2026-10-25.jsonl:7@${Buffer.byteLength(first)}~r0` }));
    expect(pages.flatMap((page) => page.items.map((item: RawItem) => item.identity.providerItemId))).toEqual(['b']);
    expect(pages.at(-1)?.nextCursor).toStartWith(`2026-10-25.jsonl:8@${Buffer.byteLength(first + line('b'))}`);
  });
});

describe('reactions aggregate from a persistent index', () => {
  test('a reaction to a message in an earlier file is attached from the index, after a restart too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-reactions-'));
    roots.push(dir);
    writeFileSync(join(dir, '2026-10-24.jsonl'), line('m1', { text: 'the first message' }) + line('m2'));
    const first = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    const cursor = first.at(-1)!.nextCursor!;
    expect(existsSync(join(dir, WHATSAPP_SPOOL_INDEX_FILE))).toBe(true);
    writeFileSync(join(dir, '2026-10-25.jsonl'), reaction('r1', 'm1', '👍') + reaction('r2', 'm1', '❤️', 'sender-3@s.whatsapp.net'));
    // A new connector (a restart): the reacted-to message is read from its one line.
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor }));
    const items = pages.flatMap((page) => [...page.items]);
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['m1']);
    expect(items[0]!.content).toEqual({ kind: 'text', text: 'the first message' });
    const reactions = items[0]!.metadata['reactions'] as Array<{ key: string; count: number }>;
    expect(reactions.map((entry) => entry.key).sort()).toEqual(['❤️', '👍'].sort());
    // The index holds positions and reactions, never a message's text.
    const db = new Database(join(dir, WHATSAPP_SPOOL_INDEX_FILE), { readonly: true });
    try {
      const dump = JSON.stringify(db.query('SELECT * FROM messages').all());
      expect(dump).not.toContain('the first message');
    } finally {
      db.close();
    }
  });

  test('an index started on an existing spool catches up within the budget before aggregating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-catchup-'));
    roots.push(dir);
    const history = Array.from({ length: 40 }, (_, index) => line(`h${index}`)).join('');
    writeFileSync(join(dir, '2026-10-24.jsonl'), history);
    const listed = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    const cursor = listed.at(-1)!.nextCursor!;
    // The index is lost (an upgrade from before it, or a deleted cache).
    rmSync(join(dir, WHATSAPP_SPOOL_INDEX_FILE), { force: true });
    writeFileSync(join(dir, '2026-10-25.jsonl'), reaction('r1', 'h3', '👍'));
    let resume = cursor;
    let reEmitted: RawItem | undefined;
    let budgetPasses = 0;
    // The index is rebuilt: the cursor of the old build reads its file again (a few lines a pass at this budget).
    for (let pass = 0; pass < 400 && !reEmitted; pass += 1) {
      const findings = emptyWhatsAppSpoolPassFindings();
      const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir, findings, passByteBudget: 2_000 }).listItems({ cursor: resume }));
      budgetPasses += findings.passBudgetReached;
      reEmitted = pages.flatMap((page) => [...page.items]).find((item) => item.identity.providerItemId === 'h3' && item.metadata['reactions'] !== undefined);
      resume = pages.at(-1)?.nextCursor ?? resume;
    }
    expect(budgetPasses).toBeGreaterThan(1);
    expect((reEmitted?.metadata['reactions'] as Array<{ key: string }>).map((entry) => entry.key)).toEqual(['👍']);
  });
});

describe('the packaged bridge', () => {
  test('every source file the bridge is built from ships in the release package', () => {
    const bridge = join(import.meta.dir, '..', 'tools', 'whatsapp-bridge');
    const sources = readdirSync(bridge).filter((name) => name.endsWith('.go') && !name.endsWith('_test.go'));
    expect(sources).toContain('capture_status.go');
    const packaged: readonly string[] = V0_4_PUBLIC_PACKAGE_FILES;
    for (const name of sources) expect(packaged).toContain(`tools/whatsapp-bridge/${name}`);
  });
});

describe('a disconnected bridge reads as stopped', () => {
  test('a disconnect past the grace is stale and stopped, never quiet', async () => {
    const target = lane('2026-10-25T12:00:00Z');
    writeFileSync(target.file, line('a', { timestamp: '2026-10-25T06:00:00Z' }));
    writeFileSync(join(target.spoolDir, 'capture-status.json'), `${JSON.stringify({
      kind: 'whatsapp_capture_status', updated_at: '2026-10-25T11:59:00Z', connected: false, connected_through: '2026-10-25T11:30:00Z', dropped_messages: 0,
    })}\n`);
    const receipt = await target.sync.pull();
    expect(receipt.counts).toMatchObject({ capture_stale: 1, capture_quiet: 0, capture_stopped: 1 });
    expect(receipt.warnings).toContain(WHATSAPP_CAPTURE_DISCONNECTED_WARNING);
  });

  test('a disconnect within the grace (a reconnect in progress) is not yet stopped', async () => {
    const target = lane('2026-10-25T12:00:00Z');
    writeFileSync(target.file, line('a', { timestamp: '2026-10-25T06:00:00Z' }));
    writeFileSync(join(target.spoolDir, 'capture-status.json'), `${JSON.stringify({
      kind: 'whatsapp_capture_status', updated_at: '2026-10-25T11:58:00Z', connected: false, connected_through: '2026-10-25T11:58:00Z', dropped_messages: 0,
    })}\n`);
    const receipt = await target.sync.pull();
    expect(receipt.counts).toMatchObject({ capture_stopped: 0, capture_fresh: 1 });
    expect(receipt.warnings ?? []).not.toContain(WHATSAPP_CAPTURE_DISCONNECTED_WARNING);
  });
});

// Key-shaped fixture assembled at run time, so no literal key sits in the repository.
const STRIPE_LIVE_KEY = ['sk', '_live_', 'k9Xp2LmQ7vRt4WzY8bNc3HdF'].join('');

describe('review round 2', () => {
  test('an idle pull clears a window an earlier pull failed to clear', async () => {
    const target = lane();
    const secret = line('s1', { text: `prod key ${STRIPE_LIVE_KEY}` });
    writeFileSync(target.file, line('a') + secret);
    await target.sync.pull();
    expect(readFileSync(target.file, 'utf8')).not.toContain(STRIPE_LIVE_KEY);
    // The bridge redelivers the Secret message, and the spool cannot be opened for writing for one pull.
    appendFileSync(target.file, secret);
    chmodSync(target.file, 0o400);
    const failed = await target.sync.pull();
    expect(failed.warnings).toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    chmodSync(target.file, 0o600);
    // Nothing new to read: the window the failed pull owes is cleared all the same.
    const idle = await target.sync.pull();
    expect(idle.warnings ?? []).not.toContain(WHATSAPP_SPOOL_REDACTION_FAILED_WARNING);
    expect(readFileSync(target.file, 'utf8')).not.toContain(STRIPE_LIVE_KEY);
  });

  test('reading reacted-to messages is spent from the pass budget, and the pass goes on next time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-targets-'));
    roots.push(dir);
    const targets = Array.from({ length: 40 }, (_, index) => line(`t${index}`, { text: `${'y'.repeat(100 * 1024)} ${index}` })).join('');
    writeFileSync(join(dir, '2026-10-24.jsonl'), targets);
    let cursor: string | undefined;
    for (let pass = 0; pass < 100; pass += 1) {
      const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems(cursor ? { cursor } : {}));
      cursor = pages.at(-1)?.nextCursor ?? cursor;
      if (pages.at(-1)?.done) break;
    }
    writeFileSync(join(dir, '2026-10-25.jsonl'), Array.from({ length: 40 }, (_, index) => reaction(`r${index}`, `t${index}`, '👍')).join(''));
    const reEmitted = new Set<string>();
    let passes = 0;
    let firstDone: boolean | undefined;
    for (; passes < 100; passes += 1) {
      const findings = emptyWhatsAppSpoolPassFindings();
      const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir, findings, passByteBudget: 256 * 1024 }).listItems(cursor ? { cursor } : {}));
      firstDone ??= pages.at(-1)?.done;
      for (const item of pages.flatMap((page) => [...page.items])) {
        if (item.metadata['reactions'] !== undefined) reEmitted.add(item.identity.providerItemId);
      }
      expect(findings.unresolvedReactionTargets).toBe(0);
      cursor = pages.at(-1)?.nextCursor ?? cursor;
      if (pages.at(-1)?.done) break;
    }
    // Forty 100 KB lines do not fit one 256 KB pass: the first stops, and the rest follow, each target once.
    expect(firstDone).toBe(false);
    expect(passes).toBeGreaterThan(5);
    expect(reEmitted.size).toBe(40);
  });

  test('a reaction from a file that is gone is no longer counted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-gone-'));
    roots.push(dir);
    writeFileSync(join(dir, '2026-10-23.jsonl'), line('m1'));
    writeFileSync(join(dir, '2026-10-24.jsonl'), reaction('r1', 'm1', '👍'));
    const first = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    rmSync(join(dir, '2026-10-24.jsonl'));
    writeFileSync(join(dir, '2026-10-25.jsonl'), reaction('r2', 'm1', '❤️', 'sender-3@s.whatsapp.net'));
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems({ cursor: first.at(-1)!.nextCursor! }));
    const item = pages.flatMap((page) => [...page.items]).find((entry) => entry.identity.providerItemId === 'm1');
    expect((item?.metadata['reactions'] as Array<{ key: string }>).map((entry) => entry.key)).toEqual(['❤️']);
  });

  test('a file replaced by another of the same length is indexed again, not trusted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whatsapp-review-replaced-'));
    roots.push(dir);
    const day = join(dir, '2026-10-24.jsonl');
    writeFileSync(day, line('m1', { text: 'xxxx' }) + line('m2', { text: 'yyyy' }));
    const first = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir }).listItems());
    // The same bytes in another order, in a new file put in its place: the length and the line ends agree.
    writeFileSync(`${day}.new`, line('m2', { text: 'yyyy' }) + line('m1', { text: 'xxxx' }));
    renameSync(`${day}.new`, day);
    writeFileSync(join(dir, '2026-10-25.jsonl'), reaction('r1', 'm1', '👍'));
    const findings = emptyWhatsAppSpoolPassFindings();
    const pages = await drain(createWhatsAppLiveSourceConnector({ spoolDir: dir, findings }).listItems({ cursor: first.at(-1)!.nextCursor! }));
    const item = pages.flatMap((page) => [...page.items]).find((entry) => entry.identity.providerItemId === 'm1');
    expect(findings.unresolvedReactionTargets).toBe(0);
    expect(item?.content).toEqual({ kind: 'text', text: 'xxxx' });
    expect((item?.metadata['reactions'] as Array<{ key: string }>).map((entry) => entry.key)).toEqual(['👍']);
  });
});
