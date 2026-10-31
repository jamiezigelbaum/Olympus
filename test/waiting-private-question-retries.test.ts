import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWaitingPrivateQuestionStore } from '../src/core/waiting-private-questions.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('retry exhaustion is persisted with content-free reasons and fenced from old generations', () => {
  const root = mkdtempSync(join(tmpdir(), 'bounded-inbox-')); roots.push(root);
  const path = join(root, 'state', 'waiting.sqlite');
  let store = openWaitingPrivateQuestionStore(path);
  try {
    const input = { question: 'question', surface: 'remote' as const, state: 'waiting' as const };
    const ref = store.record(store.ticket('c'), input)!;
    for (let i = 0; i < 8; i += 1) expect(store.retry(ref, 'answer_failed')).toBe(true);
    expect(store.get(ref.id)).toMatchObject({ attempts: 8, result: { status: 'failed' }, retryReasons: Array(8).fill('answer_failed') });
    expect(store.retry(ref, 'evidence_changed')).toBe(false);
    store.close();
    store = openWaitingPrivateQuestionStore(path);
    expect(store.get(ref.id)?.result?.status).toBe('failed');
    const again = store.record(store.ticket('c'), input)!;
    expect(store.retry(ref, 'answer_failed')).toBe(false);
    expect(again.generation).toBe(ref.generation + 1);
    expect(store.get(ref.id)?.retryReasons).toBeUndefined();
  } finally { store.close(); }
});

test('retry reasons refuse arbitrary text and old generations cannot settle a new ask', () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-reasons-')); roots.push(root);
  const store = openWaitingPrivateQuestionStore(join(root, 'state', 'waiting.sqlite'));
  try {
    const input = { question: 'question', surface: 'remote' as const, state: 'waiting' as const };
    const ref = store.record(store.ticket('c'), input)!;
    store.retry(ref, '/Users/private/source.pdf' as never);
    expect(store.get(ref.id)?.retryReasons).toEqual(['answer_failed']);
    const again = store.record(store.ticket('c'), input)!;
    expect(store.retry(ref, 'answer_failed')).toBe(false);
    expect(store.get(again.id)).toMatchObject({ attempts: 0 });
    expect(store.get(again.id)?.result).toBeUndefined();
    store.revokeConnection('c');
    expect(store.retry(again, 'answer_failed')).toBe(false);
    expect(store.get(again.id)).toBeUndefined();
  } finally { store.close(); }
});


test('failed metadata stays visible without parsing malformed stored answer JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-metadata-')); roots.push(root);
  const path = join(root, 'state', 'waiting.sqlite');
  const store = openWaitingPrivateQuestionStore(path);
  const raw = new Database(path);
  try {
    const ref = store.record(store.ticket('c'), { question: 'question', surface: 'remote', state: 'waiting' })!;
    for (let i = 0; i < 8; i += 1) store.retry(ref, 'answer_failed');
    raw.query('UPDATE waiting_questions SET result = ? WHERE id = ?').run('{invalid-json', ref.id);
    raw.exec('BEGIN IMMEDIATE');
    expect(store.list({ includeResults: false }).questions[0]).toMatchObject({ id: ref.id, hasResult: true, failed: true });
    raw.exec('ROLLBACK');
  } finally { raw.close(); store.close(); }
});

test('v6 migration preserves valid failures and tolerates malformed answer bodies', () => {
  const root = mkdtempSync(join(tmpdir(), 'retry-upgrade-')); roots.push(root);
  const path = join(root, 'state', 'waiting.sqlite');
  const store = openWaitingPrivateQuestionStore(path);
  const failed = store.record(store.ticket('c'), { question: 'failed', surface: 'remote', state: 'waiting' })!;
  const malformed = store.record(store.ticket('c'), { question: 'malformed', surface: 'remote', state: 'waiting' })!;
  for (let i = 0; i < 8; i += 1) store.retry(failed);
  store.saveAnswer(malformed, { status: 'not_found', citations: [], read: [], unanswered: [], leftOut: [] });
  store.close();
  const raw = new Database(path);
  raw.query('UPDATE waiting_questions SET result = ? WHERE id = ?').run('{invalid-json', malformed.id);
  raw.exec('ALTER TABLE waiting_questions DROP COLUMN failed');
  raw.query('UPDATE schema_version SET version = 6 WHERE store_id = ?').run('waiting-private-questions');
  raw.close();
  const upgraded = openWaitingPrivateQuestionStore(path);
  try {
    const listed = upgraded.list({ includeResults: false }).questions;
    expect(listed.find(q => q.id === failed.id)).toMatchObject({ failed: true, hasResult: true });
    expect(listed.find(q => q.id === malformed.id)?.failed).toBeUndefined();
    expect(upgraded.invalidate(failed)).toBe(true);
    expect(upgraded.list({ includeResults: false }).questions.find(q => q.id === failed.id)?.failed).toBeUndefined();
  } finally { upgraded.close(); }
});
