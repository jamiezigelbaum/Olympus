import { describe, expect, test } from 'bun:test';
import { callSetupTool, PRIVACY_DRAFT_TOOLS, type ChatGptSetupBackend } from '../src/workers/chatgpt/setup-tools.ts';
import { PRIVACY_CHECK_TOOL_NAME, PRIVACY_GET_TOOL_NAME, PRIVACY_META_KEY, PRIVACY_QUESTIONS_TOOL_NAME } from '../src/workers/chatgpt/dashboard-contract.ts';
import { createChatGptSetupBackend } from '../src/workers/chatgpt/setup-backend.ts';
import { createChatGptHandoffs } from '../src/workers/chatgpt/handoff.ts';
import { loadSovereigntyPreset } from '../src/core/sovereignty.ts';

function fixture() {
  const calls: unknown[] = [];
  const questions = { fallback: false, questions: [{ id: 'invoice', question: 'Should client invoices stay Private?' }] };
  const check = { private: ['Invoices'], share: ['Poems'], samples: [{ name: 'Synthetic invoice', side: 'private' as const }] };
  const backend = {
    privacySettings: () => ({ configured: true, description: 'Saved words', rules: [], pendingCount: 0, revision: 'v1' }),
    secretLocations: () => ({ folderKeys: new Set(), pathPrefixes: [], labelIds: new Set(), senders: [] }),
    privacyQuestions: async (description: string) => { calls.push(description); return questions; },
    privacyCheck: async (description: string, sample?: string) => { calls.push({ description, sample }); return check; },
    savePrivacy: () => { throw new Error('draft must not save'); },
  } as unknown as ChatGptSetupBackend;
  return { backend, calls, questions, check };
}
async function confirmation(backend: ChatGptSetupBackend) {
  const got = await callSetupTool(PRIVACY_GET_TOOL_NAME, {}, backend);
  return ((got._meta as Record<string, unknown>)[PRIVACY_META_KEY] as { confirmation: string }).confirmation;
}

describe('widget-only privacy draft tools', () => {
  test('both tools are hidden from the model and accept only bounded draft arguments', () => {
    expect(PRIVACY_DRAFT_TOOLS.map(tool => tool.name)).toEqual([PRIVACY_QUESTIONS_TOOL_NAME, PRIVACY_CHECK_TOOL_NAME]);
    for (const tool of PRIVACY_DRAFT_TOOLS) {
      expect(tool._meta).toEqual({ ui: { visibility: ['app'] }, 'openai/widgetAccessible': true, 'openai/visibility': 'private' });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.required).toEqual(['description', 'confirmation']);
    }
  });

  test('owner-only confirmation, scoped to the panel backend; metadata-only results never save', async () => {
    const { backend, calls, questions, check } = fixture();
    const token = await confirmation(backend);
    for (const name of [PRIVACY_QUESTIONS_TOOL_NAME, PRIVACY_CHECK_TOOL_NAME]) {
      await expect(callSetupTool(name, { description: 'Draft' }, backend)).rejects.toMatchObject({ code: 'privacy_owner_only' });
      await expect(callSetupTool(name, { description: 'Draft', confirmation: token }, fixture().backend)).rejects.toMatchObject({ code: 'privacy_owner_only' });
    }
    expect(calls).toHaveLength(0);
    const asked = await callSetupTool(PRIVACY_QUESTIONS_TOOL_NAME, { description: 'Draft', confirmation: token }, backend);
    expect(asked).toEqual({ content: [], _meta: { [PRIVACY_META_KEY]: questions } });
    const checked = await callSetupTool(PRIVACY_CHECK_TOOL_NAME, { description: 'Draft', sample: 'Synthetic invoice', confirmation: token }, backend);
    expect(checked).toEqual({ content: [], _meta: { [PRIVACY_META_KEY]: check } });
    expect(backend.privacySettings().description).toBe('Saved words');
    expect(calls).toHaveLength(2);
  });

  test.each([{ description: 3 }, { description: 'x'.repeat(2001) }, { description: 'Draft', sample: '' },
    { description: 'Draft', sample: 'x'.repeat(121) }, { description: 'Draft', extra: true }])('rejects invalid input before inference', async args => {
    const { backend, calls } = fixture();
    await expect(callSetupTool(PRIVACY_CHECK_TOOL_NAME, { ...args, confirmation: await confirmation(backend) }, backend)).rejects.toMatchObject({ code: 'invalid_params' });
    expect(calls).toHaveLength(0);
  });

  test('setup backend reaches the injected engine and has a safe fallback without one', async () => {
    const calls: string[] = [];
    const options = {
      workerFetch: async () => { throw new Error('draft never fetches worker routes'); }, handoffs: createChatGptHandoffs(),
      publicUrls: () => undefined, sovereignty: { config: loadSovereigntyPreset('local-only'), source: 'test' },
      credentialPresent: () => false, requestReload: () => false,
    };
    const noModel = createChatGptSetupBackend(options);
    expect(await noModel.privacyQuestions!('Draft')).toEqual({ fallback: true, questions: [] });
    expect(await noModel.privacyCheck!('Draft')).toBeNull();
    const backend = createChatGptSetupBackend({ ...options, privacyQuestionEngine: {
      questions: async description => { calls.push(description); return { fallback: false, questions: [] }; },
      check: async description => { calls.push(description); return null; },
    } });
    await backend.privacyQuestions!('Question draft'); await backend.privacyCheck!('Read-back draft');
    expect(calls).toEqual(['Question draft', 'Read-back draft']);
  });
});
