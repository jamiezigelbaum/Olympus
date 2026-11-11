import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import {
  EMBEDDING_LEDGER_BACKFILL,
  EMBEDDING_LEDGER_PATH_ENV,
  appendEmbeddingLedgerEntry,
  appendEmbeddingLedgerEntryOnce,
  appendEmbeddingLedgerEntriesOnce,
  embeddingLedgerScopeText,
  isEmbeddingLedgerEntry,
  parseEmbeddingLedgerJsonl,
  readEmbeddingLedger,
  resolveEmbeddingLedgerPath,
  type EmbeddingLedgerEntry,
} from '../src/workers/embedding-ledger.ts';
import {
  embeddingLedgerObservationEntries,
  recordEmbeddingLedgerObservations,
  type EmbeddingCorpusObservation,
} from '../src/workers/embedding-ledger-observer.ts';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const QWEN3 = 'secure-local-qwen3-embed';
const QWEN3_EPOCH = 'local:openai-compatible:secure-local-qwen3-embed:2560';
const DELPHI = 'http://127.0.0.1:28090/v1';

const tempDirs: string[] = [];

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-embedding-ledger-'));
  tempDirs.push(dir);
  return join(dir, 'embedding-ledger.jsonl');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<EmbeddingLedgerEntry> = {}): EmbeddingLedgerEntry {
  return {
    recorded_at: '2026-08-24T09:00:00.000Z',
    kind: 'note',
    what: 'A thing happened to the embeddings.',
    approved_by: 'jamie',
    status: 'complete',
    ...overrides,
  };
}

describe('embedding ledger path', () => {
  test('prefers the explicit override', () => {
    const path = resolveEmbeddingLedgerPath({ [EMBEDDING_LEDGER_PATH_ENV]: '  /srv/ledger.jsonl  ' });

    expect(path).toBe('/srv/ledger.jsonl');
  });

  test('falls back to durable worker state under XDG_DATA_HOME, never a temp dir', () => {
    const path = resolveEmbeddingLedgerPath({ XDG_DATA_HOME: '/data' });

    expect(path).toBe('/data/openclaw/olympus/embedding-ledger.jsonl');
    expect(path.startsWith('/tmp')).toBe(false);
  });

  test('defaults under the home data dir when XDG_DATA_HOME is unset', () => {
    const path = resolveEmbeddingLedgerPath({});

    expect(path.endsWith('/.local/share/openclaw/olympus/embedding-ledger.jsonl')).toBe(true);
  });
});

describe('append and read', () => {
  test('round-trips an entry through the file', async () => {
    const path = tempLedgerPath();
    const recorded = entry({
      entry_id: 'round-trip',
      kind: 'model_decision',
      what: 'Stay on the local Qwen3 embedding model.',
      model_id: QWEN3,
      epoch: QWEN3_EPOCH,
      endpoint: DELPHI,
      scope: { corpora: ['dropbox'], chunks: { dropbox: 162_203 } },
      why: 'The owner researched it.',
    });

    await appendEmbeddingLedgerEntry(path, recorded);
    const ledger = await readEmbeddingLedger(path);

    expect(ledger.entries.find((found) => found.entry_id === 'round-trip')).toEqual(recorded);
    expect(ledger.skipped).toBe(0);
    expect(ledger.path).toBe(path);
  });

  test('appends rather than replaces, and keeps the file owner-only', async () => {
    const path = tempLedgerPath();

    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'first', what: 'First.' }));
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'second', what: 'Second.' }));

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('a missing file is an empty ledger, not an error', async () => {
    const ledger = await readEmbeddingLedger(join(tempLedgerPath(), 'nope', 'absent.jsonl'));

    expect(ledger.skipped).toBe(0);
    expect(ledger.entries).toEqual([...EMBEDDING_LEDGER_BACKFILL].reverse());
  });

  test('returns entries newest first', async () => {
    const path = tempLedgerPath();
    // After every committed backfill entry, so the two appended ones lead.
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'old', recorded_at: '2026-10-25T00:00:00.000Z' }));
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'new', recorded_at: '2026-10-26T00:00:00.000Z' }));

    const ledger = await readEmbeddingLedger(path);

    expect(ledger.entries[0]?.entry_id).toBe('new');
    expect(ledger.entries[1]?.entry_id).toBe('old');
  });

  test('appendOnce refuses a second entry with the same id and admits a new one', async () => {
    const path = tempLedgerPath();
    const once = entry({ entry_id: 'only-once' });

    expect(await appendEmbeddingLedgerEntryOnce(path, once)).toBe(true);
    expect(await appendEmbeddingLedgerEntryOnce(path, once)).toBe(false);
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'other' }))).toBe(true);

    const ledger = await readEmbeddingLedger(path);
    expect(ledger.entries.filter((found) => found.entry_id === 'only-once')).toHaveLength(1);
  });

  test('appendOnce sees ids another writer appended, and only reads each byte once', async () => {
    const path = tempLedgerPath();
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'first' }))).toBe(true);
    // Another process appends a complete line, then starts a line it has not finished.
    appendFileSync(path, `${JSON.stringify(entry({ entry_id: 'from-elsewhere' }))}\n`);
    const partial = JSON.stringify(entry({ entry_id: 'half-written' }));
    appendFileSync(path, partial.slice(0, 20));

    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'from-elsewhere' }))).toBe(false);
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'first' }))).toBe(false);
  });

  test('overlapping appendOnce calls never skip records appended after them', async () => {
    const path = tempLedgerPath();
    await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'seed' }));
    await Promise.all([
      appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'seed' })),
      appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'a' })),
      appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'b' })),
    ]);
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'a' }))).toBe(false);
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'b' }))).toBe(false);
  });

  test('appendOnce rereads a ledger that was replaced by a shorter file', async () => {
    const path = tempLedgerPath();
    await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'gone-a' }));
    await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'gone-b' }));
    writeFileSync(path, `${JSON.stringify(entry({ entry_id: 'kept' }))}\n`);

    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'kept' }))).toBe(false);
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'gone-a' }))).toBe(true);
  });

  test('an entry with no id is never deduplicated away', async () => {
    const path = tempLedgerPath();

    await appendEmbeddingLedgerEntryOnce(path, entry({ what: 'Same sentence.' }));
    await appendEmbeddingLedgerEntryOnce(path, entry({ what: 'Same sentence.' }));

    const ledger = await readEmbeddingLedger(path);
    expect(ledger.entries.filter((found) => found.what === 'Same sentence.')).toHaveLength(2);
  });
});

describe('interrupted appends (#1012, #1014)', () => {
  test('a retry after A + partial B leaves A, B and C readable and skips only the fragment', async () => {
    const path = tempLedgerPath();
    const [a, b, c] = ['note-a', 'note-b', 'note-c'].map(id => entry({ entry_id: id }));
    // The first attempt writes A and part of B, then the disk fills.
    const original = fs.open;
    const opened = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[1] !== 'r') {
        spyOn(handle, 'appendFile').mockImplementation(async (data: unknown) => {
          const text = String(data);
          await handle.write(text.slice(0, text.indexOf('\n') + 20));
          throw Object.assign(new Error('Synthetic ENOSPC'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    try {
      await expect(appendEmbeddingLedgerEntriesOnce(path, [a!, b!])).rejects.toThrow('Synthetic ENOSPC');
    } finally { opened.mockRestore(); }
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(false);

    // The caller still holds A and B; it retries them with C.
    expect(await appendEmbeddingLedgerEntriesOnce(path, [a!, b!, c!])).toBe(2);
    const ledger = await readEmbeddingLedger(path);
    // The torn fragment of B is its own skipped line; nothing else is lost.
    expect(ledger.skipped).toBe(1);
    for (const id of ['note-a', 'note-b', 'note-c']) {
      expect(ledger.entries.filter(found => found.entry_id === id)).toHaveLength(1);
    }
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
  });

  test('two writers racing over the same torn tail never lose an acknowledged entry', async () => {
    const path = tempLedgerPath();
    writeFileSync(path, `${JSON.stringify(entry({ entry_id: 'before' }))}\n${JSON.stringify(entry()).slice(0, 15)}`);
    // Writer one inspects the torn tail, then stalls until writer two has
    // repaired it, appended and fsynced its own entry.
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    let inspected!: () => void;
    const hasInspected = new Promise<void>(resolve => { inspected = resolve; });
    const original = fs.open;
    let first = true;
    const opened = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (args[1] === 'a+' && first) {
        first = false;
        const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<unknown>;
        spyOn(handle, 'read').mockImplementation((async (...readArgs: unknown[]) => {
          const result = await read(...readArgs);
          inspected();
          await stalled;
          return result;
        }) as never);
      }
      return handle;
    });
    try {
      const one = appendEmbeddingLedgerEntry(path, entry({ entry_id: 'writer-one' }));
      await hasInspected;
      await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'writer-two' }));
      release();
      await one;
    } finally { opened.mockRestore(); }
    const ledger = await readEmbeddingLedger(path);
    for (const id of ['before', 'writer-one', 'writer-two']) {
      expect(ledger.entries.filter(found => found.entry_id === id)).toHaveLength(1);
    }
    expect(ledger.skipped).toBe(1);
  });

  test('an ID-less append also starts on a line boundary', async () => {
    const path = tempLedgerPath();
    writeFileSync(path, `${JSON.stringify(entry({ entry_id: 'kept', recorded_at: '2026-08-24T08:00:00.000Z' }))}\n${JSON.stringify(entry()).slice(0, 15)}`);
    await appendEmbeddingLedgerEntry(path, entry({ what: 'After the tear.' }));
    const ledger = await readEmbeddingLedger(path);
    expect(ledger.skipped).toBe(1);
    const mine = ledger.entries.filter(found => found.entry_id === 'kept' || found.what === 'After the tear.');
    expect(mine.map(found => found.entry_id ?? found.what)).toEqual(['After the tear.', 'kept']);
  });

  test('a complete last entry without a newline is kept, not truncated', async () => {
    const path = tempLedgerPath();
    writeFileSync(path, JSON.stringify(entry({ entry_id: 'hand-edited' })));
    expect(await appendEmbeddingLedgerEntryOnce(path, entry({ entry_id: 'next' }))).toBe(true);
    const ledger = await readEmbeddingLedger(path);
    expect(ledger.skipped).toBe(0);
    expect(ledger.entries.filter(found => found.entry_id === 'hand-edited')).toHaveLength(1);
    expect(ledger.entries.filter(found => found.entry_id === 'next')).toHaveLength(1);
  });

  test('a torn tail is terminated, never cut, so earlier bytes are untouched', async () => {
    const path = tempLedgerPath();
    writeFileSync(path, '{"recorded_at":"2026-');
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'first-whole' }));
    expect(readFileSync(path, 'utf8')).toBe(`{"recorded_at":"2026-\n${JSON.stringify(entry({ entry_id: 'first-whole' }))}\n`);
  });
});

describe('ID-less appends (#1011)', () => {
  test('never stat or read the existing ledger', async () => {
    const path = tempLedgerPath();
    writeFileSync(path, `${JSON.stringify(entry({ entry_id: 'existing' }))}\n`);
    const original = fs.open;
    const reads: string[] = [];
    const opened = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[1] === 'r') reads.push(String(args[0]));
      return original(...args);
    });
    const stat = spyOn(fs, 'stat').mockImplementation(async () => {
      throw Object.assign(new Error('Synthetic stat failure'), { code: 'EIO' });
    });
    try {
      expect(await appendEmbeddingLedgerEntryOnce(path, entry({ what: 'No id here.' }))).toBe(true);
      expect(await appendEmbeddingLedgerEntriesOnce(path, [entry({ what: 'One.' }), entry({ what: 'Two.' })])).toBe(2);
    } finally { opened.mockRestore(); stat.mockRestore(); }
    expect(reads).toEqual([]);
    expect((await readEmbeddingLedger(path)).entries.filter(found => !found.entry_id)).toHaveLength(3);
  });
});

describe('corruption tolerance', () => {
  test('skips unparsable lines, keeps the good ones, and reports the count', async () => {
    const path = tempLedgerPath();
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'good-one' }));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"truncated": \nnot json at all\n`, { flag: 'w' });
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'good-two' }));

    const ledger = await readEmbeddingLedger(path);

    expect(ledger.skipped).toBe(2);
    expect(ledger.entries.some((found) => found.entry_id === 'good-one')).toBe(true);
    expect(ledger.entries.some((found) => found.entry_id === 'good-two')).toBe(true);
  });

  test('counts well-formed JSON that is not an entry as skipped', () => {
    const parsed = parseEmbeddingLedgerJsonl('{"hello":"world"}\n[1,2,3]\n"a string"\n');

    expect(parsed.entries).toEqual([]);
    expect(parsed.skipped).toBe(3);
  });

  test('blank lines are not corruption', () => {
    expect(parseEmbeddingLedgerJsonl('\n\n   \n').skipped).toBe(0);
  });

  test('refuses an entry whose approval word is not one this module knows', () => {
    expect(isEmbeddingLedgerEntry({ ...entry(), approved_by: 'someone-else' })).toBe(false);
    expect(isEmbeddingLedgerEntry({ ...entry(), kind: 'invented_kind' })).toBe(false);
    expect(isEmbeddingLedgerEntry({ ...entry(), status: 'maybe' })).toBe(false);
    expect(isEmbeddingLedgerEntry(entry())).toBe(true);
  });

  test('refuses an entry with no sentence, because that is what a reader reads', () => {
    expect(isEmbeddingLedgerEntry({ ...entry(), what: '   ' })).toBe(false);
    expect(isEmbeddingLedgerEntry({ ...entry(), recorded_at: '' })).toBe(false);
  });
});

describe('backfill', () => {
  test('the 2026-08-20 wipe and the 2026-08-24 decision are both on record', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const kinds = ledger.entries.map((found) => found.kind);

    expect(kinds).toContain('endpoint_change');
    expect(kinds).toContain('invalidation');
    expect(kinds).toContain('re_embed_started');
    expect(kinds).toContain('model_decision');
  });

  test('names the retarget, the commit, and the five emptied stores', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const retarget = ledger.entries.find((found) => found.kind === 'endpoint_change');
    const invalidation = ledger.entries.find((found) => found.kind === 'invalidation');

    expect(retarget?.what).toContain('28011');
    expect(retarget?.what).toContain('28090');
    expect(retarget?.what).toContain('8ad61fa9');
    expect(invalidation?.scope?.corpora).toEqual([
      'dropbox', 'gmail-secure', 'drive-secure', 'whatsapp-live', 'telegram-protected',
    ]);
  });

  test('the model and epoch did not change across the wipe', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const wipe = ledger.entries.filter((found) => found.kind === 'endpoint_change'
      || found.kind === 'invalidation');

    expect(wipe).toHaveLength(2);
    for (const found of wipe) {
      expect(found.model_id).toBe(QWEN3);
      expect(found.epoch).toBe(QWEN3_EPOCH);
    }
  });

  test('the wipe is recorded as unapproved and the re-embed as still running', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const invalidation = ledger.entries.find((found) => found.kind === 'invalidation');
    const reEmbed = ledger.entries.find((found) => found.kind === 're_embed_started');

    expect(invalidation?.approved_by).not.toBe('jamie');
    expect(reEmbed?.status).toBe('in_progress');
  });

  test('only owner decisions are approved, and the newest is the 2026-09-30 Gmail catch-up decision', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const approved = ledger.entries.filter((found) => found.approved_by === 'jamie');

    expect(ledger.entries[0]?.entry_id).toBe('decision-2026-09-30-gmail-catch-up');
    expect(ledger.entries[0]?.approved_by).toBe('jamie');
    // The owner decisions, newest first: chat lanes catch up on chunks still
    // missing a vector (2026-09-25); Readwise answers hybrid on its existing
    // vectors (2026-09-24); then 2026-08-24's keep-the-model and the
    // three lanes that run on it. Nothing else claims approval, which is the
    // rule the ledger exists to keep — an approval is never inferred from a
    // machine having done something.
    expect(approved.map((found) => found.entry_id)).toEqual([
      'decision-2026-09-30-gmail-catch-up',
      'decision-2026-09-25-chat-lane-catch-up',
      'decision-2026-09-24-readwise-hybrid',
      'backfill-2026-08-24-drain-lane-enablement',
      'backfill-2026-08-24-model-decision',
    ]);
    expect(approved[4]?.kind).toBe('model_decision');
    expect(approved[4]?.model_id).toBe(QWEN3);
  });

  test('the Readwise hybrid decision quotes the owner and invalidates nothing', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const decision = ledger.entries.find((found) => found.entry_id === 'decision-2026-09-24-readwise-hybrid');

    expect(decision?.kind).toBe('model_decision');
    expect(decision?.what).toContain('Readwise: use existing embeddings for hybrid answers; decouple embedding from sync; keep vectors.');
    expect(decision?.scope?.corpora).toEqual(['readwise', 'readwise-secure']);
    expect(decision?.why).toContain('no existing vector is invalidated or re-embedded');
  });

  test('the lane enablement names its corpora and invalidates nothing', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const enablement = ledger.entries
      .find((found) => found.entry_id === 'backfill-2026-08-24-drain-lane-enablement');

    expect(enablement?.scope?.corpora).toEqual(['dropbox', 'readwise', 'x-bookmarks']);
    // Counts only where one was actually read. Readwise's chunk total was
    // approximate, so it has no number here — only a qualified sentence.
    expect(enablement?.scope?.chunks).toEqual({ dropbox: 52_840, 'x-bookmarks': 15 });
    expect(enablement?.why).toContain('no existing vector is invalidated');
  });

  test('appears exactly once however many times the ledger is read', async () => {
    const path = tempLedgerPath();

    const first = await readEmbeddingLedger(path);
    const second = await readEmbeddingLedger(path);

    for (const backfill of EMBEDDING_LEDGER_BACKFILL) {
      expect(first.entries.filter((found) => found.entry_id === backfill.entry_id)).toHaveLength(1);
      expect(second.entries.filter((found) => found.entry_id === backfill.entry_id)).toHaveLength(1);
    }
    expect(second.entries).toHaveLength(first.entries.length);
  });

  test('appears exactly once even when the same entry is also written to the file', async () => {
    const path = tempLedgerPath();
    const seeded = EMBEDDING_LEDGER_BACKFILL[0]!;
    await appendEmbeddingLedgerEntry(path, seeded);
    await appendEmbeddingLedgerEntry(path, seeded);

    const ledger = await readEmbeddingLedger(path);

    expect(ledger.entries.filter((found) => found.entry_id === seeded.entry_id)).toHaveLength(1);
  });

  test('a correction appended under a backfill id supersedes the constant', async () => {
    const path = tempLedgerPath();
    const seeded = EMBEDDING_LEDGER_BACKFILL[2]!;
    await appendEmbeddingLedgerEntry(path, {
      ...seeded,
      kind: 're_embed_completed',
      what: 'The 2026-08-20 re-embed finished.',
      status: 'complete',
    });

    const ledger = await readEmbeddingLedger(path);
    const superseding = ledger.entries.filter((found) => found.entry_id === seeded.entry_id);

    expect(superseding).toHaveLength(1);
    expect(superseding[0]?.status).toBe('complete');
  });

  test('survives someone deleting the ledger file', async () => {
    const path = tempLedgerPath();
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'transient' }));
    rmSync(path);

    const ledger = await readEmbeddingLedger(path);

    expect(ledger.entries).toHaveLength(EMBEDDING_LEDGER_BACKFILL.length);
  });
});

describe('observer', () => {
  const context = { observed_at: NOW, model_id: QWEN3, epoch: QWEN3_EPOCH, endpoint: DELPHI };

  function observation(overrides: Partial<EmbeddingCorpusObservation>): EmbeddingCorpusObservation {
    return { corpus: 'dropbox', embedded_chunks: 100, missing_chunks: 0, ...overrides };
  }

  test('records a start when epoch-pending chunks appear for a quiet corpus', () => {
    const recorded = [entry({
      kind: 're_embed_completed',
      scope: { corpora: ['dropbox'] },
      endpoint: DELPHI,
      epoch: QWEN3_EPOCH,
    })];

    const entries = embeddingLedgerObservationEntries(
      [observation({ embedded_chunks: 10, missing_chunks: 4_120 })],
      recorded,
      context,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('re_embed_started');
    expect(entries[0]?.status).toBe('in_progress');
    expect(entries[0]?.approved_by).toBe('system-automatic');
    expect(entries[0]?.what).toContain('4,120');
    expect(entries[0]?.scope?.corpora).toEqual(['dropbox']);
  });

  test('records a completion when the pending chunks are worked off', () => {
    const recorded = [entry({ kind: 're_embed_started', scope: { corpora: ['dropbox'] }, status: 'in_progress' })];

    const entries = embeddingLedgerObservationEntries(
      [observation({ embedded_chunks: 4_130, missing_chunks: 0 })],
      recorded,
      context,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('re_embed_completed');
    expect(entries[0]?.status).toBe('complete');
    expect(entries[0]?.what).toContain('4,130');
  });

  test('says nothing at all when nothing has changed', () => {
    const recorded = [entry({ kind: 're_embed_started', scope: { corpora: ['dropbox'] } })];

    expect(embeddingLedgerObservationEntries(
      [observation({ missing_chunks: 900 })],
      recorded,
      context,
    )).toEqual([]);
  });

  test('an endpoint change is caught, named, and marked unapproved', () => {
    const recorded = [entry({ endpoint: 'http://127.0.0.1:28011/v1', epoch: QWEN3_EPOCH })];

    const entries = embeddingLedgerObservationEntries([], recorded, context);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('endpoint_change');
    expect(entries[0]?.approved_by).toBe('system-automatic');
    expect(entries[0]?.what).toContain('28090');
    expect(entries[0]?.what).toContain('28011');
  });

  test('an epoch change is caught separately from the endpoint', () => {
    const recorded = [entry({ endpoint: DELPHI, epoch: 'local:openai-compatible:old-model:1024' })];

    const entries = embeddingLedgerObservationEntries([], recorded, context);

    expect(entries.map((found) => found.kind)).toEqual(['epoch_change']);
  });

  test('backlog after a config change is an invalidation, and the start follows it', () => {
    const recorded = [entry({
      kind: 're_embed_completed',
      scope: { corpora: ['dropbox'] },
      endpoint: 'http://127.0.0.1:28011/v1',
      epoch: QWEN3_EPOCH,
    })];

    const entries = embeddingLedgerObservationEntries(
      [observation({ embedded_chunks: 0, missing_chunks: 162_203 })],
      recorded,
      context,
    );

    expect(entries.map((found) => found.kind)).toEqual([
      'endpoint_change', 'invalidation', 're_embed_started',
    ]);
    expect(entries[1]?.what).toContain('162,203');
    expect(entries[1]?.approved_by).toBe('system-automatic');
  });

  test('backlog with no config change is ordinary new work, never an invalidation', () => {
    const recorded = [entry({
      kind: 're_embed_completed',
      scope: { corpora: ['dropbox'] },
      endpoint: DELPHI,
      epoch: QWEN3_EPOCH,
    })];

    const entries = embeddingLedgerObservationEntries(
      [observation({ embedded_chunks: 900, missing_chunks: 40 })],
      recorded,
      context,
    );

    expect(entries.map((found) => found.kind)).toEqual(['re_embed_started']);
  });

  test('a corpus nobody has recorded before is starting, not being invalidated', () => {
    const entries = embeddingLedgerObservationEntries(
      [observation({ corpus: 'roam', embedded_chunks: 0, missing_chunks: 12 })],
      [entry({ endpoint: 'http://127.0.0.1:28011/v1' })],
      context,
    );

    expect(entries.some((found) => found.kind === 'invalidation')).toBe(false);
    expect(entries.some((found) => found.kind === 're_embed_started')).toBe(true);
  });

  test('records against the real ledger exactly once, however often it runs', async () => {
    const path = tempLedgerPath();
    // The backfill leaves dropbox mid-re-embed, so a corpus reporting no
    // pending chunks is the completion of the 2026-08-20 recovery.
    const done = [observation({ embedded_chunks: 162_203, missing_chunks: 0 })];

    const first = await recordEmbeddingLedgerObservations(path, done, context);
    const second = await recordEmbeddingLedgerObservations(path, done, context);

    expect(first.map((found) => found.kind)).toEqual(['re_embed_completed']);
    expect(second).toEqual([]);
    const ledger = await readEmbeddingLedger(path);
    expect(ledger.entries.filter((found) => found.kind === 're_embed_completed')).toHaveLength(1);
  });

  test('a second re-embed of the same corpus is a distinct entry, not a duplicate', async () => {
    const path = tempLedgerPath();
    const done = [observation({ embedded_chunks: 162_203, missing_chunks: 0 })];
    const working = [observation({ embedded_chunks: 100, missing_chunks: 500 })];

    await recordEmbeddingLedgerObservations(path, done, context);
    await recordEmbeddingLedgerObservations(path, working, context);
    await recordEmbeddingLedgerObservations(path, done, context);

    const ledger = await readEmbeddingLedger(path);
    expect(ledger.entries.filter((found) => found.kind === 're_embed_started')).toHaveLength(2);
    expect(ledger.entries.filter((found) => found.kind === 're_embed_completed')).toHaveLength(2);
  });
});

describe('scope text', () => {
  test('prints counts only where a count is known', () => {
    expect(embeddingLedgerScopeText({ corpora: ['dropbox', 'gmail-secure'], chunks: { dropbox: 162_203 } }))
      .toBe('dropbox (162,203 chunks), gmail-secure');
    expect(embeddingLedgerScopeText({ corpora: ['dropbox'] })).toBe('dropbox');
    expect(embeddingLedgerScopeText(undefined)).toBe('');
  });
});

describe('route', () => {
  const AUTH_TOKEN = 'test-worker-auth-token-embedding-ledger';
  const URL_BASE = 'http://worker.test/dashboard?embedding-ledger';

  function guarded(): (request: Request) => Promise<Response> {
    return withWorkerBearerAuth(createEmailSourceWorker().fetch, { authToken: AUTH_TOKEN });
  }

  // Unified dashboard phase 4 (2026-10-09): the ledger page is gone; its
  // address lands on the dashboard, keeping a dash_ reader's token.
  test('the old ledger page address redirects to the dashboard', async () => {
    const response = await guarded()(new Request(URL_BASE, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/dashboard');
  });

  test('a dash_ reader is redirected with the token kept', async () => {
    const token = dashboardQueryTokenFromWorkerAuthToken(AUTH_TOKEN)!;

    const response = await guarded()(new Request(`${URL_BASE}&token=${encodeURIComponent(token)}`));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe(`/dashboard?token=${encodeURIComponent(token)}`);
  });

  test('refuses an unauthenticated reader', async () => {
    const response = await guarded()(new Request(URL_BASE));

    expect(response.status).toBe(401);
  });
});
