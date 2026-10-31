import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWaitingPrivateQuestionStore } from '../src/core/waiting-private-questions.ts';
import { createLocalPrivateAnswers } from '../src/workers/email-source/local-private-answers.ts';

test('saved Secret locations are rechecked and old answers fail closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-inbox-'));
  const store = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'), { isActive: () => true });
  const location = { source: 'fixture', ref: 'secret:abc', fingerprint: 'screened' };
  let allowed = true;
  const controller = createLocalPrivateAnswers({
    store: () => store, eligible: async items => items.map(() => true), eligibleSecrets: (_request, items) => allowed && items[0]?.ref === location.ref,
    answer: async () => ({ status: 'answered', answer: 'The Secret is in /allowed/keys', citations: [], unanswered: [], leftOut: [], read: [], secretLocations: [location] }),
  });
  try {
    const ref = store.record(store.ticket('conn'), { question: 'keys', surface: 'remote', state: 'waiting' })!;
    await controller.tick();
    expect((await controller.handle({ action: 'read', id: ref.id }, 'owner')).body.answer).toContain('/allowed/keys');
    allowed = false;
    const changed = await controller.handle({ action: 'read', id: ref.id }, 'owner');
    expect(changed.body.status).toBe('answering');
    expect(JSON.stringify(changed.body)).not.toContain('/allowed/keys');
    const old = store.record(store.ticket('conn'), { question: 'old keys', surface: 'remote', state: 'waiting' })!;
    store.saveAnswer(old, { status: 'answered', answer: '/old/location', citations: [], unanswered: [], leftOut: [], read: [] });
    expect((await controller.handle({ action: 'read', id: old.id }, 'owner')).body.status).toBe('answering');
  } finally { controller.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
