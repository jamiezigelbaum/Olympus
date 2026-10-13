import { describe, expect, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { createInProcessOperationContext } from '../src/workers/remote-mcp.ts';
import { PRIVATE_QUESTION_META_KEY, type PrivateQuestionMetaV1 } from '../src/workers/chatgpt/private-question-contract.ts';
import { PrivateQuestionJobs, type PrivateQuestionBeginRequest, type PrivateQuestionOrigin } from '../src/workers/chatgpt/private-question-jobs.ts';
import {
  ASK_ANONYMOUSLY_TOOL,
  SOURCE_ANSWER_TOOL,
  callChatGptTool,
  type ChatGptSurfaceOptions,
} from '../src/workers/chatgpt/mcp-surface.ts';

const QUESTION = 'What did I decide about Acme?';
const MODEL = 'venice/llama-4';
const META: PrivateQuestionMetaV1 = {
  v: 1,
  jobId: `oly2p.${'a'.repeat(32)}.${'B'.repeat(43)}`,
  askKey: 'C'.repeat(87),
  level: 'standard',
  cleanup: 'as_written',
  customInstruction: false,
  maxChars: 4_000,
};

function lane() {
  const begun: Array<{ origin: PrivateQuestionOrigin; request?: PrivateQuestionBeginRequest }> = [];
  const realJobs = new PrivateQuestionJobs({
    installId: () => 'a'.repeat(32),
    choice: () => ({ level: META.level, cleanup: META.cleanup, customInstruction: false }),
    ask: async () => { throw new Error('No provider call before the private panel submits'); },
  });
  const privateQuestions = {
    async begin(origin: PrivateQuestionOrigin, request?: PrivateQuestionBeginRequest) {
      begun.push({ origin, ...(request ? { request } : {}) });
      return realJobs.begin(origin, request);
    },
  } as unknown as PrivateQuestionJobs;
  const config = defaultConfig();
  const ctx = createInProcessOperationContext({
    config,
    sourceIndexReadEnabled: true,
    workerFetch: async () => { throw new Error('normal operation path ran'); },
    caller: { surface: 'mcp', displayName: 'ChatGPT', provider: 'openai', connectionId: 'conn-documents' },
  });
  const options: ChatGptSurfaceOptions = {
    privateQuestions,
    answerModelAvailable: () => true,
    dashboardView: async () => ({}) as never,
  };
  return { begun, ctx, options };
}

function modelVisible(result: Awaited<ReturnType<typeof callChatGptTool>>): string {
  return JSON.stringify([result.content, result.structuredContent]);
}

describe('ChatGPT document questions route only to the private panel', () => {
  test('ask_anonymously use_documents opens a document panel and never runs the anonymous operation', async () => {
    const { begun, ctx, options } = lane();
    const result = await callChatGptTool(ASK_ANONYMOUSLY_TOOL.name, {
      question: QUESTION,
      use_documents: true,
      level: 'strict',
      cleanup: 'light_cleanup',
      remember: true,
      model: MODEL,
    }, ctx, options);

    expect(result.structuredContent).toEqual({ status: 'opened' });
    expect(begun).toEqual([{
      origin: { connectionId: 'conn-documents', readOnly: false },
      request: { question: QUESTION, useDocuments: true, model: MODEL, level: 'strict', cleanup: 'light_cleanup', remember: true },
    }]);
    expect(modelVisible(result)).not.toContain(QUESTION);
    expect(modelVisible(result)).not.toContain(MODEL);
    expect((result._meta as Record<string, unknown> | undefined)?.[PRIVATE_QUESTION_META_KEY]).toMatchObject({ question: QUESTION, useDocuments: true, level: 'strict' });
    expect((result._meta as Record<string, unknown> | undefined)?.[PRIVATE_QUESTION_META_KEY]).not.toHaveProperty('model');
  });

  test('source_answer with an explicit Venice analyst opens the same document panel', async () => {
    const { begun, ctx, options } = lane();
    const result = await callChatGptTool(SOURCE_ANSWER_TOOL.name, {
      question: QUESTION,
      detail: 'full',
      analyst_provider: 'venice',
      analyst_model: MODEL,
    }, ctx, options);

    expect(result.structuredContent).toMatchObject({ status: 'opened' });
    expect(begun).toEqual([{
      origin: { connectionId: 'conn-documents', readOnly: false },
      request: { question: QUESTION, useDocuments: true, model: MODEL, provider: 'venice' },
    }]);
    expect(modelVisible(result)).not.toContain(QUESTION);
    expect(modelVisible(result)).not.toContain(MODEL);
    expect((result._meta as Record<string, unknown> | undefined)?.[PRIVATE_QUESTION_META_KEY]).toMatchObject({ question: QUESTION, useDocuments: true, provider: 'venice' });
    expect((result._meta as Record<string, unknown> | undefined)?.[PRIVATE_QUESTION_META_KEY]).not.toHaveProperty('model');
  });

  test('the schemas expose only the bounded document routes', () => {
    expect(ASK_ANONYMOUSLY_TOOL.inputSchema.properties.use_documents).toEqual({
      type: 'boolean',
      description: expect.any(String),
    });
    expect(SOURCE_ANSWER_TOOL.inputSchema.properties.analyst_provider).toMatchObject({ type: 'string', enum: ['venice'] });
    expect(SOURCE_ANSWER_TOOL.inputSchema.properties.analyst_model).toMatchObject({ type: 'string' });
  });
});
