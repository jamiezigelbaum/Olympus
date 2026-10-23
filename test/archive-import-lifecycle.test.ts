// One imported archive from start to removal, on the shared tier spine:
// bounded passes that resume after a crash without counting anything twice,
// a changed or missing file that stops the import visibly, two archives that
// never share a resume point, and a removal that takes everything derived
// from one archive and nothing of another (questions still waiting stay), and
// deleting another source keeps what read the archives. Synthetic mail only.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import type { ArchiveConnectorFactory } from '../src/core/archive-formats.ts';
import { defaultConfig } from '../src/core/config.ts';
import { REMOTE_CONNECTIONS_DB_PATH_ENV } from '../src/core/remote-connections.ts';
import {
  openWaitingPrivateQuestionStore,
  waitingPrivateQuestionsDbPath,
  type StoredPrivateAnswer,
} from '../src/core/waiting-private-questions.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { secretLocationsPathForStore, tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { tierRowVisible } from '../src/workers/connector-store/local-index.ts';
import { createMboxArchiveConnector } from '../src/workers/archive-import/mbox/connector.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import {
  ARCHIVE_IMPORTS_CONCURRENCY_KEY,
  archiveImportTaskId,
  createArchiveImportsSchedulerSource,
} from '../src/workers/archive-import/scheduler-source.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import {
  archiveConnectorStoreDbPath,
  archiveConnectorStoreDbPaths,
  archiveCorpusId,
  withArchiveImportCorpora,
} from '../src/workers/archive-import/store.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../src/workers/archive-import/sync.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function mail(index: number, input: { subject?: string; body?: string; headers?: string[]; tag?: string } = {}): string {
  const tag = input.tag ?? 'a';
  return [
    'From: Sam Example <sam@example.invalid>',
    'To: Alex Example <alex@example.invalid>',
    `Subject: ${input.subject ?? `Synthetic ${tag} note ${index}`}`,
    `Date: Mon, ${String(5 + index).padStart(2, '0')} Jan 2015 10:00:00 +0000`,
    `Message-ID: <${tag}-${index}@example.invalid>`,
    ...(input.headers ?? []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body ?? `The synthetic ${tag} harbour log, entry ${index}.`,
  ].join('\n');
}

function mbox(messages: readonly string[]): string {
  return messages.map((message) => `From sender@example.invalid Mon Jan  5 10:00:00 2015\n${message}\n\n`).join('');
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-lifecycle-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const env = { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const exports = join(base, 'exports');
  mkdirSync(exports);
  const waitingQuestionsDbPath = join(base, 'waiting-private-questions.sqlite');
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath,
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  const start = (name: string, text: string): string => {
    const path = join(exports, name);
    writeFileSync(path, text);
    const started = runtime.start(path);
    if (started.kind !== 'started') throw new Error(`expected a start, got ${started.kind}`);
    return started.archive.archive_id;
  };
  return { base, env, exports, runtime, waitingQuestionsDbPath, start };
}

function pull(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  return pullArchiveImport({ state: runtime.state, lane: runtime.lane('email'), archiveId, ...options });
}

async function importAll(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  for (let pass = 0; pass < 50; pass += 1) {
    const outcome = await pull(runtime, archiveId, options);
    if (!outcome.continueSoon) return outcome;
  }
  throw new Error('the import did not finish');
}

/** Distinct items each archive holds across its family's stores. */
function itemsByArchive(env: Record<string, string>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const path of archiveConnectorStoreDbPaths(['email'], env)) {
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

function storedRows(env: Record<string, string>, scope: string): Array<{ corpusId: string; identity: { provider: string; accountScope: string; providerItemId: string } }> {
  const rows: Array<{ corpusId: string; identity: { provider: string; accountScope: string; providerItemId: string } }> = [];
  for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
    const path = archiveConnectorStoreDbPath(domain, 'email', env);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const found = db.query('SELECT provider, account_scope, provider_item_id FROM items WHERE account_scope = ?').all(scope) as Array<{ provider: string; account_scope: string; provider_item_id: string }>;
      for (const row of found) {
        rows.push({
          corpusId: archiveCorpusId(domain, 'email'),
          identity: { provider: row.provider, accountScope: row.account_scope, providerItemId: row.provider_item_id },
        });
      }
    } finally {
      db.close();
    }
  }
  return rows;
}

/** The real connector, with `action` run once the first page is out and before the next is read. */
function afterFirstPage(action: () => void): (formatId: string) => ArchiveConnectorFactory {
  return () => (input) => {
    const real = createMboxArchiveConnector(input);
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

/** The real connector, with `action` run once its last page was taken in, while the pass finishes indexing it. */
function afterLastPage(action: () => void): (formatId: string) => ArchiveConnectorFactory {
  return () => (input) => {
    const real = createMboxArchiveConnector(input);
    const connector: SourceConnector = {
      ...real,
      listItems(options) {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          let last = false;
          try {
            for await (const page of real.listItems(options)) {
              last = page.done;
              yield page;
            }
          } finally {
            if (last) action();
          }
        })();
      },
    };
    return connector;
  };
}

function dyingAfterFirstPage(): (formatId: string) => ArchiveConnectorFactory {
  return () => (input) => {
    const real = createMboxArchiveConnector(input);
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

describe('archive import passes', () => {
  test('bounded passes resume after a crash, store each message once, and count each finding once', async () => {
    const f = fixture();
    const messages = Array.from({ length: 7 }, (_, index) => index === 1
      ? mail(index, { headers: ['X-Gmail-Labels: Spam'] })
      : mail(index));
    const archiveId = f.start('Inbox.mbox', mbox(messages));

    await expect(pull(f.runtime, archiveId, { pageSize: 2, connectorFactory: dyingAfterFirstPage() }))
      .rejects.toThrow('synthetic crash');
    expect(f.runtime.state.get(archiveId)?.status).toBe('importing');

    const first = await pull(f.runtime, archiveId, { pageSize: 2, maxItems: 3 });
    expect(first.continueSoon).toBe(true);
    expect(first.receipt.counts.traversal_complete).toBe(0);

    const last = await importAll(f.runtime, archiveId, { pageSize: 2, maxItems: 3 });
    expect(last.receipt.counts.traversal_complete).toBe(1);
    expect(last.receipt.policy).toEqual({ counts_only: true, raw_source_exposed: false, source_text_returned: false });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.completed_at).toBeString();
    expect(record.findings.skipped).toEqual({ spam_or_trash: 1 });
    expect(record.findings.gaps).toEqual({});
    expect(record.date_range).toEqual({ earliest: '2015-01-05T10:00:00.000Z', latest: '2015-01-11T10:00:00.000Z' });
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(6);

    // A finished import has nothing more to do.
    const again = await pull(f.runtime, archiveId);
    expect(again.continueSoon).toBe(false);
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(6);
  });

  test('a file that changed or went missing stops the import and says which', async () => {
    const f = fixture();
    const changing = f.start('Changing.mbox', mbox([mail(0), mail(1), mail(2)]));
    expect((await pull(f.runtime, changing, { pageSize: 1, maxItems: 1 })).continueSoon).toBe(true);
    appendFileSync(join(f.exports, 'Changing.mbox'), mbox([mail(3)]));
    const stopped = await pull(f.runtime, changing);
    expect(stopped.continueSoon).toBe(false);
    expect(stopped.receipt.counts.import_stopped).toBe(1);
    expect(stopped.receipt.warnings).toEqual(['archive_import_stopped']);
    expect(f.runtime.state.get(changing)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: 'Changing.mbox' } });

    const vanishing = f.start('Vanishing.mbox', mbox([mail(0, { tag: 'v' })]));
    unlinkSync(join(f.exports, 'Vanishing.mbox'));
    await pull(f.runtime, vanishing);
    expect(f.runtime.state.get(vanishing)).toMatchObject({ status: 'stopped', stop: { code: 'file_missing', rel_path: 'Vanishing.mbox' } });

    // A stopped archive gets no import task.
    expect(createArchiveImportsSchedulerSource({ runtime: f.runtime, config: defaultConfig() })).toBeUndefined();
  });

  test('a file replaced after the first page stops the import, though its messages were already read', async () => {
    const f = fixture();
    const text = mbox([mail(0, { tag: 'r' }), mail(1, { tag: 'r' }), mail(2, { tag: 'r' })]);
    const replaced = f.start('Replaced.mbox', text);
    const path = join(f.exports, 'Replaced.mbox');
    const outcome = await pull(f.runtime, replaced, {
      pageSize: 1,
      connectorFactory: afterFirstPage(() => {
        // The same bytes under a new file: only the name says it is not the file approved.
        writeFileSync(`${path}.new`, text);
        renameSync(`${path}.new`, path);
      }),
    });
    expect(outcome.receipt.counts.import_stopped).toBe(1);
    expect(f.runtime.state.get(replaced)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: 'Replaced.mbox' } });
  });

  test('a file changed or removed while the last page is indexed stops the import instead of completing it', async () => {
    const f = fixture();
    const changing = f.start('Late.mbox', mbox([mail(0, { tag: 'late' }), mail(1, { tag: 'late' })]));
    await pull(f.runtime, changing, {
      connectorFactory: afterLastPage(() => appendFileSync(join(f.exports, 'Late.mbox'), mbox([mail(2, { tag: 'late' })]))),
    });
    expect(f.runtime.state.get(changing)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: 'Late.mbox' } });

    const vanishing = f.start('Gone.mbox', mbox([mail(0, { tag: 'gone' })]));
    const outcome = await pull(f.runtime, vanishing, {
      connectorFactory: afterLastPage(() => unlinkSync(join(f.exports, 'Gone.mbox'))),
    });
    expect(outcome.receipt.counts.import_stopped).toBe(1);
    expect(f.runtime.state.get(vanishing)).toMatchObject({ status: 'stopped', stop: { code: 'file_missing', rel_path: 'Gone.mbox' } });
  });

  test('a removal asked for while a pass reads is not undone when the pass stops', async () => {
    const f = fixture();
    const archiveId = f.start('Removing.mbox', mbox([mail(0, { tag: 'm' }), mail(1, { tag: 'm' }), mail(2, { tag: 'm' })]));
    await pull(f.runtime, archiveId, {
      pageSize: 1,
      connectorFactory: afterFirstPage(() => {
        requestArchiveRemoval(f.runtime.state, archiveId);
        appendFileSync(join(f.exports, 'Removing.mbox'), mbox([mail(3, { tag: 'm' })]));
      }),
    });
    expect(f.runtime.state.get(archiveId)?.status).toBe('removing');
    // So the removal still runs, and takes it.
    let removal = await runArchiveRemoval({ state: f.runtime.state, lane: f.runtime.lane('email'), archiveId });
    for (let run = 0; run < 20 && removal.kind === 'progress'; run += 1) {
      removal = await runArchiveRemoval({ state: f.runtime.state, lane: f.runtime.lane('email'), archiveId });
    }
    expect(removal.kind).toBe('removed');
    expect(itemsByArchive(f.env).has(archiveId)).toBe(false);
  });

  test('a completed import keeps each file SHA-256: a copy is already imported, an export sharing only its ends is not', async () => {
    const f = fixture();
    const text = mbox([mail(0, { tag: 'big', body: 'x'.repeat(3 * 1024 * 1024) })]);
    const archiveId = f.start('Big.mbox', text);
    await importAll(f.runtime, archiveId);
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.files[0]!.sha256).toBe(createHash('sha256').update(text).digest('hex'));

    // The same size and the same first and last MiB, one byte apart in the middle.
    const middle = Math.floor(text.length / 2);
    writeFileSync(join(f.exports, 'Twin.mbox'), `${text.slice(0, middle)}y${text.slice(middle + 1)}`);
    expect(f.runtime.start(join(f.exports, 'Twin.mbox')).kind).toBe('started');

    mkdirSync(join(f.base, 'elsewhere'));
    copyFileSync(join(f.exports, 'Big.mbox'), join(f.base, 'elsewhere', 'Big copy.mbox'));
    const copy = f.runtime.start(join(f.base, 'elsewhere', 'Big copy.mbox'));
    expect(copy.kind).toBe('already_imported');
    if (copy.kind === 'already_imported') expect(copy.archive.archive_id).toBe(archiveId);
  });

  test('two archives keep their own resume points', async () => {
    const f = fixture();
    const first = f.start('First.mbox', mbox(Array.from({ length: 5 }, (_, index) => mail(index, { tag: 'first' }))));
    const second = f.start('Second.mbox', mbox(Array.from({ length: 4 }, (_, index) => mail(index, { tag: 'second' }))));
    let firstDone = false;
    let secondDone = false;
    for (let round = 0; round < 10 && !(firstDone && secondDone); round += 1) {
      if (!firstDone) firstDone = !(await pull(f.runtime, first, { pageSize: 2, maxItems: 2 })).continueSoon;
      if (!secondDone) secondDone = !(await pull(f.runtime, second, { pageSize: 2, maxItems: 2 })).continueSoon;
    }
    expect([firstDone, secondDone]).toEqual([true, true]);
    const items = itemsByArchive(f.env);
    expect(items.get(first)?.size).toBe(5);
    expect(items.get(second)?.size).toBe(4);
    const set = f.runtime.lane('email').set;
    const firstCursor = set.committedCursor(archiveConnectorId(first))?.cursor;
    const secondCursor = set.committedCursor(archiveConnectorId(second))?.cursor;
    expect(firstCursor).toEndWith(':done');
    expect(secondCursor).toEndWith(':done');
    expect(firstCursor).not.toBe(secondCursor);
  });

  // The private model is stopped here: no judge runs, so every item stays held.
  test('with the private model stopped, an import puts no content in the Personal or Public stores and embeds nothing there', async () => {
    const f = fixture();
    const archiveId = f.start('Inbox.mbox', mbox(Array.from({ length: 3 }, (_, index) => mail(index))));
    await importAll(f.runtime, archiveId);
    expect(itemsByArchive(f.env).get(archiveId)?.size).toBe(3);
    // The content is all in the Private store, waiting for the judge.
    const secure = new Database(archiveConnectorStoreDbPath('secure_local', 'email', f.env), { readonly: true });
    try {
      const held = secure.query(`
        SELECT COUNT(DISTINCT i.item_pk) AS n FROM chunks c JOIN items i ON i.item_pk = c.item_pk
        WHERE i.account_scope = ? AND c.bounded_text LIKE '%harbour log%'
      `).get(archiveId) as { n: number };
      expect(held.n).toBe(3);
    } finally {
      secure.close();
    }
    for (const domain of ['internal', 'public_safe'] as const) {
      const path = archiveConnectorStoreDbPath(domain, 'email', f.env);
      if (!existsSync(path)) continue;
      const db = new Database(path, { readonly: true });
      try {
        const chunks = db.query(`
          SELECT c.bounded_text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?
        `).all(archiveId) as Array<{ text: string }>;
        expect(chunks.filter((chunk) => chunk.text.includes('harbour log'))).toEqual([]);
        expect((db.query('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    }
  });
});

describe('removing an archive', () => {
  test('takes everything derived from it, hidden first, and nothing of the other archive', async () => {
    const f = fixture();
    const removed = f.start('Removed.mbox', mbox(Array.from({ length: 5 }, (_, index) => mail(index, { tag: 'removed' }))));
    const kept = f.start('Kept.mbox', mbox(Array.from({ length: 4 }, (_, index) => mail(index, { tag: 'kept' }))));
    await importAll(f.runtime, removed);
    await importAll(f.runtime, kept);
    const lane = f.runtime.lane('email');
    expect(lane.ledger.accountScopeCounts('mbox', removed).items).toBe(5);
    expect(lane.ledger.accountScopeCounts('mbox', kept).items).toBe(4);

    // Side stores, seeded for both archives.
    const snifferPath = tierSnifferPathForLedger(lane.ledger.dbPath);
    const sniffer = new TierSnifferStore({ dbPath: snifferPath });
    for (const accountScope of [removed, kept]) {
      sniffer.enqueue({ subject: { provider: 'mbox', accountScope, providerItemId: 'judge-me' }, pass: 'content', material: 'synthetic', mapRevision: 'r1', flags: [] });
    }
    sniffer.close();
    for (const accountScope of [removed, kept]) {
      lane.secretLocations!.record({ identity: { provider: 'mbox', accountScope, providerItemId: 'secret-item' }, findingKinds: ['synthetic_key'] });
    }
    const inbox = openWaitingPrivateQuestionStore(f.waitingQuestionsDbPath);
    const answerReading = (accountScope: string, corpusId = archiveCorpusId('secure_local', 'email')): StoredPrivateAnswer => ({
      status: 'answered', answer: 'SYNTHETIC', citations: [], unanswered: [], leftOut: [],
      read: [{ corpusId, trustDomain: 'secure_local', provenance: { sourceItem: { family: 'email', provider: 'mbox', accountScope, providerItemId: 'x' } } }],
    });
    const ask = (question: string, answer: StoredPrivateAnswer) => {
      const ref = inbox.record(inbox.ticket('synthetic-agent'), { question, state: 'waiting', surface: 'remote' })!;
      expect(inbox.saveAnswer(ref, answer)).toBe(true);
      return ref.id;
    };
    const removedAnswer = ask('From the removed archive?', answerReading(removed));
    const keptAnswer = ask('From the kept archive?', answerReading(kept));
    const otherAnswer = ask('From another source?', answerReading('someone', 'secure_local.synthetic.other'));
    // Still waiting: it has read nothing yet, so nothing ties it to the archive.
    const pending = inbox.record(inbox.ticket('synthetic-agent'), { question: 'Not answered yet?', state: 'waiting', surface: 'remote' })!.id;

    requestArchiveRemoval(f.runtime.state, removed);
    // The archive's own pass stops importing it from here on.
    expect((await pull(f.runtime, removed)).continueSoon).toBe(false);

    const step = await runArchiveRemoval({
      state: f.runtime.state,
      lane,
      archiveId: removed,
      openWaitingQuestions: () => f.runtime.openWaitingQuestions(),
      stepItems: 1,
      stepsPerRun: 2,
    });
    expect(step.kind).toBe('progress');
    // Rows still stored are no longer served: every copy is superseded.
    const remaining = storedRows(f.env, removed);
    expect(remaining.length).toBeGreaterThan(0);
    const copies = lane.ledger.copiesForMany(remaining.map((row) => row.identity));
    for (const row of remaining) {
      const forItem = copies.get(tierLedgerIdentityKey(row.identity));
      // Copies are there (an item without any would be served as before tiers), none current.
      expect(forItem?.length ?? 0).toBeGreaterThan(0);
      expect(tierRowVisible(forItem, row.corpusId, 'metadata') || tierRowVisible(forItem, row.corpusId, 'content')).toBe(false);
    }
    const keptRows = storedRows(f.env, kept);
    const keptCopies = lane.ledger.copiesForMany(keptRows.map((row) => row.identity));
    for (const row of keptRows) {
      const forItem = keptCopies.get(tierLedgerIdentityKey(row.identity));
      expect(tierRowVisible(forItem, row.corpusId, 'metadata') || tierRowVisible(forItem, row.corpusId, 'content')).toBe(true);
    }
    expect(lane.ledger.accountScopeCounts('mbox', removed).items).toBe(0);

    let outcome = step;
    for (let run = 0; run < 20 && outcome.kind === 'progress'; run += 1) {
      outcome = await runArchiveRemoval({
        state: f.runtime.state,
        lane,
        archiveId: removed,
        openWaitingQuestions: () => f.runtime.openWaitingQuestions(),
        stepItems: 1,
        stepsPerRun: 2,
      });
    }
    expect(outcome.kind).toBe('removed');

    const items = itemsByArchive(f.env);
    expect(items.has(removed)).toBe(false);
    expect(items.get(kept)?.size).toBe(4);
    expect(lane.ledger.accountScopeCounts('mbox', kept).items).toBe(4);
    expect(lane.set.committedCursor(archiveConnectorId(removed))).toBeUndefined();
    expect(lane.set.committedCursor(archiveConnectorId(kept))?.cursor).toEndWith(':done');
    expect(f.runtime.state.list().map((record) => record.archive_id)).toEqual([kept]);

    const judged = new TierSnifferStore({ dbPath: snifferPath, readOnly: true });
    expect(judged.listQuestions().map((question) => question.accountScope)).toEqual([kept]);
    judged.close();
    expect(lane.secretLocations!.get({ provider: 'mbox', accountScope: removed, providerItemId: 'secret-item' })).toBeUndefined();
    expect(lane.secretLocations!.get({ provider: 'mbox', accountScope: kept, providerItemId: 'secret-item' })).toBeDefined();
    expect(inbox.get(removedAnswer)).toBeUndefined();
    expect(inbox.get(keptAnswer)).toBeDefined();
    expect(inbox.get(otherAnswer)).toBeDefined();
    expect(inbox.get(pending)).toMatchObject({ question: 'Not answered yet?', state: 'waiting' });
    inbox.close();

    // The chosen file is never touched, and a removal that finished has nothing left to do.
    expect(existsSync(join(f.exports, 'Removed.mbox'))).toBe(true);
    expect((await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: removed })).kind).toBe('not_removing');
  });
});

describe('deleting another source', () => {
  test('keeps the inbox answers that read imported archives', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-other-delete-')));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir);
    const env = { [REMOTE_CONNECTIONS_DB_PATH_ENV]: join(dir, 'remote-connections.sqlite') };
    const inboxPath = waitingPrivateQuestionsDbPath(env[REMOTE_CONNECTIONS_DB_PATH_ENV]);
    const inbox = openWaitingPrivateQuestionStore(inboxPath);
    const ask = (question: string, provider: string, accountScope: string, corpusId: string) => {
      const ref = inbox.record(inbox.ticket('synthetic-agent'), { question, state: 'waiting', surface: 'remote' })!;
      expect(inbox.saveAnswer(ref, {
        status: 'answered', answer: 'SYNTHETIC', citations: [], unanswered: [], leftOut: [],
        read: [{ corpusId, trustDomain: 'secure_local', provenance: { sourceItem: { family: 'email', provider, accountScope, providerItemId: 'x' } } }],
      })).toBe(true);
      return ref.id;
    };
    const firstArchive = ask('From the first archive?', 'mbox', 'archive-one', archiveCorpusId('secure_local', 'email'));
    const secondArchive = ask('From the second archive?', 'mbox', 'archive-two', archiveCorpusId('internal', 'email'));
    const gmail = ask('From Gmail?', 'gmail', 'someone@example.invalid', 'secure_local.email.private');
    inbox.close();

    deleteOlympusData({ sourceId: 'gmail.email', homeDir, env });

    const after = openWaitingPrivateQuestionStore(inboxPath);
    try {
      expect(after.get(gmail)).toBeUndefined();
      expect(after.get(firstArchive)).toBeDefined();
      expect(after.get(secondArchive)).toBeDefined();
    } finally {
      after.close();
    }
  });
});

describe('archive corpora in the registry', () => {
  test('the source runtime adds the archive stores; the shipped public roster does not have them', () => {
    const shipped = createSourceCorpusRegistry().list().map((corpus) => corpus.corpusId);
    expect(shipped.filter((corpusId) => corpusId.includes('.archive.'))).toEqual([]);
    const withArchives = createSourceCorpusRegistry(withArchiveImportCorpora());
    expect(withArchives.list().map((corpus) => corpus.corpusId)).toEqual([
      ...shipped,
      'secure_local.archive.email',
      'internal.archive.email',
      'public_safe.archive.email',
    ]);
    expect(withArchives.ids('sync').filter((corpusId) => corpusId.includes('.archive.'))).toEqual(['secure_local.archive.email']);
    for (const corpus of withArchives.list().filter((entry) => entry.sourceId === 'archive.imports')) {
      expect(corpus).toMatchObject({ provider: 'mbox', family: 'email', createdOnDemand: true });
    }
    // Added once, whatever the config already holds.
    expect(withArchiveImportCorpora(withArchiveImportCorpora()).corpora).toHaveLength(withArchives.list().length);
  });
});

describe('archive imports in the scheduler', () => {
  test('one task per archive importing or being removed, all on one key', async () => {
    const f = fixture();
    expect(createArchiveImportsSchedulerSource({ runtime: f.runtime, config: defaultConfig() })).toBeUndefined();
    const importing = f.start('Importing.mbox', mbox([mail(0, { tag: 'i' }), mail(1, { tag: 'i' })]));
    const finished = f.start('Finished.mbox', mbox([mail(0, { tag: 'f' })]));
    await importAll(f.runtime, finished);

    const source = createArchiveImportsSchedulerSource({ runtime: f.runtime, config: defaultConfig() })!;
    expect(source.sourceId).toBe('archive.imports');
    expect(source.corpusId).toBe('secure_local.archive.email');
    expect(source.tasks.map((task) => [task.id, task.kind, task.concurrencyKey])).toEqual([
      [archiveImportTaskId(importing), 'sync', ARCHIVE_IMPORTS_CONCURRENCY_KEY],
    ]);
    expect(archiveImportTaskId(importing)).not.toBe(archiveImportTaskId(finished));
    const ran = await source.tasks[0]!.run();
    expect(ran.counts?.traversal_complete).toBe(1);
    expect(f.runtime.state.get(importing)?.status).toBe('imported');

    requestArchiveRemoval(f.runtime.state, finished);
    const removing = createArchiveImportsSchedulerSource({ runtime: f.runtime, config: defaultConfig() })!;
    expect(removing.tasks.map((task) => task.id)).toEqual([archiveImportTaskId(finished)]);
    const removal = await removing.tasks[0]!.run();
    expect(removal.counts?.removal_complete).toBe(1);
    expect(f.runtime.state.get(finished)).toBeUndefined();
    expect(itemsByArchive(f.env).get(importing)?.size).toBe(2);
  });
});
