// Historical capture claims never decide privacy. Content and explicit owner rules do.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createLaneTieredStoreSet, type TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramConnectorStoreSyncHandler,
} from '../src/workers/telegram-messages/index.ts';
import { compareTelegramVersions, telegramCaptureVersion } from '../src/workers/telegram-messages/record-builder.ts';
import { forgetSpoolOffsets } from '../src/workers/telegram-messages/spool-lines.ts';

const ACCOUNT = 'telegram.personal';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface Capture {
  id: string;
  text: string;
  /** Edit time. */
  at: string;
  trust: 'internal' | 'secure_local';
  capturedAt: string;
  seq: number;
  reactions?: Array<{ key: string; count: number }>;
}

function line(capture: Capture): string {
  const digest = capture.reactions ? `:r${sha256(JSON.stringify(capture.reactions)).slice(0, 8)}` : '';
  const sourceVersion = `${ACCOUNT}:chat-1:${capture.id}:${capture.at}${digest}`;
  return JSON.stringify({
    schema_version: 1,
    capture_id: sha256([ACCOUNT, 'chat-1', capture.id, sourceVersion].join('\x1f')),
    captured_at: capture.capturedAt,
    capture_seq: capture.seq,
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: `${ACCOUNT}:chat:chat-1`,
    conversation_id: 'chat-1',
    corpus_id: capture.trust === 'secure_local' ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID : INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: capture.trust,
    classification: { trust_domain: capture.trust, reason: 'fixture' },
    sync_direction: 'forward',
    message: {
      id: capture.id,
      conversationId: 'chat-1',
      chatTitle: 'Chat one',
      chatType: 'group',
      senderId: 'sender-1',
      boundedText: capture.text,
      sentAt: '2026-10-01T09:00:00Z',
      editedAt: capture.at,
      sourceVersion,
      ...(capture.reactions ? { reactions: capture.reactions, attachments: [{ attachmentId: 'photo:1', type: 'image' }] } : {}),
    },
  }) + '\n';
}

const roots: string[] = [];
afterEach(() => {
  forgetSpoolOffsets();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-claims-'));
  roots.push(root);
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  const internal = new LocalConnectorStore({ dbPath: join(root, 'internal.sqlite'), corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'internal' });
  const secureLocal = new LocalConnectorStore({ dbPath: join(root, 'secure.sqlite'), corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const set = createLaneTieredStoreSet({ setId: 'telegram.messages', internalStore: internal, secureStore: secureLocal, splitLayers: false });
  let seq = 0;
  let clock = Date.parse('2026-10-20T00:00:00Z');
  const capture = (file: string, entry: Omit<Capture, 'capturedAt' | 'seq'>): Capture => {
    seq += 1;
    clock += 60_000;
    const full: Capture = { ...entry, seq, capturedAt: new Date(clock).toISOString() };
    appendFileSync(join(spoolDir, file), line(full));
    return full;
  };
  const identity = (id: string) => ({ provider: 'telegram', accountScope: ACCOUNT, providerItemId: id, providerConversationId: 'chat-1' });
  const textIn = (store: LocalConnectorStore, id: string): string => store.localContent(`${ACCOUNT}:chat-1:${id}`)?.chunks.join(' ') ?? '';
  /** What a read of the ordinary lane serves of the item: an active row whose ledger copy there is current (or a legacy row). */
  const readableInInternal = (id: string): boolean => {
    if (!internal.itemPresence(identity(id)).active) return false;
    if (internal.searchItems(`marker${id}`, 5).length === 0 && textIn(internal, id) === '') return false;
    const copies = set.ledger.copies(identity(id));
    return copies.length === 0 || copies.some((copy) => copy.corpusId === INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID && copy.state === 'current');
  };
  return {
    spoolDir, internal, secureLocal, set, capture, identity, textIn, readableInInternal,
    handler: (extra: Partial<Parameters<typeof createTelegramConnectorStoreSyncHandler>[0]> = {}) =>
      createTelegramConnectorStoreSyncHandler({ stores: { internal, secureLocal }, spoolDir, tierSet: set as TieredStoreSet, ...extra }),
    close() { internal.close(); secureLocal.close(); },
  };
}

describe('retired capture claims', () => {
  test('an old secure claim and a secure record cannot move Personal content', async () => {
    const w = world();
    try {
      w.capture('2026-10-22.jsonl', { id: 'A', text: 'markerA ordinary text', at: '2026-10-22T09:00:00Z', trust: 'internal' });
      const sync = w.handler();
      await sync.pull();
      // Metadata persisted by old builds must have no authority after upgrade.
      w.set.ledger.writeMeta(`telegram:secure_claim:${ACCOUNT}:chat-1:A`, '1');
      // The old claim's record is older than the ordinary copy; pruning the
      // newer record must not make its trust domain authoritative either.
      unlinkSync(join(w.spoolDir, '2026-10-22.jsonl'));
      w.capture('2026-10-23.jsonl', { id: 'A', text: 'markerA old text', at: '2026-10-21T09:00:00Z', trust: 'secure_local' });
      // Boundary receipts still need writes; only forbid the retired claim.
      const writeMeta = w.set.ledger.writeMeta.bind(w.set.ledger);
      w.set.ledger.writeMeta = (key, value) => {
        if (key.startsWith('telegram:secure_claim:')) throw new Error('retired claim write');
        writeMeta(key, value);
      };
      const receipt = await sync.pull();
      expect(receipt.counts.trust_claims_moved).toBe(0);
      expect(w.textIn(w.internal, 'A')).toContain('ordinary text');
      expect(w.textIn(w.secureLocal, 'A')).toBe('');
      w.capture('2026-10-24.jsonl', { id: 'A', text: 'markerA a later ordinary edit', at: '2026-10-24T09:00:00Z', trust: 'secure_local' });
      await sync.pull();
      expect(w.readableInInternal('A')).toBe(true);
      expect(w.textIn(w.internal, 'A')).toContain('later ordinary edit');
    } finally { w.close(); }
  });
});

describe('nothing is deleted before its replacement is stored', () => {
  test('a failed pass keeps the stored Personal copy until the newer record can be judged', async () => {
    const w = world();
    try {
      w.capture('2026-10-22.jsonl', { id: 'A', text: 'markerA the stored ordinary text', at: '2026-10-22T09:00:00Z', trust: 'internal' });
      const sync = w.handler();
      await sync.pull();
      // A historical secure domain is just another input record.
      w.capture('2026-10-23.jsonl', { id: 'A', text: 'markerA the newer protected text', at: '2026-10-23T09:00:00Z', trust: 'secure_local' });
      const syncLegs = w.set.syncLegs.bind(w.set);
      let fail = true;
      w.set.syncLegs = (...args: Parameters<TieredStoreSet['syncLegs']>) => {
        if (fail) { fail = false; return Promise.reject(new Error('the lanes could not write')); }
        return syncLegs(...args);
      };
      await expect(sync.pull()).rejects.toThrow('the lanes could not write');
      // The failed pass deletes nothing; retry judges the new text on its own.
      expect(w.readableInInternal('A')).toBe(true);
      expect(w.textIn(w.internal, 'A')).toContain('stored ordinary');
      await sync.pull();
      expect(w.textIn(w.internal, 'A')).toContain('newer protected');
      expect(w.readableInInternal('A')).toBe(true);
    } finally {
      w.close();
    }
  });
});

describe('captures are ordered by when they were captured', () => {
  test('the capture mark sorts by capture time, then the helper\'s sequence, then the place in the spool', () => {
    const base = `${ACCOUNT}:chat-1:A:2026-10-20T09:00:00Z`;
    const at = (capturedAt: string, seq: number, file: string, line: number) => telegramCaptureVersion(base, { capturedAt, seq, file, line });
    expect(compareTelegramVersions(at('2026-10-20T10:00:00.000Z', 1, '2026-10-20.jsonl', 9), at('2026-10-20T11:00:00.000Z', 2, '2026-10-20.jsonl', 1))).toBe(-1);
    expect(compareTelegramVersions(at('2026-10-20T10:00:00.000Z', 3, 'b', 1), at('2026-10-20T10:00:00.000Z', 2, 'a', 9))).toBe(1);
    expect(compareTelegramVersions(base, at('2026-10-20T10:00:00.000Z', 0, 'a', 1))).toBe(-1);
  });

  test('a day file removed and written again is read from its start, never past the old file\'s line count', async () => {
    const w = world();
    try {
      for (const id of ['P1', 'P2', 'P3', 'P4', 'P5']) w.capture('2026-10-20.jsonl', { id, text: `marker${id} first file`, at: '2026-10-20T09:00:00Z', trust: 'internal' });
      const sync = w.handler();
      await sync.pull();
      expect(w.internal.lastCompletedSyncRun('telegram_capture_spool_internal')?.cursor).toBe('2026-10-20.jsonl:5');
      // Removed, and written again under the same name with more lines than before.
      unlinkSync(join(w.spoolDir, '2026-10-20.jsonl'));
      const fresh = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7'];
      for (const id of fresh) w.capture('2026-10-20.jsonl', { id, text: `marker${id} second file`, at: '2026-10-20T10:00:00Z', trust: 'internal' });
      const receipt = await sync.pull();
      expect(receipt.counts.spool_cursor_resets).toBeGreaterThan(0);
      for (const id of fresh) expect(w.textIn(w.internal, id)).toContain('second file');
    } finally {
      w.close();
    }
  });

  test('a record rewritten in place under the cursor is caught: the file is read again, and a domain rewrite does not change the tier', async () => {
    const w = world();
    try {
      const a = w.capture('2026-10-20.jsonl', { id: 'A', text: 'markerA first', at: '2026-10-20T09:00:00Z', trust: 'internal' });
      const b = w.capture('2026-10-20.jsonl', { id: 'B', text: 'markerB second', at: '2026-10-20T09:00:00Z', trust: 'internal' });
      const cRecord = w.capture('2026-10-20.jsonl', { id: 'C', text: 'markerC third, ordinary', at: '2026-10-20T09:00:00Z', trust: 'internal' });
      const sync = w.handler();
      await sync.pull();
      expect(w.textIn(w.internal, 'C')).toContain('ordinary');
      // The last record is rewritten in place, longer, as protected: the first line (the file's identity) is unchanged.
      writeFileSync(join(w.spoolDir, '2026-10-20.jsonl'), line(a) + line(b) + line({ ...cRecord, trust: 'secure_local', text: 'markerC third, now protected and longer' }));
      const receipt = await sync.pull();
      expect(receipt.counts.spool_cursor_resets).toBeGreaterThan(0);
      expect(w.readableInInternal('C')).toBe(true);
      expect(w.textIn(w.secureLocal, 'C')).toBe('');
      // The others were read again under the intake rule and stand as they were.
      expect(w.textIn(w.internal, 'A')).toContain('markerA first');
    } finally {
      w.close();
    }
  });

  test('a crash between the cursors moving and their receipts being kept leaves nothing trusted: the next pull reads the file again', async () => {
    const w = world();
    try {
      const records = [1, 2, 3].map((n) => w.capture('2026-10-20.jsonl', { id: `R${n}`, text: `markerR${n} ordinary`, at: '2026-10-20T09:00:00Z', trust: 'internal' }));
      const sync = w.handler();
      await sync.pull();
      // Two more records; the next pull's cursors and clearing move to line 5, then it is killed before the receipts are kept.
      records.push(w.capture('2026-10-20.jsonl', { id: 'R4', text: 'markerR4 ordinary', at: '2026-10-20T09:00:00Z', trust: 'internal' }));
      records.push(w.capture('2026-10-20.jsonl', { id: 'R5', text: 'markerR5 ordinary', at: '2026-10-20T09:00:00Z', trust: 'internal' }));
      const writeMeta = w.set.ledger.writeMeta.bind(w.set.ledger);
      w.set.ledger.writeMeta = (key: string, value: string) => {
        if (key.startsWith('telegram:spool_boundary:')) throw new Error('killed before the receipts');
        writeMeta(key, value);
      };
      await expect(sync.pull()).rejects.toThrow('killed before the receipts');
      w.set.ledger.writeMeta = writeMeta;
      expect(w.internal.lastCompletedSyncRun('telegram_capture_spool_internal')?.cursor).toBe('2026-10-20.jsonl:5');
      // Record 3 is rewritten in place, inside both boundary windows: now protected, and holding a Secret.
      const key = '-----BEGIN RSA ' + 'PRIVATE KEY-----MIIEowIBAAKCAQEA-----END RSA PRIVATE KEY-----';
      writeFileSync(join(w.spoolDir, '2026-10-20.jsonl'), records.map((record, index) => line(index === 2
        ? { ...record, trust: 'secure_local', text: `markerR3 protected now ${key}`, capturedAt: '2026-10-21T00:00:00.000Z', seq: 99 }
        : record)).join(''));
      const receipt = await sync.pull();
      expect(receipt.counts.spool_cursor_resets).toBeGreaterThan(0);
      expect(w.readableInInternal('R3')).toBe(false);
      // The Secret is cleared out of the spool: the clearing was owed again from the start.
      expect(readFileSync(join(w.spoolDir, '2026-10-20.jsonl'), 'utf8')).not.toContain('MIIEowIBAAKCAQEA');
    } finally {
      w.close();
    }
  });

  test('a mismatch under the cursor owes the Secrets clearing again from the start of the spool', async () => {
    const w = world();
    try {
      const a = w.capture('2026-10-20.jsonl', { id: 'A', text: 'markerA first', at: '2026-10-20T09:00:00Z', trust: 'internal' });
      w.capture('2026-10-20.jsonl', { id: 'B', text: 'markerB second', at: '2026-10-20T09:00:00Z', trust: 'internal' });
      const sync = w.handler();
      await sync.pull();
      expect(w.set.ledger.readMeta('capture_spool_secret_redaction:telegram:cleared_through')).toBe('2026-10-20.jsonl:2');
      writeFileSync(join(w.spoolDir, '2026-10-20.jsonl'), line(a) + line({ ...a, id: 'B', text: 'markerB replaced, same file' }));
      let clearedSeen: string | undefined = 'unread';
      const writeMeta = w.set.ledger.writeMeta.bind(w.set.ledger);
      w.set.ledger.writeMeta = (key: string, value: string) => {
        if (key === 'capture_spool_secret_redaction:telegram:cleared_through' && clearedSeen === 'unread') clearedSeen = value;
        writeMeta(key, value);
      };
      await sync.pull();
      // Dropped first (owed from the start), then recorded again only as far as this pull's clearing ran.
      expect(clearedSeen).toBe('');
      expect(w.set.ledger.readMeta('capture_spool_secret_redaction:telegram:cleared_through')).toBe('2026-10-20.jsonl:2');
    } finally {
      w.close();
    }
  });

  test('a day file removed and written again does not reverse two captures of one version', async () => {
    const w = world();
    try {
      const one = [{ key: '👍', count: 1 }];
      const two = [{ key: '👍', count: 2 }];
      w.capture('2026-10-20.jsonl', { id: 'B', text: 'markerB filler', at: '2026-10-20T08:00:00Z', trust: 'internal' });
      w.capture('2026-10-20.jsonl', { id: 'C', text: 'markerC filler', at: '2026-10-20T08:00:00Z', trust: 'internal' });
      w.capture('2026-10-20.jsonl', { id: 'A', text: 'markerA photo', at: '2026-10-20T09:00:00Z', trust: 'internal', reactions: one });
      const sync = w.handler();
      await sync.pull();
      expect(w.internal.itemReactions(`${ACCOUNT}:chat-1:A`)).toEqual(one);
      // The file is removed and written again: the newer capture sits on its first line.
      unlinkSync(join(w.spoolDir, '2026-10-20.jsonl'));
      w.capture('2026-10-20.jsonl', { id: 'A', text: 'markerA photo', at: '2026-10-20T09:00:00Z', trust: 'internal', reactions: two });
      await sync.pull();
      await sync.pull();
      expect(w.internal.itemReactions(`${ACCOUNT}:chat-1:A`)).toEqual(two);
    } finally {
      w.close();
    }
  });
});

/** A small deterministic generator, so a failing seed can be run again. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('a seeded run over mixed-domain captures, prunes, recreated files and failures', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    test(`seed ${seed}: the newest Personal capture stays in the ordinary store`, async () => {
      const random = prng(seed);
      const w = world();
      const ids = ['A', 'B', 'C'];
      const written: Capture[] = [];
      const files = new Map<Capture, string>();
      let failPass = false;
      const syncLegs = w.set.syncLegs.bind(w.set);
      w.set.syncLegs = (...args) => failPass ? Promise.reject(new Error('injected pass failure')) : syncLegs(...args);
      const sync = w.handler({ maxItems: 1 + Math.floor(random() * 3) });
      try {
        let day = 10;
        for (let step = 0; step < 40; step += 1) {
          const roll = random();
          if (roll < 0.55) {
            const id = ids[Math.floor(random() * ids.length)]!;
            const trust = random() < 0.3 ? 'secure_local' : 'internal';
            const at = `2026-10-${String(1 + Math.floor(random() * 27)).padStart(2, '0')}T09:00:00Z`;
            const file = `2026-11-${String(day).padStart(2, '0')}.jsonl`;
            const made = w.capture(file, { id, text: `marker${id} text ${step}`, at, trust });
            written.push(made);
            files.set(made, file);
          } else if (roll < 0.65) {
            day += 1;
          } else if (roll < 0.72) {
            // Prune the oldest day file left.
            const file = `2026-11-${String(day - 1).padStart(2, '0')}.jsonl`;
            if (existsSync(join(w.spoolDir, file))) unlinkSync(join(w.spoolDir, file));
          } else {
            failPass = random() < 0.2;
            await sync.pull().catch(() => undefined);
            failPass = false;
          }
          expect(w.secureLocal.status().counts.items).toBe(0);
        }
        // Each surviving record is judged Personal, regardless of old domain.
        for (let pull = 0; pull < 8; pull += 1) await sync.pull();
        for (const id of ids) {
          const newestLeft = written
            .filter((entry) => entry.id === id && existsSync(join(w.spoolDir, files.get(entry)!)))
            .map((entry) => entry.at)
            .sort()
            .at(-1);
          if (newestLeft === undefined) continue;
          const stored = w.internal.storedItemState(w.identity(id));
          expect(stored?.version).toBeDefined();
          expect(editTimeOf(stored!.version!) >= newestLeft).toBe(true);
        }
      } finally {
        w.close();
      }
    });
  }
});

/** The edit time a stored version carries. */
function editTimeOf(version: string): string {
  return /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)(?::r[0-9a-f]+)?(?:~at:.*)?$/.exec(version)?.[1] ?? '';
}
