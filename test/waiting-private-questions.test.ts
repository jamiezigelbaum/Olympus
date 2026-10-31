// Waiting private questions (design docs/design/background-agents.md, A):
// the store's bounds, dedupe, expiry, dismiss and marker; the revocation
// generation that refuses an insert in flight; the acknowledgment compare;
// and that it survives a restart (a reopen).

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import {
  normalizeWaitingSelectors,
  openWaitingPrivateQuestionStore,
  waitingPrivateQuestionsDbPath,
  WAITING_QUESTION_LIMITS,
  type WaitingQuestionStore,
} from '../src/core/waiting-private-questions.ts';

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-waiting-'));
  roots.push(root);
  return join(root, 'olympus');
}

function open(path = join(dir(), 'waiting-private-questions.sqlite'), clock = { now: 1_000_000 }): { store: WaitingQuestionStore; clock: { now: number }; path: string } {
  const store = openWaitingPrivateQuestionStore(path, { now: () => clock.now });
  stores.push(store);
  return { store, clock, path };
}

const CONN_A = 'a'.repeat(18);
const CONN_B = 'b'.repeat(18);

describe('waiting private questions: what is stored', () => {
  test('a record keeps the question, connection, surface, detail, selectors, state, generation and time; nothing else', () => {
    const { store, path } = open();
    const ref = store.record(store.ticket(CONN_A), {
      question: '  What did the June lab report say?  ',
      surface: 'chatgpt',
      state: 'waiting',
      detail: 'full',
      selectors: { query: 'june lab', corpus_ids: ['secure_local.dropbox.files'] },
    });
    expect(ref).toEqual({ id: expect.any(String), generation: 1, connectionId: CONN_A });
    const { questions, olderRemoved } = store.list();
    expect(olderRemoved).toBe(false);
    expect(questions).toEqual([{
      id: ref!.id,
      connectionId: CONN_A,
      path: 'private',
      surface: 'chatgpt',
      question: 'What did the June lab report say?',
      detail: 'full',
      selectors: { corpus_ids: ['secure_local.dropbox.files'], query: 'june lab' },
      state: 'waiting',
      seen: false,
      generation: 1,
      askedAt: new Date(1_000_000).toISOString(),
      attempts: 0, nextAttemptAt: 0,
    }]);
    // Owner-only file in an owner-only directory, like the Private stores.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
  });

  test('selectors are kept field by field; anything else is dropped, and a malformed one records nothing', () => {
    expect(normalizeWaitingSelectors({
      question: 'q',
      query: ' lab ',
      corpus_id: 'b.two',
      corpus_ids: ['a.one', 'b.two'],
      account: 'me@example.com',
      authored_after: '2026-06-01',
      include_secure_local: true,
      analyst_model: 'x',
      max_results: 4,
      selected_items: [{ corpus_id: 'a.one', provider: 'dropbox', local_item_id: 'x', extra: 'dropped' }],
    })).toEqual({
      query: 'lab',
      account: 'me@example.com',
      authored_after: '2026-06-01',
      corpus_ids: ['a.one', 'b.two'],
      selected_items: [{ corpus_id: 'a.one', provider: 'dropbox', local_item_id: 'x' }],
      retrieval_mode: 'hybrid',
    });
    // The effective retrieval mode: the request's own, else the answer's hybrid default.
    expect(normalizeWaitingSelectors({ query: 'q', retrieval_mode: 'keyword' })).toEqual({ query: 'q', retrieval_mode: 'keyword' });
    expect(normalizeWaitingSelectors({})).toEqual({ retrieval_mode: 'hybrid' });
    expect(normalizeWaitingSelectors({ retrieval_mode: 'semantic' })).toBeUndefined();
    expect(normalizeWaitingSelectors({ query: 4 })).toBeUndefined();
    expect(normalizeWaitingSelectors({ corpus_ids: 'a.one' })).toBeUndefined();
    expect(normalizeWaitingSelectors({ selected_items: [{ provider: 7 }] })).toBeUndefined();
  });

  test('a question over 2 KB, or selectors over their bound, is not recorded (no silent widening)', () => {
    const { store } = open();
    const ticket = store.ticket(CONN_A);
    expect(store.record(ticket, { question: 'x'.repeat(WAITING_QUESTION_LIMITS.questionBytes + 1), surface: 'chatgpt', state: 'waiting' })).toBeUndefined();
    // Multi-byte characters count in bytes.
    expect(store.record(ticket, { question: 'é'.repeat(1_025), surface: 'chatgpt', state: 'waiting' })).toBeUndefined();
    expect(store.record(ticket, { question: 'ok', surface: 'remote', state: 'waiting', selectors: { query: 'q'.repeat(WAITING_QUESTION_LIMITS.selectorBytes) } })).toBeUndefined();
    expect(store.list().questions).toHaveLength(0);
    expect(store.record(ticket, { question: 'x'.repeat(WAITING_QUESTION_LIMITS.questionBytes), surface: 'chatgpt', state: 'waiting' })).toBeDefined();
  });
});

describe('waiting private questions: dedupe', () => {
  test('a duplicate (case and spacing aside) refreshes the time, keeps the fuller detail and bumps the generation', () => {
    const { store, clock } = open();
    const first = store.record(store.ticket(CONN_A), { question: 'What did the June report say?', surface: 'chatgpt', state: 'unchecked', detail: 'full' })!;
    store.markSeen([first.id]);
    clock.now += 60_000;
    const second = store.record(store.ticket(CONN_A), { question: 'what  did the JUNE report say?', surface: 'chatgpt', state: 'waiting', detail: 'summary' })!;
    expect(second).toEqual({ id: first.id, generation: 2, connectionId: CONN_A });
    const [question] = store.list().questions;
    expect(question).toMatchObject({ id: first.id, detail: 'full', state: 'waiting', seen: false, generation: 2, askedAt: new Date(clock.now).toISOString() });
    // A match is not downgraded by a later probe that could not tell.
    store.record(store.ticket(CONN_A), { question: 'What did the June report say?', surface: 'chatgpt', state: 'unchecked' });
    expect(store.list().questions[0]).toMatchObject({ state: 'waiting', generation: 3 });
  });

  test('another connection or other selectors are another question', () => {
    const { store } = open();
    store.record(store.ticket(CONN_A), { question: 'q', surface: 'chatgpt', state: 'waiting' });
    store.record(store.ticket(CONN_B), { question: 'q', surface: 'remote', state: 'waiting' });
    store.record(store.ticket(CONN_B), { question: 'q', surface: 'remote', state: 'waiting', selectors: { account: 'work' } });
    expect(store.list().questions).toHaveLength(3);
  });
});

describe('waiting private questions: bounds, expiry and dismiss', () => {

  test('7 days: an expired question is gone, silently', () => {
    const { store, clock } = open();
    store.record(store.ticket(CONN_A), { question: 'old', surface: 'chatgpt', state: 'waiting' });
    clock.now += WAITING_QUESTION_LIMITS.ttlMs - 1;
    expect(store.list().questions).toHaveLength(1);
    clock.now += 1;
    expect(store.list()).toEqual({ questions: [], olderRemoved: false });
  });

  test('dismiss removes one; the same question asked again comes back as new', () => {
    const { store } = open();
    const ref = store.record(store.ticket(CONN_A), { question: 'q', surface: 'chatgpt', state: 'waiting' })!;
    expect(store.dismiss(ref.id)).toBe(true);
    expect(store.dismiss(ref.id)).toBe(false);
    expect(store.list().questions).toHaveLength(0);
    const again = store.record(store.ticket(CONN_A), { question: 'q', surface: 'chatgpt', state: 'waiting' })!;
    expect(again.id).not.toBe(ref.id);
    expect(again.generation).toBe(1);
    expect(store.list().questions).toHaveLength(1);
  });

  test('an app retrying keeps the answer; a re-ask later is answered afresh', () => {
    // Live canary 2026-10-29: re-asks were handed yesterday's answers, made before the Secret fix.
    const { store, clock } = open();
    const ask = () => store.record(store.ticket(CONN_A), { question: 'Where is the Wi-Fi password?', surface: 'remote', state: 'waiting' })!;
    const first = ask();
    expect(store.saveAnswer(first, { status: 'answered', answer: 'Old reply', citations: [], read: [], leftOut: [], unanswered: [] })).toBe(true);
    clock.now += WAITING_QUESTION_LIMITS.reanswerAfterMs - 1;
    expect(ask()).toEqual(first);
    expect(store.list().questions[0]).toMatchObject({ generation: 1, answeredAt: expect.any(String) });
    clock.now += 1;
    const again = ask();
    expect(again).toEqual({ ...first, generation: 2 });
    expect(store.list().questions[0]).not.toHaveProperty('answeredAt');
  });

  test('mark seen', () => {
    const { store } = open();
    const ref = store.record(store.ticket(CONN_A), { question: 'q', surface: 'chatgpt', state: 'waiting' })!;
    expect(store.markSeen([ref.id, 'nope'])).toBe(1);
    expect(store.list().questions[0]!.seen).toBe(true);
    expect(store.markSeen([ref.id])).toBe(0);
  });
});

describe('waiting private questions: acknowledgment compare', () => {
  test('only the current generation of the same record and connection is cleared', () => {
    const { store } = open();
    const first = store.record(store.ticket(CONN_A), { question: 'q', surface: 'chatgpt', state: 'waiting' })!;
    const second = store.record(store.ticket(CONN_A), { question: 'q', surface: 'chatgpt', state: 'waiting' })!;
    // An older answer does not clear the newer duplicate.
    expect(store.acknowledge(first)).toBe(false);
    expect(store.acknowledge({ ...second, connectionId: CONN_B })).toBe(false);
    expect(store.list().questions).toHaveLength(1);
    expect(store.acknowledge(second)).toBe(true);
    expect(store.list().questions).toHaveLength(0);
    expect(store.acknowledge(second)).toBe(false);
  });

  test('an unchecked question settles at its generation only: a match waits, no match is removed', () => {
    const { store } = open();
    const a = store.record(store.ticket(CONN_A), { question: 'a', surface: 'remote', state: 'unchecked' })!;
    const b = store.record(store.ticket(CONN_A), { question: 'b', surface: 'remote', state: 'unchecked' })!;
    expect(store.unchecked().map((q) => q.question)).toEqual(['a', 'b']);
    expect(store.settleUnchecked(a, 'match')).toBe(true);
    expect(store.settleUnchecked(b, 'no_match')).toBe(true);
    expect(store.list().questions.map((q) => [q.question, q.state])).toEqual([['a', 'waiting']]);
    expect(store.settleUnchecked(a, 'no_match')).toBe(false);
  });
});

describe('waiting private questions: revocation', () => {
  test('revoking deletes the connection\'s records and refuses an insert that began before it', () => {
    const { store } = open();
    store.record(store.ticket(CONN_A), { question: 'a1', surface: 'remote', state: 'waiting' });
    store.record(store.ticket(CONN_B), { question: 'b1', surface: 'remote', state: 'waiting' });
    // A request for A begins (its ticket), then A is revoked mid-flight.
    const inFlight = store.ticket(CONN_A);
    expect(store.revokeConnection(CONN_A)).toBe(1);
    expect(store.record(inFlight, { question: 'a2', surface: 'remote', state: 'waiting' })).toBeUndefined();
    expect(store.list().questions.map((q) => q.question)).toEqual(['b1']);
  });

  test('two handles on one file (the CLI\'s and the worker\'s): a revocation while the worker\'s insert is in flight', () => {
    const { store: worker, path } = open();
    const cli = openWaitingPrivateQuestionStore(path);
    stores.push(cli);
    const inFlight = worker.ticket(CONN_A);
    cli.revokeConnection(CONN_A);
    expect(worker.record(inFlight, { question: 'q', surface: 'remote', state: 'waiting' })).toBeUndefined();
    // An insert committed before the revocation is deleted by it.
    const early = worker.ticket(CONN_B);
    worker.record(early, { question: 'q', surface: 'remote', state: 'waiting' });
    cli.revokeConnection(CONN_B);
    expect(worker.list().questions).toHaveLength(0);
  });

  test('the connection store\'s revoke removes that connection\'s waiting questions (its public result unchanged)', () => {
    const root = dir();
    const connections = openRemoteConnectionStore(join(root, 'remote-connections.sqlite'));
    stores.push(connections);
    const a = connections.create('Grok').connection;
    const b = connections.create('Muse').connection;
    const waiting = openWaitingPrivateQuestionStore(waitingPrivateQuestionsDbPath(connections.dbPath));
    stores.push(waiting);
    const inFlight = waiting.ticket(a.id);
    waiting.record(waiting.ticket(a.id), { question: 'a', surface: 'remote', state: 'waiting' });
    waiting.record(waiting.ticket(b.id), { question: 'b', surface: 'remote', state: 'waiting' });
    const revoked = connections.revoke(a.id);
    expect(revoked).toMatchObject({ id: a.id, displayName: 'Grok', kind: 'bearer', revokedAt: expect.any(String) });
    expect(waiting.list().questions.map((q) => q.question)).toEqual(['b']);
    expect(waiting.record(inFlight, { question: 'a again', surface: 'remote', state: 'waiting' })).toBeUndefined();
  });

  test('a recording for a connection the connection store does not vouch for is refused and cleans that connection up', () => {
    const active = new Set([CONN_A, CONN_B]);
    let readable = true;
    const path = join(dir(), 'waiting-private-questions.sqlite');
    const store = openWaitingPrivateQuestionStore(path, {
      isActive: (id) => {
        if (!readable) throw new Error('connection store unreadable');
        return active.has(id);
      },
    });
    stores.push(store);
    const ticket = store.ticket(CONN_A);
    store.record(ticket, { question: 'a', surface: 'remote', state: 'waiting' });
    store.record(store.ticket(CONN_B), { question: 'b', surface: 'remote', state: 'waiting' });
    // Unreadable: refused, and nothing is removed on a read failure.
    readable = false;
    expect(store.record(ticket, { question: 'a2', surface: 'remote', state: 'waiting' })).toBeUndefined();
    expect(store.list().questions.map((q) => q.question).sort()).toEqual(['a', 'b']);
    // Revoked elsewhere, its cleanup here lost: the ticket is still current, yet refused.
    readable = true;
    active.delete(CONN_A);
    expect(store.ticket(CONN_A)).toEqual(ticket);
    expect(store.record(ticket, { question: 'a3', surface: 'chatgpt', state: 'waiting' })).toBeUndefined();
    expect(store.list().questions.map((q) => q.question)).toEqual(['b']);
  });

  test('reconcile removes the questions of connections that are no longer active', () => {
    const { store } = open();
    store.record(store.ticket(CONN_A), { question: 'a', surface: 'remote', state: 'waiting' });
    store.record(store.ticket(CONN_B), { question: 'b', surface: 'remote', state: 'waiting' });
    expect(store.reconcileConnections((id) => id === CONN_B)).toBe(1);
    expect(store.list().questions.map((q) => q.question)).toEqual(['b']);
    expect(store.record(store.ticket(CONN_A), { question: 'a', surface: 'remote', state: 'waiting' })).toBeDefined();
  });
});

describe('waiting private questions: restart', () => {
  test('records persist across a reopen', () => {
    const { store, path, clock } = open();
    const ref = store.record(store.ticket(CONN_A), { question: 'kept', surface: 'chatgpt', state: 'waiting' })!;
    store.close();
    const reopened = openWaitingPrivateQuestionStore(path, { now: () => clock.now });
    stores.push(reopened);
    expect(reopened.list().questions).toEqual([expect.objectContaining({ id: ref.id, question: 'kept', generation: 1 })]);
    expect(reopened.acknowledge(ref)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No recoverable question text, and separate processes

const STORE_MODULE = join(import.meta.dir, '..', 'src', 'core', 'waiting-private-questions.ts');
const CONNECTIONS_MODULE = join(import.meta.dir, '..', 'src', 'core', 'remote-connections.ts');

/** Every file of the store (the database and any sidecar), as bytes. */
function storeFiles(path: string): Array<{ name: string; bytes: Buffer }> {
  const base = path.split('/').at(-1)!;
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(base))
    .map((name) => ({ name, bytes: readFileSync(join(dirname(path), name)) }));
}

function holds(path: string, marker: string): string[] {
  return storeFiles(path).filter((file) => file.bytes.includes(Buffer.from(marker))).map((file) => file.name);
}

/** A child script: a separate bun process, given the store path and arguments. */
function script(root: string, name: string, body: string): string {
  const file = join(root, `${name}.ts`);
  writeFileSync(file, body);
  return file;
}

async function run(file: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn([process.execPath, file, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, out };
}

describe('waiting private questions: deleted text does not linger', () => {
  test('a dismissed or acknowledged question is gone from the database and every sidecar, with the connection still open', () => {
    const { store, path, clock } = open();
    const reader = openWaitingPrivateQuestionStore(path, { now: () => clock.now });
    stores.push(reader);
    const dismissed = `dismissed-${crypto.randomUUID()}`;
    const acknowledged = `acknowledged-${crypto.randomUUID()}`;
    const kept = `kept-${crypto.randomUUID()}`;
    const first = store.record(store.ticket(CONN_A), { question: dismissed, surface: 'remote', state: 'waiting' })!;
    const second = store.record(store.ticket(CONN_A), { question: acknowledged, surface: 'chatgpt', state: 'waiting' })!;
    store.record(store.ticket(CONN_B), { question: kept, surface: 'remote', state: 'waiting' });
    expect(reader.list().questions).toHaveLength(3);
    expect(holds(path, dismissed)).toContain('waiting-private-questions.sqlite');
    expect(store.dismiss(first.id)).toBe(true);
    expect(store.acknowledge(second)).toBe(true);
    // Both connections still open: no WAL, no journal left, and the text zeroed in place.
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-journal`)).toBe(false);
    expect(holds(path, dismissed)).toEqual([]);
    expect(holds(path, acknowledged)).toEqual([]);
    expect(holds(path, kept)).toEqual(['waiting-private-questions.sqlite']);
    // Revocation and the bounds delete the same way.
    store.revokeConnection(CONN_B);
    expect(holds(path, kept)).toEqual([]);
  });

  test('after a crash mid-delete the delete never happened; the next delete leaves nothing behind', async () => {
    const root = dir();
    const path = join(root, 'waiting-private-questions.sqlite');
    const marker = `crash-${crypto.randomUUID()}`;
    const child = script(dirname(root), 'crash', `
      import { Database } from 'bun:sqlite';
      const { openWaitingPrivateQuestionStore } = await import(${JSON.stringify(STORE_MODULE)});
      const [path, marker, mode] = process.argv.slice(2);
      const store = openWaitingPrivateQuestionStore(path);
      store.record(store.ticket(${JSON.stringify(CONN_A)}), { question: marker, surface: 'remote', state: 'waiting' });
      if (mode === 'after-commit') {
        store.dismissAll();
      } else {
        // The worker dies inside the deleting transaction.
        const raw = new Database(path);
        raw.exec('PRAGMA secure_delete = ON; BEGIN IMMEDIATE; DELETE FROM waiting_questions;');
      }
      process.kill(process.pid, 'SIGKILL');
    `);
    const crashed = await run(child, path, marker, 'mid-delete');
    expect(crashed.code).not.toBe(0);
    // The hot journal holds the pre-delete page until the next open rolls it back.
    const reopened = openWaitingPrivateQuestionStore(path);
    stores.push(reopened);
    expect(reopened.list().questions.map((question) => question.question)).toEqual([marker]);
    expect(reopened.dismissAll()).toBe(1);
    expect(holds(path, marker)).toEqual([]);
    expect(storeFiles(path).map((file) => file.name)).toEqual(['waiting-private-questions.sqlite']);
    reopened.close();

    const after = `after-${crypto.randomUUID()}`;
    expect((await run(child, path, after, 'after-commit')).code).not.toBe(0);
    expect(holds(path, after)).toEqual([]);
    expect(storeFiles(path).map((file) => file.name)).toEqual(['waiting-private-questions.sqlite']);
  }, 30_000);
});

describe('waiting private questions: separate processes', () => {
  test('first open from several processes at once: one migration, every record kept', async () => {
    const root = dir();
    const path = join(root, 'waiting-private-questions.sqlite');
    const child = script(dirname(root), 'first-open', `
      const { openWaitingPrivateQuestionStore } = await import(${JSON.stringify(STORE_MODULE)});
      const [path, connection] = process.argv.slice(2);
      const store = openWaitingPrivateQuestionStore(path);
      const ref = store.record(store.ticket(connection), { question: 'from ' + connection, surface: 'remote', state: 'waiting' });
      store.close();
      console.log(ref ? 'recorded' : 'refused');
    `);
    const connections = ['c'.repeat(18), 'd'.repeat(18), 'e'.repeat(18), 'f'.repeat(18)];
    const results = await Promise.all(connections.map((connection) => run(child, path, connection)));
    expect(results.map((result) => [result.code, result.out.trim()])).toEqual(connections.map(() => [0, 'recorded']));
    const store = openWaitingPrivateQuestionStore(path);
    stores.push(store);
    expect(store.list().questions.map((question) => question.question).sort()).toEqual(connections.map((connection) => `from ${connection}`));
  }, 30_000);

  test('a revoke whose cleanup hits a held lock still revokes; recordings are refused at once and the worker cleans up after', async () => {
    const root = dir();
    const connectionsPath = join(root, 'remote-connections.sqlite');
    const connections = openRemoteConnectionStore(connectionsPath);
    stores.push(connections);
    const grok = connections.create('Grok').connection;
    const muse = connections.create('Muse').connection;
    const isActive = (id: string) => connections.list().some((connection) => connection.id === id && connection.revokedAt === null);
    const path = waitingPrivateQuestionsDbPath(connectionsPath);
    const worker = openWaitingPrivateQuestionStore(path, { isActive });
    stores.push(worker);
    const inFlight = worker.ticket(grok.id);
    worker.record(worker.ticket(grok.id), { question: 'grok question', surface: 'remote', state: 'waiting' });
    worker.record(worker.ticket(muse.id), { question: 'muse question', surface: 'remote', state: 'waiting' });

    const holder = Bun.spawn([process.execPath, script(dirname(root), 'hold', `
      import { Database } from 'bun:sqlite';
      const [path, ms] = process.argv.slice(2);
      const db = new Database(path);
      db.exec('BEGIN IMMEDIATE');
      db.run("INSERT INTO waiting_meta (key, value) VALUES ('held', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      console.log('locked');
      await Bun.sleep(Number(ms));
      db.exec('ROLLBACK');
      db.close();
    `), path, '3000'], { stdout: 'pipe', stderr: 'pipe' });
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');

    // The CLI revokes from its own process while the lock is held.
    const cli = await run(script(dirname(root), 'revoke', `
      const { openRemoteConnectionStore } = await import(${JSON.stringify(CONNECTIONS_MODULE)});
      const [path, id] = process.argv.slice(2);
      const store = openRemoteConnectionStore(path);
      const started = Date.now();
      const revoked = store.revoke(id);
      store.close();
      console.log(JSON.stringify({ revoked: revoked.revokedAt !== null, ms: Date.now() - started }));
    `), connectionsPath, grok.id);
    expect(cli.code).toBe(0);
    const outcome = JSON.parse(cli.out.trim().split('\n').at(-1)!) as { revoked: boolean; ms: number };
    expect(outcome.revoked).toBe(true);
    // Not held up by this store for long (its cleanup waits about a second).
    expect(outcome.ms).toBeLessThan(2_900);
    expect(await holder.exited).toBe(0);

    // The cleanup failed: the record is still there and the old ticket is still current here.
    expect(worker.list().questions.map((question) => question.question).sort()).toEqual(['grok question', 'muse question']);
    expect(worker.ticket(grok.id)).toEqual(inFlight);
    // The worker's reconcile (on open and on every re-check pass) retries the failed cleanup.
    expect(worker.reconcileConnections(isActive)).toBe(1);
    expect(worker.list().questions.map((question) => question.question)).toEqual(['muse question']);
    expect(worker.record(inFlight, { question: 'grok again', surface: 'remote', state: 'waiting' })).toBeUndefined();
    expect(worker.record(worker.ticket(grok.id), { question: 'grok later', surface: 'remote', state: 'waiting' })).toBeUndefined();
    expect(worker.record(worker.ticket(muse.id), { question: 'muse later', surface: 'remote', state: 'waiting' })).toBeDefined();
  }, 30_000);
});

test('v3 retained private answers migrate additively to v4 alongside anonymous answers', () => {
  const { store, path } = open();
  const ref = store.record(store.ticket(CONN_A), { question: 'Old private question', state: 'waiting', surface: 'remote' })!;
  store.saveAnswer(ref, { status: 'answered', answer: 'Old local reply', citations: [], read: [], leftOut: [], unanswered: [] });
  store.close();
  // Reconstruct the v3 shape an already-installed inbox has, preserving its data.
  const legacy = new Database(path);
  legacy.exec('ALTER TABLE waiting_questions DROP COLUMN answer_path; ALTER TABLE waiting_questions DROP COLUMN destination; ALTER TABLE waiting_questions DROP COLUMN retry_reasons');
  legacy.query('UPDATE schema_version SET version = 3 WHERE store_id = ?').run('waiting-private-questions');
  legacy.close();
  const upgraded = openWaitingPrivateQuestionStore(path); stores.push(upgraded);
  expect(upgraded.get(ref.id)).toMatchObject({ path: 'private', question: 'Old private question', result: { answer: 'Old local reply' } });
  const anonymous = upgraded.record(upgraded.ticket(CONN_A), { question: 'Sent outside', state: 'waiting', surface: 'remote', path: 'anonymous' })!;
  expect(upgraded.saveAnswer(anonymous, { status: 'answered', answer: 'Outside reply', citations: [], read: [], leftOut: [], unanswered: [] }, 'Exact sent text')).toBe(true);
  expect(upgraded.list().questions).toHaveLength(2);
});
