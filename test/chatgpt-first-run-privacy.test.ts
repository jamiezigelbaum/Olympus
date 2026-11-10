import { writePrivacyProfile } from '../src/workers/classification/privacy-profile.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import { createSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { ModelSetupService } from '../src/core/model-setup.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(credentialPresent = false) {
  const dir = mkdtempSync(join(tmpdir(), 'first-run-chatgpt-'));
  dirs.push(dir);
  const path = join(dir, 'sovereignty.json');
  const config = createPendingPrivacyPolicy();
  writeFileSync(path, JSON.stringify(config));
  const backend = createChatGptSetupBackend({
    sovereignty: { config, source: 'file', path }, credentialPresent: () => credentialPresent, requestReload: () => true,
    workerFetch: async () => new Response('{}'), publicUrls: () => undefined,
    handoffs: {} as never,
    env: { HOME: dir, OLYMPUS_PRIVACY_PROFILE_PATH: join(dir, 'privacy.json'), OLYMPUS_TIER_RULES_PATH: join(dir, 'rules.json') },
  });
  return { backend, path, dir };
}
const meta = (result: any) => result._meta['olympus/privacy'];

test('privacy setup exposes the shared four-mode choice only for a pending policy', async () => {
  const { backend } = setup();
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  expect(meta(opened).privateAnswerChoice.options).toHaveLength(4);
  expect(meta(opened).privateAnswerChoice.options[0]).toMatchObject({ id: 'local-first', recommended: true });
});

test.each(['local-first', 'local-only', 'private-cloud-only', 'no-sensitive'] as const)('widget choice saves %s and is never asked again', async choice => {
  const { backend, path } = setup();
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  const saved = await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: choice }, backend);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadSovereigntyPreset(choice));
  expect(meta(saved).privateAnswerChoice).toBeUndefined();
  expect(meta(await callSetupTool('olympus_privacy_get', {}, backend)).privateAnswerChoice).toBeUndefined();
});

test('a stale ChatGPT choice never overwrites a dashboard choice', async () => {
  const { backend, path } = setup();
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  saveFirstRunPrivacyChoice(path, 'local-only');
  const stale = await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: 'private-cloud-only' }, backend);
  // Honest about it (#702): the other path's choice stands and the panel reads it back.
  expect((stale as any).structuredContent.status).toBe('conflict');
  expect(meta(stale).privateAnswerChoice).toBeUndefined();
  expect(meta(stale).privateAnswerMode.id).toBe('local-only');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadSovereigntyPreset('local-only'));
});

test('the dashboard status stops asking after the ChatGPT panel saves a choice', async () => {
  const { backend, path } = setup();
  const dashboardPending = () => new ModelSetupService({ config: JSON.parse(readFileSync(path, 'utf8')), credentialState: () => 'ready', autoCheck: false }).getStatus().privacy_choice_pending;
  expect(dashboardPending()).toBe(true);
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: 'local-first' }, backend);
  expect(dashboardPending()).toBeUndefined();
});

test('the ChatGPT panel stops asking after the shared dashboard save', async () => {
  const { backend, path } = setup();
  expect(meta(await callSetupTool('olympus_privacy_get', {}, backend)).privateAnswerChoice).toBeDefined();
  expect(saveFirstRunPrivacyChoice(path, 'local-only')).toMatchObject({ ok: true, changed: true });
  expect(meta(await callSetupTool('olympus_privacy_get', {}, backend)).privateAnswerChoice).toBeUndefined();
});

test('choosing a mode requires the owner panel confirmation', async () => {
  const { backend, path } = setup();
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  await expect(callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, private_answer_mode: 'local-first' }, backend)).rejects.toMatchObject({ code: 'privacy_owner_only' });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(createPendingPrivacyPolicy());
});


test('an existing install never gets the first-run choice', async () => {
  const { backend, path } = setup();
  writeFileSync(path, JSON.stringify(loadSovereigntyPreset('no-sensitive')));
  expect(meta(await callSetupTool('olympus_privacy_get', {}, backend)).privateAnswerChoice).toBeUndefined();
});


test('model selection cannot clear the durable first-run choice across tools and reload', async () => {
  const { backend, path } = setup(true);
  await callSetupTool('olympus_model_set', { answers: 'venice' }, backend);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(saved.privacyChoicePending).toBe(true);
  expect(() => createSovereigntyEngine(saved).resolveAnalystPool({ trustDomain: 'internal' })).toThrow('Choose the first-run privacy policy');
  const status = new ModelSetupService({ config: saved, credentialState: () => 'ready', autoCheck: false }).getStatus();
  expect(status.ready).toBe(false);
  expect(status.privacy_choice_pending).toBe(true);
  expect(meta(await callSetupTool('olympus_privacy_get', {}, backend)).privateAnswerChoice.pending).toBe(true);
  expect(saveFirstRunPrivacyChoice(path, 'local-only')).toMatchObject({ ok: true, changed: true });
  expect(JSON.parse(readFileSync(path, 'utf8')).privacyChoicePending).toBeUndefined();
});


test('the pending chooser returns no existing source rules or backlog', async () => {
  const { backend, dir } = setup();
  writePrivacyProfile({ description: 'SENTINEL_SOURCE_DESCRIPTION', rules: [{ kind: 'sender', source_id: 'gmail.email', value: 'SENTINEL_SENDER@example.test' }] },
    { env: { HOME: dir, OLYMPUS_PRIVACY_PROFILE_PATH: join(dir, 'privacy.json'), OLYMPUS_TIER_RULES_PATH: join(dir, 'rules.json') } });
  const result = await callSetupTool('olympus_privacy_get', {}, backend);
  expect(meta(result).privateAnswerChoice.pending).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SENTINEL');
});


test('pending chooser refuses profile edits without overwriting hidden owner rules', async () => {
  const { backend, dir } = setup();
  const env = { HOME: dir, OLYMPUS_PRIVACY_PROFILE_PATH: join(dir, 'privacy.json'), OLYMPUS_TIER_RULES_PATH: join(dir, 'rules.json') };
  writePrivacyProfile({ description: 'SENTINEL_KEEP_DESCRIPTION', rules: [{ kind: 'sender', source_id: 'gmail.email', value: 'keep@example.test' }] }, { env });
  const before = readFileSync(env.OLYMPUS_PRIVACY_PROFILE_PATH, 'utf8');
  const beforeRules = readFileSync(env.OLYMPUS_TIER_RULES_PATH, 'utf8');
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  await expect(callSetupTool('olympus_privacy_set', { revision: meta(opened).revision,
    rules: [{ kind: 'sender', source_id: 'gmail.email', value: 'new@example.test' }] }, backend)).rejects.toMatchObject({ code: 'privacy_choice_required' });
  expect(readFileSync(env.OLYMPUS_PRIVACY_PROFILE_PATH, 'utf8')).toBe(before);
  expect(readFileSync(env.OLYMPUS_TIER_RULES_PATH, 'utf8')).toBe(beforeRules);
  expect(meta(opened).privateAnswerChoice.pending).toBe(true);
  await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: 'local-only' }, backend);
  expect(readFileSync(env.OLYMPUS_PRIVACY_PROFILE_PATH, 'utf8')).toBe(before);
  expect(readFileSync(env.OLYMPUS_TIER_RULES_PATH, 'utf8')).toBe(beforeRules);
});

test.each(['local-first', 'local-only', 'private-cloud-only', 'no-sensitive'] as const)('the saved mode can change to %s without replacing search models', async choice => {
  const { backend, path } = setup();
  saveFirstRunPrivacyChoice(path, 'local-only');
  const original = JSON.parse(readFileSync(path, 'utf8'));
  original.modelProfiles['local-source-answer'].model = 'my-local-model';
  writeFileSync(path, JSON.stringify(original));
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  expect(meta(opened).privateAnswerMode).toMatchObject({ id: 'local-only', label: 'Local models' });
  const saved = await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: choice }, backend);
  expect(meta(saved).privateAnswerMode.id).toBe(choice);
  const config = JSON.parse(readFileSync(path, 'utf8'));
  expect(config.modelProfiles['local-source-answer'].model).toBe('my-local-model');
  expect(config.retrieval.trustDomains.internal).toEqual(original.retrieval.trustDomains.internal);
  expect(config.retrieval.trustDomains.secure_local.embeddingProfile).toBe(original.retrieval.trustDomains.secure_local.embeddingProfile);
});

test('a stale mode change cannot overwrite a policy saved by another tab', async () => {
  const { backend, path } = setup();
  saveFirstRunPrivacyChoice(path, 'local-only');
  const opened = await callSetupTool('olympus_privacy_get', {}, backend);
  const current = JSON.parse(readFileSync(path, 'utf8'));
  current.modelProfiles['local-source-answer'].model = 'changed-elsewhere';
  writeFileSync(path, JSON.stringify(current));
  const saved = await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: 'private-cloud-only' }, backend);
  expect((saved as any).structuredContent.status).toBe('conflict');
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(current);
});

test('choosing Local models cannot silently keep sending Private search text to a cloud model', async () => {
  const { path } = setup();
  const config = loadSovereigntyPreset('private-cloud-only');
  config.modelProfiles['private-search'] = { provider: 'venice', trust: 'encrypted_cloud', purpose: 'embedding', model: 'text-embedding-bge-m3', baseUrl: 'https://api.venice.ai/api/v1', secretRef: 'store:venice.api_key' };
  config.retrieval.trustDomains.secure_local!.embeddingProfile = 'private-search';
  writeFileSync(path, JSON.stringify(config));
  const { savePrivateAnswerMode } = await import('../src/core/first-run-privacy.ts');
  expect(() => savePrivateAnswerMode(path, 'local-only', config)).toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(config);
});
