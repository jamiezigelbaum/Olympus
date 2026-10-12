// Waiting private questions (design docs/design/background-agents.md, A):
// the store's bounds, dedupe, expiry, dismiss and marker; the revocation
// generation that refuses an insert in flight; the acknowledgment compare;
// and that it survives a restart (a reopen).

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      surface: 'chatgpt',
      question: 'What did the June lab report say?',
      detail: 'full',
      selectors: { corpus_ids: ['secure_local.dropbox.files'], query: 'june lab' },
      state: 'waiting',
      seen: false,
      generation: 1,
      askedAt: new Date(1_000_000).toISOString(),
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
    });
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
  test('20 per connection: the oldest is dropped and the marker persists', () => {
    const { store, clock, path } = open();
    for (let index = 0; index < 21; index += 1) {
      clock.now += 1_000;
      store.record(store.ticket(CONN_A), { question: `question ${index}`, surface: 'chatgpt', state: 'waiting' });
    }
    const listed = store.list();
    expect(listed.questions).toHaveLength(20);
    expect(listed.questions.map((q) => q.question)).not.toContain('question 0');
    expect(listed.olderRemoved).toBe(true);
    store.close();
    // Persisted: a reopen (a restart) still shows the line.
    const reopened = openWaitingPrivateQuestionStore(path, { now: () => clock.now });
    stores.push(reopened);
    expect(reopened.list().olderRemoved).toBe(true);
    // Dismiss all clears it.
    expect(reopened.dismissAll()).toBe(20);
    expect(reopened.list()).toEqual({ questions: [], olderRemoved: false });
  });

  test('50 in all across connections, oldest first', () => {
    const { store, clock } = open();
    for (let index = 0; index < 55; index += 1) {
      clock.now += 1_000;
      const connection = (index % 5).toString(16).repeat(18);
      store.record(store.ticket(connection), { question: `question ${index}`, surface: 'remote', state: 'waiting' });
    }
    const listed = store.list();
    expect(listed.questions).toHaveLength(50);
    expect(listed.questions.map((q) => q.question)).not.toContain('question 4');
    expect(listed.questions.map((q) => q.question)).toContain('question 5');
    expect(listed.olderRemoved).toBe(true);
  });

  test('256 KB in all: large records push the oldest out', () => {
    const { store, clock } = open();
    let bytes = 0;
    for (let index = 0; index < 50; index += 1) {
      clock.now += 1_000;
      const connection = (index % 5).toString(16).repeat(18);
      const question = `${index} ${'q'.repeat(2_000)}`;
      store.record(store.ticket(connection), { question, surface: 'remote', state: 'waiting', selectors: { query: 's'.repeat(3_900) } });
      bytes += question.length + 3_900;
    }
    expect(bytes).toBeGreaterThan(WAITING_QUESTION_LIMITS.totalBytes);
    const listed = store.list();
    expect(listed.questions.length).toBeLessThan(50);
    const total = listed.questions.reduce((sum, q) => sum + q.question.length + JSON.stringify(q.selectors).length + 160, 0);
    expect(total).toBeLessThanOrEqual(WAITING_QUESTION_LIMITS.totalBytes);
    expect(listed.questions[0]!.question.startsWith('49 ')).toBe(true);
    expect(listed.olderRemoved).toBe(true);
  });

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

  test('the race across two processes: a store opened separately (the CLI) revokes while the worker\'s insert is in flight', () => {
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
