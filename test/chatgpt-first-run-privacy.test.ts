import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPendingPrivacyPolicy, saveFirstRunPrivacyChoice } from '../src/core/first-run-privacy.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { callSetupTool } from '../src/workers/chatgpt/setup-tools.ts';
import { loadSovereigntyPreset } from '../src/core/sovereignty.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'first-run-chatgpt-'));
  dirs.push(dir);
  const path = join(dir, 'sovereignty.json');
  const config = createPendingPrivacyPolicy();
  writeFileSync(path, JSON.stringify(config));
  const backend = createChatGptSetupBackend({
    sovereignty: { config, source: 'file', path }, credentialPresent: () => false, requestReload: () => true,
    workerFetch: async () => new Response('{}'), publicUrls: () => undefined,
    handoffs: {} as never,
    env: { HOME: dir, OLYMPUS_PRIVACY_PROFILE_PATH: join(dir, 'privacy.json'), OLYMPUS_TIER_RULES_PATH: join(dir, 'rules.json') },
  });
  return { backend, path };
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
  await callSetupTool('olympus_privacy_set', { revision: meta(opened).revision, confirmation: meta(opened).confirmation, private_answer_mode: 'private-cloud-only' }, backend);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(loadSovereigntyPreset('local-only'));
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
