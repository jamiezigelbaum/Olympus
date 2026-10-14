import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHATGPT_INBOX_GRACE_MS,
  WAITING_QUESTION_LIMITS,
  openWaitingPrivateQuestionStore,
  type StoredPrivateAnswer,
  type WaitingQuestionInput,
  type WaitingQuestionStore,
} from '../src/core/waiting-private-questions.ts';
import { createLocalPrivateAnswers, type LocalPrivateAnswersOptions } from '../src/workers/email-source/local-private-answers.ts';
import { createLocalModelActivity, runBackgroundInference } from '../src/workers/answer-activity.ts';
import type { LocalAnswerResult } from '../src/workers/source-index/local-answer.ts';

const ANSWER = 'SYNTHETIC_INBOX_ANSWER: the example renewal is in May.';
const SOURCE_TEXT = 'SYNTHETIC_SOURCE_PASSAGE_MUST_NOT_PERSIST';
const identity = {
  corpusId: 'secure_local.synthetic.inbox', trustDomain: 'secure_local', trustTier: 'private',
  provenance: { sourceItem: { family: 'file', provider: 'synthetic', providerItemId: 'renewal' } },
};
function result(): Extract<LocalAnswerResult, { status: 'answered' }> {
  return { status: 'answered', answer: ANSWER, citations: [{ title: 'Synthetic renewal', url: 'https://example.invalid/renewal' }],
    unanswered: [], leftOut: [], read: [{ ...identity, text: SOURCE_TEXT, futurePrivateField: SOURCE_TEXT }] };
}
function stored(corpusId = identity.corpusId): StoredPrivateAnswer {
  return { ...result(), read: [{ ...identity, corpusId }] };
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-private-inbox-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse('2026-10-14T12:00:00Z');
  const dbPath = join(dir, 'data', 'waiting-private-questions.sqlite');
  const store = openWaitingPrivateQuestionStore(dbPath, { now: () => clock });
  cleanups.push(() => store.close());
  return { dir, dbPath, store, now: () => clock, advance: (ms: number) => { clock += ms; } };
}
function record(store: WaitingQuestionStore, input: Partial<WaitingQuestionInput> = {}, connection = 'synthetic-agent') {
  const ref = store.record(store.ticket(connection), { question: 'When is the synthetic renewal?', state: 'waiting', surface: 'remote', ...input });
  expect(ref).toBeDefined();
  return ref!;
}
function service(f: ReturnType<typeof fixture>, options: Partial<LocalPrivateAnswersOptions> = {}) {
  const api = createLocalPrivateAnswers({ store: () => f.store, now: f.now, answer: async () => result(),
    eligible: async items => items.map(() => true), ...options });
  cleanups.push(() => api.close());
  return api;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('private inbox automatic answering', () => {
  test('start answers recorded remote matches without a click and later records wake it', async () => {
    const f = fixture();
    const first = record(f.store, { detail: 'full', selectors: { corpus_ids: [identity.corpusId], query: 'synthetic renewal' } });
    const inputs: unknown[] = [];
    const api = service(f, { answer: async input => { inputs.push(input); return result(); } });
    expect(api.waitingCount()).toBe(0);
    api.start();
    await until(() => !!f.store.get(first.id)?.result);
    expect(inputs[0]).toMatchObject({ question: 'When is the synthetic renewal?', detail: 'full', selectors: { corpus_ids: [identity.corpusId], query: 'synthetic renewal' } });
    expect(api.waitingCount()).toBe(1);
    const next = record(f.store, { question: 'A second synthetic question' });
    await until(() => !!f.store.get(next.id)?.result);
    expect(api.waitingCount()).toBe(2);
    expect((await api.handle({ action: 'seen', id: first.id, generation: first.generation }, 'owner')).body.status).toBe('read');
    expect(api.waitingCount()).toBe(1);
    expect(f.store.get(first.id)?.result?.answer).toBe(ANSWER);
  });

  test('unchecked questions wait for a match verdict, which wakes the service', async () => {
    const f = fixture();
    const ref = record(f.store, { state: 'unchecked' });
    let calls = 0;
    const api = service(f, { answer: async () => { calls++; return result(); } });
    api.start();
    await api.tick();
    expect(calls).toBe(0);
    expect(api.waiting()?.questions[0]?.state).toBe('unchecked');
    expect(f.store.settleUnchecked(ref, 'match')).toBe(true);
    await until(() => !!f.store.get(ref.id)?.result);
    expect(calls).toBe(1);
  });

  test('ChatGPT is hidden for thirty seconds then automatically stored and visible', async () => {
    const f = fixture();
    const ref = record(f.store, { surface: 'chatgpt' });
    let calls = 0;
    const api = service(f, { answer: async () => { calls++; return result(); } });
    expect(api.waiting()?.questions).toEqual([]);
    f.advance(CHATGPT_INBOX_GRACE_MS - 1);
    await api.tick();
    expect(calls).toBe(0);
    f.advance(1);
    await api.tick();
    expect(f.store.get(ref.id)?.result?.answer).toBe(ANSWER);
    expect(api.waiting()?.questions[0]).toMatchObject({ id: ref.id, state: 'answered', unread: true });
  });

  test('a claimed panel suppresses fallback; acknowledgment deletes only its generation', async () => {
    const f = fixture();
    const ref = record(f.store, { surface: 'chatgpt' });
    f.advance(CHATGPT_INBOX_GRACE_MS);
    const api = service(f, { panelClaimed: () => true, answer: async () => { throw new Error('claimed panel must own this answer'); } });
    await api.tick();
    expect(f.store.get(ref.id)?.attempts).toBe(0);
    expect(api.waiting()?.questions).toEqual([]);
    const newer = record(f.store, { surface: 'chatgpt' });
    expect(f.store.acknowledge(ref)).toBe(false);
    expect(f.store.get(newer.id)).toBeDefined();
    expect(f.store.acknowledge(newer)).toBe(true);
    expect(f.store.get(newer.id)).toBeUndefined();
  });

  test('model failure stores retry timing without private exception text and backs off', async () => {
    const f = fixture();
    const ref = record(f.store);
    const secretError = 'SYNTHETIC_RAW_ERROR_WITH_PRIVATE_PASSAGE';
    let calls = 0;
    const api = service(f, { answer: async () => { calls++; throw new Error(secretError); } });
    await api.tick();
    const firstRetry = f.store.get(ref.id)!;
    expect(firstRetry.attempts).toBe(1);
    expect(firstRetry.nextAttemptAt).toBeGreaterThan(f.now());
    expect(api.waiting()?.questions[0]?.state).toBe('retrying');
    expect(JSON.stringify([firstRetry, await api.handle({ action: 'list' }, 'owner')])).not.toContain(secretError);
    await api.tick();
    expect(calls).toBe(1);
    f.advance(firstRetry.nextAttemptAt - f.now());
    await api.tick();
    expect(calls).toBe(2);
    expect(f.store.get(ref.id)!.nextAttemptAt - f.now()).toBeGreaterThan(firstRetry.nextAttemptAt - Date.parse(firstRetry.askedAt));
  });
});

describe('private inbox persistence and fencing', () => {
  test('answered rows survive seven days, remain owner-only and respect the per-connection cap', () => {
    const f = fixture();
    const oldest = record(f.store, { question: 'Answered oldest' });
    expect(f.store.saveAnswer(oldest, stored())).toBe(true);
    record(f.store, { question: 'Unanswered oldest' });
    f.advance(8 * 24 * 60 * 60_000);
    expect(f.store.list().questions.map(q => q.id)).toEqual([oldest.id]);
    for (let i = 0; i < WAITING_QUESTION_LIMITS.answeredPerConnection; i++) {
      f.advance(1);
      expect(f.store.saveAnswer(record(f.store, { question: `Answered ${i}` }), stored())).toBe(true);
    }
    expect(f.store.list().questions).toHaveLength(WAITING_QUESTION_LIMITS.answeredPerConnection);
    expect(f.store.get(oldest.id)).toBeUndefined();
    expect(f.store.list().olderRemoved).toBe(true);
    expect(statSync(f.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.dir, 'data')).mode & 0o777).toBe(0o700);
  });

  test('read eligibility withdrawing a Secret item never returns the stored text', async () => {
    const f = fixture();
    const ref = record(f.store);
    f.store.saveAnswer(ref, stored());
    const api = service(f, { eligible: async items => items.map(() => false), interactiveBusy: () => true });
    const response = await api.handle({ action: 'read', id: ref.id }, 'owner');
    expect(response.body.status).toBe('answering');
    expect(JSON.stringify(response)).not.toContain(ANSWER);
    expect(f.store.get(ref.id)?.result).toBeUndefined();
    expect(f.store.get(ref.id)?.generation).toBeGreaterThan(ref.generation);
  });

  test('withdrawing an answer older than seven days retains its row for automatic reanswer', async () => {
    const f = fixture();
    const ref = record(f.store);
    f.store.saveAnswer(ref, stored());
    f.advance(8 * 24 * 60 * 60_000);
    let eligible = false;
    let busy = true;
    let calls = 0;
    const replacement = 'SYNTHETIC_REPLACEMENT_FROM_CURRENT_ELIGIBLE_EVIDENCE';
    const api = service(f, {
      eligible: async items => items.map(() => eligible),
      interactiveBusy: () => busy,
      answer: async () => { calls++; return { ...result(), answer: replacement }; },
    });
    const withdrawn = await api.handle({ action: 'read', id: ref.id }, 'owner');
    expect(withdrawn.body.status).toBe('answering');
    expect(JSON.stringify(withdrawn)).not.toContain(ANSWER);
    expect(f.store.get(ref.id)).toBeDefined();
    expect(f.store.get(ref.id)?.result).toBeUndefined();
    expect(f.store.list().questions.map(q => q.id)).toContain(ref.id);
    expect(api.waiting()?.questions[0]?.state).toBe('answering');
    expect(calls).toBe(0);
    eligible = true;
    busy = false;
    await api.tick();
    expect(calls).toBe(1);
    expect(f.store.get(ref.id)?.result?.answer).toBe(replacement);
    expect((await api.handle({ action: 'read', id: ref.id }, 'owner')).body.answer).toBe(replacement);
  });

  for (const change of ['duplicate', 'delete', 'revoke'] as const) {
    test(`a completion across ${change} cannot restore the stale answer`, async () => {
      const f = fixture();
      const ref = record(f.store);
      const pending = deferred<LocalAnswerResult>();
      let called = false;
      const api = service(f, { answer: () => { called = true; return pending.promise; } });
      const pass = api.tick();
      await until(() => called);
      if (change === 'duplicate') record(f.store);
      else if (change === 'delete') f.store.dismiss(ref.id);
      else f.store.revokeConnection(ref.connectionId);
      pending.resolve(result());
      await pass;
      expect(f.store.get(ref.id)?.result).toBeUndefined();
      expect(f.store.saveAnswer(ref, stored())).toBe(false);
      expect(f.store.retry(ref)).toBe(false);
      if (change === 'duplicate') expect(f.store.get(ref.id)?.generation).toBeGreaterThan(ref.generation);
      else expect(f.store.get(ref.id)).toBeUndefined();
    });
  }

  test('corpus deletion removes dependent answers and unresolved work, retaining unrelated answers', () => {
    const f = fixture();
    const affected = record(f.store, { question: 'Affected answer' });
    f.store.saveAnswer(affected, stored());
    const retained = record(f.store, { question: 'Unrelated answer' });
    f.store.saveAnswer(retained, stored('secure_local.synthetic.other'));
    const pending = record(f.store, { question: 'Dependency not known yet' });
    expect(f.store.deleteForCorpora([identity.corpusId])).toBe(2);
    expect(f.store.get(affected.id)).toBeUndefined();
    expect(f.store.get(pending.id)).toBeUndefined();
    expect(f.store.get(retained.id)?.result?.answer).toBe(ANSWER);
  });

  test('an independently constructed v1 database upgrades its question and tick answers it', async () => {
    const f = fixture();
    const oldPath = join(f.dir, 'legacy.sqlite');
    const db = new Database(oldPath, { create: true });
    db.exec(`CREATE TABLE schema_version (store_id TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES ('waiting-private-questions', 1, '2026-10-13');
      CREATE TABLE waiting_questions (id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, connection_id TEXT NOT NULL,
        surface TEXT NOT NULL, question TEXT NOT NULL, detail TEXT NOT NULL, selectors TEXT NOT NULL,
        state TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL, asked_at INTEGER NOT NULL);
      CREATE TABLE connection_revocations (connection_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
      CREATE TABLE waiting_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.query('INSERT INTO waiting_questions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-question', 'legacy-dedupe', 'synthetic-agent', 'remote', 'Legacy synthetic renewal?', 'full', '{"query":"synthetic"}', 'waiting', 0, 7, f.now());
    db.close();
    const upgraded = openWaitingPrivateQuestionStore(oldPath, { now: f.now });
    cleanups.push(() => upgraded.close());
    const api = service(f, { store: () => upgraded });
    await api.tick();
    expect(upgraded.get('legacy-question')).toMatchObject({ generation: 7, question: 'Legacy synthetic renewal?', result: { answer: ANSWER } });
  });
});

describe('private inbox source capabilities and egress', () => {
  test('source tokens are session-bound', async () => {
    const f = fixture();
    const ref = record(f.store);
    f.store.saveAnswer(ref, stored());
    let opened = 0;
    const api = service(f, { interactiveBusy: () => true, openUrl: async (_url, allowed) => { expect(await allowed()).toBe(true); opened++; } });
    const read = await api.handle({ action: 'read', id: ref.id }, 'owner');
    const token = (read.body.citations as Array<{ open: string }>)[0]!.open;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,64}$/);
    expect(JSON.stringify(read)).not.toContain(identity.corpusId);
    expect((await api.handle({ action: 'open', token }, 'other-session')).status).toBe(410);
    expect(opened).toBe(0);
    expect(f.store.get(ref.id)?.result?.answer).toBe(ANSWER);
    expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(200);
    expect(opened).toBe(1);
  });

  test('source open authorization is rechecked after an awaited eligibility guard', async () => {
    const f = fixture(); const ref = record(f.store); f.store.saveAnswer(ref, stored());
    let duringOpen = false; let dispatched = 0;
    const api = service(f, { interactiveBusy: () => true,
      eligible: async items => { if (duringOpen) f.store.dismiss(ref.id); return items.map(() => true); },
      openUrl: async () => { dispatched++; },
    });
    const read = await api.handle({ action: 'read', id: ref.id }, 'owner');
    duringOpen = true;
    const token = (read.body.citations as Array<{ open: string }>)[0]!.open;
    expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(410);
    expect(dispatched).toBe(0);
  });

  for (const change of ['delete', 'revoke', 'eligibility'] as const) {
    test(`source tokens cannot open after ${change}`, async () => {
      const f = fixture();
      const ref = record(f.store);
      f.store.saveAnswer(ref, stored());
      let allowed = true;
      let opened = 0;
      const api = service(f, { interactiveBusy: () => true, eligible: async items => items.map(() => allowed), openUrl: async () => { opened++; } });
      const read = await api.handle({ action: 'read', id: ref.id }, 'owner');
      const token = (read.body.citations as Array<{ open: string }>)[0]!.open;
      if (change === 'delete') await api.handle({ action: 'delete', id: ref.id }, 'owner');
      else if (change === 'revoke') f.store.revokeConnection(ref.connectionId);
      else { allowed = false; await api.handle({ action: 'read', id: ref.id }, 'owner'); }
      expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(410);
      expect(opened).toBe(0);
    });
  }

  test('synthetic local answer is neither logged nor fetched and stores no source passages', async () => {
    const f = fixture();
    const ref = record(f.store);
    const logs: unknown[][] = [];
    let fetched = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { fetched++; throw new Error('network forbidden'); }) as unknown as typeof fetch;
    const restore: Array<() => void> = [() => { globalThis.fetch = originalFetch; }];
    for (const key of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const original = console[key];
      console[key] = (...args: unknown[]) => { logs.push(args); };
      restore.push(() => { console[key] = original; });
    }
    try {
      const api = service(f);
      await api.tick();
      const read = await api.handle({ action: 'read', id: ref.id }, 'owner');
      expect(read.body.answer).toBe(ANSWER);
      expect(f.store.get(ref.id)?.result?.answer).toBe(ANSWER);
      expect(JSON.stringify(f.store.get(ref.id)?.result?.read)).not.toContain(SOURCE_TEXT);
      expect(JSON.stringify(logs)).not.toContain(ANSWER);
      expect(JSON.stringify(logs)).not.toContain(SOURCE_TEXT);
      expect(fetched).toBe(0);
    } finally { for (const undo of restore.reverse()) undo(); }
  });
});

test('actual shared-model dispatch runs one completion at a time and queues owner work ahead of background work', async () => {
  const activity = createLocalModelActivity();
  const gates = new Map<string, ReturnType<typeof deferred<{ text: string; modelId: string }>>>();
  const order: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const model = activity.track('synthetic-shared-model', {
    async complete(request: { prompt: string }) {
      order.push(request.prompt);
      running++;
      maxRunning = Math.max(maxRunning, running);
      const gate = deferred<{ text: string; modelId: string }>();
      gates.set(request.prompt, gate);
      try { return await gate.promise; } finally { running--; }
    },
  });
  const request = (prompt: string) => ({ system: 'synthetic', prompt, localOnly: true });
  const first = runBackgroundInference(() => model.complete(request('background-running')));
  await until(() => gates.has('background-running'));
  const background = runBackgroundInference(() => model.complete(request('background-queued')));
  const owner = model.complete(request('owner-queued'));
  expect(order).toEqual(['background-running']);
  gates.get('background-running')!.resolve({ text: 'done', modelId: 'synthetic' });
  await first;
  await until(() => gates.has('owner-queued'));
  expect(order).toEqual(['background-running', 'owner-queued']);
  gates.get('owner-queued')!.resolve({ text: 'done', modelId: 'synthetic' });
  await owner;
  await until(() => gates.has('background-queued'));
  gates.get('background-queued')!.resolve({ text: 'done', modelId: 'synthetic' });
  await background;
  expect(order).toEqual(['background-running', 'owner-queued', 'background-queued']);
  expect(maxRunning).toBe(1);
  expect(activity.busy('synthetic-shared-model')).toBe(false);
});

test('re-asking an answered row refreshes only its timestamp and preserves its open token', async () => {
  const f = fixture();
  const ref = record(f.store);
  f.store.saveAnswer(ref, stored());
  f.store.markRead(ref);
  const api = service(f, { interactiveBusy: () => true, openUrl: async (_url, allowed) => { expect(await allowed()).toBe(true); } });
  const read = await api.handle({ action: 'read', id: ref.id }, 'owner');
  const token = (read.body.citations as Array<{ open: string }>)[0]!.open;
  const before = f.store.get(ref.id)!;
  f.advance(1000);
  expect(record(f.store)).toEqual(ref);
  expect(f.store.get(ref.id)).toEqual({ ...before, askedAt: new Date(f.now()).toISOString() });
  expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(200);
});

test('per-connection automatic budget survives reopen and re-asks; queued rows resume next hour', async () => {
  const f = fixture();
  let calls = 0;
  const api = service(f, { answer: async () => { calls++; return result(); } });
  for (let i = 0; i < WAITING_QUESTION_LIMITS.autoAnswersPerWindow; i++) {
    record(f.store, { question: `Budget ${i}` });
    await api.tick();
  }
  const queued = record(f.store, { question: 'Queued question' });
  await api.tick();
  expect(calls).toBe(5);
  expect(api.waiting()?.questions.find(q => q.id === queued.id)?.state).toBe('queued');
  expect((await api.handle({ action: 'read', id: queued.id }, 'owner')).body.status).toBe('queued');
  const second = openWaitingPrivateQuestionStore(f.dbPath, { now: f.now });
  cleanups.push(() => second.close());
  expect(second.reserveAutoAnswer(record(second, { question: 'Queued question' }))).toBe(false);
  const other = record(f.store, { question: 'Other connection' }, 'another-agent');
  await api.tick();
  expect(f.store.get(other.id)?.result).toBeDefined();
  f.advance(WAITING_QUESTION_LIMITS.autoAnswerWindowMs);
  await api.tick();
  expect(f.store.get(queued.id)?.result).toBeDefined();
});

test('metadata listing succeeds under a writer lock and never parses answer bodies', () => {
  const f = fixture(); const ref = record(f.store); f.store.saveAnswer(ref, stored());
  const lock = new Database(f.dbPath);
  try {
    // Invalid JSON independently proves the listing never parses this column.
    lock.query('UPDATE waiting_questions SET result = ? WHERE id = ?').run('{invalid-json', ref.id);
    lock.exec('BEGIN IMMEDIATE');
    const listed = f.store.list({ includeResults: false });
    expect(listed.questions).toHaveLength(1);
    expect(listed.questions[0]).toMatchObject({ id: ref.id, hasResult: true });
    expect(listed.questions[0]!.result).toBeUndefined();
  } finally { lock.exec('ROLLBACK'); lock.close(); }
});

test('byte quota evicts only the saving connection even below the row quota', () => {
  const f = fixture();
  const victim = record(f.store, { question: 'Another connection answer' }, 'other');
  f.store.saveAnswer(victim, stored());
  for (let i = 0; i < 15; i++) {
    f.advance(1);
    f.store.saveAnswer(record(f.store, { question: `Large ${i}` }), { ...stored(), answer: 'x'.repeat(100 * 1024) });
  }
  expect(f.store.get(victim.id)?.result?.answer).toBe(ANSWER);
  const own = f.store.list().questions.filter(q => q.connectionId === 'synthetic-agent');
  expect(own.length).toBeLessThan(15);
  expect(own.length).toBeGreaterThan(0);
});

test('an unavailable open check hides the source but preserves answer, generation and token for retry', async () => {
  const f = fixture(); const ref = record(f.store); f.store.saveAnswer(ref, stored());
  let unavailable = false; let opened = 0;
  const api = service(f, { interactiveBusy: () => true,
    eligible: async items => { if (unavailable) throw new Error('SQLITE_BUSY'); return items.map(() => true); },
    openUrl: async () => { opened++; },
  });
  const read = await api.handle({ action: 'read', id: ref.id }, 'owner');
  const token = (read.body.citations as Array<{ open: string }>)[0]!.open;
  unavailable = true;
  expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(503);
  expect(f.store.get(ref.id)).toMatchObject({ generation: ref.generation, result: { answer: ANSWER } });
  expect(opened).toBe(0);
  unavailable = false;
  expect((await api.handle({ action: 'open', token }, 'owner')).status).toBe(200);
  expect(opened).toBe(1);
});

test('classification holds automatic answers visibly queued without spending their budget', async () => {
  const f = fixture(); const ref = record(f.store);
  let sorting = true; let calls = 0;
  const api = service(f, { backgroundBusy: () => sorting, answer: async () => { calls++; return result(); } });
  await api.tick();
  expect(api.waiting()?.questions[0]?.state).toBe('queued');
  expect(calls).toBe(0);
  sorting = false;
  await api.tick();
  expect(f.store.get(ref.id)?.result).toBeDefined();
});
