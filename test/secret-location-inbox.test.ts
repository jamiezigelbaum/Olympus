import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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


test('local Secret Inbox resolves the exact question and opens only its current matched sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-open-'));
  const store = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'), { isActive: () => true });
  const file = join(dir, 'Recovery document.txt'); writeFileSync(file, 'synthetic fixture');
  const location = { source: 'fixture', ref: 'secret:one', fingerprint: 'current' };
  const ref = store.record(store.ticket('conn'), { question: 'recovery', surface: 'chatgpt', state: 'waiting' })!;
  store.saveAnswer(ref, { status: 'answered', answer: 'Recovery document is a Secret', citations: [], unanswered: [], leftOut: [], read: [], secretLocations: [location] });
  let allowed = true; const opened: string[] = [];
  const controller = createLocalPrivateAnswers({
    store: () => store, answer: async () => ({ status: 'no_model' }), eligible: async items => items.map(() => true),
    panelSecretNotice: candidate => candidate.id === ref.id,
    resolveSecretInbox: handle => handle === 'S'.repeat(22) ? ref : undefined,
    eligibleSecrets: (_request, items) => allowed && items[0]?.ref === location.ref,
    secretSources: (_request, items) => items.map(() => ({ title: 'Recovery document', localPath: file })),
    openFile: async (path, eligible) => { if (!await eligible()) throw Error('revoked'); opened.push(path); },
  });
  try {
    expect((await controller.handle({ action: 'resolve_secret', handle: 'S'.repeat(22) }, 'owner')).body).toEqual({ ok: true, id: ref.id });
    expect(controller.waiting()?.questions.map(q => q.id)).toContain(ref.id);
    const read = await controller.handle({ action: 'read', id: ref.id }, 'owner');
    const citations = read.body.citations as Array<{ title: string; open: string }>;
    expect(citations).toHaveLength(1); expect(citations[0]!.title).toBe('Recovery document');
    expect(JSON.stringify(citations)).not.toContain(file);
    expect((await controller.handle({ action: 'open', token: citations[0]!.open }, 'other-session')).status).toBe(410);
    expect((await controller.handle({ action: 'open', token: citations[0]!.open }, 'owner')).status).toBe(200);
    expect(opened).toEqual([file]);
    allowed = false;
    expect((await controller.handle({ action: 'open', token: citations[0]!.open }, 'owner')).status).toBe(410);
    expect(opened).toEqual([file]);
    expect((await controller.handle({ action: 'resolve_secret', handle: 'invalid' }, 'owner')).status).toBe(410);
    store.dismiss(ref.id);
    expect((await controller.handle({ action: 'resolve_secret', handle: 'S'.repeat(22) }, 'owner')).status).toBe(410);
  } finally { controller.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('source lookup returns just the saved matching Secrets through existing open adapters', async () => {
  const { createLocalAnswerPath } = await import('../src/workers/email-source/local-private-answers.ts');
  const { createReleaseTierCheck } = await import('../src/workers/connector-store/tier-visibility.ts');
  const { buildSourceIndexCorpusRegistry } = await import('../src/core/source-index/corpus.ts');
  let eligible = true;
  const matches = ['one', 'two', 'unrelated'].map(ref => ({ source: 'fixture', ref, title: ref, locator: `/allowed/${ref}.txt`, findingKinds: [] }));
  const path = createLocalAnswerPath({
    model: undefined, available: () => false, relevanceEmbedding: () => undefined,
    releaseCheck: createReleaseTierCheck(() => [], () => 'approval'),
    lanes: () => ({ registry: buildSourceIndexCorpusRegistry([]), adapters: {}, contentProviders: {},
      secretLocations: () => matches, checkSecretLocations: () => eligible }),
    sourceLinks: item => ({ localPath: (item.provenance as { citation: { uri: string } }).citation.uri }),
  });
  const saved = ['one', 'two'].map(ref => ({ source: 'fixture', ref, fingerprint: 'current' }));
  expect(path.secretSources({ question: 'recovery' }, saved)).toEqual([
    { title: 'one', source: 'fixture', localPath: '/allowed/one.txt' },
    { title: 'two', source: 'fixture', localPath: '/allowed/two.txt' },
  ]);
  eligible = false;
  expect(path.secretSources({ question: 'recovery' }, saved)).toEqual([]);
});

for (const state of ['no_model', 'model_downloading'] as const) test(`Secret-only Inbox answer names the item without waiting for ${state}`, async () => {
  const { answerOnThisComputer } = await import('../src/workers/source-index/local-answer.ts');
  const { buildSourceIndexCorpusRegistry } = await import('../src/core/source-index/corpus.ts');
  const result = await answerOnThisComputer({ question: 'Recovery' }, {
    lanes: () => ({ registry: buildSourceIndexCorpusRegistry([]), adapters: {}, contentProviders: {},
      secretLocations: () => [{ source: 'fixture', ref: 'secret:one', title: 'Recovery document', locator: '/allowed/recovery.txt', findingKinds: [] }] }),
    model: { status: () => ({ state }), answerPrivately: async () => { throw Error('must not infer'); } },
    eligible: async items => items.map(() => true),
  });
  expect(result.status).toBe('answered');
  expect('answer' in result && result.answer).toContain('/allowed/recovery.txt');
});


for (const explicitQuery of [false, true]) test(`Secret Open sources honor the saved query and human labels (query=${explicitQuery})`, async () => {
  const { createLocalAnswerPath } = await import('../src/workers/email-source/local-private-answers.ts');
  const { createReleaseTierCheck } = await import('../src/workers/connector-store/tier-visibility.ts');
  const { buildSourceIndexCorpusRegistry } = await import('../src/core/source-index/corpus.ts');
  const locations = [
    { source: 'dropbox', ref: 'named', title: 'Recovery', locator: '/allowed/recovery.txt', findingKinds: [] },
    { source: 'dropbox', ref: 'hidden', title: null, locator: null, findingKinds: [] },
  ];
  const path = createLocalAnswerPath({
    model: undefined, available: () => false, relevanceEmbedding: () => undefined,
    releaseCheck: createReleaseTierCheck(() => [], () => 'approval'),
    lanes: () => ({ registry: buildSourceIndexCorpusRegistry([]), adapters: {}, contentProviders: {},
      secretLocations: query => query === (explicitQuery ? 'recovery alias' : 'original question') ? locations : [], checkSecretLocations: () => true }),
    sourceLinks: () => ({ localPath: '/allowed/recovery.txt' }),
  });
  expect(path.secretSources({ question: 'original question', ...(explicitQuery ? { selectors: { query: ' recovery alias ' } } : {}) },
    locations.map(({ source, ref }) => ({ source, ref, fingerprint: 'current' })))).toEqual([
    { title: 'Recovery', source: 'Dropbox', localPath: '/allowed/recovery.txt' },
  ]);
});

for (const secretOnly of [false, true]) test(`Inbox lists a Secret notice immediately but preserves mixed-answer inference grace (only=${secretOnly})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-grace-')); let now = Date.now();
  const store = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'), { now: () => now, isActive: () => true });
  let calls = 0;
  const controller = createLocalPrivateAnswers({ store: () => store, now: () => now,
    panelSecretNotice: () => true, panelSecretOnlyNotice: () => secretOnly,
    answer: async () => { calls++; return { status: 'not_found', leftOut: [] }; },
  });
  try {
    const ref = store.record(store.ticket('conn'), { question: 'recovery', surface: 'chatgpt', state: 'waiting' })!;
    expect(controller.waiting()?.questions.map(q => q.id)).toContain(ref.id);
    await controller.tick(); expect(calls).toBe(secretOnly ? 1 : 0);
    now += 31_000; await controller.tick(); expect(calls).toBe(1);
  } finally { controller.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
