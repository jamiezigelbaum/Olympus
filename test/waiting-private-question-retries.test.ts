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
