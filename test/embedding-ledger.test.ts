import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import {
  EMBEDDING_LEDGER_BACKFILL,
  EMBEDDING_LEDGER_PATH_ENV,
  appendEmbeddingLedgerEntry,
  appendEmbeddingLedgerEntryOnce,
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
import { renderEmbeddingLedgerPage } from '../src/workers/dashboard/pages/embedding-ledger.ts';

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
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'old', recorded_at: '2026-08-25T00:00:00.000Z' }));
    await appendEmbeddingLedgerEntry(path, entry({ entry_id: 'new', recorded_at: '2026-08-26T00:00:00.000Z' }));

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

  test('an entry with no id is never deduplicated away', async () => {
    const path = tempLedgerPath();

    await appendEmbeddingLedgerEntryOnce(path, entry({ what: 'Same sentence.' }));
    await appendEmbeddingLedgerEntryOnce(path, entry({ what: 'Same sentence.' }));

    const ledger = await readEmbeddingLedger(path);
    expect(ledger.entries.filter((found) => found.what === 'Same sentence.')).toHaveLength(2);
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

  test('only owner decisions are approved, and the newest is the 2026-08-24 lane enablement', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());
    const approved = ledger.entries.filter((found) => found.approved_by === 'jamie');

    expect(ledger.entries[0]?.entry_id).toBe('backfill-2026-08-24-drain-lane-enablement');
    expect(ledger.entries[0]?.approved_by).toBe('jamie');
    // The two owner decisions of 2026-08-24, newest first: keep the model, then
    // switch on the three lanes that run on it. Nothing else claims approval,
    // which is the rule the ledger exists to keep — an approval is never
    // inferred from a machine having done something.
    expect(approved.map((found) => found.entry_id)).toEqual([
      'backfill-2026-08-24-drain-lane-enablement',
      'backfill-2026-08-24-model-decision',
    ]);
    expect(approved[1]?.kind).toBe('model_decision');
    expect(approved[1]?.model_id).toBe(QWEN3);
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

describe('page', () => {
  test('renders the backfill newest first, in plain language', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());

    const page = renderEmbeddingLedgerPage(ledger, { now: NOW });

    expect(page).toContain('Embedding decisions');
    expect(page).toContain('Model decision');
    expect(page).toContain('Stored vectors invalidated');
    expect(page).toContain('Re-embed started');
    expect(page.indexOf('Model decision')).toBeLessThan(page.indexOf('Stored vectors invalidated'));
  });

  test('says who approved what, and never launders an unapproved change', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());

    const page = renderEmbeddingLedgerPage(ledger, { now: NOW });

    expect(page).toContain('Approved in advance by the owner');
    expect(page).toContain('Not approved — the system did this on its own');
    expect(page).toContain('Not approved — no decision is on record');
  });

  test('prints the loopback endpoints in full, because the port is the story', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());

    const page = renderEmbeddingLedgerPage(ledger, { now: NOW });

    expect(page).toContain('http://127.0.0.1:28090/v1');
    expect(page).toContain('28011');
  });

  test('states the date in UTC alongside the relative time', async () => {
    const ledger = await readEmbeddingLedger(tempLedgerPath());

    const page = renderEmbeddingLedgerPage(ledger, { now: NOW });

    expect(page).toContain('20 Aug 2026');
    expect(page).toContain('UTC');
  });

  test('reports skipped lines rather than presenting a damaged record as whole', () => {
    const page = renderEmbeddingLedgerPage({ entries: [], skipped: 3, path: '/x' }, { now: NOW });

    expect(page).toContain('3 lines');
    expect(page).toContain('incomplete');
  });

  test('escapes entry text rather than rendering it as markup', () => {
    const page = renderEmbeddingLedgerPage({
      entries: [entry({ what: '<script>alert(1)</script>', why: '<img onerror=x>' })],
      skipped: 0,
      path: '/x',
    }, { now: NOW });

    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;');
  });

  test('carries the reader token into its one link back', () => {
    const page = renderEmbeddingLedgerPage({ entries: [], skipped: 0, path: '/x' }, {
      now: NOW,
      basePath: '/dashboard?token=dash_abc',
    });

    expect(page).toContain('/dashboard?token=dash_abc&amp;background');
  });

  test('an empty ledger says nothing was recorded, not that nothing happened', () => {
    const page = renderEmbeddingLedgerPage({ entries: [], skipped: 0, path: '/x' }, { now: NOW });

    expect(page).toContain('not that none happened');
  });
});

describe('route', () => {
  const AUTH_TOKEN = 'test-worker-auth-token-embedding-ledger';
  const URL_BASE = 'http://worker.test/dashboard?embedding-ledger';

  function guarded(): (request: Request) => Promise<Response> {
    return withWorkerBearerAuth(createEmailSourceWorker().fetch, { authToken: AUTH_TOKEN });
  }

  test('serves the page to a bearer-token reader', async () => {
    const response = await guarded()(new Request(URL_BASE, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('Embedding decisions');
  });

  test('serves the page to the read-only dash_ query token, like every dashboard page', async () => {
    const token = dashboardQueryTokenFromWorkerAuthToken(AUTH_TOKEN)!;

    const response = await guarded()(new Request(`${URL_BASE}&token=${encodeURIComponent(token)}`));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Embedding decisions');
  });

  test('refuses an unauthenticated reader', async () => {
    const response = await guarded()(new Request(URL_BASE));

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('Embedding decisions');
  });

  test('refuses a wrong bearer token and a wrong query token', async () => {
    const wrongBearer = await guarded()(new Request(URL_BASE, {
      headers: { Authorization: 'Bearer not-the-token' },
    }));
    const wrongQuery = await guarded()(new Request(`${URL_BASE}&token=dash_wrong`));

    expect(wrongBearer.status).toBe(401);
    expect(wrongQuery.status).toBe(401);
  });

  test('leaves the ordinary dashboard route alone', async () => {
    const response = await guarded()(new Request('http://worker.test/dashboard', {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    }));

    expect(await response.text()).not.toContain('Embedding decisions');
  });
});
